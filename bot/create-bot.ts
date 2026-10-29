import { Bot, InlineKeyboard, type BotConfig, type Context } from 'grammy';

export class BotConfigurationError extends Error {}

export function readBotConfig(env: NodeJS.ProcessEnv) {
  const token = env.BOT_TOKEN?.trim();
  const appUrl = env.WEB_APP_URL?.trim();
  if (!token || !appUrl) {
    throw new BotConfigurationError('Заполните BOT_TOKEN и WEB_APP_URL в .env.');
  }
  let url: URL;
  try { url = new URL(appUrl); }
  catch { throw new BotConfigurationError('WEB_APP_URL должен содержать корректный HTTPS-адрес.'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new BotConfigurationError('WEB_APP_URL должен быть HTTPS-адресом без логина и пароля.');
  }
  const transport = env.BOT_TRANSPORT ?? 'polling';
  if (transport !== 'polling' && transport !== 'webhook') {
    throw new BotConfigurationError('BOT_TRANSPORT должен быть polling или webhook.');
  }
  return { token, url, transport };
}

export function createFitnessBot(token: string, url: URL, config?: BotConfig<Context>, updateMenu = true) {
  const bot = new Bot(token, config);
  const menuButton = {
    type: 'web_app' as const,
    text: 'Открыть приложение',
    web_app: { url: url.href },
  };
  bot.command('start', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await ctx.reply('Открой личный чат со мной, чтобы запустить приложение.');
      return;
    }
    if (updateMenu) {
      await bot.api.setChatMenuButton({ chat_id: ctx.chat.id, menu_button: menuButton });
    }
    // В webhook-режиме это единственный вызов Bot API на обновление.
    await ctx.reply('Нажми кнопку, чтобы открыть приложение.', {
      reply_markup: new InlineKeyboard().webApp('Открыть приложение', url.href),
    });
  });
  // Не выводим объекты ошибок API: они могут содержать данные пользователя.
  bot.catch(() => console.error('Не удалось обработать обновление Telegram.'));
  return { bot, menuButton };
}
