import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Users } from './users';
import { createApp } from './app';
import { todayInTimezone } from './activity';

const token = 'light-workout-api-test-token';
function auth(id: number) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: 'test' }) });
  params.sort();
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update([...params].map(([key, value]) => key + '=' + value).join('\n')).digest('hex'));
  return { Authorization: 'tma ' + params, 'Content-Type': 'application/json' };
}
function addDays(date: string, count: number) {
  const day = new Date(date + 'T12:00:00Z'); day.setUTCDate(day.getUTCDate() + count); return day.toISOString().slice(0, 10);
}
async function fixture(local = false) {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-light-http-'));
  const file = join(dir, 'fitness.sqlite');
  const users = new Users(file);
  if (local) users.identify({ id: 101, first_name: 'existing' });
  const server = createApp(token, users, dir, local ? { local: { userId: 101, origin: 'http://127.0.0.1:5174' } } : {});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { users, file, server, base: 'http://127.0.0.1:' + address.port,
    async close() { await new Promise<void>(done => server.close(() => done())); users.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('light-workout API authenticates, persists opted-in and manual assignments per account and never awards activity or diary entries', async () => {
  const f = await fixture();
  const today = todayInTimezone('UTC');
  const url = (path: string, date = today) => f.base + path + '?timezone=UTC&date=' + date;
  const send = (id: number, method = 'GET', input?: unknown, path = '/api/light-workouts', date = today) => fetch(url(path, date), {
    method, headers: auth(id), ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  try {
    for (const [path, method] of [['/api/light-workouts', 'GET'], ['/api/light-workouts', 'POST'], ['/api/light-workouts/preferences', 'PATCH'], ['/api/light-workouts/reroll', 'POST']]) {
      assert.equal((await fetch(url(path), { method })).status, 401);
    }
    assert.equal(f.users.list().length, 0);
    const empty = await send(101);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { date: today, dailyEnabled: false, assignment: null, catalogSize: 200, rerollsUsed: 0, rerollsRemaining: 0 });
    const selected = await send(101, 'POST', { userId: 202 });
    assert.equal(selected.status, 200);
    const manual = await selected.json();
    assert.equal(manual.dailyEnabled, false);
    assert.ok(manual.assignment && manual.assignment.exercises.length);
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => send(101, 'POST')));
    for (const response of concurrent) assert.deepEqual(await response.json(), manual);
    assert.deepEqual((await (await send(202)).json()).assignment, null);
    const enabled = await send(101, 'PATCH', { dailyEnabled: true, userId: 202 }, '/api/light-workouts/preferences');
    assert.equal(enabled.status, 200);
    assert.deepEqual(await enabled.json(), { ...manual, dailyEnabled: true });
    assert.equal((await (await send(202)).json()).dailyEnabled, false);
    const disabled = await send(101, 'PATCH', { dailyEnabled: false }, '/api/light-workouts/preferences');
    assert.deepEqual(await disabled.json(), manual);
    const tracking = await fetch(f.base + '/api/tracking/day?timezone=UTC&date=' + today, { headers: auth(101) });
    assert.deepEqual((await tracking.json()).day.completedIds, []);
    const raw = new DatabaseSync(f.file, { readOnly: true });
    try {
      assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM light_workout_assignments').get()!.count, 1);
      assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM tracking_completions').get()!.count, 0);
      assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM workout_exercises').get()!.count, 0);
    } finally { raw.close(); }
  } finally { await f.close(); }
});

test('light-workout API uses the requested timezone, rejects invalid selection dates and does not fill unseen days', async () => {
  const f = await fixture();
  const today = todayInTimezone('UTC');
  const call = (path: string, method = 'GET', input?: unknown) => fetch(f.base + path, { method, headers: auth(101), ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  try {
    const enabled = await call('/api/light-workouts/preferences?timezone=UTC', 'PATCH', { dailyEnabled: true });
    assert.equal(enabled.status, 200);
    for (const date of [addDays(today, -1), addDays(today, 1)]) {
      const path = '/api/light-workouts?timezone=UTC&date=' + date;
      assert.equal((await (await call(path)).json()).assignment, null);
      assert.equal((await call(path, 'POST')).status, 400);
    }
    for (const query of ['timezone=invalid', 'timezone=UTC&date=2026-02-30', 'timezone=UTC&date=bad']) {
      assert.equal((await call('/api/light-workouts?' + query)).status, 400);
    }
    for (const dailyEnabled of [null, 1, 'true', {}, []]) {
      assert.equal((await call('/api/light-workouts/preferences?timezone=UTC', 'PATCH', { dailyEnabled })).status, 400);
    }
    assert.equal((await (await call('/api/light-workouts?timezone=UTC')).json()).dailyEnabled, true);
    for (const timezone of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
      const date = todayInTimezone(timezone);
      const response = await call('/api/light-workouts?timezone=' + encodeURIComponent(timezone) + '&date=' + date, 'POST');
      assert.equal(response.status, 200);
      assert.equal((await response.json()).assignment.date, date);
    }
    const raw = new DatabaseSync(f.file, { readOnly: true });
    try {
      const allowedDates = new Set([today, todayInTimezone('Pacific/Kiritimati'), todayInTimezone('Etc/GMT+12')]);
      const saved = raw.prepare('SELECT date FROM light_workout_assignments WHERE user_id=101').all();
      for (const row of saved) assert.ok(allowedDates.has(String(row.date)));
    } finally { raw.close(); }
  } finally { await f.close(); }
});

function localCall(server: Server, path: string, method = 'GET', headers: Record<string, string> = {}, input?: unknown): Promise<{ status: number; cookie?: string; value: any }> {
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const payload = input === undefined ? undefined : JSON.stringify(input);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path, method,
      headers: { Host: '127.0.0.1:5174', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode!, cookie: response.headers['set-cookie']?.[0].split(';')[0], value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject); req.end(payload);
  });
}

test('local light suggestions require the local cookie and retain same-origin and proxy guards for every mutation', async () => {
  const f = await fixture(true);
  const day = '/api/light-workouts?timezone=UTC';
  const preferences = '/api/light-workouts/preferences?timezone=UTC';
  try {
    assert.equal((await localCall(f.server, day)).status, 401);
    assert.equal((await localCall(f.server, day, 'POST')).status, 401);
    assert.equal((await localCall(f.server, preferences, 'PATCH', {}, { dailyEnabled: true })).status, 401);
    const session = await localCall(f.server, '/api/local/session');
    assert.ok(session.cookie);
    const headers = { Cookie: session.cookie };
    const attacks: Record<string, string>[] = [{ Origin: 'https://other.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'X-Forwarded-For': '203.0.113.1' }, { Host: 'localhost:5174' }];
    for (const attack of attacks) {
      assert.equal((await localCall(f.server, day, 'POST', { ...headers, ...attack })).status, 403);
      assert.equal((await localCall(f.server, preferences, 'PATCH', { ...headers, ...attack }, { dailyEnabled: true })).status, 403);
      assert.equal((await localCall(f.server, '/api/light-workouts/reroll?timezone=UTC', 'POST', { ...headers, ...attack }, { expectedCatalogId: '001' })).status, 403);
    }
    const enabled = await localCall(f.server, preferences, 'PATCH', headers, { dailyEnabled: true, userId: 202 });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.value.dailyEnabled, true);
    assert.ok(enabled.value.assignment);
    assert.deepEqual(f.users.list().map(user => user.id), [101]);
    assert.deepEqual((await localCall(f.server, day, 'GET', headers)).value, enabled.value);
  } finally { await f.close(); }
});
