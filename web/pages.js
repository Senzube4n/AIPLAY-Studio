/* My pages (server/pages.js): build a small page with an AI model, run it in a
 * sandbox, keep every version, export it as a file.
 *
 * THE SANDBOX. A page is someone's AI-written (or imported) code, so it runs in
 * an iframe with sandbox="allow-scripts" and no allow-same-origin: an opaque
 * origin, so it cannot read Studio's routes, and Studio refuses its POSTs
 * (server/index.js refuses other origins). A Content-Security-Policy inside the
 * frame blocks the internet. What it may know comes through window.studio,
 * answered here from postMessage: songs and pictures (read only), the songs'
 * and pictures' own bytes (so Web Audio and canvas work on them), and the
 * page's own saved data. */
import { appConfirm, appAlert } from "./dialog.js";
import { wireMic } from "./voice.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const post = async (body) => {
  const r = await fetch("/api/pages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || `Studio answered ${r.status}.`);
  return d;
};
const getJson = async (url) => {
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw Object.assign(new Error(d.error || `Studio answered ${r.status}.`), { status: r.status });
  return d;
};

let wired = false;
let current = null;            // the open page: { id, name, version, versions, html }
let busy = false;
let pageErrors = [];           // what the running version has reported, sent with the next request
let selection = 0;             // newer navigation wins over an older response
let listing = 0;
let opening = 0;
let activeBuild = null;
const deleting = new Set();
const selected = (target) => current?.id === target.id && selection === target.selection && !deleting.has(target.id);

/* ── the frame ──────────────────────────────────────────────────────────── */

/* The page is served by Studio (server/pages.js, GET /api/pages/<id>/shell
 * and /frame): the rules are response headers its markup cannot move, the
 * bridge (window.studio) is written ahead of the page's own code, and the
 * wrapper stops the page navigating anywhere outside Studio. */
function showFrame() {
  pageErrors = [];
  paintErrors();
  if (!current) return;
  $("mpFrame").src = `/api/pages/${encodeURIComponent(current.id)}/shell?v=${current.version}&t=${Date.now()}`;
  /* Listen on the new wrapper as soon as it exists, not at its load event
   * (which waits for the page inside). The bridge says hello until answered,
   * so nothing it sends early is lost either way. */
  const until = Date.now() + 10_000;
  const poll = setInterval(() => { if (attachToWrapper() || Date.now() > until) clearInterval(poll); }, 30);
}

/* Keyed by the wrapper's DOCUMENT: the frame's window object stays the same
 * across loads while its listeners do not, so a new document needs a new one. */
const attached = new WeakSet();
function attachToWrapper() {
  try {
    const win = $("mpFrame").contentWindow;
    if (!win || win.location.href !== $("mpFrame").src) return false;   // still the previous page
    if (!attached.has(win.document)) { attached.add(win.document); win.addEventListener("message", onBridgeMessage); }
    return true;
  } catch { return false; }
}

function paintErrors() {
  const has = pageErrors.length > 0;
  $("mpErr").hidden = !has;
  $("mpFix").hidden = !has;
  $("mpErr").textContent = has
    ? `The page hit ${pageErrors.length === 1 ? "an error" : `${pageErrors.length} errors`}: ${pageErrors.at(-1)}${pageErrors.length > 1 ? " (all of them go with your next request)" : ""}`
    : "";
}

/* The bridge's answers, only ever to our own frame. */
async function bridgeAnswer(op, args = {}) {
  if (op === "songs") {
    const s = await getJson("/api/status");
    return (s.library || []).map((t) => ({
      file: t.file, title: t.title || t.file, caption: t.caption || "", lyrics: t.lyrics || "",
      durationSeconds: t.durationSeconds ?? null, engine: t.engine || null, createdAt: t.at || t.mtime || null,
    }));
  }
  if (op === "images") {
    const d = await getJson("/api/images");
    return (d.images || []).map((im) => ({
      name: im.name, prompt: im.meta?.prompt || "", width: im.meta?.width ?? null, height: im.meta?.height ?? null, createdAt: im.at || null,
    }));
  }
  if (op === "audio" || op === "image") {
    const r = await fetch(`/api/${op}/${encodeURIComponent(String(args.name || ""))}`);
    if (!r.ok) throw new Error(`No ${op === "audio" ? "song" : "picture"} called "${args.name}".`);
    return { data: await r.arrayBuffer(), type: r.headers.get("content-type") || "" };
  }
  if (op === "data-get") return (await post({ action: "data-get", id: current.id, key: args.key })).value;
  if (op === "data-set") { await post({ action: "data-set", id: current.id, key: args.key, value: args.value }); return null; }
  throw new Error(`Unknown bridge call "${op}".`);
}

/* The page's bridge messages arrive at the WRAPPER's window (server/pages.js
 * shellHtml: the page's parent), which is Studio's own origin, so the
 * listener is added there each time a wrapper loads. Only the page inside
 * the wrapper is answered. */
const pageWindow = () => { try {
  const frame = $("mpFrame");
  if (frame.contentWindow?.location.href !== frame.src) return null;
  return frame.contentDocument?.getElementById("f")?.contentWindow || null;
} catch { return null; } };
async function onBridgeMessage(e) {
  const inner = pageWindow();
  if (!inner || e.source !== inner) return;
  const d = e.data;
  if (!d || d.aiplayBridge !== 1) return;
  if (d.op === "hello") { e.source.postMessage({ aiplayBridge: 1, op: "ready" }, "*"); return; }
  if (d.op === "error") {
    if (!pageErrors.includes(d.message) && pageErrors.length < 8) pageErrors.push(d.message);
    paintErrors();
    return;
  }
  try {
    const result = await bridgeAnswer(d.op, d.args);
    /* The bytes are handed over, not copied. */
    e.source.postMessage({ aiplayBridge: 1, id: d.id, result }, "*", result?.data instanceof ArrayBuffer ? [result.data] : []);
  } catch (err) {
    e.source.postMessage({ aiplayBridge: 1, id: d.id, error: String(err?.message || err) }, "*");
  }
}

/* ── list and open ──────────────────────────────────────────────────────── */

const say = (text, warn = false) => { $("mpNote").textContent = text; $("mpNote").classList.toggle("warnhint", warn); };

async function refresh(openId = current?.id, expected = selection, reopen = true) {
  const request = ++listing;
  let d;
  try { d = await getJson("/api/pages"); }
  catch (err) { if (request === listing) $("mpPages").innerHTML = `<li class="hint">${esc(err.message)}</li>`; return null; }
  if (request !== listing) return null;
  const shownId = expected === selection && reopen ? openId : current?.id;
  $("mpPages").innerHTML = d.pages.map((p) => `<li><button type="button" class="mp-item${p.id === shownId ? " on" : ""}" data-mp="${esc(p.id)}"
      aria-current="${p.id === shownId ? "true" : "false"}"><b>${esc(p.name)}</b><span>${p.versions} version${p.versions === 1 ? "" : "s"}</span></button></li>`).join("");
  $("mpEmpty").hidden = d.pages.length > 0;
  engineOff = !!d.engineOff;
  paintModels(d.models);
  if (!reopen || expected !== selection) return null;
  if (openId && d.pages.some((p) => p.id === openId)) return open(openId, null, false, expected);
  if (d.pages[0]) return open(d.pages[0].id, null, true, expected);
  current = null; selection++; pageErrors = []; paintErrors();
  $("mpMain").hidden = true; setFull(false);
  return null;
}

async function open(id, v = null, list = true, expected = selection) {
  if (expected !== selection || deleting.has(id)) return null;
  const request = ++opening, view = list ? ++selection : selection;
  let page;
  try { page = await getJson(`/api/pages/${encodeURIComponent(id)}${v ? `?v=${v}` : ""}`); }
  catch (err) { if (request === opening && view === selection) say(err.message, true); return null; }
  if (request !== opening || view !== selection || deleting.has(id)) return null;
  current = page;
  $("mpMain").hidden = false;
  $("mpName").value = current.name;
  $("mpVersion").innerHTML = current.versions.slice().reverse().map((x) =>
    `<option value="${x.n}">v${x.n} · ${esc(new Date(x.at).toLocaleString())}${x.note ? ` · ${esc(x.note.slice(0, 50))}` : ""}</option>`).join("");
  $("mpVersion").value = String(current.version);
  $("mpCode").value = current.html;
  showFrame();
  say("");
  $("mpLive").hidden = true; $("mpTimer").hidden = true;
  paintGo();
  if (list) for (const b of document.querySelectorAll("#mpPages [data-mp]")) {
    const on = b.dataset.mp === id;
    b.classList.toggle("on", on);
    b.setAttribute("aria-current", on ? "true" : "false");
  }
  return view;
}

/* ── the model menu ─────────────────────────────────────────────────────── */

const ADD = "__add";
const MODEL_KEY = "aiplay.mypages.model";
const remembered = () => { try { return localStorage.getItem(MODEL_KEY) || ""; } catch { return ""; } };
const remember = (v) => { try { localStorage.setItem(MODEL_KEY, v); } catch { /* a convenience only */ } };

/* The connected APIs, the engine's own models, then one row that opens the
 * "another model" box. With the engine off its models cannot be listed: a
 * greyed row says so rather than leaving them silently missing. */
let engineOff = false;
function paintModels(models, want = $("mpModel").value || remembered()) {
  const sel = $("mpModel");
  const opts = (rows) => rows.map((m) => `<option value="${esc(m.value)}">${esc(m.label)}</option>`).join("");
  const api = models.filter((m) => m.group !== "local"), local = models.filter((m) => m.group === "local");
  sel.innerHTML = (models.length ? "" : `<option value="">Pick a model first</option>`)
    + (api.length ? `<optgroup label="API">${opts(api)}</optgroup>` : "")
    + (local.length ? `<optgroup label="Studio engine · this PC">${opts(local)}</optgroup>`
      : engineOff ? `<optgroup label="Studio engine · this PC"><option value="" disabled>Start the engine to list its models</option></optgroup>` : "")
    + `<option value="${ADD}">+ Another model or API key…</option>`;
  sel.value = models.some((m) => m.value === want) ? want : models[0]?.value || "";
  sel.dataset.last = sel.value;
  paintGo();
}

async function reloadModels(want) {
  try { const d = await getJson("/api/pages"); engineOff = !!d.engineOff; paintModels(d.models, want); } catch { /* the menu keeps what it had */ }
}

function paintGo() {
  const m = $("mpModel").value;
  const can = !!current && !busy && !!m && m !== ADD && $("mpAsk").value.trim().length > 0;
  $("mpGo").disabled = !can;
  $("mpGo").textContent = busy ? "Building…" : current && current.versions.length > 1 ? "Change it" : "Build";
}

/* ── another model: a cloud key, or a server on this PC ─────────────────── */

let providers = [];
let mdProvider = null;              // the provider just connected, while its model is picked

async function openModelDialog() {
  const note = $("mpMdNote");
  note.hidden = true;
  $("mpMdStep1").hidden = false; $("mpMdStep2").hidden = true;
  $("mpMdGo").textContent = "Connect"; $("mpMdGo").disabled = false;
  $("mpKey").value = "";
  try { providers = (await getJson("/api/llm")).providers || []; }
  catch (err) { await appAlert(err.message); return; }
  /* The PC's own server first: free, and the person may already run one. */
  const rows = [...providers].sort((a, b) => (b.custom - a.custom));
  $("mpProv").innerHTML = rows.map((p) => `<option value="${esc(p.id)}">${esc(p.custom ? "On this PC: LM Studio, Ollama or another server" : `${p.name} (${p.company})`)}${p.connected ? " · connected" : ""}</option>`).join("");
  $("mpProv").value = rows[0]?.id || "";
  paintProvider();
  $("mpModelDlg").showModal();
  $("mpProv").focus();
}

function paintProvider() {
  const p = providers.find((x) => x.id === $("mpProv").value);
  if (!p) return;
  $("mpMdLocal").hidden = !p.custom;
  $("mpMdCloud").hidden = !!p.custom;
  $("mpKeyOpt").hidden = !p.keyOptional;
  $("mpKey").placeholder = p.connected && !p.custom ? `Saved: ${p.hint || "a key"}. Paste a new one to replace it` : (p.keyHint || "Paste your key");
  $("mpKey").required = !p.keyOptional && !p.connected;
  $("mpBase").required = !!p.custom;
  if (p.custom) $("mpBase").value = p.base || $("mpBase").value || "";
  if (p.keyUrl) { $("mpKeyLink").href = p.keyUrl; $("mpKeyLink").textContent = `Get a ${p.name} key ↗`; }
  $("mpMdNote").hidden = true;
}

const mdSay = (text) => { $("mpMdNote").textContent = text; $("mpMdNote").hidden = !text; };

async function llm(body) {
  const r = await fetch("/api/llm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || `Studio answered ${r.status}.`);
  return d;
}

async function useModel(id) {
  $("mpModelDlg").close();
  remember(`api:${id}`);
  await reloadModels(`api:${id}`);
  document.dispatchEvent(new CustomEvent("aiplay:llm-changed"));
  say("Model ready. Describe the page and press Build.");
  if (!busy) setMini(false);
}

async function submitModelDialog() {
  const go = $("mpMdGo");
  if (!$("mpMdStep2").hidden) {
    go.disabled = true;
    try { await llm({ action: "model", provider: mdProvider, model: $("mpPick").value }); await useModel(mdProvider); }
    catch (err) { mdSay(err.message); }
    finally { go.disabled = false; }
    return;
  }
  const p = providers.find((x) => x.id === $("mpProv").value);
  if (!p) return;
  const key = $("mpKey").value.trim();
  /* A provider already connected needs no new key: just pick its model. */
  const keepKey = p.connected && !p.custom && !key;
  go.disabled = true; go.textContent = "Checking…"; mdSay("");
  try {
    let current = p.model;
    if (!keepKey) {
      const r = await llm({ action: "connect", provider: p.id, key, base: p.custom ? $("mpBase").value.trim() : undefined });
      $("mpKey").value = "";
      current = r.model;
      if (!r.checked) mdSay("Saved, but the provider could not be reached to check it.");
    }
    let models = [];
    try { models = (await getJson(`/api/llm/models?provider=${encodeURIComponent(p.id)}`)).models || []; } catch { /* checked below */ }
    if (!models.length && !current) {
      mdSay(p.custom ? "Connected, but the server lists no models. Load one in LM Studio or Ollama, then try again." : "Connected, but no model was listed. Pick one on the Agent page.");
      return;
    }
    if (models.length <= 1) { await useModel(p.id); return; }
    /* Several models: the person picks, newest last, the current one chosen. */
    mdProvider = p.id;
    $("mpPick").innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}${m.label !== m.id ? `: ${esc(m.id)}` : ""}</option>`).join("");
    $("mpPick").value = models.some((m) => m.id === current) ? current : models.at(-1).id;
    $("mpMdStep1").hidden = true; $("mpMdStep2").hidden = false;
    go.textContent = "Use this model";
    $("mpPick").focus();
  } catch (err) {
    mdSay(err.message);
  } finally {
    go.disabled = false;
    if (!$("mpMdStep1").hidden) go.textContent = "Connect";
  }
}

/* ── the request box and its pencil ─────────────────────────────────────── */

/* Folded = only the pencil shows. While the model writes the box folds by
 * itself; the pencil opens it to show what was asked, greyed and read only. */
function setMini(on, focus = true) {
  const stage = $("mpStage");
  stage.classList.toggle("mp-mini", on);
  $("mpPencil").hidden = !on;
  $("mpPencil").setAttribute("aria-expanded", on ? "false" : "true");
  $("mpTimer").hidden = !(on && busy);
  if (!on && !busy && focus) $("mpAsk").focus();
}

function setBusy(on, focus = true) {
  busy = on;
  $("mpStage").classList.toggle("mp-busy", on);
  $("mpAsk").readOnly = on;
  $("mpModel").disabled = on;
  $("mpPencilSay").textContent = on ? "The model is writing the page. Show what you asked." : "Show the request box";
  $("mpPencil").title = on ? "Writing… click to see what you asked" : "Show the request box";
  if (on) setMini(true); else { $("mpTimer").hidden = true; $("mpLive").hidden = true; setMini(false, focus); }
  paintGo();
}

/* ── building ───────────────────────────────────────────────────────────── */

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

/* THE LIVE VIEW. The answer streams in (server/pages.js, one JSON line per
 * piece): what the model is thinking, when it sends that, and the page as it
 * writes it. Shown in the request box, which the pencil opens. */
const live = { think: "", write: "", note: "", queued: false };
function paintLive() {
  if (live.queued) return;
  live.queued = true;
  requestAnimationFrame(() => {
    live.queued = false;
    if (!activeBuild || !selected(activeBuild)) { $("mpLive").hidden = true; return; }
    const show = (id, text) => { const el = $(id); el.hidden = !text; el.textContent = text.slice(-1500); el.scrollTop = el.scrollHeight; };
    show("mpThink", live.think);
    show("mpWrite", live.write);
    $("mpThinkLabel").hidden = !live.think;
    $("mpWriteLabel").hidden = !live.write;
    $("mpLiveNote").hidden = !live.note;
    $("mpLiveNote").textContent = live.note;
    $("mpLive").hidden = !busy || !(live.think || live.write || live.note);
  });
}

async function generate(target, request, errors) {
  const started = Date.now();
  Object.assign(live, { think: "", write: "", note: "" });
  paintLive();
  const clock = () => {
    if (!selected(target)) return;
    const s = Math.round((Date.now() - started) / 1000);
    const doing = live.write ? `Writing the page · ${(live.write.length / 1000).toFixed(1)}k characters` : live.think ? "Thinking" : "Waiting for the model";
    say(`${doing}… ${s} s`);
    $("mpTimer").textContent = `${doing.split(" · ")[0].replace(" the page", "")}… ${s} s`;
  };
  clock();
  const tick = setInterval(clock, 1000);
  try {
    const r = await fetch("/api/pages", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "generate", stream: true, id: target.id, model: target.model, request, errors }) });
    if (!r.ok || !r.body) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `Studio answered ${r.status}.`);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", done = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const lineText = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!lineText.trim()) continue;
        const ev = JSON.parse(lineText);
        if (ev.type === "thinking") live.think += ev.text || "";
        else if (ev.type === "text") live.write += ev.text || "";
        else if (ev.type === "note") live.note = ev.text || "";
        else if (ev.type === "done") done = ev;
        else if (ev.type === "error") throw new Error(ev.error);
      }
      paintLive();
    }
    if (!done) throw new Error("The model stopped before the page was saved. Try again.");
    return { ...done, seconds: Math.round((Date.now() - started) / 1000) };
  } finally { clearInterval(tick); }
}

async function build() {
  if (!current || busy || deleting.has(current.id)) return;
  const target = { id: current.id, selection, model: $("mpModel").value };
  const request = $("mpAsk").value, errors = pageErrors.slice();
  activeBuild = target;
  setBusy(true);
  let built = false;
  try {
    const r = await generate(target, request, errors);
    built = true;
    if (!selected(target)) return;
    const opened = await refresh(target.id, target.selection);
    if (!opened || current?.id !== target.id || current.version !== r.version) return;
    target.selection = opened;
    /* ONE automatic repair: a new version that throws while it starts is sent
     * straight back with its errors, rather than leaving the person to ask. */
    await waitMs(3000);
    if (!selected(target) || current.version !== r.version) return;
    if (pageErrors.length) {
      say(`v${r.version} hit an error while starting. Asking the model to fix it (once)…`, true);
      const fix = await generate(target, "The page you just wrote throws the errors listed above when it starts. Fix them, change nothing else.", pageErrors.slice());
      if (!selected(target)) return;
      const repaired = await refresh(target.id, target.selection);
      if (!repaired || current?.id !== target.id || current.version !== fix.version) return;
      target.selection = repaired;
      await waitMs(3000);
      if (!selected(target) || current.version !== fix.version) return;
      say(pageErrors.length
        ? `Fixed once as v${fix.version}, but it still reports an error. Describe what you see, or pick an older version.`
        : `Built and repaired: v${fix.version}. The version list goes back.`, pageErrors.length > 0);
    } else {
      say(`Done in ${r.seconds} s. Saved as v${r.version}; the version list goes back.`);
    }
  } catch (err) {
    if (selected(target)) {
      let missing = false;
      try { await getJson(`/api/pages/${encodeURIComponent(target.id)}`); }
      catch (check) { missing = check.status === 404; }
      if (missing) await refresh(target.id, target.selection);
      else if (selected(target)) say(err.message, true);
    }
  } finally {
    /* A failed request stays in the box to try again; a built one is cleared. */
    const stillHere = selected(target);
    if (built && stillHere) $("mpAsk").value = "";
    activeBuild = null;
    setBusy(false, stillHere);
  }
}

/* ── full screen ────────────────────────────────────────────────────────── */

/* The page fills the window; the controls fold into one button at the bottom. */
function setFull(on) {
  const root = $("mypages");
  root.classList.toggle("mp-full", on);
  $("mpFullBtn").hidden = !on;
  $("mpFullMenu").hidden = true;
  $("mpFullBtn").setAttribute("aria-expanded", "false");
  $("mpExpand").setAttribute("aria-pressed", on ? "true" : "false");
  if (on) $("mpFullBtn").focus();
}

/* ── export and import ──────────────────────────────────────────────────── */

function exportPage() {
  if (!current) return;
  $("mpLicence").checked = false;
  $("mpExportGo").disabled = true;
  $("mpExportDlg").showModal();
}

async function writeExport() {
  const name = current.name;
  const author = $("mpAuthor").value.trim().slice(0, 80);
  const year = new Date().getFullYear();
  const file = {
    format: "aiplay-page", formatVersion: 1, name, author, licence: "Apache-2.0",
    licenceNotice: `Copyright ${year} ${author || "the author"}. Licensed under the Apache License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0`,
    exportedAt: new Date().toISOString(), html: current.html,
  };
  const text = JSON.stringify(file, null, 2);
  const suggested = `${name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "page"}.aiplay-page.json`;
  /* Save where the person chooses when the browser can ask; a download otherwise. */
  if (typeof window.showSaveFilePicker === "function") {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: suggested, types: [{ description: "AIPLAY page", accept: { "application/json": [".json"] } }] });
      const w = await h.createWritable(); await w.write(text); await w.close();
      return true;
    } catch (err) { if (err?.name === "AbortError") return false; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = suggested;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return true;
}

async function importFile(file) {
  if (!file) return;
  let parsed;
  try { parsed = JSON.parse(await file.text()); }
  catch { await appAlert("That file is not an AIPLAY page file."); return; }
  const who = parsed?.author ? ` by ${parsed.author}` : "";
  const ok = await appConfirm(`Import “${String(parsed?.name || "a page").slice(0, 60)}”${who}? `
    + "It can read your song and picture libraries and keep its own saved data. It runs without internet access.",
  { title: "Import a page", ok: "Import" });
  if (!ok) return;
  const expected = ++selection;
  try { const meta = await post({ action: "import", file: parsed }); if (await refresh(meta.id, expected)) say("Imported."); }
  catch (err) { await appAlert(err.message); }
}

/* ── wiring ─────────────────────────────────────────────────────────────── */

async function newPage() {
  const expected = ++selection;
  try { const meta = await post({ action: "create", name: "My page" }); if (await refresh(meta.id, expected) && !busy) setMini(false); }
  catch (err) { if (expected === selection) say(err.message, true); }
}
async function deletePage() {
  if (!current) return;
  const target = { id: current.id, selection }, name = current.name;
  if (deleting.has(target.id)) return;
  if (!(await appConfirm(`Delete “${name}” and all its versions? Export it first if you want a copy.`,
    { title: "Delete page", ok: "Delete", tone: "danger" }))) return;
  if (deleting.has(target.id)) return;
  deleting.add(target.id);
  try {
    await post({ action: "delete", id: target.id });
    if (current?.id === target.id && selection === target.selection) {
      current = null; selection++; setFull(false);
      await refresh(null); say("");
    } else await refresh(current?.id, selection, false);
  } catch (err) { if (current?.id === target.id && selection === target.selection) say(err.message, true); }
  finally { deleting.delete(target.id); }
}
const reload = () => current && showFrame();

function wire() {
  wired = true;
  $("mpNew").onclick = newPage;
  $("mpImport").onchange = (e) => { importFile(e.target.files?.[0]); e.target.value = ""; };
  $("mpPages").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mp]");
    if (b) open(b.dataset.mp);
  });
  $("mpVersion").onchange = () => current && open(current.id, $("mpVersion").value);
  $("mpName").onchange = async () => {
    if (!current) return;
    const target = { id: current.id, selection }, name = $("mpName").value;
    try { const r = await post({ action: "rename", id: target.id, name }); if (selected(target)) { current.name = r.name; await refresh(target.id, target.selection); } }
    catch (err) { if (selected(target)) say(err.message, true); }
  };
  $("mpAsk").addEventListener("input", paintGo);
  $("mpAsk").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!$("mpGo").disabled) build(); } });
  $("mpModel").onchange = () => {
    const sel = $("mpModel");
    if (sel.value === ADD) { sel.value = sel.dataset.last || ""; openModelDialog(); }
    else { sel.dataset.last = sel.value; if (sel.value) remember(sel.value); }
    paintGo();
  };
  $("mpGo").onclick = build;
  wireMic($("mpMic"), { box: $("mpAsk"), say, after: paintGo });
  $("mpMin").onclick = () => { setMini(true); $("mpPencil").focus(); };
  $("mpPencil").onclick = () => setMini(false);
  $("mpProv").onchange = paintProvider;
  $("mpMdForm").addEventListener("submit", (e) => { e.preventDefault(); submitModelDialog(); });
  $("mpMdCancel").onclick = () => $("mpModelDlg").close();
  /* A key added or removed on the Agent page shows up here without a reload. */
  document.addEventListener("aiplay:llm-changed", () => reloadModels());
  $("mpFrame").addEventListener("load", attachToWrapper);
  $("mpFix").onclick = () => {
    $("mpAsk").value = "Fix the errors the page reports.";
    paintGo(); $("mpAsk").focus();
  };
  $("mpReload").onclick = reload;
  $("mpSaveCode").onclick = async () => {
    if (!current) return;
    const target = { id: current.id, selection }, html = $("mpCode").value;
    try { const r = await post({ action: "save", id: target.id, html }); if (selected(target)) { const opened = await refresh(target.id, target.selection); if (opened && current?.id === target.id) say(`Saved as v${r.version}.`); } }
    catch (err) { if (selected(target)) say(err.message, true); }
  };
  $("mpDelete").onclick = deletePage;
  $("mpExport").onclick = exportPage;
  $("mpLicence").onchange = () => { $("mpExportGo").disabled = !$("mpLicence").checked; };
  $("mpExportCancel").onclick = () => $("mpExportDlg").close();
  $("mpExportGo").onclick = async () => {
    if (!$("mpLicence").checked) return;
    const saved = await writeExport();
    if (saved) { $("mpExportDlg").close(); say("Exported."); }
  };
  /* Full screen and its one button. */
  $("mpExpand").onclick = () => setFull(!$("mypages").classList.contains("mp-full"));
  $("mpFullBtn").onclick = () => {
    const open = $("mpFullMenu").hidden;
    $("mpFullMenu").hidden = !open;
    $("mpFullBtn").setAttribute("aria-expanded", open ? "true" : "false");
    if (open) $("mpFullMenu").querySelector("button")?.focus();
  };
  $("mpFullMenu").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mpdo]");
    if (!b) return;
    $("mpFullMenu").hidden = true;
    $("mpFullBtn").setAttribute("aria-expanded", "false");
    ({ exit: () => setFull(false), reload, export: exportPage, delete: deletePage, new: newPage,
      import: () => $("mpImport").click() })[b.dataset.mpdo]?.();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !$("mypages").classList.contains("mp-full") || $("mpExportDlg").open || $("mpModelDlg").open) return;
    if (!$("mpFullMenu").hidden) { $("mpFullMenu").hidden = true; $("mpFullBtn").focus(); }
    else setFull(false);
  });
}

/** Called each time the My pages screen opens (web/app.js setView). */
export function initPages() {
  if (!$("mypages")) return;
  if (!wired) wire();
  if (pendingIdea) { const idea = pendingIdea; pendingIdea = null; startIdea(idea); }
  else refresh();
}

/* ── ideas from elsewhere (the Chat screen's cards) ─────────────────────── */

/* A card in Chat (web/page-ideas.js) carries data-go="mypages" (app.js switches the view) and
 * data-page-idea. This listener is added when the module loads, before
 * app.js's, so the idea is waiting when initPages runs: a new page, the
 * idea in its box, NOT built. The person improves it or presses Build. */
let pendingIdea = null;
document.addEventListener("click", (e) => {
  const card = e.target.closest("[data-page-idea]");
  if (card) pendingIdea = card.dataset.pageIdea;
});

async function startIdea(text) {
  if (busy) { say("A page is being built. Try the idea again when it is done.", true); return; }
  const expected = ++selection;
  try {
    const meta = await post({ action: "create", name: "My page" });
    if (!await refresh(meta.id, expected)) return;
    if (!busy) setMini(false);
    const box = $("mpAsk");
    box.value = text;
    paintGo();
    box.focus();
    box.setSelectionRange(text.length, text.length);
    say("An idea from Chat. Change anything you like, then press Build.");
  } catch (err) { if (expected === selection) say(err.message, true); }
}
