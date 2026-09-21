const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => crypto.randomUUID();
const backendOptions = '<option value="yue2">YuE2 · Python · supplied score</option><option value="yue2-gguf">YuE2 · native GGUF · supplied score</option>';
const recipeFields = prefix => `<label>Style and instruments<textarea data-kit="${prefix}Style" rows="3" maxlength="2000"></textarea></label>
  <label>Lyrics<textarea data-kit="${prefix}Lyrics" rows="3" maxlength="8000"></textarea></label>
  <div class="mk-row"><label><input data-kit="${prefix}Instrumental" type="checkbox"> Request instrumental (Python only)</label>
  <label>Seed<input data-kit="${prefix}Seed" type="number" min="0" max="4294967295" value="831001"></label></div>
  <div class="mk-row"><label>Backend<select data-kit="${prefix}Engine">${backendOptions}</select></label><label>Precision<select data-kit="${prefix}Quant"></select></label></div>`;

/** All actions use the public API. onLoadRequest fills the existing composer;
 * only the explicit Render button invokes the persisted kit render action. */
export function mountMusicKits({ root, fetch: request = fetch, onLoadRequest } = {}) {
  if (!root || root.dataset.musicKitsMounted) return;
  root.dataset.musicKitsMounted = "1"; root.classList.add("music-kits");
  root.innerHTML = `<div class="mk-heading"><div><h3>Musical identity kits</h3><p>Save a theme, then develop its opening, tension and closing cues.</p></div><button type="button" data-act="refresh">Refresh</button></div>
  <p class="mk-notice">These are score and style recipes for new takes. They do not preserve an original singer or recording; instruments and audio length are not guaranteed.</p>
  <p class="mk-status" data-kit="status" role="status" aria-live="polite"></p>
  <label>Saved kit<select data-kit="pick"><option value="">Choose a kit…</option></select></label>
  <details class="mk-create"><summary>Save a new identity kit</summary>
    <div class="mk-grid"><label>Kit name<input data-kit="name" maxlength="120" placeholder="Episode theme"></label><label>Theme notes<input data-kit="theme" maxlength="2000" placeholder="Character, mood and musical identity"></label></div>
    <label>Score source<select data-kit="source"><option value="stored">A saved score version</option><option value="paste">Paste ABC notation</option></select></label>
    <div class="mk-row" data-kit="sourcePicks"><label>Score<select data-kit="sourceScore"></select></label><label>Version<select data-kit="sourceVersion"></select></label></div>
    <label>Theme score · ABC<textarea data-kit="sourceAbc" rows="7" spellcheck="false" readonly></textarea></label>
    <p class="mk-small">Use a short theme if desired. A saved version is copied exactly; its source is not changed.</p>
    ${recipeFields("source")}
    <button type="button" data-act="create">Save source as a kit</button>
  </details>
  <section data-kit="work" hidden>
    <div class="mk-heading"><h4 data-kit="title"></h4><span data-kit="revision" class="mk-small"></span></div>
    <p data-kit="themeNote"></p><div class="mk-variants" data-kit="variants"></div>
    <div class="mk-grid">
      <section class="mk-box"><h4>1 · Develop a variant</h4>
        <p class="mk-small">Based on <strong data-kit="baseName"></strong>. Saving adds a variant and leaves the source intact.</p>
        <div class="mk-row"><label>Cue<select data-kit="role"><option value="opening">Opening</option><option value="tension">Tension</option><option value="closing">Closing</option></select></label><label>Variant name<input data-kit="variantName" maxlength="120" placeholder="Opening · strings"></label></div>
        <label>What to keep<select data-kit="mode"><option value="keep_score">Keep score · request new instrumentation</option><option value="keep_melody">Keep melody · remove written chords</option><option value="revise">Revise composition · edit ABC explicitly</option></select></label>
        <p class="mk-small" data-kit="modeNote"></p>
        <label>Score<textarea data-kit="variantAbc" rows="7" spellcheck="false" readonly></textarea></label>
        ${recipeFields("variant")}
        <div class="mk-actions"><button type="button" data-act="preview">Check variant</button><button type="button" data-act="saveVariant">Save variant</button></div>
        <p data-kit="variantResult" class="mk-small"></p>
      </section>
      <section class="mk-box"><h4>2 · Review and generate</h4>
        <p class="mk-small">Selected saved variant: <strong data-kit="renderName"></strong>. Unsaved edits are not rendered.</p>
        <div class="mk-row"><label>Backend<select data-kit="renderEngine">${backendOptions}</select></label><label>Precision<select data-kit="renderQuant"></select></label><label>Seed<input data-kit="renderSeed" type="number" min="0" max="4294967295"></label></div>
        <p class="mk-small" data-kit="backendNote"></p>
        <button type="button" data-act="prepare">Build request for review</button>
        <div data-kit="review" hidden><p data-kit="requestSummary"></p><details><summary>Exact generation request</summary><pre data-kit="requestJson"></pre></details>
          <div class="mk-actions"><button type="button" data-act="load">Use in Music form</button><button type="button" class="mk-primary" data-act="render">Render this request</button></div></div>
        <h4>3 · Attach to an episode plan</h4>
        <label>Episode<select data-kit="episode"></select></label>
        <div class="mk-row"><label>Placement<select data-kit="scene"><option value="">Whole episode</option></select></label><label>Cue slot<select data-kit="slot"><option value="opening">Opening</option><option value="tension">Tension</option><option value="closing">Closing</option></select></label></div>
        <div class="mk-actions"><button type="button" data-act="attach">Attach selected variant</button><button type="button" data-act="detach">Remove cue link</button></div>
        <p class="mk-small">A local planning link. It does not send files, mix audio, or assign work to a friend.</p><div data-kit="cues"></div>
      </section>
    </div>
    <section class="mk-box"><h4>Listen and compare completed takes</h4><p class="mk-small">Use the recorded seed, score and model details for comparison. No listening verdict is inferred.</p><div data-kit="renders"></div></section>
    <details><summary>Saved source and model provenance</summary><pre data-kit="provenance"></pre></details>
  </section>`;
  const el = name => root.querySelector(`[data-kit="${name}"]`);
  const state = { kit: null, variantId: "theme", prepared: null, renderKey: null, source: null, plan: null, busy: false, engines: [] };
  const say = message => { el("status").textContent = message; };
  async function api(url, body) {
    const response = await request(url, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }
  const selected = () => state.kit?.variants.find(v => v.id === state.variantId);
  function controls() {
    for (const button of root.querySelectorAll("button")) button.disabled = state.busy;
    for (const input of root.querySelectorAll("input,select,textarea")) input.disabled = state.busy;
    for (const action of ["preview", "saveVariant", "prepare", "attach", "detach"]) root.querySelector(`[data-act="${action}"]`).disabled ||= !state.kit;
    root.querySelector('[data-act="render"]').disabled ||= !state.prepared;
    root.querySelector('[data-act="load"]').disabled ||= !state.prepared || !onLoadRequest;
    root.querySelector('[data-act="attach"]').disabled ||= !state.plan;
    root.querySelector('[data-act="detach"]').disabled ||= !state.plan;
  }
  function invalidate() { state.prepared = null; state.renderKey = null; el("review").hidden = true; controls(); }
  async function run(fn) {
    if (state.busy) return;
    state.busy = true; controls();
    try { await fn(); } catch (error) { say(error.message); }
    finally { state.busy = false; controls(); }
  }
  function precision(prefix, value) {
    const native = el(`${prefix}Engine`).value === "yue2-gguf";
    el(`${prefix}Quant`).innerHTML = native ? '<option value="q4_0">Q4</option><option value="q8_0">Q8</option>' : '<option value="none">BF16</option><option value="fp8">FP8 (supported NVIDIA cards)</option>';
    if ([...el(`${prefix}Quant`).options].some(o => o.value === value)) el(`${prefix}Quant`).value = value;
    if (prefix === "render") {
      const found = state.engines.find(e => e.id === el("renderEngine").value);
      el("backendNote").textContent = `${native ? "GGUF requires lyrics; it does not export a generated score. " : "Python YuE2 records a new score version when generation completes. "}${found?.ready === false ? found.reason || "Backend is not ready; check Models." : "Runtime availability is checked again before generation."}`;
    }
  }
  function fillRecipe(prefix, recipe) {
    for (const name of ["style", "lyrics", "seed", "engine"]) el(`${prefix}${name[0].toUpperCase()}${name.slice(1)}`).value = recipe[name] ?? "";
    el(`${prefix}Instrumental`).checked = !!recipe.instrumental; precision(prefix, recipe.quantization);
  }
  const readRecipe = prefix => ({ style: el(`${prefix}Style`).value, lyrics: el(`${prefix}Lyrics`).value,
    seed: Number(el(`${prefix}Seed`).value), engine: el(`${prefix}Engine`).value, quantization: el(`${prefix}Quant`).value,
    instrumental: el(`${prefix}Instrumental`).checked });
  function modeNote() {
    const mode = el("mode").value;
    el("variantAbc").readOnly = mode !== "revise";
    if (mode !== "revise" && selected()) el("variantAbc").value = selected().score.abc;
    el("modeNote").textContent = mode === "keep_melody" ? "Removes chord annotations only. Both written note lines and their timing remain; the model generates accompaniment from the new style."
      : mode === "keep_score" ? "Keeps the exact ABC bytes. Instrumentation and production changes are model requests, not guaranteed edits to existing audio." : "Edit a complete valid two-voice ABC score. The symbolic comparison will show the changed notes, chords and headers.";
  }
  function paintKit(fill = true) {
    const kit = state.kit, v = selected(); el("work").hidden = !kit; if (!kit || !v) return;
    el("title").textContent = kit.name; el("revision").textContent = `Revision ${kit.revision}`; el("themeNote").textContent = kit.theme;
    el("variants").innerHTML = kit.variants.map(item => `<button type="button" data-variant="${esc(item.id)}" class="${item.id === v.id ? "on" : ""}"><b>${esc(item.name)}</b><small>${esc(item.role)} · ${item.score.facts.bars_per_voice} bars · ${Math.round(item.score.facts.nominal_seconds)}s notation</small></button>`).join("");
    el("baseName").textContent = v.name; el("renderName").textContent = v.name;
    if (fill) {
      fillRecipe("variant", v.recipe); el("variantAbc").value = v.score.abc;
      el("variantName").value = ""; el("renderEngine").value = v.recipe.engine; precision("render", v.recipe.quantization); el("renderSeed").value = v.recipe.seed; modeNote();
    }
    el("provenance").textContent = JSON.stringify({ source: v.sourceScore, scoreHash: v.score.sha256, harmony: v.score.harmony, savedRecipe: v.recipe, sourceReceipt: v.sourceProvenance }, null, 2);
    el("renders").innerHTML = kit.renders.length ? [...kit.renders].reverse().map(r => `<article class="mk-take"><b>${esc(kit.variants.find(v => v.id === r.variantId)?.name || r.variantId)}</b><span>${esc(r.status)} · ${esc(r.request.engine)} · seed ${r.request.seed}</span><small>Job ${esc(r.jobId || "not confirmed")}${r.score ? ` · score ${esc(r.score.slug)}/${esc(r.score.version)}` : ""}</small>${r.error ? `<p>${esc(r.error)}</p>` : ""}${r.file ? `<audio controls preload="none" src="/api/audio/${encodeURIComponent(r.file)}"></audio>` : ""}<button type="button" data-refresh-job="${esc(r.id)}">Refresh this job</button></article>`).join("") : '<p class="mk-small">No takes have been submitted from this kit.</p>';
    controls();
  }
  async function refreshList() {
    const data = await api("/api/music-kits"); state.engines = data.engines || [];
    el("pick").innerHTML = '<option value="">Choose a kit…</option>' + data.kits.map(k => `<option value="${esc(k.id)}">${esc(k.name)} · ${k.variants} variants</option>`).join("");
    if (state.kit) el("pick").value = state.kit.id;
  }
  async function loadKit(id) {
    if (!id) return;
    const data = await api(`/api/music-kits?id=${encodeURIComponent(id)}`); state.kit = data.kit; state.engines = data.engines || [];
    if (!state.kit.variants.some(v => v.id === state.variantId)) state.variantId = "theme";
    invalidate(); paintKit(); say("Saved kit loaded. Choose a variant or develop a new one.");
  }
  async function sourceVersions() {
    state.source = null; const slug = el("sourceScore").value;
    if (!slug) { el("sourceVersion").innerHTML = '<option value="">No saved versions</option>'; return; }
    const data = await api("/api/score", { action: "read", slug, scores: false });
    el("sourceVersion").innerHTML = '<option value="">Choose a version…</option>' + data.versions.map(v => `<option value="${esc(v.id)}">${esc(v.label || v.id)}${v.audioSeconds ? ` · ${Math.round(v.audioSeconds)}s audio` : " · draft"}</option>`).join("");
  }
  async function sourceLoad() {
    state.source = null; const slug = el("sourceScore").value, version = el("sourceVersion").value; if (!slug || !version) return;
    const data = await api("/api/score", { action: "read", slug, version, scores: true }), row = data.versions[0];
    if (!row?.score?.text) throw new Error("This score's notation could not be read.");
    state.source = { slug, version }; el("sourceAbc").value = row.score.text;
    fillRecipe("source", { style: row.style || "", lyrics: row.lyrics || "", seed: row.seed ?? 831001, engine: "yue2", quantization: "none", instrumental: false });
    say(row.requestWarning || "Source score and available request metadata loaded. Review style and lyrics before saving.");
  }
  async function planLoad() {
    state.plan = null; el("cues").textContent = ""; const slug = el("episode").value;
    if (!slug) { el("scene").innerHTML = '<option value="">Whole episode</option>'; return; }
    const data = await api(`/api/collab/plan?slug=${encodeURIComponent(slug)}`); state.plan = data.plan;
    el("scene").innerHTML = '<option value="">Whole episode</option>' + data.plan.shots.map(s => `<option value="${esc(s.segmentId)}">${esc(s.title)}</option>`).join("");
    el("cues").innerHTML = (data.plan.musicCues || []).map(c => `<p class="mk-small">${esc(c.slot)} · ${esc(c.segmentId || "episode")} · ${esc(c.kitName)} / ${esc(c.variantName)}</p>`).join(""); controls();
  }
  async function refresh() {
    await refreshList();
    if (state.kit) await loadKit(state.kit.id);
    const results = await Promise.allSettled([api("/api/score"), api("/api/mv/projects")]);
    if (results[0].status === "fulfilled") {
      const previous = el("sourceScore").value;
      el("sourceScore").innerHTML = '<option value="">Choose a score…</option>' + results[0].value.scores.map(s => `<option value="${esc(s.slug)}">${esc(s.title || s.slug)}</option>`).join("");
      if (previous) el("sourceScore").value = previous;
    }
    if (results[1].status === "fulfilled") {
      const previous = el("episode").value;
      el("episode").innerHTML = '<option value="">Choose an episode…</option>' + results[1].value.projects.map(p => `<option value="${esc(p.slug)}">${esc(p.title || p.slug)}</option>`).join("");
      if (previous) el("episode").value = previous;
    }
    const failed = results.filter(r => r.status === "rejected"); if (failed.length) say(failed.map(r => r.reason.message).join(" · "));
  }
  const variantBody = action => ({ action, id: state.kit.id, expectedRevision: state.kit.revision, baseVariantId: state.variantId,
    role: el("role").value, name: el("variantName").value || el("role").value, mode: el("mode").value,
    ...(el("mode").value === "revise" ? { abc: el("variantAbc").value } : {}), ...readRecipe("variant") });
  const actions = {
    refresh,
    async create() {
      const source = el("source").value === "stored" ? { sourceScore: state.source } : { abc: el("sourceAbc").value };
      if (el("source").value === "stored" && !state.source) throw new Error("Choose and load an exact score version first, or paste ABC.");
      const data = await api("/api/music-kits", { action: "create", idempotencyKey: uid(), name: el("name").value, theme: el("theme").value, ...source, ...readRecipe("source") });
      state.kit = data.kit; state.variantId = "theme"; invalidate(); paintKit(); await refreshList(); say("Identity kit saved. Source score unchanged; no audio generated.");
    },
    async preview() {
      const data = await api("/api/music-kits", variantBody("preview_variant")), v = data.variant;
      el("variantResult").textContent = `${v.note} ${v.score.facts.bars_per_voice} bars; ${Math.round(v.score.facts.nominal_seconds)}s notation. Notes identical: ${Object.entries(v.changes.voices).map(([name, value]) => `${name} ${value.notes_identical ? "yes" : "no"}`).join(", ")}.`;
      say("Variant checked. Nothing saved or rendered.");
    },
    async saveVariant() {
      const data = await api("/api/music-kits", { ...variantBody("save_variant"), idempotencyKey: uid() });
      state.kit = data.kit; state.variantId = data.kit.variants.at(-1).id; invalidate(); paintKit(); await refreshList(); say("Variant saved. Build its request when ready to review a new take.");
    },
    async prepare() {
      const data = await api("/api/music-kits", { action: "prepare", id: state.kit.id, expectedRevision: state.kit.revision, variantId: state.variantId,
        engine: el("renderEngine").value, quantization: el("renderQuant").value, seed: Number(el("renderSeed").value) });
      state.kit = data.kit; state.prepared = data.prepared; state.renderKey = uid(); paintKit(false);
      el("requestSummary").textContent = `${data.prepared.request.engine} · ${data.prepared.request.quantization} · seed ${data.prepared.request.seed} · ${Math.round(data.prepared.notationSeconds)}s notation. This request makes a new take. Nothing queued yet.`;
      el("requestJson").textContent = JSON.stringify(data.prepared.request, null, 2); el("review").hidden = false; say("Exact request ready for review. Render is a separate action.");
    },
    async load() { if (state.prepared && onLoadRequest) { await onLoadRequest(structuredClone(state.prepared.request)); say("Request copied to the Music form. Nothing generated; changes there are a separate request."); } },
    async render() {
      if (!state.prepared) return;
      const data = await api("/api/music-kits", { action: "render", id: state.kit.id, expectedRevision: state.kit.revision,
        preparedId: state.prepared.id, idempotencyKey: state.renderKey });
      state.kit = data.kit; invalidate(); paintKit(false); say(data.render.jobId ? `Submitted exact job ${data.render.jobId}. Use Refresh this job to follow it.` : data.note || data.render.error);
    },
    async attach() { await cue(selected()); }, async detach() { await cue(null); },
  };
  async function cue(variant) {
    if (!state.plan) throw new Error("Choose an episode first.");
    const data = await api("/api/collab/plan", { action: "set_music_cue", slug: state.plan.slug, expectedRevision: state.plan.revision,
      slot: el("slot").value, segmentId: el("scene").value || null,
      musicKit: variant ? { kitId: state.kit.id, variantId: variant.id, variantHash: variant.hash } : null });
    state.plan = data.plan; await planLoad(); say(variant ? "Variant linked to the local episode plan. No files sent or audio mixed." : "Local cue link removed.");
  }
  root.addEventListener("click", event => {
    const button = event.target.closest("button"); if (!button || !root.contains(button)) return;
    if (button.dataset.variant) return run(async () => { state.variantId = button.dataset.variant; invalidate(); paintKit(); });
    if (button.dataset.refreshJob) return run(async () => {
      const data = await api("/api/music-kits", { action: "refresh_job", id: state.kit.id, renderId: button.dataset.refreshJob });
      state.kit = data.kit; invalidate(); paintKit(false); say("Exact job record refreshed.");
    });
    if (actions[button.dataset.act]) run(actions[button.dataset.act]);
  });
  root.addEventListener("change", event => {
    const name = event.target.dataset.kit;
    if (name === "pick") return run(() => loadKit(el("pick").value));
    if (name === "sourceScore") return run(sourceVersions);
    if (name === "sourceVersion") return run(sourceLoad);
    if (name === "episode") return run(planLoad);
    if (name === "source") { state.source = null; el("sourceAbc").readOnly = el("source").value === "stored"; el("sourcePicks").hidden = el("source").value !== "stored"; }
    if (name === "mode") modeNote();
    for (const prefix of ["source", "variant", "render"]) if (name === `${prefix}Engine`) precision(prefix);
  });
  root.addEventListener("input", event => { if (event.target.dataset.kit) invalidate(); });
  for (const prefix of ["source", "variant", "render"]) precision(prefix);
  controls(); run(refresh);
  return { refresh: () => run(refresh) };
}
