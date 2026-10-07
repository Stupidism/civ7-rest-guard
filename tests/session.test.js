import test from 'node:test';
import assert from 'node:assert/strict';
import { RestSession, IDLE_HINT_MS, IDLE_REST_MS } from '../ui/rest-session.js';
import { normalizeConfig } from '../ui/rest-model.js';

const c = normalizeConfig();
const at = (turn, context = 'game:age') => ({ turn, context, token: `${context}:${turn}` });
const minute = 60000;
const play = (s, current, config, from, minutes) => {
  s.tick(current, config, from);
  for (let i = 1; i <= minutes; i++) s.activity(current, config, from + i * minute);
};

test('four combinations of independent switches govern their own triggers', () => {
  for (const turnEnabled of [false, true]) for (const timeEnabled of [false, true]) {
    const config = normalizeConfig({ turnEnabled, timeEnabled });
    const byTurn = new RestSession();
    assert.equal(byTurn.requestTurn(at(5), config, 0), !turnEnabled);
    const byTime = new RestSession();
    play(byTime, at(4), config, 0, 25);
    assert.equal(!!byTime.pending, timeEnabled);
  }
});

test('25 minutes causes exactly one time break; a turn trigger cannot stack it', () => {
  const s = new RestSession();
  play(s, at(5), c, 0, 24);
  s.tick(at(5), c, 25 * minute - 1);
  assert.equal(s.pending, null);
  s.tick(at(5), c, 25 * minute);
  const deadline = s.pending.deadline;
  assert.equal(s.pending.reason, 'time');
  assert.equal(s.requestTurn(at(5), c, 25 * minute + 5), false);
  assert.equal(s.pending.deadline, deadline);
});

test('time break at turn 4 resets time and moves the next turn break to 9', () => {
  const s = new RestSession();
  play(s, at(4), c, 0, 25);
  assert.equal(s.complete(at(4), 30 * minute - 1), false);
  assert.equal(s.complete(at(4), 30 * minute), true);
  assert.equal(s.elapsed(30 * minute), 0);
  assert.equal(s.targetTurn(at(4), c), 9);
  assert.equal(s.requestTurn(at(5), c, 30 * minute), true);
  assert.equal(s.requestTurn(at(9), c, 30 * minute), false);
});

test('turn break at minute 24 clears the imminent time break', () => {
  const s = new RestSession();
  play(s, at(4), c, 0, 24);
  assert.equal(s.requestTurn(at(5), c, 24 * minute), false);
  assert.equal(s.complete(at(5), 29 * minute), true);
  s.tick(at(6), c, 30 * minute);
  assert.equal(s.pending, null);
  assert.equal(s.elapsed(30 * minute), minute);
});

test('one minute idle reveals duration, five minutes grants rest, waiting stays at zero', () => {
  const s = new RestSession();
  play(s, at(4), c, 0, 20);
  s.tick(at(4), c, 21 * minute);
  assert.equal(s.idle(21 * minute), IDLE_HINT_MS);
  assert.equal(s.idleRested, false);
  s.tick(at(4), c, 25 * minute);
  assert.equal(s.pending, null);
  assert.equal(s.idleRested, true);
  assert.equal(s.elapsed(25 * minute), 0);
  s.tick(at(4), c, 60 * minute);
  assert.equal(s.pending, null);
  s.activity(at(4), c, 65 * minute);
  assert.equal(s.elapsed(65 * minute), 0);
  assert.equal(s.targetTurn(at(4), c), 9);
});

test('returning from idle is credited before its input overwrites the timestamp', () => {
  const s = new RestSession();
  s.tick(at(4), c, 0);
  s.activity(at(4), c, IDLE_REST_MS);
  assert.equal(s.elapsed(IDLE_REST_MS), 0);
  assert.equal(s.idleRested, false);
  assert.equal(s.targetTurn(at(4), c), 9);
});

test('less than five idle minutes does not reset play or turn cadence', () => {
  const s = new RestSession();
  s.tick(at(4), c, 0);
  s.activity(at(4), c, IDLE_REST_MS - 1);
  assert.equal(s.elapsed(IDLE_REST_MS - 1), IDLE_REST_MS - 1);
  assert.equal(s.targetTurn(at(4), c), 5);
});

test('idle detection is disabled along with the time feature', () => {
  const s = new RestSession();
  const config = normalizeConfig({ timeEnabled: false });
  s.tick(at(4), config, 0);
  s.tick(at(4), config, 20 * minute);
  assert.equal(s.idleRested, false);
  assert.equal(s.targetTurn(at(4), config), 5);
});

test('loading saves retains 24 minutes plus a 6-minute load, without granting idle rest', () => {
  const s = new RestSession();
  play(s, at(4), c, 0, 24);
  s.beginLoading(24 * minute);
  const loaded = new RestSession(JSON.parse(JSON.stringify(s.export())));
  loaded.tick(null, c, 30 * minute);
  assert.equal(loaded.idleRested, false);
  loaded.finishLoading(30 * minute);
  loaded.tick(at(30, 'other:age'), c, 30 * minute);
  assert.equal(loaded.pending.reason, 'time');
  assert.equal(loaded.elapsed(30 * minute), 30 * minute);
});

test('first load time counts, while a fresh game process has no previous session', () => {
  const s = new RestSession();
  s.beginLoading(0);
  s.finishLoading(2 * minute);
  s.tick(at(1), c, 2 * minute);
  assert.equal(s.elapsed(2 * minute), 2 * minute);
  assert.equal(new RestSession().elapsed(2 * minute), 0);
});

test('age reset and rewind only rebase turn schedule; time survives', () => {
  const s = new RestSession();
  s.reset(at(60), 0);
  s.tick(at(3, 'game:newAge'), c, minute);
  assert.equal(s.targetTurn(at(3, 'game:newAge'), c), 5);
  assert.equal(s.elapsed(minute), minute);
  s.reset(at(15), 2 * minute);
  assert.equal(s.targetTurn(at(4), c), 5);
});

test('stage switches retain fixed boundaries after shared rest reset', () => {
  const s = new RestSession();
  s.reset(at(19), 0);
  assert.equal(s.targetTurn(at(20), c), 24);
  s.reset(at(58), 0);
  assert.equal(s.targetTurn(at(59), c), 62);
  s.reset(at(79), 0);
  assert.equal(s.targetTurn(at(80), c), 81);
  s.reset(at(80), 0);
  assert.equal(s.targetTurn(at(81), c), 81);
});

test('idle time before a forced overlay counts toward the same full idle break', () => {
  const s = new RestSession();
  play(s, at(4), c, 0, 24);
  s.tick(at(4), c, 25 * minute);
  s.tick(at(4), c, 29 * minute);
  assert.equal(s.remaining(29 * minute), 0);
  assert.equal(s.complete(at(4), 29 * minute), true);
});
