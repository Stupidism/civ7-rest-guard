import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { RestGate, normalizeConfig } from '../ui/rest-model.js';
import { RestStore } from '../ui/rest-store.js';
import { RestSession } from '../ui/rest-session.js';

const source = fs.readFileSync(new URL('../ui/rest-guard.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');

function harness({ turn = 5, multiplayer = false, readonlyNative = false, storage, savedSession, startTime = 100000 } = {}) {
  const calls = { submits: 0, panelEffects: 0, inputs: 0, navigation: 0, writes: 0 };
  const clock = { now: startTime };
  const session = new RestSession(savedSession);
  const timers = [];
  const events = new Map();
  let view;
  const ctx = { hasSentTurnComplete: () => false, localPlayerID: 0,
    sendTurnComplete() { calls.submits++; } };
  if (readonlyNative) Object.defineProperty(ctx, 'sendTurnComplete', { writable: false });
  class PanelAction { sendEndTurn() { calls.panelEffects++; ctx.sendTurnComplete(); } }
  class View {
    constructor(callbacks) { this.callbacks = callbacks; this.root = { style: {} }; this.mode = null; view = this; }
    close() { this.mode = null; }
    setVisible(visible) { this.root.style.display = visible ? '' : 'none'; }
    showRest(pending) { this.mode = 'rest'; this.pending = pending; }
    updateRest(remaining) { this.remaining = remaining; }
    updateLauncher(current) { this.turn = current.turn; }
    showSettings(config, t) { this.mode = 'settings'; this.config = config; this.turn = t; }
    activate(target) { if (target === 'continue') this.callbacks.resume(); }
    destroy() {}
  }
  const data = new Map();
  const localStorage = storage || { getItem: k => data.get(k), setItem: (k, v) => { calls.writes++; data.set(k, v); } };
  const ContextManager = {
    handleInput() { calls.inputs++; return true; },
    handleNavigation() { calls.navigation++; return true; },
  };
  const sandbox = {
    RestGate, RestStore, normalizeConfig, RestView: View, PanelAction,
    session, checkpoint() {}, installLoadingHooks() {},
    ContextManager, Cursor: { target: null }, localStorage,
    Game: { turn, age: 'age1' }, GameContext: ctx,
    UI: { isInGame: () => true },
    Configuration: { getGame: () => ({ isAnyMultiplayer: multiplayer, gameSeed: 123 }) },
    Players: { isValid: () => true, get: () => ({ isHuman: true, isTurnActive: true }) },
    InputActionStatuses: { FINISH: 1 },
    document: { body: {}, querySelector: () => ({}), elementFromPoint: () => null },
    window: { addEventListener: (type, fn) => events.set(type, fn), removeEventListener() {} },
    Controls: { loadStyle() {}, decorate() {} }, console: { log() {}, warn() {} },
    setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval() {},
    Date: { now: () => clock.now },
  };
  vm.runInNewContext(source, sandbox);
  timers[0](); // The bootstrap interval observes an already attached panel.
  return { calls, clock, timers, events, sandbox, storage: localStorage, session,
    panel: new PanelAction(), view: () => view,
    input(name, target = null) {
      sandbox.Cursor.target = target;
      return ContextManager.handleInput({ detail: { name, status: 1 }, preventDefault() {}, stopImmediatePropagation() {} });
    } };
}

test('ending displayed turn 4 proceeds; ending turn 5 rests before the next turn', () => {
  const h = harness({ turn: 4 });
  h.panel.sendEndTurn();
  assert.equal(h.calls.submits, 1);
  h.sandbox.Game.turn = 5;
  h.panel.sendEndTurn();
  h.panel.sendEndTurn(); // repeated hotkey or auto-end-turn
  assert.equal(h.calls.submits, 1);
  assert.equal(h.calls.panelEffects, 1);
  assert.equal(h.view().mode, 'rest');
});
test('escape, next-turn and pointer input cannot bypass a rest; continue submits once', () => {
  const h = harness();
  h.panel.sendEndTurn();
  for (const name of ['keyboard-escape', 'force-end-turn', 'mousebutton-right', 'keyboard-enter']) {
    assert.equal(h.input(name), false);
  }
  assert.equal(h.calls.submits, 0);
  assert.equal(h.calls.inputs, 0);
  h.clock.now += 300000;
  h.input('mousebutton-left', 'continue');
  assert.equal(h.calls.submits, 1);
  assert.equal(h.calls.panelEffects, 1);
  assert.equal(h.view().mode, null);
});
test('auto-end-turn is blocked while settings are open', () => {
  const h = harness({ turn: 3 });
  h.panel.sendEndTurn();
  h.view().callbacks.openSettings();
  h.panel.sendEndTurn();
  assert.equal(h.calls.submits, 1);
  h.input('keyboard-escape');
  assert.equal(h.view().mode, null);
});
test('native direct submission is guarded when engine allows wrapping', () => {
  const h = harness();
  h.sandbox.GameContext.sendTurnComplete();
  assert.equal(h.calls.submits, 0);
  h.clock.now += 300000;
  h.view().callbacks.resume();
  assert.equal(h.calls.submits, 1);
});
test('required panel guard works when native API is read-only', () => {
  const h = harness({ readonlyNative: true });
  h.panel.sendEndTurn();
  assert.equal(h.calls.submits, 0);
  h.clock.now += 300000;
  h.view().callbacks.resume();
  assert.equal(h.calls.submits, 1);
});
test('reload transfers the same break, with remaining duration and no settings writes', () => {
  const h = harness();
  h.panel.sendEndTurn();
  assert.equal(h.calls.writes, 0);
  const reloaded = harness({ storage: h.storage, savedSession: h.session.export(), startTime: h.clock.now + 60000 });
  assert.equal(reloaded.view().mode, 'rest');
  assert.equal(reloaded.view().remaining, 240000);
  assert.equal(reloaded.calls.submits, 0);
});

test('time limit interrupts a normal turn without needing an end-turn action', () => {
  const h = harness({ turn: 4 });
  for (let i = 0; i < 25; i++) { h.clock.now += 60000; h.input('mousebutton-left'); }
  assert.equal(h.view().mode, 'rest');
  assert.equal(h.view().pending.reason, 'time');
  h.clock.now += 300000;
  h.view().callbacks.resume();
  assert.equal(h.view().mode, null);
  assert.equal(h.calls.submits, 0);
  h.sandbox.Game.turn = 5;
  h.panel.sendEndTurn();
  assert.equal(h.calls.submits, 1);
  assert.equal(h.calls.writes, 0);
});

test('mouse motion counts as activity; a five-minute idle resets both triggers', () => {
  const h = harness({ turn: 4 });
  h.clock.now += 60000;
  h.events.get('mousemove')();
  assert.equal(h.session.lastInputAt, h.clock.now);
  h.clock.now += 300000;
  h.timers[0]();
  assert.equal(h.session.idleRested, true);
  assert.equal(h.view().mode, null);
  h.input('mousebutton-left');
  assert.equal(h.session.elapsed(h.clock.now), 0);
  h.sandbox.Game.turn = 5;
  h.panel.sendEndTurn();
  assert.equal(h.calls.submits, 1);
});
test('age reset uses the game turn directly and writes no turn or timer data', () => {
  const h = harness({ turn: 80 });
  h.panel.sendEndTurn();
  assert.equal(h.calls.submits, 0);
  h.clock.now += 300000;
  h.view().callbacks.resume();
  assert.equal(h.calls.submits, 1);
  h.sandbox.Game.age = 'age2';
  h.sandbox.Game.turn = 0;
  for (const tick of h.timers) tick();
  assert.equal(h.view().turn, 0);
  h.panel.sendEndTurn();
  assert.equal(h.calls.submits, 2);
  assert.equal(h.calls.writes, 0);
});
test('multiplayer bypasses all mod UI and submission handling', () => {
  const h = harness({ multiplayer: true });
  h.panel.sendEndTurn();
  assert.equal(h.calls.submits, 1);
  assert.equal(h.view(), undefined);
  assert.equal(h.input('force-end-turn'), true);
});
