import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkoutDiary, type Exercise } from './workouts';
import type { LightWorkoutAssignment, LightWorkoutSet } from './light-workout-types';

const date = '2026-11-04';
const manual = (id = 'manual', name = 'жим'): Exercise => ({ id, name, reps: 8, sets: 3, weight: 40 });
const assignment = (exercises = ['25 отжиманий', 'планка — 1 минута суммарно, до 2 подходов'], catalogId = '001'): LightWorkoutAssignment => ({ date, catalogId, title: 'набор ' + catalogId, exercises, note: 'суммарно' });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-light-diary-'));
  const file = join(dir, 'fitness.sqlite');
  let db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE users(id INTEGER PRIMARY KEY) STRICT; INSERT INTO users VALUES(101),(202)');
  let diary = new WorkoutDiary(db);
  return { get db() { return db; }, get diary() { return diary; },
    restart() { db.close(); db = new DatabaseSync(file); db.exec('PRAGMA foreign_keys=ON'); diary = new WorkoutDiary(db); },
    close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('light completion appends every exercise, preserves exact instructions and parses only certain quantities', () => {
  const f = fixture();
  const source = assignment(['25 отжиманий', 'планка — 1 минута суммарно, до 2 подходов',
    'брусья — 3 подхода по 8 раз', 'болгарские выпады — по 20 на каждую ногу, в 2 подхода', 'бег 3 км в спокойном темпе']);
  try {
    f.diary.setDay(101, date, { exercises: [manual()] });
    const saved = f.diary.syncLightWorkout(101, date, source);
    assert.deepEqual(saved.exercises[0], manual());
    const rows = saved.exercises.slice(1);
    assert.deepEqual(rows.map(row => row.sourceText), source.exercises);
    assert.ok(rows.every(row => row.source === 'light' && row.weight === null));
    assert.deepEqual(rows.map(row => [row.name, row.reps, row.sets]), [
      ['отжимания', 25, null], ['планка', null, null], ['брусья', 8, 3], ['болгарские выпады', null, 2], ['бег 3 км в спокойном темпе', null, null],
    ]);
    assert.deepEqual(f.diary.syncLightWorkout(101, date, source), saved, 'a repeated completion uses the same IDs and adds nothing');
    f.restart();
    assert.deepEqual(f.diary.getDay(101, date), saved);
    assert.deepEqual(f.diary.getDay(202, date).exercises, []);
    assert.deepEqual(f.diary.getDay(101, '2026-11-05').exercises, []);
  } finally { f.close(); }
});

test('manual editing and undo preserve each other, while stale automatic IDs cannot resurrect a removed set', () => {
  const f = fixture();
  try {
    f.diary.setDay(101, date, { exercises: [manual()] });
    const original = f.diary.syncLightWorkout(101, date, assignment());
    const edited = f.diary.setDay(101, date, { exercises: [{ ...manual(), name: 'тяга', reps: 12 }] });
    assert.equal(edited.exercises[0].name, 'тяга');
    assert.deepEqual(edited.exercises.slice(1), original.exercises.slice(1), 'saving only manual rows retains protected completed exercises');
    const tampered = f.diary.setDay(101, date, { exercises: edited.exercises.map(row => row.source === 'light' ? { ...row, name: 'подмена', reps: 999 } : row) });
    assert.deepEqual(tampered, edited, 'a client cannot overwrite a completed set through the generic editor');
    const undone = f.diary.syncLightWorkout(101, date, null);
    assert.deepEqual(undone.exercises, [edited.exercises[0]]);
    const stale = f.diary.setDay(101, date, { exercises: edited.exercises });
    assert.deepEqual(stale, undone, 'a late save cannot bring removed automatic exercises back as manual records');
    const repeated = f.diary.syncLightWorkout(101, date, assignment());
    assert.deepEqual(repeated, edited, 'ticking again restores the same stable record IDs without duplicates');
  } finally { f.close(); }
});

test('switching after undo replaces only imported exercises and retains earlier source IDs against stale writes', () => {
  const f = fixture();
  try {
    f.diary.setDay(101, date, { exercises: [manual()] });
    const first = f.diary.syncLightWorkout(101, date, assignment(['10 приседаний'], '001'));
    f.diary.syncLightWorkout(101, date, null);
    const second = f.diary.syncLightWorkout(101, date, assignment(['20 отжиманий'], '002'));
    assert.deepEqual(second.exercises.map(row => row.sourceText).filter(Boolean), ['20 отжиманий']);
    assert.notEqual(first.exercises[1].id, second.exercises[1].id);
    const saved = f.diary.setDay(101, date, { exercises: first.exercises });
    assert.deepEqual(saved, second);
    f.diary.syncLightWorkout(101, date, null);
    assert.deepEqual(f.diary.getDay(101, date).exercises, [manual()]);
  } finally { f.close(); }
});

test('a full diary or failed import rolls back all inserted provenance and exercises inside an outer transaction', () => {
  const f = fixture();
  try {
    const before = f.diary.setDay(101, date, { exercises: Array.from({ length: 49 }, (_, i) => manual('manual-' + i)) });
    f.db.exec('BEGIN IMMEDIATE');
    assert.throws(() => f.diary.syncLightWorkout(101, date, assignment()), /50/);
    assert.deepEqual(f.diary.getDay(101, date), before);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM workout_light_imports').get()!.count, 0);
    f.db.exec('COMMIT');
    f.diary.setDay(101, date, { exercises: [manual()] });
    f.db.exec("CREATE TRIGGER reject_light BEFORE INSERT ON workout_exercises WHEN NEW.name='планка' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    assert.throws(() => f.diary.syncLightWorkout(101, date, assignment()));
    assert.deepEqual(f.diary.getDay(101, date).exercises, [manual()]);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM workout_light_imports').get()!.count, 0);
    assert.throws(() => f.diary.syncLightWorkout(404, date, assignment()));
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { f.close(); }
});

test('manual payloads cannot forge completed light provenance', () => {
  const f = fixture();
  try {
    const saved = f.diary.setDay(101, date, { exercises: [{ ...manual(), source: 'light', sourceText: 'подмена' }] });
    assert.deepEqual(saved.exercises, [manual()]);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM workout_light_imports').get()!.count, 0);
  } finally { f.close(); }
});

test('all 200 provided sets transfer their full exercise wording without dropping timed or per-leg instructions', () => {
  const f = fixture();
  const catalog = JSON.parse(readFileSync(new URL('./light-workout-catalog.json', import.meta.url), 'utf8')) as LightWorkoutSet[];
  try {
    f.db.exec('BEGIN IMMEDIATE');
    for (const item of catalog) {
      const saved = f.diary.syncLightWorkout(101, date, { date, catalogId: item.id, title: item.title, exercises: item.exercises, note: item.note });
      assert.deepEqual(saved.exercises.map(row => row.sourceText), item.exercises, item.id);
      assert.ok(saved.exercises.every(row => row.source === 'light'));
    }
    f.db.exec('COMMIT');
    assert.equal(catalog.length, 200);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { f.close(); }
});
