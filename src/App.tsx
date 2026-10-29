import { useCallback, useEffect, useState } from 'react';
import { telegram } from './telegram';
import { Calendar } from './Calendar';
import { Today, type Activity } from './Today';
import { Home } from './Home';
import { FormIndex } from './FormIndex';

type Account = { id: number; first_name: string; username?: string };
type AuthSource = 'telegram' | 'local';
type AuthState =
  | { status: 'preview' }
  | { status: 'loading'; source: AuthSource }
  | { status: 'authenticated'; source: AuthSource; account: Account }
  | { status: 'error'; source: AuthSource; message: string; sessionExpired: boolean };

export function App() {
  const [auth, setAuth] = useState<AuthState>(() => ({ status: 'loading', source: telegram?.initData ? 'telegram' : 'local' }));
  const [authAttempt, setAuthAttempt] = useState(0);
  const [activities, setActivities] = useState<Record<string, Activity>>({});
  const [activityRevision, setActivityRevision] = useState(0);
  const [measurementRevision, setMeasurementRevision] = useState(0);
  const [planRevision, setPlanRevision] = useState(0);
  const planChanged = useCallback(() => setPlanRevision(value => value + 1), []);
  const configurationChanged = useCallback(() => {
    setActivities({}); setActivityRevision(value => value + 1);
  }, []);
  const measurementChanged = useCallback(() => setMeasurementRevision((value) => value + 1), []);
  const updateActivity = useCallback((activity: Activity) => {
    setActivities((current) => ({ ...current, [activity.date]: activity }));
    setActivityRevision((value) => value + 1);
  }, []);
  const loadActivities = useCallback((loaded: Activity[]) => {
    setActivities((current) => ({ ...current, ...Object.fromEntries(loaded.map((activity) => [activity.date, activity])) }));
  }, []);
  const authenticated = auth.status === 'authenticated';
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [tab, setTab] = useState<'home' | 'calendar' | 'today' | 'formIndex'>('home');

  useEffect(() => {
    const source: AuthSource = telegram?.initData ? 'telegram' : 'local';
    const controller = new AbortController();
    let disposed = false;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 12_000);
    setAuth({ status: 'loading', source });
    fetch(source === 'telegram' ? '/api/auth' : '/api/local/session', {
      ...(source === 'telegram' ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: telegram?.initData }),
      } : {}),
      credentials: 'same-origin',
      signal: controller.signal,
    }).then(async (res) => {
      if (disposed) return;
      if (source === 'local' && res.status === 404) {
        setAuth({ status: 'preview' });
        return;
      }
      if (source === 'telegram' && res.status === 401) {
        setAuth({ status: 'error', source, sessionExpired: true, message: 'Сессия Telegram истекла или недействительна.' });
        return;
      }
      if (!res.ok) throw new Error('Authentication unavailable');
      const data = await res.json() as { user?: Account; mode?: string };
      if ((source === 'local' && data.mode !== 'local') || !data.user || !Number.isSafeInteger(data.user.id) || data.user.id <= 0 || typeof data.user.first_name !== 'string') {
        throw new Error('Invalid account response');
      }
      if (!disposed && !controller.signal.aborted) setAuth({ status: 'authenticated', source, account: data.user });
    }).catch(() => {
      if (!disposed) setAuth({
        status: 'error', source, sessionExpired: false,
        message: source === 'local'
          ? timedOut ? 'Локальное приложение не ответило вовремя. Убедись, что оно запущено, и попробуй еще раз.'
            : 'Не удалось открыть локальный аккаунт. Убедись, что приложение запущено, и попробуй еще раз.'
          : timedOut ? 'Сервер не ответил вовремя. Проверь подключение к интернету и повтори вход.'
            : 'Не удалось связаться с приложением. Проверь подключение к интернету и повтори вход.',
      });
    }).finally(() => window.clearTimeout(timeout));
    return () => { disposed = true; window.clearTimeout(timeout); controller.abort(); };
  }, [authAttempt]);

  if (auth.status === 'loading' || auth.status === 'error') {
    return (
      <main className="app auth-gate">
        <section className={`auth-panel${auth.status === 'error' ? ' auth-panel-error' : ''}`}
          aria-labelledby="auth-title" role={auth.status === 'error' ? 'alert' : 'status'}>
          {auth.status === 'loading' ? <>
            <div className="auth-loader" aria-hidden="true" />
            <h1 id="auth-title">{auth.source === 'local' ? 'Открываем локальный аккаунт' : 'Входим через Telegram'}</h1>
            <p>{auth.source === 'local' ? 'Загружаем профиль и сохраненные показатели с этого компьютера.' : 'Проверяем аккаунт. Личные показатели пока не загружены.'}</p>
          </> : <>
            <span className="auth-error-mark" aria-hidden="true">!</span>
            <h1 id="auth-title">Не удалось открыть личные данные</h1>
            <p>{auth.message}</p>
            {auth.sessionExpired && <p className="auth-help">Полностью закрой Mini App и открой его снова кнопкой в чате бота, чтобы обновить вход.</p>}
            <button className="auth-retry" type="button" onClick={() => {
              setAuth({ status: 'loading', source: auth.source });
              setAuthAttempt((value) => value + 1);
            }}>{auth.source === 'local' ? 'Повторить' : 'Повторить вход'}</button>
          </>}
        </section>
      </main>
    );
  }

  return (
    <main className="app">
      {auth.status === 'preview' ? <aside className="preview-notice">
        <strong>Режим просмотра</strong>
        <p>Личные данные доступны при открытии приложения через Telegram.</p>
      </aside> : null}
      <div hidden={tab !== 'home'}><Home authenticated={authenticated} active={tab === 'home'} measurementRevision={measurementRevision} onMeasurementChange={measurementChanged}
        activityRevision={activityRevision + planRevision} onPlanChange={planChanged} /></div>
      <div hidden={tab !== 'calendar'}><Calendar authenticated={authenticated} active={tab === 'calendar'}
        activities={activities} activityRevision={activityRevision} onLoaded={loadActivities}
        onSelectDate={(date) => { setSelectedDate(date); setTab('today'); }} /></div>
      <div hidden={tab !== 'today'}><Today authenticated={authenticated} active={tab === 'today'} selectedDate={selectedDate} onActivityChange={updateActivity} measurementRevision={measurementRevision} onMeasurementChange={measurementChanged}
        onConfigurationChange={configurationChanged} onSelectToday={() => setSelectedDate(null)} /></div>
      <div hidden={tab !== 'formIndex'}><FormIndex authenticated={authenticated} active={tab === 'formIndex'} activityRevision={activityRevision} activities={activities} onLoaded={loadActivities} measurementRevision={measurementRevision}
        planRevision={planRevision} onPlanChange={planChanged} /></div>
      <nav className="bottom-nav" aria-label="Разделы приложения">
        <button type="button" aria-current={tab === 'home' ? 'page' : undefined} onClick={() => setTab('home')}>
          <span className="nav-number" aria-hidden="true">01</span>
          <span>состояние</span>
        </button>
        <button type="button" aria-current={tab === 'calendar' ? 'page' : undefined} onClick={() => setTab('calendar')}>
          <span className="nav-number" aria-hidden="true">02</span>
          <span>календарь</span>
        </button>
        <button type="button" aria-current={tab === 'today' ? 'page' : undefined} onClick={() => setTab('today')}>
          <span className="nav-number" aria-hidden="true">03</span>
          <span>отметки</span>
        </button>
        <button type="button" aria-current={tab === 'formIndex' ? 'page' : undefined} onClick={() => setTab('formIndex')}>
          <span className="nav-number" aria-hidden="true">04</span>
          <span>индекс</span>
        </button>
      </nav>
    </main>
  );
}
