/** Owned-session stdio MCP facade. No global Studio tools, provider login or
 * inference lives here; the authenticated HTTP route owns scope and approval. */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_MCP_BYTES = 2 * 1024 * 1024;
export const MAX_MCP_LINE_BYTES = 160 * 1024;
const own = value => value && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && value.length <= 256 || typeof value === 'number' && Number.isSafeInteger(value);

export function assistantMcpConfig(env = process.env) {
  let url;
  try { url = new URL(env.AIPLAY_ASSISTANT_URL); } catch { throw Error('A local assistant session is required.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !url.port
    || !/^\/api\/daw-assistant\/mcp\/[a-z0-9_-]{1,128}$/i.test(url.pathname))
    throw Error('A local assistant session is required.');
  const token = env.AIPLAY_ASSISTANT_TOKEN;
  if (typeof token !== 'string' || !/^[a-z0-9_-]{32,1024}$/i.test(token)) throw Error('An assistant session capability is required.');
  return { url: url.href, token };
}

async function responseJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_MCP_BYTES) throw Error('The assistant reply is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw Error('The assistant session returned no reply.');
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_MCP_BYTES) throw Error('The assistant reply is too large.');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('The assistant session returned invalid JSON.'); }
  if (!response.ok) throw Error('The assistant session refused this request.');
  return data;
}

export function createAssistantMcp({ env = process.env, fetchFn = globalThis.fetch } = {}) {
  const config = assistantMcpConfig(env); // All validation precedes HTTP.
  const post = async (suffix, data) => {
    const body = JSON.stringify(data);
    if (Buffer.byteLength(body) > MAX_MCP_LINE_BYTES) throw Error('The assistant request is too large.');
    let response;
    try { response = await fetchFn(config.url + suffix, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` }, body }); }
    catch { throw Error('The assistant session could not be reached.'); }
    return responseJson(response);
  };
  return async function handle(message) {
    const id = validId(message?.id) ? message.id : null;
    const error = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
    if (!own(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(-32600, 'Invalid request.');
    if (message.id === undefined) return null;
    if (!validId(message.id)) return error(-32600, 'Invalid request id.');
    const reply = result => ({ jsonrpc: '2.0', id, result });
    if (message.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} },
      serverInfo: { name: 'aiplay-daw-assistant', version: '1.0.0' }, instructions: 'Use only the DAW project named in each tool schema.' });
    if (message.method === 'ping') return reply({});
    if (!['tools/list', 'tools/call'].includes(message.method)) return error(-32601, 'Unknown method.');
    try {
      if (message.method === 'tools/list') {
        const data = await post('/tools', {});
        if (!Array.isArray(data?.tools) || data.tools.length > 128) throw Error('Invalid assistant tool list.');
        return reply({ tools: data.tools.map(tool => {
          if (!own(tool) || !/^daw_[a-z0-9_]+$/.test(tool.name) || typeof tool.description !== 'string' || !own(tool.inputSchema))
            throw Error('Invalid assistant tool list.');
          return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
        }) });
      }
      const params = message.params;
      const args = params?.arguments === undefined ? {} : params.arguments;
      if (!own(params) || !/^daw_[a-z0-9_]+$/.test(params.name) || !own(args)) return error(-32602, 'Invalid tool arguments.');
      const data = await post('/call', { callId: id, name: params.name, arguments: args });
      if (!Array.isArray(data?.content) || data.content.some(item => !own(item) || item.type !== 'text' || typeof item.text !== 'string'))
        throw Error('Invalid assistant tool result.');
      return reply({ content: data.content.map(item => ({ type: 'text', text: item.text })), ...(data.isError === true ? { isError: true } : {}) });
    } catch (e) {
      // Never echo the URL, capability or raw fetch/provider error.
      return message.method === 'tools/call' ? reply({ content: [{ type: 'text', text: 'The assistant call did not complete. Check this session before trying again.' }], isError: true })
        : error(-32603, 'The assistant session could not list its tools.');
    }
  };
}

/** JSONL is bounded before concatenation. Calls are never retried. */
export async function runAssistantStdio({ input = process.stdin, output = process.stdout, env = process.env, fetchFn = globalThis.fetch } = {}) {
  const handle = createAssistantMcp({ env, fetchFn });
  let line = Buffer.alloc(0), dropping = false;
  const write = async object => {
    if (object === null) return;
    let bytes = JSON.stringify(object) + '\n';
    if (Buffer.byteLength(bytes) > MAX_MCP_BYTES + MAX_MCP_LINE_BYTES)
      bytes = JSON.stringify({ jsonrpc: '2.0', id: object.id ?? null, error: { code: -32603, message: 'The assistant reply is too large.' } }) + '\n';
    if (!output.write(bytes)) await new Promise(resolve => output.once('drain', resolve));
  };
  const consume = async () => {
    if (!line.length) return;
    let message;
    try { message = JSON.parse(line.toString('utf8')); }
    catch { await write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } }); return; }
    await write(await handle(message));
  };
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 10) continue;
      const part = bytes.subarray(start, i); start = i + 1;
      if (!dropping && line.length + part.length <= MAX_MCP_LINE_BYTES) { line = Buffer.concat([line, part]); await consume(); }
      else await write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'The assistant request is too large.' } });
      line = Buffer.alloc(0); dropping = false;
    }
    const tail = bytes.subarray(start);
    if (!dropping && line.length + tail.length <= MAX_MCP_LINE_BYTES) line = Buffer.concat([line, tail]);
    else { dropping = true; line = Buffer.alloc(0); }
  }
  if (!dropping) await consume();
  else await write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'The assistant request is too large.' } });
}

const RUN_DIRECTLY = !!process.argv[1] && (() => {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1])); } catch { return false; }
})();
if (RUN_DIRECTLY) runAssistantStdio().catch(() => { process.stderr.write('The local DAW assistant bridge could not start.\n'); process.exitCode = 1; });
