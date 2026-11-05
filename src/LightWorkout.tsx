import { useEffect, useId, useRef, useState } from 'react';
import type { LightWorkoutAssignment, LightWorkoutView } from '../server/light-workout-types';
import { trackingRequest, trackingTimezone } from './tracking-api';

type Props = {
  date: string; authenticated: boolean; active: boolean; completed?: boolean; activityBusy?: boolean;
  onBusyChange?: (busy: boolean) => void;
};
type DayState = { view: LightWorkoutView | null; loading: boolean; open: boolean; error: string };
const emptyDay = (): DayState => ({ view: null, loading: false, open: false, error: '' });
const lower = (value: string) => value.toLocaleLowerCase('ru-RU').replace(/\u0451/g, 'е');
const message = (error: unknown) => lower(error instanceof Error ? error.message : 'не удалось загрузить набор. попробуй еще раз');

function todayKey() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function readView(value: unknown, expectedDate: string): LightWorkoutView {
  if (!value || typeof value !== 'object') throw new Error('не удалось прочитать набор');
  const view = value as LightWorkoutView;
  if (view.date !== expectedDate || typeof view.dailyEnabled !== 'boolean' ||
      !Number.isInteger(view.catalogSize) || view.catalogSize < 1 || view.catalogSize > 10000 ||
      ![0, 1].includes(view.rerollsUsed) || ![0, 1].includes(view.rerollsRemaining) ||
      view.rerollsUsed + view.rerollsRemaining > 1 || view.assignment === null && view.rerollsRemaining !== 0) throw new Error('не удалось прочитать набор');
  if (view.assignment !== null) {
    const set = view.assignment as LightWorkoutAssignment;
    if (!set || set.date !== expectedDate || typeof set.catalogId !== 'string' || !set.catalogId || set.catalogId.length > 80 ||
        typeof set.title !== 'string' || !set.title.trim() || set.title.length > 200 ||
        !Array.isArray(set.exercises) || set.exercises.length < 1 || set.exercises.length > 50 ||
        set.exercises.some(item => typeof item !== 'string' || !item.trim() || item.length > 2000) ||
        typeof set.note !== 'string' || set.note.length > 1000) throw new Error('не удалось прочитать упражнения набора');
  }
  return view;
}

function exerciseCount(count: number) {
  const last = count % 10, lastTwo = count % 100;
  return `${count} ${last === 1 && lastTwo !== 11 ? 'упражнение' : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'упражнения' : 'упражнений'}`;
}

export function LightWorkout({ date, authenticated, active, completed = false, activityBusy = false, onBusyChange }: Props) {
  const [today, setToday] = useState(todayKey);
  const [days, setDays] = useState<Record<string, DayState>>({});
  const [refresh, setRefresh] = useState(0);
  const [saving, setSaving] = useState(false);
  const day = days[date] ?? emptyDay();
  const view = day.view;
  const isToday = date === today;
  const future = date > today;
  const detailsId = useId();
  const versions = useRef(new Map<string, number>());
  const readController = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const busyReported = useRef(false);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const reportBusy = (busy: boolean) => {
    if (busyReported.current === busy) return;
    busyReported.current = busy;
    busyCallback.current?.(busy);
  };
  const currentDate = useRef(date);
  currentDate.current = date;
  const update = (key: string, change: (current: DayState) => DayState) => setDays(all => ({ ...all, [key]: change(all[key] ?? emptyDay()) }));
  const endpoint = (key: string) => '/api/light-workouts?' + new URLSearchParams({ date: key, timezone: trackingTimezone });

  useEffect(() => {
    mounted.current = true;
    const tick = () => setToday(todayKey());
    const visible = () => {
      tick();
      if (document.visibilityState === 'visible') setRefresh(value => value + 1);
    };
    const timer = window.setInterval(tick, 10000);
    document.addEventListener('visibilitychange', visible);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      readController.current?.abort();
      mutation.current?.abort();
      reportBusy(false);
    };
  }, []);

  useEffect(() => {
    if (!authenticated || !active || mutation.current) return;
    const controller = new AbortController();
    readController.current = controller;
    const version = versions.current.get(date) ?? 0;
    update(date, current => ({ ...current, loading: true }));
    const timeout = window.setTimeout(() => {
      controller.abort();
      if (mounted.current && (versions.current.get(date) ?? 0) === version) update(date, current => ({ ...current, loading: false, error: 'не удалось загрузить набор вовремя. попробуй еще раз' }));
    }, 15000);
    trackingRequest<unknown>(endpoint(date), { signal: controller.signal }).then(value => {
      if (controller.signal.aborted || !mounted.current || (versions.current.get(date) ?? 0) !== version) return;
      const loaded = readView(value, date);
      update(date, current => ({ ...current, view: loaded, loading: false, error: '', open: current.view ? current.open : loaded.dailyEnabled && loaded.assignment !== null }));
    }).catch(error => {
      if (!controller.signal.aborted && mounted.current && (versions.current.get(date) ?? 0) === version) update(date, current => ({ ...current, loading: false, error: message(error) }));
    }).finally(() => {
      window.clearTimeout(timeout);
      if (readController.current === controller) readController.current = null;
    });
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [authenticated, active, date, today, refresh]);

  async function change(kind: 'select' | 'preference' | 'reroll', enabled?: boolean) {
    if (!authenticated || !active || !isToday || activityBusy || mutation.current || !view) return;
    if (kind === 'reroll' && (!view.assignment || view.rerollsRemaining !== 1 || completed)) return;
    const key = date;
    const version = (versions.current.get(key) ?? 0) + 1;
    versions.current.set(key, version);
    readController.current?.abort();
    const controller = new AbortController();
    mutation.current = controller;
    setSaving(true);
    reportBusy(true);
    update(key, current => ({ ...current, loading: false, error: '' }));
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      const path = kind === 'select' ? endpoint(key)
        : kind === 'reroll' ? '/api/light-workouts/reroll?' + new URLSearchParams({ date: key, timezone: trackingTimezone })
          : '/api/light-workouts/preferences?' + new URLSearchParams({ timezone: trackingTimezone });
      const result = await trackingRequest<unknown>(path, {
        method: kind === 'preference' ? 'PATCH' : 'POST', signal: controller.signal,
        ...(kind === 'preference' ? { body: JSON.stringify({ dailyEnabled: enabled }) }
          : kind === 'reroll' ? { body: JSON.stringify({ expectedCatalogId: view.assignment!.catalogId }) } : {}),
      });
      if (controller.signal.aborted) throw new Error('сохранение не подтверждено. обнови набор и проверь настройку');
      const saved = readView(result, key);
      if (kind !== 'preference' && saved.assignment === null) throw new Error('не удалось подтвердить выбор набора. попробуй еще раз');
      if (mounted.current && versions.current.get(key) === version) update(key, current => ({ ...current, view: saved, error: '', open: kind !== 'preference' ? true : current.open }));
    } catch (error) {
      if (mounted.current && versions.current.get(key) === version) update(key, current => ({ ...current, error: controller.signal.aborted ? 'сохранение не подтверждено. обнови набор и проверь настройку' : message(error) }));
    } finally {
      window.clearTimeout(timeout);
      if (mutation.current === controller) mutation.current = null;
      reportBusy(false);
      if (mounted.current) {
        setSaving(false);
        if (currentDate.current !== key) setRefresh(value => value + 1);
      }
    }
  }

  if (!authenticated) return null;
  const assignment = view?.assignment;
  const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }).replace(/\u0451/g, 'е');
  return <section className="light-workout" aria-label="набор легкой тренировки">
    {!view ? !day.error && <p className="light-workout-note" role="status">загружаем набор…</p>
      : assignment ? <div className="light-workout-card">
        <button className="light-workout-heading" type="button" aria-expanded={day.open} aria-controls={detailsId}
          onClick={() => update(date, current => ({ ...current, open: !current.open }))}>
          <span>{isToday ? 'набор на сегодня' : `набор за ${dateLabel}`}</span>
          <span className="light-workout-summary">{exerciseCount(assignment.exercises.length)}<span aria-hidden="true">{day.open ? '−' : '+'}</span></span>
        </button>
        {day.open && <div className="light-workout-content" id={detailsId}>
          <ol className="light-workout-exercises">{assignment.exercises.map((exercise, index) => <li key={index}><span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><span>{lower(exercise)}</span></li>)}</ol>
          {assignment.note && <p className="light-workout-note">{lower(assignment.note)}</p>}
          {isToday && <div className="light-workout-reroll">
            <button className="tracking-text-button" type="button" disabled={saving || !active || activityBusy || completed || view.rerollsRemaining !== 1}
              onClick={() => void change('reroll')}>сменить набор</button>
            <p className="light-workout-note">{view.rerollsUsed === 1 ? 'смена на сегодня использована'
              : completed ? 'сними отметку легкой тренировки, чтобы сменить набор' : 'одна смена в день'}</p>
          </div>}
          {isToday && <label className="light-workout-preference"><span>показывать каждый день</span>
            <input type="checkbox" role="switch" checked={view.dailyEnabled} disabled={saving || !active || activityBusy} onChange={event => void change('preference', event.target.checked)} />
            <span className="light-workout-switch" aria-hidden="true" />
          </label>}
          {saving && <p className="light-workout-note" role="status">сохраняем…</p>}
        </div>}
      </div> : isToday ? <button type="button" className="tracking-text-button light-workout-pick" disabled={saving || !active || activityBusy} onClick={() => void change('select')}>{saving ? 'подбираем…' : 'подобрать на сегодня'}</button>
        : <p className="light-workout-note">{future ? 'набор можно подобрать, когда этот день наступит' : 'за этот день набор не выбирали'}</p>}
    {day.error && <div className="light-workout-error" role="alert"><p>{day.error}</p><button className="tracking-text-button" type="button" disabled={saving || day.loading} onClick={() => setRefresh(value => value + 1)}>повторить загрузку набора</button></div>}
  </section>;
}
