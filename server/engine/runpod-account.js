const API = "https://api.runpod.io/graphql";
const POD_FIELDS = `id name desiredStatus costPerHr imageName gpuCount volumeInGb containerDiskInGb ports
  machine { gpuDisplayName gpuTypeId secureCloud }`;

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
    start: id => setRunning(id, true), stop: id => setRunning(id, false),
  };
}
