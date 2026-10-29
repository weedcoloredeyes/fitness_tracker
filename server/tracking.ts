import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validateActivityDate } from './activity';
import { WorkoutDiary } from './workouts';
import { ACTIVITY_CATEGORIES, CURRENT_CATEGORY_WEIGHTS, LEGACY_CATEGORY_WEIGHTS, calculateTrackingScore, physicalTrainingFraction, type ActivityCategory, type ActivityDefinition,
  type ActivityWeights, type MonthlyTracking, type MonthlyTrackingCategory, type TrackingDay, type TrackingGoals } from './tracking-types';

export type { ActivityCategory, ActivityDefinition, MonthlyTracking, MonthlyTrackingCategory, TrackingDay, TrackingGoals } from './tracking-types';

const FIRST_DATE = '0001-01-01';
const DEFAULT_STRENGTH = 'strength';
const DEFAULT_LIGHT = 'light';
const DEFAULT_CARDIO = 'cardio';
const LEGACY_MICRO = 'legacy-micro';

function nameValue(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid activity name');
  const name = value.trim().toLocaleLowerCase('ru').replace(/ё/g, 'е');
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Invalid activity name');
  return name;
}

function monthValue(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) throw new Error('Invalid month');
  validateActivityDate(value + '-01');
  return value;
}

function sum(values: number[]): number {
  let total = 0;
  let correction = 0;
  for (const value of values) {
    const next = value - correction;
    const combined = total + next;
    correction = (combined - total) - next;
    total = combined;
  }
  return total;
}

function definition(row: Record<string, unknown>, historical = false): ActivityDefinition {
  return { id: String(row.id), name: String(row.name), category: row.category as ActivityCategory,
    archived: historical ? false : !!row.archived };
}

function migrateCategories(db: DatabaseSync) {
  const old = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tracking_definitions'").get();
  if (!old || String(old.sql).includes("'light'")) return;
  // Rebuild the parent and its children together while foreign keys remain enabled.
  // All IDs, events, historical memberships and completions are copied unchanged.
  db.exec(`
    CREATE TABLE tracking_definitions_v9 (
      user_id INTEGER NOT NULL REFERENCES users(id), id TEXT NOT NULL,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
      category TEXT NOT NULL CHECK (category IN ('strength', 'light', 'cardio')),
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)), ordinal INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    ) STRICT;
    INSERT INTO tracking_definitions_v9 SELECT * FROM tracking_definitions;
    CREATE TABLE tracking_definition_events_v9 (
      user_id INTEGER NOT NULL, definition_id TEXT NOT NULL, effective_date TEXT NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      PRIMARY KEY (user_id, definition_id, effective_date),
      FOREIGN KEY (user_id, definition_id) REFERENCES tracking_definitions_v9(user_id, id)
    ) STRICT;
    INSERT INTO tracking_definition_events_v9 SELECT * FROM tracking_definition_events;
    CREATE TABLE tracking_day_definitions_v9 (
      user_id INTEGER NOT NULL, date TEXT NOT NULL, definition_id TEXT NOT NULL,
      PRIMARY KEY (user_id, date, definition_id),
      FOREIGN KEY (user_id, date) REFERENCES tracking_legacy_days(user_id, date),
      FOREIGN KEY (user_id, definition_id) REFERENCES tracking_definitions_v9(user_id, id)
    ) STRICT;
    INSERT INTO tracking_day_definitions_v9 SELECT * FROM tracking_day_definitions;
    CREATE TABLE tracking_completions_v9 (
      user_id INTEGER NOT NULL, date TEXT NOT NULL, definition_id TEXT NOT NULL,
      PRIMARY KEY (user_id, date, definition_id),
      FOREIGN KEY (user_id, definition_id) REFERENCES tracking_definitions_v9(user_id, id)
    ) STRICT;
    INSERT INTO tracking_completions_v9 SELECT * FROM tracking_completions;
    DROP TABLE tracking_definition_events;
    DROP TABLE tracking_day_definitions;
    DROP TABLE tracking_completions;
    DROP TABLE tracking_definitions;
    ALTER TABLE tracking_definitions_v9 RENAME TO tracking_definitions;
    ALTER TABLE tracking_definition_events_v9 RENAME TO tracking_definition_events;
    ALTER TABLE tracking_day_definitions_v9 RENAME TO tracking_day_definitions;
    ALTER TABLE tracking_completions_v9 RENAME TO tracking_completions;
  `);
}

export class Tracking {
  readonly workouts: WorkoutDiary;

  // Called by Users inside its existing migration transaction.
  constructor(private readonly db: DatabaseSync) {
    migrateCategories(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS tracking_users (
        user_id INTEGER PRIMARY KEY REFERENCES users(id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tracking_definitions (
        user_id INTEGER NOT NULL REFERENCES users(id),
        id TEXT NOT NULL,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
        category TEXT NOT NULL CHECK (category IN ('strength', 'light', 'cardio')),
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (user_id, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tracking_definition_events (
        user_id INTEGER NOT NULL,
        definition_id TEXT NOT NULL,
        effective_date TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        PRIMARY KEY (user_id, definition_id, effective_date),
        FOREIGN KEY (user_id, definition_id) REFERENCES tracking_definitions(user_id, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tracking_legacy_days (
        user_id INTEGER NOT NULL REFERENCES users(id),
        date TEXT NOT NULL,
        PRIMARY KEY (user_id, date)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tracking_day_definitions (
        user_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        definition_id TEXT NOT NULL,
        PRIMARY KEY (user_id, date, definition_id),
        FOREIGN KEY (user_id, date) REFERENCES tracking_legacy_days(user_id, date),
        FOREIGN KEY (user_id, definition_id) REFERENCES tracking_definitions(user_id, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tracking_completions (
        user_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        definition_id TEXT NOT NULL,
        PRIMARY KEY (user_id, date, definition_id),
        FOREIGN KEY (user_id, definition_id) REFERENCES tracking_definitions(user_id, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS monthly_cardio_goals (
        user_id INTEGER NOT NULL REFERENCES users(id),
        month TEXT NOT NULL,
        goal INTEGER NOT NULL CHECK (goal BETWEEN 1 AND 1000),
        PRIMARY KEY (user_id, month)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tracking_category_versions (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        activation_date TEXT CHECK (activation_date IS NULL OR
          (length(activation_date) = 10 AND activation_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tracking_migrations (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        legacy_imported INTEGER NOT NULL CHECK (legacy_imported = 1)
      ) STRICT;
    `);
    for (const row of db.prepare('SELECT id FROM users ORDER BY id').all()) this.ensureUser(Number(row.id));
    if (!db.prepare('SELECT 1 FROM tracking_migrations WHERE id = 1').get()) {
      db.exec('INSERT INTO tracking_migrations (id, legacy_imported) VALUES (1, 1)');
    }
    this.workouts = new WorkoutDiary(db);
  }

  ensureUser(userId: number): void {
    this.requireUser(userId);
    if (this.db.prepare('SELECT 1 FROM tracking_users WHERE user_id = ?').get(userId)) {
      this.db.prepare('INSERT OR IGNORE INTO tracking_category_versions (user_id, activation_date) VALUES (?, NULL)').run(userId);
      return;
    }
    const days = this.db.prepare('SELECT date, training, micro_training, walking FROM daily_activity WHERE user_id = ? ORDER BY date').all(userId);
    const defaults: [string, string, ActivityCategory, number][] = days.length
      ? [[DEFAULT_STRENGTH, 'физ нагрузка', 'strength', 0], [DEFAULT_CARDIO, 'кардио', 'cardio', 1]]
      : [[DEFAULT_STRENGTH, 'основная тренировка', 'strength', 0], [DEFAULT_LIGHT, 'легкая тренировка', 'light', 1], [DEFAULT_CARDIO, 'кардио', 'cardio', 2]];
    for (const [id, name, category, ordinal] of defaults) {
      this.db.prepare(`INSERT INTO tracking_definitions (user_id, id, name, category, archived, ordinal)
        VALUES (?, ?, ?, ?, 0, ?)`).run(userId, id, name, category, ordinal);
      this.db.prepare(`INSERT INTO tracking_definition_events (user_id, definition_id, effective_date, active)
        VALUES (?, ?, ?, 1)`).run(userId, id, FIRST_DATE);
    }
    // Early databases could contain marks before their user was registered.
    // Leave those rows intact and import them only once a real identify creates the user.
    for (const day of days) {
      const date = validateActivityDate(day.date);
      this.db.prepare(`INSERT INTO tracking_definitions (user_id, id, name, category, archived, ordinal)
        VALUES (?, ?, 'микро', 'strength', 1, 2) ON CONFLICT(user_id, id) DO NOTHING`).run(userId, LEGACY_MICRO);
      this.db.prepare('INSERT INTO tracking_legacy_days (user_id, date) VALUES (?, ?)').run(userId, date);
      for (const [id, completed] of [[DEFAULT_STRENGTH, day.training], [LEGACY_MICRO, day.micro_training], [DEFAULT_CARDIO, day.walking]] as const) {
        this.db.prepare('INSERT INTO tracking_day_definitions (user_id, date, definition_id) VALUES (?, ?, ?)').run(userId, date, id);
        if (completed) this.db.prepare('INSERT INTO tracking_completions (user_id, date, definition_id) VALUES (?, ?, ?)').run(userId, date, id);
      }
    }
    this.db.prepare('INSERT INTO tracking_users (user_id) VALUES (?)').run(userId);
    this.db.prepare('INSERT INTO tracking_category_versions (user_id, activation_date) VALUES (?, ?)').run(userId, days.length ? null : FIRST_DATE);
  }

  // Activation waits for an authenticated request so "today" uses the user's timezone.
  upgradeUser(userId: number, today: string): void {
    this.requireUser(userId);
    validateActivityDate(today);
    if (this.db.prepare('SELECT activation_date FROM tracking_category_versions WHERE user_id = ?').get(userId)?.activation_date) return;
    this.atomic(() => {
      const ordinal = Number(this.db.prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM tracking_definitions WHERE user_id = ?').get(userId)!.next);
      this.db.prepare(`INSERT INTO tracking_definitions (user_id, id, name, category, archived, ordinal)
        VALUES (?, ?, 'легкая тренировка', 'light', 0, ?)`).run(userId, DEFAULT_LIGHT, ordinal);
      this.db.prepare('INSERT INTO tracking_definition_events (user_id, definition_id, effective_date, active) VALUES (?, ?, ?, 1)')
        .run(userId, DEFAULT_LIGHT, today);
      this.db.prepare(`INSERT INTO tracking_day_definitions (user_id, date, definition_id)
        SELECT user_id, date, ? FROM tracking_legacy_days WHERE user_id = ? AND date >= ?`).run(DEFAULT_LIGHT, userId, today);
      this.db.prepare("UPDATE tracking_definitions SET name = 'основная тренировка' WHERE user_id = ? AND id = ? AND name = 'физ нагрузка'")
        .run(userId, DEFAULT_STRENGTH);
      this.db.prepare('UPDATE tracking_category_versions SET activation_date = ? WHERE user_id = ?').run(today, userId);
    });
  }

  private weights(userId: number, date: string): ActivityWeights {
    const activation = this.db.prepare('SELECT activation_date FROM tracking_category_versions WHERE user_id = ?').get(userId)?.activation_date;
    return { ...(typeof activation === 'string' && date >= activation ? CURRENT_CATEGORY_WEIGHTS : LEGACY_CATEGORY_WEIGHTS) };
  }

  private requireUser(userId: number): void {
    if (!Number.isSafeInteger(userId) || userId <= 0 || !this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) {
      throw new Error('Unknown user');
    }
  }

  private atomic<T>(action: () => T): T {
    this.db.exec('SAVEPOINT tracking_change');
    try {
      const result = action();
      this.db.exec('RELEASE tracking_change');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK TO tracking_change; RELEASE tracking_change');
      throw error;
    }
  }

  getDefinitions(userId: number): ActivityDefinition[] {
    this.requireUser(userId);
    return this.db.prepare('SELECT id, name, category, archived FROM tracking_definitions WHERE user_id = ? ORDER BY ordinal, id')
      .all(userId).map(row => definition(row));
  }

  createDefinition(userId: number, input: { name: string; category: ActivityCategory }, effectiveDate: string): ActivityDefinition {
    this.requireUser(userId);
    validateActivityDate(effectiveDate);
    if (!input || typeof input !== 'object' || Array.isArray(input) || !ACTIVITY_CATEGORIES.includes(input.category)) {
      throw new Error('Invalid activity category');
    }
    const name = nameValue(input.name);
    return this.atomic(() => {
      const id = randomUUID();
      const ordinal = Number(this.db.prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM tracking_definitions WHERE user_id = ?').get(userId)!.next);
      this.db.prepare('INSERT INTO tracking_definitions (user_id, id, name, category, archived, ordinal) VALUES (?, ?, ?, ?, 0, ?)')
        .run(userId, id, name, input.category, ordinal);
      this.db.prepare('INSERT INTO tracking_definition_events (user_id, definition_id, effective_date, active) VALUES (?, ?, ?, 1)')
        .run(userId, id, effectiveDate);
      this.db.prepare(`INSERT INTO tracking_day_definitions (user_id, date, definition_id)
        SELECT user_id, date, ? FROM tracking_legacy_days WHERE user_id = ? AND date >= ?`).run(id, userId, effectiveDate);
      return { id, name, category: input.category, archived: false };
    });
  }

  updateDefinition(userId: number, id: string, input: { name?: string; archived?: boolean }, effectiveDate: string): ActivityDefinition {
    this.requireUser(userId);
    validateActivityDate(effectiveDate);
    const old = this.getDefinitions(userId).find(item => item.id === id);
    if (!old || !input || typeof input !== 'object' || Array.isArray(input) ||
        (!Object.hasOwn(input, 'name') && !Object.hasOwn(input, 'archived'))) throw new Error('Invalid activity update');
    const name = Object.hasOwn(input, 'name') ? nameValue(input.name) : old.name;
    if (Object.hasOwn(input, 'archived') && typeof input.archived !== 'boolean') throw new Error('Invalid archive value');
    const archived = input.archived ?? old.archived;
    return this.atomic(() => {
      this.db.prepare('UPDATE tracking_definitions SET name = ?, archived = ? WHERE user_id = ? AND id = ?')
        .run(name, Number(archived), userId, id);
      if (Object.hasOwn(input, 'archived')) {
        this.db.prepare(`INSERT INTO tracking_definition_events (user_id, definition_id, effective_date, active)
          VALUES (?, ?, ?, ?) ON CONFLICT(user_id, definition_id, effective_date) DO UPDATE SET active = excluded.active`)
          .run(userId, id, effectiveDate, Number(!archived));
        if (archived) this.db.prepare('DELETE FROM tracking_day_definitions WHERE user_id = ? AND definition_id = ? AND date >= ?')
          .run(userId, id, effectiveDate);
        else this.db.prepare(`INSERT OR IGNORE INTO tracking_day_definitions (user_id, date, definition_id)
          SELECT user_id, date, ? FROM tracking_legacy_days WHERE user_id = ? AND date >= ?`).run(id, userId, effectiveDate);
      }
      return { ...old, name, archived };
    });
  }

  getDay(userId: number, date: string): TrackingDay {
    this.requireUser(userId);
    validateActivityDate(date);
    const historical = !!this.db.prepare('SELECT 1 FROM tracking_legacy_days WHERE user_id = ? AND date = ?').get(userId, date);
    const rows = historical ? this.db.prepare(`SELECT d.id, d.name, d.category, d.archived FROM tracking_definitions d
      JOIN tracking_day_definitions s ON s.user_id = d.user_id AND s.definition_id = d.id
      WHERE d.user_id = ? AND s.date = ? ORDER BY d.category DESC, d.ordinal, d.id`).all(userId, date)
      : this.db.prepare(`SELECT d.id, d.name, d.category, d.archived FROM tracking_definitions d
        WHERE d.user_id = ? AND (SELECT e.active FROM tracking_definition_events e
          WHERE e.user_id = d.user_id AND e.definition_id = d.id AND e.effective_date <= ?
          ORDER BY e.effective_date DESC LIMIT 1) = 1 ORDER BY d.category DESC, d.ordinal, d.id`).all(userId, date);
    const definitions = rows.map(row => definition(row, true));
    const completed = new Set(this.db.prepare('SELECT definition_id FROM tracking_completions WHERE user_id = ? AND date = ?')
      .all(userId, date).map(row => String(row.definition_id)));
    const completedIds = definitions.filter(item => completed.has(item.id)).map(item => item.id);
    const fraction = (category: ActivityCategory) => {
      const eligible = definitions.filter(item => item.category === category);
      return eligible.length ? eligible.filter(item => completed.has(item.id)).length / eligible.length : 0;
    };
    const strengthFraction = fraction('strength');
    const lightFraction = fraction('light');
    const cardioFraction = fraction('cardio');
    const weights = this.weights(userId, date);
    return { date, definitions, completedIds, strengthFraction, lightFraction, cardioFraction, weights,
      score: calculateTrackingScore({ strength: strengthFraction, light: lightFraction, cardio: cardioFraction }, weights) };
  }

  setCompletion(userId: number, date: string, id: string, completed: boolean): TrackingDay {
    if (typeof completed !== 'boolean' || typeof id !== 'string') throw new Error('Invalid completion');
    const day = this.getDay(userId, date);
    if (!day.definitions.some(item => item.id === id)) throw new Error('Unknown activity for this date');
    if (completed) this.db.prepare('INSERT OR IGNORE INTO tracking_completions (user_id, date, definition_id) VALUES (?, ?, ?)').run(userId, date, id);
    else this.db.prepare('DELETE FROM tracking_completions WHERE user_id = ? AND date = ? AND definition_id = ?').run(userId, date, id);
    return this.getDay(userId, date);
  }

  getCalendar(userId: number, start: string, end: string): TrackingDay[] {
    this.requireUser(userId);
    validateActivityDate(start);
    validateActivityDate(end);
    const count = (Date.parse(end) - Date.parse(start)) / 86_400_000;
    if (count < 0 || count > 366) throw new Error('Invalid calendar range');
    const cursor = new Date(start + 'T12:00:00Z');
    const days: TrackingDay[] = [];
    for (let index = 0; index <= count; index++) {
      days.push(this.getDay(userId, cursor.toISOString().slice(0, 10)));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days;
  }

  getMonth(userId: number, today: string, month = today.slice(0, 7)): MonthlyTracking {
    this.requireUser(userId);
    validateActivityDate(today);
    monthValue(month);
    const start = month + '-01';
    const last = new Date(start + 'T12:00:00Z');
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    const end = [last.toISOString().slice(0, 10), today].sort()[0];
    const days = end < start ? [] : this.getCalendar(userId, start, end);
    const weights = { ...LEGACY_CATEGORY_WEIGHTS };
    const category = (kind: 'strength' | 'cardio'): MonthlyTrackingCategory => {
      const values = days.map(day => kind === 'strength' ? physicalTrainingFraction(day) : day.cardioFraction);
      const earned = sum(values);
      const table = kind === 'strength' ? 'monthly_workout_goals' : 'monthly_cardio_goals';
      const row = this.db.prepare(`SELECT goal FROM ${table} WHERE user_id = ? AND month = ?`).get(userId, month);
      const goal = row ? Number(row.goal) : null;
      return { earned, goal, score: weights[kind] === 0 ? 0 : goal === null ? null : weights[kind] * Math.min(earned / goal, 1), completedDays: values.filter(value => value === 1).length };
    };
    const strength = category('strength');
    const cardio = category('cardio');
    return { month, start, end, weights, score: strength.score === null || cardio.score === null ? null : sum([strength.score, cardio.score]),
      strength, cardio, days };
  }

  setGoals(userId: number, month: string, goals: TrackingGoals): void {
    this.requireUser(userId);
    monthValue(month);
    if (!goals || typeof goals !== 'object' || Array.isArray(goals)) throw new Error('Invalid goals');
    for (const value of [goals.strength, goals.cardio]) {
      if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1000)) throw new Error('Invalid goal');
    }
    this.atomic(() => {
      const updates: [string, number | null][] = [['monthly_workout_goals', goals.strength], ['monthly_cardio_goals', goals.cardio]];
      for (const [table, value] of updates) {
        if (value === null) this.db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND month = ?`).run(userId, month);
        else this.db.prepare(`INSERT INTO ${table} (user_id, month, goal) VALUES (?, ?, ?)
          ON CONFLICT(user_id, month) DO UPDATE SET goal = excluded.goal`).run(userId, month, value);
      }
    });
  }
}
