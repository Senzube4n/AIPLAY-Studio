/**
 * FAST COVERS in the page: the Settings > Experimental switch and its chip,
 * and the first-run question (server/fastcover.js has the why).
 *
 * The question is asked once, in Studio's own window (dialog.js appToggle),
 * with the switch already on: OK keeps it on and Studio sets it up by itself;
 * switching it off keeps covers on the covers engine. The answer is stored on
 * the server (config.art.fastCoversAsked), not in this browser, so another
 * browser or an MCP client sees the same state.
 */
import { appToggle } from "./dialog.js";

const $ = (id) => document.getElementById(id);
const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
let polling = null;
let asking = false;

async function api(method, body) {
  const r = await fetch("/api/fastcovers", method === "GET" ? {} : {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/** The chip and its one line: the state in a few words. */
export function fastCoversChip(s) {
  if (!s?.enabled) return { tone: "", text: "Off", note: "" };
  if (s.ready) return { tone: "ok", text: "Ready", note: "" };
  if (s.error) return { tone: "err", text: "Not set up", note: s.error };
  if (s.downloading) {
    const pct = s.downloading.totalBytes ? Math.floor(100 * s.downloading.receivedBytes / s.downloading.totalBytes) : null;
    return { tone: "busy", text: pct === null ? "Downloading…" : `Downloading ${pct}%`, note: "" };
  }
  if (s.settingUp) return { tone: "busy", text: s.settingUp.n && s.settingUp.of ? `Setting up ${s.settingUp.n}/${s.settingUp.of}` : "Setting up…", note: "" };
  if (!s.asked) return { tone: "warn", text: "Not answered", note: "" };
  return { tone: "busy", text: "Starting…", note: "" };
}

function paint(s) {
  const sel = $("qFastCovers");
  if (sel && document.activeElement !== sel) sel.value = s.enabled ? "1" : "0";
  const chip = $("fastCoversChip");
  const c = fastCoversChip(s);
  if (chip) {
    chip.hidden = !c.text;
    chip.className = `chip ${c.tone}`.trim();
    chip.textContent = c.text;
  }
  const note = $("fastCoversNote");
  if (note) { note.hidden = !c.note; note.textContent = c.note; }
  const working = s.enabled && s.asked && !s.ready && !s.error;
  if (working && !polling) polling = setInterval(refresh, 3000);
  if (!working && polling) { clearInterval(polling); polling = null; }
}

async function refresh() {
  try { paint(await api("GET")); } catch { /* the next refresh tries again */ }
}

async function set(enabled) {
  try { paint(await api("POST", { enabled })); } catch (e) {
    const note = $("fastCoversNote");
    if (note) { note.hidden = false; note.textContent = e.message; }
  }
}

/* Asked once, a moment after the page is up, so it does not land on top of
 * the page drawing itself. */
async function askOnce(s) {
  if (s.asked || asking) return;
  asking = true;
  const on = await appToggle(
    `Studio can draw a small cover for every song on your processor, in seconds, instead of the bigger picture models. `
      + `It sets itself up and downloads about ${gb(s.totalBytes || 1.75e9)}.\n\nChange it any time in Settings, Experimental.`,
    { title: "Fast covers", label: "Fast covers on", checked: true });
  await set(on !== false);
  asking = false;
}

async function start() {
  const sel = $("qFastCovers");
  if (sel) sel.onchange = () => set(sel.value === "1");
  let s;
  try { s = await api("GET"); } catch { return; }
  paint(s);
  if (!s.asked) setTimeout(() => askOnce(s), 1500);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}
