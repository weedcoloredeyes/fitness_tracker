import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Users } from './users';
import { CURRENT_CATEGORY_WEIGHTS, LEGACY_CATEGORY_WEIGHTS, type TrackingDay } from './tracking-types';

function history(day: TrackingDay) {
  return { date: day.date, ids: day.definitions.map(item => [item.id, item.category]), completed: day.completedIds,
    strength: day.strengthFraction, light: day.lightFraction, cardio: day.cardioFraction, score: day.score, weights: day.weights };
}

test('schema 8 migration preserves dated custom history and activates light once on the authenticated local date', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-tracking-v8-'));
  const file = join(dir, 'fitness.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT, username TEXT,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL) STRICT;
    INSERT INTO users VALUES (101, 'First', NULL, NULL, '2026-01-01', '2026-01-03');
    INSERT INTO users VALUES (202, 'Second', NULL, NULL, '2026-01-01', '2026-01-03');
    CREATE TABLE tracking_users (user_id INTEGER PRIMARY KEY REFERENCES users(id)) STRICT;
    INSERT INTO tracking_users VALUES (101), (202);
    CREATE TABLE tracking_definitions (
      user_id INTEGER NOT NULL REFERENCES users(id), id TEXT NOT NULL,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
      category TEXT NOT NULL CHECK (category IN ('strength', 'cardio')),
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)), ordinal INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    ) STRICT;
    INSERT INTO tracking_definitions VALUES
      (101, 'strength', 'моя основная', 'strength', 0, 0),
      (101, 'cardio', 'кардио', 'cardio', 0, 1),
      (101, 'custom', 'отжимания', 'strength', 1, 2),
      (202, 'strength', 'физ нагрузка', 'strength', 0, 0),
      (202, 'cardio', 'кардио', 'cardio', 0, 1);
    CREATE TABLE tracking_definition_events (
      user_id INTEGER NOT NULL, definition_id TEXT NOT NULL, effective_date TEXT NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1)), PRIMARY KEY (user_id, definition_id, effective_date),
      FOREIGN KEY (user_id, definition_id) REFERENCES tracking_definitions(user_id, id)
    ) STRICT;
    INSERT INTO tracking_definition_events VALUES
      (101, 'strength', '0001-01-01', 1), (101, 'cardio', '0001-01-01', 1),
      (101, 'custom', '2026-01-02', 1), (101, 'custom', '2026-01-04', 0),
      (202, 'strength', '0001-01-01', 1), (202, 'cardio', '0001-01-01', 1);
    CREATE TABLE tracking_legacy_days (
      user_id INTEGER NOT NULL REFERENCES users(id), date TEXT NOT NULL, PRIMARY KEY (user_id, date)
    ) STRICT;
    INSERT INTO tracking_legacy_days VALUES (101, '2026-01-02');
    CREATE TABLE tracking_day_definitions (
      user_id INTEGER NOT NULL, date TEXT NOT NULL, definition_id TEXT NOT NULL,
      PRIMARY KEY (user_id, date, definition_id),
      FOREIGN KEY (user_id, date) REFERENCES tracking_legacy_days(user_id, date),
      FOREIGN KEY (user_id, definition_id) REFERENCES tracking_definitions(user_id, id)
    ) STRICT;
    INSERT INTO tracking_day_definitions VALUES
      (101, '2026-01-02', 'strength'), (101, '2026-01-02', 'cardio'), (101, '2026-01-02', 'custom');
    CREATE TABLE tracking_completions (
      user_id INTEGER NOT NULL, date TEXT NOT NULL, definition_id TEXT NOT NULL,
      PRIMARY KEY (user_id, date, definition_id),
      FOREIGN KEY (user_id, definition_id) REFERENCES tracking_definitions(user_id, id)
    ) STRICT;
    INSERT INTO tracking_completions VALUES
      (101, '2026-01-02', 'custom'), (101, '2026-01-02', 'cardio'), (101, '2026-01-03', 'strength');
    CREATE TABLE monthly_workout_goals (
      user_id INTEGER NOT NULL REFERENCES users(id), month TEXT NOT NULL,
      goal INTEGER NOT NULL CHECK (goal BETWEEN 1 AND 1000), PRIMARY KEY (user_id, month)
    ) STRICT;
    INSERT INTO monthly_workout_goals VALUES (101, '2026-01', 4);
    CREATE TABLE monthly_cardio_goals (
      user_id INTEGER NOT NULL REFERENCES users(id), month TEXT NOT NULL,
      goal INTEGER NOT NULL CHECK (goal BETWEEN 1 AND 1000), PRIMARY KEY (user_id, month)
    ) STRICT;
    INSERT INTO monthly_cardio_goals VALUES (101, '2026-01', 2);
    PRAGMA user_version = 8;
  `);
  const tables = ['tracking_users', 'tracking_definitions', 'tracking_definition_events', 'tracking_legacy_days', 'tracking_day_definitions', 'tracking_completions', 'monthly_workout_goals', 'monthly_cardio_goals'];
  const snapshot = (db: DatabaseSync) => tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()
    .map(row => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
  const before = snapshot(old);
  old.close();
  let users = new Users(file);
  try {
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      assert.deepEqual(snapshot(raw), before, 'the schema rebuild must retain all original rows and values');
      assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 9);
    } finally { raw.close(); }
    const previous = users.tracking.getCalendar(101, '2026-01-01', '2026-01-03').map(history);
    assert.deepEqual(previous[1].weights, LEGACY_CATEGORY_WEIGHTS);
    assert.equal(previous[1].score, 75);
    assert.equal(previous[2].score, 25);
    const previousMonth = users.tracking.getMonth(101, '2026-01-03');
    users.tracking.upgradeUser(101, '2026-01-04');
    assert.deepEqual(users.tracking.getCalendar(101, '2026-01-01', '2026-01-03').map(history), previous);
    assert.deepEqual(users.tracking.getMonth(101, '2026-01-03'), previousMonth, 'viewing an older date must not alter its monthly result');
    assert.equal(users.tracking.getDefinitions(101).find(item => item.id === 'strength')!.name, 'моя основная', 'custom names survive activation');
    const today = users.tracking.getDay(101, '2026-01-04');
    assert.deepEqual(today.weights, CURRENT_CATEGORY_WEIGHTS);
    assert.equal(today.definitions.filter(item => item.category === 'light').length, 1);
    assert.equal(users.tracking.setCompletion(101, today.date, 'light', true).score, 25);
    const month = users.tracking.getMonth(101, today.date);
    assert.equal(month.strength.goal, 4);
    assert.equal(month.cardio.goal, 2);
    assert.equal(month.strength.earned, previousMonth.strength.earned + 0.5);
    assert.equal(month.strength.completedDays, previousMonth.strength.completedDays);

    users.tracking.upgradeUser(101, '2026-01-05');
    users.tracking.upgradeUser(202, '2026-01-05');
    assert.equal(users.tracking.getDefinitions(202).find(item => item.id === 'strength')!.name, 'основная тренировка', 'only the untouched original name is updated');
    assert.deepEqual(users.tracking.getDay(202, '2026-01-04').weights, LEGACY_CATEGORY_WEIGHTS, 'activation uses the supplied date, not a guessed system day');
    assert.deepEqual(users.tracking.getDay(202, '2026-01-05').weights, CURRENT_CATEGORY_WEIGHTS);
    const saved = users.tracking.getDay(101, today.date);
    users.close(); users = new Users(file);
    users.identify({ id: 101, first_name: 'First' });
    users.tracking.upgradeUser(101, '2026-02-01');
    assert.deepEqual(users.tracking.getDay(101, today.date), saved, 'restarting must not reset light marks or move the transition date');
    assert.equal(users.tracking.getDefinitions(101).filter(item => item.category === 'light').length, 1);
    const check = new DatabaseSync(file, { readOnly: true });
    try { assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), []); } finally { check.close(); }
  } finally { users.close(); rmSync(dir, { recursive: true, force: true }); }
});
