/* Simple mode for the Images and Video panels.
 *
 * Each panel gets a Simple / Advanced switch and, in Simple, the Music panel's
 * "Describe your idea" block. Which one a panel opens on is NOT remembered
 * here: it is the saved level (UI_PLAN E1, web/level.js, server/welcome/
 * level.js), Simple on a new install and Advanced on one already in use, and a
 * Home card opens its panel Simple either way. The switch itself is a choice
 * for this visit; "Show every setting" in Settings is the one that is saved.
 * The Advanced button's tooltip is the server's list of what Advanced adds.
 *
 * The Simple block's button says what it makes (Make picture, Make clip), and
 * pressing it is the go-ahead. With a writing model it asks the assistant, and
 * when the reply set the form up without starting it, the real Make button is
 * pressed after it. With none (the server answered and has none), the words
 * go straight into the real prompt and the real Make button is pressed. Both
 * are said in the log. While the engine is still starting nothing is sent
 * (web/writer.js). The
 * assistant behind it (server/chat/form-tools.js, /api/chat/image and
 * /api/chat/video) sees EVERY control of the panel's form — read here from the
 * DOM, so a control added later is covered with no change — and can set any of
 * them and press the panel's own Make button. The Advanced form stays the one
 * source of truth: Simple hides it, the assistant fills it, and switching back
 * shows exactly what it chose.
 */
import { fillModelMenu } from "./chat.js";
import { growHandle } from "./grow.js";
import { onLevel } from "./level.js";
import { writerFrom, whyNoWriter, notYetLine } from "./writer.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const PANELS = {
  image: {
    root: () => document.querySelector("#imgPanel .vidform"),
    prompt: "imgPrompt", button: "imgGo", note: "imgNote", engine: "imgEngine", engineLabel: "Image model",
    view: "images", make: "Make picture",
    /* "Your own model file": the engine choice that needs a second one, the file. */
    own: { value: "checkpoint", pick: "imgCkpt", label: "Model file" },
    kinds: ["image", "cover"],
    placeholder: "A red fox asleep on a stack of old books, morning light through a window, soft film photo…",
    doing: { set_form: "Setting up the image…", generate: "Starting the image…" },
  },
  video: {
    root: () => $("vidPanel"),
    prompt: "vidPrompt", button: "vidCreate", note: "vidEst", engine: "vidEngine", engineLabel: "Video model",
    view: "video", make: "Make clip",
    kinds: ["video"],
    placeholder: "Slow push in on a rainy neon street at night, one cyclist rides through the puddles…",
    doing: { set_form: "Setting up the clip…", generate: "Starting the clip…" },
  },
};

/* ── what the assistant sees ─────────────────────────────────────────────── */
/* A label's own words: not its "!" button, not its grey side note. */
const words = (node) => {
  if (!node) return "";
  const c = node.cloneNode(true);
  for (const x of c.querySelectorAll(".tipi, .sp.meta, select, input, textarea, button")) x.remove();
  return c.textContent.replace(/\s+/g, " ").trim();
};
function labelFor(root, el) {
  const t = words(root.querySelector(`label[for="${CSS.escape(el.id)}"]`))
    || words(el.closest("label"))
    || el.getAttribute("aria-label") || el.title || el.placeholder
    || (el.tagName === "SELECT" && el.options[0]?.value === "" ? el.options[0].textContent.trim() : "")
    || words(el.closest(".field")?.querySelector(".flabel"))
    || el.id;
  return t.slice(0, 60);
}
export function readFields(root) {
  const out = [];
  if (!root) return out;
  for (const el of root.querySelectorAll("select[id], textarea[id], input[id]")) {
    if (el.closest(".assist, .asmode")) continue;
    const t = el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "text" : (el.type || "text");
    if (!["select", "text", "number", "range", "checkbox", "search"].includes(t)) continue;
    const h = el.closest("[hidden]");
    const f = {
      id: el.id, label: labelFor(root, el), type: t === "search" ? "text" : t,
      value: t === "checkbox" ? el.checked : el.value,
      hidden: el.hidden || !!(h && h !== root && root.contains(h)),
      /* A field the page locked for a reason of its own says so in data-why
       * (Fast draft's chip and the sliders it locks), so the assistant can
       * give that reason instead of "fixed by this engine". */
      ...(el.disabled ? { fixed: true, ...(el.dataset?.why ? { why: String(el.dataset.why).slice(0, 240) } : {}) } : {}),
    };
    if (t === "select") {
      f.options = [...el.options].slice(0, 40).map((o) => ({ v: o.value, t: o.textContent.trim().slice(0, 80),
        ...(o.disabled ? { off: true, why: o.title || "" } : {}) }));
    }
    if (t === "number" || t === "range") {
      for (const k of ["min", "max", "step"]) if (el[k] !== "" && Number.isFinite(Number(el[k]))) f[k] = Number(el[k]);
    }
    out.push(f);
  }
  return out;
}
async function snapshot(kind) {
  const P = PANELS[kind], root = P.root();
  const btn = $(P.button);
  const d = {
    kind, fields: readFields(root), promptField: P.prompt,
    button: { ready: !!btn && !btn.disabled, why: btn?.title || "" },
  };
  /* What is running and what failed, from the same status the rail reads. */
  try {
    const s = (await (await fetch("/api/status")).json())?.art || {};
    const mine = (k) => P.kinds.includes(k);
    const cur = s.current && mine(s.current.kind) ? s.current : null;
    d.renders = {
      running: cur ? `"${cur.title || cur.file || "untitled"}" (${cur.kind}, ${Math.round((cur.progress || 0) * (cur.progress <= 1 ? 100 : 1))}%, ${cur.elapsed || 0} s)` : "",
      queued: P.kinds.reduce((n, k) => n + (s.queuedKinds?.[k] || 0), 0),
      recent: (s.recent || []).filter((j) => mine(j.kind)).slice(0, 4)
        .map((j) => `"${j.title || j.file || "untitled"}" (${j.kind}${j.engine ? `, ${j.engine}` : ""}): ${j.error ? `FAILED — ${j.error}` : "done"}`),
      note: $(P.note)?.textContent?.trim() || "",
    };
  } catch { /* the status read is a nicety; the form is what matters */ }
  return d;
}

/* ── what the assistant does ─────────────────────────────────────────────── */
export async function applyFields(fields) {
  for (const [id, v] of Object.entries(fields || {})) {
    const el = $(id);
    if (!el) continue;
    if (el.type === "checkbox") { el.checked = !!v; el.dispatchEvent(new Event("change", { bubbles: true })); }
    else {
      el.value = String(v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    /* An engine change repaints the rest of the form; let it before the next. */
    if (el.tagName === "SELECT") await tick(40);
  }
}
async function pressMake(kind) {
  const P = PANELS[kind], btn = $(P.button);
  if (!btn) return { ok: false, why: "the Make button is not on the page." };
  if (!String($(P.prompt)?.value || "").trim()) return { ok: false, why: "there is no description yet." };
  for (let i = 0; i < 10 && btn.disabled; i++) await tick(200);
  if (btn.disabled) return { ok: false, why: `it is not available right now${btn.title ? ` (${btn.title})` : ""}.` };
  btn.click();
  await tick(600);
  const note = $(P.note)?.textContent?.trim() || "";
  if (/fail|could not|error|refus/i.test(note)) return { ok: false, why: note };
  return { ok: true, note };
}

/* THE MODEL, IN SIMPLE TOO. A mirror of the Advanced form's engine dropdown:
 * the same choices (the unavailable ones still disabled and saying why), kept
 * in step both ways — picking here changes the real one, and the real one
 * changing (by hand, by the app repainting it, or by the assistant) shows here. */
function mirrorEngine(P, sel, hooks = {}) {
  const real = $(P.engine);
  if (!real || !sel) return null;
  const copy = () => {
    const html = real.innerHTML;
    if (sel.dataset.sig !== html) { sel.innerHTML = html; sel.dataset.sig = html; }
    sel.value = real.value;
    sel.disabled = real.disabled || !real.options.length;
    sel.title = real.selectedOptions[0]?.title || real.selectedOptions[0]?.textContent?.trim() || "";
    hooks.decorate?.();
  };
  copy();
  real.addEventListener("change", copy);
  real.addEventListener("input", copy);
  new MutationObserver(copy).observe(real, { childList: true, subtree: true, attributes: true });
  sel.addEventListener("change", () => {
    if (sel.value.startsWith("__")) { const v = sel.value; sel.value = real.value; hooks.special?.(v); return; }
    hooks.chose?.(sel.value);
    if (real.value === sel.value) return hooks.decorate?.();
    real.value = sel.value;
    real.dispatchEvent(new Event("input", { bubbles: true }));
    real.dispatchEvent(new Event("change", { bubbles: true }));
  });
  /* A script setting .value without an event (some repaints do) is caught when
   * the block is looked at. */
  sel.addEventListener("focus", copy);
  setInterval(() => { if (sel.value !== real.value && document.activeElement !== sel) copy(); }, 1500);
  return copy;
}

/* YOUR OWN MODEL, IN SIMPLE. Choosing "Your own model file" needs a second
 * choice, the file: the writing-model dropdown steps aside for the list of
 * local model files, with an arrow pointing at it. Once a file is picked the
 * writing model comes back, and the model dropdown shows the file's name in
 * place of "Your own model file"; "Choose another model file…" reopens the list. */
function ownModel(P, box) {
  const eng = $(P.engine), file = $(P.own?.pick);
  const mirror = box.querySelector(".asengine select"), pick = box.querySelector(".asown select");
  const wrap = box.querySelector(".asown"), arrow = box.querySelector(".aspoint"), writer = box.querySelector(".aswriter");
  if (!P.own || !eng || !file || !mirror || !pick) { mirrorEngine(P, mirror); return; }
  let picking = false;
  const name = () => (file.selectedOptions[0]?.textContent || file.value || "").trim().replace(/\.(safetensors|ckpt|gguf|pt|bin)$/i, "");
  const paint = () => {
    const html = file.innerHTML;
    if (pick.dataset.sig !== html) {
      pick.innerHTML = file.options.length ? html : '<option value="">no model files found</option>';
      pick.dataset.sig = html;
    }
    let hint = pick.querySelector('option[data-hint]');
    if (!file.value && file.options.length) {
      if (!hint) { hint = new Option("Choose a model file…", ""); hint.dataset.hint = "1"; hint.disabled = true; pick.prepend(hint); }
    } else hint?.remove();
    pick.value = file.value;
    const own = eng.value === P.own.value;
    if (own && !file.value) picking = true;
    if (!own) picking = false;
    const show = own && picking;
    wrap.hidden = !show; arrow.hidden = !show; writer.hidden = show;
    /* The mirror's own-model choice says which file, once there is one. */
    const o = [...mirror.options].find((x) => x.value === P.own.value);
    if (o) {
      o.dataset.orig ??= o.textContent;
      o.textContent = own && file.value && !picking ? name() : o.dataset.orig;
    }
    let again = mirror.querySelector('option[value="__pick"]');
    if (own && file.value && !picking) {
      if (!again) { again = document.createElement("option"); again.value = "__pick"; again.textContent = "Choose another model file…"; mirror.appendChild(again); }
    } else again?.remove();
  };
  const copy = mirrorEngine(P, mirror, {
    decorate: paint,
    chose: (v) => { if (v === P.own.value) picking = true; },
    special: (v) => { if (v === "__pick") { picking = true; paint(); pick.focus(); } },
  });
  pick.addEventListener("change", () => {
    if (!pick.value) return;
    file.value = pick.value;
    file.dispatchEvent(new Event("input", { bubbles: true }));
    file.dispatchEvent(new Event("change", { bubbles: true }));
    picking = false;
    copy?.();
  });
  /* Reopened and left on the same file: that is a choice too. */
  pick.addEventListener("blur", () => { if (picking && file.value && pick.value === file.value) { picking = false; copy?.(); } });
  file.addEventListener("change", () => copy?.());
  new MutationObserver(() => copy?.()).observe(file, { childList: true, subtree: true });
  copy?.();
}

/* ── the block ──────────────────────────────────────────────────────────── */
function build(kind) {
  const P = PANELS[kind], root = P.root();
  if (!root || root.querySelector(":scope > .asmode")) return null;
  const head = root.querySelector(":scope > .stagehead, :scope > .ovhead");
  const bar = document.createElement("div");
  bar.className = "seg modebar asmode";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Mode");
  bar.innerHTML = '<button type="button" data-m="simple" aria-pressed="false" title="Describe it and let the assistant set everything up">Simple</button>'
    + '<button type="button" data-m="advanced" aria-pressed="true">Advanced</button>';
  const box = document.createElement("section");
  box.className = "assist";
  box.hidden = true;
  box.setAttribute("aria-label", `Simple mode assistant for ${kind === "image" ? "images" : "video"}`);
  box.innerHTML = `
    <div class="simple-log" aria-live="polite"></div>
    <div class="simple-status" hidden><i></i><span>Thinking…</span></div>
    <label class="flabel simple-label" for="${kind}AsText">Describe your idea</label>
    <form class="simple-input">
      <textarea id="${kind}AsText" rows="6" spellcheck="true" placeholder="${esc(P.placeholder)}"></textarea>
      <div class="simple-bar">
        <label class="simple-model asengine" title="${esc(P.engineLabel)}: the one that makes it (the same list as Advanced)">
          <select class="sel2 sm" aria-label="${esc(P.engineLabel)}"></select>
        </label>
        ${P.own ? `<span class="aspoint" hidden aria-hidden="true">➜</span>
        <label class="simple-model asown" hidden title="${esc(P.own.label)}: your own model, from models/checkpoints">
          <select class="sel2 sm" aria-label="${esc(P.own.label)}"></select>
        </label>` : ""}
        <label class="simple-model aswriter" title="The language model that writes for you (the same one Music's Simple mode uses)">
          <select class="sel2 sm" aria-label="Writing model" disabled><option value="">checking…</option></select>
        </label>
        <button type="button" class="simple-new" title="Start a new conversation">＋ New</button>
        <div class="ptools" data-gallery="${kind}" data-target="${kind}AsText" data-label="ideas"></div>
        <button class="simple-send" type="submit" aria-label="${esc(P.make)}">${esc(P.make)}</button>
      </div>
    </form>`;
  /* Under the heading — and under its ⓘ panel when that is already there, so
   * the page's explanation opens right below its title. */
  const anchor = head?.nextElementSibling?.classList.contains("infopanel") ? head.nextElementSibling : (head || root.firstElementChild);
  anchor.after(bar);
  bar.after(box);
  return { root, bar, box };
}

function mount(kind) {
  const P = PANELS[kind];
  const ui = build(kind);
  if (!ui) return;
  const { root, bar, box } = ui;
  const log = box.querySelector(".simple-log"), status = box.querySelector(".simple-status");
  const text = box.querySelector("textarea"), form = box.querySelector("form");
  const send = box.querySelector(".simple-send"), model = box.querySelector(".aswriter select");
  let session = null, busy = false, stream = null;
  ownModel(P, box);                                   // the model dropdown (and, for images, your own file)
  growHandle(text, `${kind}Simple`, (b) => form.appendChild(b));   // the Music box's bar, on this block's border

  const row = (cls, html) => {
    const d = document.createElement("div");
    d.className = `simple-row ${cls}`;
    d.innerHTML = html;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  };
  const say = (t) => { status.hidden = !t; if (t) status.querySelector("span").textContent = t; };
  const setBusy = (on) => {
    busy = on;
    send.classList.toggle("stop", on);
    send.textContent = on ? "■ Stop" : P.make;
    send.setAttribute("aria-label", on ? "Stop" : P.make);
  };

  const setMode = (simple) => {
    root.classList.toggle("assist-on", simple);
    box.hidden = !simple;
    for (const b of bar.querySelectorAll("button")) b.setAttribute("aria-pressed", String((b.dataset.m === "simple") === simple));
    if (simple) { loadModels(); setTimeout(() => text.focus(), 0); }
  };
  let touched = false;
  bar.addEventListener("click", (e) => { const b = e.target.closest("button[data-m]"); if (b) { touched = true; setMode(b.dataset.m === "simple"); } });
  /* Advanced until the saved level arrives (web/level.js): a new install then
   * opens Simple, one in use stays Advanced, and a Home card opens this panel
   * Simple either way. A switch the person already pressed is kept. */
  setMode(false);
  onLevel((n) => {
    const tip = n.advancedAdds?.[P.view];
    const adv = bar.querySelector('[data-m="advanced"]');
    if (adv && tip) adv.title = tip;
    if (n.view && n.view !== P.view) return;
    if (n.boot && touched) return;
    setMode(!!n.simple);
  });

  /* Whether a writing model can answer: true, false, or null for not known
   * yet (the engine still starting). web/writer.js; read again at every press
   * until it is true. */
  let writer = null;
  async function loadModels() {
    let d = null;
    try { d = await (await fetch("/api/chat/music/models")).json(); } catch { /* offline */ }
    fillModelMenu(model, d, "Put a Qwen3 (or Gemma) text encoder in models/text_encoders, or connect an API on the Agent page");
    writer = writerFrom(d);
  }
  /* NO WRITING MODEL: the words ARE the prompt. They go into the real prompt
   * field, the real Make button is pressed, and the log says that is what
   * happened, so nothing was chosen behind the person's back. */
  async function makeDirect(message) {
    const field = $(P.prompt);
    if (!field) return;
    row("me", esc(message));
    field.value = message;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    row("note", "No writing model here, so your words went in as they are.");
    const got = await pressMake(kind);
    row(got.ok ? "did" : "fail", got.ok ? `✓ Started${got.note ? ` · ${esc(got.note)}` : ""}` : `It did not start: ${esc(got.why)}`);
  }
  model.addEventListener("change", async () => {
    try { await fetch("/api/chat/music/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: model.value }) }); }
    catch { /* offline */ }
    loadModels();
  });
  box.querySelector(".simple-new").addEventListener("click", () => { session = null; log.innerHTML = ""; text.focus(); });
  document.addEventListener("aiplay:llm-changed", () => { if (!box.hidden) loadModels(); });

  /* What the running reply did, for the Make button's go-ahead (ask `make`). */
  let turn = null;
  async function onEvent(ev) {
    const t = turn || {};
    if (ev.type === "open") { session = ev.session; return; }
    if (ev.type === "thinking") return say("Thinking…");
    if (ev.type === "tool_call") return say(P.doing[ev.tool] || "Working…");
    if (ev.type === "tool_result") {
      if (ev.error) { t.failed = true; return row("fail", `${esc(ev.tool)} did not work: ${esc(ev.error)}`); }
      const r = ev.result || {};
      if (r.form?.fields) { t.set = true; await applyFields(r.form.fields); row("did", `✓ Set ${esc(r.changed || "the form")}`); }
      if (r.action === "generate") {
        t.started = true;
        const got = await pressMake(kind);
        row(got.ok ? "did" : "fail", got.ok ? `✓ Started${got.note ? ` — ${esc(got.note)}` : ""}` : `It did not start: ${esc(got.why)}`);
      }
      return;
    }
    if (ev.type === "say") return row("bot", esc(ev.text).replace(/\n/g, "<br>"));
    if (ev.type === "gpu") {
      return row("note", `<span class="gpuwarn">⚠ ${esc(ev.text || "Using the graphics card.")}</span> `
        + '<button type="button" class="btn sm ghost gpucancel">Cancel</button>');
    }
    if (ev.type === "proposal") { t.proposed = true; return row("note", `${esc(ev.text || "")} Type yes to go ahead.`); }
    if (ev.type === "busy" || ev.type === "error") { t.failed = true; return row(ev.type === "busy" ? "note" : "fail", esc(ev.text)); }
    if (ev.type === "done" || ev.type === "end") say("");
  }

  /* `make`: the words came from pressing the Make button (or Enter in its
   * box), which is the person's go-ahead. A reply that set the form up and did
   * not start it is followed by the real button, and the log says so. */
  async function ask(message, { make = false } = {}) {
    message = String(message || "").trim();
    if (busy || !message) return;
    setBusy(true);
    turn = { make, set: false, started: false, proposed: false, failed: false, stopped: false };
    stream = new AbortController();
    row("me", esc(message));
    say("Thinking…");
    try {
      const r = await fetch(`/api/chat/${kind}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, session, form: await snapshot(kind) }),
        signal: stream.signal,
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `HTTP ${r.status}`); }
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            let ev = null;
            try { ev = JSON.parse(line.slice(5).trim()); } catch { /* a partial frame */ }
            if (ev) await onEvent(ev);
          }
        }
      }
    } catch (e) {
      turn.stopped = true;
      row(e?.name === "AbortError" ? "note" : "fail", e?.name === "AbortError" ? "Stopped." : `That did not work. ${esc(e.message || e)}`);
    } finally {
      const t = turn;
      turn = null;
      stream = null;
      setBusy(false);
      say("");
      if (t?.make && t.set && !t.started && !t.proposed && !t.failed && !t.stopped) {
        row("note", `You pressed ${esc(P.make)}, so Studio pressed it on the form too.`);
        const got = await pressMake(kind);
        row(got.ok ? "did" : "fail", got.ok ? `✓ Started${got.note ? ` — ${esc(got.note)}` : ""}` : `It did not start: ${esc(got.why)}`);
      }
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) { stream?.abort(); return; }                 // the button is Stop while a reply runs
    const v = text.value;
    if (!v.trim()) { text.focus(); return; }
    (async () => {
      /* Asked again at every press until the answer is yes (web/writer.js).
       * Not known yet (the engine starting) sends nothing and says so; the
       * words stay in the box. */
      if (writer !== true) await loadModels();
      if (writer === null) {
        const why = await whyNoWriter();
        if (why.kind !== "noengine") return row("note", esc(notYetLine(why.kind, P.make)));
      }
      text.value = "";
      if (writer !== true) return makeDirect(v.trim());
      return ask(v, { make: true });
    })();
  });
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!busy) form.requestSubmit(); }
  });
  /* The whole block is the writing space. */
  form.addEventListener("mousedown", (e) => {
    if (e.target.closest("textarea, select, button, a, input, label")) return;
    e.preventDefault();
    text.focus();
  });
}

const boot = () => { mount("image"); mount("video"); };
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
