import { useEffect, useRef, useState, type FormEvent } from 'react';
import { telegram } from './telegram';

type Measurement = { date: string; currentWeight: number | null; currentFat: number | null };
type Draft = { weight: string; fat: string };
type DayState = {
  measurement: Measurement | null;
  loaded: boolean;
  loading: boolean;
  loadError: string;
  saveError: string;
  editing: boolean;
  saving: boolean;
  draft: Draft;
};
type Props = { date: string; authenticated: boolean; active: boolean; measurementRevision: number; onSaved: () => void };
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const freshDay = (): DayState => ({ measurement: null, loaded: false, loading: false, loadError: '', saveError: '', editing: false, saving: false, draft: { weight: '', fat: '' } });
const format = (value: number | null) => value === null ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback).replace(/\u0451/gi, 'е').toLocaleLowerCase('ru-RU');
const draftFor = (measurement: Measurement): Draft => ({ weight: measurement.currentWeight === null ? '' : String(measurement.currentWeight), fat: measurement.currentFat === null ? '' : String(measurement.currentFat) });

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function readMeasurement(value: unknown, date: string): Measurement {
  if (!value || typeof value !== 'object' || !('measurement' in value)) throw new Error('не удалось прочитать замер');
  const row = value.measurement;
  if (!row || typeof row !== 'object' || !('date' in row) || row.date !== date ||
      !('currentWeight' in row) || !('currentFat' in row) ||
      !(row.currentWeight === null || typeof row.currentWeight === 'number' && Number.isFinite(row.currentWeight)) ||
      !(row.currentFat === null || typeof row.currentFat === 'number' && Number.isFinite(row.currentFat))) {
    throw new Error('не удалось прочитать замер');
  }
  return { date, currentWeight: row.currentWeight, currentFat: row.currentFat };
}

async function measurementRequest(date: string, options?: RequestInit) {
  const params = new URLSearchParams({ date, timezone });
  const response = await fetch(`/api/measurements?${params}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Authorization: `tma ${telegram?.initData ?? ''}` },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : 'не удалось получить замер');
  return readMeasurement(value, date);
}

function parseValue(raw: string, min: number, max: number): number | null {
  if (!raw.trim()) return null;
  const value = Number(raw.trim().replace(',', '.'));
  if (!Number.isFinite(value) || value < min || value > max || Math.abs(value * 10 - Math.round(value * 10)) > 1e-7) {
    throw new Error('проверь значения: вес от 20 до 400 кг, жир от 1 до 70%, не более одного знака после запятой');
  }
  return value;
}

export function DailyMeasurement({ date, authenticated, active, measurementRevision, onSaved }: Props) {
  const [days, setDays] = useState<Record<string, DayState>>({});
  const [refresh, setRefresh] = useState(0);
  const versions = useRef(new Map<string, number>());
  const requests = useRef(new Map<string, AbortController>());
  const day = days[date] ?? freshDay();
  const future = date > todayKey();

  const update = (key: string, change: (state: DayState) => DayState) => {
    setDays((current) => ({ ...current, [key]: change(current[key] ?? freshDay()) }));
  };

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
      if ((versions.current.get(date) ?? 0) === version && !controller.signal.aborted) {
        update(date, (current) => ({ ...current, loading: false, loadError: 'не удалось загрузить замер. попробуй еще раз' }));
      }
      controller.abort();
    }, 12_000);
    measurementRequest(date, { signal: controller.signal }).then((measurement) => {
      if (controller.signal.aborted || (versions.current.get(date) ?? 0) !== version) return;
      update(date, (current) => ({ ...current, measurement, loaded: true, loadError: '',
        draft: current.editing ? current.draft : draftFor(measurement) }));
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && (versions.current.get(date) ?? 0) === version) {
        update(date, (current) => ({ ...current, loadError: message(error, 'не удалось загрузить замер') }));
      }
    }).finally(() => {
      window.clearTimeout(timeout);
      if (!controller.signal.aborted && (versions.current.get(date) ?? 0) === version) {
        update(date, (current) => ({ ...current, loading: false }));
      }
      if (requests.current.get(date) === controller) requests.current.delete(date);
    });
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [authenticated, active, date, measurementRevision, refresh, day.saving]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authenticated || future || day.saving) return;
    let currentWeight: number | null;
    let currentFat: number | null;
    try {
      currentWeight = parseValue(day.draft.weight, 20, 400);
      currentFat = parseValue(day.draft.fat, 1, 70);
    } catch (error) {
      update(date, (current) => ({ ...current, saveError: message(error, 'проверь значения замера') }));
      return;
    }
    requests.current.get(date)?.abort();
    const version = (versions.current.get(date) ?? 0) + 1;
    versions.current.set(date, version);
    update(date, (current) => ({ ...current, saving: true, loading: false, saveError: '' }));
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const measurement = await measurementRequest(date, { method: 'PATCH', body: JSON.stringify({ currentWeight, currentFat }), signal: controller.signal });
      if (versions.current.get(date) !== version) return;
      update(date, (current) => ({ ...current, measurement, loaded: true, editing: false, draft: draftFor(measurement), loadError: '', saveError: '' }));
      onSaved();
    } catch (error) {
      if (versions.current.get(date) === version) update(date, (current) => ({ ...current,
        saveError: controller.signal.aborted ? 'сохранение не подтверждено. проверь замер или повтори запись' : message(error, 'не удалось сохранить замер') }));
    } finally {
      window.clearTimeout(timeout);
      if (versions.current.get(date) === version) update(date, (current) => ({ ...current, saving: false }));
    }
  }

  const measurement = day.measurement;
  const empty = day.loaded && measurement?.currentWeight == null && measurement?.currentFat == null;

  return <section className="day-measurement" aria-labelledby="day-measurement-title">
    <div className="day-measurement-heading"><h2 id="day-measurement-title">замер за день</h2>
      {authenticated && day.loaded && !future && !day.editing && <button type="button" className="edit-profile" disabled={day.saving}
        onClick={() => update(date, (current) => ({ ...current, editing: true, saveError: '', draft: current.measurement ? draftFor(current.measurement) : { weight: '', fat: '' } }))}>
        {empty ? 'записать' : 'изменить замер'}
      </button>}
    </div>
    {!authenticated ? <p className="measurement-status">открой приложение через telegram, чтобы увидеть замер</p>
      : !day.loaded ? day.loadError ? null : <p className="measurement-status" role="status">загружаем замер за этот день…</p>
        : <>
          <div className="day-measurement-values">
            <div><span>вес</span><strong>{format(measurement?.currentWeight ?? null)}<small className="unit">кг</small></strong></div>
            <div><span>процент жира</span><strong>{format(measurement?.currentFat ?? null)}<small className="unit">%</small></strong></div>
          </div>
          {empty && <p className="measurement-reminder">{future ? 'замер можно добавить, когда этот день наступит' : date === todayKey() ? 'на сегодня замер еще не записан' : 'в этот день замер не записан'}</p>}
        </>}
    {day.editing && !future && <form className="measurement-form" onSubmit={(event) => void save(event)}>
      <fieldset disabled={day.saving}><div className="measurement-fields">
        <label>вес, кг<input name="dayWeight" type="number" inputMode="decimal" min="20" max="400" step="0.1" value={day.draft.weight}
          placeholder="не записан" onChange={(event) => update(date, (current) => ({ ...current, draft: { ...current.draft, weight: event.target.value } }))} /></label>
        <label>жир, %<input name="dayFat" type="number" inputMode="decimal" min="1" max="70" step="0.1" value={day.draft.fat}
          placeholder="не записан" onChange={(event) => update(date, (current) => ({ ...current, draft: { ...current.draft, fat: event.target.value } }))} /></label>
      </div><p className="measurement-reminder">пустое поле убирает значение только за выбранный день</p>
        <div className="measurement-actions"><button type="submit" className="save-profile">{day.saving ? 'сохраняем…' : 'сохранить замер'}</button>
          <button type="button" className="retry-button" onClick={() => update(date, (current) => ({ ...current, editing: false, saveError: '' }))}>отменить</button></div>
      </fieldset>
    </form>}
    {(day.loadError || day.saveError) && <div className="measurement-error" role="alert"><p>{day.saveError || day.loadError}</p>
      {day.loadError && <button type="button" className="retry-button" disabled={day.loading || day.saving} onClick={() => setRefresh((value) => value + 1)}>повторить загрузку замера</button>}
    </div>}
  </section>;
}
