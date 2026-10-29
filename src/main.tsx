import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { telegram } from './telegram';
import './styles.css';
import './measurements.css';
import './tracking.css';
import './workouts.css';
import './monthly-tracking.css';
import './typography.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);

telegram?.ready();
if (telegram?.initData) {
  telegram.expand();
  if (telegram.isVersionAtLeast?.('7.7')) telegram.disableVerticalSwipes?.();
}
