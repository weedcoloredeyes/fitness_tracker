export const ACTIVITY_CATEGORIES = ['strength', 'light', 'cardio'] as const;
export type ActivityCategory = typeof ACTIVITY_CATEGORIES[number];
export type ActivityWeights = Record<ActivityCategory, number>;
export const ACTIVITY_LABELS: Record<ActivityCategory, string> = {
  strength: 'основная тренировка', light: 'легкая тренировка', cardio: 'кардио',
};
export const LEGACY_CATEGORY_WEIGHTS: ActivityWeights = { strength: 50, light: 0, cardio: 50 };
// Kept in one browser-safe module so optimistic and persisted scores use identical weights.
export const CURRENT_CATEGORY_WEIGHTS: ActivityWeights = { strength: 50, light: 25, cardio: 50 };

export function calculateTrackingScore(fractions: Record<ActivityCategory, number>, weights: ActivityWeights): number {
  return Math.min(weights.strength, weights.strength * fractions.strength + weights.light * fractions.light)
    + weights.cardio * fractions.cardio;
}

export function physicalTrainingFraction(day: Pick<TrackingDay, 'strengthFraction' | 'lightFraction' | 'weights'>): number {
  return Math.min(day.strengthFraction + day.weights.light / day.weights.strength * day.lightFraction, 1);
}

export type ActivityDefinition = {
  id: string;
  name: string;
  category: ActivityCategory;
  archived: boolean;
};

export type TrackingDay = {
  date: string;
  definitions: ActivityDefinition[];
  completedIds: string[];
  strengthFraction: number;
  lightFraction: number;
  cardioFraction: number;
  weights: ActivityWeights;
  score: number;
};

export type MonthlyTrackingCategory = {
  earned: number;
  goal: number | null;
  score: number | null;
  completedDays: number;
};

export type MonthlyTracking = {
  month: string;
  start: string;
  end: string;
  score: number | null;
  weights: ActivityWeights;
  strength: MonthlyTrackingCategory;
  cardio: MonthlyTrackingCategory;
  days: TrackingDay[];
};

export type TrackingGoals = { strength: number | null; cardio: number | null };
