import { useEffect, useState } from 'react';
import { telegram } from './telegram';
import { trackingTimezone } from './tracking-api';
import { waitForActivitySaves, type Activity } from './Today';
import { ACTIVITY_CATEGORIES, ACTIVITY_LABELS, type ActivityCategory } from '../server/tracking-types';
import { cardioPatternForDate } from './calendar-cardio-patterns';

const weekdays = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function ActivityMarks({ date, strength = 0, light = 0, cardio = 0 }: { date: string; strength?: number; light?: number; cardio?: number }) {
  const partialCardio = cardio < 1;
  const path = cardioPatternForDate(date);
  return <>
    {strength > 0 && <span className="calendar-main-fill" style={{ height: `${strength * 100}%` }} aria-hidden="true" />}
    {strength === 0 && light > 0 && <span className="calendar-light-tone"
      style={{ opacity: .34 * light }} aria-hidden="true" />}
    {cardio > 0 && <svg className="calendar-cardio-circle" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <path className="calendar-cardio-halo" d={path} />
      {partialCardio && <path className="calendar-cardio-track" d={path} />}
      <path className="calendar-cardio-ink" d={path} pathLength="100"
        strokeDasharray={partialCardio ? `${cardio * 100} 100` : undefined} />
    </svg>}
  </>;
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
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'не удалось загрузить отметки.');
    });
    return () => controller.abort();
  }, [authenticated, active, rangeStart, rangeEnd, activityRevision, onLoaded, retry]);

  return (
    <section className="calendar" aria-labelledby="calendar-title">
      <header className="calendar-header">
        <h1 id="calendar-title">календарь</h1>
        <span className="calendar-period">
          {weeks[0][0].toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} — {weeks[11][6].toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }).replace(' г.', '')}
        </span>
      </header>
      <nav className="calendar-navigation" aria-label="период календаря">
        <button type="button" aria-label="предыдущие 12 недель" onClick={() => setWeekOffset((value) => value - 12)}>←</button>
        <button type="button" disabled={weekOffset === 0} onClick={() => setWeekOffset(0)}>сегодня</button>
        <button type="button" aria-label="следующие 12 недель" onClick={() => setWeekOffset((value) => value + 12)}>→</button>
      </nav>
      <table className="calendar-grid" aria-label="календарь на 12 недель">
        <thead>
          <tr>
            <th className="week-heading" scope="col"><span className="sr-only">неделя</span></th>
            {weekdays.map((day) => <th key={day} scope="col">{day}</th>)}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, index) => (
            <tr key={dateKey(week[0])}>
              <th className="week-number" scope="row"><span className="sr-only">неделя </span>{index + 1}</th>
              {week.map((date, day) => {
                const activity = activities[dateKey(date)];
                const labels = activity?.definitions.filter(item => activity.completedIds.includes(item.id)).map(item => item.name) ?? [];
                const isToday = dateKey(date) === dateKey(today);
                const isFuture = dateKey(date) > dateKey(today);
                const showMonth = date.getDate() === 1 || (index === 0 && day === 0);
                const strength = Math.max(0, Math.min(1, activity?.strengthFraction ?? 0));
                const light = Math.max(0, Math.min(1, activity?.lightFraction ?? 0));
                const cardio = Math.max(0, Math.min(1, activity?.cardioFraction ?? 0));
                const hasMarks = strength > 0 || light > 0 || cardio > 0;
                const categoryLabel = (category: ActivityCategory) => {
                  const definitions = activity?.definitions.filter(item => item.category === category) ?? [];
                  const completed = definitions.filter(item => activity?.completedIds.includes(item.id)).length;
                  return completed ? `, ${ACTIVITY_LABELS[category]} ${completed} из ${definitions.length}` : '';
                };
                return (
                  <td key={dateKey(date)}>
                    <button type="button" onClick={() => onSelectDate(dateKey(date))} className={`calendar-day${isToday ? ' calendar-day-today' : ''}${isFuture ? ' calendar-day-future' : ''}${hasMarks ? ' calendar-day-has-marks' : ''}${strength >= .5 ? ' calendar-day-dark' : ''}${strength === 1 ? ' calendar-day-main-full' : ''}${strength === 0 && light > 0 ? ' calendar-day-light-only' : ''}`}
                      aria-current={isToday ? 'date' : undefined}
                      aria-label={`${date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}${isToday ? ', сегодня' : ''}${labels.length ? ', выполнено: ' + labels.join(', ') : ''}${ACTIVITY_CATEGORIES.map(categoryLabel).join('')}`}>
                      <ActivityMarks date={dateKey(date)} strength={strength} light={light} cardio={cardio} />
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
      <div className="calendar-legend" aria-label="обозначения отметок">
        <span><span className="calendar-key calendar-day-dark calendar-day-main-full" aria-hidden="true"><ActivityMarks date="legend-main" strength={1} /><span className="day-number">12</span></span>основная тренировка</span>
        <span><span className="calendar-key calendar-day-light-only" aria-hidden="true"><ActivityMarks date="legend-light" light={1} /><span className="day-number">12</span></span>легкая тренировка</span>
        <span><span className="calendar-key" aria-hidden="true"><ActivityMarks date="legend-cardio" cardio={1} /><span className="day-number">12</span></span>кардио</span>
        <span><span className="calendar-key calendar-key-today" aria-hidden="true"><span className="day-number">12</span></span>сегодня</span>
      </div>
      <p className="calendar-marks-note">неполное выполнение — частичная заливка, более светлый фон или незамкнутый круг</p>
      {error && <div className="activity-error" role="alert"><p>{error}</p>
        <button className="retry-button" onClick={() => setRetry((value) => value + 1)}>повторить</button>
      </div>}
    </section>
  );
}
