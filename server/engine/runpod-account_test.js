import test from "node:test";
import assert from "node:assert/strict";
import { createRunpodAccount, normalizeAccount } from "./runpod-account.js";
import { assertComfyLoopback } from "../../worker/check-comfy-loopback.js";

const KEY = "runpod-test-api-key-at-least-32-characters";

function rig() {
  let saved, cleared = false;
  const calls = [];
  const fetchFn = async (_url, init) => {
    const request = JSON.parse(init.body); calls.push({ ...request, auth: init.headers.Authorization });
    const q = request.query;
    if (q.includes("AiplayAccountCheck")) return Response.json({ data: { myself: { id: "user", clientBalance: 20, currentSpendPerHr: 0 } } });
    if (q.includes("AiplayRunpodOverview")) return Response.json({ data: {
      myself: { clientBalance: 20, currentSpendPerHr: 0.72, pods: [{ id: "pod1", name: "AIPLAY", desiredStatus: "RUNNING",
        costPerHr: 0.72, imageName: "runpod/comfyui:cuda12.8", gpuCount: 1, volumeInGb: 100, containerDiskInGb: 20,
        ports: "8787/http", machine: { gpuDisplayName: "RTX 4090", gpuTypeId: "4090", secureCloud: true } }] },
      gpuTypes: [
        { id: "expensive", displayName: "RTX 6000", memoryInGb: 48, secureCloud: true, communityCloud: true,
          lowestPrice: { stockStatus: "High", uninterruptablePrice: 0.9 } },
        { id: "cheap", displayName: "RTX 4090", memoryInGb: 24, secureCloud: false, communityCloud: true,
          lowestPrice: { stockStatus: "Medium", uninterruptablePrice: 0.4 } },
        { id: "none", displayName: "Unavailable", memoryInGb: 80, lowestPrice: null },
      ],
    } });
    if (q.includes("AiplayCreatePod")) return Response.json({ data: { podFindAndDeployOnDemand: {
      id: "created1", name: request.variables.input.name, desiredStatus: "RUNNING", costPerHr: 0.4,
      imageName: request.variables.input.imageName, gpuCount: 1, volumeInGb: request.variables.input.volumeInGb,
      containerDiskInGb: request.variables.input.containerDiskInGb, ports: request.variables.input.ports,
      machine: { gpuDisplayName: "RTX 4090", gpuTypeId: "cheap", secureCloud: false },
    } } });
    if (q.includes("podResume")) return Response.json({ data: { podResume: { id: "pod1", name: "AIPLAY", desiredStatus: "RUNNING", costPerHr: 0.4 } } });
    if (q.includes("podStop")) return Response.json({ data: { podStop: { id: "pod1", name: "AIPLAY", desiredStatus: "EXITED", costPerHr: 0 } } });
    throw new Error("unexpected query");
  };
  const account = createRunpodAccount({ fetchFn, getApiKey: async () => saved, setApiKey: async key => { saved = key; },
    clearApiKey: async () => { saved = undefined; cleared = true; } });
  return { account, calls, get saved() { return saved; }, get cleared() { return cleared; } };
}

test("account key is verified, stored, used as a bearer token and never returned", async () => {
  const r = rig();
  assert.deepEqual(await r.account.status(), { configured: false });
  const connected = await r.account.connect(KEY);
  assert.equal(r.saved, KEY); assert.equal(connected.configured, true);
  assert.equal(JSON.stringify(connected).includes(KEY), false);
  await r.account.overview(); assert.equal(r.calls.at(-1).auth, `Bearer ${KEY}`);
  assert.equal(JSON.stringify(await r.account.status()).includes(KEY), false);
  await r.account.disconnect(); assert.equal(r.cleared, true);
});

test("account overview sorts priced GPUs and exposes useful Pod lifecycle fields", async () => {
  const r = rig(); await r.account.connect(KEY);
  const out = await r.account.overview();
  assert.equal(out.balance, 20); assert.equal(out.currentSpendPerHr, 0.72);
  assert.deepEqual(out.gpus.map(gpu => gpu.id), ["cheap", "expensive"]);
  assert.equal(out.pods[0].workerUrl, "https://pod1-8787.proxy.runpod.net");
  assert.equal(JSON.stringify(out).includes(KEY), false);
});

test("paid creation requires the review phrase and sends the bounded AIPLAY ComfyUI configuration", async () => {
  const r = rig(); await r.account.connect(KEY);
  await assert.rejects(r.account.create({ gpuTypeId: "cheap" }), /confirm paid Pod creation/);
  const result = await r.account.create({ confirm: "CREATE PAID POD", gpuTypeId: "cheap", name: "AIPLAY test",
    cloudType: "COMMUNITY", volumeInGb: 100, containerDiskInGb: 20 });
  const input = r.calls.at(-1).variables.input;
  assert.equal(input.imageName, "runpod/comfyui:cuda12.8");
  assert.equal(input.ports, "8787/http");
  assert.equal(input.gpuTypeId, "cheap"); assert.equal(input.cloudType, "COMMUNITY");
  assert.equal(result.pod.workerUrl, "https://created1-8787.proxy.runpod.net");
  assert.match(result.next, /Pod terminal or SSH session/);
});

test("worker accepts an IPv4 loopback ComfyUI listener and rejects absent or public listeners", () => {
  const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
  const row = (address, port = "1FFC") => `   0: ${address}:${port} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 0`;
  assert.doesNotThrow(() => assertComfyLoopback([header, row("0100007F")].join("\n")));
  assert.throws(() => assertComfyLoopback(header), /not listening on 127\.0\.0\.1/);
  assert.throws(() => assertComfyLoopback([header, row("00000000")].join("\n")), /outside loopback/);
  assert.throws(() => assertComfyLoopback([header, row("0100007F"), row("0201A8C0")].join("\n")), /outside loopback/);
  assert.throws(() => assertComfyLoopback([header, row("0100007F")].join("\n"),
    [header, row("00000000000000000000000000000000")].join("\n")), /outside loopback/);
});

test("creation refuses an existing Pod name before sending another paid mutation", async () => {
  const r = rig(); await r.account.connect(KEY);
  await assert.rejects(r.account.create({ confirm: "CREATE PAID POD", gpuTypeId: "cheap", name: "AIPLAY",
    volumeInGb: 100, containerDiskInGb: 20 }), /already exists/);
  assert.equal(r.calls.filter(call => call.query.includes("AiplayCreatePod")).length, 0);
});

test("start and stop use scoped Pod mutations", async () => {
  const r = rig(); await r.account.connect(KEY);
  assert.throws(() => r.account.start("pod1"), /confirm paid Pod startup/);
  assert.equal(r.calls.filter(call => call.query.includes("podResume")).length, 0);
  assert.equal((await r.account.start("pod1", "START PAID POD")).pod.status, "RUNNING");
  assert.equal(r.calls.at(-1).variables.input.gpuCount, 1);
  assert.equal((await r.account.stop("pod1")).pod.status, "EXITED");
  assert.deepEqual(r.calls.at(-1).variables.input, { podId: "pod1" });
  await assert.rejects(r.account.stop("bad/id"), /valid Pod ID/);
});

test("normalization tolerates empty API fields", () => {
  assert.deepEqual(normalizeAccount({}), { balance: 0, currentSpendPerHr: 0, pods: [], gpus: [] });
});
