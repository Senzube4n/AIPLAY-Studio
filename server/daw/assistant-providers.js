/** Owned CLI sessions for the DAW dock. Importing this module launches nothing.
 * Codex: official stdio app-server v2 RPC. Claude: documented print/stream-json.
 * This never attaches to a desktop window or discovers/resumes arbitrary chats.
 * The caller supplies only server-resolved executable/MCP descriptors and an
 * owned session ID from its durable record, never browser command/path input.
 */
import path from 'node:path';
import os from 'node:os';
import { access, stat, opendir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const MAX_LINE = 2 * 1024 * 1024, MAX_DIAGNOSTIC = 8192, RPC_MS = 30_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CODEX_DISABLED = ['shell_tool', 'unified_exec', 'multi_agent', 'apps', 'hooks', 'plugins',
  'goals', 'view_image', 'js_repl', 'apply_patch_freeform', 'browser_use', 'computer_use',
  'image_generation', 'remote_plugin', 'code_mode', 'shell_snapshot', 'skill_mcp_dependency_install'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {}); // A transport can fail before its caller reaches await.
  return { promise, resolve, reject };
};
function failure(message, code = 'ASSISTANT_FAILED') { return Object.assign(new Error(message), { code }); }
function aborted() { const e = failure('The assistant turn was interrupted.', 'ABORT_ERR'); e.name = 'AbortError'; return e; }
function descriptor(value) {
  const e = typeof value === 'string' ? { command: value } : value;
  if (!e || !path.isAbsolute(e.command || '') || /[\0\r\n]/.test(e.command)
      || /\.(?:cmd|bat|ps1)$/i.test(e.command) || !Array.isArray(e.args ?? [])
      || (e.args ?? []).some(a => typeof a !== 'string' || /\0/.test(a)))
    throw failure('Choose an installed native CLI executable.', 'ASSISTANT_UNAVAILABLE');
  return { command: e.command, args: [...(e.args || [])] };
}
async function installed(file, executable = true, platform = process.platform) {
  try { return (await stat(file)).isFile() && (await access(file, executable && platform !== 'win32' ? constants.X_OK : constants.R_OK), true); }
  catch { return false; }
}
async function bundledWindowsCodex(localAppData) {
  if (!localAppData || !path.isAbsolute(localAppData)) return null;
  const root = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  let directory; try { directory = await opendir(root); } catch { return null; }
  let count = 0, newest = null;
  // Installed desktop builds use direct hash directories. Never recurse, run
  // candidates, inspect auth/config or scan the rest of the application data.
  for await (const entry of directory) {
    if (++count > 128) return null;
    if (!entry.isDirectory() || !/^[a-f0-9]{8,64}$/i.test(entry.name)) continue;
    const command = path.join(root, entry.name, 'codex.exe');
    if (!await installed(command, true, 'win32')) continue;
    const info = await stat(command).catch(() => null);
    if (info && (!newest || info.mtimeMs > newest.mtimeMs || info.mtimeMs === newest.mtimeMs && command < newest.command))
      newest = { command, mtimeMs: info.mtimeMs };
  }
  return newest ? { command: newest.command } : null;
}
/** Discovery reads PATH and fixed installer locations; it never installs or executes. */
export async function discoverProviders({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const out = {};
  for (const provider of ['codex', 'claude']) {
    const names = platform === 'win32' ? [`${provider}.exe`] : [provider];
    const folders = [...new Set((env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(p => p && path.isAbsolute(p)))];
    folders.push(path.join(home, '.local', 'bin'));
    for (const folder of folders) {
      for (const name of names) {
        const file = path.join(folder, name);
        if (await installed(file, true, platform)) { out[provider] = { command: file }; break; }
      }
      if (out[provider]) break;
    }
    // npm shims require a shell on Windows. Launch the installed JS entry with
    // this Node instead; never interpolate a prompt into cmd.exe or PowerShell.
    if (!out[provider]) {
      const pkg = provider === 'codex' ? ['@openai', 'codex', 'bin', 'codex.js'] : ['@anthropic-ai', 'claude-code', 'cli.js'];
      const roots = platform === 'win32'
        ? (env.APPDATA ? [path.join(env.APPDATA, 'npm', 'node_modules')] : [])
        : ['/usr/local/lib/node_modules', '/usr/lib/node_modules'];
      for (const root of roots) {
        const file = path.join(root, ...pkg);
        if (await installed(file, false)) { out[provider] = { command: process.execPath, args: [file] }; break; }
      }
    }
    if (!out[provider] && provider === 'codex' && platform === 'win32') {
      const bundled = await bundledWindowsCodex(env.LOCALAPPDATA);
      if (bundled) out[provider] = bundled;
    }
  }
  return out;
}

function launch(exe, args, cwd, spawnFn, env = process.env) {
  return spawnFn(exe.command, [...exe.args, ...args], { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}
function smallCommand(exe, args, cwd, spawnFn) {
  return new Promise((resolve, reject) => {
    let child, text = '', diagnostic = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child?.kill(); finish(failure('The CLI check did not finish.', 'ASSISTANT_UNAVAILABLE')); }, RPC_MS);
    try { child = launch(exe, args, cwd, spawnFn); }
    catch { finish(failure('The installed CLI could not be started.', 'ASSISTANT_UNAVAILABLE')); return; }
    child.on('error', () => finish(failure('The installed CLI could not be started.', 'ASSISTANT_UNAVAILABLE')));
    child.stdin.on('error', () => finish(failure('The CLI check input closed.', 'ASSISTANT_UNAVAILABLE')));
    child.stdout.on('data', b => {
      text += b.toString('utf8');
      if (Buffer.byteLength(text) > 128 * 1024) { child.kill(); finish(failure('The CLI check exceeded its output limit.')); }
    });
    child.stderr.on('data', b => { diagnostic = (diagnostic + b.toString('utf8')).slice(-MAX_DIAGNOSTIC); });
    child.on('close', (code, signal) => finish(null, { code, signal, text, diagnostic }));
    child.stdin.end();
  });
}

/** JSON lines with UTF-8/split-read handling, bounded buffering and close evidence. */
function transport(child, onLine, onFailure) {
  const decoder = new StringDecoder('utf8');
  let buffer = '', chain = Promise.resolve(), dead = false, diagnostic = '';
  const closed = deferred();
  const fail = e => { if (dead) return; dead = true; onFailure(e); child.kill(); };
  const consume = text => {
    buffer += text;
    if (Buffer.byteLength(buffer) > MAX_LINE) { fail(failure('The CLI returned an oversized protocol message.')); return; }
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
      if (!line) continue;
      chain = chain.then(async () => {
        if (dead) return;
        let value;
        try { value = JSON.parse(line); } catch { throw failure('The CLI returned invalid JSON.'); }
        await onLine(value);
      }).catch(fail);
    }
  };
  child.stdout.on('data', b => consume(decoder.write(b)));
  child.stderr.on('data', b => { diagnostic = (diagnostic + b.toString('utf8')).slice(-MAX_DIAGNOSTIC); });
  child.on('error', () => fail(failure('The assistant process failed.')));
  child.stdin.on('error', () => fail(failure('The assistant input connection closed.')));
  child.on('close', (code, signal) => {
    consume(decoder.end());
    if (buffer.trim()) consume('\n');
    chain.finally(() => closed.resolve({ code, signal, diagnostic }));
  });
  return { child, closed: closed.promise, write: value => {
    if (dead || child.stdin.destroyed || child.stdin.writableEnded) throw failure('The assistant connection is closed.');
    child.stdin.write(JSON.stringify(value) + '\n');
  } };
}

function codexConfig(mcp) {
  return { ...Object.fromEntries(CODEX_DISABLED.map(n => [`features.${n}`, false])),
    web_search: 'disabled', sandbox_mode: 'read-only', approval_policy: 'never',
    mcp_servers: { aiplay_daw: { command: mcp.command, args: mcp.args, env: mcp.env, required: true, enabled: true,
      default_tools_approval_mode: 'approve' } } }; // The facade still owns render/delete approval.
}

export function createAssistantClient({ provider, executable, cwd, mcp, onEvent = () => {}, spawnFn = spawn }) {
  if (!['codex', 'claude'].includes(provider)) throw failure('Choose Codex or Claude Code.');
  const exe = descriptor(executable);
  if (!path.isAbsolute(cwd || '') || !mcp || !path.isAbsolute(mcp.command || '') || !Array.isArray(mcp.args)
      || mcp.args.some(a => typeof a !== 'string' || a.includes('\0')) || /[\0\r\n]/.test(mcp.command))
    throw failure('The assistant workspace or guarded MCP command is invalid.');
  const guarded = { command: mcp.command, args: [...mcp.args], env: { ...(mcp.env || {}) } };
  if (Object.entries(guarded.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.includes('\0')))
    throw failure('The guarded MCP environment is invalid.');
  let channel = null, active = null, authenticated = false, closing = false, sequence = 0, boundSession = null, connectPromise = null, runReserved = false;
  let disabledMcpNames = [], disabledPluginNames = [];
  const pending = new Map();
  const emit = event => { try { onEvent(event); } catch { /* A detached viewer is not an agent failure. */ } };
  const state = value => emit({ type: 'state', state: value });
  const rejectPending = error => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear(); active?.done.reject(error);
  };
  const rpc = (method, params = {}) => {
    const d = deferred(), id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); d.reject(failure(`The assistant did not acknowledge ${method}.`)); }, RPC_MS);
    pending.set(id, { ...d, timer, method });
    try { channel.write({ id, method, params }); } catch (e) { clearTimeout(timer); pending.delete(id); d.reject(e); }
    return d.promise;
  };
  async function interrupt() {
    if (!active) return;
    active.cancelRequested = true; state('stopping');
    if (provider === 'codex') {
      if (active.turnId) await rpc('turn/interrupt', { threadId: active.threadId, turnId: active.turnId });
    } else channel?.child.kill('SIGINT');
  }
  async function codexLine(m) {
    if (m.id !== undefined && !m.method) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) {
        // A thread created before its first turn has no rollout to resume once
        // its owning app-server exits. Never silently replace that saved ID.
        const missing = p.method === 'thread/resume' && m.error.code === -32600
          && /^no rollout found for thread id /.test(String(m.error.message));
        return p.reject(missing ? failure('Codex has no saved rollout for this conversation. Choose New chat before sending again.', 'ASSISTANT_SESSION_UNAVAILABLE')
          : failure('Codex rejected the scoped session request.'));
      }
      return p.resolve(m.result);
    }
    if (m.id !== undefined && m.method) {
      // No subprocess, file, credential or unrelated elicitation approvals.
      const result = /^(item\/(?:commandExecution|fileChange)\/requestApproval)$/.test(m.method) ? { decision: 'decline' }
        : m.method === 'mcpServer/elicitation/request' ? { action: 'cancel' } : null;
      channel.write(result ? { id: m.id, result } : { id: m.id, error: { code: -32601, message: 'This DAW session does not provide that capability.' } });
      return;
    }
    if (!active) return;
    const p = m.params || {};
    if (p.threadId && p.threadId !== active.threadId) return;
    if (p.turnId && active.turnId && p.turnId !== active.turnId) return;
    if (m.method === 'turn/started' && p.turn?.id) active.turnId = p.turn.id;
    if (m.method === 'item/agentMessage/delta') emit({ type: 'delta', id: String(p.itemId || 'message'), text: String(p.delta || '') });
    if (['item/started', 'item/completed'].includes(m.method)) {
      const item = p.item || {};
      if (item.type === 'agentMessage' && m.method === 'item/completed') emit({ type: 'message', id: String(item.id), text: String(item.text || '') });
      else if (item.type === 'mcpToolCall') {
        if (item.server !== 'aiplay_daw') throw failure('Codex attempted a tool outside this DAW session.');
        emit({ type: 'tool', name: String(item.tool), status: String(item.status || (m.method === 'item/started' ? 'inProgress' : 'unknown')) });
      } else if (!['agentMessage', 'userMessage', 'reasoning', 'plan'].includes(item.type))
        throw failure('Codex attempted a capability outside this DAW session.');
    }
    if (m.method === 'turn/completed') {
      if (!p.turn || (active.turnId && p.turn.id !== active.turnId)) return;
      if (p.turn.status === 'completed' && !active.cancelRequested) active.done.resolve();
      else active.done.reject(p.turn.status === 'interrupted' || active.cancelRequested ? aborted() : failure('The Codex turn failed.'));
    }
  }
  async function connect() {
    if (closing) return { authenticated: false, message: 'The assistant session is closed.' };
    if (authenticated) return { authenticated: true };
    if (connectPromise) return connectPromise;
    connectPromise = (async () => {
      try {
        state('connecting');
        const help = await smallCommand(exe, provider === 'codex' ? ['app-server', '--help'] : ['--help'], cwd, spawnFn);
        if (closing) throw failure('The assistant session is closed.');
        const required = provider === 'codex' ? ['--strict-config', '--listen']
          : ['--output-format', '--verbose', '--include-partial-messages', '--mcp-config', '--strict-mcp-config', '--tools', '--allowedTools', '--resume', '--settings'];
        if (help.code !== 0 || required.some(flag => !help.text.includes(flag))) throw failure('Update the installed CLI: it does not support the scoped DAW connection.', 'ASSISTANT_UNAVAILABLE');
        if (provider === 'claude') {
          const auth = await smallCommand(exe, ['auth', 'status'], cwd, spawnFn);
          let a; try { a = JSON.parse(auth.text); } catch { throw failure('Claude Code did not return a supported sign-in check.'); }
          authenticated = auth.code === 0 && (a.loggedIn === true || a.authenticated === true
            || ['claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'].includes(a.authMethod));
        } else {
          // Clear inherited MCP servers before any thread exists. Secrets for
          // the guarded server are sent later over stdin, never on argv.
          const initial = { ...Object.fromEntries(CODEX_DISABLED.map(n => [`features.${n}`, false])),
            web_search: 'disabled', sandbox_mode: 'read-only', approval_policy: 'never', mcp_servers: {} };
          const args = ['app-server', '--listen', 'stdio://', '--strict-config', ...Object.entries(initial).flatMap(([k, v]) => ['-c', `${k}=${JSON.stringify(v)}`])];
          const open = async extra => {
            const owned = transport(launch(exe, [...args, ...extra], cwd, spawnFn), codexLine, rejectPending);
            channel = owned;
            owned.closed.then(() => { if (channel === owned) { authenticated = false; rejectPending(failure('The Codex connection closed before the turn settled.')); } });
            await rpc('initialize', { clientInfo: { name: 'aiplay_daw', title: 'AIPLAY DAW assistant', version: '0.1.0' } });
            owned.write({ method: 'initialized', params: {} });
            return (await rpc('config/read', { includeLayers: false })).config;
          };
          let config = await open([]);
          // Config table overrides merge with inherited tables. An empty map
          // alone does not disable servers. Enumerate only their names, then
          // restart this owned connection with explicit per-entry false flags.
          disabledMcpNames = Object.keys(config?.mcp_servers || {});
          disabledPluginNames = Object.keys(config?.plugins || {});
          // Codex's -c dotted-path reader treats quotes literally rather than
          // as TOML key quoting. Refuse names it cannot address unambiguously.
          if ([...disabledMcpNames, ...disabledPluginNames].some(n => !/^[A-Za-z0-9_@/-]+$/.test(n)))
            throw failure('An inherited Codex integration cannot be scoped safely.', 'ASSISTANT_UNAVAILABLE');
          if (disabledMcpNames.length || disabledPluginNames.length) {
            const old = channel; old.child.stdin.end(); await old.closed; channel = null;
            config = await open([
              ...disabledMcpNames.flatMap(n => ['-c', `mcp_servers.${n}.enabled=false`]),
              ...disabledPluginNames.flatMap(n => ['-c', `plugins.${n}.enabled=false`]),
            ]);
          }
          if (!config || CODEX_DISABLED.some(n => config.features?.[n] !== false) || config.web_search !== 'disabled'
              || config.sandbox_mode !== 'read-only' || config.approval_policy !== 'never'
              || Object.values(config.mcp_servers || {}).some(s => s.enabled !== false)
              || Object.values(config.plugins || {}).some(p => p.enabled !== false))
            throw failure('This Codex configuration cannot enforce a DAW-only session.', 'ASSISTANT_UNAVAILABLE');
          const a = await rpc('account/read', { refreshToken: false });
          authenticated = !!a?.account;
        }
        if (closing) throw failure('The assistant session is closed.');
        state(authenticated ? 'ready' : 'signed-out');
        if (!authenticated && channel) { channel.child.stdin.end(); await channel.closed; channel = null; }
        return { authenticated, ...(!authenticated ? { message: `Sign in to ${provider === 'codex' ? 'Codex' : 'Claude Code'} in its own app or CLI, then reconnect.` } : {}) };
      } catch (e) {
        if (channel) { channel.child.kill(); await channel.closed; channel = null; }
        authenticated = false; state('unavailable');
        return { authenticated: false, message: e.code === 'ASSISTANT_UNAVAILABLE' ? e.message : 'The CLI connection could not be verified. Check its installation and sign-in.' };
      } finally { connectPromise = null; }
    })();
    return connectPromise;
  }

  async function run({ text, sessionId = null, signal, onSessionId }) {
    if (active || runReserved) throw failure('This assistant already has an active turn.');
    if (typeof text !== 'string' || !text.trim() || text.length > 64_000) throw failure('Send a message of at most 64,000 characters.');
    if (sessionId !== null && (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId))) throw failure('The saved assistant session ID is invalid.');
    if (boundSession && sessionId !== boundSession) throw failure('This client belongs to a different assistant session.');
    if (typeof onSessionId !== 'function') throw failure('The assistant needs a durable session recorder before it can run.');
    if (signal?.aborted) throw aborted();
    runReserved = true;
    try {
      if (!(await connect()).authenticated || closing) throw failure('Connect a signed-in CLI first.', 'ASSISTANT_UNAVAILABLE');
      if (signal?.aborted) throw aborted();
    } catch (e) { runReserved = false; throw e; }
    active = { threadId: sessionId, turnId: null, done: deferred(), cancelRequested: false };
    const turn = active;
    const stop = () => { interrupt().catch(e => turn.done.reject(e)); };
    signal?.addEventListener('abort', stop, { once: true });
    try {
      state('running');
      if (provider === 'codex') {
        const result = await rpc(sessionId ? 'thread/resume' : 'thread/start', {
          ...(sessionId ? { threadId: sessionId, excludeTurns: true } : {}), cwd, sandbox: 'read-only', approvalPolicy: 'never',
          config: { ...codexConfig(guarded),
            mcp_servers: { ...Object.fromEntries(disabledMcpNames.filter(n => n !== 'aiplay_daw').map(n => [n, { enabled: false }])), ...codexConfig(guarded).mcp_servers },
            plugins: Object.fromEntries(disabledPluginNames.map(n => [n, { enabled: false }])),
          }, developerInstructions: 'Work only through the aiplay_daw MCP server for the open DAW project. Do not access the filesystem, shell, browser, other applications or other projects.',
        });
        const id = result?.thread?.id;
        if (!SAFE_ID.test(id || '') || (sessionId && id !== sessionId)) throw failure('Codex returned a different assistant session.');
        turn.threadId = id; boundSession = id;
        await onSessionId(id); // Persist before tools, inference or any streamed text.
        if (result.sandbox?.type !== 'readOnly' || result.sandbox.networkAccess === true || result.approvalPolicy !== 'never')
          throw failure('Codex did not apply the restricted DAW permissions.');
        const inventory = await rpc('mcpServerStatus/list', { threadId: id, limit: 100 });
        // The installed server also reports disabled inherited configurations.
        // Keep those only when their runtime confirms disabled with no tools;
        // an extra live/unknown connection must never reach inference.
        const rows = Array.isArray(inventory.data) ? inventory.data : [];
        const own = rows.filter(s => s.name === 'aiplay_daw');
        if (inventory.nextCursor || !Array.isArray(inventory.data) || own.length !== 1
            || own[0].runtimeStatus !== 'connected' || own[0].toolsError || !Object.keys(own[0].tools || {}).length
            || rows.some(s => s.name !== 'aiplay_daw' && (s.runtimeStatus !== 'disabled' || s.toolsError || Object.keys(s.tools || {}).length)))
          throw failure('Codex could not verify the guarded DAW tools.');
        if (turn.cancelRequested || signal?.aborted) throw aborted();
        const started = await rpc('turn/start', { threadId: id, cwd, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, input: [{ type: 'text', text }] });
        if (!started?.turn?.id) throw failure('Codex did not acknowledge its turn.');
        turn.turnId = started.turn.id;
        if (turn.cancelRequested) await interrupt();
        await turn.done.promise;
      } else {
        // Environment placeholders keep the guarded server's capability token
        // out of argv. Claude expands these in its documented MCP JSON format.
        const env = { ...process.env }, serverEnv = {};
        Object.entries(guarded.env).forEach(([key, value], i) => { const variable = `AIPLAY_DAW_BRIDGE_${i}`; env[variable] = value; serverEnv[key] = '${' + variable + '}'; });
        const server = { type: 'stdio', command: guarded.command, args: guarded.args, env: serverEnv };
        const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
          '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { aiplay_daw: server } }),
          '--tools', '', '--allowedTools', 'mcp__aiplay_daw__*', '--permission-mode', 'default',
          '--settings', JSON.stringify({ disableAllHooks: true }), ...(sessionId ? ['--resume', sessionId] : [])];
        let terminal = null, seenId = sessionId, initialized = false, streamId = 'message';
        const calls = new Map();
        const line = async m => {
          if (m.session_id && m.session_id !== seenId) {
            if (seenId || !SAFE_ID.test(m.session_id)) throw failure('Claude returned a different assistant session.');
            seenId = m.session_id; boundSession = seenId; await onSessionId(seenId);
          } else if (m.type === 'system' && m.subtype === 'init' && seenId) {
            boundSession = seenId; await onSessionId(seenId);
          }
          if (!seenId && ['assistant', 'stream_event', 'result'].includes(m.type)) throw failure('Claude emitted a turn without a durable session ID.');
          if (m.type === 'system' && m.subtype === 'init') {
            if (!Array.isArray(m.mcp_servers) || m.mcp_servers.length !== 1 || m.mcp_servers[0].name !== 'aiplay_daw'
                || m.mcp_servers[0].status !== 'connected' || !Array.isArray(m.tools)
                || m.tools.some(name => !name.startsWith('mcp__aiplay_daw__')))
              throw failure('Claude did not isolate the guarded DAW tools.');
            initialized = true;
          }
          if (!initialized && ['assistant', 'stream_event', 'result'].includes(m.type)) throw failure('Claude emitted output before verifying the DAW connection.');
          if (m.type === 'stream_event' && m.event?.type === 'message_start' && m.event.message?.id) streamId = m.event.message.id;
          if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta')
            emit({ type: 'delta', id: String(streamId), text: String(m.event.delta.text || '') });
          if (m.type === 'assistant') for (const b of m.message?.content || []) {
            if (b.type === 'text') emit({ type: 'message', id: String(m.message.id || m.uuid || 'message'), text: String(b.text || '') });
            if (b.type === 'tool_use') {
              if (!String(b.name).startsWith('mcp__aiplay_daw__')) throw failure('Claude attempted a tool outside this DAW session.');
              calls.set(b.id, b.name); emit({ type: 'tool', name: b.name, status: 'inProgress' });
            }
          }
          if (m.type === 'user') for (const b of m.message?.content || []) if (b.type === 'tool_result' && calls.has(b.tool_use_id))
            emit({ type: 'tool', name: calls.get(b.tool_use_id), status: b.is_error ? 'failed' : 'completed' });
          if (m.type === 'system' && m.subtype === 'permission_denied') state('permission-denied');
          if (m.type === 'result') terminal = m;
        };
        channel = transport(launch(exe, args, cwd, spawnFn, env), line, e => turn.done.reject(e));
        channel.child.stdin.end(text);
        const settled = channel.closed.then(exit => {
          if (turn.cancelRequested || signal?.aborted) throw aborted();
          if (exit.code !== 0 || exit.signal || !terminal || terminal.is_error || terminal.subtype !== 'success') throw failure('The Claude Code turn did not complete successfully.');
          if (!seenId) throw failure('Claude did not return its session ID.');
          return seenId;
        });
        seenId = await Promise.race([settled, turn.done.promise]); boundSession = seenId;
      }
      state('completed'); return { sessionId: boundSession };
    } catch (e) {
      state(e.name === 'AbortError' ? 'interrupted' : 'failed');
      if (provider === 'codex' && turn.turnId) await interrupt().catch(() => {});
      if (provider === 'claude') channel?.child.kill();
      throw e;
    } finally {
      signal?.removeEventListener('abort', stop);
      active = null;
      runReserved = false;
    }
  }
  async function close() {
    closing = true;
    if (active) await interrupt().catch(() => {});
    const current = channel; authenticated = false;
    if (current) {
      current.child.stdin.end();
      let observedClose = false;
      const evidence = current.closed.then(() => { observedClose = true; });
      await Promise.race([evidence, sleep(500)]);
      if (!observedClose) current.child.kill();
      await Promise.race([evidence, sleep(1000)]);
      if (!observedClose) {
        state('stop-unconfirmed');
        throw failure('The owned assistant process has not confirmed exit. Keep this session stopped and do not start a replacement.', 'ASSISTANT_STOP_UNCONFIRMED');
      }
      if (channel === current) channel = null;
    }
    rejectPending(failure('The assistant session was closed.'));
    state('closed');
  }
  return { connect, run, interrupt, close };
}
