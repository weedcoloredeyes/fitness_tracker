import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './app';
import { Users } from './users';
import { todayInTimezone } from './activity';

const token = 'light-completion-fixture-token';
const manual = (id: string, reps = 10) => ({ id, name: 'мое упражнение', reps, sets: 2, weight: null });
function auth(id: number) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: 'fixture' }) });
  params.sort();
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update([...params].map(([key, value]) => key + '=' + value).join('\n')).digest('hex'));
  return { Authorization: 'tma ' + params, 'Content-Type': 'application/json' };
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-light-completion-'));
  const file = join(dir, 'fitness.sqlite');
  const users = new Users(file);
  users.identify({ id: 101, first_name: 'fixture' });
  users.identify({ id: 202, first_name: 'other' });
  const server = createApp(token, users, dir);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const date = todayInTimezone('UTC');
  const call = async (path: string, method = 'GET', input?: unknown, userId = 101) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}?timezone=UTC&date=${date}`, {
      method, headers: auth(userId), ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, value: await response.json() };
  };
  return { users, file, date, call, async close() {
    await new Promise<void>(done => server.close(() => done())); users.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test('light completion imports the assigned exercises once, preserves manual edits and removes only imported rows on undo', async () => {
  const f = await fixture();
  try {
    const selected = await f.call('/api/light-workouts', 'POST');
    assert.equal(selected.status, 200);
    const assigned = selected.value.assignment;
    await f.call('/api/workouts', 'PATCH', { exercises: [manual('manual')] });
    const completed = await f.call('/api/tracking/day', 'PATCH', { id: 'light', completed: true });
    assert.equal(completed.status, 200); assert.equal(completed.value.day.score, 25);
    const first = (await f.call('/api/workouts')).value.workout;
    assert.deepEqual(first.exercises.filter((row: any) => row.source !== 'light'), [manual('manual')]);
    const automatic = first.exercises.filter((row: any) => row.source === 'light');
    assert.deepEqual(automatic.map((row: any) => row.sourceText), assigned.exercises);
    await f.call('/api/tracking/day', 'PATCH', { id: 'light', completed: true });
    assert.deepEqual((await f.call('/api/workouts')).value.workout, first, 'repeated completion must not duplicate entries');
    const saved = await f.call('/api/workouts', 'PATCH', { exercises: [manual('manual', 11), ...automatic.map((row: any) => ({ ...row, name: 'измененная копия' }))] });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.value.workout.exercises.filter((row: any) => row.source === 'light'), automatic);
    await f.call('/api/tracking/day', 'PATCH', { id: 'light', completed: false });
    assert.deepEqual((await f.call('/api/workouts')).value.workout.exercises, [manual('manual', 11)]);
    await f.call('/api/workouts', 'PATCH', { exercises: [manual('manual', 11), ...automatic] });
    assert.deepEqual((await f.call('/api/workouts')).value.workout.exercises, [manual('manual', 11)], 'a stale diary cannot revive undone imported rows');
    await f.call('/api/tracking/day', 'PATCH', { id: 'light', completed: true });
    assert.deepEqual((await f.call('/api/workouts')).value.workout.exercises.filter((row: any) => row.source === 'light'), automatic);
    assert.deepEqual((await f.call('/api/workouts', 'GET', undefined, 202)).value.workout.exercises, []);
  } finally { await f.close(); }
});

test('reroll is refused while completed and imports the replacement only after a new completion', async () => {
  const f = await fixture();
  try {
    const first = (await f.call('/api/light-workouts', 'POST')).value;
    const lease = { expectedCatalogId: first.assignment.catalogId };
    assert.equal((await f.call('/api/light-workouts/reroll', 'POST', lease, 202)).status, 409);
    await f.call('/api/tracking/day', 'PATCH', { id: 'light', completed: true });
    assert.equal((await f.call('/api/light-workouts/reroll', 'POST', lease)).status, 409);
    assert.equal((await f.call('/api/light-workouts')).value.rerollsRemaining, 1);
    await f.call('/api/tracking/day', 'PATCH', { id: 'light', completed: false });
    const changed = await f.call('/api/light-workouts/reroll', 'POST', lease);
    assert.equal(changed.status, 200); assert.equal(changed.value.rerollsUsed, 1); assert.equal(changed.value.rerollsRemaining, 0);
    assert.notEqual(changed.value.assignment.catalogId, first.assignment.catalogId);
    assert.deepEqual((await f.call('/api/light-workouts/reroll', 'POST', lease)).value, changed.value, 'a lost response can be retried without a second reroll');
    const again = await f.call('/api/light-workouts/reroll', 'POST', { expectedCatalogId: changed.value.assignment.catalogId });
    assert.equal(again.status, 409);
    assert.deepEqual((await f.call('/api/workouts')).value.workout.exercises, []);
    await f.call('/api/tracking/day', 'PATCH', { id: 'light', completed: true });
    assert.deepEqual((await f.call('/api/workouts')).value.workout.exercises.map((row: any) => row.sourceText), changed.value.assignment.exercises);
    const raw = new DatabaseSync(f.file, { readOnly: true });
    try { assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM light_workout_issuances WHERE user_id=101').get()!.count, 2); }
    finally { raw.close(); }
  } finally { await f.close(); }
});

test('diary-capacity failure rolls back the completion and multiple light marks share one imported set', async () => {
  const f = await fixture();
  try {
    const selected = (await f.call('/api/light-workouts', 'POST')).value.assignment;
    f.users.tracking.workouts.setDay(101, f.date, { exercises: Array.from({ length: 50 }, (_, n) => manual('manual-' + n)) });
    const failed = await f.call('/api/tracking/day', 'PATCH', { id: 'light', completed: true });
    assert.equal(failed.status, 400);
    assert.deepEqual(f.users.tracking.getDay(101, f.date).completedIds, []);
    assert.equal(f.users.tracking.workouts.getDay(101, f.date).exercises.length, 50);
    f.users.tracking.workouts.setDay(101, f.date, { exercises: [manual('manual')] });
    const second = f.users.tracking.createDefinition(101, { name: 'растяжка', category: 'light' }, f.date);
    f.users.setTrackingCompletion(101, f.date, 'light', true);
    f.users.setTrackingCompletion(101, f.date, second.id, true);
    const expectedLength = selected.exercises.length + 1;
    assert.equal(f.users.tracking.workouts.getDay(101, f.date).exercises.length, expectedLength);
    f.users.setTrackingCompletion(101, f.date, 'light', false);
    assert.equal(f.users.tracking.workouts.getDay(101, f.date).exercises.length, expectedLength);
    f.users.setTrackingCompletion(101, f.date, second.id, false);
    assert.deepEqual(f.users.tracking.workouts.getDay(101, f.date).exercises, [manual('manual')]);
    f.users.setTrackingCompletion(202, f.date, 'light', true);
    assert.equal(f.users.lightWorkouts.getSavedAssignment(202, f.date), null, 'a mark cannot create an unseen workout');
    assert.deepEqual(f.users.tracking.workouts.getDay(202, f.date).exercises, []);
  } finally { await f.close(); }
});
