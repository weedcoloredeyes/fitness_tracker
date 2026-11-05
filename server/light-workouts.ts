import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { validateActivityDate } from './activity';
import type { LightWorkoutAssignment, LightWorkoutSet, LightWorkoutView } from './light-workout-types';

export class LightWorkoutError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 400) { super(message); }
}

function readCatalog(): LightWorkoutSet[] {
  return JSON.parse(readFileSync(new URL('./light-workout-catalog.json', import.meta.url), 'utf8')) as LightWorkoutSet[];
}

function validSet(value: unknown): value is LightWorkoutSet {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const set = value as Record<string, unknown>;
  return typeof set.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(set.id)
    && typeof set.title === 'string' && set.title.length > 0 && set.title.length <= 200
    && Array.isArray(set.exercises) && set.exercises.length > 0 && set.exercises.length <= 50
    && set.exercises.every(line => typeof line === 'string' && line.length > 0 && line.length <= 2000)
    && typeof set.note === 'string' && set.note.length <= 2000;
}

function contents(exercises: readonly string[]): string {
  return JSON.stringify(exercises.map(line => line.trim().toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ')).sort());
}

export class LightWorkouts {
  private readonly catalog: LightWorkoutSet[];

  // Users runs this additive migration inside its existing transaction.
  constructor(private readonly db: DatabaseSync, catalog: readonly LightWorkoutSet[] = readCatalog()) {
    if (!Array.isArray(catalog) || !catalog.length || catalog.some(set => !validSet(set))
      || new Set(catalog.map(set => set.id)).size !== catalog.length) throw new Error('Invalid light workout catalog');
    this.catalog = catalog.map(set => ({ ...set, exercises: [...set.exercises] }));
    db.exec(`
      CREATE TABLE IF NOT EXISTS light_workout_preferences (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        daily_enabled INTEGER NOT NULL CHECK (daily_enabled IN (0, 1))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS light_workout_assignments (
        user_id INTEGER NOT NULL REFERENCES users(id),
        date TEXT NOT NULL CHECK (length(date) = 10 AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        catalog_id TEXT NOT NULL,
        title TEXT NOT NULL,
        exercises_json TEXT NOT NULL CHECK (json_valid(exercises_json) AND json_type(exercises_json) = 'array'),
        note TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (user_id, date)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS light_workout_issuances (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        date TEXT NOT NULL CHECK (length(date) = 10 AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        kind TEXT NOT NULL CHECK (kind IN ('initial', 'reroll')),
        catalog_id TEXT NOT NULL,
        title TEXT NOT NULL,
        exercises_json TEXT NOT NULL CHECK (json_valid(exercises_json) AND json_type(exercises_json) = 'array'),
        note TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (user_id, date, kind)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS light_workout_issuances_user_sequence ON light_workout_issuances(user_id, id DESC);
      INSERT INTO light_workout_issuances (user_id, date, kind, catalog_id, title, exercises_json, note, created_at)
        SELECT a.user_id, a.date, 'initial', a.catalog_id, a.title, a.exercises_json, a.note, a.created_at
        FROM light_workout_assignments a
        WHERE NOT EXISTS (SELECT 1 FROM light_workout_issuances h WHERE h.user_id = a.user_id AND h.date = a.date AND h.kind = 'initial')
        ORDER BY a.created_at, a.date, a.user_id;
    `);
  }

  private requireUser(userId: number): void {
    if (!Number.isSafeInteger(userId) || userId <= 0 || !this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) {
      throw new Error('Unknown user');
    }
  }

  private atomic<T>(action: () => T): T {
    this.db.exec('SAVEPOINT light_workout_change');
    try {
      const result = action();
      this.db.exec('RELEASE light_workout_change');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK TO light_workout_change; RELEASE light_workout_change');
      throw error;
    }
  }

  private enabled(userId: number): boolean {
    return this.db.prepare('SELECT daily_enabled FROM light_workout_preferences WHERE user_id = ?').get(userId)?.daily_enabled === 1;
  }

  private assignment(userId: number, date: string): LightWorkoutAssignment | null {
    const row = this.db.prepare('SELECT catalog_id, title, exercises_json, note FROM light_workout_assignments WHERE user_id = ? AND date = ?').get(userId, date);
    if (!row) return null;
    const set = { id: row.catalog_id, title: row.title, exercises: JSON.parse(String(row.exercises_json)), note: row.note };
    if (!validSet(set)) throw new Error('Invalid saved light workout');
    return { date, catalogId: set.id, title: set.title, exercises: set.exercises, note: set.note };
  }

  getSavedAssignment(userId: number, date: string): LightWorkoutAssignment | null {
    this.requireUser(userId);
    validateActivityDate(date);
    return this.assignment(userId, date);
  }

  private choose(userId: number): LightWorkoutSet {
    const rows = this.db.prepare(`SELECT catalog_id, exercises_json FROM light_workout_issuances
      WHERE user_id = ? ORDER BY id DESC LIMIT 60`).all(userId);
    const recent = new Set(rows.map(row => String(row.catalog_id)));
    const recentContents = new Set(rows.map(row => contents(JSON.parse(String(row.exercises_json)) as string[])));
    const options = this.catalog.filter(set => !recent.has(set.id) && !recentContents.has(contents(set.exercises)));
    if (!options.length) throw new LightWorkoutError('нет нового набора: последние 60 выдач исключены из подбора', 409);
    return options[randomInt(options.length)];
  }

  private record(userId: number, date: string, kind: 'initial' | 'reroll', set: LightWorkoutSet): void {
    this.db.prepare(`INSERT INTO light_workout_issuances (user_id, date, kind, catalog_id, title, exercises_json, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, date, kind, set.id, set.title, JSON.stringify(set.exercises), set.note);
  }

  private select(userId: number, date: string): LightWorkoutAssignment {
    const saved = this.assignment(userId, date);
    if (saved) return saved;
    const set = this.choose(userId);
    this.db.prepare(`INSERT INTO light_workout_assignments (user_id, date, catalog_id, title, exercises_json, note)
      VALUES (?, ?, ?, ?, ?, ?)`).run(userId, date, set.id, set.title, JSON.stringify(set.exercises), set.note);
    this.record(userId, date, 'initial', set);
    return this.assignment(userId, date)!;
  }

  private view(userId: number, date: string, today: string, force = false): LightWorkoutView {
    const dailyEnabled = this.enabled(userId);
    const assignment = date === today && (dailyEnabled || force) ? this.select(userId, date) : this.assignment(userId, date);
    const rerollsUsed = this.db.prepare("SELECT 1 FROM light_workout_issuances WHERE user_id = ? AND date = ? AND kind = 'reroll'").get(userId, date) ? 1 : 0;
    return { date, dailyEnabled, assignment, catalogSize: this.catalog.length, rerollsUsed,
      rerollsRemaining: assignment && date === today ? 1 - rerollsUsed : 0 };
  }

  getDay(userId: number, date: string, today: string): LightWorkoutView {
    this.requireUser(userId);
    validateActivityDate(date); validateActivityDate(today);
    return this.atomic(() => this.view(userId, date, today));
  }

  selectToday(userId: number, date: string, today: string): LightWorkoutView {
    this.requireUser(userId);
    validateActivityDate(date); validateActivityDate(today);
    if (date !== today) throw new Error('Light workouts can only be selected for today');
    return this.atomic(() => this.view(userId, date, today, true));
  }

  rerollToday(userId: number, date: string, today: string, expectedCatalogId: unknown): LightWorkoutView {
    this.requireUser(userId);
    validateActivityDate(date); validateActivityDate(today);
    if (date !== today) throw new LightWorkoutError('сменить набор можно только на сегодня');
    if (typeof expectedCatalogId !== 'string' || !expectedCatalogId) throw new LightWorkoutError('обнови набор перед сменой', 409);
    return this.atomic(() => {
      const current = this.assignment(userId, date);
      if (!current) throw new LightWorkoutError('сначала подбери набор на сегодня', 409);
      const used = this.db.prepare("SELECT 1 FROM light_workout_issuances WHERE user_id = ? AND date = ? AND kind = 'reroll'").get(userId, date);
      if (used) {
        const first = this.db.prepare("SELECT catalog_id FROM light_workout_issuances WHERE user_id = ? AND date = ? AND kind = 'initial'").get(userId, date);
        if (first?.catalog_id === expectedCatalogId) return this.view(userId, date, today);
        throw new LightWorkoutError('смена набора на сегодня уже использована', 409);
      }
      if (current.catalogId !== expectedCatalogId) throw new LightWorkoutError('набор уже изменился. обнови страницу', 409);
      const set = this.choose(userId);
      this.db.prepare(`UPDATE light_workout_assignments SET catalog_id = ?, title = ?, exercises_json = ?, note = ?
        WHERE user_id = ? AND date = ?`).run(set.id, set.title, JSON.stringify(set.exercises), set.note, userId, date);
      this.record(userId, date, 'reroll', set);
      return this.view(userId, date, today);
    });
  }

  setDailyEnabled(userId: number, dailyEnabled: unknown, today: string): LightWorkoutView {
    this.requireUser(userId);
    validateActivityDate(today);
    if (typeof dailyEnabled !== 'boolean') throw new Error('Invalid daily workout preference');
    return this.atomic(() => {
      this.db.prepare(`INSERT INTO light_workout_preferences (user_id, daily_enabled) VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET daily_enabled = excluded.daily_enabled`).run(userId, Number(dailyEnabled));
      return this.view(userId, today, today);
    });
  }
}
