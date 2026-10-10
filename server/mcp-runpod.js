/** Typed MCP access to the launcher's RunPod GPU mode. All work goes through
 * the same local HTTP routes as the UI, so server checks and actor provenance
 * remain in one place. Nothing here talks to RunPod directly. */
import path from "node:path";
import { open } from "node:fs/promises";
import { jobId, relativeFile, validateGraph } from "./engine/remote-common.js";

const POD_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const ASSET_NAME = /\.(png|jpe?g|webp|gif|mp4|webm|mov|mkv|m4v|wav|flac|mp3|ogg|opus|latent|npy|npz)$/i;
const ASSET_LIMIT = 64 * 1024 * 1024;
const TEMPLATES = ["checkpoint", "qwen", "ace-step15", "yue2-comfy", "h3", "ltx"];
const WORKFLOW_OPTIONS = {
  prompt: { type: "string" }, caption: { type: "string" }, lyrics: { type: "string" }, negative: { type: "string" },
  ckpt: { type: "string" }, checkpoint: { type: "string" }, dit: { type: "string" }, encoder: { type: "string" }, vae: { type: "string" },
  width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 },
  seconds: { type: "number", exclusiveMinimum: 0 }, duration: { type: "number", exclusiveMinimum: 0 },
  maxDuration: { type: "number", exclusiveMinimum: 0 }, steps: { type: "integer", minimum: 1 },
  cfg: { type: "number" }, guidance: { type: "number" }, seed: { type: "integer", minimum: 0 },
  count: { type: "integer", minimum: 1, maximum: 16 },
  refImages: { type: "array", maxItems: 10, items: { type: "string" } },
  refSizing: { type: "string", enum: ["reference", "custom"] },
  refResolution: { type: "integer", minimum: 0, maximum: 4096 }, transparent: { type: "boolean" },
};

function object(value, fields, required = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) throw new Error(`Expected only: ${fields.join(", ")}.`);
  return value;
}
function text(value, label, max = 160) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n]/.test(value)) throw new Error(`Enter a valid ${label}.`);
  return value.trim();
}
function podId(value) {
  if (typeof value !== "string" || !POD_ID.test(value)) throw new Error("Enter a valid Pod ID.");
  return value;
}
function redact(value, secrets = []) {
  if (typeof value === "string") {
    return secrets.reduce((part, secret) => secret ? part.replaceAll(secret, "[redacted]") : part, value);
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    key !== "hasToken" && /(?:token|api.?key|authorization|password|secret)/i.test(key) ? "[redacted]" : redact(entry, secrets)]));
}
async function clean(response, secrets = []) {
  try { return redact(await response, secrets); }
  catch (error) { throw new Error(redact(String(error.message || error), secrets)); }
}
function validOptions(options) {
  object(options, Object.keys(WORKFLOW_OPTIONS));
  for (const [key, value] of Object.entries(options)) {
    const spec = WORKFLOW_OPTIONS[key];
    if (spec.type === "string" && typeof value !== "string") throw new Error(`${key} must be text.`);
    if (spec.type === "boolean" && typeof value !== "boolean") throw new Error(`${key} must be true or false.`);
    if (spec.type === "number" && (!Number.isFinite(value) || (spec.exclusiveMinimum !== undefined && value <= spec.exclusiveMinimum))) throw new Error(`${key} must be a positive number.`);
    if (spec.type === "integer" && (!Number.isSafeInteger(value) || value < (spec.minimum ?? -Infinity) || value > (spec.maximum ?? Infinity))) throw new Error(`${key} is out of range.`);
    if (spec.enum && !spec.enum.includes(value)) throw new Error(`${key} is not a supported choice.`);
    if (spec.type === "array" && (!Array.isArray(value) || value.length > spec.maxItems || value.some(item => typeof item !== "string" || !item))) throw new Error(`${key} must be a short list of filenames.`);
  }
  return options;
}
function validBindings(bindings) {
  if (!Array.isArray(bindings) || bindings.length > 30) throw new Error("Use at most 30 input bindings.");
  for (const row of bindings) {
    object(row, ["node", "input", "asset"], ["node", "input", "asset"]);
    if (!/^[a-zA-Z0-9_-]+$/.test(String(row.node)) || !/^[a-zA-Z0-9_.-]+$/.test(String(row.input))
        || !/^[a-f0-9]{64}\.[a-z0-9]+$/.test(String(row.asset))) throw new Error("Use a node, input and asset returned by runpod_upload_asset.");
  }
  return bindings;
}
function validGraph(graph) {
  validateGraph(graph);
  for (const node of Object.values(graph)) {
    object(node, ["class_type", "inputs", "_meta"], ["class_type", "inputs"]);
    if (node._meta !== undefined && (!node._meta || typeof node._meta !== "object" || Array.isArray(node._meta))) throw new Error("Workflow node metadata must be an object.");
  }
  return graph;
}
async function localAsset(filename) {
  if (typeof filename !== "string" || !path.isAbsolute(filename) || /^[a-z]+:\/\//i.test(filename)) throw new Error("Give an absolute local file path, not a URL.");
  const name = relativeFile(path.basename(filename));
  if (!ASSET_NAME.test(name)) throw new Error("RunPod MCP upload accepts image, audio, video, latent and NumPy references only.");
  const file = await open(filename, "r");
  try {
    const st = await file.stat();
    if (!st.isFile() || st.size <= 0 || st.size > ASSET_LIMIT) throw new Error("RunPod MCP references must be nonempty files no larger than 64 MiB.");
    const bytes = Buffer.alloc(st.size);
    let position = 0;
    while (position < bytes.length) {
      const part = await file.read(bytes, position, bytes.length - position, position);
      if (!part.bytesRead) throw new Error("The reference changed while reading; retry the stable file.");
      position += part.bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, position)).bytesRead) throw new Error("The reference grew while reading; retry the stable file.");
    return { name, bytes };
  } finally { await file.close(); }
}

export function runpodTools(api) {
  const empty = { type: "object", properties: {}, additionalProperties: false };
  const get = (route) => clean(api("GET", route));
  const post = (route, body, timeout, media, secrets) => clean(api("POST", route, body, timeout, media), secrets);
  return [
    { name: "runpod_status", description: "Read the saved RunPod worker connection and local remote jobs. No worker token is returned. Available only in the launcher's RunPod GPU mode.",
      inputSchema: empty, async run(a = {}) { object(a, []); return get("/api/runpod"); } },
    { name: "runpod_worker_connect", description: "Connect to an authenticated AIPLAY worker over HTTPS (loopback HTTP is allowed by the server for a local tunnel). The token is saved by Studio and never returned; omit it only when refreshing the current worker connection.",
      inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" }, token: { type: "string", description: "Worker bearer token, separate from the RunPod account key." } }, additionalProperties: false },
      async run(a) { object(a, ["url", "token"], ["url"]); const url = text(a.url, "worker URL", 500); const token = a.token === undefined ? undefined : text(a.token, "worker token", 1000);
        return post("/api/runpod/connect", { url, ...(token ? { token } : {}) }, 120_000, null, [token]); } },
    { name: "runpod_models", description: "Read the connected worker's installed models and ComfyUI nodes before building or sending a workflow.",
      inputSchema: empty, async run(a = {}) { object(a, []); return get("/api/runpod/models"); } },
    { name: "runpod_setup_status", description: "Read verified model-bundle installation progress on the connected worker. Starts no download or render.",
      inputSchema: empty, async run(a = {}) { object(a, []); return get("/api/runpod/setup"); } },
    { name: "runpod_install_bundle", description: "Install or resume the pinned YuE2 bundle on the connected worker after the user accepts its repository terms. Verifies size and SHA-256. Downloads weights but does not deploy a Pod or start a render.",
      inputSchema: { type: "object", required: ["bundle", "acceptLicense"], properties: { bundle: { type: "string", enum: ["yue2-comfy"] }, acceptLicense: { type: "boolean", const: true } }, additionalProperties: false },
      async run(a) { object(a, ["bundle", "acceptLicense"], ["bundle", "acceptLicense"]); if (a.bundle !== "yue2-comfy" || a.acceptLicense !== true) throw new Error("Choose the YuE2 bundle and explicitly accept its repository terms."); return post("/api/runpod/setup/install", a); } },
    { name: "runpod_cancel_install", description: "Pause the connected worker's model download, retaining resumable partial bytes. Does not stop a Pod or render.",
      inputSchema: empty, async run(a = {}) { object(a, []); return post("/api/runpod/setup/cancel", {}); } },
    { name: "runpod_templates", description: "List this account's private AIPLAY workload templates. Does not start a GPU or download models.",
      inputSchema: empty, async run(a = {}) { object(a, []); return get("/api/runpod/account/templates"); } },
    { name: "runpod_create_templates", description: "Create missing private AIPLAY image, video, audio and ACE-Step training presets when requested. Existing named presets remain unchanged. Does not deploy or start a paid Pod.",
      inputSchema: empty, async run(a = {}) { object(a, []); return post("/api/runpod/account/templates", {}); } },
    { name: "runpod_workflow_preview", description: "Build a ComfyUI API workflow from Studio's RunPod template. Read-only: it does not queue a render. Review the graph and worker models before runpod_submit_job.",
      inputSchema: { type: "object", required: ["template", "options"], properties: { template: { type: "string", enum: TEMPLATES }, options: { type: "object", properties: WORKFLOW_OPTIONS, additionalProperties: false } }, additionalProperties: false },
      async run(a) { object(a, ["template", "options"], ["template", "options"]); if (!TEMPLATES.includes(a.template)) throw new Error("Unknown RunPod workflow template.");
        return post("/api/runpod/workflow", { template: a.template, options: validOptions(a.options) }); } },
    { name: "runpod_upload_asset", description: "Send one explicitly chosen local image/audio/video/latent/NumPy reference to the connected worker. Only absolute local files, no URLs; maximum 64 MiB in MCP. The worker returns a content-addressed asset name for runpod_submit_job bindings. This transfers the file to the user's Pod and does not start a render.",
      inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: false },
      async run(a) { object(a, ["path"], ["path"]); const asset = await localAsset(a.path);
        return post(`/api/runpod/assets?name=${encodeURIComponent(asset.name)}`, asset.bytes, 300_000,
          { contentType: "application/octet-stream" }); } },
    { name: "runpod_submit_job", description: "Queue a reviewed ComfyUI API graph on the connected paid Pod. The server records the forced MCP actor before dispatch, gives a durable local job ID, and polls/downloads results. Running Pods incur charges. Use runpod_status to follow it; uncertain work must be reviewed before starting another job.",
      inputSchema: { type: "object", required: ["graph"], properties: {
        graph: { type: "object", minProperties: 1, maxProperties: 500, additionalProperties: { type: "object", required: ["class_type", "inputs"], properties: { class_type: { type: "string" }, inputs: { type: "object" }, _meta: { type: "object" } }, additionalProperties: false } },
        bindings: { type: "array", maxItems: 30, items: { type: "object", required: ["node", "input", "asset"], properties: { node: { type: "string" }, input: { type: "string" }, asset: { type: "string" } }, additionalProperties: false } },
        label: { type: "string", maxLength: 160 },
      }, additionalProperties: false },
      async run(a) { object(a, ["graph", "bindings", "label"], ["graph"]);
        const body = { graph: validGraph(a.graph), bindings: validBindings(a.bindings ?? []), label: a.label === undefined ? "Remote render" : text(a.label, "job name") };
        if (Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024) throw new Error("Workflow exceeds the local API's 2 MiB JSON limit.");
        return post("/api/runpod/jobs", body); } },
    { name: "runpod_cancel_job", description: "Ask the connected worker to cancel one durable local RunPod job. Poll runpod_status until cancellation is confirmed; a late result may still complete.",
      inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false },
      async run(a) { object(a, ["id"], ["id"]); return post(`/api/runpod/jobs/${jobId(a.id)}/cancel`, {}); } },
    { name: "runpod_account_status", description: "Check whether a RunPod account API key is saved locally. The key is never returned.",
      inputSchema: empty, async run(a = {}) { object(a, []); return get("/api/runpod/account"); } },
    { name: "runpod_account_overview", description: "Read account balance, current hourly spend, Pods, live GPU stock and hourly price estimates. Read this immediately before requesting a paid Pod creation or start.",
      inputSchema: empty, async run(a = {}) { object(a, []); return get("/api/runpod/account/overview"); } },
    { name: "runpod_account_connect", description: "Verify and save a restricted RunPod account API key in Studio's local secret store. The key is never returned. This key manages paid Pods and is distinct from the worker token.",
      inputSchema: { type: "object", required: ["apiKey"], properties: { apiKey: { type: "string" } }, additionalProperties: false },
      async run(a) { object(a, ["apiKey"], ["apiKey"]); const apiKey = text(a.apiKey, "RunPod API key", 500);
        return post("/api/runpod/account/connect", { apiKey }, 120_000, null, [apiKey]); } },
    { name: "runpod_account_disconnect", description: "Remove the saved RunPod account API key from this Studio. Existing Pods continue until stopped; removing the key does not stop billing.",
      inputSchema: empty, async run(a = {}) { object(a, []); return post("/api/runpod/account/disconnect", {}); } },
    { name: "runpod_pod_create", description: "Create a paid on-demand Pod after reviewing runpod_account_overview's GPU price and storage charges with the user. The exact CREATE PAID POD phrase is required by the server. Creation starts billing; no hidden create or retry is attempted. Only authenticated worker port 8787 is exposed.",
      inputSchema: { type: "object", required: ["gpuTypeId", "confirm"], properties: {
        gpuTypeId: { type: "string" }, confirm: { type: "string", enum: ["CREATE PAID POD"] }, name: { type: "string", maxLength: 80 },
        cloudType: { type: "string", enum: ["ALL", "SECURE", "COMMUNITY"] },
        volumeInGb: { type: "integer", minimum: 20, maximum: 1000 }, containerDiskInGb: { type: "integer", minimum: 10, maximum: 200 },
      }, additionalProperties: false },
      async run(a) { object(a, ["gpuTypeId", "confirm", "name", "cloudType", "volumeInGb", "containerDiskInGb"], ["gpuTypeId", "confirm"]);
        if (a.confirm !== "CREATE PAID POD") throw new Error("Review the hourly price and confirm paid Pod creation.");
        const body = { gpuTypeId: text(a.gpuTypeId, "GPU type"), confirm: a.confirm };
        if (a.name !== undefined) body.name = text(a.name, "Pod name", 80);
        if (a.cloudType !== undefined) { if (!["ALL", "SECURE", "COMMUNITY"].includes(a.cloudType)) throw new Error("Unknown cloud type."); body.cloudType = a.cloudType; }
        for (const [key, min, max] of [["volumeInGb", 20, 1000], ["containerDiskInGb", 10, 200]]) {
          if (a[key] !== undefined) { if (!Number.isSafeInteger(a[key]) || a[key] < min || a[key] > max) throw new Error(`${key} is out of range.`); body[key] = a[key]; }
        }
        return post("/api/runpod/account/pods", body); } },
    { name: "runpod_pod_start", description: "Resume one paid Pod after reviewing its hourly cost in runpod_account_overview with the user. Billing begins when RunPod allocates the GPU. The server requires the exact START PAID POD phrase; no hidden retry is attempted.",
      inputSchema: { type: "object", required: ["id", "confirm"], properties: { id: { type: "string" }, confirm: { type: "string", enum: ["START PAID POD"] } }, additionalProperties: false },
      async run(a) { object(a, ["id", "confirm"], ["id", "confirm"]); if (a.confirm !== "START PAID POD") throw new Error("Review the hourly price and confirm paid Pod startup.");
        return post(`/api/runpod/account/pods/${podId(a.id)}/start`, { confirm: a.confirm }); } },
    { name: "runpod_pod_stop", description: "Stop one Pod's GPU compute. Persistent storage may continue to incur charges; verify the Pod state with runpod_account_overview.",
      inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false },
      async run(a) { object(a, ["id"], ["id"]); return post(`/api/runpod/account/pods/${podId(a.id)}/stop`, {}); } },
  ];
}
