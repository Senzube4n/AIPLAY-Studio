const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const live = state => ["queued", "running", "composing", "cancelling", "dispatching"].includes(state);

export async function mountMusicArtifacts({ root, fetch: request = globalThis.fetch.bind(globalThis) }) {
  if (root.dataset.musicArtifactsMounted) return;
  root.dataset.musicArtifactsMounted = "true";
  root.classList.add("music-artifacts");
  root.innerHTML = `<p class="mf-intro">Start again from a saved stage. Keep the composition, reuse the performance tokens, or decode the same sound. Every replay creates a new take and retains the original.</p>
    <div class="mf-grid"><section class="mf-card"><h3>1 · Choose what to reuse</h3>
      <div class="mf-line"><label>Original Python YuE2 song<select data-mf="source"><option value="">Loading…</option></select></label><button type="button" data-mf="refresh">Refresh</button></div>
      <button type="button" data-mf="inspect">Check saved stages</button><p data-mf="inspection">Saved files are checked before preparation and again before rendering.</p>
      <label>Start from<select data-mf="stage"><option value="latent">Saved sound · decode only</option><option value="semantic">Performance tokens · synthesize and decode</option><option value="plan">Composition · new performance</option></select></label>
      <p data-mf="explanation"></p>
      <div data-mf="synthesis" class="mf-line" hidden><label>Seed<input type="number" min="0" max="9007199254740991" step="1" data-mf="seed" value="0"></label>
      <label>Synthesis steps<select data-mf="steps"><option value="32">32</option><option value="16">16</option></select></label></div>
      <details><summary>Decoder setting</summary><label>Frames per tile<select data-mf="tiles"><option value="512">512 · default</option><option value="256">256</option><option value="1024">1024</option></select></label>
        <small>Uses the installed listening VAE. Tile size can change memory use and boundary arithmetic; it is not a quality guarantee.</small></details>
      <button type="button" data-mf="prepare" disabled>Prepare request · no render</button>
      <details><summary>Verified source details</summary><pre data-mf="details"></pre></details>
    </section><section class="mf-card"><h3>2 · Review and render</h3>
      <label>Saved requests<select data-mf="saved"><option value="">Choose a prepared request…</option></select></label>
      <div data-mf="review"><p>Prepare a request to see exactly which stages will run.</p></div>
      <div class="mf-line"><button type="button" class="primary" data-mf="render" disabled>Render reviewed replay</button><button type="button" data-mf="cancel" disabled>Cancel this replay</button></div>
      <div class="mf-audio"><label>Original<audio data-mf="original" controls preload="none"></audio></label><label>New take<audio data-mf="candidate" controls preload="none"></audio></label></div>
      <p data-mf="result"></p><details><summary>Actual job and stage timings</summary><pre data-mf="job"></pre></details>
    </section></div><p data-mf="message" role="status" aria-live="polite"></p>`;
  const $ = name => root.querySelector(`[data-mf="${name}"]`);
  let inspected = null, prepared = null, rows = [], busy = false, timer, sourceTicket = 0, statusTicket = 0, disposed = false;
  const say = text => { $("message").textContent = text || ""; };
  async function api(body, query = "") {
    const response = await request(`/api/music-artifacts${query}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const data = await response.json(); if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`); return data;
  }
  function explain() {
    const stage = $("stage").value;
    $("synthesis").hidden = stage === "latent";
    $("explanation").textContent = stage === "latent" ? "Reuses the exact saved acoustic latents. Only the listening decoder runs; the composition and performance are not regenerated."
      : stage === "semantic" ? "Reuses the exact plan and performance tokens. The acoustic solver and decoder run again; changing the seed can change the sound."
      : "Reuses the exact saved composition, words and style. A new performance is generated, then synthesized and decoded. Its timing and sound can differ.";
    buttons();
  }
  function buttons() {
    $("inspect").disabled = busy || !$("source").value;
    $("prepare").disabled = busy || !inspected || inspected.source !== $("source").value;
    $("render").disabled = busy || prepared?.state !== "prepared";
    $("cancel").disabled = busy || !prepared || !["prepared", "queued", "running", "composing", "cancelling"].includes(prepared.state);
  }
  function invalidate() { ++sourceTicket; ++statusTicket; prepared = null; clearTimeout(timer); $("saved").value = ""; $("review").textContent = "Settings changed. Prepare and review a new request before rendering."; buttons(); }
  function show() {
    clearTimeout(timer); if (!prepared) return;
    const p = prepared, names = { semantic: "Performance generation", synthesis: "Acoustic synthesis", decode: "Listening decoder" };
    $("review").innerHTML = `<p><strong>${escapeHtml(p.source)}</strong></p><p class="mf-state">${escapeHtml(p.state)}</p>
      <p>Reuse: ${p.stages.reuse.map(escapeHtml).join(" → ")}</p><p>Run: ${p.stages.run.map(s => escapeHtml(names[s] || s)).join(" → ")}</p>
      <p>Seed ${p.options.seed}${p.stage === "latent" ? " · retained" : ` · ${p.options.narSteps} synthesis steps`} · ${p.options.vaeCoreFrames} decoder frames per tile</p>
      <small>Original retained. Python YuE2 0.1.6 and verified model identities. No measured speedup is assumed.</small>
      <details><summary>Frozen source identity</summary><code>${escapeHtml(p.sourceIdentity)}</code><small>Request hash: ${escapeHtml(p.manifestSha256)}</small></details>`;
    const originalUrl = `/api/audio/${encodeURIComponent(p.source)}`;
    if ($("original").getAttribute("src") !== originalUrl) $("original").src = originalUrl;
    const file = p.job?.file;
    if (file && p.state === "done") { const url = `/api/audio/${encodeURIComponent(file)}`; if ($( "candidate").getAttribute("src") !== url) $("candidate").src = url; }
    else $("candidate").removeAttribute("src");
    $("result").textContent = p.error || p.cancelError || (file && p.state === "done" ? `Saved as ${file}. Listen before judging the result.` : p.jobId ? `Following job ${p.jobId}.` : "This request has not rendered yet.");
    $("job").textContent = p.job ? JSON.stringify(p.job, null, 2) : "No job submitted.";
    buttons();
    if (live(p.state) && !p.error && !disposed) timer = setTimeout(() => status(p.id).catch(e => say(e.message)), 2500);
  }
  async function status(id) {
    const ticket = ++statusTicket, data = await api({ action: "status", preparedId: id });
    if (disposed || ticket !== statusTicket) return;
    prepared = data.prepared; show();
  }
  async function refresh() {
    const data = await api(); if (disposed) return;
    const selected = $("source").value;
    $("source").innerHTML = '<option value="">Choose a saved Python YuE2 song…</option>' + data.sources.map(s => `<option value="${escapeHtml(s.file)}">${escapeHtml(s.title || s.file)}</option>`).join("");
    $("source").value = data.sources.some(s => s.file === selected) ? selected : data.sources[0]?.file || "";
    rows = data.prepared;
    $("saved").innerHTML = '<option value="">Choose a prepared request…</option>' + rows.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.source)} · ${escapeHtml(p.stage)} · ${escapeHtml(p.state)}</option>`).join("");
    if (prepared) $("saved").value = prepared.id;
    if (!data.sources.length) say("No saved Python YuE2 performances are available. Native GGUF and Comfy runs use different artifact formats.");
    buttons();
  }
  for (const name of ["stage", "seed", "steps", "tiles"]) $(name).addEventListener("change", () => { invalidate(); explain(); });
  $("source").addEventListener("change", () => { invalidate(); inspected = null; $("details").textContent = ""; $("inspection").textContent = "Check this source's saved stages."; buttons(); });
  $("saved").addEventListener("change", async () => {
    clearTimeout(timer); ++statusTicket; prepared = null; buttons();
    const id = $("saved").value;
    $("review").textContent = id ? "Loading the selected saved request…" : "Choose a saved request or prepare a new one.";
    if (!id) return;
    try { await status(id); } catch (e) { say(e.message); }
  });
  for (const action of ["refresh", "inspect", "prepare", "render", "cancel"]) $(action).addEventListener("click", async () => {
    if (busy) return; busy = true; buttons();
    try {
      if (action === "refresh") await refresh();
      if (action === "inspect") {
        const source = $("source").value, ticket = ++sourceTicket;
        say("Verifying saved files and runtime identities…"); const data = await api({ action: "inspect", source });
        if (ticket !== sourceTicket || source !== $("source").value) return;
        inspected = data.inspection; $("seed").value = inspected.request.seed; $("steps").value = inspected.generation.ode_steps === 16 ? "16" : "32";
        $("inspection").textContent = `${inspected.audioSeconds.toFixed(2)} seconds · saved artifacts verified${Object.values(inspected.truncated || {}).some(Boolean) ? " · source has a truncation flag" : ""}.`;
        $("details").textContent = JSON.stringify({ identity: inspected.identity, runtime: inspected.runtime, files: inspected.files, weights: inspected.weights }, null, 2);
        say("Source verified. Choose a stage and prepare a request.");
      }
      if (action === "prepare") {
        const ticket = ++sourceTicket, stage = $("stage").value;
        const data = await api({ action: "prepare", source: $("source").value, stage, vaeCoreFrames: Number($("tiles").value),
          ...(stage === "latent" ? {} : { seed: Number($("seed").value), narSteps: Number($("steps").value) }) });
        if (ticket !== sourceTicket) { say("A request was saved, but the form changed. Find it in saved requests; it was not rendered."); return; }
        prepared = data.prepared; ++statusTicket; show(); await refresh(); say("Review the stages above. Nothing has rendered yet.");
      }
      if (action === "render" || action === "cancel") {
        const id = prepared?.id; if (!id) return;
        const data = await api({ action, preparedId: id });
        if (prepared?.id === id) { prepared = data.prepared; ++statusTicket; show(); }
        say(action === "render" ? "Replay submitted to the normal music queue." : "Cancellation processed for this request only.");
      }
    } catch (e) { say(e.message); } finally { busy = false; buttons(); }
  });
  explain(); await refresh();
  return { refresh, destroy() { disposed = true; ++sourceTicket; ++statusTicket; clearTimeout(timer); $("original").pause(); $("candidate").pause(); } };
}
