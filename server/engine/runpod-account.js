const API = "https://api.runpod.io/graphql";
const REST_API = "https://rest.runpod.io/v1";
const POD_FIELDS = `id name desiredStatus costPerHr imageName gpuCount volumeInGb containerDiskInGb ports
  machine { gpuDisplayName gpuTypeId secureCloud }`;

const TEMPLATE_IMAGE = "runpod/comfyui:1.4.7-cuda13.0";
const TEMPLATE_PORTS = Object.freeze(["8787/http"]);
const TRAINING_IMAGE = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04";
const TRAINING_PORTS = Object.freeze(["8888/http", "7860/http", "6006/http"]);
export const AIPLAY_POD_TEMPLATES = Object.freeze([
  Object.freeze({ id: "images", name: "AIPLAY Images", volumeInGb: 60,
    readme: "AIPLAY image rendering with ComfyUI and worker port 8787. Use a 16 GB or larger NVIDIA GPU. Install the AIPLAY worker and your licensed image checkpoints after the first launch." }),
  Object.freeze({ id: "video", name: "AIPLAY Video", volumeInGb: 120,
    readme: "AIPLAY LTX video rendering with ComfyUI and worker port 8787. Use a 32 GB or larger NVIDIA GPU. Install the AIPLAY worker, LTX nodes, and licensed model bundle after the first launch." }),
  Object.freeze({ id: "audio", name: "AIPLAY Audio", volumeInGb: 100,
    readme: "AIPLAY music rendering with ComfyUI and worker port 8787. Use a 24 GB or larger NVIDIA GPU. Install the AIPLAY worker and the licensed YuE2, ACE-Step, or MiniMax Music models you plan to use." }),
  Object.freeze({ id: "music-lora", name: "AIPLAY Music LoRA Training", volumeInGb: 120,
    imageName: TRAINING_IMAGE, ports: TRAINING_PORTS,
    readme: `# AIPLAY Music LoRA Training

PyTorch Pod preset for the official ACE-Step 1.5 LoRA trainer.

- Minimum: NVIDIA GPU with 12 GB VRAM
- Recommended: 24 GB VRAM or more
- Persistent workspace: 120 GB at \`/workspace\`
- JupyterLab: port 8888
- ACE-Step: port 7860
- TensorBoard: port 6006

Open a JupyterLab terminal after deployment and run:

\`\`\`bash
python -m pip install --upgrade uv
cd /workspace
git clone https://github.com/ace-step/ACE-Step-1.5.git
cd ACE-Step-1.5
git checkout ca1e85fe9430179831e6bc6be790c332190a3866
uv sync
uv run acestep
\`\`\`

Open port 7860 and use the LoRA Training tab. Models download on first launch. Keep datasets and output under \`/workspace\`, and train only on audio you have permission to use.` }),
]);

function cleanText(value, name, max = 120) {
  const text = String(value || "").trim();
  if (!text || text.length > max || /[\r\n]/.test(text)) throw new Error(`Enter a valid ${name}.`);
  return text;
}

function podId(value) {
  const id = cleanText(value, "Pod ID", 80);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Enter a valid Pod ID.");
  return id;
}

function number(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return n;
}

export function normalizeAccount(data = {}) {
  const user = data.myself || {};
  const pods = (user.pods || []).map(pod => ({
    id: pod.id, name: pod.name, status: pod.desiredStatus, costPerHr: Number(pod.costPerHr || 0),
    imageName: pod.imageName, gpuCount: pod.gpuCount, volumeInGb: pod.volumeInGb,
    containerDiskInGb: pod.containerDiskInGb, ports: pod.ports,
    gpu: pod.machine?.gpuDisplayName || pod.machine?.gpuTypeId || "GPU",
    workerUrl: pod.id ? `https://${pod.id}-8787.proxy.runpod.net` : null,
  }));
  const gpus = (data.gpuTypes || []).map(gpu => ({
    id: gpu.id, name: gpu.displayName || gpu.id, memoryInGb: Number(gpu.memoryInGb || 0),
    secureCloud: !!gpu.secureCloud, communityCloud: !!gpu.communityCloud,
    pricePerHr: Number(gpu.lowestPrice?.uninterruptablePrice || 0),
    stock: gpu.lowestPrice?.stockStatus || "Unknown",
  })).filter(gpu => gpu.pricePerHr > 0).sort((a, b) => a.pricePerHr - b.pricePerHr || a.memoryInGb - b.memoryInGb);
  return { balance: Number(user.clientBalance || 0), currentSpendPerHr: Number(user.currentSpendPerHr || 0), pods, gpus };
}

export function createRunpodAccount({ getApiKey, setApiKey, clearApiKey, fetchFn = fetch }) {
  let apiKey;
  let creating = false;
  let creatingTemplates = false;
  async function key() { return apiKey ||= await getApiKey(); }
  async function graphql(query, variables = {}, override) {
    const auth = override || await key();
    if (!auth) throw new Error("Add a RunPod API key first.");
    let response;
    try {
      response = await fetchFn(API, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}` },
        body: JSON.stringify({ query, variables }) });
    } catch { throw new Error("Could not reach the RunPod account API."); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? "RunPod rejected this API key." : `RunPod account API returned HTTP ${response.status}.`);
    if (body.errors?.length) throw new Error(String(body.errors[0].message || "RunPod rejected the request.").slice(0, 500));
    return body.data || {};
  }
  async function rest(pathname, { method = "GET", body } = {}) {
    const auth = await key();
    if (!auth) throw new Error("Add a RunPod API key first.");
    let response;
    try {
      response = await fetchFn(`${REST_API}${pathname}`, { method, redirect: "error", signal: AbortSignal.timeout(30000),
        headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), Authorization: `Bearer ${auth}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new Error("Could not reach the RunPod template API."); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? "RunPod rejected this API key." : String(result?.error || result?.message || `RunPod template API returned HTTP ${response.status}.`).slice(0, 500));
    return result;
  }
  async function connect(entered) {
    const candidate = cleanText(entered, "RunPod API key", 500);
    if (candidate.length < 20) throw new Error("Enter a valid RunPod API key.");
    const data = await graphql(`query AiplayAccountCheck { myself { id clientBalance currentSpendPerHr } }`, {}, candidate);
    await setApiKey(candidate); apiKey = candidate;
    return { configured: true, balance: Number(data.myself?.clientBalance || 0), currentSpendPerHr: Number(data.myself?.currentSpendPerHr || 0) };
  }
  async function disconnect() { await clearApiKey(); apiKey = null; return { configured: false }; }
  async function overview() {
    const data = await graphql(`query AiplayRunpodOverview {
      myself { clientBalance currentSpendPerHr pods { ${POD_FIELDS} } }
      gpuTypes { id displayName memoryInGb secureCloud communityCloud
        lowestPrice(input: { gpuCount: 1 }) { stockStatus uninterruptablePrice availableGpuCounts } }
    }`);
    return { configured: true, ...normalizeAccount(data) };
  }
  async function create(input = {}) {
    if (creating) throw new Error("A Pod creation request is already in progress.");
    if (input.confirm !== "CREATE PAID POD") throw new Error("Review the hourly price and confirm paid Pod creation.");
    const gpuTypeId = cleanText(input.gpuTypeId, "GPU type", 160);
    const name = cleanText(input.name || "AIPLAY renderer", "Pod name", 80);
    const cloudType = ["ALL", "SECURE", "COMMUNITY"].includes(input.cloudType) ? input.cloudType : "ALL";
    const volumeInGb = number(input.volumeInGb ?? 100, "Persistent volume", 20, 1000);
    const containerDiskInGb = number(input.containerDiskInGb ?? 20, "Container disk", 10, 200);
    const imageName = cleanText(input.imageName || "runpod/comfyui:cuda12.8", "container image", 240);
    creating = true;
    try {
      const current = await overview();
      if (current.pods.some(pod => pod.name === name)) throw new Error(`A RunPod named "${name}" already exists. Refresh the list before retrying.`);
      const variables = { input: { cloudType, gpuCount: 1, volumeInGb, containerDiskInGb,
        minVcpuCount: 2, minMemoryInGb: 15, gpuTypeId, name, imageName,
        dockerArgs: "", ports: "8787/http", volumeMountPath: "/workspace" } };
      const data = await graphql(`mutation AiplayCreatePod($input: PodFindAndDeployOnDemandInput) {
        podFindAndDeployOnDemand(input: $input) { ${POD_FIELDS} }
      }`, variables);
      const pod = data.podFindAndDeployOnDemand;
      if (!pod?.id) throw new Error("RunPod did not return the created Pod. Refresh the account before retrying.");
      return { pod: normalizeAccount({ myself: { pods: [pod] } }).pods[0],
        next: "Open a Pod terminal or SSH session once it is ready, then install the AIPLAY worker and models." };
    } finally { creating = false; }
  }
  async function templates() {
    const rows = await rest("/templates");
    if (!Array.isArray(rows)) throw new Error("RunPod returned an invalid template list.");
    const wanted = new Set(AIPLAY_POD_TEMPLATES.map(template => template.name));
    return rows.filter(row => wanted.has(row.name)).map(row => ({ id: row.id, name: row.name,
      imageName: row.imageName, volumeInGb: Number(row.volumeInGb || 0), containerDiskInGb: Number(row.containerDiskInGb || 0),
      isPublic: !!row.isPublic, ports: Array.isArray(row.ports) ? row.ports : [] }));
  }
  async function createTemplates() {
    if (creatingTemplates) throw new Error("A template creation request is already in progress.");
    creatingTemplates = true;
    try {
      const existing = await templates();
      const names = new Set(existing.map(template => template.name));
      const created = [];
      for (const template of AIPLAY_POD_TEMPLATES) {
        if (names.has(template.name)) continue;
        const row = await rest("/templates", { method: "POST", body: {
          name: template.name, imageName: template.imageName || TEMPLATE_IMAGE, category: "NVIDIA", containerDiskInGb: 20,
          dockerEntrypoint: [], dockerStartCmd: [], env: { AIPLAY_TEMPLATE_PROFILE: template.id },
          isPublic: false, isServerless: false, ports: [...(template.ports || TEMPLATE_PORTS)], readme: template.readme,
          volumeInGb: template.volumeInGb, volumeMountPath: "/workspace",
        } });
        if (!row?.id) throw new Error(`RunPod did not return the created ${template.name} template.`);
        created.push({ id: row.id, name: row.name || template.name });
      }
      return { created, existing: existing.map(template => ({ id: template.id, name: template.name })),
        templates: await templates(), consoleUrl: "https://console.runpod.io/user/templates" };
    } finally { creatingTemplates = false; }
  }
  async function setRunning(id, running) {
    id = podId(id);
    const operation = running ? "podResume" : "podStop";
    const type = running ? "PodResumeInput!" : "PodStopInput!";
    const input = running ? { podId: id, gpuCount: 1 } : { podId: id };
    const data = await graphql(`mutation AiplayPodPower($input: ${type}) { ${operation}(input: $input) { ${POD_FIELDS} } }`, { input });
    const pod = data[operation];
    if (!pod?.id) throw new Error(`RunPod did not ${running ? "start" : "stop"} the Pod.`);
    return { pod: normalizeAccount({ myself: { pods: [pod] } }).pods[0] };
  }
  return {
    status: async () => ({ configured: !!(await key()) }), connect, disconnect, overview, create,
    templates, createTemplates,
    start: (id, confirm) => {
      if (confirm !== "START PAID POD") throw new Error("Review the hourly price and confirm paid Pod startup.");
      return setRunning(id, true);
    },
    stop: id => setRunning(id, false),
  };
}
