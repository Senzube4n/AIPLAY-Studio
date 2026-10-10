import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { runpodTools } from "./mcp-runpod.js";
import { createRemoteRoutes } from "./engine/remote-routes.js";

const graph = { "1": { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "review" } },
  "2": { class_type: "LoadImage", inputs: { image: "old.png" } } };
const id = "12345678-1234-1234-1234-123456789abc";
const asset = `${"a".repeat(64)}.png`;
const KEY = "test-secret-runpod-api-key-123456789";
const workerToken = "test-secret-worker-token-123456789";

function rig() {
  const calls = [];
  const api = async (...args) => { calls.push(args); return { ok: true, route: args[1] }; };
  const tools = Object.fromEntries(runpodTools(api).map(tool => [tool.name, tool]));
  return { calls, tools };
}

test("verified bundle setup and private presets are exposed through matching local routes", async () => {
  const r = rig();
  await r.tools.runpod_setup_status.run({});
  await r.tools.runpod_install_bundle.run({ bundle: "yue2-comfy", acceptLicense: true });
  await r.tools.runpod_cancel_install.run({});
  await r.tools.runpod_templates.run({});
  await r.tools.runpod_create_templates.run({});
  assert.deepEqual(r.calls.map(([method, route]) => [method, route]), [
    ["GET", "/api/runpod/setup"], ["POST", "/api/runpod/setup/install"], ["POST", "/api/runpod/setup/cancel"],
    ["GET", "/api/runpod/account/templates"], ["POST", "/api/runpod/account/templates"],
  ]);
  const count = r.calls.length;
  for (const bad of [{ bundle: "yue2-comfy", acceptLicense: false }, { bundle: "url", acceptLicense: true },
    { bundle: "yue2-comfy", acceptLicense: true, url: "https://arbitrary.example" }]) await assert.rejects(r.tools.runpod_install_bundle.run(bad));
  await assert.rejects(r.tools.runpod_create_templates.run({ deploy: true }));
  assert.equal(r.calls.length, count, "unaccepted downloads and hidden Pod deployment must not reach an API");
});

test("RunPod tools are registered with closed top-level schemas and use the local API", async () => {
  const r = rig();
  assert.equal(Object.keys(r.tools).length, 19);
  assert.ok(Object.values(r.tools).every(tool => tool.inputSchema.additionalProperties === false));
  assert.match(readFileSync(new URL("./mcp.js", import.meta.url), "utf8"), /\.\.\.runpodTools\(api\)/);
  await r.tools.runpod_status.run({});
  await r.tools.runpod_models.run({});
  await r.tools.runpod_account_status.run({});
  await r.tools.runpod_account_overview.run({});
  assert.deepEqual(r.calls.map(([method, route]) => [method, route]), [
    ["GET", "/api/runpod"], ["GET", "/api/runpod/models"],
    ["GET", "/api/runpod/account"], ["GET", "/api/runpod/account/overview"],
  ]);
  await assert.rejects(r.tools.runpod_status.run({ unexpected: true }), /Expected only/);
});

test("credential tools reuse the secret routes but cannot echo tokens in MCP results", async () => {
  const calls = [];
  const api = async (...args) => { calls.push(args); return { configured: true, token: workerToken,
    nested: { apiKey: KEY, note: `worker ${workerToken}; account ${KEY}` }, hasToken: true }; };
  const tools = Object.fromEntries(runpodTools(api).map(tool => [tool.name, tool]));
  const connected = await tools.runpod_worker_connect.run({ url: "https://worker.example", token: workerToken });
  assert.equal(calls[0][1], "/api/runpod/connect");
  assert.equal(calls[0][2].token, workerToken);
  assert.equal(JSON.stringify(connected).includes(workerToken), false);
  assert.equal(connected.hasToken, true);
  const account = await tools.runpod_account_connect.run({ apiKey: KEY });
  assert.equal(calls[1][1], "/api/runpod/account/connect");
  assert.equal(calls[1][2].apiKey, KEY);
  assert.equal(JSON.stringify(account).includes(KEY), false);
  await tools.runpod_account_disconnect.run({});
  assert.equal(calls[2][1], "/api/runpod/account/disconnect");
  await assert.rejects(tools.runpod_worker_connect.run({ url: "https://worker.example", token: workerToken, surprise: 1 }), /Expected only/);
});

test("workflow preview, upload bindings, durable job submission and cancel use their matching routes", async () => {
  const r = rig();
  await r.tools.runpod_workflow_preview.run({ template: "qwen", options: { prompt: "pink castle", seed: 7, width: 512, height: 512 } });
  assert.equal(r.calls[0][1], "/api/runpod/workflow");
  await assert.rejects(r.tools.runpod_workflow_preview.run({ template: "qwen", options: { prompt: "x", hiddenKey: "y" } }), /Expected only/);
  await r.tools.runpod_submit_job.run({ graph, bindings: [{ node: "2", input: "image", asset }], label: "test" });
  assert.equal(r.calls[1][1], "/api/runpod/jobs");
  assert.deepEqual(r.calls[1][2].bindings, [{ node: "2", input: "image", asset }]);
  await assert.rejects(r.tools.runpod_submit_job.run({ graph, bindings: [{ node: "2", input: "image", asset, surprise: true }] }), /Expected only/);
  await assert.rejects(r.tools.runpod_submit_job.run({ graph: {} }), /1–500 nodes/);
  await r.tools.runpod_cancel_job.run({ id });
  assert.equal(r.calls[2][1], `/api/runpod/jobs/${id}/cancel`);
  await assert.rejects(r.tools.runpod_cancel_job.run({ id: "../pods" }), /Invalid job ID/);
  const server = readFileSync(new URL("./engine/remote-routes.js", import.meta.url), "utf8");
  const mcp = readFileSync(new URL("./mcp.js", import.meta.url), "utf8");
  assert.match(server, /actor: actorFrom\(req\)/);
  assert.match(mcp, /"x-aiplay-actor": ACTOR/);
});

test("Pod creation and startup need explicit server phrases; stopping stays scoped", async () => {
  const r = rig();
  await assert.rejects(r.tools.runpod_pod_create.run({ gpuTypeId: "gpu-24" }), /Expected only/);
  await assert.rejects(r.tools.runpod_pod_create.run({ gpuTypeId: "gpu-24", confirm: "yes" }), /confirm paid Pod creation/);
  assert.equal(r.calls.length, 0);
  await r.tools.runpod_pod_create.run({ gpuTypeId: "gpu-24", confirm: "CREATE PAID POD", cloudType: "SECURE", volumeInGb: 100 });
  assert.equal(r.calls[0][1], "/api/runpod/account/pods");
  assert.equal(r.calls[0][2].confirm, "CREATE PAID POD");
  await assert.rejects(r.tools.runpod_pod_start.run({ id: "pod_1", confirm: "yes" }), /confirm paid Pod startup/);
  assert.equal(r.calls.length, 1);
  await r.tools.runpod_pod_start.run({ id: "pod_1", confirm: "START PAID POD" });
  assert.deepEqual(r.calls[1].slice(0, 3), ["POST", "/api/runpod/account/pods/pod_1/start", { confirm: "START PAID POD" }]);
  await r.tools.runpod_pod_stop.run({ id: "pod_1" });
  assert.equal(r.calls[2][1], "/api/runpod/account/pods/pod_1/stop");
  await assert.rejects(r.tools.runpod_pod_stop.run({ id: "../pod" }), /valid Pod ID/);
});

test("MCP asset upload is bounded, sends bytes only to the worker route and rejects URLs", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-runpod-mcp-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const good = path.join(dir, "sample.png");
  await writeFile(good, Buffer.from("sample"));
  const r = rig();
  await r.tools.runpod_upload_asset.run({ path: good });
  assert.equal(r.calls[0][1], "/api/runpod/assets?name=sample.png");
  assert.deepEqual(r.calls[0][2], Buffer.from("sample"));
  assert.equal(r.calls[0][4].contentType, "application/octet-stream");
  await assert.rejects(r.tools.runpod_upload_asset.run({ path: "https://example.com/key.png" }), /absolute local file path/);
  const tooLarge = path.join(dir, "huge.png"), file = await open(tooLarge, "w");
  try { await file.truncate(64 * 1024 * 1024 + 1); } finally { await file.close(); }
  await assert.rejects(r.tools.runpod_upload_asset.run({ path: tooLarge }), /64 MiB/);
  assert.equal(r.calls.length, 1);
});

test("the RunPod HTTP start route rejects an empty POST before billing and accepts the confirmation phrase", async t => {
  let resumes = 0;
  /* /api/runpod answers only this PC's Studio address on the UI port, and its
   * JSON POSTs pass index.js sameOriginLocalJson, lifted here as it is. */
  const config = { uiPort: 4173 };
  const guardSrc = /function sameOriginLocalJson\(req\) \{[\s\S]*?\n\}/.exec(readFileSync(new URL("./index.js", import.meta.url), "utf8"))?.[0] || "";
  const sameOriginLocalJson = new Function("config", `${guardSrc}\nreturn sameOriginLocalJson;`)(config);
  const route = createRemoteRoutes({ config, sameOriginLocalJson,
    getSecret: async name => name === "RUNPOD_ACCOUNT_API_KEY" ? KEY : null,
    setSecret: async () => {}, clearSecret: async () => {}, append: async () => {}, actorFrom: () => "agent:test", adopt: async () => {},
    fetchFn: async (_url, init) => {
      const query = JSON.parse(init.body).query;
      if (query.includes("podResume")) { resumes++; return Response.json({ data: { podResume: { id: "pod_1", name: "Pod", desiredStatus: "RUNNING", costPerHr: 0.4 } } }); }
      return Response.json({ data: {} });
    },
  });
  const server = http.createServer((req, res) => route(req, res, new URL(req.url, "http://local")));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  config.uiPort = server.address().port;
  const url = `http://127.0.0.1:${server.address().port}/api/runpod/account/pods/pod_1/start`;
  const post = body => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-aiplay-actor": "agent:test" }, body: JSON.stringify(body) });
  const denied = await post({});
  assert.equal(denied.status, 400);
  assert.match((await denied.json()).error, /confirm paid Pod startup/);
  assert.equal(resumes, 0);
  const accepted = await post({ confirm: "START PAID POD" });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).pod.id, "pod_1");
  assert.equal(resumes, 1);
});
