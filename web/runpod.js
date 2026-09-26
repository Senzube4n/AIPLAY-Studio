const $ = id => document.getElementById(id);
let models = null, submitting = false, lastJobs = "";
const message = (text, error = false) => { $("notice").textContent = text; $("notice").classList.toggle("error", error); };
async function api(route = "", body, options = {}) {
  const response = await fetch(`/api/runpod${route}`, { ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
const action = fn => async event => { event?.preventDefault(); try { await fn(); } catch (e) { message(e.message, true); } };
function workflow() {
  const graph = JSON.parse($("graph").value);
  if (!graph || Array.isArray(graph) || !Object.keys(graph).length || Object.values(graph).some(n => !n.class_type || !n.inputs)) throw new Error("Use a ComfyUI workflow exported in API format.");
  return graph;
}
function validate() {
  try {
    const graph = workflow();
    const missing = models ? [...new Set(Object.values(graph).map(n => n.class_type))].filter(n => !models[n]) : [];
    $("validation").textContent = missing.length ? `Missing worker nodes: ${missing.join(", ")}` : `${Object.keys(graph).length} nodes. ${models ? "Node types are available; the worker also validates model selections before rendering." : "Connect to check installed nodes."}`;
  } catch (e) { $("validation").textContent = e.message; }
}
async function loadModels() {
  models = await api("/models");
  const previous = $("checkpoint").value;
  $("checkpoint").replaceChildren(new Option("Select a remote checkpoint", ""));
  const spec = models.CheckpointLoaderSimple?.input?.required?.ckpt_name;
  const choices = Array.isArray(spec?.[0]) ? spec[0] : spec?.[0] === "COMBO" && Array.isArray(spec?.[1]?.options) ? spec[1].options : [];
  for (const name of choices) $("checkpoint").add(new Option(name, name));
  if ([...$("checkpoint").options].some(o => o.value === previous)) $("checkpoint").value = previous;
  if ($("graph").value.trim()) validate();
}
$("connectForm").addEventListener("submit", action(async () => {
  $("connectButton").disabled = true;
  try {
    const result = await api("/connect", { url: $("url").value, token: $("token").value });
    $("token").value = "";
    $("connectionState").textContent = "Worker connected";
    $("hardware").textContent = (result.devices || []).map(d => `${d.name || d.type}${d.vram_total ? ` · ${(d.vram_total / 1073741824).toFixed(1)} GB VRAM` : ""}`).join(" / ") || "Remote ComfyUI is ready.";
    await loadModels(); message("Connected. Select a template or import your workflow.");
  } finally { $("connectButton").disabled = false; }
}));
$("refreshModels").addEventListener("click", action(loadModels));
$("build").addEventListener("click", action(async () => {
  const template = $("template").value;
  if (template === "checkpoint" && !$("checkpoint").value) throw new Error("Select a checkpoint installed on the worker.");
  const options = { prompt: $("prompt").value, caption: $("prompt").value, lyrics: $("lyrics").value,
    ckpt: $("checkpoint").value, checkpoint: $("checkpoint").value || undefined,
    width: Number($("width").value), height: Number($("height").value), seed: Number($("seed").value),
    seconds: Number($("seconds").value), duration: Number($("seconds").value), maxDuration: Number($("seconds").value) };
  const result = await api("/workflow", { template, options });
  $("graph").value = JSON.stringify(result.graph, null, 2); $("bindings").replaceChildren(); validate();
}));
$("workflowFile").addEventListener("change", action(async () => {
  const file = $("workflowFile").files[0]; if (!file) return;
  if (file.size > 2 * 1024 * 1024) throw new Error("Workflow exceeds 2 MiB.");
  $("graph").value = await file.text(); workflow(); $("bindings").replaceChildren(); validate();
}));
$("graph").addEventListener("change", validate);
$("addReference").addEventListener("click", action(async () => {
  const graph = workflow();
  const row = document.createElement("div"); row.className = "binding";
  const node = document.createElement("select"); node.setAttribute("aria-label", "Reference node");
  for (const [id, def] of Object.entries(graph)) node.add(new Option(`${id} · ${def.class_type}`, id));
  const field = document.createElement("select"); field.setAttribute("aria-label", "Reference input");
  const fields = () => { field.replaceChildren(); for (const [key, value] of Object.entries(graph[node.value].inputs)) if (typeof value === "string") field.add(new Option(key, key)); };
  const first = Object.entries(graph).find(([, n]) => /load.*(image|audio|video|latent)/i.test(n.class_type));
  if (first) node.value = first[0]; fields(); node.addEventListener("change", fields);
  const file = document.createElement("input"); file.type = "file"; file.setAttribute("aria-label", "Reference file");
  const remove = document.createElement("button"); remove.textContent = "Remove"; remove.className = "secondary"; remove.addEventListener("click", () => row.remove());
  row.append(node, field, file, remove); $("bindings").append(row);
}));
$("render").addEventListener("click", action(async () => {
  if (submitting) return;
  submitting = true; $("render").disabled = true;
  try {
    const graph = workflow(), bindings = [];
    for (const row of $("bindings").children) {
      const [node, input, picker] = row.children;
      const file = picker.files[0];
      if (!file || !input.value) throw new Error("Every reference needs a file, node and input.");
      if (file.size > 512 * 1024 * 1024) throw new Error("A reference exceeds 512 MiB.");
      message(`Uploading ${file.name}…`);
      const uploaded = await api(`/assets?name=${encodeURIComponent(file.name)}`, undefined, { method: "POST", body: file });
      bindings.push({ node: node.value, input: input.value, asset: uploaded.asset });
    }
    const job = await api("/jobs", { graph, bindings, label: $("label").value });
    message(`Job ${job.id} recorded. You can continue working while it renders.`); await refresh();
  } finally { submitting = false; $("render").disabled = false; }
}));
function paintJobs(jobs) {
  const signature = JSON.stringify(jobs); if (signature === lastJobs) return; lastJobs = signature;
  $("jobs").replaceChildren();
  if (!jobs.length) { $("jobs").textContent = "No jobs yet. Finished media will appear here and in the local library."; return; }
  for (const job of jobs) {
    const row = document.createElement("article"); row.className = "job";
    const head = document.createElement("div"); head.className = "job-head";
    const name = document.createElement("strong"); name.textContent = job.label;
    const state = document.createElement("span"); state.className = "badge"; state.textContent = job.cancelRequested && !["completed", "cancelled", "failed"].includes(job.state) ? "Cancellation requested" : job.state;
    head.append(name, state); row.append(head);
    const date = document.createElement("small"); date.textContent = `${new Date(job.createdAt).toLocaleString()} · ${job.id}`; row.append(date);
    if (job.error) { const error = document.createElement("p"); error.className = "error-text"; error.textContent = job.error; row.append(error); }
    if (!["completed", "cancelled", "failed", "uncertain", "recording"].includes(job.state)) {
      const cancel = document.createElement("button"); cancel.className = "secondary"; cancel.textContent = "Cancel job";
      cancel.addEventListener("click", action(async () => { await api(`/jobs/${job.id}/cancel`, {}); message("Cancellation requested. Other jobs are unaffected."); await refresh(); })); row.append(cancel);
    }
    const results = document.createElement("div"); results.className = "outputs";
    for (const file of job.outputs || []) {
      const output = document.createElement("div"); output.className = "output";
      const url = `/api/runpod/jobs/${job.id}/files/${file.id}`;
      let preview;
      if (/\.(png|jpe?g|webp|gif)$/i.test(file.filename)) { preview = document.createElement("img"); preview.alt = file.filename; preview.loading = "lazy"; }
      else if (/\.(mp4|webm)$/i.test(file.filename)) { preview = document.createElement("video"); preview.controls = true; preview.preload = "metadata"; }
      else if (/\.(wav|mp3|flac|ogg|opus)$/i.test(file.filename)) { preview = document.createElement("audio"); preview.controls = true; preview.preload = "metadata"; }
      if (preview) { preview.src = url; output.append(preview); }
      const link = document.createElement("a"); link.href = url; link.download = file.filename; link.textContent = `Save ${file.filename}`; output.append(link); results.append(output);
    }
    row.append(results); $("jobs").append(row);
  }
}
async function refresh(initial = false) {
  const status = await api();
  if (initial) { $("url").value = status.url; $("connectionState").textContent = status.configured ? "Saved connection · click Connect to verify" : "Not configured"; }
  paintJobs(status.jobs);
}
refresh(true).catch(e => message(e.message, true));
setInterval(() => refresh().catch(() => {}), 2500);
