/**
 * THE LEVEL, on the page: do Music, Pictures and Video open Simple or Advanced.
 *
 * UI_PLAN E1, and the owner's words of 2026-09-24: "have it open on simple but
 * make it clear there is an advanced with a tooltip option that shows what you
 * get". A new install opens Simple; an install already in use keeps Advanced.
 *
 * THIS FILE DECIDES NOTHING AND WRITES NO COPY. /api/welcome {action:"level"}
 * (server/welcome/level.js) says which level, who chose it, the one line
 * Settings shows about that, and each screen's "Advanced adds ..." tooltip.
 * The same answer is studio_welcome {action:"level"} for an agent and
 * `config.ui` on /api/status. This file shows it and passes it on.
 *
 * Each screen keeps its own Simple / Advanced switch, owned where it always
 * was: Music in web/app.js (setSimple), Pictures and Video in web/assist.js.
 * They subscribe with onLevel() and get one of three kinds of news:
 *
 *   boot  the saved level, once, on page load. A screen the person has
 *         already switched by hand keeps what they chose.
 *   home  a Home card was pressed: that one screen opens Simple, whatever
 *         the level (UI_PLAN D1 and E1). `view` names it.
 *   all   the person changed the level ("Show every setting", in Settings or
 *         at the foot of the rail): every screen follows at once.
 *
 * The per-screen switches do NOT change the saved level. Pressing Advanced on
 * Video once is a choice for this visit; "Show every setting" is the one that
 * is remembered, in settings.json, where an agent can read it too.
 */

const $ = (id) => (typeof document !== "undefined" ? document.getElementById(id) : null);
/* The screens that have a Simple form are the server's (`screens`, the keys of
 * server/welcome/level.js ADVANCED_ADDS); this file keeps no list of them. */

const subs = new Set();
let last = null;

const post = async (body) => {
  const r = await fetch("/api/welcome", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
};

function tell(news) {
  for (const fn of subs) {
    try { fn(news); } catch (err) { console.warn("[level]", err); }
  }
}

/** Subscribe. A late subscriber gets the boot news at once, if it is known. */
export function onLevel(fn) {
  subs.add(fn);
  if (last) {
    try { fn({ ...last, simple: last.level === "simple", boot: true }); } catch (err) { console.warn("[level]", err); }
  }
  return () => subs.delete(fn);
}

/** The last answer from the server, or null before it came. */
export const levelNow = () => last;

/* Settings' switch, its line, and the rail's way out of Simple. A save that
 * failed keeps its reason on screen (`error`) until the next change, in
 * Settings' line and on the rail button's tooltip. */
function paint(st, error = "") {
  const foot = $("levelFoot");
  if (foot) {
    foot.hidden = st.level !== "simple";
    foot.title = error ? `Not saved: ${error}` : (st.line || "");
  }
  const box = $("levelAll");
  if (box) box.checked = st.level === "advanced";
  const note = $("levelNote");
  if (note) note.textContent = error ? `Not saved: ${error}` : (st.line || "");
}

/** Save a level the person chose. Every screen follows it. */
export async function levelSave(level) {
  let r = null;
  try { r = await post({ action: "level", level }); } catch (err) { r = { error: err?.message || String(err) }; }
  if (!r || r.error) {
    /* Put the switch back where the saved level is, THEN say why. */
    paint(last || { level: level === "simple" ? "advanced" : "simple" }, r?.error || "no answer");
    return null;
  }
  last = r;
  paint(r);
  tell({ ...r, simple: r.level === "simple", all: true });
  return r;
}

async function boot() {
  let r = null;
  try { r = await post({ action: "level" }); } catch { return; }
  if (!r || r.error || !r.level) return;
  last = r;
  paint(r);
  tell({ ...r, simple: r.level === "simple", boot: true });
}

if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  /* A Home card opens its screen on Simple, whatever the level. Delegated and
   * read at click time, so a Home that is redrawn keeps working. The screens
   * are the server's; before its answer arrives every card is passed on, and
   * each screen listens only for its own view. */
  document.addEventListener("click", (e) => {
    const a = e.target?.closest?.("#home [data-go]");
    const view = a?.dataset?.go;
    if (!view || (Array.isArray(last?.screens) && !last.screens.includes(view))) return;
    tell({ ...(last || {}), view, simple: true, home: true });
  });
  const wire = () => {
    $("levelFoot")?.addEventListener("click", () => levelSave("advanced"));
    $("levelAll")?.addEventListener("change", (e) => levelSave(e.target.checked ? "advanced" : "simple"));
    boot();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
}
