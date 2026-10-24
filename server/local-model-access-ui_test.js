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
const initial = () => ({ capability: 'videoLtx', auth: { set: false, usable: false }, oauth: { state: 'idle', message: '' },
  access: { state: 'not-connected', message: 'Connect a read token.' },
  files: { totalBytes: 39689918812, missingBytes: 39689918812, ready: false },
  modelsDir: 'D:/Models', diskFree: { freeBytes: 60e9 }, installing: false });
const authorized = () => ({ ...initial(), auth: { set: true, usable: true, method: 'dpapi', encrypted: true,
  hint: '…abcd', said: 'Using the token …abcd saved in Studio.', protection: 'Encrypted with Windows DPAPI.' },
  access: { state: 'granted', message: '' } });
function fixture(request, options = {}) {
  const controls = Object.fromEntries(['Login','LoginCancel','Token','Form','Connect','Forget','Check','Terms','Install','Cancel','State','Message','Saved','Storage','Protection','Total','Missing','Destination','Free','Close']
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

const waiting = () => ({ ...initial(), oauth: { state: 'waiting', message: 'Finish signing in on Hugging Face.',
  authorizationUrl: 'https://huggingface.co/oauth/authorize?client_id=studio&response_type=code&code_challenge=mock' } });
const signedIn = () => ({ ...authorized(), auth: { ...authorized().auth, kind: 'oauth', said: 'Signed in with Hugging Face.' },
  oauth: { state: 'connected', message: 'Signed in.' } });
function popupFixture() {
  const navigations = [];
  const popup = { opener: {}, closed: false, focus() {}, close() { this.closed = true; },
    location: { set href(value) { navigations.push(value); } } };
  return { popup, navigations };
}

test('browser login opens its detached popup synchronously before POST and uses only its HF authorization URL', async () => {
  const calls = [], p = popupFixture();
  let opened = false;
  const f = fixture(async action => {
    calls.push(action);
    if (!action) return initial();
    assert.equal(opened, true, 'popup created before the first async request');
    assert.equal(p.popup.opener, null, 'authorization page cannot reach Studio through opener');
    return waiting();
  }, { openPopup() { opened = true; return p.popup; } });
  await f.controller.show();
  f.controls.Login.fire('click');
  assert.equal(opened, true, 'click opens before it returns');
  await tick();
  assert.deepEqual(calls, [undefined, 'login']);
  assert.deepEqual(p.navigations, [waiting().oauth.authorizationUrl]);
  assert.equal(f.controls.LoginCancel.hidden, false);
  assert.equal(f.controls.Install.disabled, true);
  assert.equal(f.controls.Terms.checked, false);
  for (const c of Object.values(f.controls)) assert.ok(!c.textContent.includes('code_challenge'));
  f.controller.hide();
});

test('a blocked popup makes no login request and gives a deliberate retry', async () => {
  const calls = [], f = fixture(async action => { calls.push(action); return initial(); }, { openPopup: () => null });
  await f.controller.show();
  f.controls.Login.fire('click'); await tick();
  assert.deepEqual(calls, [undefined]);
  assert.match(f.controls.Message.textContent, /Allow pop-ups/);
  assert.equal(f.controls.Login.disabled, false);
});

test('returned authorization links cannot navigate to another origin, credentials, protocol or path', async () => {
  for (const url of ['http://huggingface.co/oauth/authorize', 'https://huggingface.co.evil.test/oauth/authorize',
    'https://user:pass@huggingface.co/oauth/authorize', 'https://huggingface.co/settings/tokens', 'javascript:bad()', undefined]) {
    const p = popupFixture();
    const f = fixture(async action => action ? { ...waiting(), oauth: { ...waiting().oauth, authorizationUrl: url } } : initial(),
      { openPopup: () => p.popup });
    await f.controller.show(); f.controls.Login.fire('click'); await tick();
    assert.deepEqual(p.navigations, [], String(url));
    assert.equal(p.popup.closed, true);
    assert.match(f.controls.Message.textContent, /could not be opened/);
    assert.equal(f.controls.Install.disabled, true);
  }
});

test('cancel remains usable during login start and a late start cannot navigate or reconnect', async () => {
  const calls = [], p = popupFixture();
  let finishStart;
  const f = fixture(async action => {
    calls.push(action);
    if (action === 'login') return new Promise(resolve => { finishStart = resolve; });
    return action === 'login-cancel' ? { ...initial(), oauth: { state: 'cancelled', message: 'Sign-in cancelled.' } } : initial();
  }, { openPopup: () => p.popup });
  await f.controller.show(); f.controls.Login.fire('click');
  assert.equal(f.controls.LoginCancel.disabled, false);
  assert.equal(f.controls.LoginCancel.hidden, false);
  f.controls.LoginCancel.fire('click'); await tick();
  assert.equal(p.popup.closed, true);
  finishStart(waiting()); await tick();
  assert.deepEqual(calls, [undefined, 'login', 'login-cancel']);
  assert.deepEqual(p.navigations, []);
  assert.equal(f.controls.State.textContent, 'Sign-in cancelled');
  assert.equal(f.controls.Login.disabled, false);
  assert.equal(f.controls.LoginCancel.hidden, true);
});

test('offline waiting and callback-check status are polled until access finishes without accepting terms or installing', async () => {
  const timers = [], calls = [], p = popupFixture();
  let phase = 0;
  const f = fixture(async action => {
    calls.push(action);
    if (action === 'login') { phase = 1; return waiting(); }
    if (phase++ === 1) return { ...signedIn(), access: { state: 'checking', message: 'Checking access.' } };
    return phase > 2 ? signedIn() : initial();
  }, { openPopup: () => p.popup, setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer() {} });
  await f.controller.show(); f.controls.Login.fire('click'); await tick();
  assert.equal(timers.length, 1);
  await timers[0]();
  assert.equal(f.controls.State.textContent, 'Checking access');
  assert.equal(p.popup.closed, true);
  assert.equal(timers.length, 2);
  await timers[1]();
  assert.equal(f.controls.State.textContent, 'Access ready');
  assert.equal(f.controls.Saved.textContent, 'Signed in with Hugging Face.');
  assert.equal(f.controls.Forget.textContent, 'Disconnect');
  assert.equal(f.controls.Protection.textContent, 'Encrypted with Windows DPAPI.');
  assert.equal(f.controls.Install.disabled, true, 'sign-in cannot accept publisher terms');
  assert.equal(f.controls.Terms.checked, false);
  assert.deepEqual(calls, [undefined, 'login', undefined, undefined]);
  assert.equal(timers.length, 2, 'grant stops saved-status polling');
  const reused = signedIn();
  reused.auth.savedHere = false;
  reused.auth.said = 'Signed in with Hugging Face. Saved by another copy of Studio.';
  const other = fixture(async () => reused);
  await other.controller.show();
  assert.equal(other.controls.Saved.textContent, reused.auth.said, 'server-owned copy provenance remains visible');
});

test('manually closing the popup does not cancel a completed provider login', async () => {
  const timers = [], calls = [], p = popupFixture();
  let started = false;
  const f = fixture(async action => {
    calls.push(action);
    if (action === 'login') { started = true; return waiting(); }
    return started ? signedIn() : initial();
  }, { openPopup: () => p.popup, setTimer: fn => { timers.push(fn); return 1; }, clearTimer() {} });
  await f.controller.show(); f.controls.Login.fire('click'); await tick(); p.popup.close();
  await timers[0]();
  assert.equal(f.controls.State.textContent, 'Access ready');
  assert.equal(calls.includes('login-cancel'), false);
  assert.equal(calls.includes('install'), false);
});

test('expired, declined and failed logins stop polling and can be retried', async () => {
  for (const [state, label] of [['expired', 'Sign-in expired'], ['denied', 'Sign-in declined'], ['error', 'Sign-in failed']]) {
    const timers = [], p = popupFixture(); let started = false;
    const f = fixture(async action => {
      if (action === 'login') { started = true; return waiting(); }
      return started ? { ...initial(), oauth: { state, message: 'Sign in again to continue.' } } : initial();
    }, { openPopup: () => p.popup, setTimer: fn => { timers.push(fn); return 1; }, clearTimer() {} });
    await f.controller.show(); f.controls.Login.fire('click'); await tick(); await timers[0]();
    assert.equal(f.controls.State.textContent, label);
    assert.equal(f.controls.Login.disabled, false);
    assert.equal(p.popup.closed, true);
    assert.equal(timers.length, 1);
  }
});

test('cancellation invalidates an in-flight saved-status response', async () => {
  const timers = [], p = popupFixture(); let started = false, finishPoll;
  const f = fixture(async action => {
    if (action === 'login') { started = true; return waiting(); }
    if (action === 'login-cancel') return { ...initial(), oauth: { state: 'cancelled' } };
    return started ? new Promise(resolve => { finishPoll = resolve; }) : initial();
  }, { openPopup: () => p.popup, setTimer: fn => { timers.push(fn); return 1; }, clearTimer() {} });
  await f.controller.show(); f.controls.Login.fire('click'); await tick();
  const poll = timers[0]();
  f.controls.LoginCancel.fire('click'); await tick(); finishPoll(signedIn()); await poll;
  assert.equal(f.controls.State.textContent, 'Sign-in cancelled');
  assert.equal(f.controls.Install.disabled, true);
  assert.equal(f.controls.Saved.textContent, 'Not connected to Hugging Face.');
});

test('hidden tabs suspend saved-login polling and visibility return resumes local status only', async () => {
  const timers = [], calls = [], f = fixture(async action => { calls.push(action); return waiting(); },
    { setTimer: fn => { timers.push(fn); return 1; }, clearTimer() {} });
  await f.controller.show(); f.doc.hidden = true; f.controller.visibilityChanged();
  await timers[0]();
  assert.equal(calls.length, 1);
  f.doc.hidden = false; await f.controller.visibilityChanged();
  assert.deepEqual(calls, [undefined, undefined]);
  f.controller.hide(); await timers.at(-1)();
  assert.equal(calls.length, 2);
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
  assert.match(html, /id="ltxAccessLogin">Sign in with Hugging Face<\/button>/);
  assert.match(html, /<details class="more"><summary>Use a read token<\/summary>\s*<form id="ltxAccessForm">/);
  const module = source('../web/local-model-access.js');
  assert.doesNotMatch(module, /localStorage|sessionStorage|innerHTML|hf auth|fetch_ltx25|\/api\/runpod/);
  assert.match(module, /id: 'videoLtx', action/);
  assert.match(module, /Content-Type': 'application\/json'/);
});
