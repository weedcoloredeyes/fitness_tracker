import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { validateActivityDate } from './activity';
import type { LightWorkoutAssignment } from './light-workout-types';

export type Exercise = { id: string; name: string; reps: number | null; sets: number | null; weight: number | null;
  source?: 'light'; sourceText?: string };
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

function importedExercise(id: string, sourceText: string): Exercise {
  const text = sourceText.trim().replace(/\u0451/gi, 'е').toLocaleLowerCase('ru-RU');
  const leading = /^(\d+)\s+(.+)$/.exec(text);
  const explicitSets = /^(.*?)\s+—\s+(\d+)\s+подход(?:а|ов)?\s+по\s+(\d+)\s+раз(?:а)?$/.exec(text);
  const setCount = /,\s+в\s+(\d+)\s+подход(?:а|ов)?$/.exec(text);
  let name = text.split(' — ')[0], reps: number | null = null, sets: number | null = null;
  if (explicitSets && Number(explicitSets[2]) >= 1 && Number(explicitSets[2]) <= 100 && Number(explicitSets[3]) >= 1 && Number(explicitSets[3]) <= 1000) {
    name = explicitSets[1]; sets = Number(explicitSets[2]); reps = Number(explicitSets[3]);
  } else if (leading && Number(leading[1]) >= 1 && Number(leading[1]) <= 1000) {
    name = ({ 'отжиманий': 'отжимания', 'приседаний': 'приседания', 'скручиваний на пресс': 'скручивания на пресс' } as Record<string, string>)[leading[2]] ?? leading[2];
    reps = Number(leading[1]);
  } else if (setCount && Number(setCount[1]) >= 1 && Number(setCount[1]) <= 100) sets = Number(setCount[1]);
  if (!name || name.length > 120) throw new Error('не удалось перенести упражнение из набора');
  return { id, name, reps, sets, weight: null, source: 'light', sourceText };
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
    ) STRICT;
    CREATE TABLE IF NOT EXISTS workout_light_imports (
      user_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL CHECK (length(date) = 10 AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      assignment_key TEXT NOT NULL,
      catalog_id TEXT NOT NULL,
      item_index INTEGER NOT NULL CHECK (item_index BETWEEN 0 AND 49),
      exercise_id TEXT NOT NULL CHECK (length(exercise_id) BETWEEN 1 AND 80),
      source_text TEXT NOT NULL CHECK (length(source_text) BETWEEN 1 AND 2000),
      PRIMARY KEY (user_id, date, exercise_id),
      UNIQUE (user_id, date, assignment_key, item_index)
    ) STRICT`);
  }

  getDay(userId: number, date: string): Workout {
    validateActivityDate(date);
    const rows = this.db.prepare(`SELECT w.id, w.name, w.reps, w.sets, w.weight, i.source_text FROM workout_exercises w
      LEFT JOIN workout_light_imports i ON i.user_id = w.user_id AND i.date = w.date AND i.exercise_id = w.id
      WHERE w.user_id = ? AND w.date = ? ORDER BY w.position`).all(userId, date);
    return { date, exercises: rows.map((row) => ({
      id: String(row.id), name: String(row.name), reps: row.reps as number | null,
      sets: row.sets as number | null, weight: row.weight as number | null,
      ...(typeof row.source_text === 'string' ? { source: 'light' as const, sourceText: row.source_text } : {}),
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
    // Import IDs remain reserved after undo, so a stale editor cannot resurrect
    // removed automatic rows or overwrite the current completed light set.
    const reserved = new Set(this.db.prepare('SELECT exercise_id FROM workout_light_imports WHERE user_id = ? AND date = ?')
      .all(userId, date).map(row => String(row.exercise_id)));
    const automatic = this.getDay(userId, date).exercises.filter(row => row.source === 'light');
    return this.replaceDay(userId, date, [...exercises.filter(row => !reserved.has(row.id)), ...automatic]);
  }

  private replaceDay(userId: number, date: string, exercises: Exercise[]): Workout {
    if (exercises.length > 50) throw new Error('не больше 50 упражнений за день вместе с легкой тренировкой');
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

  syncLightWorkout(userId: number, date: string, assignment: LightWorkoutAssignment | null): Workout {
    validateActivityDate(date);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw new Error('Unknown user');
    if (assignment && (assignment.date !== date || typeof assignment.catalogId !== 'string' || !assignment.catalogId || assignment.catalogId.length > 80 ||
      !Array.isArray(assignment.exercises) || assignment.exercises.length < 1 || assignment.exercises.length > 50 ||
      assignment.exercises.some(text => typeof text !== 'string' || !text.trim() || text.length > 2000))) throw new Error('некорректный набор упражнений');
    this.db.exec('SAVEPOINT workout_light_sync');
    try {
      const manual = this.getDay(userId, date).exercises.filter(row => row.source !== 'light');
      const automatic: Exercise[] = [];
      if (assignment) {
        const key = createHash('sha256').update(JSON.stringify([assignment.catalogId, assignment.exercises])).digest('hex');
        for (const [index, text] of assignment.exercises.entries()) {
          const existing = this.db.prepare('SELECT exercise_id, source_text FROM workout_light_imports WHERE user_id = ? AND date = ? AND assignment_key = ? AND item_index = ?')
            .get(userId, date, key, index);
          const id = existing ? String(existing.exercise_id) : 'light-' + randomUUID();
          const sourceText = existing ? String(existing.source_text) : text;
          const exercise = importedExercise(id, sourceText);
          if (!existing) this.db.prepare(`INSERT INTO workout_light_imports (user_id, date, assignment_key, catalog_id, item_index, exercise_id, source_text)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, date, key, assignment.catalogId, index, id, sourceText);
          automatic.push(exercise);
        }
      }
      const workout = this.replaceDay(userId, date, [...manual, ...automatic]);
      this.db.exec('RELEASE workout_light_sync');
      return workout;
    } catch (error) {
      this.db.exec('ROLLBACK TO workout_light_sync; RELEASE workout_light_sync');
      throw error;
    }
  }
}
