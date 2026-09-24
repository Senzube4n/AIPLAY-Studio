/**
 * THE COMFY API PAGE (launcher: "Use Comfy API"). Hosted models through Comfy
 * Router, on the user's own Comfy key and credits. server/router/ is the other
 * half; this file draws the page and never sees the key.
 *
 * THREE WAYS TO FILL A MODEL IN, one form engine:
 *   Simple        the featured models whose body is nested get a short form
 *                 (server/router/adapters.js builds the native body);
 *   All settings  every model: a form drawn from its published JSON schema,
 *                 the common fields first and the rest under "More settings";
 *   JSON          the native body itself, for anything the form cannot say
 *                 and for the models Comfy has not published a schema for.
 *
 * A run spends credits, so the Run button asks first, every time, and says
 * whether a refusal on content grounds is charged when the Router knows.
 */
import { appConfirm, appAlert } from "./dialog.js";
import { mountPicDrop } from "./picdrop.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const KINDS = [["image", "Image"], ["video", "Video"], ["audio", "Audio"], ["3d", "3D"], ["text", "Text"]];
const MAX_FILE = 40 * 1048576;

const st = {
  inited: false, models: [], kind: "image", model: null, schema: null, mode: "simple",
  files: {}, runs: [], timer: null, keySet: false, busy: false,
};

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) throw Object.assign(new Error(j?.error || `${r.status}`), { status: r.status });
  return j;
}

/* Full Studio and Music only mount no /api/router at all (server/index.js,
 * so no route there can spend a credit), and the Welcome catalogue still lists
 * this page. Reached that way it says what it is for and stops: no red "not
 * found" chip, no forms that cannot work, no poll every fifteen seconds. */
function paintOffMode() {
  clearTimeout(st.timer);
  for (const id of ["router-key", "router-make", "router-runs"]) if ($(id)) $(id).hidden = true;
  let note = $("rtOffMode");
  if (!note) {
    note = document.createElement("p");
    note.className = "hint";
    note.id = "rtOffMode";
    $("router").querySelector(".page-head")?.after(note);
  }
  note.textContent = "This page runs in the launcher's Use Comfy API mode. Full Studio never spends Comfy credits. "
    + "Your Comfy API key can also be saved or forgotten in Settings → No strong graphics card?.";
}

/* ── the key ─────────────────────────────────────────────────────────── */

function paintKey(k) {
  st.keySet = !!k?.set;
  const chip = $("rtKeyChip");
  chip.className = `chip ${k?.set ? (k.usable === false ? "warn" : "ok") : "warn"}`;
  chip.textContent = k?.set ? (k.usable === false ? "Key needs saving again" : `Key saved ${k.hint || ""}`.trim()) : "No key yet";
  chip.title = k?.protection || "";
  /* Said only when true (server/secrets.js): "encrypted" when DPAPI really
   * encrypted it, otherwise where the key is and who can read it. And a key
   * another copy of Studio saved is shown as that, with its date. */
  if ($("rtKeySub")) {
    $("rtKeySub").textContent = !k?.set ? "Kept on this computer and sent only to Comfy."
      : k.encrypted ? "Kept encrypted on this computer and sent only to Comfy."
      : `${k.protection || "Not encrypted on this computer."} Sent only to Comfy.`;
  }
  if ($("rtKeySaid")) { $("rtKeySaid").textContent = k?.set ? (k.said || "") : ""; $("rtKeySaid").hidden = !k?.set; }
  const editing = !k?.set || k.usable === false || st.editKey;
  $("rtKey").hidden = !editing;
  $("rtKeySave").hidden = !editing;
  $("rtKeyChange").hidden = editing;
  $("rtKeyForget").hidden = !k?.set;
  $("rtKeyHint").hidden = !!k?.set && !editing;
  paintRunButton();
}

async function saveKey() {
  const key = $("rtKey").value.trim();
  if (!key) { $("rtKey").focus(); return; }
  $("rtKeySave").disabled = true;
  $("rtKeyChip").className = "chip busy";
  $("rtKeyChip").textContent = "Checking the key…";
  try {
    const r = await api("/api/router", { action: "key", key });
    $("rtKey").value = "";
    st.editKey = false;
    paintKey(r.key);
    loadModels(true);
  } catch (e) {
    $("rtKeyChip").className = "chip err";
    $("rtKeyChip").textContent = e.message;
  } finally {
    $("rtKeySave").disabled = false;
  }
}

/* ── models ──────────────────────────────────────────────────────────── */

async function loadModels(fresh = false) {
  try {
    const r = await api(`/api/router/models${fresh ? "?fresh=1" : ""}`);
    st.models = r.models || [];
    paintModels();
  } catch (e) {
    $("rtModelNote").textContent = `Could not list the models: ${e.message}`;
  }
}

function paintKinds() {
  for (const b of document.querySelectorAll("#rtKinds [data-kind]")) {
    const n = st.models.filter((m) => m.kind === b.dataset.kind).length;
    b.setAttribute("aria-pressed", b.dataset.kind === st.kind ? "true" : "false");
    b.querySelector("small").textContent = n ? String(n) : "";
  }
}

function paintModels() {
  paintKinds();
  const list = st.models.filter((m) => m.kind === st.kind);
  const featured = list.filter((m) => m.featured);
  const rest = list.filter((m) => !m.featured);
  const byProvider = {};
  for (const m of rest) (byProvider[m.provider] ||= []).push(m);
  const opt = (m) => `<option value="${esc(m.id)}">${esc(m.label)}${m.featured ? "" : ` (${esc(m.id.split("/")[1])})`}</option>`;
  $("rtModel").innerHTML = (featured.length ? `<optgroup label="Featured">${featured.map(opt).join("")}</optgroup>` : "")
    + Object.entries(byProvider).map(([p, ms]) => `<optgroup label="${esc(p)}">${ms.map(opt).join("")}</optgroup>`).join("");
  const keep = list.find((m) => m.id === st.model) ? st.model : list[0]?.id || null;
  $("rtModel").value = keep || "";
  $("rtModelNote").textContent = list.length ? "" : "No models of this kind.";
  if (keep !== st.model || !st.schema) pickModel(keep);
}

async function pickModel(id) {
  st.model = id;
  st.schema = null;
  for (const n of Object.keys(st.files)) dropFile(n);
  $("rtForm").innerHTML = id ? '<span class="chip busy">Reading the model…</span>' : "";
  $("rtJson").hidden = true;
  paintRunButton();
  if (!id) return;
  try {
    const s = await api(`/api/router/schema?id=${encodeURIComponent(id)}`);
    if (st.model !== id) return;
    st.schema = s;
    st.mode = s.simple ? "simple" : s.authored && Object.keys(s.input?.properties || {}).length ? "fields" : "json";
    $("rtJson").value = JSON.stringify(s.example && typeof s.example === "object" ? s.example : {}, null, 2);
    paintForm();
  } catch (e) {
    if (st.model !== id) return;
    st.schema = { id, authored: false, simple: null, input: {}, example: {} };
    st.mode = "json";
    $("rtJson").value = "{\n}";
    paintForm();
    $("rtModelNote").textContent = e.message;
  }
}

/* ── the form engine ─────────────────────────────────────────────────── */

const MAIN = /prompt|^text|negative|aspect|ratio|^size$|resolution|duration|seconds|width|height|^image|input_image|voice|style|^n$|num_images|quality|fps|audio|sound|mode$/i;
const LONG = /prompt|^text|instruction|description|lyrics|script|^input$/i;

/** How an upload goes into this field: raw base64, a data URI, or not at all. */
function mediaOf(name, sch) {
  const d = `${name} ${sch?.description || ""}`.toLowerCase();
  if (sch?.type && sch.type !== "string") return null;
  if (!/image|video|audio|mask|frame|photo|picture|voice|sound|clip|garment|person|file/.test(d)) return null;
  if (!/base64|data uri|data:/.test(d)) return null;
  const media = /video|clip/.test(d) && !/image/.test(name) ? "video" : /audio|voice|sound/.test(d) && !/image/.test(name) ? "audio" : "image";
  return { media, as: /data uri|data:|url/.test(d) ? "uri" : "raw" };
}

function isScalar(sch) {
  if (!sch) return false;
  if (sch.enum) return true;
  return ["string", "integer", "number", "boolean"].includes(sch.type) && !sch.oneOf && !sch.anyOf;
}

/* ⚠ ELEMENT IDS ARE NUMBERED, NEVER BUILT FROM THE FIELD NAME. A field name is
 * a property key from the model's published schema (server/router/catalog.js
 * copies keys through as they come), and it went into id="…" unescaped: a key
 * with a double quote in it closed the attribute and put markup of its choosing
 * into Studio's own page, where a script passes every same-origin guard. The
 * id only pairs a label with its control; values are read through the escaped
 * data-f / data-media / data-drop attributes, so a counter loses nothing and
 * also pairs names that are not valid ids (a space, a dot). */
let rtfSeq = 0;
function fieldHtml(f) {
  const id = `rtf_${++rtfSeq}`;
  const req = f.required ? " *" : "";
  const tip = f.help ? ` title="${esc(f.help)}"` : "";
  const label = `<label for="${id}"${tip}>${esc(f.label)}${req}</label>`;
  let ctl;
  if (f.type === "media" && (f.media || "image") === "image") {
    /* A picture takes the app's drop box (web/picdrop.js), like every other
     * picture input; video and audio keep a plain file input. */
    ctl = `<div class="rtdrop" data-drop="${esc(f.name)}" data-as="${esc(f.as || "uri")}"></div>`;
  } else if (f.type === "media") {
    ctl = `<span class="rtfile"><input id="${id}" type="file" data-media="${esc(f.name)}" data-as="${esc(f.as || "uri")}" accept="${esc(f.accept || `${f.media || "image"}/*`)}">
      <span class="dim" data-mname="${esc(f.name)}"></span></span>`;
  } else if (f.type === "enum") {
    const opts = (f.required || f.default !== undefined ? [] : ['<option value="">default</option>'])
      .concat(f.options.map((o) => `<option value="${esc(o)}"${String(o) === String(f.default) ? " selected" : ""}>${esc(o)}</option>`));
    ctl = `<select id="${id}" class="sel2" data-f="${esc(f.name)}" data-t="${esc(f.valueType || "string")}">${opts.join("")}</select>`;
  } else if (f.type === "bool") {
    ctl = f.simple
      ? `<label class="tog"><input id="${id}" type="checkbox" data-f="${esc(f.name)}" data-t="bool"${f.default ? " checked" : ""}> on</label>`
      : `<select id="${id}" class="sel2" data-f="${esc(f.name)}" data-t="bool3"><option value="">default${f.default !== undefined ? ` (${f.default ? "on" : "off"})` : ""}</option><option value="1">on</option><option value="0">off</option></select>`;
  } else if (f.type === "int" || f.type === "number") {
    ctl = `<input id="${id}" class="in2 num" type="number" data-f="${esc(f.name)}" data-t="${f.type}"${f.min != null ? ` min="${esc(f.min)}"` : ""}${f.max != null ? ` max="${esc(f.max)}"` : ""}${f.type === "number" ? ' step="any"' : ""}${f.simple && f.default != null ? ` value="${esc(f.default)}"` : ""} placeholder="${esc(f.default ?? "")}">`;
  } else if (f.type === "json") {
    ctl = `<textarea id="${id}" rows="3" spellcheck="false" class="rtjson" data-f="${esc(f.name)}" data-t="json" placeholder="JSON"></textarea>`;
  } else if (f.type === "longtext") {
    ctl = `<textarea id="${id}" rows="${f.name === "prompt" ? 4 : 2}" spellcheck="false" data-f="${esc(f.name)}" data-t="string" placeholder="${esc(f.placeholder || "")}"></textarea>`;
  } else {
    ctl = `<input id="${id}" class="line" data-f="${esc(f.name)}" data-t="string" placeholder="${esc(f.placeholder || "")}">`;
  }
  return `${label}<span class="pv">${ctl}</span>`;
}

/** The schema's top-level properties as form fields, the common ones first. */
function schemaFields(s) {
  const hidden = new Set(s.hidden || []);
  const props = s.input?.properties || {};
  const req = new Set(s.input?.required || []);
  const out = [];
  for (const [name, sch] of Object.entries(props)) {
    if (hidden.has(name)) continue;
    const help = (sch.description || "").slice(0, 300);
    const base = { name, label: name.replace(/_/g, " "), required: req.has(name), help, default: sch.default };
    const m = mediaOf(name, sch);
    if (m) out.push({ ...base, type: "media", media: m.media, as: m.as });
    else if (sch.enum) out.push({ ...base, type: "enum", options: sch.enum, valueType: typeof sch.enum[0] === "number" ? "number" : "string" });
    else if (sch.type === "boolean") out.push({ ...base, type: "bool" });
    else if (sch.type === "integer" || sch.type === "number") out.push({ ...base, type: sch.type === "integer" ? "int" : "number", min: sch.minimum, max: sch.maximum });
    else if (sch.type === "string" && isScalar(sch)) out.push({ ...base, type: LONG.test(name) ? "longtext" : "text" });
    else out.push({ ...base, type: "json" });
    /* A numbered sibling (input_image_2 … _9) is "one more of the above": it
     * waits under More settings, or nine upload rows push the prompt away. */
    const extra = /_\d+$/.test(name) && props[name.replace(/_\d+$/, "")];
    out[out.length - 1].main = req.has(name) || (MAIN.test(name) && !extra && out[out.length - 1].type !== "json");
  }
  /* The words first, then what is required, then the rest as published. */
  const rank = (f) => (/^(prompt|text|text_prompt|prompt_text|promptText)$/i.test(f.name) ? 0 : f.required ? 1 : /prompt/i.test(f.name) ? 2 : 3);
  return out.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i).map((x) => x.f);
}

function paintForm() {
  const s = st.schema;
  if (!s) return;
  /* "All settings" needs top-level fields to draw; a schema that is only a
   * choice of shapes (Meshy's preview or refine) goes through Simple or JSON. */
  const drawable = !!s.authored && !!Object.keys(s.input?.properties || {}).length;
  const modes = [["simple", "Simple", !!s.simple], ["fields", "All settings", drawable], ["json", "JSON", true]];
  $("rtModes").innerHTML = modes.filter(([, , ok]) => ok)
    .map(([m, label]) => `<button type="button" class="edtool" data-mode="${m}" aria-pressed="${st.mode === m}">${label}</button>`).join("");
  $("rtJson").hidden = st.mode !== "json";
  if (st.mode === "json") {
    $("rtForm").innerHTML = s.authored ? "" : '<p class="hint">Comfy has not published this model\'s fields yet. Send its native JSON.</p>';
  } else if (st.mode === "simple") {
    const fields = s.simple.fields.map((f) => ({ ...f, simple: true, type: f.type === "media" ? "media" : f.type }));
    $("rtForm").innerHTML = `<div class="params">${fields.map(fieldHtml).join("")}</div>`;
    mountDrops();
  } else {
    const fields = schemaFields(s);
    const main = fields.filter((f) => f.main), more = fields.filter((f) => !f.main);
    $("rtForm").innerHTML = `<div class="params">${main.map(fieldHtml).join("")}</div>`
      + (more.length ? `<details class="more"><summary>More settings (${more.length})</summary><div class="params">${more.map(fieldHtml).join("")}</div></details>` : "");
    mountDrops();
  }
  $("rtModelNote").textContent = "";
  paintRunButton();
}

function readForm() {
  const values = {};
  for (const el of $("rtForm").querySelectorAll("[data-f]")) {
    const t = el.dataset.t, name = el.dataset.f;
    if (t === "bool") { values[name] = el.checked; continue; }
    const v = el.value.trim();
    if (v === "") continue;
    if (t === "bool3") values[name] = v === "1";
    else if (t === "int") values[name] = Math.round(Number(v));
    else if (t === "number") values[name] = Number(v);
    else if (t === "json") {
      try { values[name] = JSON.parse(v); } catch { throw new Error(`${name} is not valid JSON.`); }
    } else values[name] = v;
  }
  return values;
}

/** A file into st.files[name], base64, ready to send. */
async function takeFile(name, f, as) {
  if (!f) return false;
  if (f.size > MAX_FILE) { appAlert(`${f.name} is over 40 MB.`); return false; }
  const data = await new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] || "");
    r.onerror = () => bad(r.error);
    r.readAsDataURL(f);
  });
  dropFile(name);
  st.files[name] = { mime: f.type || "application/octet-stream", data, as: as || "uri",
    fileName: f.name, size: f.size, url: URL.createObjectURL(f) };
  return true;
}
function dropFile(name) {
  if (st.files[name]?.url) URL.revokeObjectURL(st.files[name].url);
  delete st.files[name];
}

async function readFile(input) {
  const f = input.files?.[0];
  const name = input.dataset.media;
  const tag = $("rtForm").querySelector(`[data-mname="${CSS.escape(name)}"]`);
  if (!f) { dropFile(name); if (tag) tag.textContent = ""; return; }
  if (!(await takeFile(name, f, input.dataset.as))) { input.value = ""; return; }
  if (tag) tag.textContent = `${f.name} · ${(f.size / 1048576).toFixed(1)} MB`;
}

/* Earlier Comfy API pictures, for the drop box's "Library ▾". */
function pictureCandidates() {
  return st.runs.flatMap((r) => (r.files || [])
    .filter((f) => /^image\//.test(f.mime || "") || /^(png|jpg|webp)$/.test(f.ext || ""))
    .map((f) => ({ name: f.name, url: `/api/router/file/${encodeURIComponent(f.name)}`,
      label: (r.prompt || r.label || f.name).slice(0, 48), group: "Comfy API results" })));
}

function mountDrops() {
  for (const host of $("rtForm").querySelectorAll("[data-drop]")) {
    const name = host.dataset.drop, as = host.dataset.as;
    const drop = mountPicDrop(host, {
      zone: "Drop a picture here",
      candidates: pictureCandidates,
      current: () => {
        const f = st.files[name];
        return f ? { label: f.fileName || "Your picture", sub: `${(f.size / 1048576).toFixed(1)} MB`, url: f.url } : null;
      },
      onFiles: async (files) => { if (await takeFile(name, files[0], as)) drop?.paint(); },
      onClear: () => { dropFile(name); drop?.paint(); },
    });
    drop?.paint();
  }
}

function paintRunButton() {
  const b = $("rtRun");
  if (!b) return;
  b.disabled = st.busy || !st.keySet || !st.schema;
  b.textContent = st.busy ? "Sending…" : "Run";
  const m = st.models.find((x) => x.id === st.model);
  $("rtRunNote").textContent = !st.keySet ? "Save your Comfy API key first."
    : `Uses Comfy credits${m?.policyCharged === "yes" ? " · a refusal is charged" : ""}`;
}

async function run() {
  if (!st.schema || st.busy) return;
  const m = st.models.find((x) => x.id === st.model) || { label: st.model };
  // Only what the server needs: the preview URL and file name stay here.
  const files = Object.fromEntries(Object.entries(st.files).map(([k, f]) => [k, { mime: f.mime, data: f.data, as: f.as }]));
  let payload;
  try {
    if (st.mode === "json") {
      let raw;
      try { raw = JSON.parse($("rtJson").value || "{}"); } catch { throw new Error("That JSON does not parse."); }
      payload = { model: st.model, raw };
    } else if (st.mode === "simple") {
      payload = { model: st.model, simple: readForm(), files };
    } else {
      payload = { model: st.model, body: readForm(), files };
    }
  } catch (e) { appAlert(e.message); return; }

  const policy = m.policyCharged === "yes" ? "\n\nIf the provider refuses it on content grounds, that is still charged."
    : m.policyCharged === "no" ? "" : m.policyCharged === "unknown" ? "\n\nWhether a content refusal is charged is not known for this model." : "";
  const ok = await appConfirm(`Run ${m.label} on Comfy's cloud? This uses credits from your Comfy account.${policy}`,
    { title: "Use Comfy credits?", ok: "Run", cancel: "Not now" });
  if (!ok) return;
  /* This run's own yes, which the server now requires (routes.js): the box
   * above is the only place it is set. */
  payload.confirmSpend = true;
  st.busy = true;
  paintRunButton();
  try {
    await api("/api/router/run", payload);
    await loadRuns();
    document.getElementById("router-runs")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    appAlert(e.message);
  } finally {
    st.busy = false;
    paintRunButton();
  }
}

/* ── runs ────────────────────────────────────────────────────────────── */

const CHIP = {
  waiting: ["busy", "Sending"], queued: ["busy", "Queued"], running: ["busy", "Running"], collecting: ["busy", "Saving"],
  done: ["ok", "Done"], failed: ["err", "Failed"], cancelled: ["warn", "Cancelled"],
};
const ACTIVE = new Set(["waiting", "queued", "running", "collecting"]);

function preview(r) {
  const f = (r.files || [])[0];
  const url = (x) => `/api/router/file/${encodeURIComponent(x.name)}`;
  let main = "";
  if (f) {
    if (/^image\//.test(f.mime || "") || /^(png|jpg|webp|gif|avif|svg)$/.test(f.ext)) main = `<img src="${url(f)}" alt="" loading="lazy">`;
    else if (/^video\//.test(f.mime || "") || /^(mp4|mov|webm|mkv)$/.test(f.ext)) main = `<video src="${url(f)}" controls preload="metadata"></video>`;
    else if (/^audio\//.test(f.mime || "") || /^(mp3|wav|ogg|opus|flac|aac|m4a)$/.test(f.ext)) main = `<audio src="${url(f)}" controls preload="metadata"></audio>`;
    else main = `<a class="btn2" href="${url(f)}?download=1">Download ${esc(f.ext || "file")}</a>`;
  } else if (r.text) {
    main = `<pre class="rttext">${esc(r.text)}</pre>`;
  }
  const extra = (r.files || []).slice(1).map((x, i) => `<a href="${url(x)}" target="_blank" rel="noopener">${i + 2}</a>`).join(" ");
  return main + (extra ? `<div class="rtmore dim">more: ${extra}</div>` : "");
}

function paintRuns() {
  const box = $("rtRuns");
  if (!st.runs.length) { box.innerHTML = '<p class="hint">Runs appear here.</p>'; return; }
  box.innerHTML = st.runs.map((r) => {
    const [tone, word] = CHIP[r.status] || ["", r.status];
    const status = r.status === "queued" && r.position != null ? `${word} #${r.position + 1}` : word;
    const when = new Date(r.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return `<article class="rtrun" data-run="${esc(r.id)}">
      <div class="rtprev">${ACTIVE.has(r.status) ? '<span class="rtspin" aria-hidden="true"></span>' : preview(r)}</div>
      <div class="rtmeta">
        <div class="rthead"><b>${esc(r.label)}</b> <span class="chip ${tone}">${esc(status)}</span></div>
        <p class="rtprompt" title="${esc(r.prompt)}">${esc(r.prompt || "")}</p>
        <p class="dim rtsmall">${esc(when)}${r.credits != null ? ` · ${esc(r.credits)} credits` : ""}${r.dropped ? ` · not sent: ${esc(r.dropped)}` : ""}</p>
        ${r.error ? `<p class="hint warnhint">${esc(r.error.message)}${r.error.upstream ? ` (${esc(r.error.upstream)})` : ""}</p>` : ""}
        <div class="cta rtacts">
          ${ACTIVE.has(r.status) ? `<button type="button" class="btn2 danger" data-act="cancel">Cancel</button>` : ""}
          ${!ACTIVE.has(r.status) && r.status !== "cancelled" ? `<button type="button" class="btn2" data-act="raw">Raw answer</button>` : ""}
          ${!ACTIVE.has(r.status) ? `<button type="button" class="btn2" data-act="remove" title="The files stay on disk">Remove</button>` : ""}
        </div>
      </div>
    </article>`;
  }).join("");
}

async function loadRuns() {
  try {
    const r = await api("/api/router/runs");
    const next = JSON.stringify(r.runs || []);
    if (next !== st.lastRuns) { st.lastRuns = next; st.runs = r.runs || []; paintRuns(); }
  } catch { /* the next poll tries again */ }
  schedule();
}

function schedule() {
  clearTimeout(st.timer);
  if ($("router")?.hidden) return;
  const active = st.runs.some((r) => ACTIVE.has(r.status));
  st.timer = setTimeout(loadRuns, active ? 2500 : 15000);
}

/* ── wiring ──────────────────────────────────────────────────────────── */

export function initRouter() {
  if (st.inited || !$("router")) return;
  st.inited = true;
  $("rtKinds").innerHTML = KINDS.map(([k, label]) =>
    `<button type="button" class="edtool" data-kind="${k}" aria-pressed="${k === st.kind}">${label}<small></small></button>`).join("");
  $("rtKinds").addEventListener("click", (e) => {
    const b = e.target.closest("[data-kind]");
    if (!b) return;
    st.kind = b.dataset.kind;
    paintModels();
  });
  $("rtModel").addEventListener("change", () => pickModel($("rtModel").value));
  $("rtModes").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b || !st.schema) return;
    st.mode = b.dataset.mode;
    for (const n of Object.keys(st.files)) dropFile(n);
    paintForm();
  });
  $("rtForm").addEventListener("change", (e) => {
    if (e.target.matches("input[type=file][data-media]")) readFile(e.target).catch((err) => appAlert(err.message));
  });
  $("rtForm").addEventListener("submit", (e) => e.preventDefault());
  $("rtRun").addEventListener("click", run);
  $("rtKeySave").addEventListener("click", saveKey);
  $("rtKey").addEventListener("keydown", (e) => { if (e.key === "Enter") saveKey(); });
  $("rtKeyChange").addEventListener("click", () => { st.editKey = true; api("/api/router").then((r) => paintKey(r.key)); $("rtKey").focus(); });
  $("rtKeyForget").addEventListener("click", async () => {
    if (!(await appConfirm("Forget the saved Comfy API key on this computer?", { ok: "Forget", tone: "danger" }))) return;
    const r = await api("/api/router", { action: "forget" });
    paintKey(r.key);
  });
  $("rtRuns").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    const id = e.target.closest("[data-run]")?.dataset.run;
    if (!b || !id) return;
    if (b.dataset.act === "raw") {
      try {
        const r = await api(`/api/router/raw?id=${encodeURIComponent(id)}`);
        appAlert(JSON.stringify(r.result, null, 2).slice(0, 6000), { title: "Raw answer" });
      } catch (err) { appAlert(err.message); }
      return;
    }
    b.disabled = true;
    const r = await api("/api/router/runs", { action: b.dataset.act, id }).catch((err) => ({ error: err.message }));
    if (r?.error) appAlert(r.error);
    loadRuns();
  });
}

/** Called by setView each time the page opens. */
export async function showRouter() {
  initRouter();
  /* "Music videos are made in Full Studio's Music video screen…": the server's sentence
   * for the mode this page is open in (GET /api/cloud comfy.note). The page
   * keeps its written placeholder if the read fails. */
  fetch("/api/cloud").then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (d?.comfy?.note && $("rtNoMv")) $("rtNoMv").textContent = d.comfy.note;
  }).catch(() => {});
  try {
    const r = await api("/api/router");
    paintKey(r.key);
    $("rtOut").textContent = r.outDir || "";
  } catch (e) {
    if (e.status === 404) { paintOffMode(); return; }
    $("rtKeyChip").className = "chip err";
    $("rtKeyChip").textContent = e.message;
  }
  if (!st.models.length) loadModels();
  loadRuns();
}
