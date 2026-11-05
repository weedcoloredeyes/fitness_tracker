export type LightWorkoutSet = {
  id: string;
  title: string;
  exercises: string[];
  note: string;
};

export type LightWorkoutAssignment = {
  date: string;
  catalogId: string;
  title: string;
  exercises: string[];
  note: string;
};

export type LightWorkoutView = {
  date: string;
  dailyEnabled: boolean;
  assignment: LightWorkoutAssignment | null;
  catalogSize: number;
  rerollsUsed: number;
  rerollsRemaining: number;
};
