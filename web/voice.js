/* THE MIC BUTTON (Chat and My pages): say a prompt instead of typing it.
 *
 * Recorded in the browser (MediaRecorder, the way Hum a melody does it), sent
 * once to POST /api/voice, transcribed by the timed-lyrics whisper on Studio's
 * queue (server/voice.js). The words are ADDED to the box for the person to
 * read and edit; nothing is sent on their behalf. */
/* setup-feature.js is loaded only when a refusal names a setup: it touches the
 * page when it loads, and chat.js (which imports this) is also read by tests. */

const MAX_MS = 2 * 60_000;
const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
const WORDS = { idle: "Record your request", opening: "Opening microphone", rec: "Stop recording", busy: "Writing down what you said" };
const IDLE_TITLE = "Say it instead of typing. Whisper writes it into the box.";

/**
 * `button` holds the mic icon and a .sr-only label; `box` is the textarea the
 * words go into; `say(text, warn)` shows a status line; `after()` runs once
 * the box changed (resize it, repaint a Send button).
 */
export function wireMic(button, { box, say, after = () => {} }) {
  let rec = null;               // { recorder, stream, chunks, stopTimer, tick }
  let state = "idle";

  function paint(next) {
    state = next;
    button.dataset.state = state;
    button.setAttribute("aria-pressed", state === "rec" ? "true" : "false");
    button.disabled = state === "busy" || state === "opening";
    const label = button.querySelector(".sr-only");
    if (label) label.textContent = WORDS[state];
    button.title = state === "idle" ? IDLE_TITLE : WORDS[state];
  }

  const clearTimers = (mine) => { clearTimeout(mine.stopTimer); clearInterval(mine.tick); };
  const release = (stream) => { for (const track of stream?.getTracks() || []) { try { track.stop(); } catch { /* release the other tracks too */ } } };
  function failed(mine, stream, err) {
    if (mine) {
      mine.finished = true;
      clearTimers(mine);
      if (rec === mine) rec = null;
      try { if (mine.recorder.state !== "inactive") mine.recorder.stop(); } catch { /* already failed */ }
    }
    release(stream);
    paint("idle");
    say(`The microphone could not record: ${err?.message || err}`, true);
  }

  async function start() {
    if (state !== "idle") return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { say("This browser cannot record here.", true); return; }
    paint("opening");
    let stream, mine;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || "";
      const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const started = Date.now();
      mine = { recorder, stream, chunks: [], stopping: false, finished: false };
      rec = mine;
      recorder.ondataavailable = (e) => { if (e.data?.size) mine.chunks.push(e.data); };
      recorder.onstop = () => {
        if (mine.finished) return;
        mine.finished = true;
        clearTimers(mine); release(stream);
        if (rec === mine) rec = null;
        send(new Blob(mine.chunks, { type: recorder.mimeType || type || "audio/webm" }));
      };
      recorder.onerror = (e) => { if (!mine.finished) failed(mine, stream, e.error || new Error("Recording stopped.")); };
      recorder.start();
      mine.stopTimer = setTimeout(() => { if (rec === mine) stop(); }, MAX_MS);
      const tick = () => say(`Listening… ${Math.round((Date.now() - started) / 1000)} s. Press the mic again when you are done.`);
      tick(); mine.tick = setInterval(tick, 1000);
      paint("rec");
    } catch (err) { failed(mine, stream, err); }
  }

  function stop() {
    const mine = rec;
    if (!mine || mine.stopping || mine.finished) return;
    mine.stopping = true;
    paint("busy");
    clearTimers(mine);
    try { if (mine.recorder.state !== "inactive") mine.recorder.stop(); }
    catch (err) { failed(mine, mine.stream, err); }
    finally { release(mine.stream); }
  }

  async function send(blob) {
    rec = null;
    if (blob.size < 800) { paint("idle"); say("Nothing was recorded.", true); return; }
    paint("busy");
    say("Whisper is writing down what you said…");
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const r = await fetch("/api/voice", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: btoa(bin), type: blob.type }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) {
        if (d.setup) (await import("./setup-feature.js")).offerSetup(d.setup, d.error);
        throw new Error(d.error || `Studio answered ${r.status}.`);
      }
      const text = String(d.text || "").trim();
      if (!text) { say("Whisper heard no words. Try again a little closer to the mic.", true); return; }
      box.value = box.value.trim() ? `${box.value.trimEnd()} ${text}` : text;
      say("Added to the box. Check it, then send.");
      after();
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    } catch (err) {
      say(err.message, true);
    } finally {
      paint("idle");
    }
  }

  paint("idle");
  button.addEventListener("click", () => {
    if (state === "opening" || state === "busy") return;
    return rec ? stop() : start();
  });
}
