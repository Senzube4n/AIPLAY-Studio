const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const uid = () => crypto.randomUUID();
const busyTake = t => ["submitting", "queued", "running", "cancelling"].includes(t.state);

/** The browser labels audio; it does not judge it or silently submit a render. */
export function mountMusicListeningLab({ root, fetch: request = fetch } = {}) {
  if (!root || root.dataset.listeningLabMounted) return;
  root.dataset.listeningLabMounted = "true"; root.classList.add("music-listening-lab");
  root.innerHTML = `<div class="ml-head"><div><h3>Listen before choosing an adapter</h3><p>Matched base / LoRA renders. Your ears supply the result.</p></div><button data-ml-action="refresh">Refresh installed choices</button></div>
    <p class="ml-note">This uses the installed ComfyUI YuE2 MODEL adapter path. Python and native GGUF adapter inference are not offered. A new take does not preserve a singer or source waveform; loss is not a quality score.</p>
    <p data-ml="capability" role="status">Checking installed adapters and runtime…</p>
    <details class="ml-create" open><summary>1 · Design an experiment</summary><div class="ml-grid">
    <section><h4>Training material</h4><label>Experiment name<input data-ml="name" maxlength="120" placeholder="Held-out chorus comparison"></label>
    <label>What are you evaluating?<textarea data-ml="purpose" rows="2" maxlength="2000" placeholder="For example: clearer consonants without losing the accompaniment"></textarea></label>
    <label>Installed trained adapter<select data-ml="adapter"></select></label><p data-ml="trainingEvidence" class="ml-note"></p>
    <label>Checkpoint<select data-ml="checkpoint"></select></label><label>Adapter strength<input data-ml="strength" type="number" min="-4" max="4" step=".05" value="1"></label>
    <label>Recording used for training<select data-ml="trainingFile"></select></label><audio data-ml="trainingAudio" controls preload="none"></audio>
    <div class="ml-row"><label>Region start · s<input data-ml="trainingStart" type="number" min="0" step=".01" value="0"></label><label>Region length · s<input data-ml="trainingSeconds" type="number" min=".25" step=".01" value="24"></label></div>
    <button data-ml-action="playTraining">Listen to training region</button><p class="ml-note">Without a matching recorded training receipt, this region is saved as your declaration. It is never relabelled as verified training.</p></section>
    <section><h4>Separate evaluation cases</h4><p class="ml-note">Use held-out prompts and lyrics. An optional comparison recording must not overlap the training region. It is for listening only, not model conditioning.</p>
    <div data-ml="caseDrafts"></div><button data-ml-action="addCase">Add evaluation case</button></section></div>
    <button class="ml-primary" data-ml-action="create">Save experiment for review · no rendering</button></details>
    <section class="ml-review"><div class="ml-row"><label>Saved experiment<select data-ml="saved"><option value="">Choose an experiment…</option></select></label><button data-ml-action="load">Open</button></div>
    <div data-ml="review"><p>Save or open an experiment to review its paired settings.</p></div></section>
    <p data-ml="status" role="status" aria-live="polite"></p>`;
  const $ = name => root.querySelector(`[data-ml="${name}"]`);
  let caps = {}, libraries = [], current = null, pending = false, disposed = false, timer, createKey = uid(), startKey = uid(), epoch = 0;
  const drafts = [{ name: "Evaluation 1", caption: "", lyrics: "", seed: 831001, maxDuration: 60, narSteps: 32, cot: "full", instrumental: false }];
  const ratings = new Map(); let trainingEnd = Infinity;
  const say = text => { $("status").textContent = text; };
  async function json(url, body) {
    const r = await request(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    const data = await r.json(); if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`); return data;
  }
  const api = body => json("/api/music-listening-lab", body);
  const options = (rows, field = "name") => '<option value="">Choose…</option>' + rows.map(row => `<option value="${esc(row[field])}">${esc(row.title || row.name || row.file)}</option>`).join("");
  function controls() {
    for (const button of root.querySelectorAll("button")) button.disabled = pending;
    root.querySelector('[data-ml-action="create"]').disabled ||= !caps.ready || !caps.adapters?.length;
    root.querySelector('[data-ml-action="addCase"]').disabled ||= drafts.length >= 8;
    const start = root.querySelector('[data-ml-action="start"]'); if (start) start.disabled ||= !!current?.submission || current?.cancelRequested;
    const reveal = root.querySelector('[data-ml-action="reveal"]'); if (reveal) reveal.disabled ||= current?.revealed;
    for (const button of root.querySelectorAll('[data-ml-action="rate"]')) button.disabled ||= current?.takes.filter(t => t.caseId === button.dataset.case).some(t => t.state !== "ready");
  }
  function collectDrafts() {
    for (const card of root.querySelectorAll("[data-eval-index]")) {
      const d = drafts[+card.dataset.evalIndex], input = key => card.querySelector(`[data-eval="${key}"]`);
      for (const field of ["name", "caption", "lyrics", "cot"]) d[field] = input(field).value;
      for (const field of ["seed", "maxDuration", "narSteps"]) d[field] = Number(input(field).value);
      d.instrumental = input("instrumental").checked;
      d.reference = input("referenceFile").value ? { file: input("referenceFile").value, startSeconds: Number(input("referenceStart").value), seconds: Number(input("referenceSeconds").value) } : undefined;
    }
  }
  function paintDrafts() {
    $("caseDrafts").innerHTML = drafts.map((d, i) => `<article class="ml-case" data-eval-index="${i}"><div class="ml-row"><b>Case ${i + 1}</b>${i ? `<button data-ml-action="removeCase" data-index="${i}">Remove</button>` : ""}</div>
      <label>Name<input data-eval="name" value="${esc(d.name)}" maxlength="120"></label><label>Evaluation style<textarea data-eval="caption" rows="2" maxlength="2000">${esc(d.caption)}</textarea></label>
      <label>Evaluation lyrics<textarea data-eval="lyrics" rows="3" maxlength="8000">${esc(d.lyrics)}</textarea></label>
      <label class="ml-check"><input data-eval="instrumental" type="checkbox" ${d.instrumental ? "checked" : ""}> Instrumental · clear lyrics first</label>
      <div class="ml-row"><label>Matched seed<input data-eval="seed" type="number" min="0" max="4294967295" step="1" value="${d.seed}"></label><label>Duration ceiling · s<input data-eval="maxDuration" type="number" min="30" max="300" value="${d.maxDuration}"></label></div>
      <div class="ml-row"><label>Solver steps<input data-eval="narSteps" type="number" min="8" max="64" value="${d.narSteps}"></label><label>Planning<select data-eval="cot">${["full", "melody", "off"].map(v => `<option ${v === d.cot ? "selected" : ""}>${v}</option>`).join("")}</select></label></div>
      <details><summary>Optional held-out listening reference</summary><label>Recording<select data-eval="referenceFile">${options(libraries, "file")}</select></label><div class="ml-row"><label>Start · s<input data-eval="referenceStart" type="number" min="0" value="${d.reference?.startSeconds || 0}"></label><label>Length · s<input data-eval="referenceSeconds" type="number" min=".25" value="${d.reference?.seconds || 15}"></label></div></details></article>`).join("");
    for (const card of root.querySelectorAll("[data-eval-index]")) card.querySelector('[data-eval="referenceFile"]').value = drafts[+card.dataset.evalIndex].reference?.file || "";
    controls();
  }
  function adapterChanged() {
    const a = caps.adapters?.find(a => a.name === $("adapter").value), t = a?.training;
    $("trainingEvidence").textContent = t ? `Recorded training run: ${t.runId || "not identified"}. ${(t.warnings || []).join(" ")}` : "Select the training recording and region. Saving the review checks for a matching training receipt; otherwise it records your declaration.";
    if (t?.file) { $("trainingFile").value = t.file; $("trainingStart").value = t.startSeconds; $("trainingSeconds").value = t.seconds; }
  }
  function rememberRatings() {
    if (!current) return;
    for (const form of root.querySelectorAll("[data-rating-case]")) {
      const read = field => form.querySelector(`[data-rating="${field}"]`).value;
      ratings.set(`${current.id}/${form.dataset.ratingCase}`, { preference: read("preference"), A: read("A"), B: read("B"), unwantedA: read("unwantedA"), unwantedB: read("unwantedB"), notes: read("notes") });
    }
  }
  const ratingSelect = (field, saved) => `<select data-rating="${field}"><option value="">Choose…</option>${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${String(saved) === String(n) ? "selected" : ""}>${n}</option>`).join("")}</select>`;
  function paintReview(row) {
    rememberRatings(); current = row;
    $("review").innerHTML = `<div class="ml-head"><div><h4>${esc(row.name)}</h4><p>${esc(row.purpose)}</p></div><span>${esc(row.state)} · ${row.revealed ? "identities revealed" : "A/B labels hidden"}</span></div>
      <p class="ml-note">Training: ${esc(row.trainingSource.file)} · ${row.trainingSource.startSeconds}–${row.trainingSource.startSeconds + row.trainingSource.seconds}s · ${esc(row.trainingSource.evidence)}. Adapter: ${esc(row.adapter.name)} at ${row.strength}. Checkpoint: ${esc(row.checkpoint.name)}.</p>
      ${(row.adapter.training?.warnings || []).map(w => `<p class="ml-warning">${esc(w)}</p>`).join("")}
      <p class="ml-note">${esc(row.note)}</p><div class="ml-row"><button class="ml-primary" data-ml-action="start">Queue ${row.takes.length} matched renders</button><button data-ml-action="refreshJobs">Refresh jobs</button><button data-ml-action="cancel">Cancel this experiment's pending jobs</button><button data-ml-action="reveal">${row.revealed ? "Identities revealed" : "Reveal A/B identities"}</button></div>
      ${row.cases.map(c => {
        const own = ratings.get(`${row.id}/${c.id}`) || {}, takes = row.takes.filter(t => t.caseId === c.id);
        return `<article class="ml-case"><h4>${esc(c.name)}</h4><p class="ml-note">Seed ${c.seed} · ${c.narSteps} steps · ${c.cot} planning · ${c.maxDuration}s ceiling. Same inputs on both sides.</p>
        <details><summary>Review evaluation text and provenance</summary><p>${esc(c.caption)}</p><pre>${esc(c.lyrics || "Instrumental")}</pre><pre>${esc(JSON.stringify({ training: row.trainingSource, adapterIdentity: row.adapter.identity, checkpointIdentity: row.checkpoint.identity }, null, 2))}</pre></details>
        ${c.reference ? `<p class="ml-note">Held-out listening reference: ${esc(c.reference.file)} · ${c.reference.startSeconds}–${c.reference.startSeconds + c.reference.seconds}s</p><audio controls preload="none" src="/api/audio/${encodeURIComponent(c.reference.file)}#t=${c.reference.startSeconds},${c.reference.startSeconds + c.reference.seconds}"></audio>` : ""}
        <div class="ml-pair">${takes.map(t => `<section><b>Take ${t.label}${row.revealed ? ` · ${t.role === "base" ? "base model" : "trained adapter"}` : ""}</b><p>${esc(t.state)}${t.seconds ? ` · ${t.seconds.toFixed(2)}s measured` : ""}</p>
          ${t.state === "ready" ? `<audio controls preload="none" src="/api/audio/${encodeURIComponent(t.file)}"></audio>` : ""}
          ${t.error || t.cancelError ? `<p class="ml-warning">${esc(t.error || t.cancelError)}</p>` : ""}<small>Job ${esc(t.jobId || "not submitted")}</small></section>`).join("")}</div>
        <div class="ml-rating" data-rating-case="${c.id}"><h4>Your listening notes</h4><div class="ml-row"><label>A · 1–5${ratingSelect("A", own.A)}</label><label>B · 1–5${ratingSelect("B", own.B)}</label><label>Preference<select data-rating="preference"><option value="">Choose…</option>${["A", "B", "tie", "neither"].map(v => `<option value="${v}" ${own.preference === v ? "selected" : ""}>${v}</option>`).join("")}</select></label></div>
          <div class="ml-row"><label>Unwanted changes in A<textarea data-rating="unwantedA" rows="2" maxlength="2000">${esc(own.unwantedA || "")}</textarea></label><label>Unwanted changes in B<textarea data-rating="unwantedB" rows="2" maxlength="2000">${esc(own.unwantedB || "")}</textarea></label></div><label>What did you hear?<textarea data-rating="notes" rows="2" maxlength="4000">${esc(own.notes || "")}</textarea></label>
          <button data-ml-action="rate" data-case="${c.id}">Save my observations ${row.revealed ? "· identities revealed" : "· labels hidden"}</button>
          ${row.ratings.filter(r => r.caseId === c.id).map(r => `<p class="ml-note">Saved: preference ${esc(r.preference)}, A ${r.ratings.A}/5, B ${r.ratings.B}/5 · ${r.blinded ? "before reveal" : "after reveal"} · ${esc(r.notes)}</p>`).join("")}</div></article>`;
      }).join("")}`;
    controls(); clearTimeout(timer);
    if (row.takes.some(busyTake) && !disposed) timer = setTimeout(() => refreshJobs().catch(e => say(e.message)), 4000);
  }
  async function refreshJobs() {
    if (!current || pending) return;
    const ticket = ++epoch, value = current.id, data = await api({ action: "refresh", id: value });
    if (!disposed && ticket === epoch && current?.id === value) paintReview(data.experiment);
  }
  async function refresh() {
    collectDrafts();
    const [list, status] = await Promise.all([api({ action: "list" }), json("/api/status")]);
    if (disposed) return;
    caps = list.capabilities || {}; libraries = status.library || [];
    $("capability").textContent = caps.ready ? "Compatible installed adapter path is ready. Saving an experiment does not render." : caps.reason || "No supported installed training adapter is ready. Finish Training and save the adapter, then refresh.";
    const previous = { adapter: $("adapter").value, checkpoint: $("checkpoint").value, file: $("trainingFile").value, saved: $("saved").value };
    $("adapter").innerHTML = options(caps.adapters || []); $("checkpoint").innerHTML = options(caps.checkpoints || []); $("trainingFile").innerHTML = options(libraries, "file");
    $("adapter").value = previous.adapter || caps.adapters?.[0]?.name || ""; $("checkpoint").value = previous.checkpoint || caps.checkpoints?.[0]?.name || ""; $("trainingFile").value = previous.file;
    $("saved").innerHTML = '<option value="">Choose an experiment…</option>' + (list.experiments || []).map(e => `<option value="${esc(e.id)}">${esc(e.name)} · ${esc(e.state)}</option>`).join("");
    $("saved").value = previous.saved || current?.id || ""; adapterChanged(); paintDrafts(); controls();
    if (list.errors?.length) say(`${list.errors.length} saved experiment(s) could not be read. Existing records were retained.`);
  }
  $("adapter").addEventListener("change", adapterChanged);
  $("trainingAudio").addEventListener("timeupdate", () => { if ($("trainingAudio").currentTime >= trainingEnd) $("trainingAudio").pause(); });
  root.addEventListener("input", () => { if (!pending) createKey = uid(); });
  root.addEventListener("click", async event => {
    const button = event.target.closest("button[data-ml-action]"); if (!button || !root.contains(button) || pending) return;
    const action = button.dataset.mlAction;
    try {
      if (action === "addCase" || action === "removeCase") {
        collectDrafts(); if (action === "addCase" && drafts.length < 8) drafts.push({ ...drafts[0], name: `Evaluation ${drafts.length + 1}`, seed: drafts[0].seed + drafts.length, reference: undefined });
        else if (action === "removeCase") drafts.splice(+button.dataset.index, 1); createKey = uid(); paintDrafts(); return;
      }
      if (action === "playTraining") { const player = $("trainingAudio"), file = $("trainingFile").value; if (!file) throw new Error("Choose a training recording.");
        trainingEnd = Number($("trainingStart").value) + Number($("trainingSeconds").value); player.src = `/api/audio/${encodeURIComponent(file)}`; player.currentTime = Number($("trainingStart").value); await player.play(); return; }
      pending = true; controls(); ++epoch;
      if (action === "refresh") await refresh();
      else if (action === "load") { const data = await api({ action: "get", id: $("saved").value }); current = null; ratings.clear(); startKey = uid(); paintReview(data.experiment); }
      else if (action === "create") {
        collectDrafts(); const data = await api({ action: "create", idempotencyKey: createKey, name: $("name").value, purpose: $("purpose").value,
          adapter: $("adapter").value, checkpoint: $("checkpoint").value, strength: Number($("strength").value),
          trainingSource: { file: $("trainingFile").value, startSeconds: Number($("trainingStart").value), seconds: Number($("trainingSeconds").value) }, cases: drafts });
        current = null; paintReview(data.experiment); startKey = uid(); await refresh(); say("Experiment saved. Review the paired cases, then explicitly queue the renders.");
      } else if (current) {
        const body = { action: action === "refreshJobs" ? "refresh" : action, id: current.id,
          ...(action === "refreshJobs" ? {} : { expectedRevision: current.revision }) };
        if (action === "start") body.idempotencyKey = startKey;
        if (action === "rate") { rememberRatings(); const r = ratings.get(`${current.id}/${button.dataset.case}`);
          Object.assign(body, { caseId: button.dataset.case, preference: r.preference, ratings: { A: Number(r.A), B: Number(r.B) }, unwantedChanges: { A: r.unwantedA, B: r.unwantedB }, notes: r.notes }); }
        const data = await api(body); paintReview(data.experiment);
        say(action === "start" ? "Exact job receipts saved. Audio quality still needs listening." : action === "rate" ? "Your observations are saved with their before/after-reveal status." : action === "reveal" ? "A/B identities revealed. Later ratings are marked as informed." : "Experiment refreshed.");
      }
    } catch (error) { say(error.message); }
    finally { pending = false; controls(); if (current?.takes.some(busyTake) && !disposed) { clearTimeout(timer); timer = setTimeout(() => refreshJobs().catch(e => say(e.message)), 4000); } }
  });
  refresh().catch(e => say(e.message));
  return { refresh, destroy() { disposed = true; ++epoch; clearTimeout(timer); $("trainingAudio").pause(); } };
}
