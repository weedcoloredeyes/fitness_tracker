import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from './app';
import { Users } from './users';
import { todayInTimezone } from './activity';

const origin = 'http://127.0.0.1:5174';
const localUser = { id: 101, first_name: 'Existing', username: 'existing' };
type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function close(server: Server) {
  await new Promise<void>((done) => server.close(() => done()));
}

function call(server: Server, path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: address.port, path, method: options.method ?? 'GET',
      headers: { Host: '127.0.0.1:5174', ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }), ...options.headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function sessionCookie(reply: Reply) {
  assert.equal(reply.status, 200);
  const raw = reply.headers['set-cookie']?.[0];
  assert.ok(raw);
  assert.match(raw, /; HttpOnly/);
  assert.match(raw, /; SameSite=Strict/);
  assert.match(raw, /; Path=\/api/);
  assert.doesNotMatch(raw, /Domain=/i);
  return raw.split(';')[0];
}

test('local mode opens the existing account and saved data; saves survive restart and old cookies expire', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-local-'));
  const file = join(dir, 'fitness.sqlite');
  let users = new Users(file);
  users.identify(localUser);
  users.identify({ id: 202, first_name: 'Other', username: 'NotTofu' });
  const date = todayInTimezone('Europe/Moscow');
  users.setProfile(localUser.id, { currentFat: 20, targetFat: 15, currentWeight: 80, targetWeight: 75 }, date);
  users.setMonthlyWorkoutGoal(localUser.id, date, 12);
  users.setActivity(localUser.id, date, 'training', true);
  const before = users.list();
  let server = await listen(createApp('', users, dir, { local: { userId: localUser.id, origin } }));
  try {
    const bootstrap = await call(server, '/api/local/session');
    const firstCookie = sessionCookie(bootstrap);
    assert.deepEqual(JSON.parse(bootstrap.body), { mode: 'local', user: before.find((user) => user.id === localUser.id) });
    assert.equal(sessionCookie(await call(server, '/api/local/session')), firstCookie, 'parallel bootstrap must not invalidate cookies');
    assert.deepEqual(users.list(), before, 'local bootstrap must not rename users or change admin binding');
    const headers = { Cookie: firstCookie, Authorization: 'tma ', Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
    const dashboard = await call(server, '/api/dashboard?timezone=Europe%2FMoscow', { headers });
    assert.equal(dashboard.status, 200);
    const data = JSON.parse(dashboard.body);
    assert.equal(data.profile.currentWeight, 80);
    assert.equal(data.workouts.goal, 12);
    assert.equal(data.workouts.total, 1);
    const measurementPath = `/api/measurements?date=${date}&timezone=Europe%2FMoscow`;
    const daily = await call(server, measurementPath, { headers });
    assert.equal(daily.status, 200);
    assert.equal(JSON.parse(daily.body).measurement.currentWeight, 80);
    const dailyPatch = await call(server, measurementPath, { method: 'PATCH', headers, body: { currentFat: 19.5, userId: 202 } });
    assert.equal(dailyPatch.status, 200);
    assert.equal(JSON.parse(dailyPatch.body).measurement.currentWeight, 80, 'partial local patch preserves the other measurement');
    assert.equal(users.getMeasurement(202, date).currentFat, null);
    const patch = await call(server, '/api/activity', {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body: { date, timezone: 'Europe/Moscow', kind: 'walking', completed: true, userId: 202 },
    });
    assert.equal(patch.status, 200, patch.body);
    assert.equal(JSON.parse(patch.body).activity.walking, true);
    assert.equal(users.getActivity(202, date).walking, false, 'client cannot choose another user');
    await close(server);
    users.close();
    users = new Users(file);
    server = await listen(createApp('', users, dir, { local: { userId: localUser.id, origin } }));
    assert.equal((await call(server, '/api/dashboard', { headers })).status, 401, 'restart invalidates the previous cookie');
    const nextCookie = sessionCookie(await call(server, '/api/local/session'));
    assert.notEqual(firstCookie, nextCookie);
    const saved = await call(server, `/api/activity?date=${date}&timezone=Europe%2FMoscow`, { headers: { Cookie: nextCookie } });
    assert.equal(saved.status, 200, saved.body);
    assert.equal(JSON.parse(saved.body).activity.training, true);
    assert.equal(JSON.parse(saved.body).activity.walking, true);
    const savedDashboard = await call(server, '/api/dashboard?timezone=Europe%2FMoscow', { headers: { Cookie: nextCookie } });
    assert.equal(JSON.parse(savedDashboard.body).profile.currentWeight, 80);
    assert.equal(JSON.parse(savedDashboard.body).profile.currentFat, 19.5);
    assert.equal(JSON.parse(savedDashboard.body).workouts.goal, 12);
  } finally {
    await close(server);
    users.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local API requires its cookie and rejects CSRF, other hosts and proxy headers before bootstrap or data access', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-local-access-'));
  const users = new Users(join(dir, 'fitness.sqlite'));
  users.identify(localUser);
  const server = await listen(createApp('', users, dir, { local: { userId: localUser.id, origin } }));
  try {
    const cookie = sessionCookie(await call(server, '/api/local/session'));
    for (const path of ['/api/dashboard', '/api/calendar?start=2026-10-01&end=2026-10-31', '/api/form-index', '/api/activity', '/api/admin/users',
      '/api/measurements?date=2026-10-01&timezone=UTC', '/api/measurement-history?timezone=UTC']) {
      assert.equal((await call(server, path)).status, 401, path);
      assert.equal((await call(server, path, { headers: { Cookie: 'fitness_local_session=wrong' } })).status, 401, path);
    }
    assert.equal((await call(server, '/api/auth', { method: 'POST', body: {} })).status, 401);
    assert.equal((await call(server, '/api/activity', { method: 'PATCH', body: {} })).status, 401);
    for (const attackHeaders of [
      { Origin: 'https://attacker.example' },
      { Origin: 'null' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
      { 'Sec-Fetch-Site': 'unknown' },
      { Host: 'attacker.example' },
      { Host: '127.0.0.1:9999' },
      { Host: 'localhost:5174' },
      { Forwarded: 'for=203.0.113.1;host=127.0.0.1:5174' },
      { 'X-Forwarded-For': '203.0.113.1' },
      { 'X-Forwarded-Host': '127.0.0.1:5174' },
      { 'CF-Connecting-IP': '203.0.113.1' },
      { 'CF-Ray': 'test' },
      { 'X-Real-IP': '127.0.0.1' },
    ] as Record<string, string>[]) {
      const headers = { Cookie: cookie, ...attackHeaders };
      assert.equal((await call(server, '/api/local/session', { headers })).status, 403, JSON.stringify(attackHeaders));
      assert.equal((await call(server, '/api/dashboard', { headers })).status, 403, JSON.stringify(attackHeaders));
      assert.equal((await call(server, '/api/activity', { method: 'PATCH', headers, body: {} })).status, 403, JSON.stringify(attackHeaders));
    }
    assert.equal((await call(server, '/api/admin/users', { headers: { Cookie: cookie } })).status, 403, 'local mode does not grant admin rights');
  } finally {
    await close(server);
    users.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local mode strips the Telegram SDK from HTML while the default server leaves it intact and requires Telegram auth', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-local-html-'));
  const users = new Users(join(dir, 'fitness.sqlite'));
  users.identify(localUser);
  mkdirSync(join(dir, 'dist'));
  const root = join(dir, 'dist');
  writeFileSync(join(root, 'index.html'), '<html><head><script src="https://telegram.org/js/telegram-web-app.js"></script></head><body>Fitness</body></html>');
  const local = await listen(createApp('', users, root, { local: { userId: localUser.id, origin } }));
  const normal = await listen(createApp('test-token', users, root));
  try {
    const html = await call(local, '/');
    assert.equal(html.status, 200);
    assert.doesNotMatch(html.body, /telegram-web-app/);
    assert.match(html.body, /Fitness/);
    assert.match((await call(normal, '/')).body, /telegram-web-app/);
    assert.equal((await call(normal, '/api/local/session')).status, 404);
    const cookie = sessionCookie(await call(local, '/api/local/session'));
    assert.equal((await call(normal, '/api/dashboard', { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await call(normal, '/api/auth', { method: 'POST', body: { initData: 'fake' } })).status, 401);
  } finally {
    await close(local);
    await close(normal);
    users.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local mode fails for an absent or invalid existing user and never selects or creates an account', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-local-user-'));
  const users = new Users(join(dir, 'fitness.sqlite'));
  users.identify(localUser);
  try {
    for (const userId of [0, -1, NaN, 202]) {
      assert.throws(() => createApp('', users, dir, { local: { userId, origin } }), /LOCAL_USER_ID/);
    }
    assert.equal(users.list().length, 1);
    assert.throws(() => createApp('', users, dir, { local: { userId: localUser.id, origin: 'http://0.0.0.0:5174' } }));
    assert.throws(() => createApp('', users, dir, { local: { userId: localUser.id, origin: 'https://public.example' } }));
  } finally {
    users.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LOCAL_MODE=1 without LOCAL_USER_ID fails explicitly before creating a database or listening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-local-config-'));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, LOCAL_MODE: '1', PORT: '5174', BOT_TOKEN: '' };
    delete env.LOCAL_USER_ID;
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), new URL('./index.ts', import.meta.url).pathname], {
      cwd: dir, env, encoding: 'utf8', timeout: 10_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LOCAL_USER_ID/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
