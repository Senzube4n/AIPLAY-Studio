/**
 * BATTERY SAFE, the page side. The decisions live in server/power.js and the
 * watchdog in server/index.js; this file only shows them and asks.
 *
 *   1. A bar at the top of the window while the computer runs on battery:
 *      the countdown before a running generation is stopped, and the buttons
 *      to keep generating on battery or to stop now.
 *   2. A question before a generation STARTS on battery: generate on battery,
 *      or don't. Asked by wrapping fetch, so every screen (songs, pictures,
 *      video, overnight, training) is covered without touching each button.
 *      A generation started some other way (an agent, MCP) is still caught
 *      by the server's countdown.
 *   3. The two settings: on/off, and how many minutes before it stops.
 */
import { appConfirm } from "./dialog.js";

const rawFetch = window.fetch.bind(window);
let power = null;
let dismissedStop = 0;

/* POSTs that start work on the graphics card. `null` = any body; a list =
 * only these `action`s (the same routes also carry settings changes). */
const STARTS = [
  [/^\/api\/generate$/, null],
  [/^\/api\/video$/, ["run", "create", "extend"]],
  [/^\/api\/image$/, ["create"]],
  [/^\/api\/images\/(create|ai-edit)$/, null],
  [/^\/api\/(stems|lyrics)$/, ["run"]],
  [/^\/api\/art$/, ["regenerate", "backfill"]],
  [/^\/api\/batch$/, ["start"]],
  [/^\/api\/train$/, ["start"]],
  [/^\/api\/reactive\/run$/, null],
];

function startsWork(input, init) {
  if (typeof input !== "string" && !(input instanceof URL)) return false;
  if (String(init?.method || "GET").toUpperCase() !== "POST") return false;
  let u;
  try { u = new URL(String(input), location.origin); } catch { return false; }
  if (u.origin !== location.origin) return false;
  const rule = STARTS.find(([re]) => re.test(u.pathname));
  if (!rule) return false;
  if (!rule[1]) return true;
  if (typeof init?.body !== "string") return false;
  try { return rule[1].includes(JSON.parse(init.body)?.action); } catch { return false; }
}

const needsAsking = (p) => p?.known && p.onBattery && p.batterySafe && !p.consent;

async function refresh() {
  try { power = await (await rawFetch("/api/power")).json(); } catch { /* server restarting */ }
  paint();
  paintSettings();
  return power;
}

async function send(patch) {
  try {
    power = await (await rawFetch("/api/power", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    })).json();
  } catch { /* server restarting */ }
  paint();
  return power;
}

window.fetch = async (input, init) => {
  if (!startsWork(input, init)) return rawFetch(input, init);
  const p = await refresh();
  if (!needsAsking(p)) return rawFetch(input, init);
  const pct = p.percent != null ? ` (${p.percent}% left)` : "";
  const yes = await appConfirm(
    `This computer is running on battery${pct}.\n\n`
    + "Generating uses the whole machine and drains the battery fast. If you generate on battery, "
    + "Battery Safe leaves it running until the power comes back. If you don't, nothing starts.",
    { title: "Running on battery", ok: "Generate on battery", cancel: "Don't generate", tone: "warn" },
  );
  if (!yes) {
    return new Response(JSON.stringify({
      error: "Not started: this computer is on battery. Plug it in, or choose Generate on battery.",
    }), { status: 409, headers: { "Content-Type": "application/json" } });
  }
  await send({ allow: true });
  return rawFetch(input, init);
};

/* ── the bar ─────────────────────────────────────────────────────────────── */

const CSS = `
#batBar { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 99000;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: center;
  max-width: min(760px, calc(100vw - 32px)); box-sizing: border-box; padding: 10px 14px;
  border-radius: 14px; border: 1px solid hsla(38,92%,55%,.45);
  background: hsl(30,30%,11%); color: var(--ink, hsl(0,0%,96%));
  box-shadow: 0 12px 40px hsla(0,0%,0%,.5); font-size: 13px; line-height: 1.45; }
#batBar[hidden] { display: none; }
#batBar.urgent { border-color: hsla(0,85%,60%,.6); background: hsl(0,30%,12%); }
#batBar .bi { flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center;
  font-weight: 700; background: hsla(38,92%,55%,.18); color: var(--warn, hsl(38,92%,55%)); }
#batBar .bt { flex: 1 1 260px; }
#batBar .bt b { font-variant-numeric: tabular-nums; }
#batBar .ba { display: flex; gap: 8px; }
#batBar button { font: inherit; font-size: 12.5px; font-weight: 600; height: 30px; padding: 0 14px;
  border-radius: 999px; border: 1px solid hsla(0,0%,100%,.15); cursor: pointer;
  background: hsla(0,0%,100%,.06); color: inherit; }
#batBar button.go { background: var(--warn, hsl(38,92%,55%)); color: hsl(30,40%,10%); border-color: transparent; }
`;

let bar = null;
let painted = "";   // what the bar was last built for; only the clock ticks in between
function ensureBar() {
  if (bar) return bar;
  const st = document.createElement("style");
  st.textContent = CSS;
  document.head.appendChild(st);
  bar = document.createElement("div");
  bar.id = "batBar";
  bar.setAttribute("role", "status");
  bar.hidden = true;
  document.body.appendChild(bar);
  return bar;
}

function button(label, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (cls) b.className = cls;
  b.onclick = onClick;
  return b;
}

function clock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function paint() {
  if (!document.body) return;
  const el = ensureBar();
  const p = power;
  const stop = p?.lastStop && p.lastStop.at > dismissedStop ? p.lastStop : null;
  const onBat = p?.known && p.onBattery && p.batterySafe;
  const pct = p?.percent != null ? ` (${p.percent}%)` : "";
  const mode = !onBat ? (stop ? "stopped" : "") : p.deadline ? "countdown" : p.consent ? "allowed" : "idle";
  /* Rebuilt only when what it says changes. Rebuilding every second would
   * swap a button out from under a click that is halfway through. */
  const key = `${mode}|${pct}|${stop?.at || ""}`;
  if (key === painted) {
    const b = el.querySelector(".bt b");
    if (b && p?.deadline) b.textContent = clock((p.deadline - Date.now()) / 1000);
    return;
  }
  painted = key;
  el.replaceChildren();
  el.classList.remove("urgent");
  if (!mode) { el.hidden = true; return; }
  el.hidden = false;
  const icon = document.createElement("span");
  icon.className = "bi";
  icon.textContent = "!";
  const text = document.createElement("span");
  text.className = "bt";
  const acts = document.createElement("span");
  acts.className = "ba";

  if (onBat && p.deadline) {
    el.classList.add("urgent");
    const left = (p.deadline - Date.now()) / 1000;
    text.append(`Running on battery${pct}. Generation stops in `);
    const b = document.createElement("b");
    b.textContent = clock(left);
    text.append(b, " to protect your files.");
    acts.append(
      button("Keep generating on battery", "", () => send({ allow: true })),
      button("Stop now", "go", () => send({ stopNow: true })),
    );
  } else if (onBat && p.consent) {
    text.textContent = `Running on battery${pct}. Generating on battery is allowed until the power comes back.`;
    acts.append(button("Don't generate on battery", "", () => send({ allow: false })));
  } else if (onBat) {
    text.textContent = stop
      ? `Running on battery${pct}. Battery Safe: ${stop.what} It will ask before anything new starts.`
      : `Running on battery${pct}. Battery Safe will ask before anything starts.`;
    acts.append(button("Generate on battery", "", () => send({ allow: true })));
  } else {
    text.textContent = `Battery Safe: ${stop.what} (${new Date(stop.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`;
    acts.append(button("OK", "", () => { dismissedStop = stop.at; paint(); }));
  }
  el.append(icon, text, acts);
}

/* ── settings ────────────────────────────────────────────────────────────── */

let settingsWired = false;
function paintSettings() {
  const safe = document.getElementById("qBatSafe");
  const grace = document.getElementById("qBatGrace");
  if (!safe || !grace || !power) return;
  if (!settingsWired) {
    settingsWired = true;
    safe.onchange = () => send({ batterySafe: safe.value === "1" });
    grace.onchange = () => send({ graceMinutes: Number(grace.value) });
  }
  if (document.activeElement !== safe) safe.value = power.batterySafe === false ? "0" : "1";
  if (document.activeElement !== grace) {
    const m = String(power.graceMinutes || 5);
    if (![...grace.options].some((o) => o.value === m)) grace.add(new Option(`${m} minutes on battery`, m));
    grace.value = m;
  }
  grace.disabled = power.batterySafe === false;
}

/* Every five seconds for the state, every second for the clock while one runs. */
refresh();
setInterval(refresh, 5000);
setInterval(() => { if (power?.deadline) paint(); }, 1000);
