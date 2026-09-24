/**
 * THE RAIL'S FOLD: "More tools" (UI_PLAN B1).
 *
 * The rail puts what a newcomer comes for on top (Home, Music, Pictures,
 * Video, Music video) and folds every other screen into one <details>,
 * #navMore. Before this, only 9 of 21 entries showed at 1440x900 and Models
 * was not one of them. This file does three small things for the fold and
 * nothing else; setView() in web/app.js still owns every entry, through
 * ".nav a", exactly as before.
 *
 *   1. Open or folded is remembered per viewer, in this browser. localStorage
 *      in try/catch: a private window or blocked storage just starts folded.
 *   2. When the screen on show lives inside the fold (the Chat link, a Home
 *      button, an agent), the fold opens so the highlighted entry can be
 *      seen. That opening is not saved; it is the page following you.
 *   3. The fold's tooltip lists what is in it, read from its own VISIBLE
 *      links, so there is no second list to go stale, and a launcher mode
 *      that hides entries (Music only, Comfy API: web/app.js applyStatus) is
 *      not told about screens it cannot open. Rebuilt when a link is hidden.
 */
const KEY = "aiplayRailMore";

function mount() {
  const more = document.getElementById("navMore");
  if (!more) return;

  try { more.open = localStorage.getItem(KEY) === "1"; } catch { /* private mode: folded */ }
  let following = false;
  more.addEventListener("toggle", () => {
    if (following) { following = false; return; }
    try { localStorage.setItem(KEY, more.open ? "1" : "0"); } catch { /* private mode */ }
  });

  const head = more.querySelector("summary");
  const tip = () => {
    if (!head) return;
    const names = [...more.querySelectorAll("a")]
      .filter((a) => !a.hidden && a.style?.display !== "none")
      .map((a) => a.querySelector(".lbl")?.textContent.trim()).filter(Boolean);
    const want = names.length ? `More tools: ${names.join(", ")}` : "More tools";
    if (head.title !== want) head.title = want;
  };

  /* The highlight moves by a class change on the link (setView toggles "on"). */
  const reveal = () => {
    if (!more.open && more.querySelector("a.on")) { following = true; more.open = true; }
  };
  reveal();
  tip();
  if (typeof MutationObserver === "function") {
    new MutationObserver(() => { reveal(); tip(); })
      .observe(more, { subtree: true, attributes: true, attributeFilter: ["class", "hidden", "style"] });
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
}
