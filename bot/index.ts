import { GrammyError, HttpError } from 'grammy';
import { BotConfigurationError, createFitnessBot, readBotConfig } from './create-bot';
import { createWebhookRuntime, readWebhookConfig, WEBHOOK_PATH } from './webhook';

async function main() {
  const { token, url, transport } = readBotConfig(process.env);
  if (transport === 'webhook') {
    const config = readWebhookConfig(token, process.env);
    const runtime = createWebhookRuntime({ ...config, token, url });
    await runtime.listen(config.port);
    const stop = () => {
      void runtime.stop().catch(() => {
        console.error('Не удалось корректно остановить webhook бота.');
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    console.info(`Webhook бота: http://127.0.0.1:${config.port}${WEBHOOK_PATH}`);
    return;
  }

  const { bot, menuButton } = createFitnessBot(token, url);
  await bot.api.setChatMenuButton({ menu_button: menuButton });
  process.once('SIGINT', () => { void bot.stop(); });
  process.once('SIGTERM', () => { void bot.stop(); });
  await bot.start({ onStart: () => console.info('Бот запущен.') });
}

main().catch((error: unknown) => {
  let reason = 'Проверьте .env, токен и подключение к Telegram.';
  if (error instanceof BotConfigurationError) {
    reason = error.message;
  } else if (error instanceof GrammyError && error.error_code === 401) {
    reason = 'Telegram 401: токен бота недействителен или отозван.';
  } else if (error instanceof GrammyError && error.error_code === 409) {
    reason = 'Telegram 409: конфликт с другим экземпляром бота или настроенным webhook.';
  } else {
    const networkError = error instanceof HttpError ? error.error : error;
    const candidates = [networkError];
    if (networkError && typeof networkError === 'object' && 'cause' in networkError) {
      candidates.push(networkError.cause);
    }
    const allowedCodes = new Set([
      'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
      'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
    ]);
    const code = candidates.map((value) =>
      value && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
        ? value.code : '',
    ).find((value) => allowedCodes.has(value));
    if (code) reason = `Ошибка соединения с Telegram (${code}).`;
    else if (error instanceof HttpError) reason = 'Ошибка соединения с Telegram.';
  }
  // Выводим только заранее заданный текст и разрешенные коды, без данных API.
  console.error(`Не удалось запустить бота. ${reason}`);
  process.exitCode = 1;
});
