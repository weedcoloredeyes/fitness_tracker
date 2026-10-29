export const normalizeMeasurementInput = (value: string): string => value.replace(/,/g, '.');

export function parseMeasurementInput(raw: string, min: number, max: number): number | null {
  const text = normalizeMeasurementInput(raw.trim());
  if (text === '') return null;
  const value = Number(text);
  if (!/^\d+(?:\.\d*)?$/.test(text) || !Number.isFinite(value) || value < min || value > max ||
      Math.abs(value * 10 - Math.round(value * 10)) > 1e-7) {
    throw new Error('проверь значения: вес от 20 до 400 кг, жир от 1 до 70%, с точностью до одного знака после точки');
  }
  return value;
}
