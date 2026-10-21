import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDawAssistantRoutes } from './assistant.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function fixture(t, options = {}) {
  const dir = options.dir || await mkdtemp(path.join(os.tmpdir(), 'aiplay-assistant-'));
  const instances = [], calls = [];
  const config = { uiPort: 0, paths: { appData: dir } };
  const api = async (...args) => { calls.push(args); return { slug: 'song', tracks: [], revision: 1 }; };
  const routes = createDawAssistantRoutes({ config, dir, api, stopTimeoutMs: options.stopTimeoutMs || 12000, discover: async () => ({ codex: { command: 'fake-codex' }, claude: { command: 'fake-claude' } }),
    clientFactory: params => {
      const done = deferred();
      done.promise.catch(() => {}); // A Stop can precede the first inference callback.
      const item = { params, done, interrupts: 0, closes: 0, runs: [] };
      instances.push(item);
      return {
        connect: async () => ({ authenticated: options.authenticated !== false }),
        run: async input => {
          item.runs.push(input); await input.onSessionId(input.sessionId || 'owned-provider-thread');
          if (options.run) return options.run(item, input);
          input.signal.addEventListener('abort', () => done.reject(Error('interrupted')), { once: true });
          return done.promise;
        },
        interrupt: async () => { item.interrupts++; done.reject(Error('interrupted')); },
        close: async () => { item.closes++; if (options.close) await options.close(item); if (options.stubborn) await new Promise(() => {}); },
      };
    },
    toolsFactory: ({ slug, api: toolApi }) => [
      { name: 'daw_edit', description: 'edit', inputSchema: { type: 'object' }, gate: null,
        validate: args => { assert.equal(args.slug, slug); return args; }, run: args => toolApi('POST', '/api/daw', args) },
      { name: 'daw_render', description: 'render', inputSchema: { type: 'object' }, gate: 'gpu',
        validate: args => { assert.equal(args.slug, slug); return args; }, run: args => toolApi('POST', '/api/daw', args) },
    ],
  });
  const server = createServer((req, res) => {
    if (req.headers['x-fixture-lan'] === 'true') req.lanClient = true;
    void routes(req, res, new URL(req.url, 'http://localhost')).then(handled => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.uiPort = server.address().port;
  const base = `http://127.0.0.1:${config.uiPort}`;
  const post = (route, body, headers = {}) => fetch(base + '/api/daw-assistant' + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
  const get = route => fetch(base + '/api/daw-assistant' + route);
  const connect = async (extra = {}) => { const response = await post('/connect', { slug: 'song', provider: 'codex', ...extra }); assert.equal(response.status, 200); return response.json(); };
  const mcp = (item, route, body) => fetch(item.params.mcp.env.AIPLAY_ASSISTANT_URL + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${item.params.mcp.env.AIPLAY_ASSISTANT_TOKEN}` }, body: JSON.stringify(body) });
  const begin = async sessionId => stream(await post('/turn', { sessionId, text: 'Add a note', context: { slug: 'song', trackId: 'track-1', noteIds: ['note-1'] } }));
  const close = async () => { await routes.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  t.after(async () => { if (server.listening) await close(); if (!options.dir) await rm(dir, { recursive: true, force: true }); });
  return { dir, instances, calls, get, post, connect, mcp, begin, close };
}
function stream(response) {
  assert.equal(response.status, 200);
  const reader = response.body.getReader(); let buffer = '';
  return {
    async next(type) {
      for (;;) {
        const at = buffer.indexOf('\n\n');
        if (at >= 0) {
          const text = buffer.slice(0, at); buffer = buffer.slice(at + 2);
          const event = JSON.parse(text.slice(6));
          if (!type || event.type === type) return event;
        } else {
          const chunk = await reader.read();
          if (chunk.done) throw Error(`Stream ended before ${type}`);
          buffer += Buffer.from(chunk.value).toString('utf8');
        }
      }
    }, cancel: () => reader.cancel(),
  };
}

test('status is inert; cross-origin, LAN, unknown IDs and bad project selections refuse', async t => {
  const f = await fixture(t);
  assert.equal((await (await f.get('/status')).json()).providers.length, 2);
  assert.equal(f.instances.length, 0);
  assert.equal((await f.post('/connect', { slug: 'song', provider: 'codex' }, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await f.post('/connect', { slug: 'song', provider: 'codex' }, { 'x-fixture-lan': 'true' })).status, 403);
  assert.equal((await f.post('/connect', { slug: '../song', provider: 'codex' })).status, 400);
  assert.equal((await f.post('/connect', { slug: 'song', provider: 'arbitrary.exe' })).status, 400);
  assert.equal((await f.post('/turn', { sessionId: 'unknown' })).status, 404);
  assert.equal(f.instances.length, 0);
});

test('connect checks CLI login without an inference turn or exposing private state', async t => {
  const f = await fixture(t, { authenticated: false });
  const result = await f.post('/connect', { slug: 'song', provider: 'codex' });
  assert.equal(result.status, 401);
  assert.equal(f.instances[0].runs.length, 0);
  assert.equal(f.instances[0].closes, 1);
  const saved = await (await f.get('/session?slug=song&provider=codex')).json();
  assert.equal(saved.connected, false);
  assert.equal(Object.hasOwn(saved, 'providerSessionId'), false);
  assert.equal(Object.hasOwn(saved, 'token'), false);
});

test('persisted owned thread resumes after service restart and completed transcript is truthful', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiplay-owned-thread-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = async item => { item.params.onEvent({ type: 'delta', id: 'answer', text: 'One ' }); item.params.onEvent({ type: 'message', id: 'answer', text: 'One note.' }); };
  const first = await fixture(t, { dir, run });
  const session = await first.connect(); const events = await first.begin(session.sessionId);
  await events.next('open'); assert.equal((await events.next('end')).status, 'completed');
  await first.close();
  const second = await fixture(t, { dir, run });
  const resumed = await second.connect(); assert.equal(resumed.sessionId, session.sessionId);
  assert.deepEqual(resumed.history.map(row => row.text), ['Add a note', 'One note.']);
  const next = await second.begin(resumed.sessionId); await next.next('end');
  assert.equal(second.instances[0].runs[0].sessionId, 'owned-provider-thread');
  assert.match(second.instances[0].runs[0].text, /track-1/);
  const names = await readdir(dir); const record = JSON.parse(await readFile(path.join(dir, names.find(name => name === session.sessionId + '.json')), 'utf8'));
  assert.equal(record.providerSessionId, 'owned-provider-thread');
  assert.ok(!JSON.stringify(record).includes('AIPLAY_ASSISTANT_TOKEN'));
});

test('active capability, exact call-ID dedupe, server actor and duplicate turn guard', async t => {
  const f = await fixture(t); const session = await f.connect(); const item = f.instances[0];
  assert.equal((await f.mcp(item, '/tools', {})).status, 403);
  const events = await f.begin(session.sessionId); await events.next('open');
  assert.equal((await f.mcp(item, '/tools', {})).status, 200);
  assert.equal((await f.post('/turn', { sessionId: session.sessionId, text: 'again', context: { slug: 'song' } })).status, 409);
  const call = { callId: 1, name: 'daw_edit', arguments: { slug: 'song', action: 'add_note' } };
  const results = await Promise.all([f.mcp(item, '/call', call), f.mcp(item, '/call', call)]);
  assert.ok(results.every(result => result.status === 200));
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 1);
  assert.equal(f.calls.find(([method]) => method === 'POST')[3], 'agent:daw-codex');
  assert.equal((await f.mcp(item, '/call', { ...call, arguments: { slug: 'song', action: 'different' } })).status, 409);
  item.done.resolve(); await events.next('end');
  assert.equal((await f.mcp(item, '/call', { ...call, callId: 2 })).status, 403);
});

test('render waits for exact one-shot approval; denial and stale approval never edit', async t => {
  const f = await fixture(t); const session = await f.connect(), item = f.instances[0];
  const events = await f.begin(session.sessionId), open = await events.next('open');
  const pending = f.mcp(item, '/call', { callId: 'render-1', name: 'daw_render', arguments: { slug: 'song' } });
  const approval = await events.next('approval');
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 0);
  assert.equal((await f.post('/approval', { sessionId: session.sessionId, runId: 'stale', id: approval.id, approved: true })).status, 409);
  assert.equal((await f.post('/approval', { sessionId: session.sessionId, runId: open.runId, id: approval.id, approved: false })).status, 200);
  assert.equal((await (await pending).json()).isError, true);
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 0);
  assert.equal((await f.post('/approval', { sessionId: session.sessionId, runId: open.runId, id: approval.id, approved: true })).status, 409);
  const accepted = f.mcp(item, '/call', { callId: 'render-2', name: 'daw_render', arguments: { slug: 'song' } });
  const second = await events.next('approval');
  await f.post('/approval', { sessionId: session.sessionId, runId: open.runId, id: second.id, approved: true });
  assert.equal((await accepted).status, 200);
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 1);
  item.done.resolve(); await events.next('end');
});

test('Stop revokes capability and interrupts only the owned client, with no global queue call', async t => {
  const f = await fixture(t); const session = await f.connect(), item = f.instances[0];
  const events = await f.begin(session.sessionId), open = await events.next('open');
  assert.equal((await f.post('/stop', { sessionId: session.sessionId, runId: 'wrong' })).status, 409);
  const stopped = await f.post('/stop', { sessionId: session.sessionId, runId: open.runId });
  assert.equal(stopped.status, 200); assert.equal((await events.next('end')).status, 'stopped');
  assert.equal(item.interrupts, 1); assert.equal(item.closes, 1);
  assert.ok(f.calls.every(([, target]) => !target.includes('cancel')));
  assert.equal((await f.mcp(item, '/tools', {})).status, 403);
  assert.equal((await f.post('/turn', { sessionId: session.sessionId, text: 'again', context: { slug: 'song' } })).status, 409);
});

test('closing the stream interrupts its owned turn rather than leaving a detached agent', async t => {
  const f = await fixture(t); const session = await f.connect(), item = f.instances[0];
  const events = await f.begin(session.sessionId); await events.next('open');
  const disconnected = deferred();
  item.done.promise.catch(() => disconnected.resolve());
  await events.cancel(); await disconnected.promise;
  assert.equal(item.interrupts, 1);
});

test('unconfirmed stop keeps the handle and refuses Connect, New chat and another turn', async t => {
  const f = await fixture(t, { stubborn: true, stopTimeoutMs: 25 });
  const session = await f.connect(); const events = await f.begin(session.sessionId), open = await events.next('open');
  assert.equal((await f.post('/stop', { sessionId: session.sessionId, runId: open.runId })).status, 500);
  assert.equal((await events.next('end')).status, 'failed');
  assert.equal((await f.post('/connect', { slug: 'song', provider: 'codex' })).status, 409);
  assert.equal((await f.post('/connect', { slug: 'song', provider: 'codex', newSession: true })).status, 409);
  assert.equal((await f.post('/turn', { sessionId: session.sessionId, text: 'again', context: { slug: 'song' } })).status, 409);
  assert.equal(f.instances.length, 1);
});

test('an admitted but incomplete MCP body cannot cross into a subsequent turn', async t => {
  const f = await fixture(t); const session = await f.connect(), item = f.instances[0];
  const events = await f.begin(session.sessionId), open = await events.next('open');
  const target = new URL(item.params.mcp.env.AIPLAY_ASSISTANT_URL + '/call');
  const result = deferred();
  const call = httpRequest(target, { method: 'POST', headers: { 'Content-Type': 'application/json',
    Authorization: `Bearer ${item.params.mcp.env.AIPLAY_ASSISTANT_TOKEN}` } }, res => { res.resume(); res.on('end', () => result.resolve(res.statusCode)); });
  call.on('error', result.reject); call.write('{"callId":99,');
  // Ensure the earlier request reached the server, without relying on a sleep.
  await f.mcp(item, '/tools', {});
  await f.post('/stop', { sessionId: session.sessionId, runId: open.runId }); await events.next('end');
  await f.connect(); const fresh = await f.begin(session.sessionId); await fresh.next('open');
  call.end('"name":"daw_edit","arguments":{"slug":"song"}}');
  assert.equal(await result.promise, 403);
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 0);
  f.instances[1].done.resolve(); await fresh.next('end');
});

test('concurrent cold session reads and Connect share one runtime and capability', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiplay-cold-assistant-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await fixture(t, { dir });
  const original = await first.connect(); await first.close();
  const cold = await fixture(t, { dir });
  // None of these requests has a warm runtime at dispatch. The connection
  // must remain reachable after all concurrent disk reads have completed.
  const [connected, ...reads] = await Promise.all([cold.connect(),
    ...Array.from({ length: 20 }, () => cold.get('/session?slug=song&provider=codex').then(response => response.json()))]);
  assert.equal(connected.sessionId, original.sessionId);
  assert.ok(reads.every(row => row.sessionId === original.sessionId));
  const current = await (await cold.get('/session?slug=song&provider=codex')).json();
  assert.equal(current.connected, true); assert.equal(cold.instances.length, 1);
  const events = await cold.begin(current.sessionId); await events.next('open');
  assert.equal((await cold.mcp(cold.instances[0], '/tools', {})).status, 200);
  cold.instances[0].done.resolve(); assert.equal((await events.next('end')).status, 'completed');
  await cold.close(); assert.equal(cold.instances[0].closes, 1);
});

test('New chat refuses active turns and invalidates the old runtime before awaiting close', async t => {
  const closing = deferred(), allowClose = deferred(), newRunEntered = deferred(); let old;
  const f = await fixture(t, { close: async item => {
    if (item === old) { closing.resolve(); await allowClose.promise; }
  }, run: async item => { if (item !== old) newRunEntered.resolve(); return item.done.promise; } });
  const original = await f.connect(); old = f.instances[0];
  const firstTurn = await f.begin(original.sessionId); await firstTurn.next('open');
  assert.equal((await f.post('/connect', { slug: 'song', provider: 'codex', newSession: true })).status, 409);
  assert.equal(f.instances.length, 1); assert.equal(old.closes, 0);
  old.done.resolve(); await firstTurn.next('end');
  const replacement = f.post('/connect', { slug: 'song', provider: 'codex', newSession: true });
  await closing.promise;
  const staleBody = { sessionId: original.sessionId, text: 'Use the old conversation', context: { slug: 'song' } };
  assert.equal((await f.post('/turn', staleBody)).status, 409);
  assert.equal((await f.post('/connect', { slug: 'song', provider: 'codex' })).status, 409);
  assert.equal(f.instances.length, 1, 'no replacement client before the owned close settles');
  allowClose.resolve(); const response = await replacement; assert.equal(response.status, 200);
  const next = await response.json(); assert.notEqual(next.sessionId, original.sessionId);
  assert.equal(old.closes, 1); assert.equal(f.instances.length, 2);
  assert.equal((await f.post('/turn', staleBody)).status, 409);
  assert.equal((await f.mcp(old, '/tools', {})).status, 403);
  const events = await f.begin(next.sessionId); await events.next('open');
  await newRunEntered.promise;
  assert.equal(f.instances[1].runs[0].sessionId, null, 'an explicit New chat never resumes the prior provider thread');
  f.instances[1].done.resolve(); assert.equal((await events.next('end')).status, 'completed');
});
