import test from 'node:test';
import assert from 'node:assert/strict';
import { workshopRoute, workshopFrameUrl, workshopStudioUrl, initialStudioView } from '../../web/avatar-shell.js';

const ORIGIN = 'http://127.0.0.1:4173';
const FIRST = 'av_12345678-1234-4321-8765-123456789abc';
const SECOND = 'av_abcdefab-abcd-4abc-8abc-abcdefabcdef';
let instance = 0;

// Only the shell's browser boundary is faked. Import the real module freshly
// for each lifecycle, so module-scoped initialization cannot leak across tests.
async function shell(t, href = `${ORIGIN}/?view=avatars&avatar=${FIRST}`) {
  const frameListeners = new Map(), windowListeners = new Map();
  const sent = [], replaced = [], assigned = [];
  let src = null;
  const child = { postMessage(data, origin) { sent.push({ data: structuredClone(data), origin }); } };
  const frame = {
    contentWindow: child,
    style: {},
    getAttribute(name) { assert.equal(name, 'src'); return src; },
    get src() { return src; },
    set src(value) { assigned.push(value); src = value; },
    addEventListener(name, listener) {
      const listeners = frameListeners.get(name) || [];
      listeners.push(listener); frameListeners.set(name, listeners);
    },
  };
  let present = true;
  const location = new URL(href);
  const globals = {
    document: { getElementById(id) { assert.equal(id, 'avatarFrame'); return present ? frame : null; } },
    window: { addEventListener(name, listener) {
      const listeners = windowListeners.get(name) || [];
      listeners.push(listener); windowListeners.set(name, listeners);
    } },
    location,
    history: { replaceState(state, title, url) {
      assert.equal(state, null); assert.equal(title, '');
      location.href = new URL(url, location).href;
      replaced.push(location.href);
    } },
  };
  const previous = new Map(Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const module = await import(`../../web/avatar-shell.js?lifecycle=${++instance}`);
  return {
    show: module.showAvatarWorkshop, frame, child, sent, replaced, assigned, location,
    frameListeners, windowListeners,
    present(value) { present = value; },
    load() { for (const listener of frameListeners.get('load') || []) listener(); },
    message(data, overrides = {}) {
      const event = { data, origin: ORIGIN, source: child, ...overrides };
      for (const listener of windowListeners.get('message') || []) listener(event);
    },
  };
}

test('legacy and Studio links resolve the same avatar; flags are explicit', () => {
  assert.deepEqual(workshopRoute(`${ORIGIN}/avatars.html?id=${FIRST}&overlay=1`), { id: FIRST, overlay: true, embedded: false });
  assert.deepEqual(workshopRoute(`${ORIGIN}/?view=avatars&avatar=${FIRST}`), { id: FIRST, overlay: false, embedded: false });
  assert.deepEqual(workshopRoute(`${ORIGIN}/avatars.html?id=${FIRST}&embedded=1`), { id: FIRST, overlay: false, embedded: true });
  assert.deepEqual(workshopRoute(`${ORIGIN}/?overlay=true&embedded=true`), { id: null, overlay: false, embedded: false });
});

test('route helpers admit only local avatar IDs and never forward arbitrary query parameters', () => {
  for (const id of ['../avatar.glb', 'https://example.com/avatar.vrm', 'av_123', 'javascript:alert(1)', `${FIRST}/other`]) {
    const href = `${ORIGIN}/avatars.html?id=${encodeURIComponent(id)}&overlay=1&embedded=1&unrelated=secret`;
    assert.equal(workshopRoute(href).id, null);
    assert.equal(workshopFrameUrl(href), '/avatars.html?embedded=1');
    assert.equal(workshopStudioUrl(href), '/?view=avatars');
  }
  const href = `${ORIGIN}/avatars.html?id=${FIRST}&overlay=1&embedded=1&unrelated=secret`;
  assert.equal(workshopFrameUrl(href), `/avatars.html?embedded=1&id=${FIRST}`);
  assert.equal(workshopStudioUrl(href), `/?view=avatars&avatar=${FIRST}`);
});

test('initial Studio view is restricted to the caller allowlist', () => {
  const allowed = ['home', 'avatars', 'workflow'];
  assert.equal(initialStudioView(`${ORIGIN}/?view=avatars&avatar=${FIRST}`, allowed), 'avatars');
  assert.equal(initialStudioView(`${ORIGIN}/?view=workflow`, allowed), 'workflow');
  for (const query of ['', '?view=unknown', '?view=__proto__', '?view=avatars.html']) {
    assert.equal(initialStudioView(`${ORIGIN}/${query}`, allowed), null);
  }
});

test('the Workshop iframe loads lazily once and preserves its document across navigation', async t => {
  const f = await shell(t);
  f.show(false);
  assert.deepEqual(f.assigned, []);
  assert.deepEqual(f.sent.at(-1), { data: { type: 'aiplay-avatar-visibility', active: false }, origin: ORIGIN });
  f.show(true);
  assert.deepEqual(f.assigned, [`/avatars.html?embedded=1&id=${FIRST}`]);
  f.load();
  assert.deepEqual(f.sent.at(-1), { data: { type: 'aiplay-avatar-visibility', active: true }, origin: ORIGIN });
  f.show(false); f.show(true); f.show(true);
  assert.equal(f.assigned.length, 1, 'returning to the page must retain its current model and unsaved edits');
  assert.equal(f.frameListeners.get('load').length, 1);
  assert.equal(f.windowListeners.get('message').length, 1);
  assert.equal(f.sent.at(-1).data.active, true);
});

test('a frame finishing its load after navigation receives the current hidden state', async t => {
  const f = await shell(t);
  f.show(true); f.show(false); f.load();
  assert.equal(f.sent.at(-1).data.active, false);
  f.show(true); f.load();
  assert.equal(f.sent.at(-1).data.active, true);
});

test('missing iframe is harmless and does not prevent later initialization', async t => {
  const f = await shell(t);
  f.present(false);
  assert.doesNotThrow(() => f.show(true));
  assert.equal(f.windowListeners.size, 0);
  assert.equal(f.sent.length, 0);
  f.present(true); f.show(true); f.load();
  assert.equal(f.assigned.length, 1);
  assert.equal(f.sent.at(-1).data.active, true);
});

test('messages require both the exact child window and the same origin', async t => {
  const f = await shell(t);
  f.show(true);
  for (const overrides of [
    { origin: 'https://example.com' },
    { origin: 'http://localhost:4173' },
    { source: {} },
    { source: null },
    { origin: ORIGIN, source: globalThis.window },
  ]) {
    f.message({ type: 'aiplay-avatar-height', height: 1400 }, overrides);
    f.message({ type: 'aiplay-avatar-selection', id: SECOND }, overrides);
  }
  assert.equal(f.frame.style.height, undefined);
  assert.equal(f.replaced.length, 0);
  f.message({ type: 'aiplay-avatar-height', height: 1400 });
  f.message({ type: 'aiplay-avatar-selection', id: SECOND });
  assert.equal(f.frame.style.height, '1400px');
  assert.equal(f.location.searchParams.get('avatar'), SECOND);
});

test('height messages are finite numbers, rounded and bounded', async t => {
  const f = await shell(t);
  f.show(true);
  for (const [height, expected] of [[1200.2, '1201px'], [10, '400px'], [-100, '400px'], [30000, '20000px']]) {
    f.message({ type: 'aiplay-avatar-height', height });
    assert.equal(f.frame.style.height, expected);
  }
  for (const height of [NaN, Infinity, -Infinity, '1000', null, undefined, {}, []]) {
    f.message({ type: 'aiplay-avatar-height', height });
    assert.equal(f.frame.style.height, '20000px');
  }
  for (const data of [null, undefined, {}, { type: 'unrelated', height: 1234 }]) assert.doesNotThrow(() => f.message(data));
  assert.equal(f.frame.style.height, '20000px');
});

test('selection updates the active deep link without discarding other page state', async t => {
  const f = await shell(t, `${ORIGIN}/?view=avatars&avatar=${FIRST}&context=kept#anchor`);
  f.show(true);
  f.message({ type: 'aiplay-avatar-selection', id: SECOND });
  assert.equal(f.replaced.length, 1);
  assert.equal(f.location.searchParams.get('avatar'), SECOND);
  assert.equal(f.location.searchParams.get('view'), 'avatars');
  assert.equal(f.location.searchParams.get('context'), 'kept');
  assert.equal(f.location.hash, '#anchor');
  for (const id of ['', 'other', '../escape', null, undefined]) f.message({ type: 'aiplay-avatar-selection', id });
  assert.equal(f.replaced.length, 1);
  f.show(false);
  f.location.searchParams.set('view', 'create');
  f.message({ type: 'aiplay-avatar-selection', id: FIRST });
  assert.equal(f.replaced.length, 1, 'a late child selection must not send the user back to a hidden page');
  assert.equal(f.location.searchParams.get('view'), 'create');
});
