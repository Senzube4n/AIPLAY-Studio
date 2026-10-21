/** A loopback-only, project-bound bridge to installed coding assistants.
 * Browser sessions own their CLI thread IDs. No desktop conversations, login
 * files, commands or global Studio MCP tools are accepted from a client. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { renameAtomic } from '../fs-atomic.js';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { discoverProviders, createAssistantClient } from './assistant-providers.js';
import { createAssistantTools } from './assistant-tools.js';

const PREFIX = '/api/daw-assistant';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,95}$/;
const LABELS = { codex: 'Codex', claude: 'Claude Code' };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const fault = (status, message) => Object.assign(Error(message), { status });
const localSocket = req => !req.lanClient && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);
const later = (ms, message) => new Promise((_, reject) => {
  const timer = setTimeout(() => reject(Error(message)), ms); timer.unref?.();
});

async function bodyJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fault(415, 'Send JSON.');
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) throw fault(413, 'The assistant request is too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!plain(value)) throw Error();
    return value;
  } catch { throw fault(400, 'Send a JSON object.'); }
}

function validateBinding(slug, provider) {
  if (typeof slug !== 'string' || !SLUG.test(slug)) throw fault(400, 'Open a saved DAW project first.');
  if (!Object.hasOwn(LABELS, provider)) throw fault(400, 'Choose Codex or Claude Code.');
}
function contextFor(value, slug) {
  if (!plain(value) || value.slug !== slug) throw fault(409, 'The open project changed. Send again from that project.');
  const out = { slug };
  for (const key of ['projectEpoch', 'revision', 'trackId', 'loopA', 'loopB', 'playheadSeconds']) {
    const item = value[key];
    if (item == null) continue;
    if (typeof item === 'string' && item.length <= 256 || typeof item === 'number' && Number.isFinite(item)) out[key] = item;
    else throw fault(400, 'Invalid DAW selection.');
  }
  if (value.noteIds !== undefined) {
    if (!Array.isArray(value.noteIds) || value.noteIds.length > 2048 || value.noteIds.some(id => typeof id !== 'string' || id.length > 256))
      throw fault(400, 'Invalid selected notes.');
    out.noteIds = value.noteIds;
  }
  return out;
}

export function createDawAssistantRoutes({ config, api, dir = path.join(config.paths.appData, 'daw-assistant'),
  discover = discoverProviders, clientFactory = createAssistantClient, toolsFactory = createAssistantTools, stopTimeoutMs = 12000 } = {}) {
  const sessions = new Map(), bindings = new Map();
  const port = () => config.uiPort;
  const json = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  // This API wrapper is private to the server. The scoped registry additionally
  // checks the exact path, action, slug and schema before reaching it.
  const studioApi = api || (async (method, target, data, actor, signal) => {
    // Keep Node 20.0 source installs supported (AbortSignal.any needs 20.3).
    const deadline = new AbortController(), cancel = () => deadline.abort();
    const timer = setTimeout(cancel, 15 * 60 * 1000); timer.unref?.();
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    try {
      const response = await fetch(`http://127.0.0.1:${port()}${target}`, { method, redirect: 'error', signal: deadline.signal,
        headers: { 'Content-Type': 'application/json', 'x-aiplay-actor': actor },
        ...(method === 'GET' ? {} : { body: JSON.stringify(data) }) });
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 4 * 1024 * 1024) throw Error('The DAW reply is too large.');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) throw Error(result.error || 'The DAW refused that edit.');
      return result;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  });
  const bindingKey = (slug, provider) => createHash('sha256').update(`${slug}\n${provider}`).digest('hex');
  const recordPath = id => path.join(dir, `${id}.json`);
  async function atomic(file, value) {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    await renameAtomic(tmp, file);
  }
  async function readJson(file) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw fault(500, 'The saved assistant conversation could not be read.'); }
  }
  function save(session) {
    session.saving = (session.saving || Promise.resolve()).then(() => atomic(recordPath(session.record.id), session.record));
    return session.saving;
  }
  function runtime(record) {
    const session = { record, token: randomBytes(32).toString('hex'), connected: false, client: null, activeRun: null };
    sessions.set(record.id, session); return session;
  }
  async function getSession(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw fault(404, 'Assistant conversation not found.');
    if (sessions.has(id)) return sessions.get(id);
    const record = await readJson(recordPath(id));
    if (!record || record.id !== id || record.version !== 1 || !Array.isArray(record.history)) throw fault(404, 'Assistant conversation not found.');
    validateBinding(record.slug, record.provider);
    if (sessions.has(id)) return sessions.get(id); // Concurrent cold readers share one runtime and token.
    return runtime(record);
  }
  const publicSession = session => ({ sessionId: session.record.id, slug: session.record.slug, provider: session.record.provider,
    connected: session.connected, history: session.record.history.map(({ role, text, status }) => ({ role, text, ...(status ? { status } : {}) })),
    ...(session.activeRun ? { activeRunId: session.activeRun.id } : {}) });
  async function current(slug, provider) {
    const pointer = await readJson(path.join(dir, `binding-${bindingKey(slug, provider)}.json`));
    if (!pointer) return null;
    const session = await getSession(pointer.sessionId);
    if (session.record.slug !== slug || session.record.provider !== provider) throw fault(500, 'The saved project conversation has the wrong binding.');
    return session;
  }
  function emit(run, event) {
    if (!run.res.destroyed && !run.res.writableEnded) run.res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  function browserRequest(req) {
    if (!localSocket(req)) throw fault(403, 'The Assistant is available on this computer only.');
    const host = req.headers.host;
    const allowed = new Set([`localhost:${port()}`, `127.0.0.1:${port()}`, `[::1]:${port()}`]);
    if (!allowed.has(host)) throw fault(403, 'Open the Assistant from Studio.');
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) throw fault(403, 'Open the Assistant from Studio.');
    if (req.method !== 'GET' && !origin || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']))
      throw fault(403, 'Open the Assistant from Studio.');
  }
  function capability(req, session) {
    const raw = req.headers.authorization;
    if (!localSocket(req) || typeof raw !== 'string' || !raw.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(raw.slice(7)), expected = Buffer.from(session.token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
      && !!session.activeRun && !session.activeRun.abort.signal.aborted && !session.activeRun.finishing;
  }
  async function stop(session, run) {
    if (run.stopping) return run.stopping;
    run.abort.abort();
    for (const resolve of run.approvals.values()) resolve(false);
    run.approvals.clear();
    run.stopping = (async () => {
      try {
        const client = session.client;
        // close() is the provider's actual owned-child exit check, including if
        // interrupt fails. A timeout retains the handle and blocks replacement.
        await Promise.race([(async () => { try { await client?.interrupt(); } finally { await client?.close(); } })(), later(stopTimeoutMs, 'Assistant stop could not be confirmed. Restart Studio after checking that assistant process.')]);
        session.client = null;
      } catch (error) { session.blocked = error.message; throw error; }
      finally { session.connected = false; }
    })();
    return run.stopping;
  }
  async function connect(session) {
    if (session.blocked) throw fault(409, session.blocked);
    if (session.connected) return;
    if (session.client) {
      try { await session.client.close(); session.client = null; }
      catch (error) { session.blocked = error.message; throw fault(409, session.blocked); }
    }
    const found = await discover(), executable = found[session.record.provider];
    if (!executable) throw fault(503, `Install ${LABELS[session.record.provider]} and sign in in its CLI first.`);
    const cwd = path.join(dir, 'workspaces', session.record.id);
    await mkdir(cwd, { recursive: true });
    const client = clientFactory({ provider: session.record.provider, executable, cwd,
      mcp: { command: process.execPath, args: [fileURLToPath(new URL('./assistant-mcp.mjs', import.meta.url))],
        env: { AIPLAY_ASSISTANT_URL: `http://127.0.0.1:${port()}${PREFIX}/mcp/${session.record.id}`, AIPLAY_ASSISTANT_TOKEN: session.token } },
      onEvent(event) {
        const run = session.activeRun;
        if (!run || run.abort.signal.aborted || run.finishing) return;
        if (event.type === 'delta' || event.type === 'message') {
          if (typeof event.text !== 'string' || typeof event.id !== 'string') return;
          const prior = run.messages.get(event.id) || '';
          if (prior.length + event.text.length > 1024 * 1024) { void stop(session, run).catch(() => {}); return; }
          run.messages.set(event.id, event.type === 'message' ? event.text : prior + event.text);
        }
        if (['delta', 'message', 'tool', 'state'].includes(event.type)) emit(run, event);
      } });
    try {
      const result = await client.connect();
      if (!result.authenticated) throw fault(401, result.message || `Sign in with the ${LABELS[session.record.provider]} CLI first, then Connect.`);
      session.client = client; session.connected = true;
    } catch (error) {
      try { await client.close(); } catch (closeError) { session.client = client; session.blocked = closeError.message; }
      throw error;
    }
  }
  async function toolCall(session, run, body) {
    if (session.activeRun !== run || run.abort.signal.aborted || run.finishing) throw fault(409, 'This assistant turn has stopped.');
    const registry = toolsFactory({ slug: session.record.slug,
      api: (method, target, data) => studioApi(method, target, data, `agent:daw-${session.record.provider}`, run.abort.signal) });
    const tool = registry.find(item => item.name === body.name);
    if (!tool) throw fault(400, 'This tool is not available in the DAW Assistant.');
    const args = tool.validate ? tool.validate(body.arguments || {}) : body.arguments || {};
    if (tool.gate) {
      const id = randomUUID();
      const approved = await new Promise(resolve => {
        const timer = setTimeout(() => { run.approvals.delete(id); resolve(false); }, 5 * 60 * 1000); timer.unref?.();
        run.approvals.set(id, value => { clearTimeout(timer); resolve(value); });
        emit(run, { type: 'approval', id, tool: tool.name, args });
      });
      if (!approved || run.abort.signal.aborted) return { content: [{ type: 'text', text: 'The user did not approve this action. It was not started.' }], isError: true };
    }
    if (session.activeRun !== run || run.abort.signal.aborted || run.finishing) throw fault(409, 'This assistant turn has stopped.');
    emit(run, { type: 'tool', name: tool.name, status: 'running' });
    try {
      const result = await tool.run(args);
      emit(run, { type: 'tool', name: tool.name, status: 'completed' });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      emit(run, { type: 'tool', name: tool.name, status: 'failed' });
      // A transport failure can occur after a reducer committed. Never retry.
      return { content: [{ type: 'text', text: `${error.message} Do not automatically repeat this action; inspect project state first.` }], isError: true };
    }
  }
  async function turn(session, body, req, res) {
    if (session.blocked) throw fault(409, session.blocked);
    if (!session.connected || !session.client) throw fault(409, 'Connect the Assistant first.');
    if (session.activeRun || [...sessions.values()].some(s => s.activeRun && s.record.slug === session.record.slug))
      throw fault(409, 'An assistant turn is already running for this project.');
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16384) throw fault(400, 'Write a message of up to 16,384 characters.');
    const context = contextFor(body.context, session.record.slug);
    const run = { id: randomUUID(), res, abort: new AbortController(), calls: new Map(), approvals: new Map(), messages: new Map(), finishing: false };
    let settled; run.settled = new Promise(resolve => { settled = resolve; });
    session.activeRun = run;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    emit(run, { type: 'open', sessionId: session.record.id, runId: run.id });
    const closed = () => { if (!run.finishing) void stop(session, run).catch(() => {}); };
    res.once('close', closed);
    let status = 'failed';
    try {
      session.record.history.push({ role: 'user', text: body.text.trim() }); await save(session);
      if (run.abort.signal.aborted) throw Error('Assistant stopped before inference.');
      const prompt = `You are inside AIPLAY Studio's DAW, bound to project ${session.record.slug}. Use only the aiplay_daw MCP tools to inspect or edit this project. The UI selection below is a pointer, not proof of current state; read the project before editing. Never use filesystem, shell, web, other projects, plugins or installation tools. Do not automatically repeat a tool action with an uncertain outcome. Describe only edits and measurements actually confirmed; do not claim you heard audio unless a tool provided that evidence. Rendering and deletion need the user's in-panel approval.\nCurrent selection: ${JSON.stringify(context)}\n\n${body.text.trim()}`;
      await session.client.run({ text: prompt, sessionId: session.record.providerSessionId || null, signal: run.abort.signal,
        onSessionId: async id => {
          if (typeof id !== 'string' || !id || id.length > 256) throw Error('The assistant returned an invalid conversation ID.');
          if (session.record.providerSessionId && session.record.providerSessionId !== id) throw Error('The assistant resumed a different conversation.');
          session.record.providerSessionId = id; await save(session);
        } });
      status = run.abort.signal.aborted ? 'stopped' : 'completed';
    } catch (error) {
      status = run.abort.signal.aborted ? 'stopped' : 'failed';
      if (status === 'failed') emit(run, { type: 'error', message: error.message || 'The assistant turn failed.' });
      if (status === 'failed') await stop(session, run).catch(() => {});
    } finally {
      run.finishing = true;
      for (const resolve of run.approvals.values()) resolve(false);
      run.approvals.clear();
      await Promise.allSettled([...run.calls.values()].map(call => call.promise));
      try {
        for (const text of run.messages.values()) if (text) session.record.history.push({ role: 'assistant', text, status });
        // The full provider thread remains resumable; bound the UI transcript.
        session.record.history = session.record.history.slice(-200);
        await save(session);
      } catch {
        status = 'failed'; emit(run, { type: 'error', message: 'The conversation could not be saved. Reconnect before continuing.' });
        await stop(session, run).catch(() => {});
      }
      if (run.stopping) await run.stopping.catch(error => { status = 'failed'; emit(run, { type: 'error', message: error.message }); });
      session.activeRun = null;
      emit(run, { type: 'end', status });
      res.removeListener('close', closed); res.end();
      settled();
    }
  }
  const routes = async (req, res, url) => {
    if (!url.pathname.startsWith(PREFIX + '/')) return false;
    try {
      const mcpMatch = url.pathname.match(/^\/api\/daw-assistant\/mcp\/([^/]+)\/(tools|call)$/);
      if (mcpMatch) {
        if (req.method !== 'POST') throw fault(405, 'Use POST.');
        const session = await getSession(mcpMatch[1]);
        if (!capability(req, session)) throw fault(403, 'This assistant capability is inactive.');
        const run = session.activeRun, body = await bodyJson(req);
        if (session.activeRun !== run || !capability(req, session)) throw fault(403, 'This assistant capability is inactive.');
        if (mcpMatch[2] === 'tools') {
          const tools = toolsFactory({ slug: session.record.slug, api: studioApi });
          json(res, 200, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        } else {
          if (!(typeof body.callId === 'string' && body.callId.length <= 256 || Number.isSafeInteger(body.callId))) throw fault(400, 'A tool call ID is required.');
          const key = `${typeof body.callId}:${body.callId}`, signature = JSON.stringify([body.name, body.arguments || {}]);
          const prior = run.calls.get(key);
          if (prior && prior.signature !== signature) throw fault(409, 'This tool call ID was already used.');
          if (!prior && run.calls.size >= 256) throw fault(429, 'Too many tool calls in this turn.');
          const call = prior || { signature, promise: toolCall(session, run, body) };
          run.calls.set(key, call); json(res, 200, await call.promise);
        }
        return true;
      }
      browserRequest(req);
      if (req.method === 'GET' && url.pathname === PREFIX + '/status') {
        const found = await discover(); json(res, 200, { providers: Object.entries(LABELS).map(([id, label]) => ({ id, label, installed: !!found[id] })), separateSession: true });
      } else if (req.method === 'GET' && url.pathname === PREFIX + '/session') {
        const slug = url.searchParams.get('slug'), provider = url.searchParams.get('provider'); validateBinding(slug, provider);
        const session = await current(slug, provider);
        json(res, 200, session ? publicSession(session) : { sessionId: null, slug, provider, connected: false, history: [] });
      } else if (req.method === 'POST') {
        const body = await bodyJson(req);
        if (url.pathname === PREFIX + '/connect') {
          validateBinding(body.slug, body.provider);
          const key = bindingKey(body.slug, body.provider);
          if (bindings.has(key)) throw fault(409, 'This project is already connecting.');
          bindings.set(key, true);
          try {
            await studioApi('GET', `/api/daw/project/${body.slug}`, undefined, `agent:daw-${body.provider}`);
            let session = await current(body.slug, body.provider);
            if (session?.activeRun) throw fault(409, 'Stop the current turn first.');
            if (session?.blocked) throw fault(409, session.blocked);
            if (!session || body.newSession === true) {
              if (session) {
                session.connected = false;
                if (session.client) {
                  try { await session.client.close(); session.client = null; }
                  catch (error) { session.blocked = error.message; throw error; }
                }
              }
              session = runtime({ version: 1, id: randomUUID(), slug: body.slug, provider: body.provider, history: [], providerSessionId: null });
              await save(session);
              await atomic(path.join(dir, `binding-${key}.json`), { sessionId: session.record.id });
            }
            await connect(session); json(res, 200, publicSession(session));
          } finally { bindings.delete(key); }
        } else if ([PREFIX + '/turn', PREFIX + '/stop', PREFIX + '/approval'].includes(url.pathname)) {
          const session = await getSession(body.sessionId);
          if (url.pathname === PREFIX + '/turn') await turn(session, body, req, res);
          else {
            const run = session.activeRun;
            if (!run || run.id !== body.runId || run.finishing) throw fault(409, 'This assistant turn is no longer active.');
            if (url.pathname.endsWith('/stop')) { await stop(session, run); json(res, 200, { status: 'stopped' }); }
            else {
              if (typeof body.approved !== 'boolean' || !run.approvals.has(body.id)) throw fault(409, 'This confirmation is no longer active.');
              const resolve = run.approvals.get(body.id); run.approvals.delete(body.id); resolve(body.approved); json(res, 200, { ok: true });
            }
          }
        } else throw fault(404, 'Assistant route not found.');
      } else throw fault(404, 'Assistant route not found.');
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.message || 'The assistant request failed.' });
      else if (!res.writableEnded) res.end();
    }
    return true;
  };
  routes.close = async () => {
    await Promise.all([...sessions.values()].map(async session => {
      if (session.activeRun) {
        const run = session.activeRun;
        await stop(session, run).catch(() => {});
        await Promise.race([run.settled, later(stopTimeoutMs, 'Assistant shutdown is still pending.')]).catch(() => {});
      }
      else await Promise.race([session.client?.close(), later(stopTimeoutMs, 'Assistant shutdown is still pending.')]).catch(() => {});
    }));
  };
  return routes;
}
