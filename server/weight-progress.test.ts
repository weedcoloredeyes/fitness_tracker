import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Users } from './users';

const initial = { currentWeight: 90, currentFat: 22, targetWeight: 80, targetFat: 18 };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-weight-progress-'));
  const file = join(dir, 'fitness.sqlite');
  let users = new Users(file);
  users.identify({ id: 101, first_name: 'First' });
  users.identify({ id: 202, first_name: 'Second' });
  return {
    file,
    get users() { return users; },
    restart() { users.close(); users = new Users(file); },
    close() { users.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function baselineDate(file: string, userId: number): string | null {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT start_weight_date AS date FROM body_profiles WHERE user_id = ?').get(userId);
    assert.ok(row);
    return row.date as string | null;
  } finally { db.close(); }
}

test('correcting the first dated weight corrects the baseline without inventing weight loss', () => {
  const f = fixture();
  try {
    const users = f.users;
    users.setProfile(101, initial, '2026-01-01');
    users.setMeasurement(101, '2026-01-01', { currentWeight: 85 });
    let dashboard = users.getDashboard(101, '2026-01-01');
    assert.equal(dashboard.profile.startWeight, 85);
    assert.equal(dashboard.progress, 0, 'correcting the sole measurement is not actual progress');
    assert.equal(dashboard.profile.currentFat, 22, 'a weight correction preserves the same-day fat value');
    assert.equal(baselineDate(f.file, 101), '2026-01-01');

    users.setProfile(101, { ...initial, currentWeight: 86 }, '2026-01-01');
    dashboard = users.getDashboard(101, '2026-01-01');
    assert.equal(dashboard.profile.startWeight, 86, 'the dashboard form follows the same correction policy');
    assert.equal(dashboard.progress, 0);
    users.setMeasurement(101, '2026-01-02', { currentWeight: 83 });
    dashboard = users.getDashboard(101, '2026-01-03');
    assert.equal(dashboard.profile.startWeight, 86);
    assert.equal(dashboard.profile.currentWeight, null);
    assert.equal(dashboard.progress, 50);
  } finally { f.close(); }
});

test('deleting and restoring the source weight selects the earliest remaining weight within a stable goal boundary', () => {
  const f = fixture();
  try {
    const users = f.users;
    users.setProfile(101, initial, '2026-01-02');
    users.setMeasurement(101, '2026-01-01', { currentWeight: 100 });
    users.setMeasurement(101, '2026-01-03', { currentFat: 21 });
    users.setMeasurement(101, '2026-01-04', { currentWeight: 88 });
    users.setMeasurement(101, '2026-01-05', { currentWeight: 86 });

    users.setMeasurement(101, '2026-01-02', { currentWeight: null });
    let dashboard = users.getDashboard(101, '2026-01-06');
    assert.equal(dashboard.profile.startWeight, 88, 'fat-only days and weights before the goal boundary are skipped');
    assert.equal(dashboard.progress, 25);
    assert.equal(users.getMeasurement(101, '2026-01-02').currentFat, 22);
    assert.equal(baselineDate(f.file, 101), '2026-01-02', 'deleting a source does not move the goal boundary');

    users.setMeasurement(101, '2026-01-02', { currentWeight: 91 });
    dashboard = users.getDashboard(101, '2026-01-06');
    assert.equal(dashboard.profile.startWeight, 91, 'restoring the original day restores its role as the baseline');
    assert.equal(dashboard.progress, 45);
    users.setMeasurement(101, '2026-01-02', { currentWeight: null, currentFat: null });
    assert.equal(users.getDashboard(101, '2026-01-06').profile.startWeight, 88);
    users.setMeasurement(101, '2026-01-04', { currentWeight: null });
    assert.equal(users.getDashboard(101, '2026-01-06').profile.startWeight, 86);
    users.setMeasurement(101, '2026-01-05', { currentWeight: null });
    dashboard = users.getDashboard(101, '2026-01-06');
    assert.equal(dashboard.profile.startWeight, null, 'an earlier pre-goal weight cannot become the new baseline');
    assert.equal(dashboard.profile.targetWeight, 80);
    assert.equal(dashboard.progress, null);
    assert.equal(baselineDate(f.file, 101), '2026-01-02');

    users.setMeasurement(101, '2026-01-01', { currentWeight: 99 });
    assert.equal(users.getDashboard(101, '2026-01-06').profile.startWeight, null);
    users.setMeasurement(101, '2026-01-03', { currentWeight: 85 });
    dashboard = users.getDashboard(101, '2026-01-06');
    assert.equal(dashboard.profile.startWeight, 85, 'a later fill can use any day at or after the preserved boundary');
    assert.equal(dashboard.progress, 0);
    assert.equal(baselineDate(f.file, 101), '2026-01-02');
  } finally { f.close(); }
});

test('changing the target starts a new dated period and older corrections cannot alter it', () => {
  const f = fixture();
  try {
    const users = f.users;
    users.setProfile(101, initial, '2026-01-01');
    users.setMeasurement(101, '2026-01-03', { currentWeight: 85 });
    users.setProfile(101, { currentWeight: null, currentFat: null, targetWeight: 75, targetFat: 17 }, '2026-01-04');
    let dashboard = users.getDashboard(101, '2026-01-04');
    assert.equal(dashboard.profile.startWeight, 85);
    assert.equal(dashboard.profile.currentWeight, null);
    assert.equal(dashboard.progress, 0);
    assert.equal(baselineDate(f.file, 101), '2026-01-03', 'the latest known weight supplies the new boundary');

    users.setMeasurement(101, '2026-01-05', { currentWeight: 83 });
    users.setMeasurement(101, '2026-01-01', { currentWeight: 100 });
    users.setMeasurement(101, '2026-01-02', { currentWeight: 95 });
    users.setMeasurement(101, '2026-01-01', { currentWeight: null, currentFat: null });
    dashboard = users.getDashboard(101, '2026-01-06');
    assert.equal(dashboard.profile.startWeight, 85);
    assert.equal(dashboard.progress, 20);
    users.setMeasurement(101, '2026-01-03', { currentWeight: 84 });
    dashboard = users.getDashboard(101, '2026-01-06');
    assert.equal(dashboard.profile.startWeight, 84, 'corrections inside the new period still update the baseline');
    assert.equal(dashboard.progress, 11);

    users.setProfile(101, { currentWeight: null, currentFat: null, targetWeight: 75, targetFat: 16 }, '2026-01-06');
    assert.equal(users.getDashboard(101, '2026-01-06').profile.startWeight, 84, 'changing only the fat target keeps the weight period');
    assert.equal(baselineDate(f.file, 101), '2026-01-03');
    users.setProfile(101, { currentWeight: null, currentFat: null, targetWeight: 70, targetFat: 16 }, '2026-01-06');
    assert.equal(users.getDashboard(101, '2026-01-06').profile.startWeight, 83);
    assert.equal(baselineDate(f.file, 101), '2026-01-05');
    users.setMeasurement(101, '2026-01-03', { currentWeight: 100 });
    assert.equal(users.getDashboard(101, '2026-01-06').profile.startWeight, 83);
    assert.equal(users.getDashboard(101, '2026-01-06').progress, 0);
  } finally { f.close(); }
});

test('fat-only updates preserve weight progress and empty current values do not discard the latest weight', () => {
  const f = fixture();
  try {
    const users = f.users;
    users.setProfile(101, initial, '2026-01-01');
    users.setMeasurement(101, '2026-01-02', { currentWeight: 85, currentFat: 20 });
    users.setMeasurement(101, '2026-01-01', { currentFat: 19.5 });
    users.setMeasurement(101, '2026-01-01', { currentFat: null });
    users.setMeasurement(101, '2026-01-03', { currentFat: 18 });
    const dashboard = users.getDashboard(101, '2026-01-04');
    assert.equal(dashboard.profile.startWeight, 90);
    assert.equal(dashboard.profile.currentWeight, null);
    assert.equal(dashboard.profile.currentFat, null);
    assert.equal(dashboard.progress, 50);
    assert.equal(dashboard.progressMeasurementDate, '2026-01-02');
    assert.equal(dashboard.lastMeasurementDate, '2026-01-03');
    assert.equal(users.getMeasurement(101, '2026-01-01').currentWeight, 90);
    assert.equal(baselineDate(f.file, 101), '2026-01-01');
  } finally { f.close(); }
});

test('baseline corrections and the fixed goal boundary survive restart and stay isolated by user', () => {
  const f = fixture();
  try {
    f.users.setProfile(101, initial, '2026-01-01');
    f.users.setMeasurement(101, '2026-01-02', { currentWeight: 85 });
    f.users.setProfile(202, { ...initial, currentWeight: 70, targetWeight: 80 }, '2026-01-01');
    f.users.setMeasurement(202, '2026-01-02', { currentWeight: 75 });
    f.users.setMeasurement(101, '2026-01-01', { currentWeight: 86 });
    const other = f.users.getDashboard(202, '2026-01-03');
    assert.equal(f.users.getDashboard(101, '2026-01-03').progress, 17);
    assert.equal(other.progress, 50);
    f.restart();
    assert.equal(f.users.getDashboard(101, '2026-01-03').profile.startWeight, 86);
    assert.equal(f.users.getDashboard(101, '2026-01-03').progress, 17);
    assert.equal(baselineDate(f.file, 101), '2026-01-01');
    assert.deepEqual(f.users.getDashboard(202, '2026-01-03'), other);

    f.users.setMeasurement(101, '2026-01-01', { currentWeight: null, currentFat: null });
    assert.equal(f.users.getDashboard(101, '2026-01-03').profile.startWeight, 85);
    assert.equal(f.users.getDashboard(101, '2026-01-03').progress, 0);
    f.restart();
    assert.equal(baselineDate(f.file, 101), '2026-01-01');
    f.users.setMeasurement(101, '2026-01-01', { currentWeight: 86 });
    assert.equal(f.users.getDashboard(101, '2026-01-03').progress, 17);
    assert.deepEqual(f.users.getDashboard(202, '2026-01-03'), other);
  } finally { f.close(); }
});

test('v6 migration preserves an undated baseline until a target change explicitly creates a dated period', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fitness-weight-progress-v6-'));
  const file = join(dir, 'fitness.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT, username TEXT,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
    ) STRICT;
    INSERT INTO users VALUES (101, 'Legacy', NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
    CREATE TABLE body_profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id), current_fat REAL, target_fat REAL,
      current_weight REAL, target_weight REAL, start_weight REAL
    ) STRICT;
    INSERT INTO body_profiles VALUES (101, 22, 18, 85, 80, 90);
    PRAGMA user_version = 6;
  `);
  old.close();
  let users = new Users(file);
  try {
    assert.equal(baselineDate(file, 101), null, 'an unknown historical start date must not be fabricated');
    assert.equal(users.getDashboard(101, '2026-01-01').profile.startWeight, 90);
    assert.equal(users.getDashboard(101, '2026-01-01').progress, 50);
    users.setMeasurement(101, '2026-01-02', { currentWeight: 84 });
    users.setMeasurement(101, '2026-01-02', { currentWeight: 83 });
    assert.equal(users.getDashboard(101, '2026-01-03').profile.startWeight, 90);
    assert.equal(users.getDashboard(101, '2026-01-03').progress, 70);
    assert.equal(baselineDate(file, 101), null);
    users.close();
    users = new Users(file);
    assert.equal(users.getDashboard(101, '2026-01-03').profile.startWeight, 90);
    assert.equal(baselineDate(file, 101), null);

    users.setProfile(101, { currentWeight: null, currentFat: null, targetWeight: 75, targetFat: 18 }, '2026-01-03');
    assert.equal(users.getDashboard(101, '2026-01-03').profile.startWeight, 83);
    assert.equal(baselineDate(file, 101), '2026-01-02');
    users.setMeasurement(101, '2026-01-02', { currentWeight: 82 });
    assert.equal(users.getDashboard(101, '2026-01-03').profile.startWeight, 82);
    assert.equal(users.getDashboard(101, '2026-01-03').progress, 0);
    assert.deepEqual(users.getMeasurementHistory(101).legacyMeasurement, { currentWeight: 85, currentFat: 22 });
  } finally { users.close(); rmSync(dir, { recursive: true, force: true }); }
});
