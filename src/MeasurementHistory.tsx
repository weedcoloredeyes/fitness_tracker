import { useEffect, useMemo, useState } from 'react';
import { telegram } from './telegram';

type Measurement = { date: string; currentWeight: number | null; currentFat: number | null };
type History = { measurements: Measurement[]; legacyMeasurement: { currentWeight: number | null; currentFat: number | null } | null };
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const format = (value: number | null) => value === null ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const dayTime = (date: string) => Date.parse(date + 'T12:00:00Z');
const shortDate = (date: string) => new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
const fullDate = (date: string) => new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'не удалось загрузить историю').replace(/\u0451/gi, 'е').toLocaleLowerCase('ru-RU');

function numbers(row: Record<string, unknown>) {
  return ['currentWeight', 'currentFat'].every((key) => row[key] === null || typeof row[key] === 'number' && Number.isFinite(row[key]));
}

function readHistory(value: unknown): History {
  if (!value || typeof value !== 'object' || !('measurements' in value) || !Array.isArray(value.measurements) || !('legacyMeasurement' in value)) {
    throw new Error('не удалось прочитать историю замеров');
  }
  const seen = new Set<string>();
  const measurements = value.measurements.map((row: unknown): Measurement => {
    if (!row || typeof row !== 'object' || !('date' in row) || typeof row.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(dayTime(row.date)) ||
        new Date(dayTime(row.date)).toISOString().slice(0, 10) !== row.date || seen.has(row.date) || !numbers(row as Record<string, unknown>)) {
      throw new Error('не удалось прочитать историю замеров');
    }
    seen.add(row.date);
    const item = row as Measurement;
    return { date: item.date, currentWeight: item.currentWeight, currentFat: item.currentFat };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const legacy = value.legacyMeasurement;
  if (legacy !== null && (!legacy || typeof legacy !== 'object' || !numbers(legacy as Record<string, unknown>))) {
    throw new Error('не удалось прочитать прежний замер');
  }
  return { measurements, legacyMeasurement: legacy === null ? null : {
    currentWeight: (legacy as Measurement).currentWeight, currentFat: (legacy as Measurement).currentFat,
  } };
}

// Each point represents an actual dated weight. Gaps are never joined into an invented daily trajectory.
export function buildWeightPlot(measurements: Measurement[]) {
  const weights = measurements.filter((row): row is Measurement & { currentWeight: number } => row.currentWeight !== null);
  if (!weights.length) return null;
  const firstTime = dayTime(weights[0].date);
  const lastTime = dayTime(weights[weights.length - 1].date);
  const min = weights.reduce((result, row) => Math.min(result, row.currentWeight), Infinity);
  const max = weights.reduce((result, row) => Math.max(result, row.currentWeight), -Infinity);
  const span = max - min;
  const margin = span === 0 ? .5 : span * .15;
  const low = min - margin;
  const high = max + margin;
  const points = weights.map((row) => ({
    ...row,
    x: firstTime === lastTime ? 177 : 42 + (dayTime(row.date) - firstTime) / (lastTime - firstTime) * 270,
    y: 18 + (high - row.currentWeight) / (high - low) * 112,
  }));
  const path = points.map((point, index) => {
    const previous = points[index - 1];
    const connected = previous && dayTime(point.date) - dayTime(previous.date) === 86_400_000;
    return `${connected ? 'L' : 'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  }).join(' ');
  return { points, path, min, max, minY: 18 + (high - min) / (high - low) * 112, maxY: 18 + (high - max) / (high - low) * 112 };
}

export function MeasurementHistory({ authenticated, active, measurementRevision }: { authenticated: boolean; active: boolean; measurementRevision: number }) {
  const [data, setData] = useState<History | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') setRefresh((value) => value + 1); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, []);

  useEffect(() => {
    if (!authenticated || !active) return;
    const controller = new AbortController();
    setLoading(true);
    const timeout = window.setTimeout(() => {
      if (!controller.signal.aborted) {
        setError('история не ответила вовремя. попробуй еще раз');
        setLoading(false);
      }
      controller.abort();
    }, 12_000);
    fetch(`/api/measurement-history?${new URLSearchParams({ timezone })}`, {
      credentials: 'same-origin', headers: { Authorization: `tma ${telegram?.initData ?? ''}` }, signal: controller.signal,
    }).then(async (response) => {
      const value = await response.json();
      if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : 'не удалось загрузить историю');
      return readHistory(value);
    }).then((value) => {
      if (!controller.signal.aborted) { setData(value); setError(''); }
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(err));
    }).finally(() => {
      window.clearTimeout(timeout);
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [authenticated, active, measurementRevision, refresh]);

  const plot = useMemo(() => buildWeightPlot(data?.measurements ?? []), [data]);
  const measurements = data?.measurements ?? [];
  const rows = (expanded ? measurements : measurements.slice(-14)).slice().reverse();
  const legacy = data?.legacyMeasurement;
  const change = plot && plot.points.length > 1 ? plot.points[plot.points.length - 1].currentWeight - plot.points[0].currentWeight : null;

  return <section className="measurement-history" aria-labelledby="measurement-history-title">
    <header className="measurement-history-heading"><h2 id="measurement-history-title">история замеров</h2><p>вес и процент жира по записанным датам</p></header>
    {!authenticated ? <p className="measurement-status">открой приложение через telegram, чтобы увидеть историю</p>
      : !data ? error ? null : <p className="measurement-status" role="status">загружаем историю замеров…</p>
        : <>
          {plot && <>
            <div className="measurement-chart-caption"><span>вес, кг</span>
              {change !== null && <span>изменение: {change > 0 ? '+' : ''}{format(Math.round(change * 10) / 10)} кг</span>}
            </div>
            <svg className="measurement-chart" viewBox="0 0 324 164" role="img" aria-label={`график веса, записей: ${plot.points.length}`}>
              <g className="measurement-chart-axis">
                <line x1="42" y1="130" x2="312" y2="130" />
                {plot.min === plot.max ? <text x="0" y={plot.minY + 3}>{format(plot.min)}</text> : <><text x="0" y={plot.maxY + 3}>{format(plot.max)}</text><text x="0" y={plot.minY + 3}>{format(plot.min)}</text></>}
                {plot.points.length === 1 ? <text x="177" y="157" textAnchor="middle">{shortDate(plot.points[0].date)}</text>
                  : <><text x="42" y="157">{shortDate(plot.points[0].date)}</text><text x="312" y="157" textAnchor="end">{shortDate(plot.points[plot.points.length - 1].date)}</text></>}
              </g>
              <path className="measurement-chart-line" d={plot.path} />
              {plot.points.map((point) => <circle className="measurement-chart-point" key={point.date} cx={point.x} cy={point.y} r="2.8"><title>{fullDate(point.date)}: {format(point.currentWeight)} кг</title></circle>)}
            </svg>
            <p className="measurement-reminder">точки — записанные значения. пропущенные дни не соединяем</p>
          </>}
          {measurements.length ? <>
            <table className="measurement-table"><caption className="sr-only">датированные замеры</caption><thead><tr><th scope="col">дата</th><th scope="col">вес, кг</th><th scope="col">жир, %</th></tr></thead>
              <tbody>{rows.map((row) => <tr key={row.date}><th scope="row"><time dateTime={row.date}>{fullDate(row.date)}</time></th><td>{format(row.currentWeight)}</td><td>{format(row.currentFat)}</td></tr>)}</tbody>
            </table>
            {measurements.length > 14 && <button type="button" className="retry-button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? 'показать последние записи' : `показать все записи (${measurements.length})`}</button>}
          </> : <p className="measurement-status">датированных замеров пока нет. после записи они появятся здесь</p>}
          {legacy && (legacy.currentWeight !== null || legacy.currentFat !== null) && <aside className="legacy-measurement" aria-labelledby="legacy-measurement-title">
            <h3 id="legacy-measurement-title">прежний замер без даты</h3><p className="measurement-reminder">сохранен из прошлой версии. день измерения неизвестен</p>
            <div className="legacy-measurement-values"><div><span>вес</span><strong>{format(legacy.currentWeight)}<small className="unit">кг</small></strong></div>
              <div><span>жир</span><strong>{format(legacy.currentFat)}<small className="unit">%</small></strong></div></div>
          </aside>}
        </>}
    {error && <div className="measurement-error" role="alert"><p>{error}</p><button className="retry-button" type="button" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>повторить загрузку истории</button></div>}
  </section>;
}
