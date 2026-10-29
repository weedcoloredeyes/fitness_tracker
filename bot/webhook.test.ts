import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBotConfig } from './create-bot';
import { createWebhookRuntime, parseBotInfo, readWebhookConfig, WEBHOOK_PATH } from './webhook';

const token = '123456:test-token-only';
const secret = 'test-webhook-secret';
const url = new URL('https://fitness.example/app');
const info = { id: 123456, is_bot: true, first_name: 'Fitness', username: 'fitness_test_bot' };
const botInfo = parseBotInfo(info, token);
type Runtime = ReturnType<typeof createWebhookRuntime>;

function startUpdate(text = '/start') {
  return {
    update_id: 1,
    message: {
      message_id: 1, date: Math.floor(Date.now() / 1000),
      from: { id: 42, is_bot: false, first_name: 'Tester' },
      chat: { id: 42, type: 'private', first_name: 'Tester' },
      text, entities: [{ offset: 0, length: text.length, type: 'bot_command' }],
    },
  };
}

function portOf(runtime: Runtime) {
  const address = runtime.server.address();
  assert.ok(address && typeof address === 'object');
  assert.equal(address.address, '127.0.0.1');
  return address.port;
}

function post(runtime: Runtime, header: string | undefined, body: unknown = startUpdate(), method = 'POST', path = WEBHOOK_PATH) {
  return new Promise<{ status: number; type: string | undefined; body: string }>((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: portOf(runtime), method, path,
      headers: {
        'Content-Type': 'application/json', Connection: 'close',
        ...(header === undefined ? {} : { 'X-Telegram-Bot-Api-Secret-Token': header }),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, type: res.headers['content-type'], body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

function fixture() {
  let calls = 0;
  const runtime = createWebhookRuntime({
    token, secret, url, botInfo,
    fetch: async () => { calls++; throw new Error('Unexpected outgoing Telegram request'); },
  });
  return { runtime, calls: () => calls };
}

test('webhook rejects a missing or wrong secret before parsing the update and never fetches Telegram', async () => {
  const f = fixture();
  await f.runtime.listen(0);
  try {
    for (const header of [undefined, 'wrong-secret', 'test-webhook-secreu']) {
      const response = await post(f.runtime, header, '{malformed');
      assert.equal(response.status, 401);
    }
    assert.equal(f.calls(), 0);
  } finally { await f.runtime.stop(); }
});

test('authenticated /start replies with one sendMessage and Mini App URL without any outgoing API call', async () => {
  const f = fixture();
  await f.runtime.listen(0);
  try {
    for (const text of ['/start', '/start@fitness_test_bot']) {
      const response = await post(f.runtime, secret, startUpdate(text));
      assert.equal(response.status, 200);
      assert.equal(response.type, 'application/json');
      const reply = JSON.parse(response.body);
      assert.equal(reply.method, 'sendMessage');
      assert.equal(reply.chat_id, 42);
      assert.equal(reply.text, 'Нажми кнопку, чтобы открыть приложение.');
      assert.deepEqual(reply.reply_markup.inline_keyboard, [[{
        text: 'Открыть приложение', web_app: { url: url.href },
      }]]);
    }
    assert.equal(f.calls(), 0);
  } finally { await f.runtime.stop(); }
});

test('webhook only accepts POST on its fixed path and acknowledges unrelated updates without network', async () => {
  const f = fixture();
  await f.runtime.listen(0);
  try {
    assert.equal((await post(f.runtime, secret, {}, 'GET')).status, 405);
    assert.equal((await post(f.runtime, secret, {}, 'POST', '/')).status, 404);
    const response = await post(f.runtime, secret, { update_id: 2 });
    assert.equal(response.status, 200);
    assert.equal(response.body, '');
    assert.equal(f.calls(), 0);
  } finally { await f.runtime.stop(); }
});

test('graceful shutdown stops accepting connections and lets an active webhook finish', { timeout: 5000 }, async () => {
  const f = fixture();
  await f.runtime.listen(0);
  const body = JSON.stringify(startUpdate());
  const incoming = once(f.runtime.server, 'request');
  const req = request({
    hostname: '127.0.0.1', port: portOf(f.runtime), method: 'POST', path: WEBHOOK_PATH,
    headers: { 'Content-Length': Buffer.byteLength(body), Connection: 'close', 'X-Telegram-Bot-Api-Secret-Token': secret },
  });
  const received = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req.on('error', reject);
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
  });
  req.write(body.slice(0, 10));
  await incoming;
  const stopped = f.runtime.stop(1000);
  assert.equal(f.runtime.server.listening, false);
  assert.equal(f.runtime.stop(), stopped);
  req.end(body.slice(10));
  const response = await received;
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).method, 'sendMessage');
  await stopped;
  assert.equal(f.runtime.server.address(), null);
  assert.equal(f.calls(), 0);
});

test('cached getMe must describe this bot; full API response and bare result are accepted', () => {
  assert.deepEqual(parseBotInfo(info, token), info);
  assert.deepEqual(parseBotInfo({ ok: true, result: info }, token), info);
  for (const invalid of [
    { ...info, id: 654321 }, { ...info, is_bot: false }, { ...info, username: '' },
    { ...info, first_name: '' }, { ok: false, result: info }, {}, null,
  ]) assert.throws(() => parseBotInfo(invalid, token));
  assert.throws(() => parseBotInfo(info, 'invalid-token'));
});

test('polling stays the default; webhook validates its secret, port and cached bot information', () => {
  assert.equal(readBotConfig({ BOT_TOKEN: token, WEB_APP_URL: url.href }).transport, 'polling');
  assert.equal(readBotConfig({ BOT_TOKEN: token, WEB_APP_URL: url.href, BOT_TRANSPORT: 'webhook' }).transport, 'webhook');
  assert.throws(() => readBotConfig({ BOT_TOKEN: token, WEB_APP_URL: url.href, BOT_TRANSPORT: 'unknown' }));
  const dir = mkdtempSync(join(tmpdir(), 'fitness-webhook-config-'));
  const file = join(dir, 'bot-info.json');
  writeFileSync(file, JSON.stringify({ ok: true, result: info }));
  const env = { WEBHOOK_SECRET: secret, BOT_INFO_FILE: file };
  try {
    assert.deepEqual(readWebhookConfig(token, env), { port: 8081, secret, botInfo });
    assert.equal(readWebhookConfig(token, { ...env, WEBHOOK_PORT: '8082' }).port, 8082);
    for (const value of ['', '0', '65536', '-1', 'not-a-port']) {
      assert.throws(() => readWebhookConfig(token, { ...env, WEBHOOK_PORT: value }));
    }
    for (const value of ['', 'invalid secret', 'x'.repeat(257)]) {
      assert.throws(() => readWebhookConfig(token, { ...env, WEBHOOK_SECRET: value }));
    }
    assert.throws(() => readWebhookConfig(token, { BOT_INFO_FILE: file }));
    assert.throws(() => readWebhookConfig(token, { ...env, BOT_INFO_FILE: join(dir, 'missing.json') }));
    writeFileSync(file, '{invalid');
    assert.throws(() => readWebhookConfig(token, env));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
