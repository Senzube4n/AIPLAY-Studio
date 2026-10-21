import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistantMcpConfig, createAssistantMcp, runAssistantStdio, MAX_MCP_BYTES, MAX_MCP_LINE_BYTES } from './assistant-mcp.mjs';

const token = 'd'.repeat(64), url = 'http://127.0.0.1:4173/api/daw-assistant/mcp/12345678-1234-4234-8234-123456789abc';
const env = { AIPLAY_ASSISTANT_URL: url, AIPLAY_ASSISTANT_TOKEN: token };
const rpc = (method, id = 1, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const tools = [{ name: 'daw_render', description: 'Render this project.', gate: 'gpu', run: 'not a transport field',
  inputSchema: { type: 'object', properties: { slug: { type: 'string', enum: ['song'] } } } }];

test('invalid endpoint or capability is refused before any HTTP', () => {
  let fetched = 0;
  for (const bad of ['https://127.0.0.1:4173/api/daw-assistant/mcp/id', 'http://example.test:4173/api/daw-assistant/mcp/id',
    'http://127.0.0.1/api/daw-assistant/mcp/id', url + '?token=secret', url + '#fragment',
    url.replace('127.0.0.1', 'user:password@127.0.0.1'), url.replace('/mcp/', '/other/'), url + '/tools',
    url.replace('12345678-1234-4234-8234-123456789abc', '%2fapi')])
    assert.throws(() => createAssistantMcp({ env: { ...env, AIPLAY_ASSISTANT_URL: bad }, fetchFn() { fetched++; } }));
  for (const bad of ['', 'short', token + '\n', undefined])
    assert.throws(() => createAssistantMcp({ env: { ...env, AIPLAY_ASSISTANT_TOKEN: bad }, fetchFn() { fetched++; } }));
  assert.equal(fetched, 0);
  assert.equal(assistantMcpConfig(env).url, url);
  assert.equal(assistantMcpConfig({ ...env, AIPLAY_ASSISTANT_URL: url.replace('127.0.0.1', '[::1]') }).token, token);
});

test('initialize, ping, notifications and unknown methods never request HTTP', async () => {
  let fetched = 0; const handle = createAssistantMcp({ env, fetchFn() { fetched++; } });
  assert.equal((await handle(rpc('initialize'))).result.serverInfo.name, 'aiplay-daw-assistant');
  assert.deepEqual((await handle(rpc('ping'))).result, {});
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await handle(rpc('resources/list'))).error.code, -32601);
  assert.equal((await handle({ method: 'tools/list', id: 1 })).error.code, -32600);
  assert.equal((await handle(rpc('tools/list', {}))).error.code, -32600);
  assert.equal(fetched, 0);
});

test('tool listing authenticates only its owned session and strips nonstandard fields', async () => {
  const calls = [];
  const handle = createAssistantMcp({ env, fetchFn: async (endpoint, options) => { calls.push({ endpoint, options }); return response({ tools }); } });
  const listed = await handle(rpc('tools/list', 'list'));
  assert.deepEqual(listed.result.tools, [{ name: tools[0].name, description: tools[0].description, inputSchema: tools[0].inputSchema }]);
  assert.equal(calls[0].endpoint, url + '/tools'); assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer ' + token);
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.body, '{}');
  assert.equal(calls[0].options.headers['x-aiplay-actor'], undefined, 'the parent route owns attribution');
  assert.ok(!JSON.stringify(listed).includes(token));
});

test('calls preserve exact JSON-RPC ID for parent dedupe and forward only MCP results', async () => {
  const calls = [], result = { content: [{ type: 'text', text: 'Rendered.' }], isError: true, secret: 'not returned' };
  const handle = createAssistantMcp({ env, fetchFn: async (endpoint, options) => { calls.push({ endpoint, options }); return response(result); } });
  for (const id of [0, 'call:two']) {
    const reply = await handle(rpc('tools/call', id, { name: 'daw_render', arguments: { slug: 'song' } }));
    assert.equal(reply.id, id); assert.deepEqual(reply.result, { content: result.content, isError: true });
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), { callId: id, name: 'daw_render', arguments: { slug: 'song' } });
    assert.equal(calls.at(-1).endpoint, url + '/call');
  }
  for (const args of [null, false, [], 'text']) assert.equal((await handle(rpc('tools/call', 3, { name: 'daw_render', arguments: args }))).error.code, -32602);
  assert.equal((await handle(rpc('tools/call', 3, { name: 'api_request', arguments: {} }))).error.code, -32602);
  assert.equal(calls.length, 2);
});

test('failed and oversized responses never leak tokens, URL or raw server errors and never retry', async () => {
  for (const make of [() => { throw Error(token + url); }, () => new Response(JSON.stringify({ error: token + url }), { status: 403 }),
    () => new Response('{broken'), () => new Response('x'.repeat(MAX_MCP_BYTES + 1)),
    () => new Response('{}', { headers: { 'content-length': String(MAX_MCP_BYTES + 1) } })]) {
    let calls = 0;
    const handle = createAssistantMcp({ env, fetchFn: async () => { calls++; return make(); } });
    const reply = await handle(rpc('tools/call', 1, { name: 'daw_render', arguments: {} }));
    assert.equal(reply.result.isError, true); assert.equal(calls, 1);
    assert.ok(!JSON.stringify(reply).includes(token)); assert.ok(!JSON.stringify(reply).includes(url));
  }
  let calls = 0; const handle = createAssistantMcp({ env, fetchFn: async () => { calls++; } });
  const reply = await handle(rpc('tools/call', 1, { name: 'daw_render', arguments: { data: 'a'.repeat(MAX_MCP_LINE_BYTES) } }));
  assert.equal(reply.result.isError, true); assert.equal(calls, 0);
});

test('stdio handles split UTF-8, malformed JSON, bounded lines and EOF without replay', async () => {
  const messages = [JSON.stringify(rpc('initialize', 'one')), '{bad', 'x'.repeat(MAX_MCP_LINE_BYTES + 1),
    JSON.stringify(rpc('tools/call', 'two', { name: 'daw_get_project', arguments: { slug: 'song', text: 'café' } }))].join('\n');
  const bytes = Buffer.from(messages), at = bytes.indexOf(Buffer.from('é')) + 1;
  let output = '', calls = 0;
  await runAssistantStdio({ env, input: Readable.from([bytes.subarray(0, 50), bytes.subarray(50, at), bytes.subarray(at)]),
    output: new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } }),
    fetchFn: async (endpoint, options) => { calls++; assert.equal(JSON.parse(options.body).arguments.text, 'café'); return response({ content: [{ type: 'text', text: 'done' }] }); } });
  const replies = output.trim().split('\n').map(JSON.parse);
  assert.deepEqual(replies.map(reply => reply.id), ['one', null, null, 'two']);
  assert.equal(replies[1].error.code, -32700); assert.equal(replies[2].error.code, -32600);
  assert.equal(replies[3].result.content[0].text, 'done'); assert.equal(calls, 1);
});

test('imports are inert and a direct junction path with spaces runs the configuration guard', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'aiplay assistant fixture ')); t.after(() => rm(base, { recursive: true, force: true }));
  const alias = path.join(base, 'DAW bridge');
  await symlink(fileURLToPath(new URL('.', import.meta.url)), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const modulePath = path.join(alias, 'assistant-mcp.mjs');
  const safeEnv = { ...process.env, AIPLAY_ASSISTANT_URL: 'invalid', AIPLAY_ASSISTANT_TOKEN: token };
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./assistant-mcp.mjs', import.meta.url).href)}); process.stdout.write('inert');`],
    { env: safeEnv, windowsHide: true, encoding: 'utf8' }), 'inert');
  assert.throws(() => execFileSync(process.execPath, [modulePath], { env: safeEnv, windowsHide: true, encoding: 'utf8', stdio: 'pipe' }), error => {
    assert.equal(error.status, 1); assert.equal(error.stdout, '');
    assert.match(error.stderr, /bridge could not start/); assert.ok(!error.stderr.includes(token)); return true;
  });
});
