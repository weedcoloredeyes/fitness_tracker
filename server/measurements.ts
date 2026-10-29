export type Measurement = { date: string; currentWeight: number | null; currentFat: number | null };
export type MeasurementInput = { currentWeight?: number | null; currentFat?: number | null };

export function validateMeasurement(input: unknown): MeasurementInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid measurement');
  const result: MeasurementInput = {};
  for (const key of ['currentWeight', 'currentFat'] as const) {
    if (!Object.hasOwn(input, key)) continue;
    const value = (input as Record<string, unknown>)[key];
    const [min, max] = key === 'currentFat' ? [1, 70] : [20, 400];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max ||
        Math.abs(value * 10 - Math.round(value * 10)) > 0.000001)) throw new Error('Invalid measurement');
    result[key] = value as number | null;
  }
  if (!Object.keys(result).length) throw new Error('Missing measurement');
  return result;
}
