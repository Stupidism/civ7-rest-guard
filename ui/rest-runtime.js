import { RestSession } from './rest-session.js';

const KEY = 'civ7-rest-guard.load-handoff.v1';
const SHARED_KEY = 'modSettings';

// Gameface recreates its JS window on loads and has no sessionStorage.
// Transfer ONE snapshot during navigation, consume it on the destination screen.
// Normal ticks/inputs never persist turns or timers.
export function handoffTransport(storage, scope) {
  // Civ VII and community settings managers require ONE top-level storage key.
  // Keep the short-lived transfer as a separate namespace inside that shared blob.
  const read = () => {
    const shared = JSON.parse(storage.getItem(SHARED_KEY) || '{}');
    if (!shared || typeof shared !== 'object' || Array.isArray(shared)) throw new Error('Invalid shared settings');
    return shared;
  };
  const write = shared => {
    if (Object.keys(shared).length) storage.setItem(SHARED_KEY, JSON.stringify(shared));
    else storage.removeItem(SHARED_KEY);
  };
  // Remove our previous version's stand-alone transfer key on upgrade.
  storage.removeItem(KEY);
  const clear = () => {
    const shared = read();
    if (KEY in shared) { delete shared[KEY]; write(shared); }
  };
  return {
    take() {
      const shared = read();
      const entry = shared[KEY];
      if (KEY in shared) { delete shared[KEY]; write(shared); }
      return entry?.destination === scope ? entry.state : null;
    },
    put(destination, state) {
      const shared = read();
      shared[KEY] = { destination, state };
      write(shared);
    },
    clear,
  };
}

const scope = UI.isInGame() ? 'game' : 'shell';
let transport;
let saved;
try { transport = handoffTransport(localStorage, scope); saved = transport.take(); }
catch (error) { console.warn('[Rest Guard] Load handoff unavailable: ' + error); }
export const session = new RestSession(saved);
let destination = null;
let warned = false;
export function checkpoint() {
  if (!destination) return;
  try { transport?.put(destination, session.export()); }
  catch (error) {
    if (!warned) console.warn('[Rest Guard] Session transfer unavailable: ' + error);
    warned = true;
  }
}
function cancelTransfer() {
  destination = null;
  try { transport?.clear(); } catch (_) {}
}
export function beginLoading() {
  session.beginLoading(Date.now()); destination = 'game'; checkpoint();
}

export function installLoadingHooks() {
  for (const name of ['loadGame', 'loadAgeTransition']) {
    try {
      const original = Network[name];
      if (typeof original !== 'function' || original.c7rLoadingHook) continue;
      const wrapped = function (...args) {
        beginLoading();
        try {
          const result = original.apply(Network, args);
          if (result === false) { session.finishLoading(Date.now()); cancelTransfer(); }
          return result;
        } catch (error) { session.finishLoading(Date.now()); cancelTransfer(); throw error; }
      };
      wrapped.c7rLoadingHook = true;
      Network[name] = wrapped;
    } catch (error) { console.warn('[Rest Guard] Load hook ' + name + ': ' + error); }
  }

  // Wrap only the final confirmed menu/desktop exits, preserving return values.
  const call = engine.call;
  if (!call.c7rExitHook) {
    const wrappedCall = function (name, ...args) {
      if (name === 'exitToMainMenu') {
        session.finishLoading(Date.now()); destination = 'shell'; checkpoint();
      } else if (name === 'exitToDesktop') cancelTransfer();
      return call.call(this, name, ...args);
    };
    wrappedCall.c7rExitHook = true;
    engine.call = wrappedCall;
  }

  const loadingChanged = () => {
    const state = UI.getGameLoadingState();
    if (destination !== 'shell' && [UIGameLoadingState.WaitingForGameplayData,
      UIGameLoadingState.WaitingForLoadingCurtain, UIGameLoadingState.WaitingForConfiguration,
      UIGameLoadingState.WaitingForGameCore, UIGameLoadingState.WaitingForVisualization,
      UIGameLoadingState.WaitingForUIReady, UIGameLoadingState.WaitingForGameUnloadScreenReady].includes(state)) {
      beginLoading();
    } else if (state === UIGameLoadingState.GameStarted || state === UIGameLoadingState.WaitingToStart) {
      session.finishLoading(Date.now()); cancelTransfer();
    }
  };
  engine.on('UIGameLoadingStateChanged', loadingChanged);
  engine.on('LoadComplete', result => {
    if (typeof SerializerResult !== 'undefined' && result?.result !== undefined &&
        result.result !== SerializerResult.RESULT_OK) {
      session.finishLoading(Date.now()); cancelTransfer();
    }
  });
  window.addEventListener('unload', checkpoint);
  loadingChanged();
  console.warn('[Rest Guard] ' + scope + ' session ' + (saved ? 'resumed' : 'new') + '; play ms: ' + session.elapsed(Date.now()));
}

