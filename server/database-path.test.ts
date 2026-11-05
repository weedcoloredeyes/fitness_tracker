import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Users } from './users';

const entry = fileURLToPath(new URL('./index.ts', import.meta.url));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-database-path-'));
  const cwd = join(dir, 'code');
  mkdirSync(cwd);
  const preload = join(dir, 'without-listening.mjs');
  // Exercise the real entry point and createApp validation without opening a port.
  writeFileSync(preload, `import { Server } from 'node:http';
Server.prototype.listen = function (...args) {
  const callback = args.at(-1);
  if (typeof callback === 'function') callback();
  return this;
};
`);
  return {
    dir, cwd,
    start(overrides: NodeJS.ProcessEnv = {}) {
      const env: NodeJS.ProcessEnv = { ...process.env, LOCAL_MODE: '1', LOCAL_USER_ID: '101', PORT: '5174', BOT_TOKEN: '' };
      delete env.DATABASE_PATH;
      Object.assign(env, overrides);
      return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', preload, entry], {
        cwd, env, encoding: 'utf8', timeout: 10_000,
      });
    },
    close() { rmSync(dir, { recursive: true, force: true }); },
  };
}

function seed(file: string, id = 101) {
  const users = new Users(file);
  users.identify({ id, first_name: 'database path fixture' });
  users.close();
}

function assertStarted(result: ReturnType<typeof spawnSync>) {
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /Сервер: http:\/\/127\.0\.0\.1:5174/);
}

test('the default database path remains data/fitness.sqlite when DATABASE_PATH is omitted or blank', () => {
  const f = fixture();
  try {
    seed(join(f.cwd, 'data', 'fitness.sqlite'));
    for (const overrides of [{}, { DATABASE_PATH: '' }, { DATABASE_PATH: '   ' }]) {
      assertStarted(f.start(overrides));
    }
  } finally { f.close(); }
});

test('an absolute DATABASE_PATH opens the external local account and leaves a code-local database untouched', () => {
  const f = fixture();
  try {
    const external = join(f.dir, 'runtime', 'fitness.sqlite');
    const codeLocal = join(f.cwd, 'data', 'fitness.sqlite');
    seed(external, 202);
    seed(codeLocal, 101);
    const before = createHash('sha256').update(readFileSync(codeLocal)).digest('hex');
    assertStarted(f.start({ DATABASE_PATH: external, LOCAL_USER_ID: '202' }));
    assert.equal(createHash('sha256').update(readFileSync(codeLocal)).digest('hex'), before);
    const db = new DatabaseSync(external, { readOnly: true });
    try { assert.deepEqual(db.prepare('SELECT id FROM users').all().map(row => row.id), [202]); }
    finally { db.close(); }
  } finally { f.close(); }
});

test('a relative DATABASE_PATH resolves from the working directory without creating data inside the code', () => {
  const f = fixture();
  try {
    seed(join(f.dir, 'runtime', 'fitness.sqlite'));
    assertStarted(f.start({ DATABASE_PATH: '../runtime/fitness.sqlite' }));
    assert.equal(existsSync(join(f.cwd, 'data')), false);
  } finally { f.close(); }
});

test('a missing configured database in local mode fails without creating either database location', () => {
  const f = fixture();
  try {
    const missing = join(f.dir, 'missing-runtime', 'fitness.sqlite');
    for (const path of [missing, '../missing-runtime/fitness.sqlite']) {
      const result = f.start({ DATABASE_PATH: path });
      assert.notEqual(result.status, 0);
      assert.match(String(result.stderr), /нужна существующая база по пути DATABASE_PATH/);
      assert.equal(existsSync(missing), false);
      assert.equal(existsSync(dirname(missing)), false);
      assert.equal(existsSync(join(f.cwd, 'data')), false);
    }
  } finally { f.close(); }
});

test('legacy users are imported only from beside the configured database', () => {
  const f = fixture();
  try {
    const external = join(f.dir, 'runtime', 'fitness.sqlite');
    mkdirSync(dirname(external));
    new DatabaseSync(external).close();
    const legacy = (id: number) => ({ adminId: id, users: [{ id, first_name: 'legacy fixture', firstSeen: '2026-01-01', lastSeen: '2026-01-01' }] });
    writeFileSync(join(dirname(external), 'users.json'), JSON.stringify(legacy(202)));
    mkdirSync(join(f.cwd, 'data'));
    writeFileSync(join(f.cwd, 'data', 'users.json'), JSON.stringify(legacy(101)));
    assertStarted(f.start({ DATABASE_PATH: external, LOCAL_USER_ID: '202' }));
    assert.equal(existsSync(join(f.cwd, 'data', 'fitness.sqlite')), false);
    const db = new DatabaseSync(external, { readOnly: true });
    try { assert.deepEqual(db.prepare('SELECT id FROM users').all().map(row => row.id), [202]); }
    finally { db.close(); }
  } finally { f.close(); }
});
