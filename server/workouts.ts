import type { DatabaseSync } from 'node:sqlite';
import { validateActivityDate } from './activity';

export type Exercise = { id: string; name: string; reps: number | null; sets: number | null; weight: number | null };
export type Workout = { date: string; exercises: Exercise[] };

function quantity(value: unknown, min: number, max: number, decimal = false): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max ||
      (decimal ? Math.abs(value * 10 - Math.round(value * 10)) > 0.000001 : !Number.isInteger(value))) {
    throw new Error('проверь повторения, подходы и вес');
  }
  return value;
}

export function validateWorkout(input: unknown): { exercises: Exercise[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('exercises' in input) ||
      !Array.isArray(input.exercises) || input.exercises.length > 50) throw new Error('не больше 50 упражнений за день');
  const ids = new Set<string>();
  const exercises = input.exercises.map((row: unknown): Exercise => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('проверь упражнение');
    const value = row as Record<string, unknown>;
    if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id) || ids.has(value.id)) {
      throw new Error('некорректная строка упражнения');
    }
    ids.add(value.id);
    if (typeof value.name !== 'string') throw new Error('укажи название упражнения');
    const name = value.name.trim().replace(/\u0451/gi, 'е').toLocaleLowerCase('ru-RU');
    if (!name || name.length > 120) throw new Error('название упражнения: от 1 до 120 символов');
    return { id: value.id, name, reps: quantity(value.reps, 1, 1000), sets: quantity(value.sets, 1, 100), weight: quantity(value.weight, 0, 1000, true) };
  });
  return { exercises };
}

export class WorkoutDiary {
  constructor(private db: DatabaseSync) {
    // This constructor also runs inside the Users schema migration transaction.
    this.db.exec(`CREATE TABLE IF NOT EXISTS workout_exercises (
      user_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL CHECK (length(date) = 10 AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 80),
      position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 49),
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
      reps INTEGER CHECK (reps BETWEEN 1 AND 1000),
      sets INTEGER CHECK (sets BETWEEN 1 AND 100),
      weight REAL CHECK (weight BETWEEN 0 AND 1000),
      PRIMARY KEY (user_id, date, id),
      UNIQUE (user_id, date, position)
    ) STRICT`);
  }

  getDay(userId: number, date: string): Workout {
    validateActivityDate(date);
    const rows = this.db.prepare(`SELECT id, name, reps, sets, weight FROM workout_exercises
      WHERE user_id = ? AND date = ? ORDER BY position`).all(userId, date);
    return { date, exercises: rows.map((row) => ({
      id: String(row.id), name: String(row.name), reps: row.reps as number | null,
      sets: row.sets as number | null, weight: row.weight as number | null,
    })) };
  }

  getLatest(userId: number, before: string): Workout | null {
    validateActivityDate(before);
    const latest = this.db.prepare('SELECT MAX(date) AS date FROM workout_exercises WHERE user_id = ? AND date < ?').get(userId, before);
    return typeof latest?.date === 'string' ? this.getDay(userId, latest.date) : null;
  }

  setDay(userId: number, date: string, input: unknown): Workout {
    validateActivityDate(date);
    const { exercises } = validateWorkout(input);
    this.db.exec('SAVEPOINT workout_diary');
    try {
      this.db.prepare('DELETE FROM workout_exercises WHERE user_id = ? AND date = ?').run(userId, date);
      const insert = this.db.prepare(`INSERT INTO workout_exercises (user_id, date, id, position, name, reps, sets, weight)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      exercises.forEach((row, index) => insert.run(userId, date, row.id, index, row.name, row.reps, row.sets, row.weight));
      const workout = this.getDay(userId, date);
      this.db.exec('RELEASE workout_diary');
      return workout;
    } catch (error) {
      this.db.exec('ROLLBACK TO workout_diary; RELEASE workout_diary');
      throw error;
    }
  }
}
