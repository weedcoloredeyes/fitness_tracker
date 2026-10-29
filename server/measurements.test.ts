import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import { Users } from './users';
import { validateMeasurement } from './measurements';
import { createApp } from './app';
import { todayInTimezone } from './activity';

const profile = { currentWeight: 90, currentFat: 22, targetWeight: 80, targetFat: 18 };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-measurements-'));
  return { dir, file: join(dir, 'fitness.sqlite') };
}
function seed(users: Users) {
  users.identify({ id: 101, first_name: 'First', username: 'NotTofu' });
  users.identify({ id: 202, first_name: 'Second' });
}

test('v5 migration preserves undated profiles, goals, activities and users without inventing measurement dates', () => {
  const f = fixture();
  let users = new Users(f.file);
  try {
    seed(users);
    users.setProfile(101, profile);
    users.setProfile(101, { ...profile, currentWeight: 85 });
    users.setMonthlyWorkoutGoal(101, '2026-01-01', 12);
    users.setActivity(101, '2026-01-01', 'walking', true);
    const accounts = users.list();
    const original = users.getProfile(101);
    users.close();
    const db = new DatabaseSync(f.file);
    db.exec('DROP TABLE daily_measurements; PRAGMA user_version = 5');
    db.close();
    users = new Users(f.file);
    assert.deepEqual(users.list(), accounts);
    assert.equal(users.isAdmin(101), true);
    assert.deepEqual(users.getProfile(101), original);
    assert.equal(users.getActivity(101, '2026-01-01').walking, true);
    const dashboard = users.getDashboard(101, '2026-01-02');
    assert.equal(dashboard.profile.currentWeight, null);
    assert.equal(dashboard.profile.currentFat, null);
    assert.equal(dashboard.profile.targetWeight, 80);
    assert.equal(dashboard.profile.startWeight, 90);
    assert.equal(dashboard.progress, 50);
    assert.equal(dashboard.workouts.goal, 12);
    assert.equal(dashboard.lastMeasurementDate, null);
    assert.deepEqual(users.getMeasurementHistory(101), {
      measurements: [], legacyMeasurement: { currentWeight: 85, currentFat: 22 },
    });
    assert.deepEqual(users.getMeasurement(101, '2026-01-01'), { date: '2026-01-01', currentWeight: null, currentFat: null });
  } finally { users.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('daily measurements survive restart, remain isolated and never carry current values into the next day', () => {
  const f = fixture();
  let users = new Users(f.file);
  try {
    seed(users);
    users.setProfile(101, profile, '2026-01-01');
    users.setMeasurement(101, '2026-01-02', { currentWeight: 89, currentFat: 21 });
    users.setMeasurement(202, '2026-01-02', { currentWeight: 70, currentFat: 15 });
    users.setMonthlyWorkoutGoal(101, '2026-01-03', 8);
    users.close();
    users = new Users(f.file);
    assert.deepEqual(users.getMeasurement(101, '2026-01-02'), { date: '2026-01-02', currentWeight: 89, currentFat: 21 });
    const next = users.getDashboard(101, '2026-01-03');
    assert.deepEqual(next.profile, { currentWeight: null, currentFat: null, targetWeight: 80, targetFat: 18, startWeight: 90 });
    assert.equal(next.progress, 10);
    assert.equal(next.progressMeasurementDate, '2026-01-02');
    assert.equal(next.lastMeasurementDate, '2026-01-02');
    assert.equal(next.workouts.goal, 8);
    assert.deepEqual(users.getMeasurementHistory(101), { measurements: [
      { date: '2026-01-01', currentWeight: 90, currentFat: 22 },
      { date: '2026-01-02', currentWeight: 89, currentFat: 21 },
    ], legacyMeasurement: null });
    assert.equal(users.getMeasurementHistory(202).measurements.length, 1);
    assert.equal(users.getDashboard(101, '2025-12-31').progress, null, 'future measurements cannot affect an earlier dashboard');
  } finally { users.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('partial measurements, corrections and clearing one date preserve other dates and undated legacy', () => {
  const f = fixture();
  const users = new Users(f.file);
  try {
    seed(users);
    users.setProfile(101, profile);
    users.setMeasurement(101, '2026-01-01', { currentWeight: 89 });
    users.setMeasurement(101, '2026-01-01', { currentFat: 21 });
    users.setMeasurement(101, '2026-01-02', { currentWeight: 88 });
    assert.deepEqual(users.getMeasurement(101, '2026-01-01'), { date: '2026-01-01', currentWeight: 89, currentFat: 21 });
    assert.equal(users.getMeasurement(101, '2026-01-02').currentFat, null);
    users.setMeasurement(101, '2026-01-01', { currentFat: 20.5 });
    users.setMeasurement(101, '2026-01-01', { currentWeight: null });
    assert.deepEqual(users.getMeasurement(101, '2026-01-01'), { date: '2026-01-01', currentWeight: null, currentFat: 20.5 });
    users.setMeasurement(101, '2026-01-01', { currentWeight: null, currentFat: null });
    assert.equal(users.getMeasurementHistory(101).measurements.length, 1);
    assert.equal(users.getMeasurement(101, '2026-01-02').currentWeight, 88);
    users.setMeasurement(101, '2026-01-02', { currentWeight: null, currentFat: null });
    assert.deepEqual(users.getMeasurementHistory(101), { measurements: [], legacyMeasurement: { currentWeight: 90, currentFat: 22 } });
    assert.equal(users.getDashboard(101, '2026-01-03').progress, 0);
  } finally { users.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('goal edits use the latest known weight, preserve the baseline on empty days and save atomically', () => {
  const f = fixture();
  const users = new Users(f.file);
  try {
    seed(users);
    users.setProfile(101, profile);
    users.setMeasurement(101, '2026-01-01', { currentWeight: 85 });
    users.setProfile(101, { currentWeight: null, currentFat: null, targetWeight: 75, targetFat: 17 }, '2026-01-02');
    let dashboard = users.getDashboard(101, '2026-01-02');
    assert.equal(dashboard.profile.startWeight, 85);
    assert.equal(dashboard.profile.currentWeight, null);
    assert.equal(dashboard.progress, 0);
    users.setMeasurement(101, '2026-01-03', { currentWeight: 84 });
    users.setProfile(101, { currentWeight: null, currentFat: null, targetWeight: 75, targetFat: 16 }, '2026-01-04');
    dashboard = users.getDashboard(101, '2026-01-04');
    assert.equal(dashboard.profile.startWeight, 85);
    assert.equal(dashboard.progress, 10);
    assert.equal(users.getMeasurementHistory(101).legacyMeasurement?.currentWeight, 90);
    const before = users.getMeasurementHistory(101);
    assert.throws(() => users.setProfile(101, { ...profile, currentWeight: 82, targetWeight: -1 }, '2026-01-03'));
    assert.deepEqual(users.getMeasurementHistory(101), before, 'failed goal save must roll back the daily update');
    assert.equal(users.getProfile(101).targetWeight, 75);
    users.setProfile(202, { currentWeight: null, currentFat: null, targetWeight: 80, targetFat: null }, '2026-01-01');
    assert.equal(users.getDashboard(202, '2026-01-01').profile.startWeight, null);
    users.setMeasurement(202, '2026-01-02', { currentWeight: 90 });
    assert.equal(users.getDashboard(202, '2026-01-03').profile.startWeight, 90);
  } finally { users.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('measurement validation accepts explicit emptiness and boundaries, rejecting malformed or overprecise values', () => {
  assert.deepEqual(validateMeasurement({ currentWeight: 20, currentFat: 70 }), { currentWeight: 20, currentFat: 70 });
  assert.deepEqual(validateMeasurement({ currentWeight: 400, currentFat: 1 }), { currentWeight: 400, currentFat: 1 });
  assert.deepEqual(validateMeasurement({ currentWeight: null, currentFat: null }), { currentWeight: null, currentFat: null });
  assert.deepEqual(validateMeasurement({ currentWeight: 90.1, userId: 202 }), { currentWeight: 90.1 });
  for (const bad of [null, [], {}, { userId: 202 }, { currentWeight: '90' }, { currentFat: 0 },
    { currentFat: 70.1 }, { currentWeight: 19.9 }, { currentWeight: 400.1 }, { currentWeight: NaN },
    { currentWeight: Infinity }, { currentWeight: 85.123 }, { currentFat: undefined }]) {
    assert.throws(() => validateMeasurement(bad));
  }
});

function auth(token: string, id: number) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: 'Test' }) });
  params.sort();
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update([...params].map(([key, value]) => `${key}=${value}`).join('\n')).digest('hex'));
  return { Authorization: 'tma ' + params, 'Content-Type': 'application/json' };
}
async function listen(server: Server) {
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); done(); });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

test('measurement API authenticates, isolates accounts, keeps dated data and rejects invalid/future dates', async () => {
  const f = fixture();
  const users = new Users(f.file);
  const token = 'measurement-test-token';
  const server = createApp(token, users);
  try {
    const base = await listen(server);
    const timezone = 'Europe/Moscow';
    const today = todayInTimezone(timezone);
    const tomorrow = new Date(`${today}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const future = tomorrow.toISOString().slice(0, 10);
    const path = `/api/measurements?date=${today}&timezone=${encodeURIComponent(timezone)}`;
    assert.equal((await fetch(base + path)).status, 401);
    assert.equal((await fetch(base + '/api/measurement-history?timezone=UTC')).status, 401);
    const first = await fetch(base + path, { method: 'PATCH', headers: auth(token, 101), body: JSON.stringify({ currentWeight: 85, currentFat: 20, userId: 202 }) });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { measurement: { date: today, currentWeight: 85, currentFat: 20 } });
    const other = await fetch(base + path, { headers: auth(token, 202) });
    assert.deepEqual(await other.json(), { measurement: { date: today, currentWeight: null, currentFat: null } });
    assert.equal((await fetch(base + path, { method: 'PATCH', headers: auth(token, 101), body: '{' })).status, 400);
    for (const date of ['2026-02-30', '2026-13-01', 'not-a-date', future]) {
      const reply = await fetch(base + `/api/measurements?date=${date}&timezone=UTC`, { method: 'PATCH', headers: auth(token, 101), body: JSON.stringify({ currentWeight: 80 }) });
      assert.equal(reply.status, 400, date);
    }
    for (const value of [{ currentWeight: -1 }, { currentFat: 71 }, { currentWeight: 85.123 }, {}]) {
      assert.equal((await fetch(base + path, { method: 'PATCH', headers: auth(token, 101), body: JSON.stringify(value) })).status, 400);
    }
    assert.equal((await fetch(base + `/api/measurements?date=${today}&timezone=invalid`, { headers: auth(token, 101) })).status, 400);
    const blankFuture = await fetch(base + `/api/measurements?date=${future}&timezone=UTC`, { headers: auth(token, 101) });
    assert.equal(blankFuture.status, 200);
    assert.equal((await blankFuture.json()).measurement.currentWeight, null);
    const pastPath = '/api/measurements?date=2020-01-01&timezone=UTC';
    assert.equal((await fetch(base + pastPath, { method: 'PATCH', headers: auth(token, 101), body: JSON.stringify({ currentFat: 19 }) })).status, 200);
    const history = await fetch(base + '/api/measurement-history?timezone=UTC', { headers: auth(token, 101) });
    assert.deepEqual((await history.json()).measurements.map((entry: { date: string }) => entry.date), ['2020-01-01', today]);
    assert.deepEqual((await (await fetch(base + '/api/measurement-history?timezone=UTC', { headers: auth(token, 202) })).json()).measurements, []);
    const todayDashboard = await (await fetch(base + '/api/dashboard?timezone=Europe%2FMoscow', { headers: auth(token, 101) })).json();
    assert.equal(todayDashboard.profile.currentWeight, 85);
    const profilePatch = await fetch(base + '/api/dashboard?timezone=Europe%2FMoscow', { method: 'PATCH', headers: auth(token, 101), body: JSON.stringify({ ...profile, currentWeight: 84 }) });
    assert.equal(profilePatch.status, 200);
    assert.equal(users.getMeasurement(101, today).currentWeight, 84);
    assert.equal(users.getMeasurement(101, '2020-01-01').currentFat, 19);
    assert.equal(users.getMeasurementHistory(101).legacyMeasurement, null);
  } finally {
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
    users.close(); rmSync(f.dir, { recursive: true, force: true });
  }
});
