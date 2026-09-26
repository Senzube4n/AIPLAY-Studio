/* RunPod inside AIPLAY's Images and Video screens, in the launcher's "RunPod GPU"
 * mode only (config.remoteOnly). In any other mode this file does nothing: the
 * blocks stay hidden, no request goes to /api/runpod, and Make / Render are
 * never intercepted. In that mode every Images and Video render goes to the Pod
 * (there is no local engine to choose), so the "Render on" chooser stays hidden.
 *
 * The local forms remain authoritative for prompts and common render settings.
 * This module only changes where the final button sends them. The worker token
 * goes directly to the local backend secret store and is never returned here. */

const $ = (id) => document.getElementById(id);
const FINAL = new Set(["completed", "cancelled", "failed", "uncertain"]);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let objectInfo = null;
let connected = false;
const active = new Map();
let runpodAccount = null;

function friendlyError(error) {
  const message = String(error?.message || error || "Unknown worker error");
  return /HTTP 404|fetch failed|network|ECONNREFUSED/i.test(message)
    ? "Pod is stopped or the worker is unavailable. Start the Pod, then check the connection again."
    : message;
}

export function modelChoices(spec) {
  if (Array.isArray(spec?.[0])) return spec[0];
  if (spec?.[0] === "COMBO" && Array.isArray(spec?.[1]?.options)) return spec[1].options;
  return [];
}

export function imageWorkflowOptions({ prompt, checkpoint, width, height, steps, seed, count = 1, negative = "", cfg = 6 }) {
  return { prompt, checkpoint, ckpt: checkpoint, width, height, steps, seed, count, negative, cfg };
}

export function videoWorkflowOptions({ prompt, negative, width, height, seconds, steps, seed, guidance }) {
  return { prompt, negative, width, height, seconds, duration: seconds, maxDuration: seconds, steps, seed, guidance };
}

async function api(route = "", body) {
  const response = await fetch(`/api/runpod${route}`, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`HTTP ${response.status}`); }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function accountApi(route = "", body) {
  return api(`/account${route}`, body);
}

function money(value) { return `$${Number(value || 0).toFixed(2)}`; }

function renderAccount(data) {
  runpodAccount = data;
  $("runpodAccountPanel").hidden = false;
  $("runpodBalance").textContent = `Balance ${money(data.balance)} · running spend ${money(data.currentSpendPerHr)}/hour`;
  const list = $("runpodPodList");
  list.replaceChildren();
  if (!data.pods?.length) list.textContent = "No Pods in this RunPod account yet.";
  for (const pod of data.pods || []) {
    const row = document.createElement("div"); row.className = "runpod-pod";
    const main = document.createElement("b"); main.textContent = pod.name || pod.id;
    const meta = document.createElement("small"); meta.textContent = `${pod.gpu} · ${pod.status} · ${money(pod.costPerHr)}/hour`;
    const actions = document.createElement("div"); actions.className = "runpod-pod-actions";
    const running = ["RUNNING", "CREATED", "RESTARTING"].includes(pod.status);
    const power = document.createElement("button"); power.type = "button"; power.className = "edtool sm";
    power.textContent = running ? "Stop" : "Start"; power.dataset.podPower = running ? "stop" : "start"; power.dataset.podId = pod.id;
    const use = document.createElement("button"); use.type = "button"; use.className = "edtool sm"; use.textContent = "Use worker URL";
    use.addEventListener("click", () => { $("runpodWorkerUrl").value = pod.workerUrl; $("runpodWorkerUrl").focus(); });
    actions.append(power, use); row.append(main, meta, actions); list.append(row);
  }
  const select = $("runpodGpu"), before = select.value;
  select.replaceChildren();
  for (const gpu of data.gpus || []) {
    const stock = gpu.stock === "None" ? "unavailable" : gpu.stock;
    const fit = gpu.memoryInGb >= 32 ? "image + LTX video" : "image; video may not fit";
    select.add(new Option(`${gpu.name} · ${gpu.memoryInGb} GB · ${money(gpu.pricePerHr)}/hr · ${stock} · ${fit}`, gpu.id));
  }
  if ([...select.options].some(option => option.value === before)) select.value = before;
  else {
    const recommended = (data.gpus || []).find(gpu => gpu.memoryInGb >= 32 && gpu.stock !== "None");
    if (recommended) select.value = recommended.id;
  }
  $("runpodAccountState").textContent = "RunPod account connected. Prices and availability are live estimates.";
  $("runpodAccountState").classList.remove("warnline");
}

async function loadAccount() {
  try {
    const status = await accountApi();
    if (!status.configured) {
      $("runpodAccountPanel").hidden = true;
      $("runpodAccountState").textContent = "No RunPod account API key saved.";
      return;
    }
    renderAccount(await accountApi("/overview"));
  } catch (error) {
    $("runpodAccountPanel").hidden = true;
    $("runpodAccountState").textContent = error.message;
    $("runpodAccountState").classList.add("warnline");
  }
}

function reviewPod() {
  const gpu = runpodAccount?.gpus?.find(row => row.id === $("runpodGpu").value);
  if (!gpu) { $("runpodAccountState").textContent = "No available GPU is selected."; return; }
  $("runpodReviewPrice").textContent = `${gpu.name}: estimated ${money(gpu.pricePerHr)} per running hour`;
  $("runpodReviewDetails").textContent = `${$("runpodPodName").value.trim() || "AIPLAY renderer"} · ${$("runpodCloud").selectedOptions[0].textContent} · ${$("runpodVolume").value} GB persistent disk. Storage is billed separately and can continue after the Pod is stopped.`;
  $("runpodCostConfirm").checked = false; $("runpodCreatePod").disabled = true; $("runpodCreateReview").hidden = false;
}

function setState(text, error = false) {
  for (const id of ["imgRunPodState", "vidRunPodState", "runpodConnectionState"]) {
    const el = $(id); if (!el) continue;
    el.textContent = text;
    el.classList.toggle("warnline", error);
  }
}

function randomSeed() {
  const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0];
}

function target(kind) { return $(`${kind}RenderWhere`)?.value || "local"; }

function paintTarget(kind) {
  const remote = target(kind) === "runpod";
  const panel = $(`${kind}Panel`);
  panel?.classList.toggle("runpod-target", remote);
  $(`${kind}RunPodOptions`).hidden = !remote;
  const engine = $(kind === "img" ? "imgEngine" : "vidEngine");
  if (engine) engine.disabled = remote;
  const engineLabel = document.querySelector(`label[for="${kind === "img" ? "imgEngine" : "vidEngine"}"]`);
  if (engineLabel) engineLabel.hidden = remote;
  if (engine?.parentElement) engine.parentElement.hidden = remote;
  const localOnlyControls = kind === "img" ? ["imgCfg", "imgSampler", "imgSched"] : ["vidSize", "vidSteps", "vidAudio"];
  for (const id of localOnlyControls) {
    const control = $(id);
    const label = document.querySelector(`label[for="${id}"]`);
    if (label) label.hidden = remote;
    if (control?.parentElement) control.parentElement.hidden = remote;
  }
  const button = $(kind === "img" ? "imgGo" : "vidCreate");
  if (button && !active.has(kind)) button.textContent = remote
    ? (kind === "img" ? "Make image on RunPod" : "Render clip on RunPod")
    : (kind === "img" ? "Make image" : "Render clip");
  if (kind === "vid") $("vidSecs")?.dispatchEvent(new Event("input"));
  if (remote && !connected) refreshWorker().catch((e) => setState(e.message, true));
}

function fillModels() {
  const select = $("imgRunPodCheckpoint");
  if (!select) return;
  const before = select.value;
  const spec = objectInfo?.CheckpointLoaderSimple?.input?.required?.ckpt_name;
  const choices = modelChoices(spec);
  select.replaceChildren(new Option(choices.length ? "Select a model on the Pod" : "No remote checkpoints found", ""));
  for (const name of choices) select.add(new Option(name, name));
  if ([...select.options].some((o) => o.value === before)) select.value = before;
  else if (choices.length === 1) select.value = choices[0];
}

async function refreshWorker() {
  const status = await api();
  if ($("runpodWorkerUrl") && !$("runpodWorkerUrl").value) $("runpodWorkerUrl").value = status.url || "";
  if (!status.configured) {
    connected = false; objectInfo = null; fillModels();
    setState("No worker saved. Open Connection to add its HTTPS URL and token.", true);
    return status;
  }
  try {
    objectInfo = await api("/models");
    connected = true; fillModels();
    setState("Worker connected · remote models checked.");
  } catch (error) {
    connected = false; objectInfo = null; fillModels();
    setState(friendlyError(error), true);
  }
  resume(status.jobs || []);
  return status;
}

function openSettings() { $("runpodConnection").hidden = false; $("runpodWorkerUrl").focus(); }
function closeSettings() { $("runpodConnection").hidden = true; }

function dimensions(kind) {
  if (kind === "vid" && target(kind) === "runpod") {
    const remote = String($("vidRunPodSize")?.value || "512x320").split("x").map(Number);
    if (remote.length === 2 && remote.every(Number.isFinite)) return remote;
  }
  const select = $(`${kind}Size`);
  if (select?.value === "custom") return [Number($(`${kind}W`).value), Number($(`${kind}H`).value)];
  const pair = String(select?.value || (kind === "img" ? "1024x1024" : "512x320")).split("x").map(Number);
  return pair.length === 2 && pair.every(Number.isFinite) ? pair : (kind === "img" ? [1024, 1024] : [512, 320]);
}

function noRemoteVideoInputs() {
  const picked = ["vidFrom", "vidTo", "vidSndSong"].some((id) => $(id)?.value)
    || ["vidFromFile", "vidToFile", "vidMidFile", "vidRefImgFile", "vidRefAudFile", "vidSndFile"].some((id) => $(id)?.files?.length)
    || $("vidMidPrev")?.children.length || $("vidRefImgPrev")?.children.length || $("vidRefAudPrev")?.children.length;
  if (picked) throw new Error("The integrated RunPod preset is text-to-video. Clear frames, references and soundtrack, or use This PC for those inputs.");
}

function noRemoteImageInputs() {
  const picked = $("imgPersona")?.value || $("imgRefFile")?.files?.length || $("imgRefPrev")?.children.length;
  if (picked) throw new Error("The integrated RunPod image preset does not upload references yet. Clear the selected references, or use This PC for this render.");
}

function note(kind, text, error = false) {
  const el = $(kind === "img" ? "imgNote" : "clipNote");
  if (!el) return;
  el.textContent = text; el.classList.toggle("warnline", error);
}

async function ensureWorker() {
  if (!connected) await refreshWorker();
  if (!connected) throw new Error("Start the Pod, then open Connection and connect the worker.");
}

async function submit(kind) {
  if (active.has(kind)) return;
  const button = $(kind === "img" ? "imgGo" : "vidCreate");
  active.set(kind, "submitting"); button.dataset.runpodBusy = "1"; button.disabled = true; button.textContent = "Sending to RunPod…";
  try {
    await ensureWorker();
    const [width, height] = dimensions(kind);
    let template, options, label;
    if (kind === "img") {
      noRemoteImageInputs();
      const prompt = $("imgPrompt").value.trim();
      if (!prompt) throw new Error("Describe the image first.");
      const checkpoint = $("imgRunPodCheckpoint").value;
      if (!checkpoint) throw new Error("Select a model installed on the Pod.");
      const raw = $("imgSeed").value.trim();
      template = "checkpoint";
      options = imageWorkflowOptions({ prompt, checkpoint, width, height,
        steps: Number($("imgSteps").value) || 20, seed: raw ? Number(raw) : randomSeed(),
        count: Number($("imgCount").value) || 1, negative: $("imgRunPodNegative").value.trim(),
        cfg: Number($("imgRunPodCfg").value) || 6 });
      label = `AIPLAY image · ${prompt.slice(0, 100)}`;
    } else {
      noRemoteVideoInputs();
      const prompt = $("vidPrompt").value.trim();
      if (!prompt) throw new Error("Describe the video first.");
      const raw = $("vidSeed").value.trim();
      template = "ltx";
      options = videoWorkflowOptions({ prompt, negative: $("vidNeg").value.trim(), width, height,
        seconds: Number($("vidSecs").value) || 5, steps: Number($("vidSteps").value) || 8,
        seed: raw ? Number(raw) : randomSeed(), guidance: Number($("vidRunPodGuidance").value) || 3 });
      label = `AIPLAY video · ${prompt.slice(0, 100)}`;
    }
    note(kind, "Building and validating the remote workflow…");
    const built = await api("/workflow", { template, options });
    const job = await api("/jobs", { graph: built.graph, bindings: [], label });
    active.set(kind, job.id);
    note(kind, `RunPod job ${job.id.slice(0, 8)} queued. You can keep using AIPLAY.`);
    watch(kind, job.id);
  } catch (error) {
    active.delete(kind); delete button.dataset.runpodBusy; button.disabled = false; paintTarget(kind); note(kind, friendlyError(error), true);
  }
}

async function watch(kind, id) {
  while (active.get(kind) === id) {
    await wait(2500);
    try {
      const status = await api();
      const job = (status.jobs || []).find((row) => row.id === id);
      if (!job) continue;
      if (!FINAL.has(job.state)) {
        note(kind, `RunPod · ${job.state}${job.remoteState && job.remoteState !== job.state ? ` · ${job.remoteState}` : ""}`);
        continue;
      }
      active.delete(kind);
      const button = $(kind === "img" ? "imgGo" : "vidCreate"); delete button.dataset.runpodBusy; button.disabled = false; paintTarget(kind);
      if (job.state === "completed") {
        note(kind, `Done on RunPod · ${(job.outputs || []).length} file${job.outputs?.length === 1 ? "" : "s"} added to this PC.`);
        document.dispatchEvent(new CustomEvent("aiplay:remote-output", { detail: { kind, job } }));
      } else note(kind, job.error || `RunPod job ${job.state}.`, true);
      return;
    } catch (error) { note(kind, `${friendlyError(error)} The job record remains on this PC.`, true); }
  }
}

function resume(jobs) {
  for (const kind of ["img", "vid"]) {
    if (active.has(kind)) continue;
    const prefix = kind === "img" ? "AIPLAY image · " : "AIPLAY video · ";
    const job = jobs.find((row) => row.label?.startsWith(prefix) && !FINAL.has(row.state));
    if (job) {
      active.set(kind, job.id);
      const button = $(kind === "img" ? "imgGo" : "vidCreate");
      if (button) { button.dataset.runpodBusy = "1"; button.disabled = true; button.textContent = "RunPod job running…"; }
      note(kind, `RunPod · ${job.state}`);
      watch(kind, job.id);
    }
  }
}

async function init() {
  if (!$("imgRenderWhere") || !$("vidRenderWhere")) return;
  let status = null;
  try { status = await (await fetch("/api/status")).json(); } catch { return; }
  if (!status?.config?.remoteOnly) return;
  for (const kind of ["img", "vid"]) {
    $(`${kind}RunPodBlock`).hidden = false;
    $(`${kind}RenderWhere`).value = "runpod";
    paintTarget(kind);
  }
  for (const button of document.querySelectorAll("[data-runpod-settings]")) button.addEventListener("click", openSettings);
  $("runpodConnectionClose").addEventListener("click", closeSettings);
  $("runpodConnection").addEventListener("click", (event) => { if (event.target === $("runpodConnection")) closeSettings(); });
  $("runpodConnectionForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("runpodConnect"); button.disabled = true;
    try {
      const result = await api("/connect", { url: $("runpodWorkerUrl").value, token: $("runpodWorkerToken").value });
      $("runpodWorkerToken").value = "";
      connected = true;
      objectInfo = await api("/models"); fillModels();
      const hardware = (result.devices || []).map((d) => d.name || d.type).filter(Boolean).join(" / ");
      setState(`Connected${hardware ? ` · ${hardware}` : ""}.`);
    } catch (error) { connected = false; setState(friendlyError(error), true); }
    finally { button.disabled = false; }
  });
  $("runpodAccountForm").addEventListener("submit", async (event) => {
    event.preventDefault(); const button = $("runpodAccountConnect"); button.disabled = true;
    try {
      await accountApi("/connect", { apiKey: $("runpodApiKey").value }); $("runpodApiKey").value = "";
      renderAccount(await accountApi("/overview"));
    } catch (error) { $("runpodAccountState").textContent = error.message; $("runpodAccountState").classList.add("warnline"); }
    finally { button.disabled = false; }
  });
  $("runpodAccountDisconnect").addEventListener("click", async () => {
    try {
      await accountApi("/disconnect", {}); runpodAccount = null; $("runpodAccountPanel").hidden = true;
      $("runpodAccountState").textContent = "RunPod account API key removed from this PC.";
    } catch (error) { $("runpodAccountState").textContent = error.message; $("runpodAccountState").classList.add("warnline"); }
  });
  $("runpodReviewPod").addEventListener("click", reviewPod);
  $("runpodCopyBootstrap").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("runpodBootstrapCommand").value); $("runpodBootstrapState").textContent = "Bootstrap command copied."; }
    catch { $("runpodBootstrapCommand").select(); $("runpodBootstrapState").textContent = "Press Ctrl+C to copy the selected command."; }
  });
  $("runpodCostConfirm").addEventListener("change", () => { $("runpodCreatePod").disabled = !$("runpodCostConfirm").checked; });
  $("runpodCreatePod").addEventListener("click", async () => {
    const button = $("runpodCreatePod"); button.disabled = true; button.textContent = "Creating Pod…";
    try {
      const created = await accountApi("/pods", { confirm: "CREATE PAID POD", name: $("runpodPodName").value,
        gpuTypeId: $("runpodGpu").value, cloudType: $("runpodCloud").value,
        volumeInGb: Number($("runpodVolume").value), containerDiskInGb: 20 });
      $("runpodWorkerUrl").value = created.pod.workerUrl;
      $("runpodCreateReview").hidden = true; renderAccount(await accountApi("/overview"));
      $("runpodAccountState").textContent = `Created ${created.pod.name}. ${created.next}`;
    } catch (error) { $("runpodAccountState").textContent = error.message; $("runpodAccountState").classList.add("warnline"); }
    finally { button.textContent = "Create paid Pod"; button.disabled = !$("runpodCostConfirm").checked; }
  });
  $("runpodPodList").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-pod-power]"); if (!button) return;
    const action = button.dataset.podPower;
    if (action === "start" && !window.confirm("Start this Pod now? Paid GPU billing begins as soon as RunPod allocates the GPU.")) return;
    button.disabled = true;
    try { await accountApi(`/pods/${encodeURIComponent(button.dataset.podId)}/${action}`, {}); renderAccount(await accountApi("/overview")); }
    catch (error) { $("runpodAccountState").textContent = error.message; $("runpodAccountState").classList.add("warnline"); }
    finally { button.disabled = false; }
  });
  $("imgGo").addEventListener("click", (event) => {
    if (target("img") !== "runpod") return;
    event.preventDefault(); event.stopImmediatePropagation(); submit("img");
  }, true);
  $("vidCreate").addEventListener("click", (event) => {
    if (target("vid") !== "runpod") return;
    event.preventDefault(); event.stopImmediatePropagation(); submit("vid");
  }, true);
  refreshWorker().catch((error) => setState(error.message, true));
  loadAccount();
}

if (typeof document !== "undefined") init();
