import { useEffect, useRef, useState, type FormEvent } from 'react';
import { waitForActivitySaves } from './Today';
import { trackingRequest, trackingTimezone } from './tracking-api';
import { ACTIVITY_CATEGORIES, type MonthlyTracking } from '../server/tracking-types';

export type { MonthlyTracking } from '../server/tracking-types';
type Draft = { strength: string; cardio: string };
const categories = ['strength', 'cardio'] as const;
const labels = { strength: 'тренировки', cardio: 'кардио' };
type Props = {
  authenticated: boolean; active: boolean; activityRevision?: number; planRevision?: number; onChanged?: () => void;
};
const format = (value: number) => value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const message = (error: unknown) => (error instanceof Error ? error.message : 'не удалось загрузить месячный план').replace(/\u0451/gi, 'е').toLocaleLowerCase('ru-RU');
const localMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};
export const monthLabel = (month: string) => new Date(`${month}-01T12:00:00`).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '').toLocaleLowerCase('ru-RU');
export function shiftMonth(month: string, offset: number) {
  const date = new Date(`${month}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}

function readMonth(value: unknown, expectedMonth: string): MonthlyTracking {
  const result = value && typeof value === 'object' && 'month' in value ? value.month : null;
  if (!result || typeof result !== 'object') throw new Error('не удалось прочитать месячный план');
  const data = result as MonthlyTracking;
  const finite = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
  if (data.month !== expectedMonth || typeof data.start !== 'string' || typeof data.end !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(data.start) || !/^\d{4}-\d{2}-\d{2}$/.test(data.end) ||
      !Array.isArray(data.days) || !(data.score === null || finite(data.score, 100))) throw new Error('не удалось прочитать месячный план');
  if (!data.weights || ACTIVITY_CATEGORIES.some((kind) => !finite(data.weights[kind], 100)) ||
      Math.abs(ACTIVITY_CATEGORIES.reduce((total, kind) => total + data.weights[kind], 0) - 100) > 0.000001) throw new Error('не удалось прочитать месячный план');
  for (const kind of categories) {
    const category = data[kind];
    if (!category || !finite(category.earned, 31.000001) || !Number.isInteger(category.completedDays) || category.completedDays < 0 || category.completedDays > 31 ||
        !(category.goal === null || Number.isInteger(category.goal) && category.goal >= 1 && category.goal <= 1000) ||
        !(category.score === null || finite(category.score, data.weights[kind]))) throw new Error('не удалось прочитать месячный план');
  }
  return data;
}

function useCurrentMonth() {
  const [current, setCurrent] = useState(localMonth);
  useEffect(() => {
    const update = () => setCurrent(localMonth());
    const timer = window.setInterval(update, 30_000);
    document.addEventListener('visibilitychange', update);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, []);
  return current;
}

function MonthlyPanel({ authenticated, active, activityRevision = 0, planRevision = 0, onChanged, index = false }: Props & { index?: boolean }) {
  const currentMonth = useCurrentMonth();
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const month = index ? selectedMonth ?? currentMonth : currentMonth;
  const [cache, setCache] = useState<Record<string, MonthlyTracking>>({});
  const data = cache[month];
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draft = drafts[month];
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const [savedMonth, setSavedMonth] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveController = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const error = errors[month];

  useEffect(() => () => saveController.current?.abort(), []);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') setRefresh((value) => value + 1); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, []);
  useEffect(() => {
    if (!authenticated || !active || saving) return;
    const controller = new AbortController();
    const requestedRevision = revision.current;
    setLoading(true);
    const timeout = window.setTimeout(() => {
      if (!controller.signal.aborted) {
        setErrors((old) => ({ ...old, [month]: 'месячный план не ответил вовремя. попробуй еще раз' }));
        setLoading(false);
      }
      controller.abort();
    }, 12_000);
    waitForActivitySaves().then(() => {
      if (controller.signal.aborted) return null;
      return trackingRequest<unknown>(`/api/tracking/month?${new URLSearchParams({ timezone: trackingTimezone, month })}`, { signal: controller.signal });
    }).then((value) => {
      if (!controller.signal.aborted && requestedRevision === revision.current) {
        const loaded = readMonth(value, month);
        setCache((old) => ({ ...old, [month]: loaded }));
        setErrors((old) => ({ ...old, [month]: '' }));
      }
    }).catch((err: unknown) => {
      if (!controller.signal.aborted && requestedRevision === revision.current) setErrors((old) => ({ ...old, [month]: message(err) }));
    }).finally(() => {
      window.clearTimeout(timeout);
      if (!controller.signal.aborted && requestedRevision === revision.current) setLoading(false);
    });
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [authenticated, active, activityRevision, planRevision, month, refresh, saving]);

  function edit() {
    if (!data) return;
    setDrafts((old) => ({ ...old, [month]: {
      strength: data.strength.goal?.toString() ?? '', cardio: data.cardio.goal?.toString() ?? '',
    } }));
    setSaveErrors((old) => ({ ...old, [month]: '' }));
    setSavedMonth(null);
  }
  function close() {
    setDrafts((old) => { const next = { ...old }; delete next[month]; return next; });
    setSaveErrors((old) => ({ ...old, [month]: '' }));
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || saving) return;
    const goal = (value: string) => value.trim() === '' ? null : Number(value.trim());
    const values = { strength: goal(draft.strength), cardio: goal(draft.cardio) };
    if (Object.values(values).some((value) => value !== null && (!Number.isInteger(value) || value < 1 || value > 1000))) {
      setSaveErrors((old) => ({ ...old, [month]: 'укажи целое число дней от 1 до 1000 или оставь поле пустым' }));
      return;
    }
    revision.current++;
    const controller = new AbortController();
    saveController.current = controller;
    setSaving(true);
    setSaveErrors((old) => ({ ...old, [month]: '' }));
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await trackingRequest<unknown>(`/api/tracking/goals?${new URLSearchParams({ timezone: trackingTimezone, month })}`, {
        method: 'PATCH', body: JSON.stringify(values), signal: controller.signal,
      });
      if (controller.signal.aborted) throw new Error('не удалось подтвердить сохранение. проверь подключение и повтори');
      const saved = readMonth(response, month);
      setCache((old) => ({ ...old, [month]: saved }));
      setErrors((old) => ({ ...old, [month]: '' }));
      close();
      setSavedMonth(month);
      onChanged?.();
    } catch (err) {
      if (saveController.current === controller) setSaveErrors((old) => ({ ...old, [month]: controller.signal.aborted ? 'не удалось подтвердить сохранение. введенные цели сохранены в форме' : message(err) }));
    } finally {
      window.clearTimeout(timeout);
      if (saveController.current === controller) { saveController.current = null; setSaving(false); }
    }
  }

  return <section className={`monthly-plan${index ? ' monthly-plan-index' : ''}`} aria-label={index ? 'месячный индекс нагрузки' : 'месячный план'}>
    {index ? <>
      <header className="today-header monthly-index-heading"><p className="eyebrow">нагрузка за календарный месяц</p><h1 id="form-index-title">месячный индекс</h1></header>
      <nav className="monthly-navigation" aria-label="месяц индекса">
        <button type="button" aria-label="предыдущий месяц" disabled={saving || month <= '0001-01'} onClick={() => setSelectedMonth(shiftMonth(month, -1))}>←</button>
        <span aria-live="polite">{monthLabel(month)}</span>
        <button type="button" aria-label="следующий месяц" disabled={saving || month >= currentMonth} onClick={() => setSelectedMonth(shiftMonth(month, 1))}>→</button>
      </nav>
      {month !== currentMonth && <button className="monthly-current retry-button" type="button" disabled={saving} onClick={() => setSelectedMonth(null)}>текущий месяц</button>}
    </> : <header className="monthly-plan-heading"><h2><span className="card-index">03</span>план на месяц</h2><span>{monthLabel(month)}</span></header>}
    {!authenticated ? <p className="monthly-status">открой приложение через telegram, чтобы увидеть месячный план</p>
      : !data ? error ? null : <p className="monthly-status" role="status">загружаем месячный план…</p>
        : <>
          {index && <div className="index-score-card monthly-index-score">
            <div className="index-score" aria-label="месячный индекс из 100">{data.score === null ? '—' : Math.round(data.score)}<span>/ 100</span></div>
            {data.score !== null ? <progress className="weight-progress index-progress" max="100" value={data.score} aria-label="месячный индекс нагрузки" />
              : <p className="monthly-status monthly-goals-needed">задай обе цели, чтобы рассчитать индекс</p>}
          </div>}
          <div className="monthly-categories">
            {categories.map((category) => {
              const progress = data[category];
              const label = labels[category];
              const max = data.weights[category];
              return <section key={category} className={`monthly-category monthly-${category}`} aria-label={label}>
                <div className="monthly-category-heading"><h3>{label}</h3>{index && <span>{progress.score === null ? '—' : format(progress.score)} / {format(max)}</span>}</div>
                <div className="monthly-category-total"><strong>{format(progress.earned)}</strong><span>{progress.goal === null ? 'цель не задана' : `/ ${progress.goal}`}</span></div>
                <p className="monthly-category-unit">дней плана</p>
                {progress.score !== null && <progress className="weight-progress monthly-category-progress" max={max} value={progress.score} aria-label={`выполнение плана: ${label}`} />}
              </section>;
            })}
          </div>
          <p className="monthly-rule">легкая тренировка — половина основной; вместе за день — максимум один день плана</p>
          {!draft && <button className="edit-profile monthly-edit" type="button" disabled={saving} onClick={edit}>{categories.every((category) => data[category].goal === null) ? 'задать цели' : 'изменить цели'}</button>}
          {draft && <form className="monthly-goals-form" onSubmit={(event) => void save(event)} aria-label="цели на месяц">
            <fieldset disabled={saving}><legend>цели на {monthLabel(month)}</legend>
              <div className="monthly-goal-fields">{categories.map((category) => <label key={category}>
                {category === 'strength' ? 'дни тренировок' : 'дни кардио'}
                <input name={category} type="number" min="1" max="1000" step="1" inputMode="numeric" placeholder="не задана" value={draft[category]}
                  onChange={(event) => setDrafts((old) => ({ ...old, [month]: { ...old[month], [category]: event.target.value } }))} />
              </label>)}</div>
              <p className="monthly-rule">пустое поле убирает цель. цели сохраняются отдельно для каждого календарного месяца</p>
              <div className="monthly-actions"><button className="save-profile" type="submit">{saving ? 'сохраняем…' : 'сохранить цели'}</button><button className="retry-button" type="button" onClick={close}>отмена</button></div>
            </fieldset>
          </form>}
          {savedMonth === month && !draft && <p className="monthly-status" role="status">цели сохранены</p>}
        </>}
    {(error || saveErrors[month]) && <div className="monthly-error" role="alert"><p>{saveErrors[month] || error}</p>
      {error && <button className="retry-button" type="button" disabled={loading || saving} onClick={() => setRefresh((value) => value + 1)}>повторить загрузку плана</button>}
    </div>}
  </section>;
}

export function MonthlyPlan(props: Props) { return <MonthlyPanel {...props} />; }
export function MonthlyIndex(props: Props) { return <MonthlyPanel {...props} index />; }
