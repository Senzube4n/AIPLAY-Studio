/** Optional controls inside Video's More controls. No startup downloads or default patches. */
import { appAlert } from "./dialog.js";

const post = async (body) => {
  const result = await (await fetch("/api/h3-refmods", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  if (result.error) throw new Error(result.error);
  return result;
};

export function mountH3RefMods(host, { getEngine = () => "h3", getImages = () => [], onChange = () => {} } = {}) {
  if (!host) return { spec: () => ({}), paint: () => {}, refresh: async () => {} };
  host.innerHTML = `<details class="more" id="h3RefModControls" hidden>
    <summary>Reference caches &amp; tweaks</summary>
    <div class="cta"><span class="chip" id="h3CacheStatus">Unchecked</span><button type="button" class="btn2" id="h3CacheCheck">Check nodes</button></div>
    <div class="params"><label for="h3CachePick">cache</label><span class="pv"><select class="sel2" id="h3CachePick"><option value="">Choose cache</option></select><button type="button" class="edtool" id="h3CacheAdd" disabled>Add</button></span></div>
    <div class="params" id="h3CacheRows"></div>
    <details class="more"><summary>Cache controls</summary>
      <div class="params"><label for="h3CacheRetention">retention</label><span class="pv"><input class="in2 num" id="h3CacheRetention" type="number" min="0" max="1" step="0.05" value="1"></span>
        <label for="h3CacheBudget">token budget</label><span class="pv"><input class="in2 num" id="h3CacheBudget" type="number" min="1" max="65536" step="512" value="8192"></span></div>
      <p class="hint">Caches retain reference latents; compressed caches can lose facial detail.</p>
    </details>
    <details class="more"><summary>Create cache</summary>
      <div class="params"><label for="h3CacheName">name</label><span class="pv"><input class="in2" id="h3CacheName" maxlength="100" placeholder="character_cache"></span>
        <label for="h3CacheMode">mode</label><span class="pv"><select class="sel2" id="h3CacheMode"><option value="encode">Full reference</option><option value="training">Compressed reference</option></select></span>
        <label for="h3CacheResolution">resolution</label><span class="pv"><select class="sel2" id="h3CacheResolution"><option>256</option><option selected>512</option><option>768</option><option>1024</option></select></span>
        <label for="h3CachePool">latent grid</label><span class="pv"><select class="sel2" id="h3CachePool"><option>8</option><option>16</option><option selected>32</option><option>64</option></select></span>
        <label for="h3CacheRefine">refinement steps</label><span class="pv"><input class="in2 num" id="h3CacheRefine" type="number" min="0" max="500" step="50" value="0"></span></div>
      <p class="hint">Uses 1 to 8 pictures from this clip's reference slots.</p>
      <div class="cta"><button type="button" class="btn2" id="h3CacheCreate" disabled>Cache references</button></div>
    </details>
    <details class="more"><summary>Fizgig tweaks</summary>
      <span class="chip" id="h3TweaksStatus">Unchecked</span>
      <div class="params"><label for="h3TweakDetail">detail &amp; contrast</label><span class="pv"><input class="in2 num" id="h3TweakDetail" type="number" min="-1" max="1" step="0.05" value="0"></span>
        <label for="h3TweakMode">detail mode</label><span class="pv"><select class="sel2" id="h3TweakMode"><option>stable across frames</option><option>per frame</option></select></span>
        <label for="h3TweakScene">scene variation</label><span class="pv"><input class="in2 num" id="h3TweakScene" type="number" min="-0.5" max="0.5" step="0.05" value="0"></span>
        <label for="h3TweakPrompt">prompt strength</label><span class="pv"><input class="in2 num" id="h3TweakPrompt" type="number" min="-0.5" max="3" step="0.05" value="0"></span></div>
      <p class="hint">Experimental; all dials start off.</p>
    </details>
    <details class="more"><summary>Sources &amp; limits</summary>
      <p class="hint">Identity transfer remains unverified for these cache and tweak settings.</p>
      <a href="https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod" target="_blank" rel="noopener noreferrer">RefMod source</a>
      <a href="https://github.com/shootthesound/ComfyUI-Fizgig-H3-Tweaks" target="_blank" rel="noopener noreferrer">Fizgig source</a>
    </details>
  </details>`;
  const find = (id) => host.querySelector(`#${id}`);
  const rows = [];
  let status = null, busy = false;
  function chip(id, text, tone) { const el = find(id); el.textContent = text; el.className = `chip ${tone || ""}`; }
  function paintRows() {
    const container = find("h3CacheRows");
    container.replaceChildren();
    rows.forEach((row, index) => {
      const label = document.createElement("label"); label.textContent = `cache ${index + 1}`; label.htmlFor = `h3CacheStrength${index}`;
      const value = document.createElement("span"); value.className = "pv";
      const name = document.createElement("span"); name.textContent = row.name; name.title = row.name;
      const strength = document.createElement("input"); Object.assign(strength, { id: label.htmlFor, className: "in2 num", type: "number", min: "0", max: "1", step: "0.05", value: row.strength });
      strength.title = "Reference strength"; strength.setAttribute("aria-label", `${row.name} strength`);
      strength.addEventListener("change", () => { row.strength = Number(strength.value); onChange(); });
      const copies = document.createElement("input"); Object.assign(copies, { className: "in2 num", type: "number", min: "1", max: "4", step: "1", value: row.copies });
      copies.title = "Copies. Each copy adds its full token cost."; copies.setAttribute("aria-label", `${row.name} copies`);
      copies.addEventListener("change", () => { row.copies = Number(copies.value); onChange(); });
      const remove = document.createElement("button"); Object.assign(remove, { className: "edtool", type: "button", textContent: "Remove" });
      remove.addEventListener("click", () => { rows.splice(index, 1); paintRows(); paint(); onChange(); });
      value.append(name, strength, copies, remove); container.append(label, value);
    });
  }
  function paint() {
    find("h3RefModControls").hidden = getEngine() !== "h3";
    find("h3CacheAdd").disabled = busy || !status?.ready || !find("h3CachePick").value || rows.length >= 8;
    find("h3CacheCreate").disabled = busy || !status?.canCreate;
    const compressed = find("h3CacheMode").value === "training";
    find("h3CachePool").disabled = !compressed; find("h3CacheRefine").disabled = !compressed;
    for (const id of ["h3TweakDetail", "h3TweakScene", "h3TweakPrompt", "h3TweakMode"]) find(id).disabled = !status?.fizgigReady;
  }
  async function refresh() {
    if (busy) return;
    busy = true; chip("h3CacheStatus", "Checking", "busy"); paint();
    try {
      status = await post({ action: "status" });
      chip("h3CacheStatus", status.ready ? "RefMod ready" : status.engineReachable ? "RefMod missing" : "Engine unavailable", status.ready ? "ok" : "warn");
      chip("h3TweaksStatus", status.fizgigReady ? "Fizgig ready" : "Fizgig missing", status.fizgigReady ? "ok" : "warn");
      find("h3CacheStatus").title = status.note || "";
      const select = find("h3CachePick"), keep = select.value;
      select.replaceChildren(new Option("Choose cache", ""));
      for (const entry of status.entries || []) {
        if (!entry.available || entry.references?.some((reference) => reference.kind === "audio")) continue;
        const option = new Option(`${entry.name} (${entry.tokens} tokens)`, entry.name);
        option.title = entry.description || ""; select.add(option);
      }
      select.value = keep;
    } catch (err) { chip("h3CacheStatus", "Could not check", "err"); find("h3CacheStatus").title = err.message; }
    finally { busy = false; paint(); }
  }
  function spec() {
    if (getEngine() !== "h3") return {};
    const retention = Number(find("h3CacheRetention").value);
    const activeRows = retention === 0 ? [] : rows.filter((row) => row.strength !== 0);
    const detail = Number(find("h3TweakDetail").value), composition = Number(find("h3TweakScene").value), promptStrength = Number(find("h3TweakPrompt").value);
    return { ...(activeRows.length ? { refMods: activeRows.map((row) => ({ ...row })), refModOptions: { retention, maxTokens: Number(find("h3CacheBudget").value) } } : {}),
      ...(detail || composition || promptStrength ? { h3Tweaks: { detail, composition, promptStrength, detailMode: find("h3TweakMode").value } } : {}) };
  }
  find("h3CacheCheck").addEventListener("click", refresh);
  find("h3RefModControls").addEventListener("toggle", () => { if (find("h3RefModControls").open && !status) void refresh(); });
  find("h3CachePick").addEventListener("change", paint);
  find("h3CacheMode").addEventListener("change", paint);
  find("h3CacheAdd").addEventListener("click", () => {
    const name = find("h3CachePick").value;
    if (!name || rows.length >= 8) return;
    rows.push({ name, strength: 1, copies: 1 }); paintRows(); paint(); onChange();
  });
  for (const id of ["h3CacheRetention", "h3CacheBudget", "h3TweakDetail", "h3TweakScene", "h3TweakPrompt", "h3TweakMode"]) find(id).addEventListener("change", onChange);
  find("h3CacheCreate").addEventListener("click", async () => {
    const images = getImages().map((image) => typeof image === "string" ? image : image.name).filter(Boolean);
    if (!images.length || images.length > 8) { await appAlert("Choose 1 to 8 pictures in the reference slots."); return; }
    busy = true; paint();
    try {
      await post({ action: "create", name: find("h3CacheName").value.trim(), images, mode: find("h3CacheMode").value,
        resolution: Number(find("h3CacheResolution").value), pool: Number(find("h3CachePool").value), refinementSteps: Number(find("h3CacheRefine").value), maxTokens: Number(find("h3CacheBudget").value) });
      chip("h3CacheStatus", "Cache queued", "busy");
    } catch (err) { await appAlert(err.message); }
    finally { busy = false; paint(); }
  });
  window.addEventListener("aiplay-refmod-ready", refresh);
  paint();
  return { spec, paint, refresh };
}
