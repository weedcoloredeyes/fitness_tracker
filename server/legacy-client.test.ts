import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { request as httpRequest, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './app';
import { Users } from './users';

const token = 'legacy-client-test-token';
const message = 'приложение обновлено. полностью закрой миниаппку и открой снова через бота, чтобы сохранить отметку.';

function credentials(id = 101) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: 'Updated name' }) });
  params.sort();
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update([...params].map(([key, value]) => key + '=' + value).join('\n')).digest('hex'));
  return { Authorization: 'tma ' + params, 'Content-Type': 'application/json' };
}

function snapshot(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return JSON.stringify(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(row => {
        const name = String(row.name);
        assert.match(name, /^[a-z_]+$/);
        const columns = db.prepare('PRAGMA table_info(' + name + ')').all().map(column => String(column.name));
        return { name, rows: db.prepare('SELECT * FROM ' + name + ' ORDER BY ' + columns.join(',')).all() };
      }));
  } finally { db.close(); }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); done(); });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return 'http://127.0.0.1:' + address.port;
}

function rejectBeforeBody(base: string): Promise<{ status: number; body: string }> {
  return new Promise((done, reject) => {
    const request = httpRequest(base + '/api/activity', {
      method: 'PATCH', headers: { ...credentials(), 'Content-Length': '1000', Connection: 'close' },
    }, response => {
      const parts: Buffer[] = [];
      response.on('data', chunk => parts.push(Buffer.from(chunk)));
      response.on('end', () => { clearTimeout(timeout); request.destroy(); done({ status: response.statusCode!, body: Buffer.concat(parts).toString('utf8') }); });
    });
    const timeout = setTimeout(() => { request.destroy(); reject(new Error('legacy rejection waited for the request body')); }, 3000);
    request.on('error', error => { clearTimeout(timeout); reject(error); });
    request.flushHeaders();
    // Deliberately leave the declared body unsent: the guard must answer without reading it.
  });
}

test('retired legacy writes reject authenticated clients before body parsing or any database mutation while legacy reads remain available', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-legacy-client-'));
  const file = join(dir, 'fitness.sqlite');
  const users = new Users(file);
  users.identify({ id: 101, first_name: 'Original name' });
  users.setActivity(101, '2026-01-01', 'training', true);
  const cardio = users.tracking.getDefinitions(101).find(item => item.category === 'cardio')!;
  users.tracking.setCompletion(101, '2026-01-02', cardio.id, true);
  const server = createApp(token, users, dir, { legacyActivityWrites: 'reject' });
  try {
    const base = await listen(server);
    const before = snapshot(file);
    const input = JSON.stringify({ timezone: 'UTC', date: '2026-01-01', kind: 'walking', completed: true });
    const unauthenticated = await fetch(base + '/api/activity', { method: 'PATCH', body: input });
    assert.equal(unauthenticated.status, 401);
    for (const [headers, body] of [[credentials(), input], [credentials(), '{'], [credentials(202), input]] as const) {
      const response = await fetch(base + '/api/activity', { method: 'PATCH', headers, body });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: message });
    }
    const streaming = await rejectBeforeBody(base);
    assert.equal(streaming.status, 409);
    assert.deepEqual(JSON.parse(streaming.body), { error: message });
    assert.equal(snapshot(file), before, 'neither account identification nor legacy/tracking writes may run before rejection');
    assert.equal(users.list().length, 1, 'a signed unknown account must not be created by a retired write');

    const readable = await fetch(base + '/api/activity?timezone=UTC&date=2026-01-01', { headers: credentials() });
    assert.equal(readable.status, 200);
    assert.deepEqual(await readable.json(), { activity: { date: '2026-01-01', training: true, microTraining: false, walking: false } });
  } finally {
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
    users.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('the actual local and production entry point enables legacy rejection without opening a network listener', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-legacy-entry-'));
  const index = new URL('./index.ts', import.meta.url);
  const appModule = new URL('./app.ts', import.meta.url);
  const loader = join(dir, 'capture-app-loader.mjs');
  const register = join(dir, 'register-capture.mjs');
  const stub = `export function createApp(token, users, root, options) {
    process.stdout.write('captured-options:' + JSON.stringify(options) + '\\n');
    return { listen() {}, on() {}, close() {} };
  }`;
  writeFileSync(loader, `export async function resolve(specifier, context, next) {
    const resolved = await next(specifier, context);
    if (resolved.url.split('?')[0] === ${JSON.stringify(appModule.href)}) {
      return { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(stub))}, shortCircuit: true };
    }
    return resolved;
  }`);
  writeFileSync(register, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)}, import.meta.url);`);
  const users = new Users(join(dir, 'data', 'fitness.sqlite'));
  users.identify({ id: 101, first_name: 'Entry fixture' });
  users.close();
  try {
    for (const mode of ['0', '1']) {
      const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', pathToFileURL(register).href, index.pathname], {
        cwd: dir, env: { ...process.env, BOT_TOKEN: token, LOCAL_MODE: mode, LOCAL_USER_ID: '101', PORT: '5174' },
        encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stderr);
      const captured = result.stdout.split('\n').find(line => line.startsWith('captured-options:'));
      assert.ok(captured, 'the real entry point must call createApp');
      const options = JSON.parse(captured.slice('captured-options:'.length));
      assert.equal(options.legacyActivityWrites, 'reject', 'every official startup must retire legacy writes');
      if (mode === '1') assert.deepEqual(options.local, { userId: 101, origin: 'http://127.0.0.1:5174' });
      else assert.equal(options.local, undefined);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
