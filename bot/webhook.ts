import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { webhookCallback, type ApiClientOptions } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { BotConfigurationError, createFitnessBot } from './create-bot';

export const WEBHOOK_PATH = '/telegram/webhook';
const secretPattern = /^[A-Za-z0-9_-]{1,256}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseBotInfo(value: unknown, token: string): UserFromGetMe {
  // Принимаем и полный ответ getMe, и его result. Секретов в этом файле нет.
  const info = record(value) && ('ok' in value || 'result' in value)
    ? value.ok === true ? value.result : undefined
    : value;
  const prefix = /^([1-9]\d*):[^:\s]+$/.exec(token)?.[1];
  const tokenId = Number(prefix);
  if (!prefix || !Number.isSafeInteger(tokenId) || !record(info) ||
      info.is_bot !== true || !Number.isSafeInteger(info.id) || info.id !== tokenId ||
      typeof info.first_name !== 'string' || !info.first_name.trim() ||
      typeof info.username !== 'string' || !/^[A-Za-z0-9_]+$/.test(info.username)) {
    throw new BotConfigurationError('BOT_INFO_FILE должен содержать успешный getMe этого бота: id, is_bot, first_name и username.');
  }
  // Проверены поля, которые использует /start; остальные флаги сохраняем из getMe.
  return info as unknown as UserFromGetMe;
}

export function readWebhookConfig(token: string, env: NodeJS.ProcessEnv) {
  const secret = env.WEBHOOK_SECRET;
  if (!secret || !secretPattern.test(secret)) {
    throw new BotConfigurationError('Для webhook укажите WEBHOOK_SECRET: 1–256 символов A–Z, a–z, 0–9, _ или -.');
  }
  const portText = env.WEBHOOK_PORT ?? '8081';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new BotConfigurationError('WEBHOOK_PORT должен быть числом от 1 до 65535.');
  }
  const infoFile = env.BOT_INFO_FILE?.trim() || 'data/bot-info.json';
  let value: unknown;
  try { value = JSON.parse(readFileSync(infoFile, 'utf8')); }
  catch { throw new BotConfigurationError('Не удалось прочитать BOT_INFO_FILE: сохраните успешный getMe в JSON.'); }
  return { port, secret, botInfo: parseBotInfo(value, token) };
}

type WebhookRuntimeOptions = {
  token: string;
  url: URL;
  secret: string;
  botInfo: UserFromGetMe;
  fetch?: ApiClientOptions['fetch'];
};

export function createWebhookRuntime(options: WebhookRuntimeOptions) {
  if (!secretPattern.test(options.secret)) {
    throw new BotConfigurationError('WEBHOOK_SECRET обязателен для webhook.');
  }
  const { bot } = createFitnessBot(options.token, options.url, {
    // Adapter вызывает init даже перед проверкой секрета: botInfo предотвращает getMe.
    botInfo: parseBotInfo(options.botInfo, options.token),
    client: {
      canUseWebhookReply: (method) => method === 'sendMessage',
      // В этом транспорте сообщения отправляются только webhook-ответом.
      fetch: options.fetch ?? (async () => { throw new Error('Исходящий Bot API недоступен в webhook-режиме.'); }),
    },
  }, false);
  const callback = webhookCallback(bot, 'http', {
    secretToken: options.secret,
    timeoutMilliseconds: 10_000,
  });
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => {
    if (req.url !== WEBHOOK_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    // Проверку X-Telegram-Bot-Api-Secret-Token выполняет штатный http adapter.
    void callback(req, res).catch(() => {
      console.error('Не удалось обработать webhook Telegram.');
      if (!res.headersSent) res.writeHead(500).end();
      else if (!res.writableEnded) res.end();
    });
  });
  let stopping: Promise<void> | undefined;
  return {
    server,
    async listen(port = 8081) {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', onError);
          resolve();
        });
      });
    },
    stop(graceMilliseconds = 25_000) {
      stopping ??= new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => server.closeAllConnections(), graceMilliseconds);
        deadline.unref();
        server.close((error) => {
          clearTimeout(deadline);
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
      });
      return stopping;
    },
  };
}
