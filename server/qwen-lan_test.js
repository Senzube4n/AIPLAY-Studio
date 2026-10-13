/** The actual LAN gate, server-wide origin check, setup route and live verifier.
 * No engine/server is started: only the repair runner is an isolated fixture. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLanGate, lanConfig, LAN_COOKIE } from "./lan.js";
import { createSetupRoutes } from "./setup/routes.js";
import { setupTools } from "./mcp-setup.js";

const INDEX = readFileSync(new URL("./index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CLOUD = readFileSync(new URL("./cloud-switch.js", import.meta.url), "utf8");
const PORT = 4173, LOCAL_HOST = `127.0.0.1:${PORT}`, PHONE_HOST = `192.168.1.20:${PORT}`;
const KEY = "abcdefghijklmnopqrstuvwx0123456789";
const config = { uiPort: PORT };
const guardText = /function sameOriginLocalJson\(req\) \{[\s\S]*?\n\}/.exec(INDEX)?.[0];
assert.ok(guardText, "the production same-origin JSON guard exists");
const sameOriginLocalJson = new Function("config", `${guardText}; return sameOriginLocalJson;`)(config);
const hostText = /export function localUiHost\(req, uiPort\) \{[\s\S]*?\n\}/.exec(CLOUD)?.[0];
assert.ok(hostText, "the production local Host check exists");
const localUiHost = new Function(`${hostText.replace(/^export /, "")}; return localUiHost;`)();
const foreignHost = (req) => !localUiHost(req, PORT);
const at = INDEX.indexOf("const server = http.createServer(async (req, res) => {");
const begin = INDEX.indexOf("\n", at) + 1;
const end = INDEX.indexOf('  const url = new URL(req.url, "http://localhost");', begin);
assert.ok(at >= 0 && end > begin, "the production request admission runs before routing");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const admitHttp = new AsyncFunction("req", "res", "lanGate", "foreignHost", "json",
  `${INDEX.slice(begin, end)}\nreturn { admitted: true };`);
const socketAt = INDEX.indexOf("verifyClient:");
const socketEnd = INDEX.indexOf("/* The live socket:", socketAt);
assert.ok(socketAt > 0 && socketEnd > socketAt, "the production live verifier exists");
const socketText = INDEX.slice(socketAt + "verifyClient:".length, socketEnd).trim().replace(/\s*\}\);$/, "");
const liveVerifier = new Function("foreignHost", "lanGate", `return (${socketText});`);

function req({ host = LOCAL_HOST, origin, site, type = "application/json", remote = "127.0.0.1", cookie,
  method = "POST", url = "/api/setup", body = { action: "run", id: "qwen-engine" } } = {}) {
  return { method, url, body, socket: { remoteAddress: remote }, headers: {
    host, ...(origin === undefined ? {} : { origin }), ...(site === undefined ? {} : { "sec-fetch-site": site }),
    ...(type === null ? {} : { "content-type": type }), ...(cookie === undefined ? {} : { cookie }),
  } };
}

function response() {
  return { status: null, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; } };
}

function fixture() {
  const lanGate = createLanGate({ key: KEY, port: PORT }), calls = [];
  const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(body); };
  const route = createSetupRoutes({ sameOriginLocalJson, json,
    readBody: async (request, limit) => { calls.push({ read: true, limit }); return request.body; },
    runner: { ids: ["qwen-engine"], has: (id) => id === "qwen-engine",
      run: async (id, opts) => { calls.push({ run: id, opts }); return { id, state: "running", label: "Downloading engine" }; },
      status: async (id) => { calls.push({ status: id }); return { setups: [{ id, job: { state: "running", label: "Checking Qwen" } }] }; } },
  });
  return { lanGate, calls,
    async send(request) {
      const res = response();
      const admission = await admitHttp(request, res, lanGate, foreignHost, json);
      if (admission?.admitted) await route(request, res, new URL(request.url, `http://${LOCAL_HOST}`));
      return res;
    },
    live(request) { return liveVerifier(foreignHost, lanGate)({ req: request }); },
  };
}

test("LAN stays off unless the launcher supplies a strong access key", () => {
  assert.equal(lanConfig({}).on, false);
  assert.equal(lanConfig({ AIPLAY_LAN: "1", AIPLAY_LAN_KEY: "short" }).on, false);
  assert.equal(lanConfig({ AIPLAY_LAN: "1", AIPLAY_LAN_KEY: KEY }).on, true);
});

test("local Studio page and local MCP retain access to Qwen repair", async () => {
  for (const request of [req({ origin: `http://${LOCAL_HOST}`, site: "same-origin" }), req(),
    req({ host: `localhost:${PORT}`, remote: "::ffff:127.0.0.1" }), req({ host: `[::1]:${PORT}`, remote: "::1" })]) {
    const f = fixture(), result = await f.send(request);
    assert.equal(result.status, 200);
    assert.equal(f.calls.filter((call) => call.run).length, 1);
    assert.equal(f.calls.find((call) => call.read).limit, 4096);
  }
});

test("the real MCP Qwen repair tool reaches the protected local setup door", async () => {
  const f = fixture();
  const tool = setupTools(async (method, url, body) => {
    const result = await f.send(req({ method, url, body }));
    assert.equal(result.status, 200); return result.body;
  }).find((item) => item.name === "qwen_engine_repair");
  const job = await tool.run({});
  assert.equal(job.id, "qwen-engine");
  assert.equal(f.calls.filter((call) => call.run).length, 1);
});

test("the launcher's phone link exchanges its key for a strict cookie before repair", async () => {
  const f = fixture();
  const link = await f.send(req({ host: PHONE_HOST, remote: "192.168.1.30", method: "GET", url: `/?k=${KEY}&view=images` }));
  assert.equal(link.status, 302);
  assert.equal(link.headers.Location, "/?view=images");
  assert.match(link.headers["Set-Cookie"], /Path=\/; HttpOnly; SameSite=Strict;/);
  assert.equal(f.calls.length, 0);
  const cookie = link.headers["Set-Cookie"].split(";")[0];
  const phone = req({ host: PHONE_HOST, remote: "192.168.1.30", cookie,
    origin: `http://${PHONE_HOST}`, site: "same-origin" });
  const repaired = await f.send(phone);
  assert.equal(repaired.status, 200);
  assert.equal(phone.lanClient, true);
  assert.equal(f.calls.filter((call) => call.run).length, 1);
});

test("an authorised phone can read Qwen repair progress without restarting again", async () => {
  const f = fixture();
  const result = await f.send(req({ host: PHONE_HOST, remote: "192.168.1.30", cookie: `${LAN_COOKIE}=${KEY}`,
    origin: `http://${PHONE_HOST}`, site: "same-origin", body: { action: "status", id: "qwen-engine" } }));
  assert.equal(result.status, 200);
  assert.equal(result.body.setups[0].job.label, "Checking Qwen");
  assert.equal(f.calls.filter((call) => call.run).length, 0);
});

for (const [name, options] of [
  ["tokenless phone", { host: PHONE_HOST, remote: "192.168.1.30" }],
  ["wrong phone cookie", { host: PHONE_HOST, remote: "192.168.1.30", cookie: `${LAN_COOKIE}=wrong` }],
  ["remote client spoofing localhost without a cookie", { host: LOCAL_HOST, remote: "192.168.1.30" }],
  ["rebound DNS Host even with the access cookie", { host: `rebind.example:${PORT}`, remote: "192.168.1.30", cookie: `${LAN_COOKIE}=${KEY}` }],
  ["foreign Origin even with the access cookie", { host: PHONE_HOST, remote: "192.168.1.30", cookie: `${LAN_COOKIE}=${KEY}`, origin: "https://evil.example", site: "same-origin" }],
  ["cross-site fetch metadata even with no Origin", { host: PHONE_HOST, remote: "192.168.1.30", cookie: `${LAN_COOKIE}=${KEY}`, site: "cross-site" }],
  ["opaque Origin even with the access cookie", { host: PHONE_HOST, remote: "192.168.1.30", cookie: `${LAN_COOKIE}=${KEY}`, origin: "null" }],
  ["foreign local browser Origin", { origin: "https://evil.example", site: "cross-site" }],
]) {
  test(`${name} cannot start or read Qwen repair`, async () => {
    for (const action of ["run", "status"]) {
      const f = fixture();
      const result = await f.send(req({ ...options, body: { action, id: "qwen-engine" } }));
      assert.equal(result.status, 403);
      assert.equal(f.calls.length, 0, "the body and repair runner are never reached");
    }
  });
}

test("a text/plain phone POST cannot run the repair despite a valid cookie and origin", async () => {
  const f = fixture();
  const result = await f.send(req({ host: PHONE_HOST, remote: "192.168.1.30", cookie: `${LAN_COOKIE}=${KEY}`,
    origin: `http://${PHONE_HOST}`, site: "same-origin", type: "text/plain" }));
  assert.equal(result.status, 403);
  assert.equal(f.calls.filter((call) => call.run).length, 0);
});

test("the live socket accepts local MCP and a keyed phone, retaining foreign-origin protection", () => {
  const f = fixture();
  assert.equal(f.live(req({ method: "GET", url: "/live" })), true);
  assert.equal(f.live(req({ method: "GET", url: "/live", host: PHONE_HOST, remote: "192.168.1.30",
    cookie: `${LAN_COOKIE}=${KEY}`, origin: `http://${PHONE_HOST}` })), true);
  assert.equal(f.live(req({ method: "GET", url: "/live", host: PHONE_HOST, remote: "192.168.1.30",
    cookie: `${LAN_COOKIE}=${KEY}`, origin: "https://evil.example" })), false);
});

test("the live socket refuses tokenless remote clients even when they spoof a local Host", () => {
  for (const host of [PHONE_HOST, LOCAL_HOST, `localhost:${PORT}`, `[::1]:${PORT}`]) {
    const f = fixture();
    assert.equal(f.live(req({ method: "GET", url: "/live", host, remote: "192.168.1.30" })), false, host);
  }
});

test("the live socket rejects wrong cookies, DNS hosts and the wrong port", () => {
  for (const options of [
    { host: PHONE_HOST, cookie: `${LAN_COOKIE}=wrong` },
    { host: `rebind.example:${PORT}`, cookie: `${LAN_COOKIE}=${KEY}` },
    { host: `192.168.1.20:${PORT + 1}`, cookie: `${LAN_COOKIE}=${KEY}` },
  ]) {
    const f = fixture();
    assert.equal(f.live(req({ method: "GET", url: "/live", remote: "192.168.1.30", ...options })), false);
  }
});
