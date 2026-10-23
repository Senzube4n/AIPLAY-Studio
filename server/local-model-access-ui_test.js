/** Browser behavior fixtures only: no login, provider request or download. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountLocalModelAccess, openLocalModelAccess, updateLocalModelAccess, requestLocalModelAccess } from '../web/local-model-access.js';
import { selectionFor } from './setup-plan.js';
import { defaultModelSelection } from '../shared/model-profiles.js';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const tick = () => new Promise(resolve => setImmediate(resolve));
class Control {
  value = ''; checked = false; disabled = false; hidden = false; textContent = ''; className = '';
  listeners = new Map();
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  fire(type) { return this.listeners.get(type)?.({ preventDefault() {} }); }
  set innerHTML(_value) { throw Error('Use textContent for provider or secret metadata'); }
}
const initial = () => ({ capability: 'videoLtx', auth: { set: false, usable: false },
  access: { state: 'not-connected', message: 'Connect a read token.' },
  files: { totalBytes: 39689918812, missingBytes: 39689918812, ready: false },
  modelsDir: 'D:/Models', diskFree: { freeBytes: 60e9 }, installing: false });
const authorized = () => ({ ...initial(), auth: { set: true, usable: true, method: 'dpapi', encrypted: true,
  hint: '…abcd', said: 'Using the token …abcd saved in Studio.', protection: 'Encrypted with Windows DPAPI.' },
  access: { state: 'granted', message: '' } });
function fixture(request, options = {}) {
  const controls = Object.fromEntries(['Token','Form','Connect','Forget','Check','Terms','Install','Cancel','State','Message','Saved','Storage','Protection','Total','Missing','Destination','Free','Close']
    .map(name => [name, new Control()]));
  let nav = 0, changed = 0;
  const root = { hidden: true, querySelector: sel => controls[sel.replace('#ltxAccess', '')],
    scrollIntoView() {}, focus() { this.focused = true; } };
  const doc = { getElementById: id => id === 'localModelAccess' ? root : null,
    querySelector: () => ({ click() { nav++; } }) };
  root.ownerDocument = doc;
  const controller = mountLocalModelAccess(root, { request, changed() { changed++; }, ...options });
  return { controls, root, doc, controller, nav: () => nav, changed: () => changed };
}

test('mount, paint and navigation make no authentication or download request', async () => {
  const calls = [], f = fixture(async (action, fields) => { calls.push({ action, fields }); return initial(); });
  assert.equal(calls.length, 0);
  updateLocalModelAccess({ capabilities: [] }, f.doc);
  assert.equal(calls.length, 0);
  await openLocalModelAccess(f.doc);
  assert.equal(f.nav(), 1);
  assert.equal(f.root.hidden, false);
  assert.equal(f.root.focused, true);
  assert.deepEqual(calls, [{ action: undefined, fields: undefined }]);
  assert.equal(f.controls.Total.textContent, '39.69 GB');
  assert.equal(f.controls.Destination.textContent, 'D:/Models');
  assert.equal(f.controls.Install.disabled, true);
  assert.equal(f.controls.Check.disabled, true);
});

test('an entered token is cleared before awaiting and no token is painted after rejection', async () => {
  const secret = 'hf_example_private_token', calls = [];
  let f;
  f = fixture(async (action, fields) => {
    calls.push({ action, fields });
    if (!action) return initial();
    assert.equal(f.controls.Token.value, '', 'cleared before any pending request');
    throw Error(`Rejected ${fields.token}`);
  });
  await f.controller.show();
  f.controls.Token.value = secret; f.controls.Token.fire('input');
  assert.equal(f.controls.Connect.disabled, false);
  f.controls.Form.fire('submit'); await tick();
  assert.equal(calls[1].action, 'connect');
  assert.deepEqual(calls[1].fields, { token: secret });
  assert.equal(f.controls.Token.value, '');
  for (const control of Object.values(f.controls)) assert.ok(!control.textContent.includes(secret));
  assert.match(f.controls.Message.textContent, /\[redacted\]/);
  assert.equal(f.changed(), 0);
});

test('saved-token provenance is visible; only a separate terms-confirmed press installs', async () => {
  const calls = [], f = fixture(async (action, fields) => {
    calls.push({ action, fields });
    return action === 'install' ? { ...authorized(), installing: true } : authorized();
  });
  await f.controller.show();
  assert.match(f.controls.Saved.textContent, /…abcd/);
  assert.equal(f.controls.Protection.textContent, 'Encrypted with Windows DPAPI.');
  assert.equal(f.controls.Storage.textContent, 'Windows encrypted');
  assert.equal(f.controls.Install.disabled, true);
  f.controls.Check.fire('click'); await tick();
  assert.equal(calls.at(-1).action, 'check');
  assert.equal(calls.some(c => c.action === 'install'), false);
  f.controls.Install.fire('click'); await tick();
  assert.equal(calls.some(c => c.action === 'install'), false);
  f.controls.Terms.checked = true; f.controls.Terms.fire('change');
  f.controls.Install.fire('click'); await tick();
  assert.deepEqual(calls.at(-1), { action: 'install', fields: { acceptLicense: true } });
  assert.equal(f.controls.Install.disabled, true);
  assert.equal(f.controls.Cancel.hidden, false);
  assert.equal(f.changed(), 1);
  f.controls.Install.fire('click'); await tick();
  assert.equal(calls.filter(c => c.action === 'install').length, 1, 'progress cannot queue another install');
  f.controls.Cancel.fire('click'); await tick();
  assert.equal(calls.at(-1).action, 'cancel');
  assert.equal(f.changed(), 2);
  updateLocalModelAccess({ capabilities: [{ id: 'videoLtx', totalBytes: 39689918812,
    haveBytes: 39689918812, ready: true }], disk: { freeBytes: 20e9 } }, f.doc);
  assert.equal(f.controls.State.textContent, 'Files ready');
  assert.equal(f.controls.Cancel.hidden, true);
});

test('access-required and network states do not arm installation or expose hidden token fields', async () => {
  for (const state of ['access-required', 'network', 'unauthorized']) {
    const data = { ...authorized(), access: { state, message: 'Check publisher access.' } };
    data.auth.token = 'hf_not_a_browser_field';
    const f = fixture(async () => data);
    await f.controller.show();
    f.controls.Terms.checked = true; f.controls.Terms.fire('change');
    assert.equal(f.controls.Install.disabled, true, state);
    assert.equal(f.controls.Token.value, '');
    for (const control of Object.values(f.controls)) assert.ok(!control.textContent.includes(data.auth.token));
  }
});

test('a replacement token rejected with HTTP403 replaces stale granted state and remains forgettable', async () => {
  const denied = { ...authorized(), access: { state: 'access-required', message: 'Accept publisher access.' }, error: 'Publisher access is required.' };
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, '/api/models/access');
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { id: 'videoLtx', action: 'connect', token: 'hf_replacement_mock' });
      return new Response(JSON.stringify(denied), { status: 403 });
    };
    let loaded = false;
    const f = fixture(async (action, fields) => {
      if (!loaded) { loaded = true; return authorized(); }
      return requestLocalModelAccess(action, fields);
    });
    await f.controller.show();
    f.controls.Terms.checked = true; f.controls.Terms.fire('change');
    assert.equal(f.controls.Install.disabled, false);
    f.controls.Token.value = 'hf_replacement_mock'; f.controls.Token.fire('input');
    f.controls.Form.fire('submit'); await tick();
    assert.equal(f.controls.State.textContent, 'Publisher access needed');
    assert.equal(f.controls.Install.disabled, true);
    assert.equal(f.controls.Forget.disabled, false, 'the rejected saved token can be removed');
    assert.equal(f.controls.Token.value, '');
  } finally { globalThis.fetch = oldFetch; }
});

test('an ordinary Models failure is shown and resumes only after a deliberate press', async () => {
  const calls = [], f = fixture(async (action, fields) => { calls.push({ action, fields }); return authorized(); });
  await f.controller.show();
  f.controls.Terms.checked = true; f.controls.Terms.fire('change');
  updateLocalModelAccess({ capabilities: [{ id: 'videoLtx', totalBytes: 39689918812, haveBytes: 2e9,
    ready: false, progress: { state: 'failed', error: 'Connection stopped; partial files retained.' } }] }, f.doc);
  assert.equal(f.controls.Message.textContent, 'Connection stopped; partial files retained.');
  assert.equal(f.controls.Install.textContent, 'Resume download');
  assert.equal(calls.length, 1, 'painting failed progress does not start anything');
  f.controls.Install.fire('click'); await tick();
  assert.deepEqual(calls.at(-1), { action: 'install', fields: { acceptLicense: true } });
});

test('pending installs poll local status and show async preflight failure without reopening or rechecking access', async () => {
  const calls = [], timers = [];
  let pending = false;
  const f = fixture(async (action, fields) => {
    calls.push({ action, fields });
    if (action === 'install') { pending = true; return { ...authorized(), installing: true, install: { state: 'installing' } }; }
    return pending ? { ...authorized(), install: { state: 'failed', message: 'Check free space and other downloads, then retry.' } } : authorized();
  }, { setTimer: fn => { timers.push(fn); return 1; }, clearTimer() {} });
  await f.controller.show();
  f.controls.Terms.checked = true; f.controls.Terms.fire('change');
  f.controls.Install.fire('click'); await tick();
  assert.equal(timers.length, 1);
  await timers[0]();
  assert.equal(f.controls.State.textContent, 'Download failed');
  assert.equal(f.controls.Message.textContent, 'Check free space and other downloads, then retry.');
  assert.equal(f.controls.Install.textContent, 'Resume download');
  assert.equal(f.controls.Install.disabled, false);
  assert.deepEqual(calls.map(c => c.action), [undefined, 'install', undefined]);
  assert.equal(timers.length, 1, 'polling stops after failure');
  f.controller.hide();
});

test('hiding a pending setup stops its local status polling', async () => {
  let calls = 0;
  const timers = [], f = fixture(async () => { calls++; return { ...authorized(), installing: true }; },
    { setTimer: fn => { timers.push(fn); return 1; }, clearTimer() {} });
  await f.controller.show();
  assert.equal(calls, 1);
  f.controller.hide();
  await timers[0]();
  assert.equal(calls, 1);
});

test('file-permissions protection is not called encrypted, and insufficient disk blocks install', async () => {
  const data = authorized();
  data.auth = { ...data.auth, encrypted: false, method: 'file-permissions', protection: 'Not encrypted: file permissions only.' };
  data.diskFree.freeBytes = 2e9;
  data.modelsDir = '<img src=x onerror=bad()> / Models';
  const f = fixture(async () => data);
  await f.controller.show();
  assert.equal(f.controls.Protection.textContent, 'Not encrypted: file permissions only.');
  assert.equal(f.controls.Storage.textContent, 'Not encrypted');
  assert.equal(f.controls.Destination.textContent, data.modelsDir);
  f.controls.Terms.checked = true; f.controls.Terms.fire('change');
  assert.equal(f.controls.Install.disabled, true);
  assert.match(f.controls.Message.textContent, /more free space/);
  f.controls.Token.value = 'hf_private_unsaved'; f.controller.hide();
  assert.equal(f.controls.Token.value, '');
});

test('fresh local plans omit gated video; saved local choices and cloud defaults are preserved', () => {
  assert.deepEqual(selectionFor({}, 'local'), { music: 'yue2-comfy', pictures: 'sdxl-turbo' });
  const config = { modelSetup: { local: { video: 'ltx25' } }, cloudSetup: { goal: 'all' }, music: {} };
  const saved = JSON.stringify(config);
  assert.deepEqual(selectionFor(config, 'local'), { video: 'ltx25' });
  assert.deepEqual(selectionFor(config, 'runpod'), defaultModelSelection('all', {}));
  assert.equal(selectionFor(config, 'runpod').video, 'ltx25');
  assert.equal(JSON.stringify(config), saved);
});

test('the planner and Models buttons navigate to a mounted inline card using existing UI classes', () => {
  const planner = source('../web/setup-plan.js'), app = source('../web/app.js'), html = source('../web/index.html');
  assert.match(planner, /button\.disabled = !modeMatches;/);
  assert.match(planner, /if \(p\.id === 'ltx25'\) button\.setAttribute\('data-local-model-access', 'videoLtx'\)/);
  assert.match(app, /data-local-model-access="videoLtx"/);
  assert.match(html, /id="localModelAccess" hidden class="pcard"/);
  assert.ok(html.indexOf('id="localModelAccess"') < html.indexOf('id="modelList"'));
  assert.match(html, /id="ltxAccessToken" type="password" autocomplete="off"/);
  const module = source('../web/local-model-access.js');
  assert.doesNotMatch(module, /localStorage|sessionStorage|innerHTML|hf auth|fetch_ltx25|\/api\/runpod/);
  assert.match(module, /id: 'videoLtx', action/);
  assert.match(module, /Content-Type': 'application\/json'/);
});
