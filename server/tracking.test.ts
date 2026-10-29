import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Users } from './users';
import { CURRENT_CATEGORY_WEIGHTS, LEGACY_CATEGORY_WEIGHTS, type ActivityCategory } from './tracking-types';

function fixture(legacy = false) {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-tracking-'));
  const file = join(dir, 'fitness.sqlite');
  if (legacy) {
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT, username TEXT,
        first_seen TEXT NOT NULL, last_seen TEXT NOT NULL) STRICT;
      INSERT INTO users VALUES (101, 'First', NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z');
      INSERT INTO users VALUES (202, 'Second', NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z');
      CREATE TABLE app_settings (id INTEGER PRIMARY KEY, admin_id INTEGER, legacy_imported INTEGER NOT NULL) STRICT;
      INSERT INTO app_settings VALUES (1, 101, 1);
      CREATE TABLE daily_activity (user_id INTEGER NOT NULL REFERENCES users(id), date TEXT NOT NULL,
        training INTEGER NOT NULL, walking INTEGER NOT NULL, micro_training INTEGER NOT NULL,
        PRIMARY KEY(user_id,date)) STRICT;
      INSERT INTO daily_activity VALUES (101, '2026-01-01', 0, 1, 1);
      INSERT INTO daily_activity VALUES (101, '2026-01-02', 1, 0, 1);
      INSERT INTO daily_activity VALUES (101, '2026-01-03', 1, 0, 1);
      INSERT INTO daily_activity VALUES (202, '2026-01-01', 1, 0, 0);
      CREATE TABLE body_profiles (user_id INTEGER PRIMARY KEY REFERENCES users(id), current_fat REAL,
        target_fat REAL, current_weight REAL, target_weight REAL, start_weight REAL, start_weight_date TEXT) STRICT;
      INSERT INTO body_profiles VALUES (101, 22, 18, 85, 80, 90, NULL);
      CREATE TABLE monthly_workout_goals (user_id INTEGER NOT NULL REFERENCES users(id), month TEXT NOT NULL,
        goal INTEGER NOT NULL, PRIMARY KEY(user_id,month)) STRICT;
      INSERT INTO monthly_workout_goals VALUES (101, '2026-01', 12);
      CREATE TABLE daily_measurements (user_id INTEGER NOT NULL REFERENCES users(id), date TEXT NOT NULL,
        current_weight REAL, current_fat REAL, PRIMARY KEY(user_id,date)) STRICT;
      INSERT INTO daily_measurements VALUES (101, '2026-01-03', 84, 21);
      PRAGMA user_version = 7;
    `);
    old.close();
  }
  let users = new Users(file);
  if (!legacy) {
    users.identify({ id: 101, first_name: 'First' });
    users.identify({ id: 202, first_name: 'Second' });
  }
  return { file, get users() { return users; },
    restart() { users.close(); users = new Users(file); },
    close() { users.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function defaultId(users: Users, userId: number, category: ActivityCategory): string {
  return users.tracking.getDefinitions(userId).find(item => item.category === category && !item.archived)!.id;
}

test('new accounts receive three stable default definitions and getters do not create unknown accounts', () => {
  const f = fixture();
  try {
    const definitions = f.users.tracking.getDefinitions(101);
    assert.deepEqual(definitions.map(({ name, category, archived }) => ({ name, category, archived })), [
      { name: 'основная тренировка', category: 'strength', archived: false },
      { name: 'легкая тренировка', category: 'light', archived: false },
      { name: 'кардио', category: 'cardio', archived: false },
    ]);
    f.users.identify({ id: 303, first_name: 'Third' });
    assert.equal(f.users.tracking.getDefinitions(303).length, 3);
    const day = f.users.tracking.getDay(101, '2026-01-01');
    assert.equal(day.definitions.length, 3);
    assert.deepEqual(day.weights, CURRENT_CATEGORY_WEIGHTS);
    assert.equal(day.lightFraction, 0);
    assert.deepEqual(day.completedIds, []);
    assert.equal(day.score, 0);
    assert.throws(() => f.users.tracking.getDay(404, '2026-01-01'));
    assert.equal(f.users.list().length, 3);
    f.users.identify({ id: 101, first_name: 'Renamed' });
    assert.deepEqual(f.users.tracking.getDefinitions(101), definitions, 'login must not replace stable definitions');
    f.restart();
    assert.deepEqual(f.users.tracking.getDefinitions(101), definitions);
  } finally { f.close(); }
});

test('schema 7 migration preserves legacy users, marks, goals and profiles while retaining historical micro marks separately', () => {
  const f = fixture(true);
  try {
    const t = f.users.tracking;
    const micro = t.getDefinitions(101).find(item => item.id === 'legacy-micro')!;
    assert.equal(micro.archived, true);
    const first = t.getDay(101, '2026-01-01');
    assert.equal(first.definitions.length, 3);
    assert.equal(first.definitions.find(item => item.id === micro.id)?.archived, false);
    assert.equal(first.strengthFraction, 0.5);
    assert.equal(first.cardioFraction, 1);
    assert.equal(first.score, 75);
    assert.ok(first.completedIds.includes(micro.id));
    assert.equal(t.getDay(101, '2026-01-02').strengthFraction, 1);
    assert.equal(t.getDay(101, '2026-01-04').definitions.length, 2, 'new days do not inherit the archived micro definition');
    assert.equal(t.getDay(202, '2026-01-01').strengthFraction, 0.5);
    const month = t.getMonth(101, '2026-01-03');
    assert.equal(month.strength.goal, 12);
    assert.equal(month.cardio.goal, null);
    assert.equal(month.score, null);
    assert.equal(month.strength.earned, 2.5);
    assert.equal(f.users.isAdmin(101), true);
    assert.equal(f.users.getProfile(101).startWeight, 90);
    assert.equal(f.users.getMeasurement(101, '2026-01-03').currentWeight, 84);
    assert.deepEqual(f.users.getMeasurementHistory(101).legacyMeasurement, { currentWeight: 85, currentFat: 22 });

    t.setCompletion(101, '2026-01-01', micro.id, false);
    assert.equal(t.getDay(101, '2026-01-01').strengthFraction, 0);
    f.restart();
    assert.equal(f.users.tracking.getDay(101, '2026-01-01').strengthFraction, 0, 'restart must not reimport a cleared legacy completion');
    const raw = new DatabaseSync(f.file, { readOnly: true });
    try {
      assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 9);
      assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM users').get()!.count, 2);
      assert.deepEqual({ ...raw.prepare('SELECT * FROM app_settings').get() }, { id: 1, admin_id: 101, legacy_imported: 1 });
      assert.deepEqual(raw.prepare('SELECT * FROM daily_activity ORDER BY user_id,date').all().map(row => ({ ...row })), [
        { user_id: 101, date: '2026-01-01', training: 0, walking: 1, micro_training: 1 },
        { user_id: 101, date: '2026-01-02', training: 1, walking: 0, micro_training: 1 },
        { user_id: 101, date: '2026-01-03', training: 1, walking: 0, micro_training: 1 },
        { user_id: 202, date: '2026-01-01', training: 1, walking: 0, micro_training: 0 },
      ]);
      assert.deepEqual({ ...raw.prepare('SELECT * FROM body_profiles').get() }, {
        user_id: 101, current_fat: 22, target_fat: 18, current_weight: 85,
        target_weight: 80, start_weight: 90, start_weight_date: null,
      });
      assert.deepEqual({ ...raw.prepare('SELECT * FROM monthly_workout_goals').get() }, { user_id: 101, month: '2026-01', goal: 12 });
    } finally { raw.close(); }
  } finally { f.close(); }
});

test('early unregistered legacy marks are retained and imported once after the real account identifies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-tracking-orphan-'));
  const file = join(dir, 'fitness.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE daily_activity (user_id INTEGER NOT NULL, date TEXT NOT NULL,
    training INTEGER NOT NULL DEFAULT 0, walking INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date)) STRICT;
    INSERT INTO daily_activity VALUES (404, '2026-01-01', 1, 1)`);
  old.close();
  let users = new Users(file);
  try {
    assert.deepEqual(users.list(), [], 'a missing account must not be fabricated during migration');
    assert.throws(() => users.tracking.getDay(404, '2026-01-01'));
    users.identify({ id: 404, first_name: 'Identified' });
    const strength = defaultId(users, 404, 'strength');
    const day = users.tracking.getDay(404, '2026-01-01');
    assert.equal(day.strengthFraction, 0.5);
    assert.equal(day.cardioFraction, 1);
    assert.equal(day.definitions.length, 3);
    assert.equal(users.tracking.getDay(404, '2026-01-02').definitions.length, 2);
    users.tracking.setCompletion(404, '2026-01-01', strength, false);
    users.close();
    users = new Users(file);
    users.identify({ id: 404, first_name: 'Identified' });
    assert.equal(users.tracking.getDay(404, '2026-01-01').strengthFraction, 0);
    assert.deepEqual(users.getActivity(404, '2026-01-01'), {
      date: '2026-01-01', training: true, microTraining: false, walking: true,
    });
  } finally { users.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('effective composition dates preserve earlier denominators through creation, rename, archive and restore', () => {
  const f = fixture();
  try {
    const t = f.users.tracking;
    const strength = defaultId(f.users, 101, 'strength');
    t.setCompletion(101, '2026-01-01', strength, true);
    const old = t.getDay(101, '2026-01-01');
    const second = t.createDefinition(101, { name: '  Отжимания  ', category: 'strength' }, '2026-01-02');
    assert.equal(second.name, 'отжимания');
    const third = t.createDefinition(101, { name: 'Тяга', category: 'strength' }, '2026-01-03');
    assert.deepEqual(t.getDay(101, '2026-01-01'), old);
    assert.equal(t.setCompletion(101, '2026-01-02', strength, true).strengthFraction, 0.5);
    const thirds = t.setCompletion(101, '2026-01-03', strength, true);
    assert.equal(thirds.strengthFraction, 1 / 3);
    assert.ok(Math.abs(thirds.score - CURRENT_CATEGORY_WEIGHTS.strength / 3) < 1e-12);
    assert.notEqual(thirds.score, Math.round(thirds.score));

    t.updateDefinition(101, second.id, { archived: true }, '2026-01-04');
    assert.equal(t.getDay(101, '2026-01-03').strengthFraction, 1 / 3);
    assert.equal(t.getDay(101, '2026-01-04').definitions.filter(item => item.category === 'strength').length, 2);
    assert.throws(() => t.setCompletion(101, '2026-01-04', second.id, true));
    assert.equal(t.setCompletion(101, '2026-01-03', second.id, true).strengthFraction, 2 / 3, 'archived definitions remain editable on their historical dates');
    t.updateDefinition(101, second.id, { archived: false }, '2026-01-05');
    assert.equal(t.getDay(101, '2026-01-04').definitions.filter(item => item.category === 'strength').length, 2);
    assert.equal(t.getDay(101, '2026-01-05').definitions.filter(item => item.category === 'strength').length, 3);
    t.updateDefinition(101, third.id, { name: 'ЖЁСТКАЯ ТЯГА' }, '2026-01-06');
    assert.equal(t.getDay(101, '2026-01-03').definitions.find(item => item.id === third.id)?.name, 'жесткая тяга');
    assert.equal(t.getDay(101, '2026-01-03').strengthFraction, 2 / 3, 'global rename does not alter membership or completed IDs');
    f.restart();
    assert.equal(f.users.tracking.getDay(101, '2026-01-03').strengthFraction, 2 / 3);
    assert.equal(f.users.tracking.getDay(101, '2026-01-04').definitions.filter(item => item.category === 'strength').length, 2);
  } finally { f.close(); }
});

test('composition changes also affect imported current and later snapshots without altering earlier legacy dates', () => {
  const f = fixture(true);
  try {
    const t = f.users.tracking;
    const before = t.getDay(101, '2026-01-02');
    const extra = t.createDefinition(101, { name: 'турник', category: 'strength' }, '2026-01-03');
    assert.deepEqual(t.getDay(101, '2026-01-02'), before);
    assert.equal(t.getDay(101, '2026-01-03').strengthFraction, 2 / 3);
    t.updateDefinition(101, 'legacy-micro', { archived: true }, '2026-01-03');
    assert.equal(t.getDay(101, '2026-01-03').strengthFraction, 0.5);
    assert.equal(t.getDay(101, '2026-01-04').definitions.filter(item => item.category === 'strength').length, 2);
    t.updateDefinition(101, extra.id, { archived: true }, '2026-01-03');
    assert.equal(t.getDay(101, '2026-01-03').strengthFraction, 1);
    assert.deepEqual(t.getDay(101, '2026-01-02'), before);
  } finally { f.close(); }
});

test('monthly index sums exact daily fractions, caps each category separately and excludes future and other-month activity', () => {
  const f = fixture();
  try {
    const t = f.users.tracking;
    const strength = defaultId(f.users, 101, 'strength');
    const cardio = defaultId(f.users, 101, 'cardio');
    t.createDefinition(101, { name: 'вторая силовая', category: 'strength' }, '2026-01-01');
    t.createDefinition(101, { name: 'третья силовая', category: 'strength' }, '2026-01-01');
    t.createDefinition(101, { name: 'бег', category: 'cardio' }, '2026-01-01');
    t.setGoals(101, '2026-01', { strength: 2, cardio: 3 });
    for (let date = 1; date <= 6; date++) {
      const key = '2026-01-0' + date;
      t.setCompletion(101, key, strength, true);
      t.setCompletion(101, key, cardio, true);
      t.setCompletion(101, key, strength, true);
    }
    t.setCompletion(101, '2025-12-31', strength, true);
    for (const item of t.getDay(101, '2026-01-07').definitions) t.setCompletion(101, '2026-01-07', item.id, true);
    let month = t.getMonth(101, '2026-01-06');
    assert.equal(month.month, '2026-01');
    assert.equal(month.start, '2026-01-01');
    assert.equal(month.end, '2026-01-06');
    assert.equal(month.days.length, 6);
    assert.equal(month.strength.earned, 2, 'thirds must not be rounded before monthly aggregation');
    assert.equal(month.cardio.earned, 3);
    assert.equal(month.strength.completedDays, 0);
    assert.equal(month.cardio.completedDays, 0);
    assert.equal(month.strength.score, CURRENT_CATEGORY_WEIGHTS.strength);
    assert.equal(month.cardio.score, CURRENT_CATEGORY_WEIGHTS.cardio);
    assert.equal(month.score, 100);
    t.workouts.setDay(101, '2026-01-06', { exercises: [
      { id: 'one', name: 'тяга', reps: 10, sets: 3, weight: 30 },
      { id: 'two', name: 'присед', reps: 10, sets: 3, weight: 40 },
    ] });
    assert.deepEqual(t.getMonth(101, '2026-01-06'), month, 'several exercises do not multiply a day credit');
    t.setGoals(101, '2026-01', { strength: 1, cardio: 100 });
    month = t.getMonth(101, '2026-01-06');
    assert.equal(month.strength.score, CURRENT_CATEGORY_WEIGHTS.strength);
    assert.equal(month.cardio.score, CURRENT_CATEGORY_WEIGHTS.cardio * 0.03);
    assert.equal(month.score, CURRENT_CATEGORY_WEIGHTS.strength + CURRENT_CATEGORY_WEIGHTS.cardio * 0.03);
    t.setGoals(101, '2026-01', { strength: null, cardio: 3 });
    month = t.getMonth(101, '2026-01-06');
    assert.equal(month.score, null);
    assert.equal(month.strength.score, null);
    assert.equal(month.cardio.score, CURRENT_CATEGORY_WEIGHTS.cardio);
    assert.equal(t.getMonth(101, '2026-01-06', '2025-12').strength.earned, 1);
    assert.deepEqual(t.getMonth(101, '2026-01-06', '2026-02').days, []);
    assert.equal(t.getMonth(101, '2026-02-01', '2026-01').days.length, 31);
  } finally { f.close(); }
});

test('light training earns half a physical day and shares the same cap with main training', () => {
  const f = fixture();
  try {
    const t = f.users.tracking;
    const strength = defaultId(f.users, 101, 'strength');
    const light = defaultId(f.users, 101, 'light');
    const cardio = defaultId(f.users, 101, 'cardio');
    t.setGoals(101, '2026-01', { strength: 2, cardio: 1 });
    let day = t.setCompletion(101, '2026-01-01', cardio, true);
    day = t.setCompletion(101, day.date, light, true);
    assert.equal(day.score, 75, 'light and cardio reach 75, not the full daily score');
    assert.equal(t.getMonth(101, '2026-01-01').strength.earned, 0.5);
    day = t.setCompletion(101, day.date, strength, true);
    assert.equal(day.score, 100, 'all three categories must stay capped at 100');
    assert.equal(t.getMonth(101, '2026-01-01').strength.earned, 1, 'main plus light is capped at one physical day');
    assert.equal(t.getMonth(101, '2026-01-01').strength.completedDays, 1);
    day = t.setCompletion(101, day.date, light, false);
    assert.equal(day.score, 100, 'main plus cardio still reaches 100 without a light mark');

    const extra = t.createDefinition(101, { name: 'легкая вторая', category: 'light' }, '2026-01-02');
    const third = t.createDefinition(101, { name: 'легкая третья', category: 'light' }, '2026-01-02');
    day = t.setCompletion(101, '2026-01-02', light, true);
    assert.equal(day.lightFraction, 1 / 3);
    assert.ok(Math.abs(day.score - 25 / 3) < 1e-12, 'partial light marks retain precision');
    t.setCompletion(101, day.date, extra.id, true);
    day = t.setCompletion(101, day.date, third.id, true);
    assert.equal(day.score, 25);
    assert.equal(t.getMonth(101, day.date).strength.earned, 1.5);
    assert.equal(t.getMonth(101, day.date).strength.score, 37.5);
    assert.equal(t.getMonth(101, day.date).score, 87.5);
    t.setCompletion(101, day.date, strength, true);
    assert.equal(t.getMonth(101, day.date).strength.earned, 2);
    assert.equal(t.getMonth(101, day.date).score, 100);
    f.restart();
    assert.equal(f.users.tracking.getMonth(101, '2026-01-02').score, 100);
    assert.equal(f.users.tracking.getDay(202, '2026-01-02').lightFraction, 0);
  } finally { f.close(); }
});

test('definitions, completions, goals and workout diary stay isolated and persist together after restart', () => {
  const f = fixture();
  try {
    const t = f.users.tracking;
    const other = t.getDay(202, '2026-01-01');
    const custom = t.createDefinition(101, { name: 'турник', category: 'strength' }, '2026-01-01');
    t.setCompletion(101, '2026-01-01', custom.id, true);
    t.setGoals(101, '2026-01', { strength: 5, cardio: 7 });
    t.workouts.setDay(101, '2026-01-01', { exercises: [{ id: 'one', name: 'турник', reps: 5, sets: 3, weight: null }] });
    assert.throws(() => t.updateDefinition(202, custom.id, { name: 'чужая' }, '2026-01-01'));
    assert.throws(() => t.setCompletion(202, '2026-01-01', custom.id, true));
    assert.deepEqual(t.getDay(202, '2026-01-01'), other);
    assert.equal(t.getMonth(202, '2026-01-01').strength.goal, null);
    assert.equal(t.workouts.getDay(202, '2026-01-01').exercises.length, 0);
    const expected = t.getMonth(101, '2026-01-01');
    const workout = t.workouts.getDay(101, '2026-01-01');
    f.restart();
    assert.deepEqual(f.users.tracking.getMonth(101, '2026-01-01'), expected);
    assert.deepEqual(f.users.tracking.workouts.getDay(101, '2026-01-01'), workout);
    assert.deepEqual(f.users.tracking.getDay(202, '2026-01-01'), other);
    assert.equal(f.users.getProfile(101).startWeight, null);
    assert.deepEqual(f.users.getMeasurementHistory(101), { measurements: [], legacyMeasurement: null });
  } finally { f.close(); }
});

test('invalid configuration and goal changes fail atomically without changing existing history', () => {
  const f = fixture();
  try {
    const t = f.users.tracking;
    const initial = t.getDefinitions(101);
    const strength = defaultId(f.users, 101, 'strength');
    t.setGoals(101, '2026-01', { strength: 12, cardio: 8 });
    for (const name of ['', '  ', 'a'.repeat(81), 'bad\nname']) {
      assert.throws(() => t.createDefinition(101, { name, category: 'strength' }, '2026-01-01'));
    }
    assert.throws(() => t.createDefinition(101, { name: 'x', category: 'other' as ActivityCategory }, '2026-01-01'));
    assert.throws(() => t.createDefinition(101, { name: 'x', category: 'strength' }, '2026-02-30'));
    assert.throws(() => t.updateDefinition(101, strength, { name: '', archived: true }, '2026-01-01'));
    assert.throws(() => t.updateDefinition(101, strength, { archived: 'true' as unknown as boolean }, '2026-01-01'));
    assert.throws(() => t.updateDefinition(101, strength, {}, '2026-01-01'));
    assert.throws(() => t.setGoals(101, '2026-01', { strength: null, cardio: 0 }));
    assert.throws(() => t.setGoals(101, '2026-13', { strength: 1, cardio: 1 }));
    assert.throws(() => t.setCompletion(101, '2026-01-01', strength, 'true' as unknown as boolean));
    assert.throws(() => t.setCompletion(101, '2026-01-01', 'missing', true));
    assert.throws(() => t.getCalendar(101, '2026-01-02', '2026-01-01'));
    assert.throws(() => t.getCalendar(101, '2025-01-01', '2026-01-03'));
    assert.deepEqual(t.getDefinitions(101), initial);
    const month = t.getMonth(101, '2026-01-01');
    assert.equal(month.strength.goal, 12);
    assert.equal(month.cardio.goal, 8);
    assert.equal(month.score, 0);
  } finally { f.close(); }
});
