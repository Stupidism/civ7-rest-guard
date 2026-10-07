import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, scheduleAt, nextRestTurn, RestGate, formatTime } from '../ui/rest-model.js';
import { RestStore } from '../ui/rest-store.js';

const config = normalizeConfig();
const memoryStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};

test('end-of-turn schedule: first rest on turn 5, then every stage boundary through 89', () => {
  const due = Array.from({ length: 90 }, (_, i) => i).filter(t => scheduleAt(t, config).due);
  assert.deepEqual(due, [5, 10, 15, 20, 24, 28, 32, 36, 40, 43, 46, 49, 52, 55, 58,
    62, 64, 66, 68, 70, 72, 74, 76, 78, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89]);
  assert.equal(scheduleAt(0, config).due, false);
  assert.deepEqual([0, 20, 21, 40, 41, 60, 61, 80, 81, 1000].map(t => scheduleAt(t, config).interval),
    [5, 5, 4, 4, 3, 3, 2, 2, 1, 1]);
});
test('turn zero is only the starting point, even with an interval of one', () => {
  const c = normalizeConfig({ intervals: [1, 1, 1, 1, 1] });
  assert.equal(scheduleAt(0, c).due, false);
  assert.equal(scheduleAt(1, c).due, true);
  assert.equal(nextRestTurn(0, c), 1);
});
test('20-turn boundaries are fixed and legacy cumulative settings are discarded', () => {
  const c = normalizeConfig({ stageLength: 99, cumulativeAges: true });
  assert.deepEqual(Object.keys(c), ['turnEnabled', 'timeEnabled', 'playMinutes', 'restMinutes', 'intervals']);
  assert.equal(scheduleAt(20, c).stage, 0);
  assert.equal(scheduleAt(21, c).stage, 1);
});
test('custom cadence continues beyond the last finite stage', () => {
  const c = normalizeConfig({ restMinutes: 2.5, intervals: [3, 5, 2, 4, 3] });
  assert.equal(scheduleAt(83, c).due, true);
  assert.equal(scheduleAt(101, c).due, true);
  assert.equal(scheduleAt(100, c).due, false);
  assert.equal(nextRestTurn(99, c), 101);
  assert.equal(nextRestTurn(38, config), 40);
  assert.equal(nextRestTurn(59, config), 62);
  assert.equal(nextRestTurn(0, config), 5);
});
test('next rest preview agrees with due turns, including intervals longer than a stage', () => {
  for (const c of [config, normalizeConfig({ intervals: [7, 100, 9, 21, 3] }),
    normalizeConfig({ intervals: [100, 100, 100, 100, 100] })]) {
    for (let t = 0; t <= 220; t++) {
      let expected = Math.max(1, t);
      while (!scheduleAt(expected, c).due) expected++;
      assert.equal(nextRestTurn(t, c), expected, `turn ${t}, intervals ${c.intervals}`);
    }
  }
});
test('invalid settings cannot create zero intervals or unbounded locks', () => {
  const c = normalizeConfig({ restMinutes: NaN, intervals: [0, -3, Infinity, '3', 900] });
  assert.deepEqual(c.intervals, [1, 1, 3, 2, 100]);
  assert.equal(c.restMinutes, 5);
  assert.equal(normalizeConfig({ restMinutes: 0 }).restMinutes, 0.1);
  assert.equal(normalizeConfig({ restMinutes: 900 }).restMinutes, 120);
});
test('repeated submissions do not extend a break; early completion is rejected', () => {
  const gate = new RestGate();
  assert.equal(gate.attempt('a:4', 4, config, 1000), true);
  assert.equal(gate.attempt('a:5', 5, config, 1000), false);
  assert.equal(gate.attempt('a:5', 5, config, 2000), false);
  assert.equal(gate.state.pending.deadline, 301000);
  assert.equal(gate.complete(300999), false);
  assert.equal(gate.complete(301000), true);
  assert.equal(gate.attempt('a:5', 5, config, 301001), true);
  assert.equal(gate.attempt('a:10', 10, config, 301002), false);
});
test('background time counts without timer drift, but no timer is saved across sessions', () => {
  const gate = new RestGate();
  gate.attempt('t5', 5, config, 10000);
  assert.equal(gate.remaining(130000), 180000);
  assert.equal(gate.remaining(900000), 0);
  assert.equal(gate.complete(900000), true);
  const reloaded = new RestGate();
  assert.equal(reloaded.state.pending, null);
  assert.equal(reloaded.attempt('t5', 5, config, 900000), false);
  assert.equal(reloaded.remaining(900000), 300000);
});
test('an active break cannot be cancelled by a shorter setting', () => {
  const gate = new RestGate();
  gate.attempt('t5', 5, config, 0);
  assert.equal(gate.attempt('t5', 5, normalizeConfig({ restMinutes: 0.1 }), 100), false);
  assert.equal(gate.state.pending.durationMs, 300000);
});
test('clock rollback cannot extend a break beyond its original duration', () => {
  const gate = new RestGate();
  gate.attempt('t5', 5, config, 1000000);
  assert.equal(gate.remaining(0), 300000);
});
test('existing saves at turn 80 or later rest without needing any history', () => {
  const gate = new RestGate();
  assert.equal(gate.attempt('existing:80', 80, config, 0), false);
  assert.equal(gate.state.pending.durationMs, 300000);
  for (const t of [81, 82, 100, 999]) {
    assert.equal(new RestGate().attempt(`existing:${t}`, t, config, 0), false);
  }
});
test('saving preserves changes from other mods and writes settings only', () => {
  const storage = memoryStorage();
  const store = new RestStore(storage);
  storage.setItem('modSettings', JSON.stringify({ other: { volume: 9 } }));
  store.data.pending = { turn: 123 };
  store.save();
  const shared = JSON.parse(storage.getItem('modSettings'));
  assert.deepEqual(shared.other, { volume: 9 });
  assert.deepEqual(shared['civ7-rest-guard'], { version: 3, config });
});
test('upgrading removes previous turn and age records while retaining user settings', () => {
  const storage = memoryStorage({ modSettings: JSON.stringify({
    other: { value: 7 },
    'civ7-rest-guard': { version: 1,
      config: { restMinutes: 3, stageLength: 20, cumulativeAges: true, intervals: [5, 4, 3, 2, 1] },
      campaigns: { old: { ages: { a: { offset: 80, maxTurn: 20 } }, pending: { deadline: 99999 } } },
    },
  }) });
  const store = new RestStore(storage);
  const shared = JSON.parse(storage.getItem('modSettings'));
  assert.deepEqual(shared['civ7-rest-guard'], { version: 3, config: { ...config, restMinutes: 3 } });
  assert.deepEqual(shared.other, { value: 7 });
  assert.equal(store.error, false);
});
test('corrupt shared storage is never cleared or overwritten', () => {
  const storage = memoryStorage({ modSettings: 'broken json' });
  const store = new RestStore(storage, () => {});
  assert.equal(store.error, true);
  assert.equal(store.save(), false);
  assert.equal(storage.getItem('modSettings'), 'broken json');
});
test('clock display never shows zero before the break expires', () => {
  assert.equal(formatTime(300000), '05:00');
  assert.equal(formatTime(1), '00:01');
  assert.equal(formatTime(0), '00:00');
});
