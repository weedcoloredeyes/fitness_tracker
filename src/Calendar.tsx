import { useEffect, useState } from 'react';
import { telegram } from './telegram';
import { trackingTimezone } from './tracking-api';
import { waitForActivitySaves, type Activity } from './Today';

const weekdays = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function CardioContour({ fraction = 1 }: { fraction?: number }) {
  return <svg className="calendar-cardio-contour" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <path d="M16 3.5C23.5 2.5 29 8.3 28.5 15.7C29.3 23 23.5 29.1 16.1 28.4C8.3 29.2 3 23 3.6 16C2.8 8.5 8.6 3 16 3.5Z"
      pathLength="100" strokeDasharray={fraction < 1 ? `${Math.max(0, fraction) * 100} 100` : undefined} />
  </svg>;
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function Calendar({ onSelectDate, authenticated, active, activities, activityRevision, onLoaded }: {
  onSelectDate: (date: string) => void;
  authenticated: boolean;
  active: boolean;
  activities: Record<string, Activity>;
  activityRevision: number;
  onLoaded: (activities: Activity[]) => void;
}) {
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [today, setToday] = useState(() => new Date());
  const [weekOffset, setWeekOffset] = useState(0);

  useEffect(() => {
    const update = () => setToday(new Date());
    const timer = window.setInterval(update, 60_000);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  start.setDate(start.getDate() - (start.getDay() + 6) % 7 + weekOffset * 7);
  const weeks = Array.from({ length: 12 }, (_, week) => (
    Array.from({ length: 7 }, (_, day) => {
      const date = new Date(start);
      date.setDate(start.getDate() + week * 7 + day);
      return date;
    })
  ));

  const rangeStart = dateKey(weeks[0][0]);
  const rangeEnd = dateKey(weeks[11][6]);
  useEffect(() => {
    if (!authenticated) return;
    const controller = new AbortController();
    waitForActivitySaves().then(async () => {
      const response = await fetch(`/api/tracking/calendar?start=${rangeStart}&end=${rangeEnd}&timezone=${encodeURIComponent(trackingTimezone)}`, {
        headers: { Authorization: `tma ${telegram?.initData ?? ''}` }, signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (!controller.signal.aborted) { onLoaded(data.days); setError(''); }
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Не удалось загрузить отметки.');
    });
    return () => controller.abort();
  }, [authenticated, active, rangeStart, rangeEnd, activityRevision, onLoaded, retry]);

  return (
    <section className="calendar" aria-labelledby="calendar-title">
      <header className="calendar-header">
        <h1 id="calendar-title">Календарь</h1>
        <span className="calendar-period">
          {weeks[0][0].toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} — {weeks[11][6].toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }).replace(' г.', '')}
        </span>
      </header>
      <nav className="calendar-navigation" aria-label="период календаря">
        <button type="button" aria-label="предыдущие 12 недель" onClick={() => setWeekOffset((value) => value - 12)}>←</button>
        <button type="button" disabled={weekOffset === 0} onClick={() => setWeekOffset(0)}>сегодня</button>
        <button type="button" aria-label="следующие 12 недель" onClick={() => setWeekOffset((value) => value + 12)}>→</button>
      </nav>
      <table className="calendar-grid" aria-label="Календарь на 12 недель">
        <thead>
          <tr>
            <th className="week-heading" scope="col"><span className="sr-only">Неделя</span></th>
            {weekdays.map((day) => <th key={day} scope="col">{day}</th>)}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, index) => (
            <tr key={dateKey(week[0])}>
              <th className="week-number" scope="row"><span className="sr-only">Неделя </span>{index + 1}</th>
              {week.map((date, day) => {
                const activity = activities[dateKey(date)];
                const labels = activity?.definitions.filter(item => activity.completedIds.includes(item.id)).map(item => item.name) ?? [];
                const isToday = dateKey(date) === dateKey(today);
                const showMonth = date.getDate() === 1 || (index === 0 && day === 0);
                const strength = Math.max(0, Math.min(1, activity?.strengthFraction ?? 0));
                const cardio = Math.max(0, Math.min(1, activity?.cardioFraction ?? 0));
                const partialStrength = strength > 0 && strength < 1;
                const categoryLabel = (category: 'strength' | 'cardio') => {
                  const definitions = activity?.definitions.filter(item => item.category === category) ?? [];
                  const completed = definitions.filter(item => activity?.completedIds.includes(item.id)).length;
                  return completed ? `, ${category === 'strength' ? 'физ нагрузка' : 'кардио'} ${completed} из ${definitions.length}` : '';
                };
                return (
                  <td key={dateKey(date)}>
                    <button type="button" onClick={() => onSelectDate(dateKey(date))} className={`calendar-day${isToday ? ' calendar-day-today' : ''}${strength === 1 ? ' calendar-day-strength-full' : ''}${partialStrength ? ' calendar-day-strength-partial' : ''}`}
                      aria-current={isToday ? 'date' : undefined}
                      aria-label={`${date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}${isToday ? ', сегодня' : ''}${labels.length ? ', выполнено: ' + labels.join(', ') : ''}${categoryLabel('strength')}${categoryLabel('cardio')}`}>
                      {partialStrength && <span className="calendar-strength-shading" style={{ height: `${strength * 100}%` }} aria-hidden="true" />}
                      {cardio > 0 && <CardioContour fraction={cardio} />}
                      {showMonth && <span className="day-month" aria-hidden="true">{months[date.getMonth()]}</span>}
                      <span className="day-number" aria-hidden="true">{date.getDate()}</span>
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="calendar-legend" aria-label="Обозначения отметок">
        <span><span className="calendar-key calendar-key-strength" aria-hidden="true" />физ нагрузка</span>
        <span><span className="calendar-key calendar-key-cardio" aria-hidden="true"><CardioContour /></span>кардио</span>
        <span><span className="calendar-key calendar-key-today" aria-hidden="true" />сегодня</span>
      </div>
      <p className="calendar-marks-note">штриховка и незамкнутый контур — часть отметок категории</p>
      {error && <div className="activity-error" role="alert"><p>{error}</p>
        <button className="retry-button" onClick={() => setRetry((value) => value + 1)}>Повторить</button>
      </div>}
    </section>
  );
}
