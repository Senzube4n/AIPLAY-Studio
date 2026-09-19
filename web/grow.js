/**
 * Grow handles, shared by Music (app.js), Images and Video (app.js, assist.js).
 */

/* ── grow handles ─────────────────────────────────────────────────────────
 * A light-blue bar on the bottom edge of a box's outer border, shown only
 * while the pointer is near it (not over the writing space): drag it
 * down (or press ↓ on it) to make the box taller, up to shrink it; a double
 * click puts the height back. It replaces the textarea's corner grip. The
 * height is remembered in this browser only. */
export function growHandle(ta, key, place) {
  if (!ta) return;
  const bar = document.createElement("div");
  bar.className = "growbar";
  bar.tabIndex = 0;
  bar.setAttribute("role", "separator");
  bar.setAttribute("aria-orientation", "horizontal");
  bar.setAttribute("aria-label", "Drag to resize the box");
  bar.title = "Drag to resize · double-click to reset";
  bar.innerHTML = "<i></i>";
  place(bar);
  ta.style.boxSizing = "border-box";
  const store = `aiplayGrow:${key}`;
  const save = () => { try { localStorage.setItem(store, String(parseInt(ta.style.height, 10) || "")); } catch { /* private mode */ } };
  try { const h = +localStorage.getItem(store); if (h > 0) ta.style.height = `${h}px`; } catch { /* private mode */ }
  const setH = (h) => { ta.style.height = `${Math.max(60, Math.round(h))}px`; };
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const y0 = e.clientY, h0 = ta.offsetHeight;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add("drag");
    const move = (ev) => setH(h0 + ev.clientY - y0);
    const up = () => {
      bar.classList.remove("drag");
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      bar.removeEventListener("pointercancel", up);
      save();
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
  });
  bar.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    setH(ta.offsetHeight + (e.key === "ArrowDown" ? 24 : -24));
    save();
  });
  bar.addEventListener("dblclick", () => {
    ta.style.height = "";
    try { localStorage.removeItem(store); } catch { /* private mode */ }
  });
}

/** A box with no frame of its own to hang the bar on: give it one. */
export function growWrap(ta, key) {
  if (!ta || ta.parentElement?.classList.contains("growwrap")) return;
  const wrap = document.createElement("div");
  wrap.className = "growwrap";
  ta.before(wrap);
  wrap.appendChild(ta);
  growHandle(ta, key, (bar) => wrap.appendChild(bar));
}
