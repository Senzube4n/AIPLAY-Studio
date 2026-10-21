/** A separate, project-bound conversation with an installed CLI assistant.
 * Dock geometry is a browser UI preference, deliberately not a DAW edit.
 * Only the service owns CLI processes, MCP calls, approvals and cancellation. */
const PROVIDERS = ['codex', 'claude'];
const PREF = 'daw.assistant.';
const clamp = (value, low, high, fallback) => Number.isFinite(Number(value))
  ? Math.min(high, Math.max(low, Number(value))) : fallback;

export function assistantContext(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  return { slug: typeof value.slug === 'string' ? value.slug : null,
    projectEpoch: value.projectEpoch ?? null, revision: value.revision ?? null,
    trackId: typeof value.trackId === 'string' ? value.trackId : null,
    noteIds: Array.isArray(value.noteIds) ? [...new Set(value.noteIds.filter(id => typeof id === 'string'))] : [],
    loopA: Number.isFinite(value.loopA) ? value.loopA : null,
    loopB: Number.isFinite(value.loopB) ? value.loopB : null,
    playheadSeconds: Number.isFinite(value.playheadSeconds) ? value.playheadSeconds : 0 };
}

/** POST response SSE, including CRLF, split UTF-8 and split frame boundaries. */
export async function readAssistantEvents(response, receive) {
  if (!response.body?.getReader) throw new Error('The assistant response has no event stream.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  const frame = async source => {
    const data = source.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    let event;
    try { event = JSON.parse(data); } catch { throw new Error('The assistant sent an unreadable event.'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('The assistant sent an invalid event.');
    await receive(event);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 1_000_000) throw new Error('The assistant event is too large.');
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        await frame(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
      if (done) break;
    }
    if (buffer.trim()) await frame(buffer);
  } finally { reader.releaseLock?.(); }
}

export function mountDawAssistant({ getContext, host = globalThis.document?.getElementById('dawAssistant'),
  toggle = globalThis.document?.getElementById('assistantBtn'), shell = globalThis.document?.getElementById('shell'),
  fetch: request = globalThis.fetch?.bind(globalThis), storage = globalThis.localStorage,
  window: win = globalThis, onLayout = () => {} } = {}) {
  if (typeof getContext !== 'function') throw new Error('DAW assistant context is required.');
  if (!host || !toggle || !shell) return { refresh() {}, destroy() {} };
  const doc = host.ownerDocument;
  const disposers = [], messages = new Map();
  const readPref = (key, fallback) => { try { return storage?.getItem(PREF + key) ?? fallback; } catch { return fallback; } };
  const savePref = (key, value) => { try { storage?.setItem(PREF + key, String(value)); } catch { /* private browsing */ } };
  let provider = readPref('provider', 'codex'); if (!PROVIDERS.includes(provider)) provider = 'codex';
  let opened = readPref('open', '0') === '1', width = clamp(readPref('width', 360), 300, 560, 360);
  let height = clamp(readPref('height', 300), 240, 480, 300);
  let disposed = false, generation = 0, binding = '', context = {}, session = null, active = null;
  let installed = false, loading = false, connecting = false, currentState = 'Disconnected', drag = null;
  const bind = (element, name, listener) => {
    element.addEventListener(name, listener); disposers.push(() => element.removeEventListener(name, listener));
  };
  const el = (tag, text, cls, name) => {
    const node = doc.createElement(tag); if (text != null) node.textContent = text;
    if (cls) node.className = cls; if (name) node.dataset.assistant = name;
    return node;
  };
  const button = (text, name) => { const node = el('button', text, 'd-btn d-sm', name); node.type = 'button'; return node; };
  const grip = el('div', null, 'd-assistant-grip', 'grip');
  grip.tabIndex = 0; grip.setAttribute('role', 'separator'); grip.setAttribute('aria-label', 'Resize assistant');
  const header = el('header', null, 'd-assistant-head'), heading = el('strong', 'Assistant');
  const chip = el('span', currentState, 'd-assistant-state', 'state'); chip.setAttribute('role', 'status');
  const close = button('Close', 'close'); header.append(heading, chip, close);
  const tools = el('div', null, 'd-assistant-tools');
  const menu = el('select', null, 'd-sel', 'provider'); menu.setAttribute('aria-label', 'Assistant provider');
  for (const [id, label] of [['codex', 'Codex'], ['claude', 'Claude Code']]) {
    const option = el('option', label); option.value = id; menu.append(option);
  }
  menu.value = provider;
  const connect = button('Connect', 'connect'), fresh = button('New chat', 'new'), check = button('Check', 'check');
  tools.append(menu, connect, fresh, check);
  const scope = el('p', 'Choose a project.', 'd-assistant-scope d-note', 'scope');
  const log = el('div', null, 'd-assistant-log', 'log'); log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite');
  const note = el('p', '', 'd-note d-assistant-note', 'note'); note.setAttribute('role', 'status');
  const form = el('form', null, 'd-assistant-form', 'form');
  const input = el('textarea', null, 'd-txt', 'input'); input.rows = 3; input.maxLength = 16384;
  input.setAttribute('aria-label', 'Message the DAW assistant'); input.placeholder = 'Ask about this project';
  const actions = el('div', null, 'd-assistant-actions');
  const send = button('Send', 'send'); send.type = 'submit';
  const stop = button('Stop', 'stop'); actions.append(send, stop); form.append(input, actions);
  const details = el('details', null, 'd-assistant-details');
  details.append(el('summary', 'Connection details'),
    el('p', 'Uses your installed CLI login in a separate DAW conversation, not your desktop chat. Usage counts toward that provider account’s limits.'),
    el('p', 'Stop interrupts this assistant. Edits already applied stay; Studio jobs already started may continue.'),
    el('p', 'Dock size and open state are saved in this browser.'));
  host.replaceChildren(grip, header, tools, scope, log, note, form, details);
  toggle.setAttribute('aria-controls', host.id);
  const media = win.matchMedia?.('(max-width: 1100px)');
  const narrow = () => !!media?.matches;
  const current = (key, serial) => !disposed && key === binding && serial === generation;
  const captured = () => ({ key: binding, serial: generation, slug: context.slug, provider });

  function controls() {
    const busy = !!active || connecting || loading;
    connect.disabled = busy || !context.slug || !installed;
    fresh.disabled = busy || !context.slug || !installed;
    menu.disabled = !!active || connecting;
    send.disabled = busy || !session?.connected || !context.slug || !input.value.trim();
    input.disabled = !context.slug || connecting;
    stop.hidden = !active; stop.disabled = !active?.runId || active?.stopping === true || active?.finished === true;
    check.disabled = connecting || loading;
    chip.textContent = currentState;
    chip.classList.toggle('d-assistant-busy', !!active || connecting || loading);
    toggle.textContent = active ? 'Assistant •' : 'Assistant';
    toggle.title = active ? 'Show the running DAW assistant' : 'Show the DAW assistant';
  }
  function state(value, message) {
    currentState = value; if (message !== undefined) note.textContent = message; controls();
  }
  function layout() {
    host.hidden = !opened; shell.classList.toggle('d-assistant-open', opened);
    shell.style.setProperty('--d-assistant-pref', `${width}px`);
    shell.style.setProperty('--d-assistant-height', `${height}px`);
    toggle.setAttribute('aria-expanded', String(opened)); toggle.classList.toggle('d-on', opened);
    grip.setAttribute('aria-orientation', narrow() ? 'horizontal' : 'vertical');
    grip.setAttribute('aria-valuemin', narrow() ? '240' : '300');
    grip.setAttribute('aria-valuemax', narrow() ? '480' : '560');
    grip.setAttribute('aria-valuenow', String(narrow() ? height : width));
    onLayout();
  }
  function append(kind, text, id) {
    let row = id && messages.get(id);
    if (!row) {
      row = el('div', '', `d-assistant-message d-assistant-${kind}`);
      log.append(row); if (id) messages.set(id, row);
    }
    row.textContent = String(text ?? '');
    log.scrollTop = log.scrollHeight;
    return row;
  }
  async function api(route, body, signal) {
    const response = await request('/api/daw-assistant' + route, body === undefined ? { signal } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || data.message || `Assistant request failed (${response.status}).`);
    return data;
  }
  function detach() {
    const old = active; active = null;
    if (old?.runId && !old.finished) api('/stop', { sessionId: old.sessionId, runId: old.runId }).catch(() => {});
    // The service interrupts only its own turn when a stream closes before open.
    old?.controller?.abort();
  }
  function history(data, token) {
    if (!current(token.key, token.serial)) return;
    if (data.slug && data.slug !== token.slug || data.provider && data.provider !== token.provider)
      throw new Error('The assistant returned a different project conversation.');
    session = data.sessionId ? { sessionId: data.sessionId, connected: data.connected === true } : null;
    messages.clear(); log.replaceChildren();
    for (const row of data.history || []) if (['user', 'assistant'].includes(row.role)) append(row.role, row.text);
    active = data.activeRunId && session ? { ...token, sessionId: session.sessionId, runId: data.activeRunId, controller: null } : null;
    state(active ? 'Running' : session?.connected ? 'Ready' : installed ? 'Disconnected' : 'Not installed',
      !installed ? 'Install the selected CLI, then check again.' : session?.connected ? '' : 'Use the CLI’s normal sign-in, then connect.');
  }
  async function refresh(force = false) {
    if (disposed) return;
    const next = assistantContext(getContext());
    const key = JSON.stringify([next.slug, next.projectEpoch, provider]);
    const changed = key !== binding;
    context = next;
    scope.textContent = context.slug ? `${context.slug}${context.trackId ? ' · ' + context.trackId : ''} · ${context.noteIds.length} selected notes` : 'Choose a project.';
    if (changed) {
      ++generation; binding = key; detach(); session = null; loading = false; connecting = false;
      input.value = ''; messages.clear(); log.replaceChildren(); state('Disconnected', '');
    }
    controls();
    if (!opened || !context.slug || !changed && (!force || active?.controller && !active.finished)) return;
    const token = captured(); loading = true; state('Checking');
    try {
      const [status, data] = await Promise.all([api('/status'), api('/session?' + new URLSearchParams({ slug: token.slug, provider: token.provider }))]);
      if (!current(token.key, token.serial)) return;
      installed = status.providers?.some(row => row.id === token.provider && row.installed === true) === true;
      loading = false; history(data, token);
    } catch (error) { if (current(token.key, token.serial)) { loading = false; state('Unavailable', error.message); } }
  }
  async function connectSession(newSession = false) {
    if (active || connecting || loading || !context.slug || !installed) return;
    const token = captured(); connecting = true; state('Connecting', '');
    try {
      const data = await api('/connect', { slug: token.slug, provider: token.provider, ...(newSession ? { newSession: true } : {}) });
      if (!current(token.key, token.serial)) return;
      connecting = false; history(data, token); input.focus();
    } catch (error) { if (current(token.key, token.serial)) { connecting = false; state('Disconnected', error.message); } }
  }
  function approval(event, turn) {
    const card = el('section', null, 'd-assistant-approval');
    card.append(el('strong', String(event.tool || 'Tool approval')));
    const args = el('pre', typeof event.args === 'string' ? event.args : JSON.stringify(event.args ?? {}, null, 2)); card.append(args);
    const yes = button('Approve', 'approve'), no = button('Decline', 'decline'); card.append(yes, no); log.append(card);
    (turn.approvals ||= []).push(yes, no);
    const respond = async approved => {
      if (!current(turn.key, turn.serial) || active !== turn || turn.finished) return;
      yes.disabled = no.disabled = true;
      try {
        await api('/approval', { sessionId: turn.sessionId, runId: turn.runId, id: event.id, approved });
        if (current(turn.key, turn.serial) && active === turn && !turn.finished) state('Running', approved ? 'Approved.' : 'Declined.');
      } catch (error) { if (current(turn.key, turn.serial) && active === turn && !turn.finished) { state('Waiting', error.message); yes.disabled = no.disabled = false; } }
    };
    bind(yes, 'click', () => respond(true)); bind(no, 'click', () => respond(false));
    state('Waiting', 'Review this tool request.');
  }
  function receive(event, turn) {
    if (!current(turn.key, turn.serial) || active !== turn) return;
    switch (event.type) {
      case 'open':
        if (event.sessionId !== turn.sessionId || !event.runId) throw new Error('The assistant turn identity did not match.');
        turn.runId = event.runId; state('Running'); break;
      case 'delta': {
        const id = String(event.id || 'reply'), row = messages.get(id);
        append('assistant', (row?.textContent || '') + String(event.text || ''), id); break;
      }
      case 'message': append('assistant', event.text, String(event.id || 'reply')); break;
      case 'tool': append('tool', `${event.name || 'Tool'} · ${event.status || 'running'}`); break;
      case 'approval': if (turn.runId) approval(event, turn); break;
      case 'state': state(({ running: 'Running', waiting: 'Waiting', stopping: 'Stopping', connected: 'Ready' })[event.state] || 'Running'); break;
      case 'error': turn.failed = true; append('error', event.message || 'The assistant failed.'); state('Error'); break;
      case 'end':
        turn.finished = true;
        if (session && (turn.failed || ['stopped', 'error', 'failed'].includes(event.status))) session.connected = false;
        for (const button of turn.approvals || []) button.disabled = true;
        if (!turn.stopping) state(event.status === 'stopped' ? 'Stopped' : turn.failed || ['error', 'failed'].includes(event.status) ? 'Error' : 'Ready');
        break;
    }
  }
  async function sendTurn() {
    await refresh();
    const text = input.value.trim();
    if (!text || active || connecting || loading || !session?.connected || !context.slug) return;
    const turn = { ...captured(), sessionId: session.sessionId, runId: null, controller: new AbortController() };
    active = turn; input.value = ''; append('user', text); state('Running', '');
    try {
      const response = await request('/api/daw-assistant/turn', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: turn.sessionId, text, context: assistantContext(getContext()) }), signal: turn.controller.signal });
      if (!response.ok) { const error = await response.json(); throw new Error(error.error || error.message || 'The assistant did not start.'); }
      await readAssistantEvents(response, event => receive(event, turn));
      if (current(turn.key, turn.serial) && !turn.finished && !turn.stopping) {
        if (session) session.connected = false;
        state('Disconnected', 'The event stream ended. Connect or check the conversation before sending again.');
      }
    } catch (error) {
      if (current(turn.key, turn.serial) && !turn.stopping) {
        if (session) session.connected = false;
        state(error.name === 'AbortError' ? 'Disconnected' : 'Error', error.name === 'AbortError' ? 'Connect or check the conversation before sending again.' : error.message);
      }
    } finally {
      if (!turn.finished && !turn.stopping) turn.controller.abort();
      if (!turn.stopping) for (const button of turn.approvals || []) button.disabled = true;
      if (active === turn && !turn.stopping) { active = null; controls(); }
    }
  }
  async function stopTurn() {
    const turn = active;
    if (!turn?.runId || turn.stopping || turn.finished) return;
    turn.stopping = true; state('Stopping', '');
    try {
      const result = await api('/stop', { sessionId: turn.sessionId, runId: turn.runId });
      if (result.status !== 'stopped') throw new Error('The assistant has not confirmed stopping.');
      turn.finished = true; turn.controller?.abort();
      for (const button of turn.approvals || []) button.disabled = true;
      if (current(turn.key, turn.serial) && active === turn) {
        if (session) session.connected = false;
        active = null; state('Stopped', 'Edits already applied stay; Studio jobs already started may continue.');
      }
    } catch (error) {
      if (current(turn.key, turn.serial) && active === turn) { turn.stopping = false; state('Stop failed', error.message); }
    }
  }
  function setOpen(value) {
    opened = value; savePref('open', opened ? '1' : '0'); layout();
    if (opened) { refresh(true); input.focus(); }
  }
  bind(toggle, 'click', () => setOpen(!opened)); bind(close, 'click', () => setOpen(false));
  bind(menu, 'change', () => { provider = menu.value; savePref('provider', provider); refresh(true); });
  bind(connect, 'click', () => connectSession()); bind(fresh, 'click', () => connectSession(true));
  bind(check, 'click', () => refresh(true)); bind(input, 'input', controls);
  bind(form, 'submit', event => { event.preventDefault(); sendTurn(); });
  bind(input, 'keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendTurn(); } });
  bind(stop, 'click', stopTurn);
  bind(grip, 'pointerdown', event => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault(); drag = { id: event.pointerId, x: event.clientX, y: event.clientY, width, height, narrow: narrow() };
    grip.setPointerCapture?.(event.pointerId);
  });
  bind(grip, 'pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (drag.narrow) height = clamp(drag.height + drag.y - event.clientY, 240, 480, 300);
    else width = clamp(drag.width + drag.x - event.clientX, 300, 560, 360);
    layout();
  });
  const endDrag = () => { if (!drag) return; try { grip.releasePointerCapture?.(drag.id); } catch { /* pointer already released */ } drag = null; savePref('width', width); savePref('height', height); };
  bind(grip, 'pointerup', endDrag); bind(grip, 'pointercancel', endDrag);
  bind(grip, 'keydown', event => {
    const small = narrow(), before = small ? height : width;
    const delta = event.key === (small ? 'ArrowUp' : 'ArrowLeft') ? 20 : event.key === (small ? 'ArrowDown' : 'ArrowRight') ? -20 : null;
    if (delta === null && event.key !== 'Home') return;
    event.preventDefault(); event.stopPropagation();
    if (small) height = event.key === 'Home' ? 300 : clamp(before + delta, 240, 480, 300);
    else width = event.key === 'Home' ? 360 : clamp(before + delta, 300, 560, 360);
    savePref(small ? 'height' : 'width', small ? height : width); layout();
  });
  if (media?.addEventListener) bind(media, 'change', layout);
  layout(); refresh(true);
  return { refresh, destroy() {
    if (disposed) return;
    disposed = true; ++generation; detach(); for (const dispose of disposers) dispose();
    shell.classList.remove('d-assistant-open'); host.hidden = true; onLayout();
  } };
}
