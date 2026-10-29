import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { verifyInitData } from './auth';
import { Users } from './users';
import { todayInTimezone, validateActivityDate } from './activity';
import { validateProfile } from './profile';
import { validateMeasurement } from './measurements';

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64_000) throw new Error('Body too large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

type AppOptions = { local?: { userId: number; origin: string }; legacyActivityWrites?: 'reject' };

export function createApp(token: string, users: Users, root = resolve('dist'), options: AppOptions = {}) {
  const local = options.local;
  const localAccount = local ? users.list().find((user) => user.id === local.userId) : undefined;
  let localOrigin: URL | undefined;
  if (local) {
    if (!Number.isSafeInteger(local.userId) || local.userId <= 0 || !localAccount) {
      throw new Error('LOCAL_USER_ID должен указывать на существующего пользователя в базе.');
    }
    localOrigin = new URL(local.origin);
    if (localOrigin.protocol !== 'http:' || localOrigin.hostname !== '127.0.0.1' ||
        localOrigin.username || localOrigin.password || localOrigin.origin !== local.origin) {
      throw new Error('Локальный адрес должен иметь вид http://127.0.0.1:PORT.');
    }
  }
  // Один секрет на запуск: параллельные загрузки страницы не отменяют сессию друг друга.
  const localSecret = local ? randomBytes(32).toString('base64url') : '';
  const localCookieName = 'fitness_local_session';
  function localRequestAllowed(req: IncomingMessage) {
    const address = req.socket.remoteAddress;
    const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    const proxyHeader = Object.keys(req.headers).some((name) => name === 'forwarded' ||
      name === 'x-forwarded' || name.startsWith('x-forwarded-') || name.startsWith('cf-') ||
      ['x-real-ip', 'true-client-ip', 'via', 'cdn-loop', 'x-original-host'].includes(name));
    const fetchSite = req.headers['sec-fetch-site'];
    return loopback && !proxyHeader && req.headers.host === localOrigin!.host &&
      (req.headers.origin === undefined || req.headers.origin === localOrigin!.origin) &&
      (fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none');
  }
  function localSessionValid(req: IncomingMessage) {
    const values = (req.headers.cookie ?? '').split(';').map((part) => part.trim())
      .filter((part) => part.startsWith(localCookieName + '='));
    if (values.length !== 1) return false;
    const supplied = Buffer.from(values[0].slice(localCookieName.length + 1));
    const expected = Buffer.from(localSecret);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
  function requestUser(req: IncomingMessage) {
    if (localAccount) return localAccount;
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('tma ')) throw new Error('Missing credentials');
    return verifyInitData(header.slice(4), token);
  }
  function identifyUser(user: ReturnType<typeof requestUser>) {
    return localAccount ?? users.identify(user);
  }
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const requestUrl = new URL(req.url ?? '/', 'http://localhost');
      const path = requestUrl.pathname;
      if (local && !localRequestAllowed(req)) {
        json(res, 403, { error: 'Локальное приложение доступно только напрямую с этого компьютера.' });
        return;
      }
      if (path.startsWith('/api/')) {
        if (path === '/api/local/session') {
          if (!localAccount) { json(res, 404, { error: 'Не найдено' }); return; }
          if (req.method !== 'GET') { json(res, 405, { error: 'Метод не поддерживается' }); return; }
          res.setHeader('Set-Cookie', `${localCookieName}=${localSecret}; Path=/api; HttpOnly; SameSite=Strict`);
          json(res, 200, { mode: 'local', user: localAccount });
          return;
        }
        if (local && !localSessionValid(req)) {
          json(res, 401, { error: 'Обнови страницу, чтобы открыть локальный профиль.' });
          return;
        }
        if (path === '/api/auth' && req.method === 'POST') {
          if (localAccount) { json(res, 200, { user: localAccount, mode: 'local' }); return; }
          let user;
          try {
            const input = await body(req);
            if (typeof input?.initData !== 'string') throw new Error('Missing credentials');
            user = verifyInitData(input.initData, token);
          } catch {
            json(res, 401, { error: 'Открой приложение заново через Telegram.' });
            return;
          }
          json(res, 200, { user: users.identify(user) });
          return;
        }
        if (path.startsWith('/api/tracking/') || path === '/api/workouts' || path === '/api/workouts/latest') {
          let user;
          try { user = requestUser(req); }
          catch { json(res, 401, { error: 'открой приложение заново через telegram.' }); return; }
          try {
            const today = todayInTimezone(requestUrl.searchParams.get('timezone'));
            identifyUser(user);
            const store = users.tracking;
            if (path === '/api/tracking/definitions' && ['GET', 'POST', 'PATCH'].includes(req.method ?? '')) {
              if (req.method === 'POST') {
                const input = await body(req);
                store.createDefinition(user.id, input as { name: string; category: 'strength' | 'cardio' }, today);
              } else if (req.method === 'PATCH') {
                const input = await body(req);
                if (typeof input.id !== 'string') throw new Error('Invalid definition');
                store.updateDefinition(user.id, input.id, input as { name?: string; archived?: boolean }, today);
              }
              json(res, 200, { definitions: store.getDefinitions(user.id) }); return;
            }
            if (path === '/api/tracking/day' && (req.method === 'GET' || req.method === 'PATCH')) {
              const date = validateActivityDate(requestUrl.searchParams.get('date') ?? today);
              if (req.method === 'PATCH') {
                if (date > today) throw new Error('Future date');
                const input = await body(req);
                if (typeof input.id !== 'string' || typeof input.completed !== 'boolean') throw new Error('Invalid completion');
                json(res, 200, { day: store.setCompletion(user.id, date, input.id, input.completed) });
              } else json(res, 200, { day: store.getDay(user.id, date) });
              return;
            }
            if (path === '/api/tracking/calendar' && req.method === 'GET') {
              const start = validateActivityDate(requestUrl.searchParams.get('start'));
              const end = validateActivityDate(requestUrl.searchParams.get('end'));
              const days = (Date.parse(end) - Date.parse(start)) / 86400000;
              if (days < 0 || days > 366) throw new Error('Invalid range');
              json(res, 200, { days: store.getCalendar(user.id, start, end) }); return;
            }
            if ((path === '/api/tracking/month' && req.method === 'GET') || (path === '/api/tracking/goals' && req.method === 'PATCH')) {
              const month = requestUrl.searchParams.get('month') ?? today.slice(0, 7);
              if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Invalid month');
              validateActivityDate(month + '-01');
              if (req.method === 'PATCH') {
                const input = await body(req);
                store.setGoals(user.id, month, input as { strength: number | null; cardio: number | null });
              }
              json(res, 200, { month: store.getMonth(user.id, today, month) }); return;
            }
            if (path === '/api/workouts/latest' && req.method === 'GET') {
              const before = validateActivityDate(requestUrl.searchParams.get('before') ?? today);
              json(res, 200, { workout: store.workouts.getLatest(user.id, before) }); return;
            }
            if (path === '/api/workouts' && (req.method === 'GET' || req.method === 'PATCH')) {
              const date = validateActivityDate(requestUrl.searchParams.get('date') ?? today);
              if (req.method === 'PATCH') {
                if (date > today) throw new Error('Future workout');
                json(res, 200, { workout: store.workouts.setDay(user.id, date, await body(req)) });
              } else json(res, 200, { workout: store.workouts.getDay(user.id, date) });
              return;
            }
            json(res, 404, { error: 'не найдено' }); return;
          } catch {
            json(res, 400, { error: 'проверь данные и дату. названия отметок — до 80 символов, цели — от 1 до 1000 дней. запись в будущие дни недоступна.' });
            return;
          }
        }
        if (path === '/api/measurements' && (req.method === 'GET' || req.method === 'PATCH')) {
          let user;
          try { user = requestUser(req); }
          catch { json(res, 401, { error: 'Открой приложение заново через Telegram.' }); return; }
          let date: string;
          let input;
          try {
            const today = todayInTimezone(requestUrl.searchParams.get('timezone'));
            const requested = requestUrl.searchParams.get('date');
            date = requested === null ? today : validateActivityDate(requested);
            if (req.method === 'PATCH') {
              if (date > today) throw new Error('Future measurement');
              input = validateMeasurement(await body(req));
            }
          } catch {
            json(res, 400, { error: 'Проверь дату и замер: вес от 20 до 400 кг, жир от 1 до 70%, не более одного знака после запятой. Будущие даты недоступны для записи.' });
            return;
          }
          if (input) identifyUser(user);
          json(res, 200, { measurement: input ? users.setMeasurement(user.id, date, input) : users.getMeasurement(user.id, date) });
          return;
        }
        if (path === '/api/measurement-history' && req.method === 'GET') {
          let user;
          try { user = requestUser(req); }
          catch { json(res, 401, { error: 'Открой приложение заново через Telegram.' }); return; }
          try { todayInTimezone(requestUrl.searchParams.get('timezone')); }
          catch { json(res, 400, { error: 'Некорректный часовой пояс.' }); return; }
          json(res, 200, users.getMeasurementHistory(user.id));
          return;
        }
        if (path === '/api/workout-goal' && req.method === 'PATCH') {
          let user;
          try {
            user = requestUser(req);
          } catch {
            json(res, 401, { error: 'Открой приложение заново через Telegram.' });
            return;
          }
          let date: string;
          let goal: number | null;
          try {
            date = todayInTimezone(requestUrl.searchParams.get('timezone'));
            const input = await body(req);
            if (input.goal !== null && (typeof input.goal !== 'number' || !Number.isInteger(input.goal) || input.goal < 1 || input.goal > 1000)) {
              throw new Error('Invalid goal');
            }
            goal = input.goal as number | null;
          } catch {
            json(res, 400, { error: 'Укажи целое число тренировок от 1 до 1000.' });
            return;
          }
          identifyUser(user);
          json(res, 200, users.setMonthlyWorkoutGoal(user.id, date, goal));
          return;
        }
        if (path === '/api/dashboard' && (req.method === 'GET' || req.method === 'PATCH')) {
          let user;
          try {
            user = requestUser(req);
          } catch {
            json(res, 401, { error: 'Открой приложение заново через Telegram.' });
            return;
          }
          let date: string;
          let profile;
          try {
            date = todayInTimezone(requestUrl.searchParams.get('timezone'));
            if (req.method === 'PATCH') profile = validateProfile(await body(req));
          } catch {
            json(res, 400, { error: 'Проверь значения: жир от 1 до 70%, вес от 20 до 400 кг, не более одного знака после запятой.' });
            return;
          }
          identifyUser(user);
          if (profile) users.setProfile(user.id, profile, date);
          json(res, 200, users.getDashboard(user.id, date));
          return;
        }
        if (path === '/api/form-index' && req.method === 'GET') {
          let user;
          try {
            user = requestUser(req);
          } catch {
            json(res, 401, { error: 'Открой приложение заново через Telegram.' });
            return;
          }
          let end: string;
          try { end = todayInTimezone(requestUrl.searchParams.get('timezone')); }
          catch { json(res, 400, { error: 'Некорректный часовой пояс.' }); return; }
          json(res, 200, users.getFormIndex(user.id, end));
          return;
        }
        if (path === '/api/calendar' && req.method === 'GET') {
          let user;
          try {
            user = requestUser(req);
          } catch {
            json(res, 401, { error: 'Открой приложение заново через Telegram.' });
            return;
          }
          let start: string;
          let end: string;
          try {
            start = validateActivityDate(requestUrl.searchParams.get('start'));
            end = validateActivityDate(requestUrl.searchParams.get('end'));
            const days = (Date.parse(end) - Date.parse(start)) / 86400000;
            if (days < 0 || days > 366) throw new Error('Invalid range');
          } catch {
            json(res, 400, { error: 'Некорректный диапазон календаря.' });
            return;
          }
          json(res, 200, { activities: users.getCalendarActivity(user.id, start, end) });
          return;
        }
        if (path === '/api/activity' && (req.method === 'GET' || req.method === 'PATCH')) {
          let user;
          try {
            user = requestUser(req);
          } catch {
            json(res, 401, { error: 'Открой приложение заново через Telegram.' });
            return;
          }
          if (req.method === 'PATCH' && options.legacyActivityWrites === 'reject') {
            json(res, 409, { error: 'приложение обновлено. полностью закрой миниаппку и открой снова через бота, чтобы сохранить отметку.' });
            return;
          }
          let input: Record<string, unknown> = {};
          let date: string;
          try {
            if (req.method === 'PATCH') input = await body(req);
            const today = todayInTimezone(req.method === 'GET' ? requestUrl.searchParams.get('timezone') : input.timezone);
            const requestedDate = req.method === 'GET' ? requestUrl.searchParams.get('date') : input.date;
            date = req.method === 'GET' && requestedDate === null ? today : validateActivityDate(requestedDate);
            if (req.method === 'PATCH' &&
                ((input.kind !== 'training' && input.kind !== 'microTraining' && input.kind !== 'walking') || typeof input.completed !== 'boolean')) {
              throw new Error('Invalid activity');
            }
          } catch {
            json(res, 400, { error: 'Некорректная отметка, дата или часовой пояс.' });
            return;
          }
          identifyUser(user);
          const activity = req.method === 'GET' ? users.getActivity(user.id, date)
            : users.setActivity(user.id, date, input.kind as 'training' | 'microTraining' | 'walking', input.completed as boolean);
          json(res, 200, { activity });
          return;
        }
        if (path === '/api/admin/users' && req.method === 'GET') {
          let user;
          try {
            user = requestUser(req);
          } catch {
            json(res, 401, { error: 'Открой приложение заново через Telegram.' });
            return;
          }
          if (!users.isAdmin(user.id)) {
            json(res, 403, { error: 'Доступ только для администратора.' });
            return;
          }
          json(res, 200, { users: users.list() });
          return;
        }
        json(res, 404, { error: 'Не найдено' });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405); res.end(); return;
      }
      const file = resolve(root, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
      if (!file.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
      };
      let content: Buffer;
      try { content = await readFile(file); }
      catch { res.writeHead(404); res.end(); return; }
      if (local && extname(file) === '.html') {
        content = Buffer.from(content.toString('utf8').replace(
          /<script\b[^>]*\bsrc=["']https:\/\/telegram\.org\/js\/telegram-web-app\.js(?:\?[^"']*)?["'][^>]*>\s*<\/script>/gi,
          '',
        ));
      }
      res.writeHead(200, {
        'Content-Type': types[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch {
      json(res, 500, { error: 'Ошибка сервера. Попробуй позже.' });
    }
  });
}
