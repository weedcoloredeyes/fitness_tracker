import { useEffect, useRef, useState, type FormEvent } from 'react';
import { telegram } from './telegram';

type Exercise = { id: string; name: string; reps: number | null; sets: number | null; weight: number | null };
type Workout = { date: string; exercises: Exercise[] };
type DraftExercise = { id: string; name: string; reps: string; sets: string; weight: string };
type Day = {
  workout: Workout | null; loaded: boolean; loading: boolean; loadError: string; saveError: string;
  editing: boolean; draft: DraftExercise[]; saving: boolean; copying: boolean;
};
type Props = { date: string; authenticated: boolean; active: boolean; onSaved?: () => void };
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const freshDay = (): Day => ({ workout: null, loaded: false, loading: false, loadError: '', saveError: '', editing: false, draft: [], saving: false, copying: false });
const lower = (text: string) => text.replace(/\u0451/gi, 'е').toLocaleLowerCase('ru-RU');
const message = (error: unknown, fallback: string) => lower(error instanceof Error ? error.message : fallback);
const format = (value: number | null) => value === null ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const drafts = (workout: Workout): DraftExercise[] => workout.exercises.map((row) => ({
  id: row.id, name: row.name, reps: row.reps === null ? '' : String(row.reps), sets: row.sets === null ? '' : String(row.sets), weight: row.weight === null ? '' : String(row.weight),
}));
let fallbackId = 0;
function rowId() { return globalThis.crypto?.randomUUID?.() ?? `exercise-${Date.now()}-${++fallbackId}`; }
const blankRow = (): DraftExercise => ({ id: rowId(), name: '', reps: '', sets: '', weight: '' });
function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function readWorkout(value: unknown, date?: string): Workout {
  if (!value || typeof value !== 'object') throw new Error('не удалось прочитать тренировку');
  const row = value as Record<string, unknown>;
  if (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || (date !== undefined && row.date !== date) ||
      !Array.isArray(row.exercises) || row.exercises.length > 50) throw new Error('не удалось прочитать тренировку');
  const ids = new Set<string>();
  const exercises = row.exercises.map((item: unknown): Exercise => {
    if (!item || typeof item !== 'object') throw new Error('не удалось прочитать упражнение');
    const exercise = item as Record<string, unknown>;
    if (typeof exercise.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(exercise.id) || ids.has(exercise.id) ||
        typeof exercise.name !== 'string' || !exercise.name.trim() || exercise.name.length > 120) throw new Error('не удалось прочитать упражнение');
    ids.add(exercise.id);
    for (const key of ['reps', 'sets', 'weight']) {
      if (!(exercise[key] === null || typeof exercise[key] === 'number' && Number.isFinite(exercise[key]))) throw new Error('не удалось прочитать упражнение');
    }
    return { id: exercise.id, name: lower(exercise.name), reps: exercise.reps as number | null, sets: exercise.sets as number | null, weight: exercise.weight as number | null };
  });
  return { date: row.date, exercises };
}
async function workoutRequest(date: string, options?: RequestInit) {
  const response = await fetch(`/api/workouts?${new URLSearchParams({ date, timezone })}`, {
    ...options, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Authorization: `tma ${telegram?.initData ?? ''}` },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : 'не удалось загрузить тренировку');
  return readWorkout(value?.workout, date);
}
function parseNumber(raw: string, min: number, max: number, decimal = false): number | null {
  if (!raw.trim()) return null;
  const value = Number(raw.trim().replace(',', '.'));
  if (!Number.isFinite(value) || value < min || value > max || (decimal ? Math.abs(value * 10 - Math.round(value * 10)) > 0.000001 : !Number.isInteger(value))) {
    throw new Error('повторения: 1–1000, подходы: 1–100, вес: 0–1000 кг с одним знаком после запятой');
  }
  return value;
}

export function WorkoutDiary({ date, authenticated, active, onSaved }: Props) {
  const [days, setDays] = useState<Record<string, Day>>({});
  const [refresh, setRefresh] = useState(0);
  const versions = useRef(new Map<string, number>());
  const requests = useRef(new Map<string, AbortController>());
  const day = days[date] ?? freshDay();
  const future = date > todayKey();
  const update = (key: string, change: (current: Day) => Day) => setDays((all) => ({ ...all, [key]: change(all[key] ?? freshDay()) }));

  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') setRefresh((value) => value + 1); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, []);

  useEffect(() => {
    if (!authenticated || !active || day.saving) return;
    const controller = new AbortController();
    requests.current.set(date, controller);
    const version = versions.current.get(date) ?? 0;
    update(date, (current) => ({ ...current, loading: true }));
    const timeout = window.setTimeout(() => {
      if (!controller.signal.aborted && (versions.current.get(date) ?? 0) === version) update(date, (current) => ({ ...current, loading: false, loadError: 'не удалось загрузить тренировку. попробуй еще раз' }));
      controller.abort();
    }, 12_000);
    workoutRequest(date, { signal: controller.signal }).then((workout) => {
      if (controller.signal.aborted || (versions.current.get(date) ?? 0) !== version) return;
      update(date, (current) => ({ ...current, workout, loaded: true, loadError: '', draft: current.editing ? current.draft : drafts(workout) }));
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && (versions.current.get(date) ?? 0) === version) update(date, (current) => ({ ...current, loadError: message(error, 'не удалось загрузить тренировку') }));
    }).finally(() => {
      window.clearTimeout(timeout);
      if (!controller.signal.aborted && (versions.current.get(date) ?? 0) === version) update(date, (current) => ({ ...current, loading: false }));
      if (requests.current.get(date) === controller) requests.current.delete(date);
    });
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [authenticated, active, date, refresh, day.saving]);

  const changeRow = (id: string, key: keyof Omit<DraftExercise, 'id'>, value: string) => update(date, (current) => ({
    ...current, saveError: '', draft: current.draft.map((row) => row.id === id ? { ...row, [key]: key === 'name' ? lower(value) : value } : row),
  }));

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authenticated || future || day.saving || day.copying) return;
    let exercises: Exercise[];
    try {
      exercises = day.draft.map((row) => {
        const name = lower(row.name.trim());
        if (!name || name.length > 120) throw new Error('укажи название каждого упражнения: до 120 символов');
        return { id: row.id, name, reps: parseNumber(row.reps, 1, 1000), sets: parseNumber(row.sets, 1, 100), weight: parseNumber(row.weight, 0, 1000, true) };
      });
    } catch (error) { update(date, (current) => ({ ...current, saveError: message(error, 'проверь упражнения') })); return; }
    requests.current.get(date)?.abort();
    const version = (versions.current.get(date) ?? 0) + 1;
    versions.current.set(date, version);
    update(date, (current) => ({ ...current, saving: true, loading: false, saveError: '' }));
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const workout = await workoutRequest(date, { method: 'PATCH', body: JSON.stringify({ exercises }), signal: controller.signal });
      if (versions.current.get(date) !== version) return;
      update(date, (current) => ({ ...current, workout, draft: drafts(workout), loaded: true, editing: false, loadError: '', saveError: '' }));
      onSaved?.();
    } catch (error) {
      if (versions.current.get(date) === version) update(date, (current) => ({ ...current, saveError: controller.signal.aborted ? 'сохранение не подтверждено. проверь тренировку или повтори запись' : message(error, 'не удалось сохранить тренировку') }));
    } finally {
      window.clearTimeout(timeout);
      if (versions.current.get(date) === version) update(date, (current) => ({ ...current, saving: false }));
    }
  }

  async function copyLatest() {
    if (day.copying || day.saving || future || !authenticated || day.draft.length > 0) return;
    update(date, (current) => ({ ...current, copying: true, saveError: '' }));
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`/api/workouts/latest?${new URLSearchParams({ before: date, timezone })}`, {
        credentials: 'same-origin', headers: { Authorization: `tma ${telegram?.initData ?? ''}` }, signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error ?? 'не удалось найти прошлую тренировку');
      if (result.workout === null) throw new Error('до этого дня еще нет сохраненных упражнений');
      const workout = readWorkout(result.workout);
      if (workout.date >= date) throw new Error('не удалось найти прошлую тренировку');
      update(date, (current) => ({ ...current, editing: true, draft: drafts(workout).map((row) => ({ ...row, id: rowId() })), saveError: '' }));
    } catch (error) {
      update(date, (current) => ({ ...current, saveError: controller.signal.aborted ? 'поиск не завершен. попробуй еще раз' : message(error, 'не удалось скопировать тренировку') }));
    } finally { window.clearTimeout(timeout); update(date, (current) => ({ ...current, copying: false })); }
  }

  const rows = day.workout?.exercises ?? [];
  return <section className="workout-diary" aria-labelledby="workout-diary-title">
    <div className="workout-diary-heading"><h2 id="workout-diary-title">упражнения за день</h2>
      {authenticated && day.loaded && !future && !day.editing && <button className="edit-profile" type="button" disabled={day.saving || day.copying}
        onClick={() => update(date, (current) => ({ ...current, editing: true, saveError: '', draft: rows.length ? drafts(current.workout!) : [blankRow()] }))}>{rows.length ? 'изменить' : 'добавить'}</button>}
    </div>
    {!authenticated ? <p className="workout-hint">открой приложение через telegram, чтобы записывать упражнения</p>
      : !day.loaded ? day.loadError ? null : <p className="workout-hint" role="status">загружаем упражнения…</p>
        : !day.editing && (rows.length ? <ol className="workout-records">{rows.map((row, index) => <li key={row.id}>
          <div className="workout-record-name"><span>{String(index + 1).padStart(2, '0')}</span><strong>{row.name}</strong></div>
          <dl><div><dt>повторы</dt><dd>{format(row.reps)}</dd></div><div><dt>подходы</dt><dd>{format(row.sets)}</dd></div>
            {row.weight !== null && <div><dt>вес, кг</dt><dd>{format(row.weight)}</dd></div>}</dl>
        </li>)}</ol> : <p className="workout-hint">{future ? 'упражнения можно записать, когда этот день наступит' : 'упражнения за этот день пока не записаны'}</p>)}
    {authenticated && day.loaded && !future && !day.editing && rows.length === 0 && <button className="workout-copy" type="button" disabled={day.copying || day.saving} onClick={() => void copyLatest()}>{day.copying ? 'ищем прошлую…' : 'скопировать прошлую тренировку'}</button>}
    {day.editing && !future && <form className="workout-editor" onSubmit={(event) => void save(event)}><fieldset disabled={day.saving || day.copying}>
      <ol className="workout-draft-rows">{day.draft.map((row, index) => <li key={row.id}>
        <div className="workout-row-heading"><span>упражнение {String(index + 1).padStart(2, '0')}</span><button type="button" className="workout-remove" aria-label={`убрать упражнение ${index + 1}`}
          onClick={() => update(date, (current) => ({ ...current, saveError: '', draft: current.draft.filter((item) => item.id !== row.id) }))}>убрать</button></div>
        <label className="workout-name">название<input type="text" name={`exercise-${row.id}-name`} maxLength={120} value={row.name} placeholder="например, жим лежа" onChange={(event) => changeRow(row.id, 'name', event.target.value)} /></label>
        <div className="workout-quantities"><label>повторы<input type="number" inputMode="numeric" min="1" max="1000" step="1" value={row.reps} placeholder="—" aria-label={`повторы упражнения ${index + 1}`} onChange={(event) => changeRow(row.id, 'reps', event.target.value)} /></label>
          <label>подходы<input type="number" inputMode="numeric" min="1" max="100" step="1" value={row.sets} placeholder="—" aria-label={`подходы упражнения ${index + 1}`} onChange={(event) => changeRow(row.id, 'sets', event.target.value)} /></label>
          <label>вес, кг <span className="workout-optional">необязательно</span><input type="number" inputMode="decimal" min="0" max="1000" step="0.1" value={row.weight} placeholder="—" aria-label={`вес упражнения ${index + 1}`} onChange={(event) => changeRow(row.id, 'weight', event.target.value)} /></label></div>
      </li>)}</ol>
      <button className="workout-add" type="button" disabled={day.draft.length >= 50} onClick={() => update(date, (current) => ({ ...current, draft: [...current.draft, blankRow()] }))}>+ упражнение</button>
      {day.draft.length === 0 && rows.length > 0 && <p className="workout-hint">после сохранения упражнения за этот день будут убраны</p>}
      <div className="workout-actions"><button type="submit" className="save-profile">{day.saving ? 'сохраняем…' : 'сохранить упражнения'}</button><button className="retry-button" type="button" onClick={() => update(date, (current) => ({ ...current, editing: false, saveError: '', draft: current.workout ? drafts(current.workout) : [] }))}>отменить</button></div>
      <p className="workout-hint">запись упражнений сохраняет дневник. выполнение тренировки отмечается отдельно выше</p>
    </fieldset></form>}
    {(day.loadError || day.saveError) && <div className="workout-error" role="alert"><p>{day.saveError || day.loadError}</p>
      {day.loadError && <button className="retry-button" type="button" disabled={day.loading || day.saving} onClick={() => setRefresh((value) => value + 1)}>повторить загрузку упражнений</button>}
    </div>}
  </section>;
}
