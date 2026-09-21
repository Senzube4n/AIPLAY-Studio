const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const busy = take => ["submitting", "queued", "generating", "composing", "cancelling"].includes(take.state);
const seconds = n => Number.isFinite(n) ? `${n.toFixed(2)} s` : "not measured";

/** Actual outgoing seam changes for a short candidate; the original does not. */
export function auditionPlaybackWindow(session, take, kind = "region") {
  const context = session.contextSeconds, duration = take ? take.seconds : session.sourceSeconds;
  const end = take ? take.effectiveTo : session.toSeconds;
  const center = kind === "in" ? session.fromSeconds : end;
  const from = Math.max(0, (kind === "region" ? session.fromSeconds : center) - context);
  return { file: take ? take.file : session.source, from, to: Math.min(duration, (kind === "region" ? end : center) + context) };
}

export async function mountMusicAuditions(host, options = {}) {
  const request = options.fetch || globalThis.fetch.bind(globalThis);
  let current = null, sourceInfo = null, sources = [], sessions = [], timer, disposed = false, sourceEpoch = 0, sessionEpoch = 0;
  const acknowledged = new Set();
  host.classList.add("music-auditions");
  host.innerHTML = `<p class="ma-intro">Try a different chorus, without losing the song. Make two or three takes, compare both seams, then keep your favourite.</p>
    <div class="ma-layout"><form class="ma-form">
      <label>Original song<select name="source"><option value="">Loading songs…</option></select></label>
      <p class="ma-support" aria-live="polite"></p>
      <div class="ma-range"><label>Start · seconds<input name="from" type="number" min="1" step="0.01" value="15" required></label>
      <label>End · seconds<input name="to" type="number" min="1" step="0.01" value="30" required></label></div>
      <div class="ma-range"><label>Alternatives<select name="count"><option value="2">2 takes · A / B</option><option value="3">3 takes · A / B / C</option></select></label>
      <label>Listen around each seam<input name="context" type="number" min="0" max="15" step="0.5" value="3"></label></div>
      <details><summary>Style, words and score</summary>
        <label>Style<textarea name="caption" rows="3" maxlength="10000"></textarea></label>
        <label>Whole lyric sheet<textarea name="lyrics" rows="6" maxlength="20000"></textarea></label>
        <small>Include the retained beginning so the continuation has the full lyric context.</small>
        <label>Whole ABC score · optional, YuE2 only<textarea name="abc" rows="3" maxlength="65536"></textarea></label>
      </details>
      <button type="submit" class="primary ma-create" disabled>Generate alternatives</button>
      <small>This queues real music renders with different saved seeds. It uses the source's existing replay data and does not install another model.</small>
    </form><section class="ma-review" aria-label="Audition review">
      <div class="ma-saved"><label>Saved auditions<select name="session"><option value="">No audition selected</option></select></label><button type="button" data-action="refresh">Refresh</button></div>
      <div class="ma-results"><p>Your original stays in the library. Select a saved audition or generate alternatives to begin.</p></div>
      <div class="ma-player"><span class="ma-playing">Playback</span><audio controls preload="none"></audio></div>
    </section></div><p class="ma-message" role="status" aria-live="polite"></p>`;
  const q = selector => host.querySelector(selector), field = name => q(`[name="${name}"]`);
  const player = q("audio"); let playbackEnd = Infinity;
  const message = text => { q(".ma-message").textContent = text || ""; };
  async function api(query = "", body) {
    const response = await request(`/api/music-auditions${query}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const data = await response.json(); if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`); return data;
  }
  const playButtons = id => `<div class="ma-listen"><button type="button" data-action="play" data-take="${id}" data-part="region">Play region</button><button type="button" data-action="play" data-take="${id}" data-part="in">Start seam</button><button type="button" data-action="play" data-take="${id}" data-part="out">End seam</button></div>`;
  function paint() {
    if (!current) return;
    const s = current;
    q(".ma-results").innerHTML = `<p class="ma-session-title"><strong>${esc(s.title)}</strong> · ${seconds(s.fromSeconds)}–${seconds(s.toSeconds)} <span>${esc(s.state)}</span></p>
      <article class="ma-take ma-original"><div><strong>Original</strong><span>${seconds(s.sourceSeconds)} · retained</span></div>${playButtons("original")}</article>
      ${s.takes.map(t => `<article class="ma-take ${s.chosen === t.id ? "ma-chosen" : ""}"><div><strong>Take ${esc(t.label)}${s.chosen === t.id ? " · kept" : ""}</strong><span>${esc(t.state)} · seed ${t.seed}</span></div>
        ${t.cancelError ? `<p class="ma-warning">${esc(t.cancelError)}</p>` : ""}
        ${t.state === "ready" ? `<p>${seconds(t.seconds)} · ending returns at ${seconds(t.effectiveTo)}</p>${playButtons(esc(t.id))}
          ${(t.warnings || []).map(w => `<p class="ma-warning">${esc(w)}</p>`).join("")}
          ${t.shortfallSeconds > 0 ? `<label class="ma-ack"><input type="checkbox" data-ack="${esc(t.id)}" ${acknowledged.has(`${s.id}/${t.id}`) ? "checked" : ""}> I have listened and accept that the ending moves earlier.</label>` : ""}
          ${s.discarded ? "" : `<button type="button" data-action="keep" data-take="${esc(t.id)}" ${s.chosen === t.id ? "disabled" : ""}>${s.chosen === t.id ? "Chosen take" : `Keep ${esc(t.label)}`}</button>`}
          <small>${esc(t.file)}</small>` : `<p>${esc(t.error || (t.state === "composing" ? "Joining the seams and measuring the complete song…" : "The original is safe while this take is prepared."))}</p>`}
      </article>`).join("")}
      <p class="ma-choice-note">Keep records your choice; it does not overwrite the original or delete the other takes.</p>
      ${s.takes.some(busy) ? '<button type="button" data-action="cancel">Cancel pending alternatives</button>' : !s.chosen && !s.discarded ? '<button type="button" data-action="discard">Dismiss this audition · keep files</button>' : ""}`;
    clearTimeout(timer);
    if (s.takes.some(busy) && !disposed) timer = setTimeout(() => loadSession(s.id).catch(e => { message(e.message); }), 2500);
  }
  async function loadSession(id) {
    const epoch = ++sessionEpoch;
    const data = await api(`?id=${encodeURIComponent(id)}`);
    if (disposed || epoch !== sessionEpoch) return;
    current = data.session; field("session").value = id; paint();
  }
  async function selectSource(file, fromSeconds, toSeconds) {
    const epoch = ++sourceEpoch; field("source").value = file; q(".ma-create").disabled = true;
    if (!file) { sourceInfo = null; q(".ma-support").textContent = "Choose a library song with saved performance data."; return; }
    const data = await api(`?source=${encodeURIComponent(file)}`);
    if (disposed || epoch !== sourceEpoch) return;
    sourceInfo = data.source;
    q(".ma-support").textContent = sourceInfo.available ? `${sourceInfo.engine} · ${seconds(sourceInfo.seconds)}. Its saved performance is available.` : sourceInfo.reason;
    q(".ma-create").disabled = !sourceInfo.available;
    field("from").value = Number.isFinite(fromSeconds) ? fromSeconds : Math.max(1, Math.min(15, sourceInfo.seconds * .25));
    field("to").value = Number.isFinite(toSeconds) ? toSeconds : Math.min(sourceInfo.seconds, Number(field("from").value) + 15);
    field("caption").value = sourceInfo.caption || ""; field("lyrics").value = sourceInfo.lyrics || ""; field("abc").value = "";
  }
  async function refresh() {
    const data = await api(); if (disposed) return;
    sources = data.sources; sessions = data.sessions;
    const selected = field("source").value || options.source || sources.find(s => s.available)?.file || sources[0]?.file || "";
    field("source").innerHTML = '<option value="">Choose a song</option>' + sources.map(s => `<option value="${esc(s.file)}">${esc(s.title)}${s.available ? "" : " · replay unavailable"}</option>`).join("");
    field("source").value = selected;
    field("session").innerHTML = '<option value="">Choose a saved audition</option>' + sessions.map(s => `<option value="${esc(s.id)}">${esc(s.title)} · ${seconds(s.fromSeconds)}–${seconds(s.toSeconds)} · ${esc(s.state)}</option>`).join("");
    if (!sourceInfo || sourceInfo.file !== selected) await selectSource(selected, options.fromSeconds, options.toSeconds);
    if (current) await loadSession(current.id);
  }
  const stopped = () => { if (player.currentTime >= playbackEnd) player.pause(); };
  player.addEventListener("timeupdate", stopped);
  field("source").addEventListener("change", () => selectSource(field("source").value).catch(e => message(e.message)));
  field("session").addEventListener("change", () => { clearTimeout(timer); if (field("session").value) loadSession(field("session").value).catch(e => message(e.message)); });
  host.addEventListener("change", event => { if (event.target.dataset.ack && current) {
    const key = `${current.id}/${event.target.dataset.ack}`;
    event.target.checked ? acknowledged.add(key) : acknowledged.delete(key);
  } });
  q("form").addEventListener("submit", async event => {
    event.preventDefault(); if (!sourceInfo?.available) return;
    const button = q(".ma-create"); button.disabled = true; message("Submitting alternatives; they will use the normal music queue…");
    try {
      const data = await api("", { action: "create", source: field("source").value,
        fromSeconds: Number(field("from").value), toSeconds: Number(field("to").value), count: Number(field("count").value),
        contextSeconds: Number(field("context").value), caption: field("caption").value, lyrics: field("lyrics").value, abc: field("abc").value || undefined });
      current = data.session; ++sessionEpoch; paint(); await refresh(); message("Alternatives are saved. Compare the original and each ready take before choosing.");
    } catch (e) { message(e.message); } finally { button.disabled = !sourceInfo?.available; }
  });
  host.addEventListener("click", async event => {
    const button = event.target.closest("button[data-action]"); if (!button) return;
    const action = button.dataset.action;
    try {
      if (action === "refresh") { await refresh(); return; }
      if (!current) return;
      const take = current.takes.find(t => t.id === button.dataset.take);
      if (action === "play") {
        if (button.dataset.take !== "original" && take?.state !== "ready") return;
        const range = auditionPlaybackWindow(current, take, button.dataset.part);
        playbackEnd = range.to; player.src = `/api/audio/${encodeURIComponent(range.file)}`;
        player.currentTime = range.from; q(".ma-playing").textContent = `${take ? `Take ${take.label}` : "Original"} · ${seconds(range.from)}–${seconds(range.to)}`;
        await player.play(); return;
      }
      const ack = acknowledged.has(`${current.id}/${take?.id}`);
      if (action === "keep" && take?.shortfallSeconds > 0 && !ack) { message("Listen first, then acknowledge the earlier ending before keeping this short take."); return; }
      button.disabled = true;
      const data = await api("", { action, id: current.id, revision: current.revision, takeId: take?.id, acknowledgeShort: ack });
      current = data.session; ++sessionEpoch; paint();
      message(action === "keep" ? `Take ${take.label} is kept. The original and other takes remain in your library.` : action === "cancel" ? "Cancellation requested for this audition's pending jobs." : "Audition dismissed. Audio files were retained.");
    } catch (e) { message(e.message); button.disabled = false; }
  });
  await refresh();
  return { refresh, selectSource, destroy() { disposed = true; ++sourceEpoch; ++sessionEpoch; clearTimeout(timer); player.pause(); } };
}
