export type ActivityCategory = 'strength' | 'cardio';

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
  cardioFraction: number;
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
  strength: MonthlyTrackingCategory;
  cardio: MonthlyTrackingCategory;
  days: TrackingDay[];
};

export type TrackingGoals = { strength: number | null; cardio: number | null };
