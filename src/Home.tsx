import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { telegram } from './telegram';
import { waitForActivitySaves } from './Today';
import { MonthlyPlan } from './MonthlyPlan';
import { normalizeMeasurementInput, parseMeasurementInput } from './measurement-input';

type Profile = { currentFat: number | null; targetFat: number | null; currentWeight: number | null; targetWeight: number | null; startWeight: number | null };
type Dashboard = { profile: Profile; progress: number | null; measurementDate?: string; progressMeasurementDate?: string | null; month: string; workouts: { training: number; microTraining: number; total: number; goal: number | null; progress: number | null } };
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const number = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const normalizeInput = (event: ChangeEvent<HTMLInputElement>) => { event.currentTarget.value = normalizeMeasurementInput(event.currentTarget.value); };

async function dashboardRequest(options?: RequestInit, path = '/api/dashboard'): Promise<Dashboard> {
  const res = await fetch(`${path}?timezone=${encodeURIComponent(timezone)}`, {
    ...options, headers: { 'Content-Type': 'application/json', Authorization: `tma ${telegram?.initData ?? ''}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Не удалось загрузить данные.');
  return data;
}

export function Home({ authenticated, active, measurementRevision = 0, onMeasurementChange, activityRevision = 0, onPlanChange }: { authenticated: boolean; active: boolean; measurementRevision?: number; onMeasurementChange?: () => void; activityRevision?: number; onPlanChange?: () => void }) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const revision = useRef(0);
  const [day, setDay] = useState(() => new Date().toDateString());

  useEffect(() => { setEditing(false); }, [day]);

  useEffect(() => {
    const update = () => setDay(new Date().toDateString());
    const timer = window.setInterval(update, 30_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') { update(); setRefresh((value) => value + 1); }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  useEffect(() => {
    if (!authenticated || !active || saving) return;
    const controller = new AbortController();
    const requestedRevision = revision.current;
    setLoading(true);
    const timeout = window.setTimeout(() => {
      if (requestedRevision === revision.current) {
        setLoadError('Не удалось загрузить показатели. Проверь подключение и попробуй еще раз.');
        setLoading(false);
      }
      controller.abort();
    }, 15_000);
    waitForActivitySaves().then(() => dashboardRequest({ signal: controller.signal }))
      .then((value) => {
        if (!controller.signal.aborted && requestedRevision === revision.current) {
          setData(value);
          setLoadError('');
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted && requestedRevision === revision.current) {
          setLoadError(err instanceof Error ? err.message : 'Не удалось загрузить данные.');
        }
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (!controller.signal.aborted && requestedRevision === revision.current) setLoading(false);
      });
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [authenticated, refresh, day, active, saving, measurementRevision]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let values: Pick<Profile, 'currentFat' | 'targetFat' | 'currentWeight' | 'targetWeight'>;
    try {
      const value = (key: string, min: number, max: number) => parseMeasurementInput(String(form.get(key) ?? ''), min, max);
      values = {
        currentFat: value('currentFat', 1, 70), targetFat: value('targetFat', 1, 70),
        currentWeight: value('currentWeight', 20, 400), targetWeight: value('targetWeight', 20, 400),
      };
    } catch (err) { setError(err instanceof Error ? err.message : 'проверь значения замера'); return; }
    revision.current++;
    setSaving(true);
    setError('');
    try {
      setData(await dashboardRequest({ method: 'PATCH', body: JSON.stringify(values) }));
      setEditing(false);
      onMeasurementChange?.();
    } catch (err) { setError(err instanceof Error ? err.message : 'Не удалось сохранить данные.'); }
    finally { setSaving(false); }
  }

  const currentDate = new Date(day);
  const currentDateKey = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;
  const currentData = data && (!data.measurementDate || data.measurementDate === currentDateKey) ? data : null;
  const p = currentData?.profile;
  const remaining = p?.currentWeight != null && p.targetWeight != null
    ? p.currentWeight === p.targetWeight || (p.startWeight != null && p.startWeight !== p.targetWeight
      && (p.currentWeight - p.targetWeight) * (p.startWeight - p.targetWeight) < 0)
      ? 0 : Math.abs(p.currentWeight - p.targetWeight)
    : null;
  const heading = <>
    <header className="home-header">
      <div><p className="eyebrow">ежедневные наблюдения</p>
        <h1 id="home-title">состояние</h1>
      </div>
      <button className="edit-profile" disabled={!authenticated || !currentData} onClick={() => setEditing(!editing)}>{editing ? 'закрыть' : currentData && p?.currentWeight == null && p?.currentFat == null ? 'записать' : 'изменить'}</button>
    </header>
    <div className="edition-line"><span>личный архив</span>
      <time dateTime={currentDateKey}>{currentDate.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })}</time>
    </div>
  </>;

  if (authenticated && !currentData) {
    return (
      <section className="home" aria-labelledby="home-title">
        {heading}
        {loadError ? <div className="activity-error" role="alert">
          <p>Сохраненные показатели пока не удалось загрузить.</p>
          <p>{loadError}</p>
          <button className="retry-button" disabled={loading} onClick={() => { setLoadError(''); setRefresh((value) => value + 1); }}>
            Повторить загрузку
          </button>
        </div> : <p className="activity-status" role="status">Загружаем сохраненные показатели…</p>}
      </section>
    );
  }

  return (
    <section className="home" aria-labelledby="home-title">
      {heading}
      {editing && data && <form className="profile-form" onSubmit={(event) => void save(event)}>
        <h2>Мои показатели</h2>
        <fieldset disabled={saving}><div className="profile-fields">
          {(['currentFat', 'targetFat'] as const).map((key) => <label key={key}>{key === 'currentFat' ? 'процент жира за сегодня' : 'целевой процент жира'}
            <input name={key} type="text" inputMode="decimal" onChange={normalizeInput}
              defaultValue={p?.[key] ?? ''} placeholder="Не указан" /></label>)}
          <label>вес за сегодня, кг<input name="currentWeight" type="text" inputMode="decimal" onChange={normalizeInput} defaultValue={p?.currentWeight ?? ''} placeholder="Не указан" /></label>
          <label>Целевой вес, кг<input name="targetWeight" type="text" inputMode="decimal" onChange={normalizeInput} defaultValue={p?.targetWeight ?? ''} placeholder="Не указан" /></label>
        </div><p className="form-hint">При смене цели прогресс начнется от текущего веса.</p>
          <button className="save-profile" type="submit">Сохранить</button>
        </fieldset>
      </form>}
      <div className="figure-card label-sheet">
        <div className="label-heading"><h2><span className="card-index">01</span>состав тела</h2><span>процент жира</span></div>
        <div className="composition-values">
          <div className="figure-data"><span>сегодня</span><strong className="fat-value" aria-label={p?.currentFat == null ? 'процент жира за сегодня не записан' : undefined}>{p?.currentFat == null ? null : <>{number(p.currentFat)}<span>%</span></>}</strong>
            {data && p?.currentFat == null && <small className="daily-measurement-reminder">запиши процент жира на сегодня</small>}
          </div>
          <div className="figure-target"><span>цель</span><strong className="fat-target">{number(p?.targetFat)}<span>%</span></strong></div>
        </div>
      </div>

      <div className="weight-card">
        <div className="section-heading"><h2><span className="card-index">02</span>вес и цель</h2><span>кг</span></div>
        <div className="weight-values"><div><span>сегодня</span><strong aria-label={p?.currentWeight == null ? 'вес за сегодня не записан' : undefined}>{p?.currentWeight == null ? null : number(p.currentWeight)}</strong>
          {data && p?.currentWeight == null && <small className="daily-measurement-reminder">запиши вес на сегодня</small>}
        </div>
          <span className="weight-arrow" aria-hidden="true">→</span><div><span>Цель</span><strong>{number(p?.targetWeight)}</strong></div></div>
        <div className="progress-caption"><span>{p?.currentWeight == null && data?.progress != null ? 'прогресс по последнему замеру' : 'прогресс к цели'}</span><strong>{data?.progress == null ? '—' : `${data.progress}%`}</strong></div>
        <progress className="weight-progress" max="100" value={data?.progress ?? 0} aria-label="Прогресс к цели по весу" />
        {data && remaining !== null && <p className="progress-note">{remaining < 0.05 ? 'целевой вес достигнут.' : `до цели ${number(Math.round(remaining * 10) / 10)} кг`}</p>}
        {p?.startWeight != null && <p className="progress-baseline">Старт {number(p.startWeight)} кг</p>}
      </div>

      <MonthlyPlan authenticated={authenticated} active={active} activityRevision={activityRevision} onChanged={onPlanChange} />

      {!authenticated && !telegram?.initData && <p className="activity-status">Открой приложение через Telegram, чтобы загрузить свои показатели.</p>}
      {(error || loadError) && <div className="activity-error" role="alert"><p>{error || loadError}</p>{!editing && <button className="retry-button" disabled={loading || saving} onClick={() => { setError(''); setLoadError(''); setRefresh((v) => v + 1); }}>Повторить</button>}</div>}
    </section>
  );
}
