/** Fake subprocess protocol tests. No installed CLI, login, model or Studio call. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { createAssistantClient, discoverProviders } from './assistant-providers.js';

const cwd = path.resolve('tmp/assistant-fixture');
const executable = path.resolve('tmp/assistant-fixture/provider.exe');
const mcp = { command: process.execPath, args: [path.resolve('server/daw/assistant-mcp.js')], env: { AIPLAY_DAW_TOKEN: 'test-only-private-capability' } };
const wait = () => new Promise(resolve => setImmediate(resolve));
async function discoveryFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiplay-provider-discovery-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  const home = path.join(root, 'home'), localAppData = path.join(root, 'local');
  await mkdir(home, { recursive: true });
  const bundle = async (hash, time) => {
    const command = path.join(localAppData, 'OpenAI', 'Codex', 'bin', hash, 'codex.exe');
    await mkdir(path.dirname(command), { recursive: true }); await writeFile(command, 'fixture, never executed');
    await utimes(command, time, time); return command;
  };
  return { root, home, localAppData, bundle };
}
test('Windows discovery finds the newest installed hash-directory Codex CLI without PATH', async t => {
  const f = await discoveryFixture(t);
  await f.bundle('11111111', 10); const newest = await f.bundle('22222222', 20);
  await f.bundle('not-a-build-hash', 30);
  const found = await discoverProviders({ env: { PATH: '', LOCALAPPDATA: f.localAppData }, home: f.home, platform: 'win32' });
  assert.deepEqual(found, { codex: { command: newest } });
});
test('Windows discovery preserves PATH priority over a newer desktop bundle', async t => {
  const f = await discoveryFixture(t); await f.bundle('22222222', 20);
  const bin = path.join(f.root, 'path-bin'), command = path.join(bin, 'codex.exe');
  await mkdir(bin); await writeFile(command, 'fixture, never executed');
  const found = await discoverProviders({ env: { PATH: bin, LOCALAPPDATA: f.localAppData }, home: f.home, platform: 'win32' });
  assert.deepEqual(found, { codex: { command } });
});
class Child extends EventEmitter {
  constructor(onInput, onEnd = () => {}) {
    super(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.exitCode = null; this.signalCode = null;
    this.stdin = new Writable({ write: (chunk, _, done) => { onInput(String(chunk), this); done(); }, final: done => { onEnd(this); done(); } });
  }
  json(value, split = false) {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    if (split) for (let n = 0; n < bytes.length; n += 3) this.stdout.write(bytes.subarray(n, n + 3));
    else this.stdout.write(bytes);
  }
  finish(code = 0, signal = null) { if (this.exitCode !== null || this.signalCode !== null) return; this.exitCode = code; this.signalCode = signal; this.emit('close', code, signal); }
  kill(signal = 'SIGTERM') { this.finish(null, signal); return true; }
}
function rig(provider = 'codex', options = {}) {
  const r = { spawns: [], requests: [], replies: [], events: [], persisted: [], turns: 0, runChild: null };
  const finishTurn = (child, status = options.status || 'completed') => child.json({ method: 'turn/completed', params: { threadId: 'thread_owned', turn: { id: 'turn_owned', status } } });
  const spawnFn = (command, args, opts) => {
    assert.equal(command, executable); assert.equal(opts.shell, false); assert.equal(opts.windowsHide, true); assert.equal(opts.cwd, cwd);
    r.spawns.push({ args, opts });
    if (args.includes('--help')) {
      const child = new Child(() => {}, c => { queueMicrotask(() => {
        c.stdout.write(options.oldCli ? '--print' : '--strict-config --listen --output-format --verbose --include-partial-messages --mcp-config --strict-mcp-config --tools --allowedTools --resume --settings'); c.finish();
      }); });
      return child;
    }
    if (args[0] === 'auth') return new Child(() => {}, c => queueMicrotask(() => { c.stdout.write(JSON.stringify({ loggedIn: !options.signedOut, authMethod: options.signedOut ? 'none' : 'claude.ai' })); c.finish(options.signedOut ? 1 : 0); }));
    if (provider === 'claude') {
      let prompt = '';
      const child = new Child(chunk => { prompt += chunk; }, c => queueMicrotask(() => {
        r.prompt = prompt;
        c.json({ type: 'system', subtype: 'init', session_id: 'session_owned', mcp_servers: [{ name: options.foreignMcp ? 'other' : 'aiplay_daw', status: 'connected' }], tools: ['mcp__aiplay_daw__daw_status'] }, true);
        c.json({ type: 'stream_event', session_id: 'session_owned', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'café 🎵' } } }, true);
        c.json({ type: 'assistant', session_id: 'session_owned', message: { id: 'answer1', content: [{ type: 'tool_use', id: 'tool1', name: options.foreignTool ? 'Bash' : 'mcp__aiplay_daw__daw_status' }] } });
        if (options.hang) return;
        c.json({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', is_error: false }] } });
        c.json({ type: 'assistant', session_id: 'session_owned', message: { id: 'answer2', content: [{ type: 'text', text: 'Your DAW project is ready.' }] } });
        if (!options.noResult) c.json({ type: 'result', subtype: options.status === 'failed' ? 'error_during_execution' : 'success', session_id: 'session_owned', is_error: options.status === 'failed' });
        setImmediate(() => c.finish(options.exitCode || 0));
      })); r.runChild = child; return child;
    }
    let buffer = '';
    const child = new Child((chunk, c) => {
      buffer += chunk; let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
        if (!msg.method) { r.replies.push(msg); continue; }
        r.requests.push(msg);
        queueMicrotask(() => {
          if (msg.id === undefined) return;
          const reply = result => c.json({ id: msg.id, result }, true);
          if (msg.method === 'initialize') return reply({ userAgent: 'fake' });
          if (msg.method === 'config/read') {
            const config = { features: {}, web_search: 'disabled', sandbox_mode: 'read-only', approval_policy: 'never', mcp_servers: {}, plugins: {} };
            for (let i = 0; i < args.length; i++) if (args[i] === '-c') {
              const [key, value] = args[i + 1].split('='); if (key.startsWith('features.')) config.features[key.slice(9)] = JSON.parse(value);
            }
            if (options.unsafeConfig) config.features.shell_tool = true;
            if (options.foreignMcp || options.inheritedMcp) config.mcp_servers.other = { enabled: options.foreignMcp || !args.includes('mcp_servers.other.enabled=false') };
            if (options.inheritedMcp) config.plugins['friend@official'] = { enabled: !args.includes('plugins.friend@official.enabled=false') };
            return reply({ config });
          }
          if (msg.method === 'account/read') return reply({ account: options.signedOut ? null : { type: 'chatgpt', email: 'not-exported@example.invalid' } });
          if (['thread/start', 'thread/resume'].includes(msg.method)) {
            if (msg.method === 'thread/resume' && options.missingRollout) return c.json({ id: msg.id, error: { code: -32600, message: 'no rollout found for thread id thread_owned' } });
            return reply({ thread: { id: 'thread_owned' }, sandbox: { type: options.unsafeSandbox ? 'dangerFullAccess' : 'readOnly' }, approvalPolicy: 'never' });
          }
          if (msg.method === 'mcpServerStatus/list') return reply({ data: [{ name: 'aiplay_daw', runtimeStatus: options.guardedStarting ? 'starting' : 'connected', tools: { daw_status: {} }, toolsError: null }, ...(options.inventoryExtra ? [options.inventoryExtra] : [])], nextCursor: null });
          if (msg.method === 'turn/interrupt') { reply({}); return finishTurn(c, 'interrupted'); }
          if (msg.method === 'turn/start') {
            r.turns++; reply({ turn: { id: 'turn_owned', status: 'inProgress' } });
            if (options.approval) c.json({ id: 999, method: options.approval, params: { threadId: 'thread_owned', turnId: 'turn_owned' } });
            c.json({ method: 'item/agentMessage/delta', params: { threadId: 'thread_owned', turnId: 'turn_owned', itemId: 'answer', delta: 'café 🎵' } }, true);
            c.json({ method: 'item/started', params: { threadId: 'thread_owned', item: { id: 'tool1', type: 'mcpToolCall', server: options.foreignTool ? 'other' : 'aiplay_daw', tool: 'daw_status', status: 'inProgress' } } });
            if (!options.hang) {
              c.json({ method: 'item/completed', params: { threadId: 'thread_owned', item: { id: 'answer', type: 'agentMessage', text: 'Done.' } } });
              finishTurn(c);
            }
          }
        });
      }
    }, c => queueMicrotask(() => c.finish()));
    r.runChild = child; return child;
  };
  r.client = createAssistantClient({ provider, executable, cwd, mcp, onEvent: e => r.events.push(e), spawnFn });
  r.run = extra => r.client.run({ text: 'Read my open project', onSessionId: async id => { r.persisted.push(id); }, ...extra });
  return r;
}

test('Codex connects without inference, clears inherited MCP and verifies sign-in/restrictions', async t => {
  const r = rig(); t.after(() => r.client.close());
  assert.deepEqual(await r.client.connect(), { authenticated: true });
  assert.equal(r.turns, 0);
  assert.deepEqual(r.requests.map(m => m.method), ['initialize', 'initialized', 'config/read', 'account/read']);
  assert.ok(r.spawns[1].args.includes('--strict-config'));
  assert.ok(r.spawns[1].args.includes('mcp_servers={}'));
  assert.ok(!JSON.stringify(r.events).includes('not-exported'));
});
test('Codex persists its owned thread before turn/start; keeps configured model and streams split UTF-8', async t => {
  const r = rig(); t.after(() => r.client.close());
  let release; const saved = new Promise(resolve => { release = resolve; });
  const running = r.run({ onSessionId: async id => { r.persisted.push(id); await saved; } });
  while (!r.persisted.length) await wait();
  assert.equal(r.turns, 0); release();
  assert.deepEqual(await running, { sessionId: 'thread_owned' });
  const start = r.requests.find(m => m.method === 'thread/start');
  assert.equal(start.params.sandbox, 'read-only'); assert.equal(start.params.model, undefined);
  assert.deepEqual(start.params.config.mcp_servers.aiplay_daw.env, mcp.env);
  assert.equal(start.params.config.mcp_servers.aiplay_daw.default_tools_approval_mode, 'approve');
  assert.equal(start.params.approvalPolicy, 'never');
  assert.equal(start.params.config.approval_policy, 'never');
  assert.ok(!JSON.stringify(r.spawns).includes(mcp.env.AIPLAY_DAW_TOKEN));
  assert.ok(r.events.some(e => e.type === 'delta' && e.text === 'café 🎵'));
  assert.equal(r.events.at(-1).state, 'completed');
  await r.run({ sessionId: 'thread_owned' });
  assert.ok(r.requests.some(m => m.method === 'thread/resume' && m.params.threadId === 'thread_owned'));
  await assert.rejects(r.run({ sessionId: 'some_other_thread' }), /different assistant session/);
});
test('a persistence failure never starts inference', async t => {
  const r = rig(); t.after(() => r.client.close());
  await assert.rejects(r.run({ onSessionId: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(r.turns, 0);
});
test('overlapping turns cannot bypass ownership while the connection is starting', async t => {
  const r = rig(); t.after(() => r.client.close());
  const first = r.run();
  await assert.rejects(r.run(), /already has an active turn/);
  await first; assert.equal(r.turns, 1);
});
test('unsupported CLI, effective shell permissions and inherited MCP fail closed without inference', async () => {
  for (const options of [{ oldCli: true }, { unsafeConfig: true }, { foreignMcp: true }, { signedOut: true }]) {
    const r = rig('codex', options);
    assert.equal((await r.client.connect()).authenticated, false); assert.equal(r.turns, 0); await r.client.close();
  }
});
test('Codex rejects a permissive thread sandbox before inference', async t => {
  const r = rig('codex', { unsafeSandbox: true }); t.after(() => r.client.close());
  await assert.rejects(r.run(), /restricted DAW permissions/); assert.equal(r.turns, 0);
});
test('Codex explicitly disables inherited MCP/plugin entries after reading names, without a model turn', async t => {
  const r = rig('codex', { inheritedMcp: true }); t.after(() => r.client.close());
  assert.deepEqual(await r.client.connect(), { authenticated: true }); assert.equal(r.turns, 0);
  assert.ok(r.spawns.at(-1).args.includes('mcp_servers.other.enabled=false'));
  assert.ok(r.spawns.at(-1).args.includes('plugins.friend@official.enabled=false'));
});
test('Codex accepts an explicitly disabled empty inherited inventory row, but rejects live or unknown extras before inference', async () => {
  const allowed = rig('codex', { inventoryExtra: { name: 'other', runtimeStatus: 'disabled', tools: {}, toolsError: null } });
  await allowed.run(); assert.equal(allowed.turns, 1); await allowed.client.close();
  for (const inventoryExtra of [
    { name: 'other', runtimeStatus: 'connected', tools: {} },
    { name: 'other', runtimeStatus: null, tools: {} },
    { name: 'other', runtimeStatus: 'disabled', tools: { hidden: {} } },
    { name: 'other', runtimeStatus: 'disabled', tools: {}, toolsError: 'failed' },
    { name: 'aiplay_daw', runtimeStatus: 'connected', tools: { other: {} } },
  ]) {
    const r = rig('codex', { inventoryExtra });
    await assert.rejects(r.run(), /guarded DAW tools/); assert.equal(r.turns, 0); await r.client.close();
  }
  const starting = rig('codex', { guardedStarting: true });
  await assert.rejects(starting.run(), /guarded DAW tools/); assert.equal(starting.turns, 0); await starting.client.close();
});
test('a missing never-started rollout requests New chat without silently creating a replacement or inferring', async t => {
  const r = rig('codex', { missingRollout: true }); t.after(() => r.client.close());
  await assert.rejects(r.run({ sessionId: 'thread_owned' }), { code: 'ASSISTANT_SESSION_UNAVAILABLE' });
  assert.equal(r.turns, 0); assert.ok(!r.requests.some(m => m.method === 'thread/start'));
});
test('Codex never accepts shell/file/unknown approval requests', async () => {
  for (const approval of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'unknown/capability']) {
    const r = rig('codex', { approval }); await r.run();
    const answer = r.replies.find(x => x.id === 999);
    if (approval === 'unknown/capability') assert.equal(answer.error.code, -32601);
    else assert.deepEqual(answer.result, { decision: 'decline' });
    await r.client.close();
  }
});
test('failed or foreign Codex tool outcomes are never reported completed', async () => {
  for (const options of [{ status: 'failed' }, { foreignTool: true }]) {
    const r = rig('codex', options); await assert.rejects(r.run());
    assert.ok(!r.events.some(e => e.type === 'state' && e.state === 'completed')); await r.client.close();
  }
});
test('abort interrupts only the exact owned Codex turn and waits for interrupted terminal state', async t => {
  const r = rig('codex', { hang: true }); t.after(() => r.client.close());
  const signal = new AbortController(), running = r.run({ signal: signal.signal });
  while (!r.turns) await wait(); signal.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.deepEqual(r.requests.find(m => m.method === 'turn/interrupt').params, { threadId: 'thread_owned', turnId: 'turn_owned' });
  assert.ok(!r.requests.some(m => /command\/exec|thread\/delete/.test(m.method)));
});
test('Claude preserves installed login, uses only scoped MCP and keeps prompt/capability out of argv', async t => {
  const r = rig('claude'); t.after(() => r.client.close());
  assert.deepEqual(await r.client.connect(), { authenticated: true }); assert.equal(r.spawns.length, 2);
  assert.deepEqual(await r.run(), { sessionId: 'session_owned' });
  const launched = r.spawns.at(-1), args = launched.args;
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__aiplay_daw__*');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.some(a => /bare|bypassPermissions|dangerously-skip/.test(a)));
  assert.ok(!JSON.stringify(args).includes(mcp.env.AIPLAY_DAW_TOKEN));
  assert.ok(!JSON.stringify(args).includes('Read my open project'));
  assert.equal(launched.opts.env.AIPLAY_DAW_BRIDGE_0, mcp.env.AIPLAY_DAW_TOKEN);
  assert.deepEqual(r.persisted, ['session_owned']);
  assert.ok(r.events.some(e => e.type === 'delta' && e.text === 'café 🎵'));
  await r.run({ sessionId: 'session_owned' });
  assert.equal(r.spawns.at(-1).args[r.spawns.at(-1).args.indexOf('--resume') + 1], 'session_owned');
  assert.ok(!r.spawns.at(-1).args.includes('--continue'));
});
test('Claude does not mistake missing result, failure, foreign MCP/tool or nonzero exit for success', async () => {
  for (const options of [{ noResult: true }, { status: 'failed' }, { foreignTool: true }, { foreignMcp: true }, { exitCode: 1 }]) {
    const r = rig('claude', options); await assert.rejects(r.run());
    assert.ok(!r.events.some(e => e.type === 'state' && e.state === 'completed')); await r.client.close();
  }
});
test('Claude interruption affects only its owned child and does not invent a completed result', async t => {
  const r = rig('claude', { hang: true }); t.after(() => r.client.close());
  const controller = new AbortController(), running = r.run({ signal: controller.signal });
  while (!r.runChild) await wait(); controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(r.runChild.signalCode, 'SIGINT');
  assert.ok(!r.events.some(e => e.type === 'state' && e.state === 'completed'));
});
test('close refuses to discard a child without an actual close event, for either provider', async () => {
  for (const provider of ['codex', 'claude']) {
    const r = rig(provider, { hang: true });
    const running = r.run(); running.catch(() => {});
    while (!r.runChild || (provider === 'codex' && !r.turns)) await wait();
    const child = r.runChild, originalKill = child.kill;
    child.kill = () => true;
    if (provider === 'codex') child.stdin.end = () => {};
    await assert.rejects(r.client.close(), { code: 'ASSISTANT_STOP_UNCONFIRMED' });
    assert.equal(r.events.at(-1).state, 'stop-unconfirmed');
    assert.equal((await r.client.connect()).authenticated, false, 'a replacement cannot start on this client');
    child.kill = originalKill; child.finish(0); await r.client.close(); await assert.rejects(running);
  }
});
