import type { Activity } from './Today';
import { MeasurementHistory } from './MeasurementHistory';
import { MonthlyIndex } from './MonthlyPlan';

export function FormIndex({ authenticated, active, activityRevision, measurementRevision = 0, planRevision = 0, onPlanChange }: {
  authenticated: boolean; active: boolean; activityRevision: number;
  measurementRevision?: number; planRevision?: number; onPlanChange?: () => void;
  activities: Record<string, Activity>; onLoaded: (activities: Activity[]) => void;
}) {
  return <section className="form-index" aria-labelledby="form-index-title">
    <MonthlyIndex authenticated={authenticated} active={active} activityRevision={activityRevision} planRevision={planRevision} onChanged={onPlanChange} />
    <MeasurementHistory authenticated={authenticated} active={active} measurementRevision={measurementRevision} />
  </section>;
}
