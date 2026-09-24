/**
 * ONE-CLICK SETUPS ON THE PAGE — [Set up timed lyrics], [Install what this
 * needs] and every other setup the server lists.
 *
 * Three places, one door (POST /api/setup, server/setup/routes.js):
 *   - Settings > Songs: #btnSetupLyrics (data-setup-feature="lyrics"), the
 *     "PyTorch build" choice beside it (data-setup-torch="lyrics") and the
 *     note under it (data-setup-note="lyrics");
 *   - the Models screen: paintSetupButtons() adds the button, and a note, to
 *     each row the server names as a setup's capability while it is not ready;
 *   - a refusal that carries a setup id (R0: `{ error, setup }`):
 *     offerSetup(r.setup, r.error) shows the refusal's first sentence and the
 *     server's offer, with the setup's own button and [Not now]. "Time the
 *     lyrics" sends "lyrics"; a missing OpenCV, librosa, soundfile or SciPy in
 *     Studio's own engine sends "studio-packages" (hum-to-score, the
 *     tokenizer, the compositor, the DAW); stem separation sends "stems".
 *     offerSetup knows none of them by name: title, button, offer and whether
 *     it is blocked or ready all come from the server's status for that id.
 *
 * NOTHING IS DECIDED HERE. Which rows get a button, whether the feature works,
 * whether a setup would change anything (blocked), the folder, the PyTorch
 * build and its words, the sizes and every sentence come from the server's
 * status; this file draws them and posts "run" with the build chosen. When a
 * job finishes, the interpreter it chose is written into the field that names
 * it (data-setup-python="lyrics", Settings' "timed lyrics python"), so that
 * field never shows a stale path beside the button that replaced it.
 * The same numbers are in MCP setup_status / setup_feature.
 */
import { appConfirm, appAlert } from "./dialog.js";

const post = async (body) => (await fetch("/api/setup", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
})).json();

let status = null;
let statusAt = 0;
let pollTimer = null;
const refreshers = new Set();
const running = new Set();

async function readStatus(force = false) {
  if (!force && status && Date.now() - statusAt < 5000) return status;
  try { status = await post({ action: "status" }); statusAt = Date.now(); } catch { /* server busy: keep the last */ }
  return status;
}
const setupOf = (id) => (status?.setups || []).find((s) => s.id === id) || null;
const sel = (attr, id) => document.querySelectorAll(`[${attr}="${CSS.escape(id)}"]`);

/** The PyTorch build chosen beside the button, or "auto" where there is no choice on screen. */
function torchOf(s) {
  for (const el of sel("data-setup-torch", s.id)) if (el.value && (s.torchChoices || []).includes(el.value)) return el.value;
  return "auto";
}
/** The server's sentence for the build that will be posted. */
const offerOf = (s) => s.blocked || s.offers?.[torchOf(s)] || s.offer;

/** The line under a button: the job while it runs, its last sentence, else the offer. */
function noteText(s) {
  if (s.blocked) return s.blocked;
  const j = s.job;
  if (j?.state === "running") {
    const tail = j.lines?.length ? ` · ${j.lines[j.lines.length - 1]}` : "";
    return `${j.label || "Starting"}… (step ${j.n || 0} of ${j.of})${tail}`;
  }
  if (j?.message) return j.message;
  return s.ready ? `${s.readyWords}: ${s.current}.` : offerOf(s);
}

function paintAll() {
  for (const el of document.querySelectorAll("[data-setup-feature]")) {
    const s = setupOf(el.dataset.setupFeature);
    if (!s) continue;
    const busy = s.job?.state === "running";
    el.disabled = busy || !!s.blocked;
    el.textContent = busy ? `Setting up… step ${s.job.n || 0} of ${s.job.of}` : s.button;
    el.title = offerOf(s);
  }
  for (const el of document.querySelectorAll("[data-setup-torch]")) {
    const s = setupOf(el.dataset.setupTorch);
    if (!s?.torchChoices) continue;
    const keep = el.value || "auto";
    /* Rebuilt only when the choices change, so a repaint never closes an open list. */
    if ([...el.options].map((o) => o.value).join() !== s.torchChoices.join()) {
      el.innerHTML = "";
      for (const t of s.torchChoices) {
        const o = document.createElement("option");
        o.value = t;
        el.appendChild(o);
      }
    }
    for (const o of el.options) o.textContent = s.torchBuilds?.[o.value] || o.value;
    el.value = s.torchChoices.includes(keep) ? keep : "auto";
    el.disabled = s.job?.state === "running" || !!s.blocked;
  }
  for (const note of document.querySelectorAll("[data-setup-note]")) {
    const s = setupOf(note.dataset.setupNote);
    if (!s) continue;
    note.textContent = noteText(s);
    note.classList.toggle("warn", s.job?.state === "failed" || !!s.blocked);
  }
}

/** A job has finished: the field naming the feature's python shows the one it chose. */
function adopt(job) {
  if (job?.state !== "done" || !job.python) return;
  for (const el of sel("data-setup-python", job.id)) el.value = job.python;
}

function finished(job) {
  adopt(job);
  for (const f of refreshers) { try { f(); } catch { /* a screen that is gone */ } }
  if (job?.message) appAlert(job.message);
}

/** Poll while a job runs; when one finishes, say so once and let the screens repaint. */
function poll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await readStatus(true);
    paintAll();
    for (const s of status?.setups || []) {
      if (s.job?.state === "running") { running.add(s.id); continue; }
      if (running.delete(s.id)) finished(s.job);
    }
    if (running.size) poll();
  }, 1500);
}

async function begin(s) {
  const r = await post({ action: "run", id: s.id, torch: torchOf(s) }).catch((e) => ({ error: e.message }));
  if (r?.error) { appAlert(r.error); return; }
  if (status?.setups) status = { ...status, setups: status.setups.map((x) => (x.id === s.id ? { ...x, job: r.job } : x)) };
  if (r.job?.state === "running") running.add(s.id);
  else finished(r.job);
  paintAll();
  poll();
}

/** A button press: the offer, then the job. Nothing to build is said, not asked. */
export async function startSetup(id) {
  await readStatus(true);
  const s = setupOf(id);
  if (!s) return;
  if (s.job?.state === "running") { paintAll(); poll(); return; }
  if (s.blocked) { appAlert(s.blocked); return; }
  if (s.ready) { appAlert(`${s.readyWords}: ${s.current}. Nothing needs setting up.`); return; }
  if (!(await appConfirm(offerOf(s), { title: `${s.button}?`, ok: s.button, cancel: "Not now" }))) return;
  await begin(s);
}

/** A refusal's first sentence, the one offerSetup shows (R0): cut at the
 *  first ". " outside parentheses, so a python path in them, such as
 *  (C:\Users\J. Carr\…\python.exe), is not cut in half. Unbalanced
 *  parentheses fall back to the plain split. */
export function firstSentence(text) {
  const s = String(text || "");
  let depth = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "." && depth === 0 && /\s/.test(s[i + 1])) return s.slice(0, i + 1);
  }
  return depth > 0 ? s.split(/(?<=\.)\s/)[0] : s;
}

/** A refusal that names a setup (the door answers { error, setup }), for any
 *  id the server lists. `lead` goes before it: a batch says how many were
 *  not queued. An unknown, blocked or ready setup is said, not offered; one
 *  already running (started from another screen, or by an agent) is shown
 *  with its progress instead of being offered twice. */
export async function offerSetup(id, message, { lead = "" } = {}) {
  await readStatus(true);
  const s = setupOf(id);
  const first = firstSentence(message);
  if (!s || s.blocked || s.ready) { appAlert(`${lead ? `${lead} ` : ""}${s?.blocked || message}`); return; }
  if (s.job?.state === "running") {
    running.add(s.id);
    paintAll();
    poll();
    appAlert(`${lead ? `${lead} ` : ""}${first}\n\n${noteText(s)}`);
    return;
  }
  if (!(await appConfirm(`${lead ? `${lead} ` : ""}${first}\n\n${offerOf(s)}`, { title: s.title, ok: s.button, cancel: "Not now" }))) return;
  await begin(s);
}

/** The Models screen, after each repaint: a button and a note on every row a
 *  setup serves, while the server says the feature does not work yet. */
export async function paintSetupButtons(root, { refresh } = {}) {
  if (typeof refresh === "function") refreshers.add(refresh);
  await readStatus();
  if (!root?.querySelector) return;
  for (const s of status?.setups || []) {
    if (!s.capability || s.blocked || (s.ready && s.job?.state !== "running")) continue;
    const card = root.querySelector(`.modelcard[data-cap="${CSS.escape(s.capability)}"]`);
    if (!card || card.querySelector("[data-setup-feature]")) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn sm";
    btn.dataset.setupFeature = s.id;
    btn.textContent = s.button;
    (card.querySelector(".mfoot") || card).appendChild(btn);
    const note = document.createElement("p");
    note.className = "hint";
    note.dataset.setupNote = s.id;
    card.appendChild(note);
  }
  paintAll();
  if ((status?.setups || []).some((s) => s.job?.state === "running")) {
    for (const s of status.setups) if (s.job?.state === "running") running.add(s.id);
    poll();
  }
}

document.addEventListener("click", (e) => {
  const b = e.target?.closest?.("[data-setup-feature]");
  if (!b || b.disabled) return;
  e.preventDefault();
  startSetup(b.dataset.setupFeature);
});
/* A different PyTorch build changes the sentence under the button at once. */
document.addEventListener("change", (e) => {
  if (e.target?.closest?.("[data-setup-torch]")) paintAll();
});

/* Settings > Songs shows its note from the first status; a job already
 * running (started from MCP, or before a reload) is picked up here too. */
readStatus().then(() => {
  paintAll();
  for (const s of status?.setups || []) if (s.job?.state === "running") running.add(s.id);
  if (running.size) poll();
}).catch(() => {});
