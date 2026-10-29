import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Users } from './users';
import { createApp } from './app';
import { todayInTimezone } from './activity';

const token = 'tracking-api-test-token';
function auth(id: number) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: 'test' }) });
  params.sort();
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update([...params].map(([k, v]) => k + '=' + v).join('\n')).digest('hex'));
  return { Authorization: 'tma ' + params, 'Content-Type': 'application/json' };
}

test('tracking API isolates definitions, dated marks and goals, requires auth and rejects invalid/future edits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracking-http-'));
  const users = new Users(join(dir, 'fitness.sqlite'));
  const server = createApp(token, users);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = 'http://127.0.0.1:' + address.port;
  const today = todayInTimezone('UTC');
  const future = new Date(today + 'T12:00:00Z'); future.setUTCDate(future.getUTCDate() + 1);
  const tomorrow = future.toISOString().slice(0, 10);
  const endpoint = (path: string, extra = '') => base + path + '?timezone=UTC' + extra;
  const send = (path: string, id: number, method = 'GET', body?: unknown, extra = '') => fetch(endpoint(path, extra), { method, headers: auth(id), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  try {
    for (const path of ['/api/tracking/day', '/api/tracking/definitions', '/api/tracking/month', '/api/workouts', '/api/workouts/latest']) assert.equal((await fetch(endpoint(path))).status, 401);
    const defs = await send('/api/tracking/definitions', 101);
    assert.equal(defs.status, 200);
    const first = (await defs.json()).definitions;
    assert.equal(first.filter((d: { archived: boolean }) => !d.archived).length, 2);
    const created = await send('/api/tracking/definitions', 101, 'POST', { name: 'ВЕЛОСИПЁД', category: 'cardio', userId: 202 });
    assert.equal(created.status, 200);
    const all = (await created.json()).definitions;
    const bike = all.find((d: { name: string }) => d.name === 'велосипед');
    assert.ok(bike);
    const other = await send('/api/tracking/definitions', 202);
    assert.equal((await other.json()).definitions.length, 2);
    assert.equal((await send('/api/tracking/day', 202, 'PATCH', { id: bike.id, completed: true }, '&date=' + today)).status, 400);
    assert.equal((await send('/api/tracking/definitions', 202, 'PATCH', { id: bike.id, name: 'чужая' })).status, 400);
    const completed = await send('/api/tracking/day', 101, 'PATCH', { id: bike.id, completed: true }, '&date=' + today);
    assert.equal(completed.status, 200);
    const day = (await completed.json()).day;
    assert.equal(day.cardioFraction, 0.5);
    assert.equal(day.score, 25);
    assert.equal((await send('/api/tracking/definitions', 101, 'PATCH', { id: bike.id, name: 'БЕГ' })).status, 200);
    assert.equal((await (await send('/api/tracking/day', 101, 'GET', undefined, '&date=' + today)).json()).day.definitions.find((d: { id: string }) => d.id === bike.id).name, 'бег');
    const goals = await send('/api/tracking/goals', 101, 'PATCH', { strength: 12, cardio: 20 });
    assert.equal(goals.status, 200);
    const month = (await goals.json()).month;
    assert.equal(month.strength.goal, 12);
    assert.equal(month.cardio.goal, 20);
    assert.equal(month.cardio.earned, 0.5);
    assert.equal(month.score, 1.25);
    assert.equal((await (await send('/api/tracking/month', 202)).json()).month.score, null);
    for (const bad of [{ name: '', category: 'cardio' }, { name: 'test', category: 'wrong' }]) assert.equal((await send('/api/tracking/definitions', 101, 'POST', bad)).status, 400);
    assert.equal((await send('/api/tracking/goals', 101, 'PATCH', { strength: 0, cardio: 20 })).status, 400);
    assert.equal((await send('/api/tracking/day', 101, 'PATCH', { id: bike.id, completed: true }, '&date=' + tomorrow)).status, 400);
    assert.equal((await send('/api/tracking/day', 101, 'GET', undefined, '&date=2026-02-30')).status, 400);
    assert.equal((await send('/api/tracking/month', 101, 'GET', undefined, '&month=2026-13')).status, 400);
    assert.equal((await fetch(base + '/api/tracking/month?timezone=bad', { headers: auth(101) })).status, 400);
    const calendar = await send('/api/tracking/calendar', 101, 'GET', undefined, '&start=' + today + '&end=' + today);
    assert.equal(calendar.status, 200);
    assert.equal((await calendar.json()).days[0].completedIds.includes(bike.id), true);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    users.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('workout API saves a full UTF-8 diary, isolates users and never awards a completion from exercises', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workout-http-'));
  const users = new Users(join(dir, 'fitness.sqlite'));
  const server = createApp(token, users);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = 'http://127.0.0.1:' + address.port;
  const today = todayInTimezone('UTC');
  const path = '/api/workouts?timezone=UTC&date=' + today;
  const exercises = Array.from({ length: 50 }, (_, i) => ({ id: 'exercise-' + i, name: '測'.repeat(120), reps: 10, sets: 3, weight: null }));
  try {
    const saved = await fetch(base + path, { method: 'PATCH', headers: auth(101), body: JSON.stringify({ exercises, userId: 202 }) });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).workout.exercises.length, 50);
    assert.equal((await (await fetch(base + path, { headers: auth(202) })).json()).workout.exercises.length, 0);
    const tracking = await fetch(base + '/api/tracking/day?timezone=UTC&date=' + today, { headers: auth(101) });
    assert.deepEqual((await tracking.json()).day.completedIds, []);
    const invalid = await fetch(base + path, { method: 'PATCH', headers: auth(101), body: JSON.stringify({ exercises: [{ ...exercises[0], sets: -1 }] }) });
    assert.equal(invalid.status, 400);
    assert.equal((await (await fetch(base + path, { headers: auth(101) })).json()).workout.exercises.length, 50);
    const before = new Date(today + 'T12:00:00Z'); before.setUTCDate(before.getUTCDate() + 1);
    const latest = await fetch(base + '/api/workouts/latest?timezone=UTC&before=' + before.toISOString().slice(0, 10), { headers: auth(101) });
    assert.equal(latest.status, 200);
    assert.equal((await latest.json()).workout.date, today);
    assert.equal((await fetch(base + '/api/workouts?timezone=UTC&date=' + before.toISOString().slice(0, 10), { method: 'PATCH', headers: auth(101), body: JSON.stringify({ exercises: [] }) })).status, 400);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    users.close(); rmSync(dir, { recursive: true, force: true });
  }
});
