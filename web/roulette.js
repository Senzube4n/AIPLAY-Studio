/* GENRE ROULETTE — six vertical reels that spin to a style line.
 *
 * Opened from the "G.R." button on the Styles box. Each reel is a drum that
 * rolls vertically: items curve away at the top and bottom (rotateX on a
 * cylinder, perspective on the window) and stay flat side to side. The reels
 * draw from web/style-tags.js — the 6,000-genre list plus the vocal, mood,
 * instrument, rhythm and production lists — and stop one after another.
 *
 * Spin, then Reroll (only unlocked reels; click a reel to lock it) or Populate,
 * which writes the result into the Styles box: the plain caption, or the three
 * Guided fields when Guided is on. Writing fires an `input` event so the page's
 * own character count and state follow as if it had been typed. */
import { GENRES, VOCALS, MOODS, INSTRUMENTS, RHYTHM, PRODUCTION } from "./style-tags.js";

export const REELS = Object.freeze([
  { key: "genre", label: "Genre", pool: GENRES },
  { key: "vocals", label: "Vocals", pool: VOCALS },
  { key: "instrument", label: "Instrument", pool: INSTRUMENTS },
  { key: "mood", label: "Mood", pool: MOODS },
  { key: "rhythm", label: "Rhythm", pool: RHYTHM },
  { key: "production", label: "Production", pool: PRODUCTION },
]);

const ITEM_H = 34;        // px per item on the drum's face
const STEP = 0.27;        // radians between neighbouring items: sets the curvature (gentle)
const RADIUS = ITEM_H / STEP;
const SHOWN = 5;          // items drawn above and below the centre

/** Pure: where an item sits on the drum, `d` items away from the centre line. */
export function drumTransform(d) {
  const a = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, d * STEP));
  return {
    y: RADIUS * Math.sin(a),
    z: RADIUS * (Math.cos(a) - 1),
    rot: -a,
    opacity: Math.max(0, Math.cos(a)) ** 1.5,
  };
}

/** Pure: a reel's path — `length` random items that end on `result`. */
export function reelPath(pool, result, length, rand = Math.random) {
  const out = [];
  for (let i = 0; i < length - 1; i++) out.push(pool[Math.floor(rand() * pool.length)]);
  out.push(result);
  return out;
}

/** Pure: ease out with a small settle past the line and back, like a detent. */
export function easeReel(t) {
  const c = 1.2;
  const u = t - 1;
  return 1 + (c + 1) * u ** 3 + c * u ** 2;
}

/** Pure: how the result goes into the Styles box. */
export function styleLine(result, guided = false) {
  const v = (k) => result[k] || "";
  if (!guided) return { caption: REELS.map((r) => v(r.key)).filter(Boolean).join(", ") };
  return {
    capMeta: [v("genre"), v("mood"), v("rhythm"), v("production")].filter(Boolean).join(", "),
    capVocal: v("vocals"),
    capArr: v("instrument"),
  };
}

const $ = (id) => document.getElementById(id);
const pick = (pool) => pool[Math.floor(Math.random() * pool.length)];
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// `filler` shows above the start and below the end of a path, so a reel never
// wraps round and shows its own upcoming result before it lands.
const reels = REELS.map((r) => ({ ...r, path: [pick(r.pool)], pos: 0, locked: false, el: null, items: [],
  filler: Array.from({ length: SHOWN * 2 + 2 }, () => pick(r.pool)) }));
let spinning = false, spun = false, spinToken = 0;

function paintReel(reel) {
  const base = Math.floor(reel.pos), frac = reel.pos - base;
  reel.items.forEach((node, k) => {
    const idx = base + k - SHOWN;
    const f = reel.filler.length;
    const text = idx >= 0 && idx < reel.path.length ? reel.path[idx] : reel.filler[((idx % f) + f) % f];
    if (node.textContent !== text) node.textContent = text;
    const t = drumTransform(k - SHOWN - frac);
    node.style.transform = `translateY(${t.y.toFixed(2)}px) translateZ(${t.z.toFixed(2)}px) rotateX(${t.rot.toFixed(4)}rad)`;
    node.style.opacity = t.opacity.toFixed(3);
  });
}

function build() {
  const host = $("grReels");
  host.innerHTML = "";
  for (const reel of reels) {
    const col = document.createElement("div");
    col.className = "grreel";
    col.innerHTML = `<div class="grlabel">${reel.label}<span class="grlock" aria-hidden="true">🔒</span></div>
      <button class="grwin" type="button" title="Click to lock this reel on a reroll" aria-pressed="false"
        aria-label="${reel.label} reel"><div class="grdrum"></div><i class="grvig"></i><i class="grline"></i></button>`;
    const drum = col.querySelector(".grdrum");
    reel.items = Array.from({ length: SHOWN * 2 + 1 }, () => {
      const n = document.createElement("div");
      n.className = "gritem";
      drum.appendChild(n);
      return n;
    });
    reel.el = col;
    col.querySelector(".grwin").onclick = () => {
      if (spinning || !spun) return;
      reel.locked = !reel.locked;
      col.classList.toggle("locked", reel.locked);
      col.querySelector(".grwin").setAttribute("aria-pressed", String(reel.locked));
    };
    host.appendChild(col);
    paintReel(reel);
  }
}

function result() {
  return Object.fromEntries(reels.map((r) => [r.key, r.path[r.path.length - 1]]));
}

function paintFoot() {
  $("grSpin").hidden = spun;
  $("grReroll").hidden = !spun;
  $("grPopulate").hidden = !spun;
  for (const id of ["grSpin", "grReroll", "grPopulate"]) $(id).disabled = spinning;
  $("grHint").textContent = spinning ? "Spinning…"
    : spun ? "Click a reel to lock it, then Reroll the rest — or Populate the Styles box."
    : "Six reels: genre, vocals, instrument, mood, rhythm and production.";
  $("grResult").textContent = spun && !spinning ? styleLine(result()).caption : "";
}

function spin() {
  if (spinning) return;
  const moving = reels.filter((r) => !r.locked);
  if (!moving.length) return;
  spinning = true;
  paintFoot();
  const t0 = performance.now();
  const plans = moving.map((reel, i) => {
    const from = reel.path[reel.path.length - 1];
    const turns = 38 + i * 9 + Math.floor(Math.random() * 6);
    reel.path = [from, ...reelPath(reel.pool, pick(reel.pool), turns)];
    reel.pos = 0;
    // One after another: each reel starts a beat after the last and runs a little longer.
    return reduced() ? { reel, end: reel.path.length - 1, start: 0, dur: 0 }
      : { reel, end: reel.path.length - 1, start: i * 220, dur: 2400 + i * 450 };
  });
  const token = ++spinToken;
  const land = () => {
    if (token !== spinToken || !spinning) return;
    for (const p of plans) { p.reel.pos = p.end; p.reel.el.classList.remove("moving"); paintReel(p.reel); }
    spinning = false; spun = true; paintFoot();
  };
  const frame = (now) => {
    if (token !== spinToken || !spinning) return;
    let running = false;
    for (const p of plans) {
      const t = p.dur ? Math.max(0, Math.min(1, (now - t0 - p.start) / p.dur)) : 1;
      p.reel.pos = p.end * easeReel(t);
      if (t < 1) running = true;
      else p.reel.pos = p.end;
      p.reel.el.classList.toggle("moving", t < 1);
      paintReel(p.reel);
    }
    if (running) requestAnimationFrame(frame);
    else land();
  };
  requestAnimationFrame(frame);
  /* A hidden or minimised window gets no animation frames at all, which would
   * leave the roulette "Spinning…" until it is looked at again. When the spin's
   * time is up, land every reel on its result regardless. */
  setTimeout(land, Math.max(...plans.map((p) => p.start + p.dur)) + 150);
}

function populate() {
  const guided = $("capGuide") && !$("capGuide").hidden;
  for (const [id, value] of Object.entries(styleLine(result(), guided))) {
    const box = $(id);
    if (!box) continue;
    box.value = value;
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }
  close();
  $(guided ? "capMeta" : "caption")?.focus();
}

function open() {
  if (!$("grReels").children.length) build();
  $("grDlg").hidden = false;
  paintFoot();
  $(spun ? "grReroll" : "grSpin").focus();
}
function close() {
  if (spinning) return;
  $("grDlg").hidden = true;
  $("grOpen")?.focus();
}

function init() {
  const openBtn = $("grOpen"), dlg = $("grDlg");
  if (!openBtn || !dlg) return;
  // The button lives inside the Styles <summary>: without this a click would also fold the box.
  openBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); open(); });
  $("grSpin").onclick = spin;
  $("grReroll").onclick = spin;
  $("grPopulate").onclick = populate;
  $("grClose").onclick = close;
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !dlg.hidden) close(); });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
