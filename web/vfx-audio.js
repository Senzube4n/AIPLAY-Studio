/** Explicit-user VFX playback. The exact server mix is the transport clock. */
export function createVfxAudio({ fetchFn = globalThis.fetch?.bind(globalThis),
  audioFactory = () => new Audio(), onState = () => {}, onError = () => {},
  beforePlay = () => {}, prepareTimeoutMs = 100_000, mediaTimeoutMs = 15_000,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let generation = 0, current = null, disposed = false;
  const abortError = () => Object.assign(new Error("Audio preview cancelled."), { name: "AbortError" });
  const emit = (status, message = "") => onState({ status, message });
  const valid = (rec) => !disposed && current === rec && rec.generation === generation && !rec.controller.signal.aborted;
  function release(rec) {
    if (!rec) return;
    rec.controller.abort();
    for (const remove of rec.listeners) remove();
    rec.listeners.length = 0;
    if (rec.timer) clearTimer(rec.timer);
    try { rec.audio.pause(); } catch { /* already detached */ }
    try { rec.audio.removeAttribute("src"); rec.audio.load(); } catch { /* test/browser teardown */ }
  }
  function pause() {
    generation++;
    const old = current;
    current = null;
    release(old);
    emit("paused");
  }
  function fail(rec, err) {
    if (!valid(rec)) return;
    generation++;
    current = null;
    release(rec);
    emit("error", err.message);
    onError(err);
  }
  const listen = (rec, name, fn) => {
    rec.audio.addEventListener(name, fn);
    const remove = () => rec.audio.removeEventListener(name, fn);
    rec.listeners.push(remove);
    return remove;
  };
  const inRange = (rec, time) => Number.isFinite(time) && time >= rec.from && time <= rec.to;
  const offset = (rec, time) => time >= rec.to ? 0 : Math.max(0, time - rec.from);
  async function play({ slug, revision, time, from = 0, to }) {
    if (disposed) throw new Error("Audio preview was disposed.");
    pause(); // every new user gesture cancels both pending and audible old mixes
    if (typeof slug !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(slug) ||
        !Number.isSafeInteger(revision) || revision < 0 || !Number.isFinite(from) || from < 0 ||
        !Number.isFinite(to) || to <= from || to - from > 120) {
      const err = new Error("Choose an audio preview work area up to 120 seconds.");
      emit("error", err.message); onError(err); throw err;
    }
    const rec = { generation, slug, revision, from, to, desired: Number.isFinite(time) && time >= from && time < to ? time : from,
      controller: new AbortController(), audio: audioFactory(), listeners: [], timer: null, playing: false, timedOut: false };
    current = rec;
    // Invoked synchronously in the user's Play gesture: the host pauses its
    // library/music player here, before this controller can make any sound.
    try { beforePlay(); } catch (err) { fail(rec, err); throw err; }
    rec.audio.preload = "auto";
    rec.audio.loop = true;
    rec.audio.autoplay = false;
    rec.audio.playbackRate = 1;
    emit("preparing", "Preparing exact composition audio…");
    rec.timer = setTimer(() => { rec.timedOut = true; rec.controller.abort(); }, prepareTimeoutMs);
    try {
      const reply = await fetchFn("/api/vfx/audio-preview", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, signal: rec.controller.signal,
        body: JSON.stringify({ slug, expectedRevision: revision, from, to }) });
      if (!valid(rec)) throw abortError();
      const body = await reply.json();
      if (!valid(rec)) throw abortError();
      if (!reply.ok || !body?.ok) throw new Error(typeof body?.error === "string" ? body.error : "Audio preview preparation failed.");
      if (body.revision !== revision || typeof body.hasAudio !== "boolean" || body.from !== from || body.to !== to ||
          !Number.isFinite(body.duration) || Math.abs(body.duration - (to - from)) > 1e-6 ||
          (body.hasAudio ? typeof body.url !== "string" || !new RegExp(`^/api/vfx/audio-preview/${slug}/[a-f0-9]{64}\\.wav$`).test(body.url) : body.url !== null)) {
        throw new Error("The audio preview response does not match this composition revision.");
      }
      clearTimer(rec.timer); rec.timer = null;
      if (!body.hasAudio) {
        release(rec);
        current = null;
        emit("silent", "This work area has no audible media sources.");
        return { hasAudio: false };
      }
      listen(rec, "error", () => fail(rec, new Error("The prepared composition audio could not be played. Press Play to retry.")));
      const loaded = new Promise((resolve, reject) => {
        let settled = false;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          clearTimer(timer);
          offReady(); offError(); rec.controller.signal.removeEventListener("abort", cancelled);
          err ? reject(err) : resolve();
        };
        const offReady = listen(rec, "loadedmetadata", () => finish());
        const offError = listen(rec, "error", () => finish(new Error("Could not load composition audio.")));
        const cancelled = () => finish(abortError());
        rec.controller.signal.addEventListener("abort", cancelled, { once: true });
        const timer = setTimer(() => finish(new Error("Loading composition audio timed out.")), mediaTimeoutMs);
        rec.audio.src = body.url;
        rec.audio.load();
        if (rec.audio.readyState >= 1) finish();
      });
      await loaded;
      if (!valid(rec)) throw abortError();
      if (!Number.isFinite(rec.audio.duration) || Math.abs(rec.audio.duration - body.duration) > 0.1) {
        throw new Error("The prepared audio duration does not match the work area.");
      }
      rec.audio.currentTime = offset(rec, rec.desired);
      // Await browser permission/start before the visual clock starts. A blocked
      // autoplay promise is an explicit error, never a silent visual fallback.
      await rec.audio.play();
      if (!valid(rec)) { release(rec); throw abortError(); }
      rec.playing = true;
      emit("playing");
      return { hasAudio: true };
    } catch (original) {
      const err = rec.timedOut ? new Error("Preparing composition audio timed out. Use a shorter work area.") : original;
      if (current === rec && !disposed) {
        // An abort caused by the deadline is still a visible failure.
        if (rec.timedOut) {
          generation++; current = null; release(rec); emit("error", err.message); onError(err);
        } else if (valid(rec)) fail(rec, err);
      }
      throw err;
    }
  }
  function seek(time) {
    const rec = current;
    if (!rec) return false;
    if (!inRange(rec, time)) { pause(); return false; }
    rec.desired = time;
    if (rec.playing) {
      try { rec.audio.currentTime = offset(rec, time); }
      catch (err) { fail(rec, err); return false; }
    }
    return true;
  }
  function getTime() {
    const rec = current;
    if (!rec?.playing || !valid(rec) || !Number.isFinite(rec.audio.currentTime)) return null;
    return Math.min(rec.to, Math.max(rec.from, rec.from + rec.audio.currentTime));
  }
  function dispose() { pause(); disposed = true; }
  return { play, seek, pause, invalidate: pause, dispose, getTime };
}
