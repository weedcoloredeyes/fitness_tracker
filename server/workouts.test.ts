import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkoutDiary, validateWorkout, type Exercise } from './workouts';

const exercise = (id: string, name = 'жим'): Exercise => ({ id, name, reps: 10, sets: 3, weight: null });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-workouts-'));
  const file = join(dir, 'fitness.sqlite');
  let db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE users(id INTEGER PRIMARY KEY) STRICT; INSERT INTO users VALUES(101),(202)');
  // Schema setup must be safe within an outer migration transaction.
  db.exec('BEGIN IMMEDIATE');
  let diary = new WorkoutDiary(db);
  db.exec('COMMIT');
  return {
    get diary() { return diary; }, get db() { return db; },
    restart() { db.close(); db = new DatabaseSync(file); db.exec('PRAGMA foreign_keys=ON'); diary = new WorkoutDiary(db); },
    close() { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('workout rows preserve order, nullable quantities, zero weight and ownership across days and restart', () => {
  const f = fixture();
  try {
    f.diary.setDay(101, '2026-10-01', { exercises: [exercise('one'), { ...exercise('two', 'Подъем'), reps: null, sets: null, weight: 0 }] });
    f.diary.setDay(101, '2026-10-02', { exercises: [{ ...exercise('one'), weight: 42.5 }] });
    f.diary.setDay(202, '2026-10-01', { exercises: [exercise('one', 'тяга')] });
    f.restart();
    assert.deepEqual(f.diary.getDay(101, '2026-10-01'), { date: '2026-10-01', exercises: [exercise('one'), { ...exercise('two', 'подъем'), reps: null, sets: null, weight: 0 }] });
    assert.equal(f.diary.getDay(101, '2026-10-02').exercises[0].weight, 42.5);
    assert.equal(f.diary.getDay(202, '2026-10-01').exercises[0].name, 'тяга');
    assert.deepEqual(f.diary.getDay(202, '2026-10-02'), { date: '2026-10-02', exercises: [] });
    f.diary.setDay(101, '2026-10-01', { exercises: [] });
    assert.equal(f.diary.getDay(101, '2026-10-01').exercises.length, 0);
    assert.equal(f.diary.getDay(202, '2026-10-01').exercises.length, 1);
  } finally { f.close(); }
});

test('workout validation rejects incomplete, duplicate, nonfinite and overprecise rows without changing saved data', () => {
  const f = fixture();
  try {
    const saved = f.diary.setDay(101, '2026-10-01', { exercises: [exercise('old')] });
    for (const input of [null, {}, { exercises: 'no' }, { exercises: Array.from({ length: 51 }, (_, i) => exercise(String(i))) },
      { exercises: [exercise('same'), exercise('same')] }, ...[
        { id: '../bad' }, { name: '' }, { name: 'x'.repeat(121) }, { reps: 0 }, { reps: 1.2 }, { sets: 101 },
        { weight: -1 }, { weight: Infinity }, { weight: 42.51 }, { reps: undefined }, { sets: '3' },
      ].map((bad) => ({ exercises: [{ ...exercise('new'), ...bad }] }))]) {
      assert.throws(() => f.diary.setDay(101, '2026-10-01', input));
      assert.deepEqual(f.diary.getDay(101, '2026-10-01'), saved);
    }
    assert.throws(() => f.diary.getDay(101, '2026-02-30'));
    assert.throws(() => f.diary.setDay(101, 'bad-date', { exercises: [] }));
    assert.deepEqual(validateWorkout({ exercises: [{ ...exercise('valid'), name: '  ЁЖ  ', reps: 1000, sets: 100, weight: 1000 }] }).exercises[0],
      { id: 'valid', name: 'еж', reps: 1000, sets: 100, weight: 1000 });
  } finally { f.close(); }
});

test('failed replacement rolls back its deletion and all partial inserts, including inside an outer transaction', () => {
  const f = fixture();
  try {
    const before = f.diary.setDay(101, '2026-10-01', { exercises: [exercise('old')] });
    f.db.exec("CREATE TRIGGER reject_bad_exercise BEFORE INSERT ON workout_exercises WHEN NEW.name='ошибка' BEGIN SELECT RAISE(ABORT,'forced test failure'); END");
    f.db.exec('BEGIN IMMEDIATE');
    assert.throws(() => f.diary.setDay(101, '2026-10-01', { exercises: [exercise('partial'), exercise('bad', 'ошибка')] }));
    assert.deepEqual(f.diary.getDay(101, '2026-10-01'), before);
    f.db.exec('COMMIT');
    f.restart();
    assert.deepEqual(f.diary.getDay(101, '2026-10-01'), before);
    assert.throws(() => f.diary.setDay(999, '2026-10-01', { exercises: [exercise('unknown-user')] }));
    assert.deepEqual(f.diary.getDay(101, '2026-10-01'), before);
  } finally { f.close(); }
});

test('copy source is the latest nonempty workout strictly before the selected date and only for that account', () => {
  const f = fixture();
  try {
    f.diary.setDay(101, '2026-10-01', { exercises: [exercise('earlier')] });
    f.diary.setDay(101, '2026-10-03', { exercises: [exercise('same-day')] });
    f.diary.setDay(202, '2026-10-02', { exercises: [exercise('other-account')] });
    assert.equal(f.diary.getLatest(101, '2026-10-03')?.date, '2026-10-01');
    assert.equal(f.diary.getLatest(202, '2026-10-03')?.date, '2026-10-02');
    assert.equal(f.diary.getLatest(101, '2026-10-01'), null);
    f.diary.setDay(101, '2026-10-03', { exercises: [] });
    assert.equal(f.diary.getLatest(101, '2026-10-04')?.date, '2026-10-01');
    assert.throws(() => f.diary.getLatest(101, '2026-13-01'));
  } finally { f.close(); }
});
