/** A draft-building workflow. Only the existing composer can start its music render. */
export function mountMusicReferences({ root, fetch: request = fetch, onLoadRequest = () => {} }) {
  if (!root || root.dataset.musicReferencesMounted) return;
  root.dataset.musicReferencesMounted = "true";
  root.classList.add("music-references");
  root.innerHTML = `<p class="mr-intro">Turn a local recording or video into a musical direction. Keep the measured evidence, review any model suggestions, then load a draft into Create.</p>
    <div class="mr-grid"><section class="mr-card"><h3>1 · Choose a reference</h3>
    <div class="mr-row"><label>Library<select data-mr="kind"><option value="audio">Music</option><option value="video">Video clips</option></select></label><button type="button" data-mr="refresh">Refresh library</button></div>
    <label>Local file<select data-mr="file"><option value="">Loading library…</option></select></label>
    <video data-mr="player" controls preload="metadata"></video>
    <div class="mr-row"><label>Start (seconds)<input data-mr="start" type="number" min="0" max="86400" step="0.25" value="0"></label><label>Length (seconds)<input data-mr="seconds" type="number" min="0.25" max="120" step="0.25" value="30"></label></div>
    <button type="button" data-mr="prepare">Prepare evidence · CPU</button>
    <label>Saved references<select data-mr="saved"><option value="">Choose a saved brief…</option></select></label></section>
    <section class="mr-card"><h3>2 · Inspect the evidence</h3><p data-mr="evidence">No reference prepared yet.</p>
    <img data-mr="sheet" hidden alt="Sampled video frames, labelled with source timestamps">
    <div class="mr-row"><button type="button" data-mr="visual" disabled>Suggest from frames · local model</button><button type="button" data-mr="transcribe" disabled>Transcribe melody · local model</button></div>
    <p data-mr="capability">Visual analysis is optional. You can write the brief yourself.</p><pre data-mr="suggestion"></pre>
    <details><summary>Review / correct score</summary><label>Two-voice ABC<textarea data-mr="score" rows="7" maxlength="65536"></textarea></label><p data-mr="scoreCheck">No score transcribed.</p><button type="button" data-mr="saveScore" disabled>Save and check score</button></details>
    </section><section class="mr-card mr-wide"><h3>3 · Review your music brief</h3>
    <label>Style and instrumentation<textarea data-mr="style" rows="3" maxlength="4000" placeholder="Describe the music you want. Model suggestions are not applied automatically."></textarea></label>
    <div class="mr-row"><label>Lyrics<textarea data-mr="lyrics" rows="5" maxlength="16000"></textarea></label><label>Reference notes<textarea data-mr="notes" rows="5" maxlength="4000"></textarea></label></div>
    <div class="mr-row"><label>Engine<select data-mr="engine"><option value="yue2">YuE2 · Python</option><option value="yue2-gguf">YuE2 · native GGUF</option><option value="yue2-comfy">YuE2 · Comfy</option></select></label><label>Seed<input data-mr="seed" type="number" min="0" max="4294967295" step="1" value="0"></label></div>
    <label class="mr-check"><input data-mr="useScore" type="checkbox">Use the validated melody score</label>
    <label class="mr-check"><input data-mr="instrumental" type="checkbox">Instrumental · empty lyrics required (Python/Comfy brief only)</label>
    <label class="mr-check"><input data-mr="labels" type="checkbox">Allow section tags in lyrics</label>
    <div class="mr-row"><button type="button" data-mr="save" disabled>Save brief</button><button type="button" data-mr="draft" disabled>Review request</button><button type="button" data-mr="load" disabled>Load reviewed request into Create</button></div>
    <pre data-mr="request"></pre><p class="mr-caveat">A new take can follow this direction; singer identity, exact hit timing and the original performance are not guaranteed. Loading a draft does not generate music.</p>
    </section></div><p data-mr="status" role="status" aria-live="polite">Choose a local file to begin.</p>`;
  const $ = name => root.querySelector(`[data-mr="${name}"]`);
  let row = null, timer = null, disposed = false, dirty = false, scoreDirty = false, capability = null, busy = false, libraryTicket = 0;
  const status = s => { $("status").textContent = s; };
  async function json(url, body) {
    const response = await request(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || `Request failed (${response.status}).`);
    return result;
  }
  const post = body => json("/api/music-references", body);
  function buttons() {
    const pending = busy || ["preparing", "analyzing", "transcribing"].includes(row?.state);
    for (const name of ["save", "draft", "saveScore"]) $(name).disabled = !row?.evidence || pending;
    $("visual").disabled = !row?.evidence?.timestamps?.length || pending || !capability?.available;
    $("transcribe").disabled = !row?.evidence?.hasAudio || pending;
    $("load").disabled = !row?.prepared || dirty || scoreDirty || pending;
    $("prepare").disabled = busy || !$("file").value;
  }
  function paint(next) {
    const changed = row?.id !== next.id, finished = row && row.id === next.id && row.state !== "ready" && next.state === "ready"; row = next;
    if (changed) {
      dirty = false; scoreDirty = false;
      const reviewed = row.prepared?.request;
      $("engine").value = ["yue2", "yue2-gguf", "yue2-comfy"].includes(reviewed?.engine) ? reviewed.engine : "yue2";
      $("seed").value = String(reviewed?.seed ?? 0);
      $("useScore").checked = !!reviewed?.abc?.trim();
      $("instrumental").checked = reviewed?.instrumental === true;
      $("labels").checked = reviewed?.allowSectionLabels === true;
    }
    if (!dirty) for (const name of ["style", "lyrics", "notes"]) $(name).value = row.brief?.[name] || "";
    const ev = row.evidence;
    $("evidence").textContent = ev ? `${row.source.file} · source ${ev.startSeconds.toFixed(2)}–${(ev.startSeconds + ev.seconds).toFixed(2)} s · ${ev.audio?.bpm ? `estimated ${ev.audio.bpm} BPM (confidence ${ev.audio.confidence})` : "no tempo estimate"}. ${(row.warnings || []).join(" ")}` : `${row.source.file} · ${row.state}`;
    if (changed) { $("sheet").hidden = true; $("sheet").removeAttribute("src"); }
    if (row.contactSheetDataUrl) { $("sheet").src = row.contactSheetDataUrl; $("sheet").hidden = false; }
    $("suggestion").textContent = row.visual?.text || "Model observations will appear here as suggestions.";
    if (!scoreDirty || changed) $("score").value = row.score?.abc || "";
    $("scoreCheck").textContent = row.score ? row.score.check?.ok ? "Notation check passed; musical accuracy still needs listening/review." : (row.score.check?.problems || []).slice(0, 3).map(p => p.says).join(" ") || "Score needs checking." : "No score transcribed.";
    $("request").textContent = row.prepared ? JSON.stringify(row.prepared.request, null, 2) : "";
    status(row.error || (row.state === "ready" ? "Evidence ready. Review the brief; no music has been generated." : `${row.state}…`));
    buttons(); clearTimeout(timer);
    if (finished) void saved();
    if (["preparing", "analyzing", "transcribing"].includes(row.state)) timer = setTimeout(poll, 1400);
  }
  async function poll() {
    if (disposed || !row) return;
    try { paint((await post({ action: "get", referenceId: row.id, preview: true })).reference); }
    catch (error) { status(error.message); }
  }
  async function act(action, extra = {}) {
    busy = true; buttons();
    try {
      const result = await post({ action, ...(row && action !== "prepare" ? { referenceId: row.id, expectedRevision: row.revision } : {}), ...extra });
      paint(result.reference); return result;
    } catch (error) { status(error.message); throw error; }
    finally { busy = false; buttons(); }
  }
  async function libraries() {
    const ticket = ++libraryTicket, kind = $("kind").value;
    try {
      const data = await json(kind === "video" ? "/api/clips" : "/api/status");
      if (disposed || ticket !== libraryTicket) return;
      const rows = kind === "video" ? (data.clips || []).filter(v => /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(v.name)) : data.library || [];
      const old = $("file").value; $("file").replaceChildren();
      const placeholder = root.ownerDocument.createElement("option"); placeholder.value = ""; placeholder.textContent = rows.length ? "Choose a local file…" : "No supported files in this library"; $("file").append(placeholder);
      for (const entry of rows) {
        const option = root.ownerDocument.createElement("option"); option.value = entry.file || entry.name; option.textContent = entry.title || option.value; $("file").append(option);
      }
      $("file").value = old; buttons();
    } catch (error) { status(`Library unavailable: ${error.message}`); }
  }
  async function saved() {
    try {
      const data = await post({ action: "list" });
      const selected = $("saved").value || row?.id || "";
      $("saved").replaceChildren();
      const placeholder = root.ownerDocument.createElement("option"); placeholder.value = ""; placeholder.textContent = "Choose a saved brief…"; $("saved").append(placeholder);
      for (const item of data.references || []) { const option = root.ownerDocument.createElement("option"); option.value = item.id; option.textContent = `${item.source.file} · ${item.state}`; $("saved").append(option); }
      $("saved").value = selected;
    } catch (error) { status(error.message); }
  }
  const listen = (name, fn) => $(name).addEventListener("click", () => Promise.resolve().then(fn).catch(error => status(error.message)));
  $("kind").addEventListener("change", libraries); listen("refresh", libraries);
  $("file").addEventListener("change", () => {
    const file = $("file").value; $("player").src = file ? `${$("kind").value === "video" ? "/api/clip/" : "/api/audio/"}${encodeURIComponent(file)}` : ""; buttons();
  });
  $("saved").addEventListener("change", async () => { if (!$("saved").value) return; try { paint((await post({ action: "get", referenceId: $("saved").value, preview: true })).reference); } catch (e) { status(e.message); } });
  for (const name of ["style", "lyrics", "notes", "engine", "seed", "useScore", "labels", "instrumental"]) $(name).addEventListener("input", () => { dirty = true; $("request").textContent = "Draft changed — review a new request before loading."; buttons(); });
  listen("prepare", async () => { await act("prepare", { kind: $("kind").value, file: $("file").value, startSeconds: Number($("start").value), seconds: Number($("seconds").value), maxFrames: 6 }); await saved(); });
  listen("visual", () => act("analyze_visual")); listen("transcribe", () => act("transcribe", { mode: "melody" }));
  $("score").addEventListener("input", () => { scoreDirty = true; buttons(); });
  listen("saveScore", async () => { await act("update_score", { abc: $("score").value, mode: row?.score?.mode || "melody" }); scoreDirty = false; buttons(); status("Score saved and checked. Review any notation findings before using it."); });
  async function saveBrief() { const result = await act("update_brief", { brief: { style: $("style").value, lyrics: $("lyrics").value, notes: $("notes").value } }); dirty = false; buttons(); return result; }
  listen("save", saveBrief);
  listen("draft", async () => {
    if (scoreDirty) return status("Save and check your edited score before preparing a request.");
    await saveBrief();
    await act("prepare_request", { reviewed: true, engine: $("engine").value, seed: Number($("seed").value), useScore: $("useScore").checked,
      instrumental: $("instrumental").checked, allowSectionLabels: $("labels").checked });
    status("Request prepared. Check it above, then load it into Create. No music has been generated.");
  });
  listen("load", async () => { if (row?.prepared && !dirty && !scoreDirty) { await onLoadRequest(structuredClone(row.prepared.request)); status("Reviewed request loaded into Create. Check the composer and press Generate when ready."); } });
  Promise.allSettled([libraries(), saved(), post({ action: "capabilities" }).then(data => {
    capability = data.visual; $("capability").textContent = capability.available ? `Local visual model available: ${capability.models[0]}. This optional action uses the engine queue.` : capability.reason; buttons();
  }).catch(error => { $("capability").textContent = error.message; })]);
  return { refresh: libraries, dispose: () => { disposed = true; clearTimeout(timer); } };
}
