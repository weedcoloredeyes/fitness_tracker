import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Users } from './users';
import { LightWorkouts } from './light-workouts';
import type { LightWorkoutSet } from './light-workout-types';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-light-workouts-'));
  const file = join(dir, 'fitness.sqlite');
  let users = new Users(file);
  users.identify({ id: 101, first_name: 'first' });
  users.identify({ id: 202, first_name: 'second' });
  return { file, get users() { return users; }, restart() { users.close(); users = new Users(file); },
    close() { users.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('light suggestions are off by default; manual selection is stable, isolated and survives a restart without marking training', () => {
  const f = fixture();
  const date = '2026-11-04';
  try {
    const original = f.users.tracking.getDay(101, date);
    assert.deepEqual(f.users.lightWorkouts.getDay(101, date, date), { date, dailyEnabled: false, assignment: null, catalogSize: 200, rerollsUsed: 0, rerollsRemaining: 0 });
    const first = f.users.lightWorkouts.selectToday(101, date, date);
    assert.equal(first.dailyEnabled, false);
    assert.ok(first.assignment && first.assignment.exercises.length > 0);
    assert.deepEqual(f.users.lightWorkouts.selectToday(101, date, date), first);
    assert.deepEqual(f.users.lightWorkouts.getDay(202, date, date).assignment, null);
    assert.deepEqual(f.users.tracking.getDay(101, date), original);
    assert.deepEqual(f.users.tracking.workouts.getDay(101, date), { date, exercises: [] });
    f.restart();
    assert.deepEqual(f.users.lightWorkouts.getDay(101, date, date), first);
    assert.deepEqual(f.users.tracking.getDay(101, date), original);
    const raw = new DatabaseSync(f.file, { readOnly: true });
    try {
      assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM light_workout_preferences').get()!.count, 0);
      assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM light_workout_assignments').get()!.count, 1);
    } finally { raw.close(); }
  } finally { f.close(); }
});

test('opting in creates only the current requested day, keeps assignments when disabled and does not backfill history or future dates', () => {
  const f = fixture();
  const today = '2026-11-04', tomorrow = '2026-11-05';
  try {
    const first = f.users.lightWorkouts.setDailyEnabled(101, true, today);
    assert.ok(first.assignment);
    assert.equal(first.dailyEnabled, true);
    assert.deepEqual(f.users.lightWorkouts.getDay(101, today, today), first);
    assert.deepEqual(f.users.lightWorkouts.getDay(101, tomorrow, today), { date: tomorrow, dailyEnabled: true, assignment: null, catalogSize: 200, rerollsUsed: 0, rerollsRemaining: 0 });
    assert.equal(f.users.lightWorkouts.getDay(101, '2026-11-03', today).assignment, null);
    assert.throws(() => f.users.lightWorkouts.selectToday(101, tomorrow, today));
    assert.throws(() => f.users.lightWorkouts.selectToday(101, '2026-11-03', today));
    const disabled = f.users.lightWorkouts.setDailyEnabled(101, false, today);
    assert.equal(disabled.dailyEnabled, false);
    assert.deepEqual(disabled.assignment, first.assignment);
    assert.equal(f.users.lightWorkouts.getDay(101, tomorrow, tomorrow).assignment, null);
    assert.deepEqual(f.users.lightWorkouts.setDailyEnabled(101, true, today), first);
    const next = f.users.lightWorkouts.getDay(101, tomorrow, tomorrow);
    assert.ok(next.assignment);
    assert.notEqual(next.assignment.catalogId, first.assignment.catalogId);
    assert.deepEqual(f.users.lightWorkouts.getDay(101, today, tomorrow).assignment, first.assignment);
    assert.equal(f.users.lightWorkouts.getDay(101, '2026-11-02', tomorrow).assignment, null);
    assert.equal(f.users.lightWorkouts.getDay(202, tomorrow, tomorrow).dailyEnabled, false);
    f.restart();
    assert.deepEqual(f.users.lightWorkouts.getDay(101, tomorrow, tomorrow), next);
  } finally { f.close(); }
});

test('stored dated snapshots survive catalog changes and recent identical contents are excluded even under another catalog id', () => {
  const f = fixture();
  const raw = new DatabaseSync(f.file);
  const set = (id: string, exercise: string): LightWorkoutSet => ({ id, title: 'набор ' + id, exercises: [exercise], note: 'суммарно' });
  try {
    const one = new LightWorkouts(raw, [set('old', '10 приседаний')]);
    const original = one.selectToday(101, '2026-11-04', '2026-11-04');
    const changed = new LightWorkouts(raw, [set('old', '30 приседаний'), set('new', '10 приседаний'), set('next', '20 отжиманий')]);
    assert.deepEqual(changed.getDay(101, '2026-11-04', '2026-11-04').assignment, original.assignment);
    const next = changed.selectToday(101, '2026-11-05', '2026-11-05');
    assert.equal(next.assignment!.catalogId, 'next', 'both a recent ID and the same exercises with another ID are excluded');
    assert.deepEqual(changed.getDay(101, '2026-11-04', '2026-11-05').assignment, original.assignment);
    const fallback = new LightWorkouts(raw, [set('next', '20 отжиманий')]);
    assert.throws(() => fallback.selectToday(101, '2026-11-06', '2026-11-06'), /последние 60/, 'an exhausted catalog cannot bypass the exclusion window');
  } finally { raw.close(); f.close(); }
});

test('new daily assignments avoid recent sets and never create records for skipped days', () => {
  const f = fixture();
  try {
    const chosen: string[] = [];
    f.users.lightWorkouts.setDailyEnabled(101, true, '2026-11-01');
    for (let n = 1; n <= 9; n++) {
      const date = '2026-11-' + String(n).padStart(2, '0');
      const assignment = f.users.lightWorkouts.getDay(101, date, date).assignment!;
      assert.ok(!chosen.slice(-7).includes(assignment.catalogId));
      chosen.push(assignment.catalogId);
    }
    f.users.lightWorkouts.getDay(101, '2026-11-20', '2026-11-20');
    assert.equal(f.users.lightWorkouts.getDay(101, '2026-11-10', '2026-11-20').assignment, null);
  } finally { f.close(); }
});

test('invalid preferences and assignment failures roll back atomically without creating users or touching workout progress', () => {
  const f = fixture();
  const raw = new DatabaseSync(f.file);
  try {
    for (const bad of [undefined, null, 0, 1, 'true', [], {}]) assert.throws(() => f.users.lightWorkouts.setDailyEnabled(101, bad, '2026-11-04'));
    assert.throws(() => f.users.lightWorkouts.getDay(404, '2026-11-04', '2026-11-04'));
    assert.throws(() => f.users.lightWorkouts.selectToday(101, '2026-02-30', '2026-02-30'));
    raw.exec(`CREATE TRIGGER light_assignment_failure BEFORE INSERT ON light_workout_assignments BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
    assert.throws(() => f.users.lightWorkouts.setDailyEnabled(101, true, '2026-11-04'));
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM light_workout_preferences').get()!.count, 0);
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM light_workout_assignments').get()!.count, 0);
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM tracking_completions').get()!.count, 0);
    assert.equal(f.users.list().length, 2);
    raw.exec('DROP TRIGGER light_assignment_failure');
    assert.ok(f.users.lightWorkouts.setDailyEnabled(101, true, '2026-11-04').assignment);
  } finally { raw.close(); f.close(); }
});

test('schema 9 upgrades add light workout storage without changing any original rows or historical scores', () => {
  const f = fixture();
  let raw: DatabaseSync | undefined;
  try {
    f.users.setProfile(101, { currentWeight: 80, currentFat: 20, targetWeight: 75, targetFat: 15 }, '2026-10-29');
    f.users.tracking.setGoals(101, '2026-10', { strength: 12, cardio: 20 });
    f.users.tracking.setCompletion(101, '2026-10-29', 'light', true);
    f.users.tracking.workouts.setDay(101, '2026-10-29', { exercises: [{ id: 'one', name: 'приседания', reps: 10, sets: 2, weight: null }] });
    const previousDay = f.users.tracking.getDay(101, '2026-10-29');
    const previousMonth = f.users.tracking.getMonth(101, '2026-10-29');
    raw = new DatabaseSync(f.file);
    raw.exec('DROP TABLE light_workout_issuances; DROP TABLE light_workout_assignments; DROP TABLE light_workout_preferences; PRAGMA user_version = 9');
    const tables = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name));
    const snapshot = (db: DatabaseSync) => tables.map(table => [table, db.prepare('SELECT * FROM ' + table).all().map(row => JSON.stringify(row)).sort()]);
    const before = snapshot(raw);
    raw.close(); raw = undefined;
    f.restart();
    raw = new DatabaseSync(f.file, { readOnly: true });
    assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 11);
    assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(snapshot(raw), before);
    assert.deepEqual(f.users.tracking.getDay(101, '2026-10-29'), previousDay);
    assert.deepEqual(f.users.tracking.getMonth(101, '2026-10-29'), previousMonth);
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM light_workout_preferences').get()!.count, 0);
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM light_workout_assignments').get()!.count, 0);
    f.users.lightWorkouts.setDailyEnabled(101, true, '2026-11-04');
    assert.deepEqual(snapshot(raw), before, 'choosing a suggestion cannot modify old tracking, profiles or diary rows');
  } finally { raw?.close(); f.close(); }
});

test('a day permits one reroll, preserves both issued sets and safely retries the original request after a restart', () => {
  const f = fixture();
  const date = '2026-11-04';
  try {
    assert.throws(() => f.users.lightWorkouts.rerollToday(101, date, date, 'missing'), /сначала/);
    const first = f.users.lightWorkouts.selectToday(101, date, date);
    assert.equal(first.rerollsUsed, 0); assert.equal(first.rerollsRemaining, 1);
    assert.throws(() => f.users.lightWorkouts.rerollToday(101, date, date, 'stale'), /изменился/);
    assert.throws(() => f.users.lightWorkouts.rerollToday(101, date, '2026-11-05', first.assignment!.catalogId), /сегодня/);
    const changed = f.users.lightWorkouts.rerollToday(101, date, date, first.assignment!.catalogId);
    assert.notEqual(changed.assignment!.catalogId, first.assignment!.catalogId);
    assert.equal(changed.rerollsUsed, 1); assert.equal(changed.rerollsRemaining, 0);
    assert.deepEqual(f.users.lightWorkouts.rerollToday(101, date, date, first.assignment!.catalogId), changed, 'a lost success response can be retried without another selection');
    assert.throws(() => f.users.lightWorkouts.rerollToday(101, date, date, changed.assignment!.catalogId), /использована/);
    assert.deepEqual(f.users.lightWorkouts.selectToday(101, date, date), changed);
    f.users.lightWorkouts.setDailyEnabled(101, true, date);
    f.users.lightWorkouts.setDailyEnabled(101, false, date);
    f.restart();
    assert.deepEqual(f.users.lightWorkouts.getDay(101, date, date), changed);
    assert.deepEqual(f.users.lightWorkouts.rerollToday(101, date, date, first.assignment!.catalogId), changed);
    assert.throws(() => f.users.lightWorkouts.rerollToday(101, date, date, changed.assignment!.catalogId), /использована/);
    const raw = new DatabaseSync(f.file, { readOnly: true });
    try {
      const history = raw.prepare('SELECT kind,catalog_id FROM light_workout_issuances WHERE user_id=101 ORDER BY id').all();
      assert.deepEqual(history.map(row => [row.kind, row.catalog_id]), [['initial', first.assignment!.catalogId], ['reroll', changed.assignment!.catalogId]]);
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM light_workout_issuances WHERE user_id=202').get()!.n, 0);
    } finally { raw.close(); }
    const other = f.users.lightWorkouts.selectToday(202, date, date);
    assert.equal(other.rerollsRemaining, 1);
    const tomorrow = f.users.lightWorkouts.selectToday(101, '2026-11-05', '2026-11-05');
    assert.equal(tomorrow.rerollsRemaining, 1);
  } finally { f.close(); }
});

test('the exclusion window counts sixty issuances including rerolls, across skipped dates and restarts', () => {
  const f = fixture();
  const issued: string[] = [];
  try {
    for (let index = 0; index < 34; index++) {
      const date = new Date(Date.UTC(2026, 0, 1 + index * 3)).toISOString().slice(0, 10);
      let view = f.users.lightWorkouts.selectToday(101, date, date);
      for (const kind of ['initial', 'reroll']) {
        if (kind === 'reroll') view = f.users.lightWorkouts.rerollToday(101, date, date, view.assignment!.catalogId);
        assert.ok(!issued.slice(-60).includes(view.assignment!.catalogId), `issuance ${issued.length + 1} repeats a recent original or replacement`);
        issued.push(view.assignment!.catalogId);
      }
      if (index === 18) f.restart();
    }
    assert.equal(issued.length, 68);
    const raw = new DatabaseSync(f.file, { readOnly: true });
    try { assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM light_workout_issuances WHERE user_id=101').get()!.n, 68); }
    finally { raw.close(); }
  } finally { f.close(); }
});

test('reordered identical exercise contents stay excluded and a failed replacement does not consume the daily change', () => {
  const f = fixture();
  const raw = new DatabaseSync(f.file);
  const set = (id: string, exercises: string[]): LightWorkoutSet => ({ id, title: id, exercises, note: '' });
  try {
    const single = new LightWorkouts(raw, [set('original', ['10 приседаний', '20 отжиманий'])]);
    const original = single.selectToday(101, '2026-11-04', '2026-11-04');
    const catalog = new LightWorkouts(raw, [set('original', ['другая тренировка']), set('duplicate', ['20 отжиманий', '10 ПРИСЕДАНИЙ']), set('fresh', ['30 скручиваний'])]);
    raw.exec("CREATE TRIGGER fail_light_reroll BEFORE INSERT ON light_workout_issuances WHEN NEW.kind='reroll' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    assert.throws(() => catalog.rerollToday(101, '2026-11-04', '2026-11-04', 'original'));
    assert.deepEqual(catalog.getDay(101, '2026-11-04', '2026-11-04'), { ...original, catalogSize: 3 });
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM light_workout_issuances').get()!.n, 1);
    raw.exec('DROP TRIGGER fail_light_reroll');
    const updated = catalog.rerollToday(101, '2026-11-04', '2026-11-04', 'original');
    assert.equal(updated.assignment!.catalogId, 'fresh');
    assert.equal(updated.rerollsUsed, 1);
    const exhausted = new LightWorkouts(raw, [set('fresh', ['30 скручиваний'])]);
    assert.throws(() => exhausted.selectToday(101, '2026-11-05', '2026-11-05'), /последние 60/);
    assert.equal(exhausted.getSavedAssignment(101, '2026-11-05'), null);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM light_workout_issuances').get()!.n, 2);
  } finally { raw.close(); f.close(); }
});

test('v10 assignments are backfilled into issuance history once without altering existing snapshots', () => {
  const f = fixture();
  let raw: DatabaseSync | undefined;
  try {
    const original = f.users.lightWorkouts.selectToday(101, '2026-11-04', '2026-11-04');
    const next = f.users.lightWorkouts.selectToday(101, '2026-11-05', '2026-11-05');
    raw = new DatabaseSync(f.file);
    const old = raw.prepare('SELECT * FROM light_workout_assignments ORDER BY date').all().map(row => ({ ...row }));
    raw.exec('DROP TABLE light_workout_issuances; PRAGMA user_version=10');
    raw.close(); raw = undefined;
    f.restart();
    raw = new DatabaseSync(f.file, { readOnly: true });
    assert.deepEqual(raw.prepare('SELECT * FROM light_workout_assignments ORDER BY date').all().map(row => ({ ...row })), old);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM light_workout_issuances').get()!.n, 2);
    assert.deepEqual(f.users.lightWorkouts.getSavedAssignment(101, '2026-11-04'), original.assignment);
    assert.deepEqual(f.users.lightWorkouts.getSavedAssignment(101, '2026-11-05'), next.assignment);
    raw.close(); raw = undefined;
    f.restart();
    raw = new DatabaseSync(f.file, { readOnly: true });
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM light_workout_issuances').get()!.n, 2);
    assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { raw?.close(); f.close(); }
});

test('a set becomes eligible only after sixty subsequent issuances and exclusion history stays per account', () => {
  const f = fixture();
  const raw = new DatabaseSync(f.file);
  const set: LightWorkoutSet = { id: 'old', title: 'старый набор', exercises: ['10 приседаний'], note: '' };
  const catalog = new LightWorkouts(raw, [set]);
  try {
    const insert = raw.prepare(`INSERT INTO light_workout_issuances (user_id,date,kind,catalog_id,title,exercises_json,note)
      VALUES (101,?,'initial',?,?,?,'')`);
    const date = (index: number) => new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
    insert.run(date(0), set.id, set.title, JSON.stringify(set.exercises));
    for (let index = 1; index < 60; index++) insert.run(date(index), 'other' + index, 'другой', JSON.stringify(['повторы ' + index]));
    assert.throws(() => catalog.selectToday(101, '2026-11-04', '2026-11-04'), /последние 60/, 'the original remains blocked while only 59 later sets have been issued');
    assert.equal(catalog.getSavedAssignment(101, '2026-11-04'), null);
    assert.equal(catalog.selectToday(202, '2026-11-04', '2026-11-04').assignment!.catalogId, 'old', 'another account has its own history');
    insert.run(date(60), 'other60', 'другой', JSON.stringify(['повторы 60']));
    assert.equal(catalog.selectToday(101, '2026-11-04', '2026-11-04').assignment!.catalogId, 'old', 'sixty intervening issued sets complete the cooldown');
  } finally { raw.close(); f.close(); }
});
