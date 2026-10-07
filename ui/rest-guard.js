import { PanelAction } from '/base-standard/ui/action/panel-action.js';
import { ContextManager } from '/core/ui/context-manager/context-manager.js';
import Cursor from '/core/ui/input/cursor.js';
import { normalizeConfig } from './rest-model.js';
import { session, checkpoint, installLoadingHooks } from './rest-runtime.js';
import { RestStore } from './rest-store.js';
import { RestView } from './rest-view.js';

const PREFIX = '[Rest Guard]';
let controller = null;
installLoadingHooks();

function snapshot() {
  if (!UI.isInGame() || Configuration.getGame().isAnyMultiplayer ||
      !Players.isValid(GameContext.localPlayerID)) return null;
  const player = Players.get(GameContext.localPlayerID);
  if (!player?.isHuman) return null;
  const seed = Configuration.getGame().gameSeed;
  if (seed === undefined || seed === null || !Number.isFinite(Game.turn)) return null;
  const key = `game:${seed}:player:${GameContext.localPlayerID}`;
  return {
    key, turn: Math.max(0, Math.floor(Game.turn)),
    context: `${key}:age:${Game.age}`,
    token: `${key}:age:${Game.age}:turn:${Game.turn}`,
    active: player.isTurnActive,
  };
}

class RestController {
  constructor() {
    let storage;
    try { storage = localStorage; } catch (_) {
      storage = { getItem: () => null, setItem: () => { throw new Error('localStorage unavailable'); } };
    }
    this.store = new RestStore(storage);
    this.view = new RestView({
      openSettings: () => this.openSettings(),
      closeSettings: () => this.view.close(),
      saveSettings: draft => this.saveSettings(draft),
      resume: () => this.resume(),
    });
    this.key = null;
    this.queued = null;
    this.tick = this.tick.bind(this);
    this.timer = setInterval(this.tick, 250);
    this.tick();
    console.warn(`${PREFIX} Ready. Independent turn/time triggers; shared rest reset; single-player only.`);
  }

  sync() {
    const current = snapshot();
    if (!current) {
      this.view.setVisible(false);
      return null;
    }
    this.view.setVisible(true);
    if (this.key !== current.key) {
      if (this.view.mode !== 'rest') this.view.close();
      this.queued = null;
      this.key = current.key;
    }
    return current;
  }

  tick() {
    const current = this.sync();
    if (!current) return;
    session.tick(current, this.store.data.config, Date.now());
    const pending = session.pending;
    if (pending) {
      this.view.showRest(pending);
      this.view.updateRest(session.remaining(Date.now()), pending.durationMs);
    }
    this.view.updateLauncher(current, this.store.data.config, this.store.error, session, Date.now());
    checkpoint();
  }

  request(submit) {
    const current = this.sync();
    if (!current) return submit();
    if (GameContext.hasSentTurnComplete()) return;
    if (this.view.mode === 'settings') return;
    if (!current.active && !session.pending) return submit();
    const allowed = session.requestTurn(current, this.store.data.config, Date.now());
    if (allowed) return submit();
    this.queued = { token: current.token, submit };
    this.tick();
  }

  resume() {
    const current = this.sync();
    if (!session.complete(current, Date.now())) return;
    const queued = this.queued;
    this.queued = null;
    this.view.close();
    if (queued && current?.token === queued.token && current.active && !GameContext.hasSentTurnComplete()) {
      queued.submit();
    }
    this.tick();
  }

  openSettings() {
    const current = this.sync();
    if (!current || session.pending) return;
    this.view.showSettings(this.store.data.config, current.turn);
  }

  saveSettings(draft) {
    if (session.pending) return;
    const wasTimeEnabled = this.store.data.config.timeEnabled;
    this.store.data.config = normalizeConfig(draft);
    if (!wasTimeEnabled && this.store.data.config.timeEnabled) {
      session.startedAt = Date.now(); session.lastInputAt = Date.now(); session.idleRested = false;
    }
    if (this.store.save()) {
      this.view.close();
      this.tick();
    } else {
      this.view.notice.textContent = '设置在本次游戏已生效，但未能持久保存；请检查 UI 日志或存储权限。';
    }
  }

  isModal() { return !!snapshot() && !!this.view.mode; }

  activity() {
    const current = this.sync();
    if (!current) return;
    session.activity(current, this.store.data.config, Date.now());
    this.tick();
  }

  handleInput(event) {
    const d = event.detail;
    if (d?.status === InputActionStatuses.FINISH) {
      if (['mousebutton-left', 'touch-tap'].includes(d.name)) {
        const target = d.isTouch ? document.elementFromPoint(d.x, d.y) : Cursor.target;
        this.view.activate(target);
      } else if (['keyboard-enter', 'accept'].includes(d.name) && this.view.mode === 'rest') {
        this.resume();
      } else if (['keyboard-escape', 'cancel'].includes(d.name) && this.view.mode === 'settings') {
        this.view.close();
      }
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    return false;
  }

  destroy() { clearInterval(this.timer); this.view.destroy(); }
}

function ensureController() {
  if (!controller && document.body && snapshot()) controller = new RestController();
  return controller;
}

// Patch the actual standard-game submit method, before its wait-state/age-transition
// side effects. Mouse, next-action hotkey, force-end-turn and auto-end-turn use it.
const originalEndTurn = PanelAction.prototype.sendEndTurn;
PanelAction.prototype.sendEndTurn = function (...args) {
  const submit = () => originalEndTurn.apply(this, args);
  const active = ensureController();
  return active ? active.request(submit) : submit();
};

// Optional second guard for other UI components that call the engine directly.
// Some builds expose read-only native methods, so the standard-panel hook above
// is the required path; native patch installation is verified before reporting it.
let directGuardInstalled = false;
try {
  const originalComplete = GameContext.sendTurnComplete;
  const guardedComplete = function (...args) {
    const submit = () => originalComplete.apply(GameContext, args);
    const active = ensureController();
    return active ? active.request(submit) : submit();
  };
  GameContext.sendTurnComplete = guardedComplete;
  directGuardInstalled = GameContext.sendTurnComplete === guardedComplete;
} catch (error) { console.warn(`${PREFIX} Native submit guard unavailable: ${error}`); }
console.warn(`${PREFIX} Standard turn hook installed; native guard: ${directGuardInstalled}`);

// Intercept before the game dispatches input to map, focus target or global hotkeys.
const originalInput = ContextManager.handleInput;
ContextManager.handleInput = function (event) {
  ensureController()?.activity();
  if (controller?.isModal()) return controller.handleInput(event);
  return originalInput.call(this, event);
};
const originalNavigation = ContextManager.handleNavigation;
ContextManager.handleNavigation = function (event) {
  ensureController()?.activity();
  if (controller?.isModal()) {
    event.preventDefault();
    return false;
  }
  return originalNavigation.call(this, event);
};

// Catch DOM input and direct hotkey dispatches as well as engine-routed input.
const domGuard = event => {
  ensureController()?.activity();
  if (!controller?.isModal()) return;
  if (event.type === 'keydown') {
    if (event.key === 'Escape' && controller.view.mode === 'settings') controller.view.close();
    else if (event.key === 'Enter' && controller.view.mode === 'rest') controller.resume();
  }
  // Allow the overlay's DOM click handlers, but never the underlying map.
  if (['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'wheel'].includes(event.type) &&
      controller.view.modal?.contains(event.target)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
};
const guardedEvents = ['keydown', 'keyup', 'click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup',
  'wheel', 'contextmenu', 'hotkey-next-action', 'action-next-action'];
for (const type of guardedEvents) window.addEventListener(type, domGuard, true);
// Mouse motion does not pass through the engine action dispatcher.
let lastMotionAt = 0;
const motion = () => {
  const now = Date.now();
  if (now - lastMotionAt < 200) return;
  lastMotionAt = now;
  ensureController()?.activity();
};
for (const type of ['mousemove', 'pointermove', 'touchmove']) window.addEventListener(type, motion, true);

Controls.loadStyle('fs://game/civ7-rest-guard/ui/rest-guard.css');
Controls.decorate('panel-action', () => ({
  beforeAttach() { ensureController(); },
  afterAttach() { ensureController()?.tick(); },
  beforeDetach() {},
  afterDetach() {},
}));
// UIScripts can be loaded after an existing component has already been attached.
const bootstrapTimer = setInterval(() => {
  if (document.querySelector('panel-action')) ensureController()?.tick();
}, 1000);
window.addEventListener('unload', () => {
  clearInterval(bootstrapTimer);
  controller?.destroy();
  checkpoint();
  for (const type of ['mousemove', 'pointermove', 'touchmove']) window.removeEventListener(type, motion, true);
  for (const type of guardedEvents) window.removeEventListener(type, domGuard, true);
});
