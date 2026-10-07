import test from 'node:test';
import assert from 'node:assert/strict';
import { RestView } from '../ui/rest-view.js';

function viewHarness() {
  globalThis.document = { createElement() {
    const attrs = new Map();
    const events = new Map();
    return {
      setAttribute: (k, v) => attrs.set(k, v), getAttribute: k => attrs.get(k),
      addEventListener: (k, fn) => events.set(k, fn),
      fire(name) { events.get(name)?.(); }, closest() { return this; },
    };
  } };
  const view = Object.create(RestView.prototype);
  Object.assign(view, { actions: new Map(), sequence: 0, root: { contains: () => true } });
  return view;
}

test('one native modal click changes a setting once despite component and DOM notifications', () => {
  const view = viewHarness();
  view.modal = { contains: () => true };
  let restMinutes = 5;
  const button = view.button('−', () => { restMinutes -= 0.5; });
  view.activate(button); // ContextManager's guarded engine FINISH event.
  button.fire('action-activate');
  button.fire('click');
  assert.equal(restMinutes, 4.5);
  button.setAttribute('disabled', 'true');
  view.activate(button);
  assert.equal(restMinutes, 4.5);
  delete globalThis.document;
});

test('HUD activation opens settings once and ignores the following DOM click', () => {
  const view = viewHarness();
  view.root.contains = () => false; // HUD is docked outside the modal root.
  let opens = 0;
  view.launcher = view.button('休息设置', () => { opens++; view.modal = { contains: () => false }; }, '', 'fxs-activatable');
  view.launcher.fire('action-activate');
  view.launcher.fire('click');
  assert.equal(opens, 1);
  delete globalThis.document;
});
