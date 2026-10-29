import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ActivityCategory, ActivityDefinition } from '../server/tracking-types';
import { trackingRequest, trackingTimezone } from './tracking-api';
import { enqueueActivitySave, waitForActivitySaves } from './Today';

export function DefinitionsManager({ authenticated, active, onChanged, onBusyChange }: {
  authenticated: boolean; active: boolean; onChanged: () => void; onBusyChange?: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [definitions, setDefinitions] = useState<ActivityDefinition[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<ActivityCategory>('strength');
  const [draftName, setDraftName] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const revision = useRef(0);
  const endpoint = '/api/tracking/definitions?timezone=' + encodeURIComponent(trackingTimezone);

  useEffect(() => {
    if (!open || !active || !authenticated) return;
    const controller = new AbortController();
    const version = revision.current;
    let disposed = false;
    let timeout: number | undefined;
    setError('');
    waitForActivitySaves().then(() => {
      if (disposed) return Promise.reject(new Error('cancelled'));
      timeout = window.setTimeout(() => controller.abort(), 15000);
      return trackingRequest<{ definitions: ActivityDefinition[] }>(endpoint, { signal: controller.signal });
    })
      .then(value => { if (!disposed && !controller.signal.aborted && revision.current === version) { setDefinitions(value.definitions); setError(''); } })
      .catch(() => { if (!disposed && revision.current === version) setError('не удалось загрузить настройки отметок. попробуй еще раз.'); })
      .finally(() => window.clearTimeout(timeout));
    return () => { disposed = true; window.clearTimeout(timeout); controller.abort(); };
  }, [open, active, authenticated, retry, endpoint]);

  async function mutate(method: 'POST' | 'PATCH', input: Record<string, unknown>, success?: () => void) {
    if (busy) return;
    revision.current++;
    setBusy(true); onBusyChange?.(true); setError('');
    try {
      const result = await enqueueActivitySave(async () => {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 20000);
        try { return await trackingRequest<{ definitions: ActivityDefinition[] }>(endpoint, { method, body: JSON.stringify(input), signal: controller.signal }); }
        finally { window.clearTimeout(timeout); }
      });
      setDefinitions(result.definitions); success?.(); onChanged();
    } catch (err) { setError(err instanceof Error && err.name !== 'AbortError' ? err.message : 'сохранение не подтверждено. проверь соединение и повтори.'); }
    finally { setBusy(false); onBusyChange?.(false); }
  }
  function create(event: FormEvent) {
    event.preventDefault();
    void mutate('POST', { name: name.trim(), category }, () => setName(''));
  }

  return <section className="definitions-manager">
    <button type="button" className="tracking-text-button" disabled={!authenticated || busy} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {open ? 'закрыть настройки' : 'настроить отметки'}
    </button>
    {open && <div className="definitions-content">
      <p className="tracking-hint">у каждой категории по 50%. все ее отметки за день дают полный зачет. новый состав действует с сегодняшнего дня; прошлые дни сохраняются.</p>
      {!definitions && !error && <p role="status">загружаем отметки…</p>}
      {definitions?.filter(item => showArchived || !item.archived).map(item => <div className="definition-row" key={item.id}>
        {editing === item.id ? <form onSubmit={event => { event.preventDefault(); void mutate('PATCH', { id: item.id, name: draftName.trim() }, () => setEditing(null)); }}>
          <label className="sr-only" htmlFor={'rename-' + item.id}>новое название отметки</label>
          <input id={'rename-' + item.id} value={draftName} maxLength={80} required disabled={busy} onChange={event => setDraftName(event.target.value)} />
          <div className="tracking-row-actions"><button type="submit" disabled={busy}>сохранить</button><button type="button" disabled={busy} onClick={() => setEditing(null)}>отмена</button></div>
        </form> : <><div><span className="definition-name">{item.name}</span><small>{item.category === 'strength' ? 'физ нагрузка' : 'кардио'}{item.archived ? ' · архив' : ''}</small></div>
          <div className="tracking-row-actions">
            <button type="button" disabled={busy} aria-label={'переименовать ' + item.name} onClick={() => { setEditing(item.id); setDraftName(item.name); }}>имя</button>
            <button type="button" disabled={busy} aria-label={(item.archived ? 'вернуть ' : 'в архив ') + item.name} onClick={() => void mutate('PATCH', { id: item.id, archived: !item.archived })}>{item.archived ? 'вернуть' : 'в архив'}</button>
          </div></>}
      </div>)}
      {!!definitions?.some(item => item.archived) && <button type="button" className="tracking-text-button" onClick={() => setShowArchived(value => !value)}>{showArchived ? 'скрыть архив' : 'показать архив'}</button>}
      {definitions && <form className="definition-create" onSubmit={create}>
        <h3>новая отметка</h3>
        <label>название<input value={name} maxLength={80} required disabled={busy} placeholder="например, велосипед" onChange={event => setName(event.target.value)} /></label>
        <label>категория<select value={category} disabled={busy} onChange={event => setCategory(event.target.value as ActivityCategory)}>
          <option value="strength">физ нагрузка · 50%</option><option value="cardio">кардио · 50%</option>
        </select></label>
        <button type="submit" className="save-profile" disabled={busy || !name.trim()}>{busy ? 'сохраняем…' : 'добавить отметку'}</button>
      </form>}
      {error && <div className="activity-error" role="alert"><p>{error}</p>{!definitions && <button type="button" disabled={busy} onClick={() => setRetry(value => value + 1)}>повторить загрузку</button>}</div>}
    </div>}
  </section>;
}
