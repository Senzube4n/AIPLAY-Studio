import test from "node:test";
import assert from "node:assert/strict";
import { createStandRigConnector } from "./connector.js";
import { createStandRigRoutes } from "./routes.js";

function fakeStandRig() {
  const calls = [];
  const state = { sessionId: "session-a", modelVersion: 0, inputContractVersion: 2,
    parameters: [{ id: "ParamMouthOpen", min: 0, max: 1 }, { id: "ParamAngleZ", min: -30, max: 30 }],
    values: { ParamMouthOpen: 0, ParamAngleZ: 0 }, demo: { active: false } };
  const seen = new Map();
  let parts = 0;
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/api/health") return { ok: true, app: "standrig-modeling-tools", capabilities: { playback: true } };
    if (path === "/api/playback" && method === "GET") return { ok: true, playback: structuredClone(state) };
    if (path === "/api/rig/summary") return { ok: true, summary: { name: "Test", counts: { visibleParts: parts, imageParts: parts, assets: parts } } };
    if (path === "/api/parts") return { ok: true, parts: parts ? [{ id: "root", kind: "group", visible: true, parentId: null },
      { id: "art", kind: "image", visible: true, parentId: "root", assetId: "art" }] : [] };
    if (path === "/api/deformers") return { ok: true, deformers: [] };
    if (path === "/api/playback/parameters" && method === "POST") {
      assert.equal(body.expectedSessionId, state.sessionId);
      assert.equal(body.expectedModelVersion, state.modelVersion);
      assert.ok(body.sequence > (seen.get(body.source) ?? -1));
      seen.set(body.source, body.sequence);
      Object.assign(state.values, body.values);
      return { ok: true, playback: structuredClone(state) };
    }
    if (path === "/api/playback/control" && method === "POST") {
      if (body.command === "demo-start") state.demo.active = true;
      if (body.command === "demo-stop") state.demo.active = false;
      return { ok: true, playback: structuredClone(state) };
    }
    throw Error(`Unexpected ${method} ${path}`);
  };
  return { request, calls, state, seen, setParts(value) { parts = value; } };
}

test("offline and unrelated localhost services return bounded, non-actionable status", async () => {
  const offline = createStandRigConnector({ request: async () => { throw Error("ECONNREFUSED"); } });
  assert.deepEqual((await offline.status()).connected, false);
  assert.equal((await offline.status()).playerUrl, null);
  await assert.rejects(offline.write({ action: "control", command: "play" }), /not running/);
  const unrelated = createStandRigConnector({ request: async () => ({ app: "other", capabilities: { playback: true } }) });
  assert.match((await unrelated.status()).reason, /not a compatible StandRig/);
  const incompatible = createStandRigConnector({ request: async (_method, path) => path === "/api/health"
    ? { ok: true, app: "standrig-modeling-tools", capabilities: { playback: true } }
    : path === "/api/playback"
      ? { ok: true, playback: { inputContractVersion: 1, sessionId: "old", modelVersion: 0, parameters: [] } }
      : { ok: true, summary: { counts: { visibleParts: 1, imageParts: 1 } } } });
  assert.match((await incompatible.status()).reason, /unsupported/);
  await assert.rejects(incompatible.write({ action: "control", command: "play" }), /unsupported/);
});

test("status distinguishes an empty rig from a visible 2D performer", async () => {
  const service = fakeStandRig();
  const connector = createStandRigConnector({ request: service.request });
  const empty = await connector.status();
  assert.equal(empty.connected, true);
  assert.equal(empty.ready, false);
  assert.equal(empty.playerUrl, "http://127.0.0.1:5180/player");
  const placeholder = createStandRigConnector({ request: async (method, path) => path === "/api/health"
    ? { ok: true, app: "standrig-modeling-tools", capabilities: { playback: true } }
    : path === "/api/playback" ? { ok: true, playback: structuredClone(service.state) }
      : path === "/api/parts" ? { ok: true, parts: [{ id: "root", kind: "group", visible: true }] }
        : path === "/api/deformers" ? { ok: true, deformers: [] }
        : { ok: true, summary: { counts: { visibleParts: 1, imageParts: 0, assets: 0 } } } });
  assert.equal((await placeholder.status()).ready, false);
  const hiddenArt = createStandRigConnector({ request: async (method, path) => path === "/api/health"
    ? { ok: true, app: "standrig-modeling-tools", capabilities: { playback: true } }
    : path === "/api/playback" ? { ok: true, playback: structuredClone(service.state) }
      : path === "/api/parts" ? { ok: true, parts: [{ id: "root", kind: "group", visible: false, parentId: null },
        { id: "art", kind: "image", visible: true, parentId: "root", assetId: "art" }] }
        : path === "/api/deformers" ? { ok: true, deformers: [] }
        : { ok: true, summary: { counts: { visibleParts: 1, imageParts: 1, assets: 1 } } } });
  assert.equal((await hiddenArt.status()).ready, false);
  const hiddenDeformer = createStandRigConnector({ request: async (method, path) => path === "/api/health"
    ? { ok: true, app: "standrig-modeling-tools", capabilities: { playback: true } }
    : path === "/api/playback" ? { ok: true, playback: structuredClone(service.state) }
      : path === "/api/parts" ? { ok: true, parts: [{ id: "root", kind: "group", visible: true, parentId: null },
        { id: "art", kind: "image", visible: true, parentId: "root", assetId: "art", deformerId: "hidden" }] }
        : path === "/api/deformers" ? { ok: true, deformers: [{ id: "hidden", visible: false, parentId: null }] }
          : { ok: true, summary: { counts: { visibleParts: 2, imageParts: 1, assets: 1 } } } });
  assert.equal((await hiddenDeformer.status()).ready, false);
  service.setParts(2);
  const ready = await connector.status();
  assert.equal(ready.ready, true);
  assert.equal(ready.hasArtwork, true);
  assert.equal(ready.playback.parameters[0].id, "ParamMouthOpen");
});

test("parameter writes validate atomically and carry ordered guarded frames", async () => {
  const service = fakeStandRig();
  service.setParts(1);
  const connector = createStandRigConnector({ request: service.request });
  const before = () => service.calls.filter((call) => call.path === "/api/playback/parameters").length;
  for (const values of [null, {}, [], { Unknown: 1 }, { ParamMouthOpen: 1.1 },
    { ParamMouthOpen: "0.4" }, { ParamMouthOpen: NaN }, { ParamMouthOpen: Infinity },
    { ParamMouthOpen: 0.5, ParamAngleZ: 31 }]) {
    await assert.rejects(connector.write({ action: "parameters", values }));
  }
  assert.equal(before(), 0);
  await Promise.all([
    connector.write({ action: "parameters", values: { ParamMouthOpen: 0.2 } }),
    connector.write({ action: "parameters", values: { ParamMouthOpen: 0.8 } }),
  ]);
  const writes = service.calls.filter((call) => call.path === "/api/playback/parameters");
  assert.deepEqual(writes.map((call) => call.body.sequence), [1, 2]);
  assert.equal(writes[0].body.source, writes[1].body.source);
  assert.equal(service.state.values.ParamMouthOpen, 0.8);
  service.state.sessionId = "session-b";
  service.state.modelVersion = 1;
  service.seen.clear(); // StandRig resets source counters on a model/session reload.
  await connector.write({ action: "parameters", values: { ParamAngleZ: -10 } });
  const afterReload = service.calls.filter((call) => call.path === "/api/playback/parameters").at(-1).body;
  assert.equal(afterReload.sequence, 1);
  assert.equal(afterReload.expectedSessionId, "session-b");
  assert.equal(afterReload.expectedModelVersion, 1);
});

test("only fixed playback commands reach StandRig", async () => {
  const service = fakeStandRig();
  const connector = createStandRigConnector({ request: service.request });
  await assert.rejects(connector.write({ action: "control", command: "reload" }), /Unknown StandRig control/);
  await connector.write({ action: "control", command: "demo-start" });
  assert.equal(service.state.demo.active, true);
  await connector.write({ action: "control", command: "demo-stop" });
  assert.equal(service.state.demo.active, false);
  assert.deepEqual(service.calls.filter((call) => call.path === "/api/playback/control").map((call) => call.body),
    [{ command: "demo-start" }, { command: "demo-stop" }]);
});

test("Studio route requires loopback and same-origin JSON before reading a write", async () => {
  const calls = [];
  let postedBody = { action: "control", command: "play" };
  const routes = createStandRigRoutes({
    json: (_res, status, body) => ({ status, body }),
    readBody: async (_req, cap) => { calls.push(`body:${cap}`); return postedBody; },
    sameOriginLocalJson: (req) => req.sameOrigin === true,
    connector: { status: async () => ({ connected: false }), write: async (body) => { calls.push(body); return { connected: true }; } },
  });
  const request = (method, ip, sameOrigin = true) => ({ method, socket: { remoteAddress: ip },
    headers: { host: "127.0.0.1:4173" }, sameOrigin });
  assert.equal((await routes(request("GET", "192.168.1.8"), {})).status, 403);
  const rebound = request("GET", "127.0.0.1");
  rebound.headers.host = "other.example";
  assert.equal((await routes(rebound, {})).status, 403);
  assert.equal((await routes(request("POST", "127.0.0.1", false), {})).status, 403);
  assert.deepEqual(calls, []);
  assert.equal((await routes(request("GET", "::1"), {})).status, 200);
  assert.equal((await routes(request("POST", "::ffff:127.0.0.1"), {})).status, 200);
  assert.deepEqual(calls, ["body:8192", { action: "control", command: "play" }]);
  postedBody = { action: "control", command: "play", url: "http://example.com" };
  assert.equal((await routes(request("POST", "127.0.0.1"), {})).status, 400);
  assert.equal(calls.length, 3); // The URL is not forwarded.
});
