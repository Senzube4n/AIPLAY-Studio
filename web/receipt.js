/* THE RECEIPT UNDER EVERY MAKE BUTTON (UI_PLAN C2), AND WHAT THE MACHINE PICKED.
 *
 * One line under Create, Make image and Render clip saying what pressing it
 * will do: "YuE2 3B · sellable by individuals · 32 steps · up to 2:30 ·
 * about 4:00 · Change". Every
 * field is READ from the control that owns it, never kept here, and every
 * field names that control: Change switches the screen to Advanced, scrolls to
 * the control and lights it up. server/defaults_test.js checks each id in
 * RECEIPTS exists in web/index.html, so a renamed control fails the gate
 * rather than a receipt that points at nothing.
 *
 * The estimate is the one the screen already writes into its note (#ctaNote,
 * #vidEst). The receipt carries it, with the note's qualifiers after it, and
 * the note steps aside while it does; a warning (.stick) or any other message
 * in the note stays in view.
 *
 * Also here, because it is the same question asked the other way round:
 * Settings' "Picked for this PC" list (studio_status `defaults`, from
 * server/fit.js defaultFor) with Change and, on a saved choice, "Let Studio
 * pick"; and the Images engine, which opens on the saved or machine-picked
 * engine and saves the person's own pick. Every judgement is the server's;
 * this file only shows it. A failed start is said here too: "Couldn't start:
 * <the server's sentence>" with Fix where the server named a missing model,
 * until a start goes through.
 */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Each screen's receipt: where it hangs (`note`, the line it sits above),
 *  the button it describes, the view it lives on, and its fields in order.
 *  `controls` are the ids that own the value, first one shown wins. */
export const RECEIPTS = {
  music: {
    note: "ctaNote", button: "btnCreate", view: "create",
    fields: [
      { id: "engine", controls: ["musicEngine"] },
      /* Whether the song may be sold ("sellable by individuals", "not for
       * sale"): the chosen engine's catalogue words, which app.js
       * paintMusicRights() writes onto the picker as data-rights-short. The
       * picker is the control that decides it, so Change leads there. */
      { id: "rights", controls: ["musicEngine"] },
      { id: "steps", controls: ["ySteps", "qSteps"] },
      { id: "length", controls: ["maxDur"] },
      { id: "estimate", controls: [], estimate: true },
    ],
  },
  image: {
    note: "imgNote", button: "imgGo", view: "images",
    fields: [
      { id: "engine", controls: ["imgEngine"] },
      /* "Fast draft" while Qwen's turbo chip is on and not greyed; nothing
       * otherwise (the chip's row is hidden on other engines). */
      { id: "draft", controls: ["imgDraft"] },
      { id: "size", controls: ["imgSize", "imgW", "imgH"] },
      { id: "steps", controls: ["imgSteps"] },
      { id: "count", controls: ["imgCount"] },
    ],
  },
  video: {
    note: "vidEst", button: "vidCreate", view: "video",
    fields: [
      { id: "engine", controls: ["vidEngine"] },
      /* Keep my character first: while it shows and carries the server's
       * words (data-receipt, video-plain.js character.receipt: "keeps Mira: 2
       * pictures + 8 steps + song (lip-sync)"), they are this field; with
       * none, the slider's "N steps". Change leads to both. */
      { id: "steps", controls: ["vidCharacter", "vidSteps"] },
      { id: "length", controls: ["vidSecs"] },
      { id: "size", controls: ["vidSize", "vidW", "vidH"] },
      { id: "estimate", controls: [], estimate: true },
    ],
  },
};

/** Where each studio_status default is changed: the view and the control. */
export const DEFAULT_CONTROLS = {
  "music.engine": { view: "create", control: "musicEngine", screen: "music" },
  "image.engine": { view: "images", control: "imgEngine", screen: "image" },
  "art.engine": { view: "settings", control: "artEngine", screen: null },
  "video.steps": { view: "video", control: "vidSteps", screen: "video" },
};

/* ── reading a field off its control ───────────────────────────────────── */

/** Applies here: not inside something marked hidden (an engine's own row)
 *  BELOW the screen itself — a screen that is not open still has a receipt
 *  to paint for when it is. */
const rootOf = (screen) => $(RECEIPTS[screen].button)?.closest("section") || null;
function applies(el, root) {
  if (!el) return false;
  for (let e = el; e && e !== root; e = e.parentElement) if (e.hidden) return false;
  return true;
}
const optText = (el) => el?.selectedOptions?.[0]?.textContent?.trim() || el?.value || "";
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
/** The estimate the screen wrote, without its tail: "about 4:00", "2 takes · about 8:00 in total". */
export function estimateOf(text) {
  const m = /^((?:\d+ takes · )?about .+?)(?= on your card| once the engine| · |$)/.exec(String(text || "").trim());
  return m ? m[1] : null;
}

function fieldText(screen, f) {
  /* A control that is a slot for the server's words (data-receipt="", Keep my
   * character) steps aside while the slot is empty, and supplies them while
   * it holds some. */
  const el = f.controls.map($).find((x) => applies(x, rootOf(screen)) && x.dataset?.receipt !== "");
  if (el?.dataset?.receipt) return el.dataset.receipt;
  if (f.estimate) {
    const note = $(RECEIPTS[screen].note);
    return note && !note.classList.contains("stick") ? estimateOf(note.textContent) : null;
  }
  if (!el) return null;
  if (f.id === "rights") return el.dataset?.rightsShort || null;
  if (f.id === "draft") return el.checked && !el.disabled ? "Fast draft" : null;
  if (f.id === "engine") {
    const segs = optText(el).split(" — ")[0].split(":")[0].split(" · ");
    /* Music names the model ("YuE2 3B"), and says so when a key pays for it. */
    const keep = screen !== "music" ? 2 : /API/.test(segs[1] || "") ? 2 : 1;
    return segs.slice(0, keep).join(" · ").trim() || null;
  }
  if (f.id === "steps") {
    const n = parseInt(el.value, 10);
    return Number.isFinite(n) ? `${n} steps` : null;
  }
  if (f.id === "length") {
    const n = Number(el.value);
    if (!Number.isFinite(n)) return null;
    return screen === "music" ? `up to ${mmss(n)}` : `${n} s`;
  }
  if (f.id === "size") {
    const v = el.value === "custom" ? `${$(f.controls[1])?.value}x${$(f.controls[2])?.value}` : el.value;
    return /^\d+x\d+$/.test(v) ? v.replace("x", "×") : null;
  }
  if (f.id === "count") {
    const n = Number(el.value);
    return n > 1 ? `${n} pictures` : null;
  }
  return null;
}

/* ── painting ──────────────────────────────────────────────────────────── */

const fails = {};          // screen -> the last failed start, until a start goes through
let lastDefaults = [];

/** The note's qualifiers after its estimate ("re-rolls ~3× faster", "from
 *  your last 3 native songs", "references ride along, expect it slower"):
 *  the receipt carries them, so hiding the note hides nothing. */
export function tailOf(text) {
  const t = String(text || "").trim();
  const est = estimateOf(t);
  if (!est) return null;
  const rest = t.slice(est.length).replace(/^ (?:in total )?on your card/, "").replace(/^ once the engine is idle/, "")
    .replace(/^\s*·\s*/, "").trim();
  return rest || null;
}

/** The value a control holds, as an engine name ("yue2-comfy:x.safetensors" -> "yue2-comfy"). */
const engineOf = (el) => String(el?.value || "").split(":")[0];

function receiptEl(screen) {
  const spec = RECEIPTS[screen];
  const note = $(spec.note);
  if (!note?.parentNode) return null;
  let el = $(`${screen}Receipt`);
  if (!el) {
    el = document.createElement("div");
    el.id = `${screen}Receipt`;
    el.className = "receipt";
    el.setAttribute("aria-live", "polite");
    note.parentNode.insertBefore(el, note);
    note.parentNode.classList?.add("has-receipt");
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-control], button[data-fix]");
      if (!b) return;
      if (b.dataset.fix !== undefined) { fix(screen); return; }
      change(screen, b.dataset.control.split(" "));
    });
  }
  return el;
}

export function paint(screen) {
  const spec = RECEIPTS[screen];
  const el = receiptEl(screen);
  if (!el) return;
  const def = lastDefaults.find((d) => DEFAULT_CONTROLS[d.key]?.screen === screen && d.key !== "video.steps");
  const parts = [];
  for (const f of spec.fields) {
    const text = fieldText(screen, f);
    if (!text) continue;
    const owner = f.controls.filter((id) => applies($(id), rootOf(screen)));
    /* The default's sentence only while the control holds that default; once
     * the screen shows another engine it would describe the wrong one. */
    const title = f.id === "engine" && def && engineOf($(owner[0])) === def.value ? def.why
      : f.estimate ? ($(spec.note)?.textContent || "")
      : f.id === "rights" ? "Whether you may sell what this model makes: its licence's answer. Change the model to change it."
      : "Change this";
    parts.push(owner.length
      ? `<button type="button" class="rcf" data-control="${esc(owner.join(" "))}" title="${esc(title)}">${esc(text)}</button>`
      : `<span class="rcf" title="${esc(title)}">${esc(text)}</span>`);
    const tail = f.estimate ? tailOf($(spec.note)?.textContent) : null;
    if (tail) parts.push(`<span class="rctail">${esc(tail)}</span>`);
  }
  const first = spec.fields.flatMap((f) => f.controls).filter((id) => applies($(id), rootOf(screen)));
  const line = parts.length
    ? `${parts.join('<span class="rcsep">·</span>')}<span class="rcsep">·</span>`
      + `<button type="button" class="rcchange" data-control="${esc(first.join(" "))}">Change</button>`
    : "";
  const f = fails[screen];
  el.innerHTML = (line ? `<p class="rcline">${line}</p>` : "")
    + (f ? `<p class="rcfail">Couldn't start: ${esc(f.error)}${f.fixable ? ' <button type="button" class="rcchange" data-fix>Fix</button>' : ""}</p>` : "");
  el.hidden = !el.innerHTML;
  /* The note steps aside only while the receipt carries its estimate (and,
   * with it, the note's qualifiers). */
  const note = $(spec.note);
  const took = !!spec.fields.find((x) => x.estimate) && !!fieldText(screen, spec.fields.find((x) => x.estimate));
  note?.classList.toggle("rc-took", took);
}

const paintAll = () => { for (const s of Object.keys(RECEIPTS)) paint(s); };

/* ── Change: Advanced, then the control ────────────────────────────────── */

function toAdvanced(screen) {
  if (screen === "music") {
    if ($("modeSimple")?.getAttribute("aria-pressed") === "true") {
      if (typeof globalThis.aiplaySetSimple === "function") globalThis.aiplaySetSimple(false);
      else $("modeSong")?.click();
    }
    return;
  }
  const root = $(RECEIPTS[screen].button)?.closest("#imgPanel, #vidPanel") || null;
  const adv = root?.querySelector('.asmode button[data-m="advanced"]');
  if (adv && adv.getAttribute("aria-pressed") !== "true") adv.click();
}

/** Open what hides it, scroll to it, light it up. */
export function highlight(ids) {
  const els = ids.map($).filter(Boolean);
  if (!els.length) return;
  for (const el of els) {
    for (let d = el.closest("details"); d; d = d.parentElement?.closest("details")) d.open = true;
  }
  const target = els[0].closest(".pv, .field, label") || els[0];
  target.scrollIntoView?.({ block: "center", behavior: "smooth" });
  for (const el of els) {
    const box = el.closest(".pv") || el;
    box.classList.add("rc-hi");
    setTimeout(() => box.classList.remove("rc-hi"), 1800);
  }
  els[0].focus?.({ preventScroll: true });
}

function change(screen, ids) {
  toAdvanced(screen);
  setTimeout(() => highlight(ids), 60);
}

function fix(screen) {
  const f = fails[screen];
  if (f?.reply && typeof globalThis.aiplayOfferModel === "function") globalThis.aiplayOfferModel(f.reply);
}

/** A start the server refused, in its own words, with Fix where there is one.
 *  Called by web/app.js (typeof-guarded) with the note id it would have used. */
const screenOfNote = (noteId) => Object.keys(RECEIPTS).find((s) => RECEIPTS[s].note === noteId);
function startFailed(noteId, reply) {
  const screen = screenOfNote(noteId);
  if (!screen) return;
  const fixable = !!(reply?.needsModel || reply?.capability);
  fails[screen] = { error: String(reply?.error || "the server gave no reason"), fixable, reply };
  paint(screen);
}
/** A start that went through (Create, Preview, Make image, Render clip):
 *  the last "Couldn't start" goes. Called by web/app.js, typeof-guarded. */
function startOk(noteId) {
  const screen = screenOfNote(noteId);
  if (!screen || !fails[screen]) return;
  delete fails[screen];
  paint(screen);
}

/* ── Settings: "Picked for this PC" ────────────────────────────────────── */

/* "Let Studio pick": the door that forgets each saved choice, so the machine
 * picks from the disk again (set_music_engine / set_image_engine "auto"). */
export const LET_STUDIO_PICK = {
  "music.engine": ["/api/music", { action: "engine", value: "auto" }],
  "image.engine": ["/api/artconfig", { imageEngine: "auto" }],
  "art.engine": ["/api/artconfig", { engine: "auto" }],
};

function goTo(key) {
  const where = DEFAULT_CONTROLS[key];
  if (!where) return;
  document.querySelector(`a[data-view="${where.view}"]`)?.click();
  if (where.screen) toAdvanced(where.screen);
  setTimeout(() => highlight([where.control]), 120);
}

async function letStudioPick(key, button) {
  const door = LET_STUDIO_PICK[key];
  if (!door) return;
  button.disabled = true;
  try {
    const r = await (await fetch(door[0], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(door[1]) })).json();
    if (r?.error) { button.textContent = r.error; return; }
    /* The pickers on the page follow the new pick at the next status. */
    if (key === "music.engine") globalThis.aiplayMusicReseed = true;
    if (key === "image.engine") { imgOwn = false; imgShown = $("imgEngine")?.value ?? null; }
    button.textContent = "Studio picks from this PC now";
  } catch (e) { button.textContent = String(e?.message || e); }
}

function paintDefaults(defaults) {
  const list = $("defaultsList");
  if (!list) return;
  list.innerHTML = (defaults || []).map((d) => `<li class="${d.chosenBy === "you" ? "mine" : "machine"}${d.kept ? " kept" : ""}${d.canRun === false ? " off" : ""}">`
    + `<span title="${esc(d.label || "")}">${esc(d.why)}</span>`
    + (DEFAULT_CONTROLS[d.key] ? ` <button type="button" class="linkbtn" data-default="${esc(d.key)}">Change</button>` : "")
    + (d.chosenBy === "you" && LET_STUDIO_PICK[d.key] && !d.paid
      ? ` <button type="button" class="linkbtn" data-auto="${esc(d.key)}" title="Forget this choice: Studio picks from what is on this PC, and follows it when a download finishes">Let Studio pick</button>` : "")
    + "</li>").join("");
  if (!list.dataset.wired) {
    list.dataset.wired = "1";
    list.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-default]");
      if (b) { goTo(b.dataset.default); return; }
      const a = e.target.closest("button[data-auto]");
      if (a) letStudioPick(a.dataset.auto, a);
    });
  }
}

/* THE IMAGES ENGINE: the saved one, or the machine's pick when nobody chose
 * (the HTML's `selected` is only the last resort), and it follows the server
 * while it still holds what this file last put there. A person's pick is
 * SAVED (POST /api/artconfig imageEngine, like the covers card), so it
 * survives a reload; a template or the assistant changing it, or "Your own
 * model file" (picked per picture, never saved), ends the following for this
 * visit. */
let imgShown = null;
let imgOwn = false;
function followImageDefault(defaults) {
  const sel = $("imgEngine");
  const d = (defaults || []).find((x) => x.key === "image.engine");
  if (!sel || !d || imgOwn) return;
  if (imgShown !== null && sel.value !== imgShown) { imgOwn = true; return; }
  if (sel.value === d.value || ![...sel.options].some((o) => o.value === d.value)) { imgShown = sel.value; return; }
  sel.value = d.value;
  imgShown = d.value;
  sel.onchange?.();
}
function imageEnginePicked(sel) {
  if (sel.value === "checkpoint") { imgOwn = true; return; }
  imgShown = sel.value;
  fetch("/api/artconfig", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageEngine: sel.value }) })
    .catch(() => { /* offline: it holds for this visit */ });
}

/* ── wiring ────────────────────────────────────────────────────────────── */

/** Called by web/app.js applyStatus with each /api/status (typeof-guarded). */
function onStatus(s) {
  lastDefaults = Array.isArray(s?.config?.defaults) ? s.config.defaults : lastDefaults;
  paintDefaults(lastDefaults);
  followImageDefault(lastDefaults);
  paintAll();
}

if (typeof document !== "undefined") {
  globalThis.aiplayReceipts = onStatus;
  globalThis.aiplayStartFailed = startFailed;
  globalThis.aiplayStartOk = startOk;
  const boot = () => {
    const ids = new Set(Object.values(RECEIPTS).flatMap((r) => r.fields.flatMap((f) => f.controls)));
    const again = (e) => {
      const id = e.target?.id;
      if (e.type === "change" && id === "imgEngine") {
        if (e.isTrusted) imageEnginePicked(e.target);
        else if (e.target.value !== imgShown) imgOwn = true;
      }
      /* The covers card remembers a person's pick even when it equals the
       * machine's (app.js artSave sends `choose`). */
      if (e.type === "change" && id === "artEngine" && e.isTrusted) e.target.dataset.touched = "1";
      if (ids.has(id)) setTimeout(paintAll, 0);
    };
    document.addEventListener("input", again, true);
    document.addEventListener("change", again, true);
    /* The notes the estimates are written into: repaint when they change. */
    if (typeof MutationObserver === "function") {
      const mo = new MutationObserver(() => paintAll());
      for (const r of Object.values(RECEIPTS)) {
        const n = $(r.note);
        if (n) mo.observe(n, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
      }
      /* ...and when a control's server words change (data-receipt, written by
       * web/vidfit.js after each check). */
      for (const id of ids) { const c = $(id); if (c) mo.observe(c, { attributes: true, attributeFilter: ["data-receipt"] }); }
    }
    imgShown = $("imgEngine")?.value ?? null;   // what the page opened on
    paintAll();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
