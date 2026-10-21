/** Isolated DOM + event-stream checks. No Studio server, CLI, model or audio. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assistantContext, readAssistantEvents, mountDawAssistant } from '../../web/daw-assistant.js';

class Element {
  constructor(tag, ownerDocument) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = ownerDocument; this.children = [];
    this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.value = '';
    this.hidden = false; this.disabled = false; this._text = ''; this._classes = new Set();
    this.style = { values: new Map(), setProperty: (key, value) => this.style.values.set(key, value) };
    this.classList = {
      add: (...names) => names.forEach(name => this._classes.add(name)),
      remove: (...names) => names.forEach(name => this._classes.delete(name)),
      contains: name => this._classes.has(name),
      toggle: (name, value = !this._classes.has(name)) => { if (value) this._classes.add(name); else this._classes.delete(name); return value; },
    };
  }
  set className(value) { this._classes = new Set(value.split(/\s+/)); }
  get className() { return [...this._classes].join(' '); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentElement = this; } }
  replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key); }
  addEventListener(name, listener) { const rows = this.listeners.get(name) || new Set(); rows.add(listener); this.listeners.set(name, rows); }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  async fire(name, values = {}) {
    if (name === 'click' && this.disabled) return;
    const event = { target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...values };
    for (const listener of [...this.listeners.get(name) || []]) await listener(event);
    return event;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const output = [], name = /\[data-assistant="([^"]+)"\]/.exec(selector)?.[1];
    const visit = node => { for (const child of node.children) { if (name ? child.dataset.assistant === name : child.tagName.toLowerCase() === selector) output.push(child); visit(child); } };
    visit(this); return output;
  }
  focus() { this.ownerDocument.activeElement = this; }
  setPointerCapture(id) { this.pointer = id; }
  releasePointerCapture() { this.pointer = null; }
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function eventStream(signal) {
  let streamController, closed = false;
  const body = new ReadableStream({ start(controller) { streamController = controller; } });
  signal?.addEventListener('abort', () => { if (!closed) { closed = true; streamController.error(new DOMException('aborted', 'AbortError')); } }, { once: true });
  return { response: { ok: true, body },
    push(event) { if (!closed) streamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); },
    close() { if (!closed) { closed = true; streamController.close(); } } };
}
function fixture(t, { prefs = {}, route, providerInstalled = true } = {}) {
  const doc = { createElement: tag => new Element(tag, doc) };
  const host = doc.createElement('aside'); host.id = 'dawAssistant';
  const toggle = doc.createElement('button'), shell = doc.createElement('div'), media = doc.createElement('media'); media.matches = false;
  const saved = new Map(Object.entries(prefs)), calls = [], sessions = new Map();
  let context = { slug: 'song-a', projectEpoch: 1, revision: 10, trackId: 'track-a', noteIds: ['note-a'], loopA: 2, loopB: 4, playheadSeconds: 3.5 };
  let stream, sessionNumber = 0;
  const response = data => ({ ok: true, json: async () => data });
  const request = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined, parsed = new URL(url, 'http://test.invalid');
    const call = { url, path: parsed.pathname, options, body }; calls.push(call);
    const custom = await route?.(call); if (custom) return custom;
    if (parsed.pathname.endsWith('/status')) return response({ providers: [{ id: 'codex', label: 'Codex', installed: providerInstalled }, { id: 'claude', label: 'Claude Code', installed: true }], separateSession: true });
    if (parsed.pathname.endsWith('/session')) {
      const slug = parsed.searchParams.get('slug'), provider = parsed.searchParams.get('provider');
      return response(sessions.get(slug + provider) || { slug, provider, sessionId: null, connected: false, history: [] });
    }
    if (parsed.pathname.endsWith('/connect')) {
      const data = { ...body, sessionId: `session-${++sessionNumber}`, connected: true, history: [] };
      sessions.set(body.slug + body.provider, data); return response(data);
    }
    if (parsed.pathname.endsWith('/turn')) { stream = eventStream(options.signal); return stream.response; }
    if (parsed.pathname.endsWith('/stop')) return response({ status: 'stopped' });
    if (parsed.pathname.endsWith('/approval')) return response({ ok: true });
    assert.fail('Unexpected request: ' + url);
  };
  const mounted = mountDawAssistant({ host, toggle, shell, getContext: () => context, fetch: request,
    storage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
    window: { matchMedia: () => media }, onLayout() {} });
  t.after(async () => { mounted.destroy(); await settle(); });
  const field = name => host.querySelector(`[data-assistant="${name}"]`);
  const open = async () => { await toggle.fire('click'); await settle(); };
  const connect = async () => { await field('connect').fire('click'); await settle(); };
  const send = async text => { field('input').value = text; await field('input').fire('input'); await field('form').fire('submit'); await settle(); };
  return { host, toggle, shell, media, saved, calls, sessions, mounted, field, open, connect, send,
    get stream() { return stream; }, get context() { return context; }, set context(value) { context = value; } };
}

test('context captures the complete selection without mutating or sharing the source', () => {
  const source = { slug: 'song', noteIds: ['a', 'a', 2, 'b'], loopA: NaN, playheadSeconds: 2 };
  const value = assistantContext(source); source.noteIds.push('later');
  assert.deepEqual(value.noteIds, ['a', 'b']); assert.equal(value.loopA, null);
  assert.equal(assistantContext(null).slug, null);
  assert.equal(assistantContext({ noteIds: Array.from({ length: 2100 }, (_, i) => String(i)) }).noteIds.length, 2100);
});

test('SSE parser preserves UTF-8, CRLF and split/multiple event frames', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\n\r\ndata: {"type":"delta","id":"a","text":"café"}\r\n\r\ndata: {"type":"end","status":"complete"}\n\n');
  const body = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); } });
  const events = []; await readAssistantEvents({ body }, event => events.push(event));
  assert.deepEqual(events, [{ type: 'delta', id: 'a', text: 'café' }, { type: 'end', status: 'complete' }]);
  const bad = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: broken\n\n')); controller.close(); } });
  await assert.rejects(readAssistantEvents({ body: bad }, () => {}), /unreadable/);
});

test('dock starts collapsed and opening only reads status/project history', async t => {
  const f = fixture(t); await settle();
  assert.equal(f.host.hidden, true); assert.equal(f.calls.length, 0);
  await f.open();
  assert.equal(f.host.hidden, false); assert.equal(f.toggle.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(f.calls.map(call => call.path), ['/api/daw-assistant/status', '/api/daw-assistant/session']);
  assert.equal(f.field('send').disabled, true); assert.equal(f.field('state').textContent, 'Disconnected');
  assert.match(f.field('scope').textContent, /song-a.*track-a.*1 selected/);
  assert.equal(f.saved.get('daw.assistant.open'), '1');
  assert.equal(f.field('input').maxLength, 16384);
  await f.field('close').fire('click');
  assert.equal(f.shell.classList.contains('d-assistant-open'), false);
});

test('missing CLI remains explicit, provider change checks its own project conversation', async t => {
  const f = fixture(t, { providerInstalled: false }); await f.open();
  assert.equal(f.field('state').textContent, 'Not installed'); assert.equal(f.field('connect').disabled, true);
  f.field('provider').value = 'claude'; await f.field('provider').fire('change'); await settle();
  assert.equal(f.field('connect').disabled, false);
  assert.match(f.calls.at(-1).url, /provider=claude/);
  await f.connect(); assert.equal(f.field('state').textContent, 'Ready');
  assert.deepEqual(f.calls.find(call => call.path.endsWith('/connect')).body, { slug: 'song-a', provider: 'claude' });
});

test('a turn sends current context and renders model/tool text without HTML', async t => {
  const f = fixture(t); await f.open(); await f.connect(); await f.send('Change this phrase');
  const call = f.calls.find(row => row.path.endsWith('/turn'));
  assert.deepEqual(call.body.context, f.context); assert.equal(call.body.text, 'Change this phrase');
  f.stream.push({ type: 'open', sessionId: call.body.sessionId, runId: 'run-a' });
  f.stream.push({ type: 'delta', id: 'reply-a', text: '<img src=x ' });
  f.stream.push({ type: 'delta', id: 'reply-a', text: 'onerror=alert(1)>' });
  f.stream.push({ type: 'message', id: 'reply-a', text: '<script>final reply</script>' });
  f.stream.push({ type: 'tool', name: '<b>daw_read</b>', status: 'completed' });
  f.stream.push({ type: 'end', status: 'completed' }); f.stream.close(); await settle();
  assert.match(f.field('log').textContent, /<script>final reply<\/script>/);
  assert.equal(f.field('log').querySelectorAll('script').length, 0);
  assert.equal(f.field('log').querySelectorAll('img').length, 0);
  assert.equal(f.field('log').children.length, 3, 'final message replaces its deltas');
  assert.equal(f.field('state').textContent, 'Ready'); assert.equal(f.field('stop').hidden, true);
  f.field('input').value = 'Another question'; await f.field('input').fire('input');
  assert.equal(f.field('send').disabled, false, 'a completed turn keeps its connection');
});

test('Stop waits for acknowledgement and names only its captured session/run', async t => {
  let acknowledge;
  const f = fixture(t, { route: call => call.path.endsWith('/stop') ? new Promise(resolve => { acknowledge = resolve; }) : undefined });
  await f.open(); await f.connect(); await f.send('Work on the selection');
  f.stream.push({ type: 'open', sessionId: 'session-1', runId: 'owned-run' }); await settle();
  const stopped = f.field('stop').fire('click'); await settle();
  assert.equal(f.field('state').textContent, 'Stopping');
  const call = f.calls.find(row => row.path.endsWith('/stop'));
  assert.deepEqual(call.body, { sessionId: 'session-1', runId: 'owned-run' });
  assert.equal(f.calls.some(row => row.path === '/api/cancel'), false);
  acknowledge({ ok: true, json: async () => ({ status: 'stopped' }) }); await stopped; await settle();
  assert.equal(f.field('state').textContent, 'Stopped');
  assert.match(f.field('note').textContent, /Edits already applied stay/);
  assert.equal(f.calls.find(row => row.path.endsWith('/turn')).options.signal.aborted, true);
  f.field('input').value = 'Next request'; await f.field('input').fire('input');
  assert.equal(f.field('send').disabled, true, 'Stop closes the connection until acknowledged Connect/Check');
  await f.connect(); assert.equal(f.field('send').disabled, false);
});

test('approval is explicit and stale project cards cannot approve another project', async t => {
  const f = fixture(t); await f.open(); await f.connect(); await f.send('Render the selected bars');
  f.stream.push({ type: 'open', sessionId: 'session-1', runId: 'run-a' });
  f.stream.push({ type: 'approval', id: 'approval-a', tool: 'daw_render', args: { slug: 'song-a' } }); await settle();
  assert.equal(f.calls.filter(row => row.path.endsWith('/approval')).length, 0);
  await f.field('approve').fire('click'); await settle();
  assert.deepEqual(f.calls.find(row => row.path.endsWith('/approval')).body, { sessionId: 'session-1', runId: 'run-a', id: 'approval-a', approved: true });
  f.stream.push({ type: 'approval', id: 'approval-b', tool: 'daw_delete', args: { slug: 'song-a' } }); await settle();
  const oldDecline = f.host.querySelectorAll('[data-assistant="decline"]').at(-1);
  f.context = { ...f.context, slug: 'song-b', projectEpoch: 2, revision: 20, noteIds: [] };
  await f.mounted.refresh(); await oldDecline.fire('click'); await settle();
  assert.equal(f.calls.filter(row => row.path.endsWith('/approval')).length, 1);
  assert.deepEqual(f.calls.find(row => row.path.endsWith('/stop')).body, { sessionId: 'session-1', runId: 'run-a' });
  assert.match(f.field('scope').textContent, /song-b/); assert.equal(f.field('log').children.length, 0);
});

test('late project history cannot replace the newly opened project', async t => {
  let finishOld;
  const f = fixture(t, { route: call => call.path.endsWith('/session') && call.url.includes('song-a')
    ? new Promise(resolve => { finishOld = resolve; }) : undefined });
  await f.open();
  f.context = { ...f.context, slug: 'song-b', projectEpoch: 2 }; await f.mounted.refresh();
  finishOld({ ok: true, json: async () => ({ slug: 'song-a', provider: 'codex', sessionId: 'old-session', connected: true, history: [{ role: 'assistant', text: 'OLD PROJECT' }] }) });
  await settle();
  assert.equal(f.field('log').textContent.includes('OLD PROJECT'), false);
  assert.equal(f.field('state').textContent, 'Disconnected');
  await f.connect();
  assert.equal(f.calls.find(row => row.path.endsWith('/connect')).body.slug, 'song-b');
});

test('a mismatched stream identity aborts only that response and cannot append output', async t => {
  const f = fixture(t); await f.open(); await f.connect(); await f.send('Inspect this phrase');
  f.stream.push({ type: 'open', sessionId: 'another-session', runId: 'foreign-run' });
  await settle();
  assert.equal(f.field('state').textContent, 'Error'); assert.match(f.field('note').textContent, /identity did not match/);
  assert.equal(f.calls.find(row => row.path.endsWith('/turn')).options.signal.aborted, true);
  assert.equal(f.calls.some(row => row.path.endsWith('/stop')), false, 'never stop a foreign identity');
  assert.equal(f.field('stop').hidden, true);
  f.field('input').value = 'Try again'; await f.field('input').fire('input');
  assert.equal(f.field('send').disabled, true, 'unknown stream failure cannot reuse the cached connection');
});

test('reloading the same slug detaches the old epoch and does not reuse stale approvals', async t => {
  const f = fixture(t); await f.open(); await f.connect(); await f.send('Render this phrase');
  f.stream.push({ type: 'open', sessionId: 'session-1', runId: 'run-old-epoch' });
  f.stream.push({ type: 'approval', id: 'old-approval', tool: 'daw_render', args: {} }); await settle();
  const oldApprove = f.field('approve');
  f.context = { ...f.context, projectEpoch: 2 }; await f.mounted.refresh(); await oldApprove.fire('click'); await settle();
  assert.equal(f.calls.find(row => row.path.endsWith('/turn')).options.signal.aborted, true);
  assert.deepEqual(f.calls.find(row => row.path.endsWith('/stop')).body, { sessionId: 'session-1', runId: 'run-old-epoch' });
  assert.equal(f.calls.some(row => row.path.endsWith('/approval')), false);
  assert.equal(f.field('log').children.length, 0);
});

test('a failed turn is not reported ready and its pending approvals become inert', async t => {
  const f = fixture(t); await f.open(); await f.connect(); await f.send('Check the instruments');
  f.stream.push({ type: 'open', sessionId: 'session-1', runId: 'run-failed' });
  f.stream.push({ type: 'approval', id: 'pending-approval', tool: 'daw_render', args: {} }); await settle();
  const approve = f.field('approve');
  f.stream.push({ type: 'end', status: 'failed' }); f.stream.close(); await settle();
  assert.equal(f.field('state').textContent, 'Error'); assert.equal(approve.disabled, true);
  await approve.fire('click'); assert.equal(f.calls.some(row => row.path.endsWith('/approval')), false);
  f.field('input').value = 'Try again'; await f.field('input').fire('input');
  assert.equal(f.field('send').disabled, true); assert.equal(f.field('connect').disabled, false);
  f.sessions.set('song-acodex', { slug: 'song-a', provider: 'codex', sessionId: 'session-1', connected: false, history: [] });
  await f.field('check').fire('click'); await settle();
  assert.equal(f.field('send').disabled, true, 'Check preserves a reported disconnection');
  await f.connect(); assert.equal(f.field('send').disabled, false, 'a successful Connect re-enables Send');
});

test('a stream closing without end requires an actual connection check before another turn', async t => {
  const f = fixture(t); await f.open(); await f.connect(); await f.send('Inspect this phrase');
  f.stream.push({ type: 'open', sessionId: 'session-1', runId: 'run-dropped' });
  f.stream.close(); await settle();
  f.field('input').value = 'Continue'; await f.field('input').fire('input');
  assert.equal(f.field('state').textContent, 'Disconnected'); assert.equal(f.field('send').disabled, true);
  f.sessions.set('song-acodex', { slug: 'song-a', provider: 'codex', sessionId: 'session-1', connected: true, history: [] });
  await f.field('check').fire('click'); await settle();
  assert.equal(f.field('state').textContent, 'Ready'); assert.equal(f.field('send').disabled, false);
});

test('a stopped end event closes the cached connection even without a local Stop click', async t => {
  const f = fixture(t); await f.open(); await f.connect(); await f.send('Check this phrase');
  f.stream.push({ type: 'open', sessionId: 'session-1', runId: 'run-stopped' });
  f.stream.push({ type: 'end', status: 'stopped' }); f.stream.close(); await settle();
  f.field('input').value = 'Continue'; await f.field('input').fire('input');
  assert.equal(f.field('state').textContent, 'Stopped'); assert.equal(f.field('send').disabled, true);
  await f.connect(); assert.equal(f.field('send').disabled, false);
});

test('a restored running turn can be checked again without starting or repeating it', async t => {
  const f = fixture(t); f.sessions.set('song-acodex', { slug: 'song-a', provider: 'codex', sessionId: 'restored', connected: true, activeRunId: 'restored-run', history: [] });
  await f.open(); assert.equal(f.field('state').textContent, 'Running'); assert.equal(f.field('stop').disabled, false);
  f.sessions.set('song-acodex', { slug: 'song-a', provider: 'codex', sessionId: 'restored', connected: true, history: [{ role: 'assistant', text: 'Finished earlier' }] });
  await f.field('check').fire('click'); await settle();
  assert.equal(f.field('state').textContent, 'Ready'); assert.match(f.field('log').textContent, /Finished earlier/);
  assert.equal(f.calls.some(row => row.path.endsWith('/turn') || row.path.endsWith('/connect')), false);
});

test('resizing is bounded, keyboard accessible and saved only as a UI preference', async t => {
  const f = fixture(t, { prefs: { 'daw.assistant.width': '9999' } });
  assert.equal(f.shell.style.values.get('--d-assistant-pref'), '560px');
  const grip = f.field('grip'), event = await grip.fire('keydown', { key: 'Home' });
  assert.equal(event.propagationStopped, true); assert.equal(f.saved.get('daw.assistant.width'), '360');
  f.media.matches = true; await f.media.fire('change');
  assert.equal(grip.getAttribute('aria-orientation'), 'horizontal');
  await grip.fire('pointerdown', { pointerId: 1, button: 0, clientX: 0, clientY: 200 });
  await grip.fire('pointermove', { pointerId: 1, clientX: 0, clientY: 150 });
  await grip.fire('pointerup', { pointerId: 1 });
  assert.equal(f.saved.get('daw.assistant.height'), '350');
  assert.equal(f.calls.length, 0);
});

test('new chat has a separate-session request and layout/mount contracts stay native', async t => {
  const f = fixture(t); await f.open(); await f.connect(); await f.field('new').fire('click'); await settle();
  assert.deepEqual(f.calls.filter(row => row.path.endsWith('/connect')).at(-1).body, { slug: 'song-a', provider: 'codex', newSession: true });
  const source = readFileSync(new URL('../../web/daw-assistant.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../../web/daw.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../web/daw-assistant.css', import.meta.url), 'utf8');
  const daw = readFileSync(new URL('../../web/daw.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|\/api\/cancel|["']\/api\/daw["']/);
  assert.match(html, /id="assistantBtn"/); assert.match(html, /id="dawAssistant" hidden/);
  assert.match(daw, /assistantDock = mountDawAssistant/); assert.match(daw, /assistantDock\?\.refresh\(\)/);
  assert.match(css, /\.d-assistant\[hidden\]\s*\{\s*display: none/);
  assert.match(css, /@media \(max-width: 1100px\)/); assert.match(css, /\.d-shell\.d-deck\.d-assistant-open/);
  assert.match(css, /@media \(max-height: 600px\)[\s\S]*?\.d-shell\.d-assistant-open\s*\{\s*overflow: auto/);
  assert.match(css, /\.d-assistant > :not\(\.d-assistant-log\)\s*\{ flex-shrink: 0/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
});
