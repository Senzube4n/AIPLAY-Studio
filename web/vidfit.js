/* THE VIDEO SCREEN FOLLOWS THE CARD (the H3 lab of 2026-09-24, #5-#7; UI_PLAN
 * C3 and E4).
 *
 * Everything this file shows is the server's: it holds no threshold, no size
 * and no sentence of its own (server/vidfit_test.js holds it to that). Even
 * which engines the card is about is the server's (`h3Tiers` per engine).
 *
 *   Size for this card   #vidTierRow: the card's tier and the smaller ones as
 *                        plain chips (/api/status config.video.h3.choices,
 *                        server/h3tier.js). A chip writes the real size list and
 *                        length (#vidSize, #vidSecs), and says so when it
 *                        shortens the clip. On a smaller card the list starts
 *                        on the tier (config.video.h3.start) each time it is
 *                        built, while it still sits on its own first size;
 *                        every other size stays under "size". Where H3 is not
 *                        offered, the server's one sentence instead (friend
 *                        first, your own key second), and Render asks before
 *                        it sends. Shown in Simple too.
 *   What this size needs #vidFitNote, Advanced: POST /api/video check
 *                        (server/video-plain.js videoPlan), the "needs about X
 *                        GB free; you have Y" line, what the render would
 *                        change and its caveats. make_clip's check_only reads
 *                        the same answer.
 *   Sparse attention     #vidSparse: follows the saved choice (an agent's
 *                        video_settings change too); changing it saves
 *                        video_settings' sparse_attention, and a render names
 *                        it only while it differs from the saved one.
 *   More motion          #vidMoreMotion: FastH3, off the main engine list,
 *                        picks the same (hidden) option of #vidEngine.
 *   References           #vidRefIgnored: the server's sentence when the engine
 *                        ignores them and some are attached.
 *   Keep my character    #vidKeepNote: the server's line (video-plain.js
 *                        character.hint), or its refusal (no such character, an
 *                        engine without references); #vidCharacter carries the
 *                        server's receipt (character.receipt) for web/receipt.js.
 *                        The check names the saved character and says whether a
 *                        song sits under the clip (#vidSndRow shows exactly then).
 *   Song under the clip  #vidSndMeta and #vidSndHint: the server's words for
 *                        this engine (video-plain.js songUnderSay): lip-sync on
 *                        H3 with pictures, measured not to follow on LTX.
 *   At render time       #vidRamNote (under 32 GB of RAM) and #vidFail, the last
 *                        failed render in words, the engine's text under
 *                        Details.
 *
 * web/app.js calls aiplayVidFit with each /api/status (typeof-guarded), the
 * way it calls web/receipt.js, and asks aiplayVidSparse / aiplayVidAsk from
 * Render. Nothing here edits app.js state: it writes the page's own controls
 * and lets their handlers run.
 */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fire = (el, type = "input") => el?.dispatchEvent(new Event(type, { bubbles: true }));

let S = null;                 // the last /api/status
let sparseMine = null;        // the person's sparse pick, until the saved value says the same
let attnOpened = false;       // FastH3's attention took the server's default once
let startedList = null;       // the size list (its first option) the card's size was considered for
let startedKey = "";          // ...and the start size it was considered with
let capSaid = "";             // the server's sentence for a length a chip or the start shortened
const opened = Date.now();    // failures older than this page are not news

const video = () => S?.config?.video || {};
const engineKey = () => $("vidEngine")?.value || video().engine || "h3";
/* The engines the card tiers are about: the server says (`h3Tiers`). */
const family = (k) => !!video().engines?.[k]?.h3Tiers;

function sizeNow() {
  const sel = $("vidSize");
  if (sel?.value === "custom") return [Number($("vidW")?.value) || 0, Number($("vidH")?.value) || 0];
  const [w, h] = String(sel?.value || "").split("x").map(Number);
  return [w || 0, h || 0];
}
const refNames = (sel) => [...document.querySelectorAll(sel)].map((e) => e.dataset.refname).filter(Boolean);
const hasOption = (sel, val) => [...sel.options].some((o) => o.value === val);

/* ── Size for this card ───────────────────────────────────────────────── */

function paintTiers() {
  const row = $("vidTierRow"), chips = $("vidTierChips"), note = $("vidTierNote");
  if (!row || !chips || !note) return;
  const h3 = video().h3;
  const on = !!h3 && family(engineKey());
  row.hidden = !on;
  if (!on) return;
  if (h3.notOffered) {
    chips.hidden = true;
    chips.innerHTML = "";
    chips.dataset.sig = "";
    note.hidden = false;
    note.classList.add("warnhint");
    note.textContent = h3.notOffered;
    return;
  }
  note.classList.remove("warnhint");
  const choices = Array.isArray(h3.choices) ? h3.choices : [];
  chips.hidden = !choices.length;
  const sig = JSON.stringify(choices);
  if (chips.dataset.sig !== sig) {
    chips.dataset.sig = sig;
    chips.innerHTML = choices.map((c) => `<button type="button" data-tier="${esc(c.id)}" data-w="${Number(c.width)}"`
      + ` data-h="${Number(c.height)}" data-s="${Number(c.maxSeconds) || 0}"${c.experimental ? " data-experimental" : ""}`
      + ` title="${esc(c.title || "")}" aria-pressed="false">${esc(c.chip)}</button>`).join("");
  }
  const [w, h] = sizeNow();
  for (const b of chips.querySelectorAll("button[data-tier]")) {
    b.setAttribute("aria-pressed", String(w === Number(b.dataset.w) && h === Number(b.dataset.h)));
  }
  /* The card's own caveat, where it has one (an unread card, the experimental
   * preview), and what a chip or the start did to the length. */
  const t = h3.tier || {};
  const say = [t.id === "unknown" || t.experimental ? t.evidence : "", capSaid].filter(Boolean).join(" ");
  note.hidden = !say;
  note.textContent = say;
}

/** A length no longer than the tier's own, and the server's sentence when it cut one. */
function capSeconds(max, said) {
  const secs = $("vidSecs");
  if (!secs || !(Number(max) > 0) || Number(secs.value) <= Number(max)) return;
  secs.value = String(max);
  fire(secs);
  capSaid = said || "";
}

function pickTier(b) {
  const sel = $("vidSize");
  const val = `${b.dataset.w}x${b.dataset.h}`;
  if (!sel || !hasOption(sel, val)) return;
  sel.value = val;
  fire(sel); fire(sel, "change");
  const c = (video().h3?.choices || []).find((x) => x.id === b.dataset.tier);
  capSeconds(b.dataset.s, c?.lengthSaid);
  paintTiers();
  schedule();
}

/* The size list starts on the card's size on a smaller card: each time the
 * list is built anew (the first status, every engine switch, which rebuilds
 * it with new options) and when the card's reading first arrives, and only
 * while the list still sits on its own first size: a size the person (or a
 * recipe) picked is theirs. Where the server sends no start (a full-size
 * card, an unread card, H3 not offered) the list keeps its own first size.
 * Keyed on the list's first option itself, not on its values, so a list
 * rebuilt to the same sizes (H3, LTX, back to H3) is a new list. */
function startAtTier() {
  const sel = $("vidSize");
  const h3 = video().h3;
  if (!sel || !sel.options.length || !h3 || !family(engineKey())) return;
  const st = h3.start || null;
  const key = st ? `${st.width}x${st.height}` : "";
  const first = sel.options[0];
  if (first === startedList && key === startedKey) return;
  startedList = first; startedKey = key;
  if (!st || sel.value !== first.value || !hasOption(sel, key)) return;
  sel.value = key;
  fire(sel);
  capSeconds(st.maxSeconds, st.lengthSaid);
}

/* H3's custom boxes step on its grid, and a typed side lands on it. */
function gridBoxes() {
  const grid = family(engineKey()) ? Number(video().h3?.grid) : 0;
  for (const id of ["vidW", "vidH"]) {
    const el = $(id);
    if (!el) continue;
    if (!el.dataset.step0) el.dataset.step0 = el.step || "";
    el.step = grid > 0 ? String(grid) : el.dataset.step0;
  }
}
function snapBox(el) {
  const grid = family(engineKey()) ? Number(video().h3?.grid) : 0;
  const v = Number(el.value);
  if (!(grid > 0) || !(v > 0)) return;
  const snapped = Math.max(grid, Math.round(v / grid) * grid);
  if (snapped !== v) { el.value = String(snapped); fire(el); }
}

/* ── what this size needs, and what the render would change ─────────── */

let timer = 0, asked = 0;
function schedule() { clearTimeout(timer); timer = setTimeout(check, 350); }

async function check() {
  const note = $("vidFitNote");
  if (!note || !S || $("vidPanel")?.hidden) return;
  const [width, height] = sizeNow();
  const stepRow = $("vidSteps")?.closest(".pv");
  const body = {
    action: "check",
    prompt: $("vidPrompt")?.value || "",
    width: width || undefined, height: height || undefined,
    seconds: Number($("vidSecs")?.value) || undefined,
    steps: stepRow && !stepRow.hidden ? Number($("vidSteps").value) || undefined : undefined,
    sparse: sparseToSend(),
    framed: !!($("vidFrom")?.value || $("vidTo")?.value) || undefined,
    refImages: refNames("#vidRefImgPrev [data-refname]"),
    refAudios: [...document.querySelectorAll("#vidRefAudPrev [data-refname]")]
      .map((e) => ({ name: e.dataset.refname, start: Number(e.dataset.refstart) || 0 })),
    persona: $("vidCharacter")?.value || undefined,
    song: $("vidSndRow") && !$("vidSndRow").hidden ? true : undefined,
    /* The decoder picked under Engine settings, so the Advanced "Runs" line
     * names the one this render loads (the same rule as the render's own). */
    videoVae: videoVaeChosen(),
  };
  const mine = ++asked;
  let r;
  try {
    r = await (await fetch("/api/video", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })).json();
  } catch { return; }
  if (mine !== asked || !r) return;
  const lines = [];
  if (r.fit?.sentence) lines.push(r.fit.sentence);
  /* Each sentence has one place: the RAM line at the button, the reference
   * refusal in the slots, "not offered" in the size row. Everything else the
   * render would change is said here, then the caveats. */
  const elsewhere = new Set(["ram", "fit", "not-offered"]);
  for (const w of Array.isArray(r.warnings) ? r.warnings : []) if (w?.text && !elsewhere.has(w.id)) lines.push(w.text);
  for (const n of Array.isArray(r.notes) ? r.notes : []) if (n?.text) lines.push(n.text);
  if (r.refusal && r.refusal.reason !== "refs-ignored" && typeof r.refusal.error === "string") lines.push(r.refusal.error);
  note.textContent = lines.join(" ");
  note.title = r.fit?.scope || "";
  note.hidden = !lines.length;
  paintKeep(r);
  paintSong(r);
}

/* The decoder Engine settings names for this render, or undefined for the
 * engine's own: app.js vidModelChoice's rule (a visible, non-auto choice). */
function videoVaeChosen() {
  const el = $("vidVideoVae");
  return el && !el.closest?.("[hidden]") && el.value && el.value !== "auto" ? el.value : undefined;
}

/* Song under the clip, in the server's words for this engine: the label's
 * "lip-sync" only where mouths follow the song (H3), the line under it. */
function paintSong(r) {
  const s = r?.songLine;
  if (!s) return;
  const meta = $("vidSndMeta"), hint = $("vidSndHint");
  if (meta && typeof s.meta === "string") meta.textContent = s.meta;
  if (hint && typeof s.hint === "string") hint.textContent = s.hint;
}

/* Keep my character, in the server's words: its line under the row, its
 * receipt on the select (web/receipt.js reads data-receipt), and its refusal
 * when the character or the engine cannot keep anyone. */
function paintKeep(r) {
  const note = $("vidKeepNote"), sel = $("vidCharacter");
  if (!note) return;
  const refused = r.refusal && (r.refusal.reason === "refs-ignored" || r.refusal.reason === "persona")
    && typeof r.refusal.error === "string" ? r.refusal.error : "";
  const say = refused || r.character?.hint || "";
  note.textContent = say;
  note.hidden = !say;
  note.classList?.toggle("warnhint", !!refused);
  /* An empty slot ("") lets the receipt fall back to the slider's steps. */
  const want = r.character?.receipt && !refused ? r.character.receipt : "";
  if (sel?.dataset && sel.dataset.receipt !== want) sel.dataset.receipt = want;
}

/* ── sparse attention, More motion, FastH3's attention ──────────────── */

/* The switch follows the saved value (the server's, which an agent can change
 * too) except while the person's own pick has not been saved yet. */
function paintSparse() {
  const sp = video().engines?.h3?.sparse, sel = $("vidSparse");
  const on = engineKey() === "h3" && !!sp;
  for (const id of ["vidSparseL", "vidSparseW"]) if ($(id)) $(id).hidden = !on;
  if (!sp || !sel) return;
  const opts = Array.isArray(sp.options) ? sp.options : [];
  if (sel.dataset.sig !== opts.join("|")) {
    sel.dataset.sig = opts.join("|");
    sel.innerHTML = opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
  }
  if (sparseMine !== null && sparseMine === sp.value) sparseMine = null;
  const want = sparseMine ?? sp.value;
  if (opts.includes(want) && sel.value !== want) sel.value = want;
  sel.title = sp.note || "";
  if ($("vidSparseL")) $("vidSparseL").title = sp.note || "";
}
/** What a render names: nothing while the switch says what is saved (the
 *  saved setting applies, and no default is sent as a request), the pick
 *  otherwise. */
function sparseToSend() {
  const sp = video().engines?.h3?.sparse, v = $("vidSparse")?.value;
  return engineKey() === "h3" && sp && v && v !== sp.value ? v : undefined;
}
async function sparsePicked(sel) {
  sparseMine = sel.value;
  schedule();
  /* The same saved value an agent reads and sets (video_settings
   * sparse_attention). Until it lands, a render names the pick itself. */
  try {
    await fetch("/api/videolab", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_knob", id: "sparse_attention", value: sel.value }) });
  } catch { /* offline: this visit's renders still name it */ }
}

function advancedEngine() {
  return Object.entries(video().engines || {}).find(([, e]) => e?.advanced) || [];
}
function paintMoreMotion() {
  const row = $("vidMoreMotionRow"), box = $("vidMoreMotion");
  if (!row || !box) return;
  const [key, e] = advancedEngine();
  const cur = engineKey();
  const on = !!key && family(cur);
  row.hidden = !on;
  if (!on) return;
  if ($("vidMoreMotionL")) $("vidMoreMotionL").textContent = e.advanced.label || key;
  row.title = e.advanced.note || "";
  box.checked = cur === key;
}
function moreMotionPicked(box) {
  const [key] = advancedEngine();
  const sel = $("vidEngine");
  /* Its partner is the H3 engine it distils: the one family member that is
   * not Advanced-only. */
  const back = Object.entries(video().engines || {}).find(([k, x]) => !x?.advanced && family(k))?.[0];
  const want = box.checked ? key : back;
  if (!sel || !want || !hasOption(sel, want)) return;
  sel.value = want;
  fire(sel, "change");
}

/* FastH3's dense attention starts on the server's default (Kitchen where the
 * engine has it), unless this browser already kept a pick. */
function paintAttnDefault() {
  if (attnOpened) return;
  const [, e] = Object.entries(video().engines || {}).find(([, x]) => x?.attention) || [];
  const sel = $("vidAttn");
  if (!e || !sel) return;
  attnOpened = true;
  let kept = null;
  try { kept = localStorage.getItem("aiplayVidAttn"); } catch { /* storage blocked */ }
  if (!kept && hasOption(sel, e.attention)) sel.value = e.attention;
}

/* ── references, RAM, a failed render, the question before Render ───── */

function paintRefLine() {
  const el = $("vidRefIgnored");
  if (!el) return;
  const said = video().engines?.[engineKey()]?.refsIgnored || "";
  const attached = document.querySelectorAll("#vidRefImgPrev [data-refname], #vidRefAudPrev [data-refname]").length;
  el.hidden = !(said && attached);
  el.textContent = said && attached ? said : "";
}

function paintRam() {
  const el = $("vidRamNote");
  if (!el) return;
  const said = family(engineKey()) ? video().h3?.ramWarning || "" : "";
  el.hidden = !said;
  el.textContent = said;
}

function paintFail() {
  const el = $("vidFail");
  if (!el) return;
  const last = (S?.art?.recent || []).find((r) => r?.kind === "video");
  const show = !!(last && last.error && Number(last.at || 0) >= opened);
  if (!show) { el.hidden = true; el.innerHTML = ""; el.dataset.sig = ""; return; }
  el.hidden = false;
  if (el.dataset.sig === String(last.id)) return;   // keep Details open across polls
  el.dataset.sig = String(last.id);
  el.innerHTML = `<span>${esc(last.title ? `${last.title}: ` : "")}${esc(last.error)}</span>`
    + (last.detail ? `<details><summary>Details</summary><pre>${esc(last.detail)}</pre></details>` : "");
}

/** Render on a card H3 is not offered on: the server's sentence, asked before
 *  anything is sent, never a silent render and never a silent stop. `ask` is
 *  the page's own dialog (app.js passes appConfirm). */
async function askBeforeRender(ask) {
  const said = family(engineKey()) ? video().h3?.notOffered : null;
  if (!said || typeof ask !== "function") return true;
  return !!(await ask(said, { ok: "Render anyway", cancel: "Cancel" }));
}

/* ── wiring ─────────────────────────────────────────────────────────── */

function paintAll() {
  paintTiers(); paintSparse(); paintMoreMotion(); paintAttnDefault(); paintRefLine(); paintRam(); paintFail(); gridBoxes();
}

let lastEngine = null, shown = false;
function onStatus(s) {
  S = s;
  startAtTier();
  paintAll();
  /* Asked again when the engine changes and when the screen comes into view. */
  const vis = !$("vidPanel")?.hidden;
  if (engineKey() !== lastEngine || (vis && !shown)) { lastEngine = engineKey(); schedule(); }
  shown = vis;
}

if (typeof document !== "undefined") {
  globalThis.aiplayVidFit = onStatus;
  globalThis.aiplayVidSparse = sparseToSend;
  globalThis.aiplayVidAsk = askBeforeRender;
  const WATCH = new Set(["vidSize", "vidW", "vidH", "vidSecs", "vidSteps", "vidPrompt", "vidEngine", "vidSparse", "vidFrom", "vidTo",
    "vidCharacter", "vidSndSong", "vidSndStart", "vidVideoVae"]);
  const boot = () => {
    const again = (e) => {
      const id = e.target?.id;
      if (!WATCH.has(id)) return;
      if (e.type === "change" && e.isTrusted && (id === "vidW" || id === "vidH")) snapBox(e.target);
      if (e.type === "change" && e.isTrusted && id === "vidSparse") sparsePicked(e.target);
      /* A length or size the person set by hand is theirs: the chip's line goes. */
      if (e.isTrusted && (id === "vidSecs" || id === "vidSize")) capSaid = "";
      paintTiers(); paintRefLine(); paintRam(); paintSparse(); paintMoreMotion(); gridBoxes();
      schedule();
    };
    document.addEventListener("input", again, true);
    document.addEventListener("change", again, true);
    $("vidTierChips")?.addEventListener("click", (e) => { const b = e.target.closest?.("button[data-tier]"); if (b) pickTier(b); });
    $("vidMoreMotion")?.addEventListener("change", (e) => moreMotionPicked(e.target));
    if (typeof MutationObserver === "function") {
      const sel = $("vidSize");
      if (sel) new MutationObserver(() => { startAtTier(); paintTiers(); }).observe(sel, { childList: true });
      const refs = new MutationObserver(() => { paintRefLine(); schedule(); });
      for (const id of ["vidRefImgPrev", "vidRefAudPrev"]) if ($(id)) refs.observe($(id), { childList: true });
      /* A song file picked by upload shows #vidSndRow without an input event. */
      const row = $("vidSndRow");
      if (row) {
        let was = row.hidden;
        new MutationObserver(() => { if (row.hidden !== was) { was = row.hidden; schedule(); } })
          .observe(row, { attributes: true, attributeFilter: ["hidden"] });
      }
    }
    paintAll();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
