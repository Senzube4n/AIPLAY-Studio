const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const working = take => ["submitting", "queued", "generating", "composing", "cancelling"].includes(take.state);
const seconds = value => Number.isFinite(value) ? `${value.toFixed(2)} s` : "unmeasured";
// Match the backend's project fingerprint inputs. Layout, timestamps and the
// edit ledger are not score content, so changing them must not invalidate a review.
const projectShape = project => project ? JSON.stringify({ id: project.id, lengthBars: project.lengthBars,
  meterMap: project.meterMap, tempoMap: project.tempoMap, tracks: project.tracks }) : null;

/** The DAW and MCP share saved passage snapshots; preview never mutates notes. */
export function mountDawPassages(host, { getContext, onOpen = () => {}, onRefresh = () => {}, fetch: request = globalThis.fetch.bind(globalThis) } = {}) {
  if (typeof getContext !== "function") throw new Error("DAW passage context is required.");
  host.classList.add("d-passages");
  host.innerHTML = `<div class="d-pass-layout">
    <form class="d-pass-form">
      <div class="d-pass-heading"><strong>AI takes</strong><span class="d-pass-project"></span><button class="d-btn d-sm" type="button" data-action="loop">Use loop</button></div>
      <div class="d-pass-fields">
        <label>first bar<input class="d-num" name="fromBar" type="number" min="1" step="1" required></label>
        <label>last bar<input class="d-num" name="toBar" type="number" min="1" step="1" required></label>
        <label>vocal melody<select class="d-sel" name="Vocal"></select></label>
        <label>instrument melody<select class="d-sel" name="Ins"></select></label>
      </div>
      <div class="d-pass-source"><label>original recording<select class="d-sel" name="source"><option value="">Score only</option></select></label>
        <label title="Positive means DAW bar 1 occurs later in the original recording.">recording offset<input class="d-num" name="offset" type="number" step="0.01" value="0"> <span>s</span></label></div>
      <div class="d-pass-options"><label title="Snaps only the ABC preview to 1/32 notes. DAW notes stay unchanged."><input name="quantize" type="checkbox"> quantize preview</label><span class="d-note">Two melody voices</span></div>
      <details class="d-pass-more"><summary>Style and lyrics</summary><label>style<textarea class="d-txt" name="caption" maxlength="10000" rows="2"></textarea></label><label>whole lyric sheet<textarea class="d-txt" name="lyrics" maxlength="20000" rows="4"></textarea></label></details>
      <div class="d-pass-actions"><button type="submit" class="d-btn" data-action="preview">Review score</button><button type="button" class="d-btn" data-action="save" disabled>Save draft</button><a class="d-btn d-pass-load" aria-disabled="true">Load in Music</a></div>
      <div class="d-pass-preview" aria-live="polite"><span class="d-pass-chip">Select notes and bars</span></div>
      <details class="d-pass-more"><summary>ABC preview</summary><textarea class="d-txt d-pass-abc" readonly rows="6" aria-label="ABC preview"></textarea></details>
      <details class="d-pass-more"><summary>Exact settings</summary><pre class="d-pass-settings">Review a passage to see its request.</pre></details>
    </form>
    <section class="d-pass-review" aria-label="Saved AI takes">
      <div class="d-pass-shelf"><label>saved draft<select class="d-sel" name="draft"><option value="">Choose a draft</option></select></label><button class="d-btn d-sm" type="button" data-action="refresh">Refresh</button></div>
      <div class="d-pass-generate"><label>takes<select class="d-sel" name="count"><option value="2">2</option><option value="3">3</option></select></label><label>seam context<input class="d-num" name="context" type="number" min="0" max="15" step="0.5" value="3"> <span>s</span></label><button class="d-btn" type="button" data-action="start" disabled>Make 2 takes</button></div>
      <p class="d-pass-eligibility d-note">Save a reviewed draft to compare takes.</p>
      <div class="d-pass-results"><p class="d-note">Edit notes in the piano roll, then review this passage.</p></div>
      <div class="d-pass-audio"><span class="d-note d-pass-playing">Playback</span><audio controls preload="none" aria-label="Passage comparison playback"></audio></div>
    </section>
  </div><p class="d-pass-message" role="status" aria-live="polite"></p>`;
  const q = selector => host.querySelector(selector);
  const field = name => q(`[name="${name}"]`);
  const player = q("audio");
  const form = q("form");
  const acknowledged = new Set();
  let disposed = false, visible = false, slug = null, draft = null, audition = null, preview = null, reviewedShape = null;
  let dirtyForm = true, sending = false, sources = [], timer, readEpoch = 0, listEpoch = 0, previewEpoch = 0, sourceEpoch = 0, playEpoch = 0, playbackEnd = Infinity, pendingSeek = null;
  const message = text => { if (!disposed) q(".d-pass-message").textContent = text || ""; };
  const active = () => !disposed && visible && document.visibilityState !== "hidden" && host.isConnected;
  const stopPlayback = () => { ++playEpoch; player.pause(); playbackEnd = Infinity; if (pendingSeek) player.removeEventListener("loadedmetadata", pendingSeek); pendingSeek = null; };
  const resetPlayback = () => { stopPlayback(); player.removeAttribute("src"); player.load(); q(".d-pass-playing").textContent = "Playback"; };

  async function api(body, query = "", endpoint = "/api/music-daw-passages") {
    const response = await request(endpoint + query, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const data = await response.json();
    if (!response.ok || data.error || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  function tracks(context, force = false) {
    const rows = context.project?.tracks || [];
    for (const voice of ["Vocal", "Ins"]) {
      const previous = field(voice).value;
      field(voice).innerHTML = '<option value="">Silent voice</option>' + rows.map(track => `<option value="${esc(track.id)}">${esc(track.name)}</option>`).join("");
      field(voice).value = force ? (voice === "Ins" ? context.trackId || rows[0]?.id || "" : "") : rows.some(track => track.id === previous) ? previous : "";
    }
    q(".d-pass-project").textContent = context.project?.name || "No project";
    for (const name of ["fromBar", "toBar"]) field(name).max = context.project?.lengthBars || 256;
  }
  function useLoop() {
    const context = getContext() || {};
    if (!context.slug || !context.project) { message("Choose a DAW project."); return; }
    tracks(context, true);
    field("fromBar").value = context.fromBar || 1;
    field("toBar").value = context.toBar || Math.min(context.project.lengthBars, Number(field("fromBar").value) + 3);
    changed();
  }
  function inputs() {
    if (!slug) throw new Error("Choose a DAW project.");
    if (!q("form").reportValidity()) throw new Error("Check the bar range.");
    return { slug, fromBar: Number(field("fromBar").value), toBar: Number(field("toBar").value),
      voiceTracks: { Vocal: field("Vocal").value || null, Ins: field("Ins").value || null },
      source: field("source").value || undefined, sourceOffsetSeconds: Number(field("offset").value),
      quantizeTo32nd: field("quantize").checked, caption: field("caption").value, lyrics: field("lyrics").value };
  }
  function controls() {
    if (disposed) return;
    q('[data-action="preview"]').disabled = sending || !slug;
    q('[data-action="save"]').disabled = sending || !preview;
    const load = q(".d-pass-load");
    if (draft && !dirtyForm) { load.href = `/?view=create&dawPassage=${encodeURIComponent(draft.id)}`; load.setAttribute("aria-disabled", "false"); }
    else { load.removeAttribute("href"); load.setAttribute("aria-disabled", "true"); }
    q('[data-action="start"]').disabled = sending || !draft || draft.state !== "draft" || dirtyForm || !draft.eligibility?.available || !!audition?.takes?.some(working);
    q('[data-action="start"]').textContent = `Make ${field("count").value} takes`;
  }
  function changed() {
    ++previewEpoch; preview = null; reviewedShape = null; dirtyForm = true;
    q(".d-pass-preview").innerHTML = '<span class="d-pass-chip">Review needed</span>';
    q(".d-pass-abc").value = "";
    q(".d-pass-settings").textContent = "Review a passage to see its request.";
    controls();
  }
  function paintPreview(value) {
    const score = value.score || value;
    const selection = score.selection || value.selection || {};
    const check = score.check || value.check;
    const warnings = score.warnings || value.warnings || [];
    q(".d-pass-preview").innerHTML = `<span class="d-pass-chip ${check?.ok === false ? "d-pass-warn" : ""}">${check?.ok === false ? "Score needs repair" : "Score ready"}</span><span class="d-note">${esc(selection.bars ?? "")} bars · ${seconds(selection.durationSeconds)}${value.source && Number.isFinite(value.fromSeconds) ? ` · recording ${seconds(value.fromSeconds)}–${seconds(value.toSeconds)}` : ""}</span>
      ${warnings.length ? `<details class="d-pass-more"><summary>${warnings.length} export warnings</summary><ul>${warnings.map(warning => `<li>${esc(warning.message || warning)}${warning.code === "quantized" ? ` (${warning.onsets} starts, ${warning.lengths} lengths)` : ""}</li>`).join("")}</ul></details>` : ""}`;
    q(".d-pass-abc").value = score.abc || value.abc || "";
    q(".d-pass-settings").textContent = JSON.stringify(value.request || {}, null, 2);
  }
  function schedule() {
    clearTimeout(timer);
    if (active() && draft && audition?.takes?.some(working)) timer = setTimeout(() => readDraft(draft.id, false).catch(error => { message(error.message); schedule(); }), 2500);
  }
  const listenButtons = id => `<div class="d-pass-listen"><button class="d-btn d-sm" type="button" data-action="play" data-take="${esc(id)}" data-part="region">Passage</button><button class="d-btn d-sm" type="button" data-action="play" data-take="${esc(id)}" data-part="in">Start seam</button><button class="d-btn d-sm" type="button" data-action="play" data-take="${esc(id)}" data-part="out">End seam</button><button class="d-btn d-sm" type="button" data-action="play" data-take="${esc(id)}" data-part="full">Full song</button></div>`;
  function paintResults() {
    q(".d-pass-eligibility").textContent = draft ? draft.state === "uncertain" ? draft.error || "Inspect the queue before saving a new draft." : draft.state === "starting" ? "Submitting takes…" : draft.state === "submitted" ? "Saved audition" : draft.eligibility?.available ? "80 ms seam blends; normal GPU queue" : draft.eligibility?.reason || "Load this score in Music to render it." : "Save a reviewed draft to compare takes.";
    const takes = audition?.takes || [];
    q(".d-pass-results").innerHTML = draft ? `${draft.source ? `<article class="d-pass-take"><div class="d-pass-takehead"><strong>Original</strong><span class="d-pass-chip">Retained</span></div>${listenButtons("original")}</article>` : ""}
      ${takes.map(take => `<article class="d-pass-take ${audition.chosen === take.id ? "d-pass-kept" : ""}"><div class="d-pass-takehead"><strong>Take ${esc(take.label || take.id)}</strong><span class="d-pass-chip">${esc(take.state)}${audition.chosen === take.id ? " · kept" : ""}</span></div><span class="d-note">seed ${esc(take.seed)}${Number.isFinite(take.seconds) ? ` · ${seconds(take.seconds)}` : ""}</span>
        ${take.state === "ready" ? `${listenButtons(take.id)}${take.shortfallSeconds > 0 ? `<label class="d-pass-ack" title="The replacement is shorter and the ending returns earlier. Listen to the end seam before keeping it."><input type="checkbox" data-ack="${esc(take.id)}" ${acknowledged.has(`${audition.id}/${take.id}`) ? "checked" : ""}> accept earlier ending (${seconds(take.shortfallSeconds)})</label>` : ""}<div class="d-pass-actions"><button class="d-btn d-sm" type="button" data-action="keep" data-take="${esc(take.id)}" ${audition.chosen === take.id || (take.shortfallSeconds > 0 && !acknowledged.has(`${audition.id}/${take.id}`)) ? "disabled" : ""}>${audition.chosen === take.id ? "Kept" : "Keep take"}</button><a class="d-btn d-sm" href="/?view=create">Open library</a></div>${(take.warnings || []).length ? `<details class="d-pass-more"><summary>Take notes</summary><ul>${take.warnings.map(warning => `<li>${esc(warning.message || warning)}</li>`).join("")}</ul></details>` : ""}` : take.error || take.cancelError ? `<p class="d-pass-error">${esc(take.error || take.cancelError)}</p>` : ""}</article>`).join("")}
      ${takes.some(working) ? '<button class="d-btn" type="button" data-action="cancel">Cancel pending takes</button>' : !takes.length ? '<p class="d-note">Load the score in Music, or add a supported recording to compare AI takes.</p>' : ""}` : '<p class="d-note">Edit notes in the piano roll, then review this passage.</p>';
    controls(); schedule();
  }
  function fillDraft(value) {
    const selection = value.score?.selection || value.selection || {};
    field("fromBar").value = value.fromBar ?? selection.fromBar ?? field("fromBar").value;
    field("toBar").value = value.toBar ?? selection.toBar ?? field("toBar").value;
    const assignments = value.options?.voiceTracks || value.voiceTracks || Object.fromEntries((value.score?.voices || []).map(voice => [voice.voice, voice.trackId]));
    for (const voice of ["Vocal", "Ins"]) if (assignments[voice] !== undefined) field(voice).value = assignments[voice] || "";
    field("source").value = value.source || "";
    field("offset").value = value.sourceOffsetSeconds || 0;
    field("quantize").checked = !!(value.options?.quantizeTo32nd ?? value.quantizeTo32nd);
    field("caption").value = value.request?.caption || "";
    field("lyrics").value = value.request?.lyrics || "";
    preview = value; reviewedShape = projectShape(getContext()?.project); dirtyForm = false; paintPreview(value);
  }
  async function readDraft(id, fill = true) {
    const epoch = ++readEpoch;
    const data = await api(null, `?id=${encodeURIComponent(id)}`);
    if (disposed || epoch !== readEpoch || (data.draft?.slug && data.draft.slug !== slug)) return;
    draft = data.draft; audition = data.audition || null;
    field("draft").value = id;
    if (fill && draft) { ++previewEpoch; fillDraft(draft); }
    paintResults();
  }
  async function refresh() {
    if (disposed) return;
    const context = getContext() || {};
    if (context.slug !== slug) await contextChanged();
    if (!slug || disposed) return;
    const capturedSlug = slug;
    const epoch = ++listEpoch;
    const data = await api(null, `?slug=${encodeURIComponent(slug)}`);
    if (disposed || capturedSlug !== slug || epoch !== listEpoch) return;
    sources = data.sources || [];
    const selectedSource = field("source").value;
    field("source").innerHTML = '<option value="">Score only</option>' + sources.map(source => `<option value="${esc(source.file)}">${esc(source.title || source.file)}${source.available ? "" : " (replay unavailable)"}</option>`).join("");
    field("source").value = sources.some(source => source.file === selectedSource) ? selectedSource : "";
    const selectedDraft = draft?.id || field("draft").value;
    field("draft").innerHTML = '<option value="">Choose a draft</option>' + (data.drafts || []).map(value => `<option value="${esc(value.id)}">${esc(value.title || value.id)}${value.state ? ` (${esc(value.state)})` : ""}</option>`).join("");
    field("draft").value = selectedDraft || "";
    if (draft) await readDraft(draft.id, false);
  }
  async function contextChanged() {
    if (disposed) return;
    const context = getContext() || {};
    const changedProject = context.slug !== slug;
    tracks(context, changedProject);
    if (!changedProject) {
      if (reviewedShape !== null && reviewedShape !== projectShape(context.project)) {
        changed(); message("Project edited. Review the score again.");
      } else controls();
      return;
    }
    slug = context.slug || null;
    ++readEpoch; ++listEpoch; ++previewEpoch; ++sourceEpoch;
    clearTimeout(timer); draft = null; audition = null; preview = null; resetPlayback();
    field("caption").value = ""; field("lyrics").value = ""; field("source").value = ""; field("offset").value = 0;
    field("fromBar").value = context.fromBar || 1;
    field("toBar").value = context.toBar || Math.min(context.project?.lengthBars || 1, (context.fromBar || 1) + 3);
    changed(); paintResults();
  }
  async function sourceChanged() {
    const epoch = ++sourceEpoch;
    changed();
    const file = field("source").value;
    if (!file) { message("Score-first draft"); return; }
    const previousCaption = field("caption").value, previousLyrics = field("lyrics").value;
    const data = await api(null, `?source=${encodeURIComponent(file)}`, "/api/music-auditions");
    if (disposed || epoch !== sourceEpoch) return;
    if (field("caption").value === previousCaption) field("caption").value = data.source?.caption || "";
    if (field("lyrics").value === previousLyrics) field("lyrics").value = data.source?.lyrics || "";
    changed();
    message(data.source?.available ? "Recording selected" : data.source?.reason || "Replay unavailable");
  }
  async function act(action, button) {
    if (sending) return;
    sending = true; controls(); if (button) button.disabled = true;
    try {
      if (action === "preview") {
        const epoch = ++previewEpoch;
        const capturedShape = projectShape(getContext()?.project);
        message("Checking score…");
        const data = await api({ action, ...inputs() });
        if (disposed || epoch !== previewEpoch) return;
        if (capturedShape !== projectShape(getContext()?.project)) { changed(); message("Project edited. Review the score again."); return; }
        preview = data.preview || data; reviewedShape = capturedShape; paintPreview(preview); message("Score reviewed");
      } else if (action === "save") {
        if (!preview) return;
        const capturedSlug = slug, epoch = previewEpoch;
        const data = await api({ action: "create", ...inputs() });
        if (disposed || capturedSlug !== slug) return;
        if (epoch !== previewEpoch) { await refresh(); message("Draft saved. Review the current edits before saving again."); return; }
        draft = data.draft; audition = data.audition || null; dirtyForm = false; preview = draft;
        fillDraft(draft); paintResults(); await refresh(); message("Draft saved");
      } else if (action === "start") {
        if (!draft || dirtyForm) return;
        const capturedId = draft.id;
        message("Queueing AI takes…");
        const data = await api({ action, id: capturedId, revision: draft.revision, count: Number(field("count").value), contextSeconds: Number(field("context").value) });
        if (disposed || draft?.id !== capturedId) return;
        draft = data.draft; audition = data.audition; paintResults(); message("Takes queued");
      } else if (action === "keep" || action === "cancel") {
        if (!audition) return;
        const capturedId = audition.id;
        const takeId = button?.dataset.take;
        const data = await api({ action, id: capturedId, revision: audition.revision, takeId,
          acknowledgeShort: acknowledged.has(`${capturedId}/${takeId}`) }, "", "/api/music-auditions");
        if (disposed || audition?.id !== capturedId) return;
        audition = data.session; paintResults(); message(action === "keep" ? "Take kept in library" : "Cancellation requested");
        if (action === "keep") await onRefresh();
      }
    } catch (error) { message(error.message); }
    finally { sending = false; controls(); if (!disposed && button?.isConnected && !["preview", "save", "start"].includes(action)) button.disabled = false; }
  }
  async function play(button) {
    if (!draft) return;
    stopPlayback();
    const epoch = playEpoch;
    message("Checking audio…");
    const data = await api({ action: "audition", id: draft.id, takeId: button.dataset.take, part: button.dataset.part });
    if (disposed || epoch !== playEpoch || !active()) return;
    const value = data.playback || data;
    if (!value.url || !Number.isFinite(value.fromSeconds) || !Number.isFinite(value.toSeconds) || value.toSeconds <= value.fromSeconds) throw new Error("Verified playback is unavailable.");
    const url = new URL(value.url, globalThis.location?.href || "http://127.0.0.1/");
    if (url.origin !== globalThis.location?.origin || url.pathname !== "/api/music-daw-passages/audio") throw new Error("Invalid playback URL.");
    playbackEnd = value.toSeconds;
    player.src = url.pathname + url.search;
    pendingSeek = () => { if (epoch === playEpoch) player.currentTime = value.fromSeconds; pendingSeek = null; };
    player.addEventListener("loadedmetadata", pendingSeek, { once: true });
    player.currentTime = value.fromSeconds;
    q(".d-pass-playing").textContent = `${value.label || (button.dataset.take === "original" ? "Original" : "Take")} · ${seconds(value.fromSeconds)}–${seconds(value.toSeconds)}`;
    await player.play(); message("Playing verified audio");
  }
  const click = event => {
    const button = event.target.closest("[data-action]"); if (!button || !host.contains(button)) return;
    const action = button.dataset.action;
    if (action === "preview") return; // Form submit handles keyboard and pointer equally.
    if (action === "loop") useLoop();
    else if (action === "refresh") refresh().catch(error => message(error.message));
    else if (action === "play") play(button).catch(error => message(error.message));
    else act(action, button);
  };
  const submit = event => { event.preventDefault(); act("preview", q('[data-action="preview"]')); };
  const input = event => {
    if (event.target.closest(".d-pass-form") && event.target.name) changed();
  };
  const change = event => {
    if (event.target.name === "source") sourceChanged().catch(error => message(error.message));
    if (event.target.name === "draft") {
      ++readEpoch; ++sourceEpoch; clearTimeout(timer); resetPlayback();
      const id = event.target.value;
      if (id) readDraft(id).catch(error => message(error.message));
      else { draft = null; audition = null; changed(); paintResults(); }
    }
    if (event.target.name === "count") controls();
    if (event.target.dataset.ack && audition) {
      const key = `${audition.id}/${event.target.dataset.ack}`;
      event.target.checked ? acknowledged.add(key) : acknowledged.delete(key);
      paintResults();
    }
  };
  const timeupdate = () => { if (player.currentTime >= playbackEnd) player.pause(); };
  const visibility = () => { if (!active()) stopPlayback(); else schedule(); };
  host.addEventListener("click", click); host.addEventListener("input", input); host.addEventListener("change", change);
  form.addEventListener("submit", submit); player.addEventListener("timeupdate", timeupdate);
  document.addEventListener("visibilitychange", visibility);
  const observer = typeof MutationObserver === "function" ? new MutationObserver(() => {
    const shown = !host.hidden && !host.closest("[hidden]") && (!host.classList.contains("d-dockpane") || host.classList.contains("d-on")) && !host.closest(".d-nodock");
    if (shown !== visible) setVisible(shown);
  }) : null;
  if (observer) {
    for (let node = host; node && node !== document.documentElement; node = node.parentElement) observer.observe(node, { attributes: true, attributeFilter: ["class", "hidden"] });
  }
  function setVisible(value) {
    if (disposed) return;
    const reopening = !visible && !!value;
    visible = !!value; clearTimeout(timer);
    if (!visible) stopPlayback();
    else if (reopening) refresh().catch(error => message(error.message));
    else schedule();
  }
  async function open() { if (disposed) return; onOpen(); setVisible(true); await contextChanged(); await refresh(); }
  contextChanged().catch(error => message(error.message));
  controls();
  return { open, refresh, contextChanged, setVisible, destroy() {
    disposed = true; ++readEpoch; ++listEpoch; ++previewEpoch; ++sourceEpoch; clearTimeout(timer); resetPlayback(); observer?.disconnect();
    host.removeEventListener("click", click); host.removeEventListener("input", input); host.removeEventListener("change", change);
    form.removeEventListener("submit", submit); player.removeEventListener("timeupdate", timeupdate); document.removeEventListener("visibilitychange", visibility);
  } };
}
