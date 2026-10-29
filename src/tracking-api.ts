import { telegram } from './telegram';

export const trackingTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export async function trackingRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Authorization: `tma ${telegram?.initData ?? ''}`, ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error.toLowerCase().replace(/\u0451/g, 'е') : 'не удалось сохранить данные.');
  return data as T;
}
