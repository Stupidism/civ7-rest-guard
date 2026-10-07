import { normalizeConfig } from './rest-model.js';
import { RestStore } from './rest-store.js';
import { session, checkpoint, installLoadingHooks } from './rest-runtime.js';

installLoadingHooks();
let config = normalizeConfig();
try { config = new RestStore(localStorage).data.config; } catch (_) {}
const activity = () => {
  if (session.startedAt === null) return;
  session.activity(null, config, Date.now());
};
for (const name of ['mousemove', 'keydown', 'mousedown', 'wheel', 'touchstart', 'engine-input', 'navigate-input']) {
  window.addEventListener(name, activity, true);
}
const timer = setInterval(() => {
  if (session.startedAt !== null) { session.tick(null, config, Date.now()); checkpoint(); }
}, 1000);
window.addEventListener('unload', () => { clearInterval(timer); checkpoint(); });
