/** Optional fused YuE2 adapters. Metadata comes from /api/models, not a second
 * browser catalogue. Mount/refresh never downloads weights or selects a style. */
const basename = value => String(value || "").split(/[\\/]/).pop().toLowerCase();
const mounted = new WeakMap();

export function yue2StyleAdapterRows(catalog = []) {
  return catalog.flatMap(row => {
    const adapter = row?.styleAdapter || (row?.fused && row?.engine === "yue2-comfy" ? row : null);
    return adapter?.file ? [{ ...adapter, installed: row.installed === true || row.ready === true }] : [];
  });
}

const find = (file, rows) => rows.find(row => basename(row.file) === basename(file)) || null;
const refuse = (reason, message) => Object.assign(new Error(message), { reason });

/** An explicit selection changes both halves. Engine changes and refreshes do not. */
export function yue2StyleAdapterPatch(file, catalog, engine = "yue2-comfy") {
  const adapter = find(file, yue2StyleAdapterRows(catalog));
  if (file && !adapter) throw refuse("yue2-style-unknown", "This style adapter is not in the model catalogue.");
  if (adapter && engine !== "yue2-comfy") throw refuse("yue2-style-engine", "YuE2 style adapters require the ComfyUI engine; Python and GGUF do not support them.");
  return adapter ? { lora: adapter.file, loraClip: adapter.file,
    loraStrength: adapter.recipe?.audioStrength ?? 1, loraClipStrength: adapter.recipe?.plannerStrength ?? 1, cot: "full" }
    : { lora: "", loraClip: "" };
}

/** UI feedback only; the server validates the same fields before generation.
 * Retained Comfy preferences are inactive in native engines unless explicit. */
export function yue2StyleSelectionIssue({ engine, lora, loraClip, cot = "full", explicit = false } = {}, catalog = []) {
  const rows = yue2StyleAdapterRows(catalog), audio = find(lora, rows), planner = find(loraClip, rows);
  if (!audio && !planner) return null;
  if (engine !== "yue2-comfy") return explicit
    ? { reason: "yue2-style-engine", message: "YuE2 style adapters require the ComfyUI engine; Python and GGUF do not support them." } : null;
  if (!audio || !planner || audio.file !== planner.file) return { reason: "yue2-style-pair", message: "Choose the same style adapter for Audio LoRA and Planner LoRA." };
  if (cot !== "full") return { reason: "yue2-style-score", message: "This style adapter needs Thinking Full." };
  return null;
}

/** Injects a compact picker near the existing LoRA controls. onSelect receives
 * {lora,loraStrength,loraClip,loraClipStrength,cot} for one explicit selection;
 * the caller updates its state and persists the two preferences. Capture handlers
 * consume known fused choices before the form's individual LoRA save handlers.
 * refresh() should follow engine, model catalogue and LoRA shelf refreshes. */
export function mountYue2StyleAdapters({ document: doc = globalThis.document, root,
  getState = () => ({}), getEngine = () => getState().musicEngine,
  getAdapters = () => [], onSelect = () => {}, onError = () => {}, onChange = () => {} } = {}) {
  if (!doc) return null;
  const anchor = doc.getElementById("yLoraNote"), host = root || anchor?.parentElement;
  if (!host) return null;
  if (mounted.has(host)) return mounted.get(host);
  const el = id => doc.getElementById(id), controls = {
    audio: el("yLora"), planner: el("yLoraClip"), audioStrength: el("yLoraStrength"),
    plannerStrength: el("yLoraClipStrength"), cot: el("yCot"),
  };
  if (!controls.audio || !controls.planner || !controls.cot) return null;
  const row = doc.createElement("div"); row.id = "yStyleAdapterRow"; row.className = "params";
  row.setAttribute("data-comfy-yue", "");
  const label = doc.createElement("label"); label.htmlFor = "yStyleAdapter"; label.textContent = "Style adapter";
  const value = doc.createElement("span"); value.className = "pv";
  const pick = doc.createElement("select"); pick.id = "yStyleAdapter"; pick.className = "sel2";
  pick.title = "Optional ComfyUI adapters by becausereasons, licensed CC BY-NC 4.0 for noncommercial use only. Choosing one fills both LoRA slots and sets Thinking Full.";
  value.append(pick); row.append(label, value);
  const hint = doc.createElement("p"); hint.id = "yStyleAdapterHint"; hint.className = "hint tipsrc";
  hint.setAttribute("data-comfy-yue", ""); hint.setAttribute("role", "status"); hint.setAttribute("aria-live", "polite");
  const note = doc.createElement("span"), licence = doc.createElement("span");
  licence.className = "chip warn"; licence.textContent = "CC BY-NC";
  hint.append(note, doc.createTextNode(" "), licence);
  if (anchor && anchor.parentElement === host) anchor.before(row, hint); else host.append(row, hint);
  let busy = false, error = null, alive = true;
  const listeners = [];
  const listen = (target, kind, handler, capture = false) => {
    target?.addEventListener(kind, handler, capture); listeners.push([target, kind, handler, capture]);
  };
  const selection = () => ({ engine: getEngine(), lora: controls.audio.value || "",
    loraClip: controls.planner.value || "", cot: controls.cot.value || "full" });
  const onShelf = file => [controls.audio, controls.planner].every(control =>
    [...control.options].some(option => basename(option.value) === basename(file) && !option.disabled));
  function refresh() {
    if (!alive) return;
    const rows = yue2StyleAdapterRows(getAdapters()), current = selection(), adapter = find(current.lora, rows) || find(current.loraClip, rows);
    pick.replaceChildren();
    const option = (text, file, disabled = false) => {
      const item = doc.createElement("option"); item.value = file; item.textContent = text; item.disabled = disabled; pick.append(item);
    };
    option("none", "");
    for (const item of rows) {
      const available = onShelf(item.file);
      option(`${item.label}${available ? "" : item.installed ? " · refresh LoRAs" : " · download in Models"}`, item.file, !available);
    }
    pick.value = current.lora === current.loraClip && adapter ? adapter.file : "";
    pick.disabled = busy || current.engine !== "yue2-comfy";
    const issue = error || yue2StyleSelectionIssue(current, getAdapters());
    row.hidden = current.engine !== "yue2-comfy" && !error;
    hint.hidden = row.hidden || (!adapter && !issue);
    hint.className = issue ? "hint tipsrc warnhint" : "hint tipsrc";
    note.textContent = issue?.message || (adapter ? `Start Style with ${adapter.trigger}; both LoRA slots use this file with Thinking Full.` : "");
    note.title = adapter ? `${adapter.prompt}\n${adapter.caution}\nPublisher tests used the BF16 checkpoint; INT8 quality is unverified.` : "";
    licence.hidden = !adapter;
    licence.title = adapter ? `${adapter.licence || "CC BY-NC 4.0"}: noncommercial use only. ${adapter.outputRights?.attribution || "LoRAs by becausereasons"}. Songs made with this adapter are labelled not for sale. See Models for the publisher's terms.` : "";
  }
  function apply(patch) {
    controls.audio.value = patch.lora; controls.planner.value = patch.loraClip;
    for (const [control, key, output] of [[controls.audioStrength, "loraStrength", "yLoraStrengthValue"],
      [controls.plannerStrength, "loraClipStrength", "yLoraClipStrengthValue"]]) {
      if (control && patch[key] !== undefined) { control.value = String(Math.round(patch[key] * 100)); if (el(output)) el(output).textContent = Number(patch[key]).toFixed(2); }
    }
    if (patch.cot) controls.cot.value = patch.cot;
  }
  const snapshot = () => ({ lora: controls.audio.value, loraClip: controls.planner.value,
    loraStrength: Number(controls.audioStrength?.value ?? 100) / 100,
    loraClipStrength: Number(controls.plannerStrength?.value ?? 100) / 100, cot: controls.cot.value });
  async function select(file) {
    if (busy || !alive) return false;
    let before, disabled;
    try {
      const catalog = getAdapters(), patch = yue2StyleAdapterPatch(file, catalog, getEngine()), adapter = find(file, yue2StyleAdapterRows(catalog));
      if (adapter && !onShelf(adapter.file)) throw refuse("yue2-style-missing", "Download this adapter in Models, then refresh the LoRA shelf.");
      before = snapshot(); busy = true; error = null;
      disabled = Object.values(controls).filter(Boolean).map(control => [control, control.disabled]);
      for (const [control] of disabled) control.disabled = true;
      apply(patch); refresh();
      await onSelect(patch, adapter); onChange(patch, adapter); return true;
    } catch (cause) {
      if (before) apply(before);
      error = { reason: cause.reason || "yue2-style-save", message: String(cause.message || cause) };
      onError(cause); return false;
    } finally { if (disabled) for (const [control, wasDisabled] of disabled) control.disabled = wasDisabled; busy = false; refresh(); }
  }
  listen(pick, "change", () => { void select(pick.value); });
  for (const control of [controls.audio, controls.planner]) listen(control, "change", event => {
    if (!find(control.value, yue2StyleAdapterRows(getAdapters()))) { error = null; refresh(); return; }
    event.stopImmediatePropagation(); void select(control.value);
  }, true);
  listen(controls.cot, "change", () => { error = null; refresh(); });
  const api = { refresh, select, validate: request => yue2StyleSelectionIssue(request, getAdapters()),
    destroy() { alive = false; for (const [target, kind, handler, capture] of listeners) target?.removeEventListener(kind, handler, capture); row.remove(); hint.remove(); mounted.delete(host); } };
  mounted.set(host, api); refresh(); return api;
}
