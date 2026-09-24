/* PROMPT TOOLS — the saved gallery, ✨ Enhance and ↺ undo beside a text box.
 *
 * Every `.ptools` element on the page becomes a small row of round buttons:
 *   data-gallery  which saved list it opens (styles | lyrics | simple | chat | image | video)
 *   data-field    which Enhance it runs (style | lyrics | simple); absent: none
 *   data-target   the textarea it works on (default: by field)
 *   data-label    how the gallery names its entries ("styles", "prompts", …)
 *
 * The lists and the model live on the server (server/prompt-tools.js), so the
 * page and MCP share them. Writing into a box fires `input`, so the page's
 * own counters and state follow as if it had been typed. */

import { fillModelMenu } from "./chat.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ICON = {
  gallery: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h3v16H4zM9 4h3v16H9zM14.2 4.6l2.9-.8 4.2 15.4-2.9.8z" fill="currentColor"/></svg>',
  enhance: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19 16 8l1.4 1.4-11 11zM15 3l.9 2.1L18 6l-2.1.9L15 9l-.9-2.1L12 6l2.1-.9zM20 9l.6 1.4L22 11l-1.4.6L20 13l-.6-1.4L18 11l1.4-.6zM9 2l.6 1.4L11 4l-1.4.6L9 6l-.6-1.4L7 4l1.4-.6z" fill="currentColor"/></svg>',
  undo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5a7 7 0 1 1-6.7 9h2.1A5 5 0 1 0 12 7H9.5l2.7 2.7-1.4 1.4L5.7 6l5.1-5.1 1.4 1.4L9.5 5z" fill="currentColor"/></svg>',
};
const FIELD_TARGET = { style: null, lyrics: "lyrics", simple: "simpleText" };

/** The box a toolbar works on. Styles follows Guided mode: its metadata field when Guided is on. */
function targetOf(bar) {
  if (bar.dataset.target) return $(bar.dataset.target);
  if (bar.dataset.field === "style") return $("capGuide") && !$("capGuide").hidden ? $("capMeta") : $("caption");
  return $(FIELD_TARGET[bar.dataset.field]);
}
function write(box, text) {
  box.value = text;
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.focus();
}
/** The whole style line, including Guided mode's three fields. */
function styleText() {
  if ($("capGuide") && !$("capGuide").hidden) {
    return ["capMeta", "capVocal", "capArr"].map((id) => $(id)?.value.trim()).filter(Boolean).join(", ");
  }
  return $("caption")?.value || "";
}
async function api(method, url, body) {
  const r = await fetch(url, body ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { method });
  const d = await r.json().catch(() => ({}));
  // A page newer than its server: the buttons load from disk at once, their routes only after a restart.
  if (r.status === 404) throw new Error("This needs a Studio restart: the running server predates these buttons.");
  if (!r.ok || d.error) {
    const e = new Error(d.error || `HTTP ${r.status}`);
    if (d.need) { e.need = d.need; e.apis = d.apis || []; }
    throw e;
  }
  return d;
}

/* ── one toolbar ─────────────────────────────────────────────────────────── */

function mount(bar) {
  const field = bar.dataset.field || null, kind = bar.dataset.gallery, label = bar.dataset.label || "entries";
  bar.innerHTML = `
    <span class="ptmsg" role="status" aria-live="polite" hidden></span>
    ${kind ? `<button class="ptbtn" type="button" data-act="gallery" title="Saved ${esc(label)}" aria-label="Saved ${esc(label)}" aria-expanded="false">${ICON.gallery}</button>` : ""}
    ${field ? `<button class="ptbtn ptenh" type="button" data-act="enhance" title="Enhance with AI" aria-label="Enhance with AI">${ICON.enhance}</button>` : ""}
    ${field ? `<button class="ptbtn" type="button" data-act="undo" title="Undo enhance" aria-label="Undo enhance" hidden>${ICON.undo}</button>` : ""}
    ${kind ? `<div class="ptpop" role="dialog" aria-label="Saved ${esc(label)}" hidden>
      <div class="ptpophead"><b>Saved ${esc(label)}</b><button class="edtool" type="button" data-act="save">Save current</button></div>
      <div class="ptlist"></div></div>` : ""}`;
  const msg = bar.querySelector(".ptmsg");
  let msgTimer = null, undoText = null;
  const say = (text, bad = false) => {
    msg.textContent = text; msg.hidden = !text; msg.classList.toggle("bad", bad);
    clearTimeout(msgTimer);
    if (text) msgTimer = setTimeout(() => { msg.hidden = true; }, bad ? 9000 : 3500);
  };
  const pop = bar.querySelector(".ptpop");
  const galleryBtn = bar.querySelector('[data-act="gallery"]');

  async function paintList() {
    const list = pop.querySelector(".ptlist");
    list.innerHTML = '<p class="hint">Loading…</p>';
    try {
      const { items } = await api("GET", `/api/gallery?kind=${encodeURIComponent(kind)}`);
      list.innerHTML = items.length ? items.map((it) => `
        <div class="ptitem" data-id="${esc(it.id)}">
          <button class="ptuse" type="button" title="Use this">${it.name ? `<b>${esc(it.name)}</b>` : ""}<span>${esc(it.text)}</span></button>
          <button class="ptdel" type="button" title="Delete" aria-label="Delete">✕</button>
        </div>`).join("")
        : `<p class="hint">Nothing saved yet. Write something and press <b>Save current</b>.</p>`;
      list.querySelectorAll(".ptitem").forEach((row) => {
        const item = items.find((x) => x.id === row.dataset.id);
        row.querySelector(".ptuse").onclick = () => { write(targetOf(bar), item.text); close(); };
        row.querySelector(".ptdel").onclick = async () => {
          try { await api("POST", "/api/gallery", { action: "delete", kind, id: item.id }); paintList(); }
          catch (e) { say(e.message, true); }
        };
      });
    } catch (e) { list.innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
  }
  function open() { pop.hidden = false; galleryBtn.setAttribute("aria-expanded", "true"); paintList(); }
  function close() { if (pop) { pop.hidden = true; galleryBtn?.setAttribute("aria-expanded", "false"); } }

  bar.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    const box = targetOf(bar);
    if (act === "gallery") return pop.hidden ? open() : close();
    if (act === "save") {
      try { await api("POST", "/api/gallery", { action: "save", kind, text: box?.value || "" }); say("Saved."); paintList(); }
      catch (err) { say(err.message, true); }
      return;
    }
    if (act === "undo") {
      if (undoText == null || !box) return;
      write(box, undoText); undoText = null;
      bar.querySelector('[data-act="undo"]').hidden = true;
      return;
    }
    if (act === "enhance") {
      const btn = bar.querySelector('[data-act="enhance"]');
      if (!box || btn.disabled) return;
      btn.disabled = true; btn.classList.add("busy"); say("Enhancing…");
      try {
        const r = await api("POST", "/api/enhance", {
          field, text: box.value, style: styleText(), lyrics: $("lyrics")?.value || "",
          engine: $("musicEngine")?.value || "yue2",
        });
        undoText = box.value;
        write(box, r.text);
        bar.querySelector('[data-act="undo"]').hidden = false;
        say(r.model ? `Enhanced · ${r.model}` : "Enhanced.");
      } catch (err) {
        /* No chat model: the window that offers one, rather than a sentence. */
        if (err.need === "chat" && window.aiplayNeedModel) {
          say("Needs a chat model.", true);
          window.aiplayNeedModel("chat", { apis: err.apis, after: paintEnhanceModel });
        } else say(err.message, true);
      }
      finally { btn.disabled = false; btn.classList.remove("busy"); }
    }
  });
  document.addEventListener("click", (e) => { if (pop && !pop.hidden && !bar.contains(e.target)) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
}

/* ── Settings: which model Enhance uses ──────────────────────────────────── */

async function paintEnhanceModel() {
  const sel = $("enhanceModel");
  if (!sel) return;
  try {
    const d = await api("GET", "/api/enhance");
    const rows = d.models || [];
    /* The same picker as every other writer (web/chat.js fillModelMenu, UI_PLAN
     * B2): writers only, by name; one is plain text; "Show every file" beside
     * it; plus this picker's own first choice. */
    fillModelMenu(sel, d, "Put a Qwen3 (or Gemma) text encoder in models/text_encoders, or connect an API on the Agent page",
      { lead: "Same as Simple mode (then Chat)" });
    sel.title = d.current ? `Enhance uses ${rows.find((m) => m.file === d.current)?.label || d.current}` : sel.title;
  } catch (e) {
    sel.innerHTML = `<option value="">${esc(e.message)}</option>`;
  }
}

function init() {
  document.querySelectorAll(".ptools").forEach(mount);
  const sel = $("enhanceModel");
  if (sel) {
    sel.addEventListener("change", async () => {
      try { await api("POST", "/api/enhance", { action: "model", model: sel.value }); $("enhanceSaved").textContent = "saved"; }
      catch (e) { $("enhanceSaved").textContent = e.message; }
    });
    paintEnhanceModel();
    // The list changes as APIs connect and the engine comes up; refresh when Settings is opened.
    document.querySelector('a[data-view="settings"]')?.addEventListener("click", () => setTimeout(paintEnhanceModel, 50));
  }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
