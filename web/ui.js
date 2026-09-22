/**
 * THE PAGE KIT, the moving parts. Styles in web/ui.css, rules in
 * docs/UI_GUIDE.md.
 *
 *   1. Pill bars. Every `.pnav` is filled with one pill per `.pcard[data-nav]`
 *      in the same page. A click scrolls to the section; the pill of the
 *      section in view is lit. A new section needs no code: give it
 *      `class="pcard" id="…" data-nav="Label"` and the pill appears.
 *   2. Long hints. Any `p.hint` / `div.hint` taller than two lines is cut to
 *      two with a "more" at the end; a click opens it, another closes it.
 *      Warnings (.warnhint), live status (role=status, aria-live) and
 *      anything marked .noclamp stay whole.
 */

/* ── 1. pill bars ─────────────────────────────────────────────────────────── */

function scrollerOf(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement || document.documentElement;
}

function fillNav(nav) {
  const page = nav.closest(".page") || nav.parentElement;
  const cards = [...page.querySelectorAll(".pcard[data-nav]")].filter((c) => c.id && !c.hidden);
  const sig = cards.map((c) => c.id).join("|");
  if (nav.dataset.sig === sig) return;
  nav.dataset.sig = sig;
  nav.replaceChildren(...cards.map((c) => {
    const a = document.createElement("a");
    a.href = `#${c.id}`;
    a.textContent = c.dataset.nav;
    a.dataset.target = c.id;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      c.scrollIntoView({ behavior: "smooth", block: "start" });
      light(nav, c.id);
    });
    return a;
  }));
}

function light(nav, id) {
  for (const a of nav.children) a.classList.toggle("on", a.dataset.target === id);
}

/* Which section is "in view": the last one whose top has passed the pill bar. */
function spy(nav) {
  const page = nav.closest(".page") || nav.parentElement;
  if (page.hidden || page.offsetParent === null) return;
  const cards = [...page.querySelectorAll(".pcard[data-nav]")].filter((c) => c.id && !c.hidden);
  if (!cards.length) return;
  const edge = nav.getBoundingClientRect().bottom + 12;
  let current = cards[0];
  for (const c of cards) if (c.getBoundingClientRect().top <= edge) current = c;
  const sc = scrollerOf(page);
  if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) current = cards[cards.length - 1];
  light(nav, current.id);
}

function mountNavs() {
  for (const nav of document.querySelectorAll(".pnav")) {
    fillNav(nav);
    spy(nav);
  }
}

let spyQueued = false;
document.addEventListener("scroll", () => {
  if (spyQueued) return;
  spyQueued = true;
  requestAnimationFrame(() => {
    spyQueued = false;
    for (const nav of document.querySelectorAll(".pnav")) spy(nav);
  });
}, true);

/* ── 2. long hints ────────────────────────────────────────────────────────── */

const CLAMPABLE = "p.hint, div.hint";
const EXEMPT = ".warnhint, .noclamp, [role=status], [aria-live]";

function measure(el) {
  if (el.classList.contains("open") || el.matches(EXEMPT) || el.offsetParent === null) return;
  el.classList.add("clipped");
  /* Clamped to two lines by the class itself: if nothing is hidden, it was
   * short all along and the "more" must not show. */
  if (el.scrollHeight <= el.clientHeight + 2) el.classList.remove("clipped");
}

let measureQueued = false;
function measureAll() {
  if (measureQueued) return;
  measureQueued = true;
  requestAnimationFrame(() => {
    measureQueued = false;
    for (const el of document.querySelectorAll(CLAMPABLE)) {
      if (!el.classList.contains("clipped")) measure(el);
    }
  });
}

document.addEventListener("click", (e) => {
  const el = e.target.closest?.(CLAMPABLE);
  if (!el || e.target.closest("a, button, input, select, textarea, summary")) return;
  if (el.classList.contains("clipped")) { el.classList.remove("clipped"); el.classList.add("open"); }
  else if (el.classList.contains("open")) { el.classList.remove("open"); measure(el); }
});

/* Text that changes (a status line rewritten) is measured again. */
new MutationObserver((list) => {
  for (const m of list) {
    const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
    const hint = el?.closest?.(CLAMPABLE);
    if (hint && !hint.classList.contains("open")) hint.classList.remove("clipped");
  }
  measureAll();
  mountNavs();
}).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });

window.addEventListener("resize", () => {
  for (const el of document.querySelectorAll(`${CLAMPABLE.split(", ").map((s) => `${s}.clipped`).join(", ")}`)) el.classList.remove("clipped");
  measureAll();
});

mountNavs();
measureAll();
