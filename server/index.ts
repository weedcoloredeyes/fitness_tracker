import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createApp } from './app';
import { Users } from './users';

const token = process.env.BOT_TOKEN?.trim();
const localMode = process.env.LOCAL_MODE === '1';
if (!localMode && !token) throw new Error('Укажите BOT_TOKEN в .env');
const port = Number(process.env.PORT ?? 5173);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть числом от 1 до 65535.');
const localUserId = Number(process.env.LOCAL_USER_ID);
if (localMode && (!Number.isSafeInteger(localUserId) || localUserId <= 0)) {
  throw new Error('Для LOCAL_MODE=1 укажи LOCAL_USER_ID существующего пользователя.');
}
const databaseFile = resolve('data/fitness.sqlite');
if (localMode && !existsSync(databaseFile)) throw new Error('Для локального режима нужна существующая база data/fitness.sqlite.');
const users = new Users(databaseFile, resolve('data/users.json'));
let server;
try {
  server = createApp(token ?? '', users, resolve('dist'), {
    legacyActivityWrites: 'reject',
    ...(localMode ? { local: { userId: localUserId, origin: `http://127.0.0.1:${port}` } } : {}),
  });
} catch (error) {
  users.close();
  throw error;
}
server.listen(port, '127.0.0.1', () => console.info(`Сервер: http://127.0.0.1:${port}`));
server.on('close', () => users.close());
server.on('error', () => { users.close(); console.error('Не удалось запустить сервер. Проверьте порт.'); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close());
}
