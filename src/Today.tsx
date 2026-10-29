import { useEffect, useRef, useState } from 'react';
import type { TrackingDay } from '../server/tracking-types';
import { DailyMeasurement } from './DailyMeasurement';
import { DefinitionsManager } from './DefinitionsManager';
import { WorkoutDiary } from './WorkoutDiary';
import { trackingRequest, trackingTimezone } from './tracking-api';

export type Activity = TrackingDay;
let saveQueue: Promise<void> = Promise.resolve();
export function waitForActivitySaves() { return saveQueue; }
export function enqueueActivitySave<T>(action: () => Promise<T>): Promise<T> {
  const pending = saveQueue.then(action);
  saveQueue = pending.then(() => {}, () => {});
  return pending;
}
const number = (value: number) => value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
function dateKey() {
  const date = new Date();
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}
function request(date: string, options?: RequestInit) {
  return trackingRequest<{ day: TrackingDay }>('/api/tracking/day?timezone=' + encodeURIComponent(trackingTimezone) + '&date=' + encodeURIComponent(date), options).then(value => {
    const day = value.day;
    if (!day || day.date !== date || !Array.isArray(day.definitions) || !Array.isArray(day.completedIds)
      || day.definitions.some(item => !item || typeof item.id !== 'string' || typeof item.name !== 'string' || !['strength', 'cardio'].includes(item.category))
      || day.completedIds.some(id => typeof id !== 'string' || !day.definitions.some(item => item.id === id))
      || ![day.strengthFraction, day.cardioFraction].every(fraction => Number.isFinite(fraction) && fraction >= 0 && fraction <= 1)
      || !Number.isFinite(day.score) || day.score < 0 || day.score > 100) throw new Error('не удалось прочитать отметки за выбранный день.');
    return day;
  });
}
function withCompleted(day: TrackingDay, completedIds: string[]): TrackingDay {
  const fraction = (category: 'strength' | 'cardio') => {
    const items = day.definitions.filter(item => item.category === category);
    return items.length ? items.filter(item => completedIds.includes(item.id)).length / items.length : 0;
  };
  const strengthFraction = fraction('strength'), cardioFraction = fraction('cardio');
  return { ...day, completedIds, strengthFraction, cardioFraction, score: 50 * strengthFraction + 50 * cardioFraction };
}

export function Today({ authenticated, active, selectedDate, onActivityChange, measurementRevision = 0, onMeasurementChange, onConfigurationChange, onSelectToday }: {
  authenticated: boolean; active: boolean; selectedDate: string | null; onActivityChange: (activity: Activity) => void;
  measurementRevision?: number; onMeasurementChange?: () => void; onConfigurationChange?: () => void; onSelectToday?: () => void;
}) {
  const [today, setToday] = useState(dateKey);
  const date = selectedDate ?? today;
  const [cache, setCache] = useState<Map<string, TrackingDay>>(() => new Map());
  const day = cache.get(date);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [configurationBusy, setConfigurationBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const versions = useRef(new Map<string, number>());
  const confirmed = useRef(new Map<string, TrackingDay>());
  const mounted = useRef(true);
  const error = errors[date] ?? '';
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const update = () => setToday(dateKey());
    const timer = window.setInterval(update, 10000);
    const onVisible = () => { if (document.visibilityState === 'visible') { update(); setRetry(value => value + 1); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  useEffect(() => {
    if (!authenticated || !active) return;
    const controller = new AbortController();
    const version = versions.current.get(date) ?? 0;
    let disposed = false;
    let timeout: number | undefined;
    setLoading(true);
    saveQueue.then(() => {
      if (disposed) return Promise.reject(new Error('cancelled'));
      timeout = window.setTimeout(() => {
        controller.abort();
        if (!disposed) { setErrors(current => ({ ...current, [date]: 'не удалось загрузить отметки. попробуй еще раз.' })); setLoading(false); }
      }, 15000);
      return request(date, { signal: controller.signal });
    }).then(value => {
      if (!disposed && !controller.signal.aborted && (versions.current.get(date) ?? 0) === version) {
        confirmed.current.set(date, value);
        setCache(current => new Map(current).set(date, value));
        setErrors(current => ({ ...current, [date]: '' }));
        onActivityChange(value);
      }
    }).catch(err => {
      if (!disposed && !controller.signal.aborted) setErrors(current => ({ ...current, [date]: err instanceof Error ? err.message : 'не удалось загрузить отметки.' }));
    }).finally(() => { window.clearTimeout(timeout); if (!disposed && !controller.signal.aborted) setLoading(false); });
    return () => { disposed = true; window.clearTimeout(timeout); controller.abort(); };
  }, [authenticated, active, date, retry, onActivityChange]);

  function toggle(id: string, completed: boolean) {
    if (!day || date > today || configurationBusy) return;
    const version = (versions.current.get(date) ?? 0) + 1;
    versions.current.set(date, version);
    const next = withCompleted(day, completed ? [...new Set([...day.completedIds, id])] : day.completedIds.filter(value => value !== id));
    setCache(current => new Map(current).set(date, next));
    onActivityChange(next);
    setErrors(current => ({ ...current, [date]: '' }));
    const pending = enqueueActivitySave(async () => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 20000);
      try { return await request(date, { method: 'PATCH', body: JSON.stringify({ id, completed }), signal: controller.signal }); }
      finally { window.clearTimeout(timeout); }
    });
    void pending.then(saved => {
      confirmed.current.set(date, saved);
      if (mounted.current && versions.current.get(date) === version) {
        setCache(current => new Map(current).set(date, saved)); onActivityChange(saved);
        setErrors(current => ({ ...current, [date]: '' }));
      }
    }, err => {
      if (mounted.current && versions.current.get(date) === version) {
        const previous = confirmed.current.get(date);
        if (previous) { setCache(current => new Map(current).set(date, previous)); onActivityChange(previous); }
        setErrors(current => ({ ...current, [date]: err instanceof Error && err.name !== 'AbortError' ? err.message : 'сохранение не подтверждено. повторно загрузи отметки.' }));
      }
    });
  }
  function configurationChanged() {
    for (const [key, version] of versions.current) versions.current.set(key, version + 1);
    confirmed.current.clear(); setCache(new Map()); setRetry(value => value + 1); onConfigurationChange?.();
  }
  const label = new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).replace(/\u0451/g, 'е');
  return <section className="today-panel" aria-labelledby="today-title">
    <header className="today-header"><p className="eyebrow">день</p><h1 id="today-title">{label}</h1>
      {selectedDate && selectedDate !== today && <button type="button" className="tracking-text-button" onClick={onSelectToday}>сегодня</button>}
    </header>
    <DailyMeasurement date={date} authenticated={authenticated} active={active} measurementRevision={measurementRevision} onSaved={() => onMeasurementChange?.()} />
    <div className="tracking-day-heading"><h2 className="day-activity-heading">отметки за день</h2><span>{day ? Math.round(day.score) + ' / 100' : ''}</span></div>
    {authenticated && !day && !error ? <div className="activity-skeleton" role="status" aria-label="загрузка отметок"><div /><div /></div> : <div className="tracking-groups">
      {(['strength', 'cardio'] as const).map(category => {
        const items = day?.definitions.filter(item => item.category === category) ?? [];
        const fraction = day ? category === 'strength' ? day.strengthFraction : day.cardioFraction : 0;
        return <section className="tracking-group" key={category} aria-label={category === 'strength' ? 'физ нагрузка' : 'кардио'}>
          <div className="tracking-group-heading"><h3>{category === 'strength' ? 'физ нагрузка' : 'кардио'}</h3><span>{number(fraction * 50)} / 50</span></div>
          <div className="activity-checks">{items.map(item => <label className={'activity-option activity-' + category + (day?.completedIds.includes(item.id) ? ' is-completed' : '')} key={item.id}>
            <input type="checkbox" checked={!!day?.completedIds.includes(item.id)} disabled={!authenticated || !day || date > today || configurationBusy} onChange={event => toggle(item.id, event.target.checked)} />
            <span className="check-box" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m6 12 4 4 8-9" /></svg></span>
            <span>{item.name}{items.length > 1 && <small className="tracking-mark-share">1/{items.length} категории</small>}</span>
          </label>)}</div>
          {day && items.length === 0 && <p className="tracking-hint">в этой категории нет отметок</p>}
        </section>;
      })}
    </div>}
    {date > today && <p className="tracking-hint">будущий день: запись станет доступна в эту дату.</p>}
    {error && <div className="activity-error" role="alert"><p>{error}</p><button type="button" disabled={loading} onClick={() => setRetry(value => value + 1)}>повторить загрузку</button></div>}
    <DefinitionsManager authenticated={authenticated} active={active} onChanged={configurationChanged} onBusyChange={setConfigurationBusy} />
    <WorkoutDiary date={date} authenticated={authenticated} active={active} />
  </section>;
}
