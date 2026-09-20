/* AIPLAY Studio — UI.
 *
 * Two things here are load-bearing rather than decorative:
 *
 *  1. Staged progress. At ~4.6 min for a 3-minute song a spinner reads as frozen,
 *     so the bar is driven by ComfyUI's own per-node events and shows which stage
 *     is running plus an ETA refined from observed pace.
 *  2. Re-roll. Changing only the sampler settings reuses the cached autoregressive
 *     stage, so a re-roll costs ~60% of a full render — faster than realtime. It is
 *     the best thing measurement found and the flow is built around it.
 */
const $ = (id) => document.getElementById(id);
const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

import { EXAMPLES } from "./examples.js";
import { dealStyleTags, GENRES } from "./style-tags.js";

import { initStudio, studioRefresh } from "./studio.js";
import { initGames } from "./games.js";
import { initVfx, vfxOpen } from "./vfx.js";

// Video Workflow (fork-only). See FORK_DELTA.md.
import { wfOpen, initWorkflow } from "./mv.js";
// The welcome window (fork-only): opens once on a fresh install, re-openable
// from About. Writes no copy of its own — it renders the catalogue served by
// server/welcome/, which is the same document studio_capabilities returns.
import { initWelcome } from "./welcome.js";
import { growHandle, growWrap } from "./grow.js";
// The score panel (YuE2's editable lead sheet). It reaches its own <details>
// through the DOM and talks to /api/score on its own; app.js only mounts it at
// boot and shows or hides it from the engine's `score` capability.
import { mountScorePanel, scorePanelSelection } from "./score-panel.js";
import { mountMusicPlan } from "./music-plan-ui.js";
// The Models screen's "For this machine" block and the per-row fit badges. It
// renders /api/models's `recommended` and `fit` and computes nothing itself —
// the same answer models_for_this_machine gives an agent, from server/fit.js.
import { paintFit, initFit } from "./modelfit.js";
import { paintLocal, initLocal } from "./modellocal.js";
// The ⓘ in every screen's header (fork-only). One control, mounted once per
// view by mountAllInfo() below, rendering /api/welcome's `screen_info` — the
// screen's own paragraph and honest limit from the catalogue, joined against
// what this machine actually has. It writes no copy of its own, exactly as
// welcome.js writes none, and it is the same object studio_screen_info returns.
import { mountInfo } from "./info.js";
import { appConfirm, appPrompt } from "./dialog.js";
// Declared up here, not beside the row renderer, because `const` is not hoisted:
// anything above its old position that called it threw ReferenceError at module
// load, which killed the whole file before the first poll could run. A helper
// with no dependencies belongs at the top.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Also hoisted for the same reason: the extend panel and the visualiser both
// attach listeners to it well above where the player section begins, and `const`
// in the temporal dead zone throws at module load and kills the whole file.
// Module-level DOM singletons belong at the top.
const audio = $("audio");

// Disk, in the units people actually think in. Base 1000 to match what Explorer
// reports for the same folder, so the two never appear to disagree.
const size = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);


const state = {
  seedLocked: true,
  loop: false,
  shuffle: false,
  lastVol: 1,
  mode: "custom",
  selected: null,
  lastSpec: null,   // what the last render used — lets us detect a re-roll
  engineReady: false,
};

/* ── seed ─────────────────────────────────────────────── */
function paintSeed() {
  $("seedLock").classList.toggle("on", state.seedLocked);
  $("seedRand").classList.toggle("on", !state.seedLocked);
  $("seedLock").textContent = state.seedLocked ? "locked" : "lock";
  // The caveat has to live in the UI. Lyrics are part of the prompt and are
  // prefilled before any frame is decoded, so editing them changes every frame —
  // a locked seed cannot hold the song across a lyric edit. Without saying so,
  // "I changed one word and got a different song" is a guaranteed support ticket.
  $("seedNote").innerHTML = state.seedLocked
    ? "Repeatability needs the same seed, model, precision, settings and inputs; an identical file isn’t guaranteed. <b>Editing lyrics can change the song.</b>"
    : "A fresh seed each time — a different song from the same words.";
}
$("seedLock").onclick = () => { state.seedLocked = true; paintSeed(); };
$("seedRand").onclick = () => {
  state.seedLocked = false;
  $("seed").value = Math.floor(Math.random() * 4294967296);
  paintSeed();
};

/* ── chips + tags ─────────────────────────────────────── */
/* The chip row is a random hand from web/style-tags.js: genres from the
 * 6,000-entry genre list, plus vocals, moods, instruments, tempo and
 * production. The same tags suit YuE2's one-line style and MiniMax's caption,
 * so one hand serves every engine. ⤮ deals a new hand; a click adds the tag. */
let chipsPainted = false;
/* Drag a one-line button row sideways with the mouse. A drag that moved is not
 * a click, so letting go over a button does not also press it. */
function dragScroll(el) {
  if (!el?.addEventListener) return;
  let down = null, moved = false;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    down = { x: e.clientX, left: el.scrollLeft }; moved = false;
  });
  el.addEventListener("pointermove", (e) => {
    if (!down) return;
    const dx = e.clientX - down.x;
    if (!moved && Math.abs(dx) < 5) return;
    if (!moved) { moved = true; el.setPointerCapture?.(e.pointerId); el.classList.add("dragging"); }
    el.scrollLeft = down.left - dx;
  });
  const up = () => { down = null; el.classList.remove("dragging"); };
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  el.addEventListener("click", (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
  /* Mouse wheel scrolls the row too. */
  el.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    el.scrollLeft += e.deltaY; e.preventDefault();
  }, { passive: false });
}
dragScroll($("chips"));
if ($("chipRandom")) {
  $("chipRandom").title = `Random styles — ${GENRES.length.toLocaleString()} genres, plus vocals, moods, instruments, tempo and production`;
  $("chipRandom").onclick = () => { paintChips(null, true); $("chips").scrollLeft = 0; };
}
function paintChips(_engine, reroll = false) {
  const el = $("chips");
  if (!el) return;
  /* Idempotent: musicEnginePaint runs on every poll and every websocket push
   * (a YuE2 job pushes about once a second), and rebuilding the buttons each
   * time would steal focus, drop a click and reshuffle under the cursor. Deal
   * once, and again only when ⤮ asks. */
  if (chipsPainted && !reroll) return;
  chipsPainted = true;
  el.innerHTML = "";
  for (const c of dealStyleTags()) {
    const b = document.createElement("button");
    b.className = "chip";
    b.type = "button";
    b.textContent = c;
    b.onclick = () => {
      const t = $("caption");
      t.value = t.value.trim() ? `${t.value.replace(/,\s*$/, "")}, ${c}` : c;
      t.focus();
      countChars();
    };
    el.appendChild(b);
  }
}
paintChips(false);
document.querySelectorAll(".tag").forEach((b) => {
  b.onclick = () => {
    const t = $("lyrics");
    const tag = b.dataset.tag;
    const at = t.selectionStart ?? t.value.length;
    const before = t.value.slice(0, at);
    const pad = before && !before.endsWith("\n") ? "\n" : "";
    t.value = before + pad + tag + "\n" + t.value.slice(at);
    t.focus();
    t.selectionStart = t.selectionEnd = (before + pad + tag + "\n").length;
  };
});

/* ── song vs instrumental ─────────────────────────────── */
/* An instrumental with no lyrics stops after ~30 s — the model has nothing to
 * pace itself against. Section tags with no words give it a structure to fill:
 * measured 32.5 s -> 157.2 s for the same caption and seed. So "Instrumental"
 * does not mean "send nothing", it means "send a scaffold". */
/* The tag vocabulary matters more than it looks.
 *
 * MiniMax documents exactly NINE section tags: Intro, Verse, Pre-Chorus, Chorus,
 * Post-Chorus, Bridge, Instrumental, Solo, Outro. Those are the ones the model
 * was trained to recognise, and the card is explicit that tags are "generative
 * control rather than strict symbolic guarantees" — so an invented tag like
 * [Drop] is not an error, it is just weaker guidance than [Chorus] is.
 *
 * The card also says musical instructions ATTACHED to a section tag are honoured.
 * So the strong form is an official tag carrying an annotation:
 *
 *     [Instrumental - drop, full kick and sub, no vocals]
 *
 * which keeps the reliable skeleton and puts the genre character in the words.
 * Every preset below is built that way — official tag, annotated. A pop verse
 * skeleton is a bad fit for a 6-minute orchestral piece, and one cycle of
 * Intro/Verse/Chorus was the whole vocabulary before this. */
/* The nine MiniMax documents, plus four the model clearly knows from training
 * data. Kept SHORT: a long unrecognised tag gets sung rather than obeyed. */
/* In the order they usually appear in a song, start to finish. */
const OFFICIAL_TAGS = ["Intro", "Verse", "Pre-Chorus", "Chorus", "Post-Chorus",
  "Bridge", "Breakdown", "Build", "Drop", "Solo", "Instrumental", "Break", "Outro"];

/* ⚠ PLAIN TAGS ONLY. An earlier version wrote annotated tags like
 * `[Intro - filtered pad, no drums]`, on the assumption the model reads the
 * instruction. It does not — in the LYRICS field it SANG the words "filtered
 * pad, no drums". normalize_lyrics() keeps anything in brackets verbatim, so an
 * unrecognised tag becomes a line to perform.
 *
 * Section character belongs in the CAPTION, which is prose the model reads as
 * description. The lyrics field takes bare tags and nothing else. */
const STRUCTURES = {
  electronic: { label: "Electronic / dance",
    cycle: ["Intro", "Build", "Drop", "Breakdown", "Build", "Drop", "Break", "Bridge"], end: "Outro" },
  orchestral: { label: "Orchestral / cinematic",
    cycle: ["Intro", "Instrumental", "Bridge", "Solo", "Instrumental", "Chorus", "Bridge", "Instrumental"], end: "Outro" },
  band: { label: "Rock / band",
    cycle: ["Intro", "Verse", "Pre-Chorus", "Chorus", "Verse", "Solo", "Bridge", "Chorus"], end: "Outro" },
  ambient: { label: "Ambient / drone",
    cycle: ["Intro", "Instrumental", "Instrumental", "Bridge", "Instrumental", "Break"], end: "Outro" },
  jazz: { label: "Jazz / small group",
    cycle: ["Intro", "Instrumental", "Solo", "Solo", "Solo", "Break", "Instrumental"], end: "Outro" },
  lofi: { label: "Lo-fi / beats",
    cycle: ["Intro", "Instrumental", "Break", "Instrumental", "Bridge", "Instrumental"], end: "Outro" },
};

function scaffold(n) {
  const s = STRUCTURES[$("structure").value] || STRUCTURES.electronic;
  const out = [];
  for (let i = 0; i < n - 1; i++) out.push(`[${s.cycle[i % s.cycle.length]}]`);
  out.push(`[${s.end}]`);
  return out.join("\n");
}

function paintScaffold() {
  const n = +$("sections").value;
  $("sectionsV").textContent = `${n} sections`;
  $("scaffold").textContent = scaffold(n);
  // ~19 s of music per section, from the 8-section / 157 s measurement.
  $("advHint").textContent = `About ${fmt(n * 19)} of music, roughly.`;
  countChars();
}
$("sections").oninput = paintScaffold;
$("structure").onchange = paintScaffold;

/* Character counts.
 *
 * The real limit is MiniMax's own: "The tokenized text prompt is limited to
 * 5,000 tokens", and style + lyrics share that budget because they are encoded
 * together. Tokens are what matters, characters are what people can see, so show
 * characters and estimate tokens at the usual ~4 chars each — deliberately
 * conservative, since lyrics with heavy punctuation and section tags tokenize
 * worse than prose.
 *
 * Nothing is blocked. The counter warns; the model truncates. Refusing to
 * generate on an estimate would be worse than letting it through. */
const TOKEN_BUDGET = 5000;

/* Guided mode joins three fields into the ONE caption the model actually takes.
 * Verified in comfy/ldm/minimax_music/prompt.py: build_prompt(caption, lyrics)
 * emits <|caption_start|>…<|caption_end|><|lyrics_start|>…<|lyrics_end|>, so
 * there is no third channel to send these on. The labels are what MiniMax
 * documents as the structure the model responds to best — a writing convention,
 * not a separate input. */
function captionValue() {
  if (!state.guided) return $("caption").value;
  return [
    $("capMeta").value.trim() && `Global Metadata. ${$("capMeta").value.trim()}`,
    $("capVocal").value.trim() && `Vocal Details. ${$("capVocal").value.trim()}`,
    $("capArr").value.trim() && `Arrangement. ${$("capArr").value.trim()}`,
  ].filter(Boolean).join(" ");
}

function setGuided(on) {
  state.guided = on;
  $("capGuide").hidden = !on;
  $("caption").hidden = on;
  $("capSimple").classList.toggle("on", !on);
  $("capGuided").classList.toggle("on", on);
  localStorage.setItem("aiplayGuided", on ? "1" : "0");
  countChars();
}
$("capSimple").onclick = () => setGuided(false);
$("capGuided").onclick = () => setGuided(true);
for (const id of ["capMeta", "capVocal", "capArr"]) {
  $(id).addEventListener("input", countChars);
}

function countChars() {
  const cap = captionValue();
  const lyr = state.mode === "instrumental" ? $("scaffold").textContent : $("lyrics").value;
  const est = Math.ceil((cap.length + lyr.length) / 4);
  const pct = est / TOKEN_BUDGET;

  $("captionCount").textContent = `${cap.length} characters`;
  $("lyricsCount").textContent = `${lyr.length} characters`;
  for (const el of [$("captionCount"), $("lyricsCount")]) {
    el.classList.toggle("over", pct > 1);
    el.classList.toggle("near", pct > 0.8 && pct <= 1);
  }
  if (pct > 0.8) {
    const which = pct > 1 ? "over" : "close to";
    $("lyricsCount").textContent +=
      ` · style and lyrics together are ${which} the model's ${TOKEN_BUDGET.toLocaleString()}-token limit (~${est.toLocaleString()})`;
  }
}
for (const id of ["caption", "lyrics"]) $(id).addEventListener("input", countChars);
$("scaffold").addEventListener("input", countChars);

/* Is the chosen music engine YuE2-shaped — i.e. does it take a chain-of-thought
 * mode? Read off the capability list /api/status serves, never off the name. */
function yueEngine() {
  return Array.isArray((state.musicEngines || {})[state.musicEngine]?.cot);
}
/* ACE-Step 1.5 — its own options panel, [Instrumental] for an instrumental. */
function aceEngine() {
  return !!(state.musicEngines || {})[state.musicEngine]?.ace;
}

/* WHERE INSTRUMENTAL LIVES. On MiniMax an instrumental is the Song form with a
 * section scaffold where the words go, so it is a switch in the Lyrics box's
 * corner rather than a tab of its own that showed the same page. YuE2's
 * instrumental is a different form (no lyrics card at all), so it keeps the tab. */
function instrInLyricsBox() {
  const eng = (state.musicEngines || {})[state.musicEngine];
  return !!eng?.instrumentalToggle && !yueEngine() && !eng?.ace;
}
function paintLyricsSwap() {
  const inBox = instrInLyricsBox(), sw = $("lyricsSwap");
  if (sw) {
    sw.hidden = !inBox;
    const on = state.mode === "instrumental";
    sw.textContent = on ? "✎ Lyrics" : "🎼 Instrumental";
    sw.title = on ? "Back to writing lyrics" : "Switch to an instrumental: a section structure instead of words";
    sw.setAttribute("aria-pressed", String(on));
  }
  if ($("modeInstr")) $("modeInstr").hidden = inBox || (state.musicEngines?.[state.musicEngine]?.instrumentalToggle === false);
  $("modeSong").setAttribute("aria-pressed", String(!state.simple && (state.mode === "song" || (state.mode === "instrumental" && inBox))));
}
function setMode(m) {
  if (m === "instrumental" && (state.musicEngines || {})[state.musicEngine]?.instrumentalToggle === false) m = "song";
  state.mode = m;
  $("modeSong").setAttribute("aria-pressed", String(!state.simple && m === "song"));
  $("modeInstr").setAttribute("aria-pressed", String(!state.simple && m === "instrumental"));
  $("lyricsField").hidden = m === "instrumental";
  /* The section scaffold is MiniMax's instrumental device: bare tags for the
   * model to pace itself against. YuE2 SINGS brackets, so its instrumental is
   * empty lyrics and a style that says so — the server writes that phrasing
   * (index.js /api/generate), and there is nothing here to scaffold. */
  $("instrField").hidden = m !== "instrumental" || yueEngine() || aceEngine();
  if (m === "instrumental" && !yueEngine() && !aceEngine()) paintScaffold();
  /* Nothing left in the Lyrics card (YuE2's instrumental has no scaffold), so
   * slide the whole card away; MiniMax keeps it for its Structure picker. */
  $("lyricsSlide")?.classList.toggle("closed", m === "instrumental" && $("instrField").hidden);
  if (typeof paintLyricsSwap === "function") paintLyricsSwap();
  countChars();
}
$("lyricsSwap")?.addEventListener("click", (e) => {
  // Inside <summary>: without this the click also folds the Lyrics box.
  e.preventDefault(); e.stopPropagation();
  setMode(state.mode === "instrumental" ? "song" : "instrumental");
  $("lyricsBox").open = true;
});

/* ── which model writes the song ───────────────────────────────────────────
 *
 * The list and every capability flag come from the server (config.music.engines
 * via /api/status), never from a copy here. The video selector's comment records
 * why: a screen holding its own engine facts went stale the day a build was
 * added, so this one holds none.
 *
 * A CONTROL IS HIDDEN RATHER THAN DISABLED ON YuE2, and the difference
 * matters. A disabled control says "not now" and invites the user to look for
 * the switch; an absent one asks no question at all.
 * (The section-tag buttons are shown: [Verse] / [Chorus] are YuE2's format.)
 *   the audio reference — the vendor states YuE2 "exposes no audio-reference,
 *     phoneme-alignment, or local-inpainting argument", so the field cannot be
 *     honoured. Offering it would be offering nothing.
 * and the estimate line has to stop making a claim it cannot keep: the preview
 * and re-roll multipliers are MiniMax AR-CACHE facts, and a subprocess engine
 * has no cache, so a re-roll there costs full price.
 */
// Setup reads are bounded and share the existing status-poll cadence. Install
// and cancel are explicit single actions, never retried by a status refresh.
let ggufSetupStatus = null, ggufSetupReading = false, ggufSetupAction = false, ggufSetupAt = 0, ggufSetupEpoch = 0;
let ggufFoldReady = null;   // the setup card folds when this flips to true, opens when it flips back
let ggufQuantization = "q4_0";
function ggufPrecision() { return ggufQuantization === "q8_0" ? "q8_0" : "q4_0"; }
function ggufPrecisionLabel(precision = ggufPrecision()) { return precision === "q8_0" ? "Q8_0" : "Q4_0"; }
function nativeMusicReady(engine) {
  const precision = ggufPrecision(), variant = engine?.variants?.[precision];
  // Old servers only knew Q4. Their aggregate ready flag must never unlock Q8.
  return engine?.variants ? variant?.ready === true : precision === "q4_0" && engine?.ready === true;
}
function ggufSetupSelection(status = ggufSetupStatus) {
  if (!status) return null;
  const precision = ggufPrecision();
  if (status.selected?.quantization === precision) return status.selected;
  if (status.variants?.[precision]) return status.variants[precision];
  return (status.quantization || "q4_0") === precision ? status : null;
}
function canInstallGguf() {
  const selected = ggufSetupSelection();
  // `blocked`: the server refuses this card (not NVIDIA) — the button must not pretend otherwise.
  return !ggufSetupAction && !!selected && !ggufSetupStatus?.uncertain && !ggufSetupStatus?.blocked
    && !["downloading", "verifying"].includes(ggufSetupStatus?.state)
    && !selected.ready
    && Number.isSafeInteger(selected.downloadBytes) && selected.downloadBytes >= 0
    && $("ggufSetupAccept")?.checked === true;
}
function applyGgufSetupStatus(response) {
  ggufSetupStatus = response;
  const engine = state.musicEngines?.["yue2-gguf"];
  if (!engine) return;
  if (response.variants) engine.variants = response.variants;
  else if ((response.quantization || "q4_0") === "q4_0") {
    engine.variants = { ...engine.variants, q4_0: { ready: response.ready === true } };
  }
  engine.ready = Object.values(engine.variants || {}).some((v) => v?.ready === true);
  engine.readinessNote = response.message || "";
  /* The page opens on Q4_0. With only Q8_0 installed that painted "Q4_0 is not
   * installed" under a Create that works — so until a precision is picked by
   * hand, follow the one that is actually installed. */
  const installed = response.variants && Object.keys(response.variants).find((q) => response.variants[q]?.ready);
  if (!ggufPrecisionPicked && installed && !response.variants[ggufPrecision()]?.ready) selectGgufPrecision(installed, false);
}
let ggufPrecisionPicked = false;
function selectGgufPrecision(value, byHand = true) {
  if (byHand) ggufPrecisionPicked = true;
  const precision = value === "q8_0" ? "q8_0" : "q4_0";
  if (precision !== ggufPrecision()) {
    ggufQuantization = precision;
    ggufSetupEpoch++;
    ggufSetupStatus = null;
    ggufSetupAt = 0;
    if ($("ggufSetupAccept")) $("ggufSetupAccept").checked = false;
  }
  for (const id of ["yGgufPrecision", "ggufSetupPrecision"]) if ($(id)) $(id).value = precision;
  musicEnginePaint();
}
async function ggufSetupRequest(body, precision = ggufPrecision()) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(body ? "/api/music-gguf/setup" : `/api/music-gguf/setup?precision=${encodeURIComponent(precision)}`, {
      method: body ? "POST" : "GET", signal: controller.signal,
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.error || result.message || "Native setup request failed.");
    return result;
  } finally { clearTimeout(timer); }
}
function paintGgufSetup() {
  const panel = $("ggufSetup");
  if (!panel) return;
  panel.hidden = state.musicEngine !== "yue2-gguf";
  $("musicInfoBtn")?.classList.remove("needs");
  if (panel.hidden) return;
  const s = ggufSetupStatus, busy = s && ["downloading", "verifying"].includes(s.state);
  const selected = ggufSetupSelection(s);
  /* Folded once installed, open while there is something to do — set only
   * when the answer changes, so a person's own click on the summary holds. */
  const ready = !!selected?.ready && !busy;
  /* The card lives in the ⓘ panel beside the model, so the ⓘ says when there
   * is setup to do (or a download running) rather than the card taking up the page. */
  const info = $("musicInfoBtn");
  if (info && s) {
    info.classList.toggle("needs", !ready);
    info.title = ready ? "About this model" : busy ? "About this model · installing…" : "About this model · native setup needed";
  }
  if (ggufFoldReady !== ready) {
    ggufFoldReady = ready;
    if ("open" in panel) panel.open = !ready;
  }
  const sum = $("ggufSetupSum");
  if (sum) sum.textContent = ready ? `${ggufPrecisionLabel()} installed · terms accepted · individuals may use it commercially (the authors' statement)` : busy ? "installing…" : "not installed";
  for (const id of ["yGgufPrecision", "ggufSetupPrecision"]) if ($(id)) {
    $(id).value = ggufPrecision();
    $(id).disabled = ggufSetupAction;
  }
  /* The runtime follows the card (CUDA on NVIDIA, Vulkan elsewhere, CPU with
   * no card), so its name, its driver needs and whether NVIDIA's terms apply
   * come from the server rather than being written into the page. */
  if (s?.runtimeKind) {
    const rt = $("ggufSetupRuntime"), req = $("ggufSetupReq"), cudaTerms = $("ggufCudaTerms");
    if (rt) rt.textContent = s.backend && ready ? `runs on ${s.backend === "cpu" ? "the CPU" : s.backend}` : `${s.runtimeLabel} runtime`;
    if (cudaTerms) cudaTerms.hidden = s.runtimeKind !== "cuda";
    if (req && s.runtimeKind !== "cuda") req.textContent = s.requirements?.driver || "";
  }
  const bytes = $("ggufSetupBytes");
  if (bytes) bytes.textContent = selected && Number.isSafeInteger(selected.downloadBytes) && selected.downloadBytes >= 0
    ? `${ggufPrecisionLabel()} · full download bundle: ${selected.downloadBytes.toLocaleString()} bytes (${(selected.downloadBytes / 1e9).toFixed(2)} GB). ${selected.ready ? "Installed and ready; nothing is downloaded." : selected.installed ? "Files found; check the runtime status below before repairing." : "Review before installing; verified existing files are reused."}`
    : `${ggufPrecisionLabel()} · download size not confirmed yet. Check again before installing.`;
  $("ggufSetupMessage").textContent = s?.error || s?.message || "Checking local setup…";
  if (busy && s.activeQuantization) $("ggufSetupMessage").textContent += ` · Active download: ${ggufPrecisionLabel(s.activeQuantization)}`;
  const progress = $("ggufSetupProgress"), p = s?.progress;
  progress.hidden = !busy;
  if (p?.total > 0) progress.value = Math.max(0, Math.min(100, 100 * p.received / p.total));
  else progress.removeAttribute("value");
  $("ggufSetupInstall").disabled = !canInstallGguf();
  $("ggufSetupInstall").textContent = selected?.installed && !selected.ready
    ? `Verify / repair ${ggufPrecisionLabel()} setup` : `Install ${ggufPrecisionLabel()} runtime and weights`;
  $("ggufSetupCancel").hidden = !busy;
  $("ggufSetupCancel").disabled = ggufSetupAction;
  $("ggufSetupRefresh").disabled = ggufSetupReading || ggufSetupAction;
}
async function refreshGgufSetup() {
  if (ggufSetupReading || ggufSetupAction) return;
  const epoch = ggufSetupEpoch, precision = ggufPrecision();
  ggufSetupReading = true; ggufSetupAt = Date.now();
  try {
    const response = await ggufSetupRequest(undefined, precision);
    if (epoch !== ggufSetupEpoch) return;
    applyGgufSetupStatus(response);
  } catch (error) {
    if (epoch === ggufSetupEpoch) ggufSetupStatus = { quantization: precision, ready: false, state: "failed", uncertain: true, error: error.name === "AbortError" ? "Setup status timed out. Check again." : error.message };
  } finally { ggufSetupReading = false; ggufSetupAt = epoch === ggufSetupEpoch ? Date.now() : 0; musicEnginePaint(); }
}
async function actGgufSetup(action) {
  if (ggufSetupAction || (action === "install" && !canInstallGguf())) return;
  const epoch = ++ggufSetupEpoch, precision = ggufPrecision();
  ggufSetupAction = true; paintGgufSetup();
  try {
    const response = await ggufSetupRequest({ action, ...(action === "install" ? { quantization: precision, acceptLicense: true } : {}) }, precision);
    if (epoch === ggufSetupEpoch) applyGgufSetupStatus(response);
    if (action === "install") $("ggufSetupAccept").checked = false;
  } catch (error) {
    if (epoch === ggufSetupEpoch) ggufSetupStatus = { quantization: precision, state: "failed", ready: false, uncertain: true, error: error.name === "AbortError"
      ? "Setup request timed out; its state is unknown. Check again before retrying." : error.message };
  } finally { ggufSetupAction = false; ggufSetupAt = epoch === ggufSetupEpoch ? Date.now() : 0; musicEnginePaint(); }
}
$("ggufSetupAccept")?.addEventListener("change", paintGgufSetup);
$("ggufSetupInstall")?.addEventListener("click", () => actGgufSetup("install"));
$("ggufSetupCancel")?.addEventListener("click", () => actGgufSetup("cancel"));
$("ggufSetupRefresh")?.addEventListener("click", refreshGgufSetup);
for (const id of ["yGgufPrecision", "ggufSetupPrecision"]) $(id)?.addEventListener("change", (e) => selectGgufPrecision(e.target.value));

/* ── the music model picker ──────────────────────────────────────────────
 * One choice of engine AND build, painted into two selects — the Music tab's
 * Model row and the top of the Models screen — from `musicModels`, which the
 * server computes (what is on disk, what can render). Both stay in step with
 * the Precision select in Advanced. */
function musicModelValue() {
  const e = state.musicEngine;
  if (e === "minimax-music3" && state.apiMode?.enabled) return `${e}:api:${state.apiMode.provider || "fal"}`;
  if (e === "minimax-music3") return `${e}:${$("qModel")?.value || state.musicPrecision || "int8"}`;
  if (e === "yue2-gguf") return `${e}:${ggufPrecision()}`;
  if (e === "yue2-comfy") return state.musicYue2Checkpoint ? `${e}:${state.musicYue2Checkpoint}` : e;
  if (e === "ace-step15") return state.musicAceModel ? `${e}:${state.musicAceModel}` : e;
  return e || "";
}
function paintMusicModelSelect(sel) {
  const choices = state.musicModels || [];
  if (!sel || !choices.length) return false;
  const sig = JSON.stringify(choices.map((c) => [c.value, c.available, c.note]));
  if (sel.dataset.sig !== sig && document.activeElement !== sel) {
    sel.innerHTML = choices.map((c) => {
      // Native GGUF stays choosable when absent: choosing it opens its setup.
      const off = !c.available && c.engine !== "yue2-gguf";
      const tail = c.available ? (c.note ? ` — ${c.note}` : "") : ` — ${c.note || "not installed"}`;
      return `<option value="${esc(c.value)}"${off ? " disabled" : ""}>${esc(c.label + tail)}</option>`;
    }).join("");
    sel.dataset.sig = sig;
  }
  const v = musicModelValue();
  if (document.activeElement !== sel && [...sel.options].some((o) => o.value === v)) sel.value = v;
  return true;
}
function paintModelMusicPanel() {
  const list = $("modelList");
  if (!list || !state.musicModels?.length) return;
  let box = $("modelMusic");
  if (!box) {
    box = document.createElement("div");
    box.id = "modelMusic";
    box.className = "mmusic";
    box.innerHTML = `<label class="flabel" for="modelMusicPick">Music model</label>
      <select id="modelMusicPick" class="sel2"></select>
      <span class="hint" id="modelMusicNote"></span>`;
    list.parentNode.insertBefore(box, $("modelFolder") || $("modelFit") || list);
    $("modelMusicPick").onchange = () => chooseMusicModel($("modelMusicPick").value);
  }
  paintMusicModelSelect($("modelMusicPick"));
  const ready = state.musicModels.filter((c) => c.available).length;
  $("modelMusicNote").textContent = ready
    ? `${ready} of ${state.musicModels.length} ready on this machine · the same choice as the Music tab`
    : "No music model is ready yet — install one below.";
}
async function chooseMusicModel(value) {
  const c = (state.musicModels || []).find((x) => x.value === value);
  if (!c) return;
  const was = { engine: state.musicEngine, precision: $("qModel")?.value };
  const repaint = () => {
    setMode(state.mode === "instrumental" ? "instrumental" : "song");
    musicEnginePaint();
  };
  const wasCkpt = state.musicYue2Checkpoint;
  state.musicEngine = c.engine;
  if (c.engine === "yue2-comfy") state.musicYue2Checkpoint = c.checkpoint;
  if (c.engine === "ace-step15" && c.dit) state.musicAceModel = c.dit;
  if (c.engine === "minimax-music3" && c.precision && $("qModel")) $("qModel").value = c.precision;
  // Hosted or local Music 3: the page's copy of API mode follows at once.
  if (c.engine === "minimax-music3" && state.apiMode) {
    state.apiMode.enabled = !!c.api;
    if (c.api) state.apiMode.provider = c.api;
  }
  if (c.engine === "yue2-gguf") selectGgufPrecision(c.precision);
  repaint();
  try {
    const r = await (await fetch("/api/music", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "model", value }),
    })).json();
    if (r.error) {
      alert(r.error);
      state.musicEngine = was.engine;
      state.musicYue2Checkpoint = wasCkpt;
      if ($("qModel") && was.precision) $("qModel").value = was.precision;
      repaint();
    } else if (c.engine === "minimax-music3") {
      if (c.precision) state.musicPrecision = c.precision;
    }
    if (c.engine === "minimax-music3" && typeof loadApiMode === "function") loadApiMode();
  } catch { /* offline: the choice still applies to this page */ }
}

/* The top-bar pill shows a short name ("YuE2", "MiniMax"); the invisible
 * <select> over it still lists the full labels, and ⓘ opens the notes. */
function paintMusicPill() {
  const sel = $("musicEngine"), pill = $("musicPillName");
  if (!sel || !pill) return;
  const e = state.musicEngine || sel.value || "";
  const text = sel.selectedOptions?.[0]?.textContent || e;
  pill.textContent = /yue/i.test(e) ? "YuE2" : /minimax/i.test(e) ? (state.apiMode?.enabled ? "MiniMax · API" : "MiniMax")
    : (text.split(/\s[—·(]/)[0] || "Model");
  if (sel.dataset && !sel.dataset.pill && $("musicInfoBtn")) {
    sel.dataset.pill = "1";
    sel.addEventListener("change", () => setTimeout(paintMusicPill));
    $("musicInfoBtn").onclick = () => {
      const box = $("musicInfo");
      box.hidden = !box.hidden;
      $("musicInfoBtn").setAttribute("aria-expanded", String(!box.hidden));
    };
  }
}

function musicEnginePaint() {
  const engines = state.musicEngines || {};
  const keys = Object.keys(engines).filter(k => !state.musicOnly || k === "yue2-gguf" || (k === "yue2-comfy" && state.engineExpected));
  if (!keys.length) return;                       // status not in yet; leave it hidden
  const cur = state.musicEngine || keys[0];
  const eng = engines[cur] || {};
  // The picker needs API mode to show hosted Music 3 as the current choice.
  if (state.apiMode === undefined && !state.apiModeAsked && typeof loadApiMode === "function") { state.apiModeAsked = true; loadApiMode(); }
  paintGgufSetup();
  if (cur === "yue2-gguf" && !ggufSetupReading && !ggufSetupAction && Date.now() - ggufSetupAt > 2000) refreshGgufSetup();

  /* The combined picker (engine + build) once the server has sent its list;
   * the plain engine list below only until then. */
  if (paintMusicModelSelect($("musicEngine")) && !$("musicEngine").dataset.models) {
    $("musicEngine").dataset.models = "1";
    state.musicEnginesPainted = true;
    $("musicEngine").onchange = () => chooseMusicModel($("musicEngine").value);
  }
  // Painted once, then left alone so it cannot fight the user's own change.
  if (!state.musicEnginesPainted) {
    state.musicEnginesPainted = true;
    $("musicEngine").innerHTML = keys
      .map((k) => '<option value="' + esc(k) + '">' + esc(engines[k].label || k) + "</option>").join("");
    $("musicEngine").onchange = async () => {
      const want = $("musicEngine").value;
      const was = state.musicEngine;
      state.musicEngine = want;
      musicEnginePaint();
      /* setMode, not countChars: it re-evaluates the mode-dependent blocks
       * (MiniMax's instrumental scaffold must leave under YuE2 and come back
       * under MiniMax) and ends with countChars() itself. */
      setMode(state.mode === "instrumental" ? "instrumental" : "song");
      /* ⚠ AND IT HAS TO GO BACK TO THE SERVER, or the choice lives until the
       * next reload and then quietly reverts. `config.music.engine` is already
       * in PREF_PATHS and /api/status already serves it, so both ends looked
       * finished while nothing connected them — the failure was invisible
       * except by reloading. The server also refuses an engine whose weights
       * are missing, which is the answer arriving at the click rather than
       * inside a subprocess eight minutes later. */
      try {
        const r = await (await fetch("/api/music", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "engine", value: want }),
        })).json();
        if (r.error) {
          /* Put the select back where it was, and say why — the same shape
           * setVideoEngine() uses below. A chooser that keeps a value the
           * server rejected is a chooser that lies about what will render. */
          alert(r.error);
          state.musicEngine = was;
          musicEnginePaint();
          setMode(state.mode === "instrumental" ? "instrumental" : "song");
        }
      } catch { /* offline: the choice still applies to this page */ }
    };
  }
  // This row also owns native installation; one engine must not hide setup.
  $("musicEngineRow").hidden = !state.musicModels?.length && keys.length < 2 && eng.runtime !== "audiocpp";
  if (!state.musicModels?.length) $("musicEngine").value = cur;
  paintMusicPill();
  paintModelMusicPanel();
  /* The length ceiling is the engine's: 5:00 by default, 6:00 where the
   * engine says so (YuE2 through ComfyUI). */
  const durMax = eng.maxDuration || 300;
  const durEl = $("maxDur");
  if (durEl && +durEl.max !== durMax) {
    durEl.max = String(durMax);
    if (+durEl.value > durMax) durEl.value = String(durMax);
    durEl.oninput?.();
  }

  /* The note says what THIS engine does differently, in the user's terms, and
   * every number in it is measured rather than modelled. */
  const bits = [];
  if (eng.amdWarning) bits.push(eng.amdWarning);
  if (eng.note) bits.push(eng.note);
  if (eng.score) bits.push("writes an editable score before the audio, so you can change the tune and re-render");
  if (eng.emergentLength) bits.push("length follows lyrics and score — no guaranteed audio duration");
  if (!eng.audioReference) bits.push("no audio reference");
  if (!eng.warmCache) bits.push("re-rolls cost the same as the first take");
  if (eng.realtimeRatio) bits.push(`about ${eng.realtimeRatio}× the song's length to render, measured on this card`);
  $("musicEngineNote").textContent = bits.join(" · ");

  /* ⚠ SAY IT HERE TOO, not only in the 400 the server would return. An engine
   * that can be chosen and cannot render is the worst kind of control, and
   * finding that out by pressing Create and reading an error is not the same as
   * being told before you write a lyric for it. The server refuses regardless —
   * this is the sentence, not the enforcement. */
  const noPath = eng.renderPath === false;
  const nativeReady = eng.runtime === "audiocpp" && nativeMusicReady(eng);
  const warn = $("musicEngineWarn");
  if (warn) {
    warn.hidden = !noPath && !(eng.runtime === "audiocpp" && !nativeReady);
    warn.textContent = eng.runtime === "audiocpp" && !nativeReady
      ? `${ggufPrecisionLabel()} is not ready. Review its optional runtime and weights below; selecting it does not download anything.`
      : noPath
      ? `${eng.label} cannot render from the Create button yet — it works through its own `
        + `driver, but the job runner here drives MiniMax Music 3 only. Choosing it and `
        + `pressing Create is refused rather than silently rendering the other engine, `
        + `because the two do not share a licence.`
      : "";
  }
  const create = $("btnCreate");   // NOT "go" — read out of index.html:440
  if (create) {
    /* ⚠ OR, NEVER =. This painter runs on every status poll, AFTER applyStatus
     * has already set the button from engine readiness. A plain assignment
     * here re-enabled Create for a MiniMax user whose engine was still
     * STARTING… — caught in review before it shipped. The painter may add a
     * reason to disable; it may not remove one it does not own. */
    create.disabled = noPath || (eng.runtime === "audiocpp" ? !nativeReady : !state.engineReady);
    create.title = noPath ? `${eng.label} has no render path from this button yet.` : "";
  }

  /* Controls only one engine can honour. These ids were READ OUT OF THE LIVE
   * DOM, not guessed: my first attempt invented "tagRow" and "audioRefBlock",
   * both of which resolve to undefined, so the two controls that matter MOST
   * stayed visible while the note beside them said otherwise. A hide that
   * silently matches nothing is worse than no hide at all — it reports success.
   *
   * #lyricTags is the [Verse]/[Chorus] button strip inside #lyricsField. On
   *   YuE2 it must be GONE rather than disabled: the model sings whatever those
   *   buttons insert. Three MiniMax tracks were rejected for exactly that and
   *   one ran 202 s instead of 64 s carrying them.
   * #arefField is the audio-reference <details>. The vendor states YuE2
   *   "exposes no audio-reference, phoneme-alignment, or local-inpainting
   *   argument", so the field cannot be honoured at all.
   * #musicInputField is "Continue from audio", and it was still showing under
   *   YuE2 after the first pass — caught in a full-page screenshot, not by any
   *   test. Its own text names its dependency: it continues a passage "using
   *   the experimental Music3 encoder". That encoder is a MiniMax component, so
   *   on any other engine the control is offering something that does not
   *   exist. Same class as #arefField and hidden for the same reason, which is
   *   why it keys off the same capability rather than getting a flag of its
   *   own — an engine with no audio reference has nothing to continue FROM. */
  const tagRow = $("lyricTags");
  if (tagRow) tagRow.hidden = !eng.sectionTags;
  const aref = $("arefField");
  if (aref) aref.hidden = !eng.audioReference;
  const musicInput = $("musicInputField");
  if (musicInput) musicInput.hidden = !eng.audioReference;
  /* The bar stays for Simple and Song; only Instrumental needs the engine's
   * toggle. It used to hide the whole bar. */
  if (!eng.instrumentalToggle && state.mode === "instrumental") setMode("song");
  if (typeof paintLyricsSwap === "function") paintLyricsSwap();

  /* Parameters are per engine. MiniMax's steps / guidance / precision map to
   * its sampler; YuE2's chain-of-thought mode, guidance and precision map to
   * protocol.py's SongRequest and the driver's --quantization. Rows are tagged
   * in index.html with data-engine, so a row this engine cannot honour is
   * ABSENT rather than ignored — the same rule as the tag strip above. Keyed
   * on the capability (`cot` is a list of modes) rather than the engine name,
   * as everything else on this page decides. */
  const yueParams = Array.isArray(eng.cot);
  const aceParams = !!eng.ace;
  for (const el of document.querySelectorAll('[data-engine="minimax"]')) el.hidden = yueParams || aceParams;
  for (const el of document.querySelectorAll('[data-engine="ace"]')) el.hidden = !aceParams;
  if (aceParams) acePaintOptions();
  for (const el of document.querySelectorAll('[data-engine="yue2"]')) el.hidden = !yueParams;
  const gguf = eng.runtime === "audiocpp";
  /* Python-kit-only rows stay hidden for the ComfyUI YuE2 engine too. */
  for (const el of document.querySelectorAll('[data-python-yue]')) el.hidden = !yueParams || gguf || eng.runtime === "comfy";
  /* ComfyUI-only rows (the LoRA picker): the Python kit and the native GGUF
   * have no loader. Painted on first show and whenever the checkpoint changes. */
  const comfyYue = yueParams && eng.runtime === "comfy";
  for (const el of document.querySelectorAll('[data-comfy-yue]')) el.hidden = !comfyYue;
  if (comfyYue) musicLoadLoras();
  for (const el of document.querySelectorAll('[data-native-gguf]')) el.hidden = !gguf;
  for (const el of document.querySelectorAll('[data-no-gguf]')) el.hidden = gguf;
  const fewerSteps = document.querySelector('#ySteps option[value="16"]');
  if (fewerSteps) fewerSteps.textContent = gguf ? "16 (experimental on GGUF)" : "16 (2× faster)";
  const preview = $("btnPreview");
  if (preview) preview.hidden = yueParams || aceParams;   // no cheap pass on YuE2 or ACE-Step
  const durLabel = document.querySelector('label[for="maxDur"]');
  if (durLabel) durLabel.textContent = yueParams || aceParams ? "Length" : "Length ceiling";
  const cap = $("caption");
  if (cap) {
    cap.placeholder = yueParams || aceParams
      ? "Style: genre, mood, tempo, instruments, who sings — e.g. warm indie folk, 96 BPM, female lead vocal, fingerpicked guitar"
      : "Indie folk, brushed drums, close-mic vocal, 92 BPM";
  }
  /* The page is the engine's. Examples come from what THIS engine rendered:
   * for YuE2 the Library's own YuE2 rows — real style + lyrics pairs that
   * rendered on this machine — rather than MiniMax's static list, whose
   * lyrics carry the section tags YuE2 sings. Placeholders, chips and the
   * credit line follow the same rule. */
  paintExamples(yueParams);
  paintChips(yueParams);
  const lyr = $("lyrics");
  if (lyr) {
    lyr.placeholder = yueParams || aceParams
      ? "[Verse]\nYour words…\n\n[Chorus]\n…"
      : "[Verse]\nSodium light on the ring road again…";
  }
  /* The model name itself, not appended after a hard-coded "MiniMax-Music3":
   * with YuE2 selected the sidebar read "Powered by MiniMax-Music3 · YuE2 3B". */
  const powered = $("poweredEngine");
  if ($("poweredName")) $("poweredName").textContent = aceParams ? "ACE-Step 1.5" : yueParams ? "YuE2 3B" : "MiniMax-Music3";
  if (powered) powered.textContent = aceParams ? " (MIT)" : yueParams ? " (CC BY-NC 4.0)" : "";
  /* Guided mode writes MiniMax's three-part caption grammar ("Global
   * Metadata. … Vocal Details. …"); YuE2 takes one line of tags. The toggle
   * is hidden under YuE2 by its data-engine tag, and an open Guided box is
   * closed here so captionValue() reads the plain textarea. */
  if (yueParams && $("capGuided")?.classList.contains("on")) setGuided(false);
  /* THERE IS NO #scoreOpen, AND THIS LINE USED TO PRETEND OTHERWISE. It read
   * `$("scoreOpen").hidden = !eng.score` behind an `if`, so it matched nothing
   * and reported success — the fourth time tonight, and this one was mine
   * twice over: the id was invented AND the panel it referred to was never
   * built. The score itself is reachable now (/api/score, mounted the same day
   * this comment was written), the Sheet PDF toggle below is the part of it
   * that has a control, and the panel itself is hidden just under this. */
  const sheetPdf = $("sheetPdfRow");
  if (sheetPdf) sheetPdf.hidden = !eng.score;
  /* The score panel, by capability rather than by engine name — and the id is
   * read out of index.html, unlike the `scoreOpen` that never existed. */
  const scorePanel = $("scorePanel");
  if (scorePanel) {
    scorePanel.hidden = !eng.score;
    /* Closing it on an engine that has no score stops a panel about a feature
     * this engine does not have from staying open across a switch. */
    if (!eng.score) scorePanel.open = false;
  }

  /* The configuration ladder. Engines without one keep the box hidden rather
   * than showing "no limitations", which would itself be a claim. */
  const ladder = !!eng.durationLadder;
  const fitBox = $("musicFitInfo");
  if (fitBox && !ladder) fitBox.hidden = true;
  /* The slider's top end is per-engine, because the ceilings are. MiniMax's
   * 300 is its own parameter's range. YuE2's length is an outcome, and the
   * number a user most needs warning about — the sampler's own 360 s stop —
   * sits ABOVE 300, so a 300-max slider can never reach the warning that
   * matters most. 600 puts it mid-track instead of past the end. */
  const dur = $("maxDur");
  if (dur) {
    const top = ladder ? 600 : 300;
    if (+dur.max !== top) {
      dur.max = String(top);
      /* Clamping DOWN matters and clamping up does not: leaving 480 selected
       * after a switch to MiniMax would submit a duration that engine's own
       * control cannot represent. */
      if (+dur.value > top) { dur.value = String(top); dur.dispatchEvent(new Event("input")); }
    }
  }
  if (ladder) musicFitPaint();
}

/* Ask the server which configuration reaches the wanted length, and say so.
 *
 * ⚠ THE PAGE DOES NOT DECIDE. It could — the rung table is small and the
 * rules are simple. But then the sentence under the slider and the
 * configuration the render actually uses would be two independent
 * implementations of one decision, and the comment at app.js:343 already
 * records what that costs: an engine warning that disagreed with the
 * server's own 400 for the same engine. One decider, asked over HTTP.
 *
 * Debounced because this hangs off a range input's oninput, which fires once
 * per pixel of drag. 200 ms is under the threshold where a settled slider
 * reads as waiting. */
let fitTimer = null, fitSeq = 0;
function musicFitPaint() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(async () => {
    const box = $("musicFitInfo");
    if (!box) return;
    const mine = ++fitSeq;
    let j = null;
    try {
      const r = await fetch("/api/music", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "fit", seconds: +$("maxDur").value }),
      });
      j = await r.json();
    } catch {
      /* A failed ask must not leave a STALE box up. A warning about a length
       * the user has since moved past is worse than no warning. */
      box.hidden = true;
      return;
    }
    /* Drop an answer the slider has already moved past — range inputs fire
     * fast enough that replies land out of order. */
    if (mine !== fitSeq) return;
    if (!j || !j.ok || !j.info) { box.hidden = true; return; }
    $("musicFitIcon").textContent =
      j.info.level === "stop" ? "⛔" : j.info.level === "warn" ? "⚠" : "ℹ";
    $("musicFitTitle").textContent = j.info.title;
    /* Reusing info.css's own severity class rather than adding one. Toggled
     * both ways: a box that keeps a warn border after dropping to a note would
     * overstate the next answer. */
    box.classList.toggle("infonote", j.info.level === "warn" || j.info.level === "stop");
    $("musicFitLines").innerHTML = j.info.lines.map((l) => "<li>" + esc(l) + "</li>").join("");
    box.hidden = false;
  }, 200);
}

/* ── examples ─────────────────────────────────────────── */
/* Per engine. MiniMax's list is static (examples.js) and teaches its caption
 * grammar; YuE2's is the Library's own YuE2 rows — every one a style + lyrics
 * pair that actually rendered on this card, which is a better teacher than
 * anything typed here. Repainted when the engine changes and when the Library
 * arrives, since the rows are not there at first paint. */
let examplesPainted = null;
function paintExamples(yue) {
  const pick = $("exPick");
  if (!pick) return;
  /* The same presets for every music model: a style line and lyrics with
   * section tags, which every engine here reads. (A Library song is reused by
   * dropping it into the idea box, not from this list.) */
  if (examplesPainted === "all") return;
  examplesPainted = "all";
  pick.innerHTML = '<option value="">Presets</option>'
    + EXAMPLES.map((e) => `<option value="${e.id}">${esc(e.label)}</option>`).join("");
}
paintExamples(false);

$("exPick").onchange = async () => {
  const v = $("exPick").value;
  const e = EXAMPLES.find((x) => x.id === v);
  if (!e) return;
  // Loading over unsaved work is the one destructive thing this control can do.
  // (What a preset or a dropped song put there is not unsaved work.)
  if (!state.presetShown && ($("caption").value.trim() || $("lyrics").value.trim()) &&
      !(await appConfirm("Replace what is in the form with this example?"))) {
    $("exPick").value = ""; return;
  }
  $("title").value = e.title || "";
  $("caption").value = e.caption;
  setMode(e.instrumental ? "instrumental" : "song");
  if (e.instrumental) {
    if (e.structure) $("structure").value = e.structure;
    if (e.sections) $("sections").value = e.sections;
    paintScaffold();
  } else {
    $("lyrics").value = e.lyrics || "";
  }
  countChars();
  fetch("/api/status").then((r) => r.json()).then(applyStatus).catch(() => {});
  presetShow(e);
  if (state.simple) paintSimpleChips();              // the preset is what the boxes show now
};
/* A preset in Simple mode: the form's own Lyrics and Styles boxes hold it,
 * read-only (they stay folded; open one to read it). One set of boxes, not a
 * second copy. Choosing no preset, the assistant writing, or leaving Simple
 * mode makes them editable again. */
function presetShow(e) {
  state.presetShown = e ? { caption: e.caption || "", lyrics: e.lyrics || "", song: e.song || "" } : null;
  for (const id of ["lyricsBox", "stylesBox"]) $(id)?.classList.toggle("preset-locked", !!e && !!state.simple);
  if (!e) $("exPick").value = "";
  simpleLock();
}
/* Simple mode: Lyrics and Styles are a read-only view of what the assistant
 * wrote, a preset or a dropped song — their options (tags, Enhance, roulette,
 * Guided, the instrumental structure) are hidden by .simplemode in the CSS.
 * Song and Instrumental make them editable again. The assistant still fills
 * them: a script can set a read-only box's value. */
function simpleLock() {
  const lock = !!state.simple;
  for (const id of ["caption", "lyrics", "capMeta", "capVocal", "capArr"]) { const el = $(id); if (el) el.readOnly = lock; }
  $("scaffold")?.setAttribute("contenteditable", lock ? "false" : "true");
}

/* ── song reference (drop box) ────────────────────────── */
/* Drag a Library row onto #songRef, or pick one from its ▾ menu, and the form
 * takes that song's lyrics and style. Nothing is sent with the job: the box is
 * only a record of where the words came from. Swapping to a different song
 * asks first, and "no" leaves the old song and the form exactly as they were. */
const SONG_DRAG = "application/x-aiplay-song";
function songRefTracks() {
  return (state.library || []).filter((t) => t.file && (String(t.caption || "").trim() || String(t.lyrics || "").trim()));
}
function songRefSub(t) {
  const cap = String(t.caption || "");
  return cap.length > 90 ? `${cap.slice(0, 90).trimEnd()}…` : cap || `seed ${t.seed}`;
}
function paintSongRef() {
  const t = (state.library || []).find((x) => x.file === state.songRef);
  $("srEmpty").hidden = !!t;
  $("srFull").hidden = !t;
  $("songRef").classList.toggle("has", !!t);
  if (!t) return;
  $("srArt").style.background = artBg(t);
  $("srTitle").textContent = t.title || t.file;
  $("srSub").textContent = songRefSub(t);
}
async function useSongRef(file) {
  const t = (state.library || []).find((x) => x.file === file);
  if (!t || file === state.songRef) return;
  const filled = $("caption").value.trim() || $("lyrics").value.trim();
  if ((state.songRef || filled) &&
      !(await appConfirm(`Replace the lyrics and style with “${t.title || t.file}”?`))) return;
  state.songRef = file;
  $("caption").value = t.caption || "";
  if (t.instrumental) setMode("instrumental");
  else { setMode("song"); $("lyrics").value = t.lyrics || ""; }
  countChars();
  paintSongRef();
}
function closeSongRefMenu() {
  $("srMenu").hidden = true;
  $("srMenuBtn").setAttribute("aria-expanded", "false");
}
function openSongRefMenu() {
  const rows = songRefTracks().sort((a, b) => b.createdAt - a.createdAt);
  $("srMenu").innerHTML = rows.length
    ? rows.map((t) => `
      <div class="row${t.file === state.songRef ? " playing" : ""}" data-sr="${encodeURIComponent(t.file)}">
        <div class="art" style="background:${artBg(t)}"></div>
        <div class="rmeta"><span class="rtitle">${esc(t.title || t.file)} <span class="ver">${esc(t.model || "")}</span></span>
          <span class="rsub">${esc(songRefSub(t))}</span></div>
        <div class="rside"><span>${t.durationSeconds ? fmt(t.durationSeconds) : ""}</span></div>
      </div>`).join("")
    : '<p class="empty">No songs with lyrics or a style in the Library yet.</p>';
  $("srMenu").hidden = false;
  $("srMenuBtn").setAttribute("aria-expanded", "true");
}
$("srMenuBtn").onclick = (e) => { e.stopPropagation(); $("srMenu").hidden ? openSongRefMenu() : closeSongRefMenu(); };
$("srEmpty").onclick = (e) => { e.stopPropagation(); $("srMenu").hidden ? openSongRefMenu() : closeSongRefMenu(); };
$("srClear").onclick = () => { state.songRef = null; closeSongRefMenu(); paintSongRef(); };
$("srMenu").onclick = (e) => {
  e.stopPropagation();
  const row = e.target.closest("[data-sr]");
  if (!row) return;
  closeSongRefMenu();
  useSongRef(decodeURIComponent(row.dataset.sr));
};
document.addEventListener("click", (e) => { if (!e.target.closest?.("#songRef")) closeSongRefMenu(); });
document.addEventListener("dragstart", (e) => {
  const row = e.target.closest?.(".row[data-file][draggable]");
  if (!row || !e.dataTransfer) return;
  const file = decodeURIComponent(row.dataset.file);
  e.dataTransfer.setData(SONG_DRAG, file);
  e.dataTransfer.effectAllowed = "copy";
  /* The empty box only exists while a song is in the air. */
  $("songRef").classList.add("dragging");
  $("songRef").scrollIntoView({ block: "nearest" });
  /* A small card as the drag picture, like Suno's, not a ghost of the whole row. */
  const t = (state.library || []).find((x) => x.file === file);
  if (t) {
    const g = document.createElement("div");
    g.className = "srghost";
    g.innerHTML = `<div class="art" style="background:${artBg(t)}"></div><div class="rmeta"><span class="rtitle">${esc(t.title || t.file)}</span><span class="rsub">${esc(t.model || "")}</span></div>`;
    document.body.appendChild(g);
    e.dataTransfer.setDragImage(g, 20, 20);
    setTimeout(() => g.remove());
  }
});
const songRefBox = $("songRef");
songRefBox.addEventListener("dragover", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes(SONG_DRAG)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  songRefBox.classList.add("over");
});
songRefBox.addEventListener("dragleave", (e) => { if (!songRefBox.contains(e.relatedTarget)) songRefBox.classList.remove("over"); });
/* THE BOX ALWAYS CLOSES. It used to close only on `dragend`, which fires on the
 * row being dragged; the Library repaints every few seconds, and a repainted
 * row is a detached one whose dragend never reaches the document — so a song
 * nudged a few pixels opened the box and it stayed open. Now it also closes on
 * a drop anywhere, when drag events stop arriving (the drag is over whatever
 * ended it), and at the first ordinary mouse movement after. */
let songDragWatch = null;
function endSongDrag() {
  clearTimeout(songDragWatch);
  songRefBox.classList.remove("dragging", "over");
  document.querySelector(".simple-input")?.classList.remove("over");
}
document.addEventListener("dragend", endSongDrag);
document.addEventListener("drop", endSongDrag);
document.addEventListener("dragover", () => {
  if (!songRefBox.classList.contains("dragging")) return;
  clearTimeout(songDragWatch);
  songDragWatch = setTimeout(endSongDrag, 400);
});
document.addEventListener("mousemove", (e) => { if (e.buttons === 0 && songRefBox.classList.contains("dragging")) endSongDrag(); });
songRefBox.addEventListener("drop", (e) => {
  songRefBox.classList.remove("over", "dragging");
  const file = e.dataTransfer?.getData(SONG_DRAG);
  if (!file) return;
  e.preventDefault();
  useSongRef(file);
});

/* One sideways-draggable row of tags; ▾ unfolds every tag at once, and the
 * help button sits outside the box on the right. */
$("lyricTags").innerHTML =
  `<div class="tagbox"><div class="tagrow" id="tagRow">` +
  OFFICIAL_TAGS.map((t) => `<button class="tag" type="button" data-tag="[${t}]">${t}</button>`).join("") +
  `</div><button class="tagmore" type="button" id="tagMore" aria-expanded="false" title="Show all tags">▾</button></div>` +
  `<button class="tipi" type="button" data-tip-key="tags" aria-label="What are section tags?" aria-expanded="false">!</button>`;
dragScroll($("tagRow"));
if ($("tagMore")) $("tagMore").onclick = () => {
  const open = $("lyricTags").classList.toggle("open");
  $("tagMore").setAttribute("aria-expanded", String(open));
  $("tagMore").title = open ? "Show one row" : "Show all tags";
};

/* These were decorative — they carried a data-tag and had no handler, so
 * clicking one did nothing at all. They insert at the cursor now. */
$("lyricTags").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tag]");
  if (!b) return;
  const ta = $("lyrics");
  const at = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, at);
  const after = ta.value.slice(ta.selectionEnd ?? at);
  // Tags want their own line, so add the breaks the user would have typed.
  const lead = before && !before.endsWith("\n") ? "\n" : "";
  const ins = `${lead}${b.dataset.tag}\n`;
  ta.value = before + ins + after;
  ta.focus();
  ta.selectionStart = ta.selectionEnd = at + ins.length;
  countChars();
});
$("modeSong").onclick = () => { setSimple(false); setMode("song"); };
$("modeInstr").onclick = () => { setSimple(false); setMode("instrumental"); };
$("modeSimple").onclick = () => setSimple(!state.simple);

/* ── Simple mode: the assistant fills this form ─────────────────────────────
 * web/chat.js runs the conversation against /api/chat/music and talks to this
 * file only through three page events, so neither module reaches into the
 * other: a snapshot of the form goes out with every message, a form patch comes
 * back from write_song / change_settings, and generate presses Create. */
/* Simple mode keeps the page on the idea: More Options and Advanced Options
 * step aside, and Lyrics and Styles fold shut (still there to open and read
 * what the assistant wrote). The song title stays, for the assistant to fill.
 * Leaving Simple mode puts the two boxes back the way they were. */
let simpleFolded = null;
function simpleFocus(on) {
  document.querySelector(".create")?.classList.toggle("simplemode", on);
  const boxes = ["lyricsBox", "stylesBox"].map((id) => $(id)).filter(Boolean);
  if (on && !simpleFolded) {
    simpleFolded = boxes.map((b) => [b, b.open]);
    boxes.forEach((b) => { b.open = false; });
  } else if (!on && simpleFolded) {
    simpleFolded.forEach(([b, open]) => { b.open = open; });
    simpleFolded = null;
  }
}
/* Into and out of Simple mode with the same motion as Song <-> Instrumental:
 * what leaves slides shut first (the song drop box, More Options, the open
 * Lyrics and Styles boxes folding to their headers, or the Simple panel),
 * then the switch happens and what arrives slides open. Reduced motion, the
 * first paint and a hidden panel switch at once. */
let simpleTurn = 0;
const simpleCalm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const simpleShown = (el) => !!el && el.getClientRects().length > 0;
const simpleGap = (el) => parseFloat(getComputedStyle(el.parentElement).rowGap) || 0;
const SHUT = (el) => ({ height: "0px", opacity: 0, overflow: "hidden", paddingTop: "0px", paddingBottom: "0px",
  borderTopWidth: "0px", borderBottomWidth: "0px", marginBottom: `${-simpleGap(el)}px` });
function slideShut(el) {
  return el.animate([{ height: `${el.offsetHeight}px`, opacity: 1, overflow: "hidden" }, SHUT(el)],
    { duration: 260, easing: "cubic-bezier(.4,0,.6,1)", fill: "forwards" });
}
/* An animation never outlives its time: where frames are not being drawn (a
 * background tab) the timeline can stall, and the switch must still happen. */
const simpleCap = (a, ms) => { setTimeout(() => a.cancel(), ms); return a; };
function slideOpen(el) {
  simpleCap(el.animate([SHUT(el), { height: `${el.offsetHeight}px`, opacity: 1, overflow: "hidden" }],
    { duration: 320, easing: "cubic-bezier(.22,.8,.24,1)" }), 450);
}
function foldedHeight(box) {
  const was = box.open;
  box.open = false;                                   // measured, never painted
  const h = box.offsetHeight;
  box.open = was;
  return h;
}
async function setSimple(on, instant = false) {
  on = !!on;
  if (instant || on === state.simple || simpleCalm() || !simpleShown($("modeSeg"))) { ++simpleTurn; return applySimple(on); }
  const turn = ++simpleTurn;
  const panel = $("simplePanel");
  const sides = [$("songRef"), ...document.querySelectorAll(".create details.adv.sbox")].filter(Boolean);
  const boxes = ["lyricsBox", "stylesBox"].map((id) => $(id)).filter(simpleShown);
  const before = new Map(boxes.map((b) => [b, b.offsetHeight]));
  const runs = (on ? sides.filter(simpleShown) : [panel]).map(slideShut);
  if (on) {
    for (const b of boxes.filter((x) => x.open)) {
      runs.push(b.animate([{ height: `${b.offsetHeight}px`, overflow: "hidden" }, { height: `${foldedHeight(b)}px`, overflow: "hidden" }],
        { duration: 260, easing: "cubic-bezier(.4,0,.6,1)", fill: "forwards" }));
    }
  }
  await Promise.race([Promise.all(runs.map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 380))]);
  if (turn !== simpleTurn) { runs.forEach((a) => a.cancel()); return; }
  const hidden = new Set(sides.filter((el) => !simpleShown(el)));
  applySimple(on);
  runs.forEach((a) => a.cancel());
  if (on) { slideOpen(panel); return; }
  sides.filter((el) => hidden.has(el) && simpleShown(el)).forEach(slideOpen);
  for (const b of boxes) {
    const to = b.offsetHeight, from = before.get(b);
    if (Math.abs(to - from) > 1) simpleCap(b.animate([{ height: `${from}px`, overflow: "hidden" }, { height: `${to}px`, overflow: "hidden" }],
      { duration: 320, easing: "cubic-bezier(.22,.8,.24,1)" }), 450);
  }
}
function applySimple(on) {
  state.simple = !!on;
  $("simplePanel").hidden = !state.simple;
  simpleFocus(state.simple);
  if (state.simple && state.guided) setGuided(false);          // one Styles line to read, not three boxes
  if (!state.simple && state.presetShown) presetShow(null);   // the form is editable again outside Simple
  simpleLock();
  $("modeSimple").setAttribute("aria-pressed", String(state.simple));
  setMode(state.mode === "instrumental" ? "instrumental" : "song");
  if (state.simple) setTimeout(() => $("simpleText")?.focus(), 0);
}
document.addEventListener("aiplay:simple-snapshot", (e) => {
  const d = e.detail;
  const val = (id) => $(id)?.value ?? "";
  const yue = yueEngine();
  d.engine = $("musicPillName")?.textContent || state.musicEngine || "";
  d.instrumental = state.mode === "instrumental";
  d.title = val("title");
  d.style = val("caption");
  d.lyrics = d.instrumental ? "" : val("lyrics");
  d.settings = {
    length_seconds: val("maxDur"), takes: state.takes, seed: val("seed"), random_seed: !state.seedLocked,
    ...(yue ? { key: val("yKey"), tempo: val("yBpm"), meter: val("yMeter"), thinking: val("yCot"), steps: val("ySteps"), guidance: val("yCfg") }
      : aceEngine() ? { key: val("aKey"), tempo: val("aBpm"), meter: val("aMeter"), language: val("aLang"), steps: val("aSteps"), guidance: val("aCfg") }
      : { steps: val("qSteps"), guidance: val("qCfg") }),
  };
  /* What the assistant needs for a remix: which engine is chosen, which remix
   * engines this machine has, and the songs dropped into the box. */
  d.engine_id = state.musicEngine || "";
  const seen = new Set();
  d.remix_models = (state.musicModels || [])
    .filter((c) => ["ace-step15", "yue2-comfy", "yue2-gguf", "yue2"].includes(c.engine) && c.available && !seen.has(c.engine) && seen.add(c.engine))
    .map((c) => ({ engine: c.engine, label: c.label || c.engine }));
  /* Every music model, installed or not and why; the render running; recent
   * ones that failed and why; the last melody transcription. */
  const curModel = $("musicPillName")?.textContent || "";
  d.music_models = (state.musicModels || []).map((c) => ({ value: c.value, engine: c.engine, label: c.label || c.value,
    available: !!c.available, note: c.note || "", current: c.engine === state.musicEngine && (c.label || "") === curModel }));
  const snap = state.lastSnap || {};
  const cur = snap.current;
  d.jobs = {
    running: cur ? `"${cur.title || "Untitled"}" on ${cur.engine}${cur.stageLabel ? `, ${cur.stageLabel}` : ""}${Number.isFinite(cur.overall) ? ` (${Math.round(cur.overall * (cur.overall <= 1 ? 100 : 1))}%)` : ""}` : "",
    queued: (snap.queue || []).length,
    recent: (snap.history || []).slice(0, 4).map((j) => `"${j.title || "Untitled"}" on ${j.engine}: ${j.state === "failed" ? `FAILED — ${j.error || "no reason recorded"}` : j.state}`),
  };
  if (state.lastTranscribe) d.transcription = state.lastTranscribe;
  if (aceCover?.song) d.remix = { song: aceCover.song, engine: "ace-step15" };
  d.max_length = Number($("maxDur")?.max) || 300;
  /* A YuE2 remix waiting for its transcription is a remix too. */
  if (!d.remix && state.remixTranscribe && yueEngine()) d.remix = { song: state.remixTranscribe, engine: state.musicEngine || "yue2" };
  d.attached = (state.simpleAttached || []).map((file) => {
    const t = simpleSongRow(file) || { file };
    return { file, title: t.title || file, model: t.model || t.engine || "", seed: t.seed, seconds: t.durationSeconds,
      instrumental: !!t.instrumental, style: t.caption || "", lyrics: t.lyrics || "" };
  });
});

/* ── songs dropped into the idea box (Simple mode) ────────────────────────── */
function paintSimpleChips() {
  const box = $("simpleChips");
  if (!box) return;
  const files = state.simpleAttached || [];
  const shown = state.presetShown?.song || "";
  box.hidden = !files.length;
  box.innerHTML = files.map((file) => {
    const t = (state.library || []).find((x) => x.file === file) || { file, title: file };
    return `<span class="schip${file === shown ? " on" : ""}" data-show="${encodeURIComponent(file)}" title="${esc(t.caption || "")}\nClick to show its lyrics and style below">`
      + `<i class="art" style="background:${artBg(t)}"></i><b>${esc(t.title || file)}</b>`
      + `<button type="button" data-unattach="${encodeURIComponent(file)}" aria-label="Remove ${esc(t.title || file)}">✕</button></span>`;
  }).join("");
}
/* A dropped song shows in the form's Lyrics and Styles boxes, read-only, the
 * way a preset does: the boxes are a view of what the assistant is reading.
 * With two or three dropped, the newest is shown; click a chip to show another.
 * Whatever the assistant writes next replaces it and unlocks the boxes. */
/* A Library row with what was read back from its file (/api/trackmeta).
 * Kept apart from state.library, which the 4-second poll replaces wholesale:
 * written onto the rows, the recovered words were gone before the next
 * message, and the assistant remixed a song it could not read. */
function simpleSongRow(file) {
  const row = (state.library || []).find((x) => x.file === file);
  if (!row) return null;
  const m = (state.trackMeta || {})[file] || {};
  return { ...row, lyrics: String(row.lyrics || "").trim() ? row.lyrics : (m.lyrics || ""),
    caption: String(row.caption || "").trim() ? row.caption : (m.caption || "") };
}
function showSimpleSong(file) {
  const t = simpleSongRow(file);
  if (!t) return;
  $("caption").value = t.caption || "";
  if (String(t.lyrics || "").trim()) { setMode("song"); $("lyrics").value = t.lyrics; }
  else { $("lyrics").value = ""; if (t.instrumental) setMode("instrumental"); }
  countChars();
  presetShow({ caption: t.caption || "", lyrics: t.lyrics || "", song: file });
  $("exPick").value = "";
  paintSimpleChips();
}
function attachToSimple(file) {
  const t = (state.library || []).find((x) => x.file === file);
  if (!file || !t) return;
  const list = state.simpleAttached || (state.simpleAttached = []);
  if (!list.includes(file)) list.push(file);
  if (list.length > 3) list.shift();                 // three at most: the prompt carries their lyrics
  showSimpleSong(file);
  $("simpleText")?.focus();
  /* Older songs keep their words only in the file's own tags (the listing
   * has none), which left the assistant and the boxes empty. Read them back,
   * the way the song panel does, and show them once they arrive. */
  if (!String(t.lyrics || "").trim() || !String(t.caption || "").trim()) {
    fetch(`/api/trackmeta?file=${encodeURIComponent(file)}`).then((r) => r.json()).then((m) => {
      if (!m || (!m.lyrics && !m.caption)) return;
      (state.trackMeta || (state.trackMeta = {}))[file] = { lyrics: m.lyrics || "", caption: m.caption || "" };
      if (state.presetShown?.song === file) showSimpleSong(file);
    }).catch(() => {});
  }
}
{
  const form = document.querySelector(".simple-input");
  form?.addEventListener("dragover", (e) => {
    if (![...(e.dataTransfer?.types || [])].includes(SONG_DRAG)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    form.classList.add("over");
  });
  form?.addEventListener("dragleave", (e) => { if (!form.contains(e.relatedTarget)) form.classList.remove("over"); });
  form?.addEventListener("drop", (e) => {
    form.classList.remove("over");
    const file = e.dataTransfer?.getData(SONG_DRAG);
    if (!file) return;
    e.preventDefault();
    attachToSimple(file);                            // never the form: Simple keeps its boxes shut
  });
  $("simpleChips")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-unattach]");
    if (!b) {
      const c = e.target.closest("[data-show]");
      if (c) showSimpleSong(decodeURIComponent(c.dataset.show));
      return;
    }
    const file = decodeURIComponent(b.dataset.unattach);
    state.simpleAttached = (state.simpleAttached || []).filter((f) => f !== file);
    if (aceCover?.song === file || state.remixTranscribe === file) clearRemix();
    if (state.presetShown?.song === file) {
      /* Its words leave with it: show the next dropped song, or empty boxes. */
      const next = state.simpleAttached[state.simpleAttached.length - 1];
      if (next) showSimpleSong(next);
      else { $("caption").value = ""; $("lyrics").value = ""; countChars(); presetShow(null); }
    }
    paintSimpleChips();
  });
  /* The whole block is the writing space: a click on it that is not a
   * control, a chip or the box itself puts the cursor in the box. */
  form?.addEventListener("mousedown", (e) => {
    if (e.target.closest("textarea, select, button, a, input, label, .schip, .ptools, .growbar")) return;
    e.preventDefault();
    const t = $("simpleText");
    t?.focus();
    t?.setSelectionRange(t.value.length, t.value.length);
  });
  $("simpleNew")?.addEventListener("click", () => { state.simpleAttached = []; clearRemix(); paintSimpleChips(); presetShow(null); });
}

growHandle($("simpleText"), "simple", (bar) => $("simplePanel")?.appendChild(bar));
growHandle($("lyrics"), "lyrics", (bar) => $("lyricsBox")?.appendChild(bar));
growHandle($("caption"), "caption", (bar) => $("stylesBox")?.appendChild(bar));
/* The Advanced description boxes on Images and Video: the same bar, not the
 * textarea's corner grip. */
growWrap($("imgPrompt"), "imgPrompt");
growWrap($("vidPrompt"), "vidPrompt");

/* A remix is set up until something says otherwise: New, removing that song's
 * chip, or the assistant's clear_remix. It used to outlive all three, so a
 * fresh song on ACE-Step came out as a cover of the old one, and YuE2 kept
 * singing the old transcription. */
function clearRemix() {
  if (aceCover?.song) {
    aceCover = null;
    if ($("aCoverSong")) $("aCoverSong").value = "";
    aceCoverPaint();
  }
  if (state.remixTranscribe) {
    if (state.remixTranscribed && $("yAbcUse")) $("yAbcUse").checked = false;   // only a score the remix put there
    state.remixTranscribe = null;
    state.remixTranscribed = null;
  }
}
/* A remix the assistant set up: switch to the engine, point it at the song. */
async function applyRemix(r) {
  const t = (state.library || []).find((x) => x.file === r.song);
  if (!t) return;
  const choice = (state.musicModels || []).find((c) => c.engine === r.engine && c.available);
  if (choice && state.musicEngine !== r.engine) await chooseMusicModel(choice.value);
  if (r.engine === "ace-step15") {
    aceCover = { song: r.song, label: t.title || r.song };
    if ($("aCoverSong")) $("aCoverSong").value = r.song;
    aceCoverPaint();
    state.remixTranscribe = null;
  } else {
    /* generate transcribes it first (aiplay:simple-generate below). */
    state.remixTranscribe = r.song;
    /* YuE2 re-sings a transcription: the Library song is set in its Cover
     * row and the person presses Transcribe (it holds the graphics card). */
    if ($("humEngine")) { $("humEngine").value = "song"; $("humEngine").dispatchEvent(new Event("change", { bubbles: true })); }
    if ($("humSong")) { $("humSong").value = r.song; $("humSong").dispatchEvent(new Event("change", { bubbles: true })); }
    if ($("yMusicPlan")) $("yMusicPlan").open = true;
  }
}
document.addEventListener("aiplay:simple-form", async (e) => {
  const f = e.detail || {};
  if (f.musicModel && (state.musicModels || []).some((c) => c.value === f.musicModel)) await chooseMusicModel(f.musicModel);
  const set = (id, v, ev = "input") => {
    const el = $(id);
    if (!el || v === undefined) return false;
    el.value = String(v);
    el.dispatchEvent(new Event(ev, { bubbles: true }));
    return true;
  };
  const touched = new Set();
  if (f.instrumental !== undefined) setMode(f.instrumental ? "instrumental" : "song");
  if (f.title !== undefined && set("title", f.title)) touched.add("title");
  if (f.style !== undefined) {
    if (!$("capGuide")?.hidden) setGuided(false);
    set("caption", f.style); touched.add("styles");
  }
  if (f.lyrics !== undefined) { set("lyrics", f.lyrics); touched.add("lyrics"); }
  if (f.lengthSeconds !== undefined) {
    const el = $("maxDur");
    el.value = String(Math.min(+el.max || 360, Math.max(+el.min || 30, f.lengthSeconds)));
    el.oninput?.(); touched.add("options");
  }
  if (f.takes !== undefined) { document.querySelector(`.howmany [data-n="${f.takes}"]`)?.click(); touched.add("options"); }
  if (f.seed !== undefined) { set("seed", f.seed); $("seedLock").click(); touched.add("options"); }
  if (f.randomSeed !== undefined) { $(f.randomSeed ? "seedRand" : "seedLock").click(); touched.add("options"); }
  if (f.remix) { applyRemix(f.remix); touched.add("options"); }
  else if (f.remix === null) { clearRemix(); touched.add("options"); }
  /* An engine with no Instrumental switch (YuE2 GGUF) stays in Song mode: its
   * instrumental is empty lyrics, or the old words would be sung. */
  if (f.instrumental === true && state.mode !== "instrumental") { set("lyrics", ""); touched.add("lyrics"); }
  if (f.style !== undefined || f.lyrics !== undefined) { state.presetShown = null; presetShow(null); }
  if (aceEngine()) {
    /* ACE-Step takes "E minor"; the assistant may write it the YuE2 way (Em). */
    if (f.key !== undefined) {
      const m = String(f.key).trim().match(/^([A-Ga-g])([b#]?)(m?)$/);
      set("aKey", m ? `${m[1].toUpperCase()}${m[2]} ${m[3] ? "minor" : "major"}` : "", "change"); touched.add("options");
    }
    if (f.tempo !== undefined) { set("aBpm", f.tempo); touched.add("options"); }
    if (f.meter !== undefined) { set("aMeter", String(f.meter).split("/")[0] || "", "change"); touched.add("options"); }
    if (f.language !== undefined) { set("aLang", f.language || "en", "change"); touched.add("options"); }
    if (f.steps !== undefined) { set("aSteps", f.steps); touched.add("options"); }
    if (f.guidance !== undefined) { set("aCfg", f.guidance); touched.add("options"); }
  } else if (yueEngine()) {
    if (f.key !== undefined) { set("yKey", f.key); touched.add("options"); }
    if (f.tempo !== undefined) { set("yBpm", f.tempo); touched.add("options"); }
    if (f.meter !== undefined) { set("yMeter", f.meter, "change"); touched.add("options"); }
    if (f.thinking !== undefined) { set("yCot", f.thinking, "change"); touched.add("options"); }
    if (f.steps !== undefined) { set("ySteps", f.steps <= 24 ? 16 : 32, "change"); touched.add("options"); }
    if (f.guidance !== undefined) { set("yCfg", f.guidance); touched.add("options"); }
  } else {
    if (f.steps !== undefined) { set("qSteps", Math.max(6, Math.min(30, f.steps))); touched.add("options"); }
    if (f.guidance !== undefined) { set("qCfg", Math.max(1, Math.min(4, f.guidance))); touched.add("options"); }
  }
  countChars();
  /* Open and briefly light the cards that changed, so the person sees where
   * the words went. */
  const card = { lyrics: $("lyricsBox"), styles: $("stylesBox"), options: document.querySelector("details.adv.sbox"), title: document.querySelector(".titlebox") };
  for (const k of touched) {
    const el = card[k];
    if (!el) continue;
    if (el.tagName === "DETAILS" && k !== "options") el.open = true;
    el.classList.remove("simple-flash");
    void el.offsetWidth;
    el.classList.add("simple-flash");
  }
});
/* The assistant's generate. A YuE2 remix renders from a transcription of the
 * song, so that runs first — one job on the graphics card, then the next —
 * and Create is pressed only if it worked (its error shows in the cover row). */
let simpleGenTurn = 0;
/* An assistant's Cancel (web/chat.js gpuWarning): the app's one Stop, and no
 * Create after a transcription that was still running. */
document.addEventListener("aiplay:gpu-cancel", (e) => {
  simpleGenTurn++;
  const done = fetch("/api/cancel", { method: "POST" }).then((r) => r.ok).catch(() => false);
  if (e.detail) e.detail.done = done;
});
/* Whether Create really started, for the assistant's log (web/chat.js):
 * "rendering now" was said before anything had happened, and several things
 * can stop it. */
const simpleGenerated = (ok, why = "") => document.dispatchEvent(new CustomEvent("aiplay:simple-generated", { detail: { ok, why } }));
document.addEventListener("aiplay:simple-generate", async () => {
  if (!$("xtPanel").hidden) return simpleGenerated(false, "the Extend panel is open, so Create would extend instead. Close it and ask again.");
  const turn = ++simpleGenTurn;                   // Cancel while transcribing: no Create after it
  const file = state.remixTranscribe;
  /* ONE TRANSCRIPTION PER SONG: the score is kept, so a second remix of the
   * same song (another style, other words) sings it again without asking the
   * card to listen to it twice. */
  const scores = state.scoreCache || (state.scoreCache = {});
  if (file && yueEngine() && scores[file] && state.remixTranscribed !== file) {
    if ($("yAbc")) $("yAbc").value = scores[file];
    if ($("yAbcUse")) $("yAbcUse").checked = true;
    if ($("yCot") && $("yCot").value === "off") $("yCot").value = "melody";
    state.remixTranscribed = file;
  }
  if (file && yueEngine() && (state.remixTranscribed !== file || !$("yAbc")?.value.trim())) {
    if ($("humEngine")?.value !== "song") { $("humEngine").value = "song"; $("humEngine").dispatchEvent(new Event("change", { bubbles: true })); }
    if ($("yMusicPlan")) $("yMusicPlan").open = true;
    document.dispatchEvent(new CustomEvent("aiplay:simple-progress", { detail: { text: "Transcribing the song's melody on the graphics card (about a minute)…" } }));
    if (!(await humSendSource({ library_file: file }))) {
      const why = $("humNote")?.textContent?.trim() || "no reason came back";
      state.lastTranscribe = `FAILED for ${file} — ${why}`;
      return simpleGenerated(false, `the melody could not be transcribed: ${why}`);
    }
    state.remixTranscribed = file;
    scores[file] = $("yAbc")?.value || "";
    state.lastTranscribe = `done for ${file}`;
    if (turn !== simpleGenTurn) return simpleGenerated(false, "cancelled.");
  }
  if (!String($("caption")?.value || "").trim() && !state.guided) return simpleGenerated(false, "there is no style in the form yet.");
  /* Create is briefly disabled after a press, and while the engine starts. */
  for (let i = 0; i < 10 && $("btnCreate").disabled; i++) await new Promise((r) => setTimeout(r, 200));
  if (turn !== simpleGenTurn) return simpleGenerated(false, "cancelled.");
  if ($("btnCreate").disabled) return simpleGenerated(false, `Create is not available right now${$("btnCreate").title ? ` (${$("btnCreate").title})` : ""}.`);
  $("btnCreate").click();
  simpleGenerated(true);
});
/* After the rest of this module has initialised: setMode reaches helpers defined further down. */
/* Every start opens on the full form (Song), not Simple: the owner's call,
 * 2026-09-19. Simple is one click away and stays chosen for the session. */

/* ── The song panel makes room ─────────────────────────────────────────────
 * The song details panel is fixed over the right edge of the library. While it
 * is open the library narrows to the space left of it (a fast slide), instead
 * of being covered; the menu and the Music panel stay as they are. Watches the
 * panel's own hidden flag,
 * so every way of opening or closing it is covered. */
{
  const sp = $("songPanel"), shell = document.querySelector(".shell");
  if (sp && shell) {
    new MutationObserver(() => {
      const open = !sp.hidden;
      if (open === shell.classList.contains("songopen")) return;
      shell.classList.toggle("songopen", open);
    }).observe(sp, { attributes: true, attributeFilter: ["hidden"] });
  }
}

/* ── real parameters, not cosmetic dials ──────────────── */
/* The ceiling wants headroom above the target: intros, outros and the gaps
 * between sections all consume time, so a song whose words run ~60 s needs
 * ~90 s of ceiling or the ending gets clipped. Warn rather than silently clip. */
$("maxDur").oninput = () => {
  const v = +$("maxDur").value;
  $("maxDurV").textContent = fmt(v);
  const need = state.mode === "instrumental"
    ? +$("sections").value * 19
    : $("lyrics").value.split("\n").filter((l) => l.trim() && !l.startsWith("[")).length * 8;
  const tight = need > 0 && v < need * 1.4;
  $("maxDurV").style.color = tight ? "var(--warn)" : "";
  $("maxDurV").title = tight
    ? `Tight — your material needs about ${fmt(Math.round(need * 1.4))} of headroom or the ending may be clipped.`
    : "";
  /* The ladder's answer depends on this value, so repaint here as well as
   * on an engine switch. Gated so MiniMax does not fire a request per
   * pixel of drag for an engine that has no rungs. `state`, not `config`:
   * this file has no `config` — the engines arrive in /api/status. */
  if ((state.musicEngines || {})[state.musicEngine]?.durationLadder) musicFitPaint();
};
$("qSteps").oninput = () => {
  const v = +$("qSteps").value;
  $("qStepsV").textContent = v;
  $("qStepsV").style.color = v === 15 ? "" : "var(--secondary)";
};
/* Two guidance scales, measured independent.
 *
 *   composition (AR)  steers the 8B LLM sampling the token trajectory. Changing
 *                     it invalidates the cached take -> a FULL render.
 *   render (flow)     steers flow-matching denoising. Changing it reuses the
 *                     cached take -> measured 16 s against 64 s, ~4x faster.
 *
 * Proven by capture count, not inference: five renders across three distinct
 * composition values produced exactly three AR executions, and the two that
 * varied only render guidance were both cache hits. */
$("qCfg").oninput = () => {
  $("qCfgV").textContent = (+$("qCfg").value).toFixed(1);
  paintGuidance();
};
$("qArCfg").oninput = () => {
  $("qArCfgV").textContent = (+$("qArCfg").value).toFixed(1);
  paintGuidance();
};
function paintGuidance() {
  // Say which of the two the next render will actually cost.
  const arChanged = state.lastSpec && state.lastSpec.arCfg !== +$("qArCfg").value;
  $("qArCfgV").style.color = +$("qArCfg").value === 1.7 ? "" : "var(--secondary)";
  $("qCfgV").style.color = +$("qCfg").value === 1.7 ? "" : "var(--secondary)";
  void arChanged;
}

/* ── help for the advanced controls ───────────────────── */
/* Every one of these maps to a real model parameter, which is the point — but a
 * name like "shift 5" or "cfg" means nothing unless you already know. Written
 * for someone who has never opened ComfyUI: what it does, then when to touch it.
 * Click, not hover — hover-only help is invisible on a touchscreen. */
const HELP = {
  seed: ["Seed",
    "The random starting point. The same seed with the same words gives you the " +
    "exact same song every time, so lock it when you have something you like and " +
    "want to change one small thing. Roll it for a completely different take."],
  maxDur: ["Length ceiling",
    "The longest the song is allowed to run — not a target. The model usually " +
    "stops earlier on its own, and how long your lyrics are matters far more than " +
    "this setting. Raise it if endings feel cut off."],
  qSteps: ["Quality",
    "How many passes are spent refining the audio. Fifteen is the measured sweet " +
    "spot: fewer starts to drift away from the sound you asked for, more mostly " +
    "costs time without a real gain. Every extra step makes the render slower."],
  qArCfg: ["Composition guidance",
    "How strictly the model follows your style description when deciding the " +
    "actual notes, chords and structure. Higher sticks closer to what you wrote " +
    "but can feel stiff and stop the song early; lower is looser and more " +
    "surprising. Changing this writes a whole new performance, so it costs a " +
    "full render."],
  qCfg: ["Render guidance",
    "How strictly your description shapes the sound and texture, once the " +
    "performance already exists. Higher is cleaner and more literal, lower is " +
    "rougher and more alive. This one reuses the take you already have, so it is " +
    "about four times faster to try than composition guidance."],
  qTier: ["Graphics memory",
    "How much of the model is kept on your graphics card at once. Auto is right " +
    "for almost everyone. Pick a smaller setting only if you run out of memory — " +
    "it streams more from ordinary RAM instead, which works but is slower."],
  qModel: ["Precision",
    "How finely the model's numbers are stored. int8 and fp16 were measured as " +
    "producing identical audio quality, so int8 is the default purely because it " +
    "takes half the disk space — changing between those two does not make your " +
    "music sound better. " +
    "fp32 is the full-precision original and has NOT been compared against the " +
    "other two. It is four times the size and much heavier on graphics memory, " +
    "so treat it as an experiment rather than a better setting."],
  qVis: ["Visualiser",
    "Makes the thin dividing lines in the app pulse along with whatever is " +
    "playing. Purely decorative — turn it off if you would rather have the " +
    "graphics card doing nothing else while it works."],
  sections: ["Structure",
    "How many sections the piece is built from. Instrumentals need this: with " +
    "nothing to fill, the model runs out after about thirty seconds. More " +
    "sections means a longer piece, roughly nineteen seconds each."],
  structure: ["Structure preset",
    "A starting skeleton of section tags for the kind of music you are making. " +
    "The nine tag names come from MiniMax and the model was trained on them; the " +
    "plain English after each dash is your own instruction for that section. Edit " +
    "the text below freely."],
};
const STATIC_HELP = {
  tags: ["Section tags",
    "Click one to drop it into the lyrics at your cursor. They tell the model " +
    "where the song changes — a chorus should lift, an outro should wind down — " +
    "and they are the main way you control structure. " +
    "Write them on their own line, and keep them BARE: [Chorus], not " +
    "[Chorus - big drums]. Anything extra inside the brackets gets SUNG, because " +
    "the model treats an unrecognised tag as words to perform. Describe how a " +
    "section should sound in the Style box instead — that is prose it reads as " +
    "description. " +
    "Instrumentals need tags too: with nothing to fill, the model stops after " +
    "about thirty seconds."],
  schedule: ["Schedule",
    "The pacing of the refinement passes. Ours concentrates effort where it " +
    "actually matters and lands about twice as close to a fully-converged render " +
    "as the stock setting, in half the time. There is no reason to change it, so " +
    "it is shown rather than offered."],
};

function attachHelp() {
  const mk = (key, title, body) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ihelp";
    b.setAttribute("aria-label", `What does ${title} do?`);
    b.dataset.help = key;
    b.textContent = "i";
    return b;
  };
  for (const [id, [title, body]] of Object.entries(HELP)) {
    const lab = document.querySelector(`label[for="${id}"]`)
      || $(id)?.closest("label");
    /* The Music panel has its own hover "!" tips (web/tips.js). */
    if (lab && !lab.closest(".create")) lab.appendChild(mk(id, title, body));
  }
  // "schedule" is a fixed readout, not a control, so it has no <label for>.
  const pk = [...document.querySelectorAll(".pk")].find((e) => e.textContent.trim() === "schedule");
  if (pk) pk.appendChild(mk("schedule", ...STATIC_HELP.schedule));

  // The tag-strip helper lives outside Advanced, so anchor its popover to the
  // create column rather than the settings panel.
  document.querySelector(".create")?.style.setProperty("position", "relative");

  const box = document.createElement("div");
  box.className = "helpbox";
  box.hidden = true;
  document.querySelector("details.adv")?.appendChild(box);

  document.addEventListener("click", (e) => {
    if (e.target.closest(".helpbox") && !e.target.closest(".helpbox .x")) return;
    const btn = e.target.closest(".ihelp");
    if (!btn) { box.hidden = true; return; }
    e.preventDefault();
    const [title, body] = HELP[btn.dataset.help] || STATIC_HELP[btn.dataset.help] || [];
    if (!title) return;
    // Second click on the same icon closes it.
    if (!box.hidden && box.dataset.of === btn.dataset.help) { box.hidden = true; return; }
    box.dataset.of = btn.dataset.help;
    box.innerHTML = `<button class="x" type="button" aria-label="Close">✕</button><b>${esc(title)}</b>${esc(body)}`;
    box.hidden = false;
    // Positioned against whichever container the icon lives in, so the layout
    // never moves. Sits under the row asked about, flipping above near the edge.
    // Anchor to whichever panel the icon ended up in — some controls now live in
    // Settings rather than Advanced.
    const host = btn.closest("details.adv, #settings") || document.querySelector(".create");
    if (box.parentElement !== host) host.appendChild(box);
    const panel = host.getBoundingClientRect();
    const r = btn.getBoundingClientRect();
    const below = r.bottom - panel.top + 6;
    box.style.top = `${below}px`;
    box.style.bottom = "auto";
    /* Follow the icon horizontally, clamped inside the panel. Without this the
     * card is always flush left, which reads as unrelated to whatever was
     * clicked when the icon is halfway down a wide settings page. */
    const want = r.left - panel.left;
    const maxLeft = Math.max(8, panel.width - box.offsetWidth - 8);
    box.style.left = `${Math.max(8, Math.min(want, maxLeft))}px`;
    box.style.right = "auto";
    if (r.bottom + box.offsetHeight + 24 > innerHeight) {
      box.style.top = "auto";
      box.style.bottom = `${panel.bottom - r.top + 6}px`;
    }
  });
}

/* ── full player ──────────────────────────────────────── */
/* A listening view. Everything technical stays in the song panel — this is the
 * one place in the app that is not for working. */
async function openFullPlayer() {
  const file = state.playingFile;
  const t = (state.library || []).find((x) => x.file === file);
  // Nothing playing yet — leave the panel open but empty rather than silently
  // ignoring the click, which reads as a broken button.
  if (!t) {
    $("fpTitle").textContent = "Nothing playing";
    $("fpSub").textContent = "Pick a track from the library.";
    $("fpStyle").textContent = "";
    $("fpLyrics").textContent = "";
    $("fpArt").style.background = "var(--raise)";
    return;
  }

  $("fpArt").style.background = artBg(t, true);
  $("fpTitle").textContent = t.title || "Untitled";
  $("fpSub").textContent = [
    t.durationSeconds ? fmt(t.durationSeconds) : null, stamp(t.createdAt),
  ].filter(Boolean).join(" · ");
  $("fpStyle").textContent = t.caption || "";
  $("fpLyrics").textContent = t.lyrics || "";
  $("fullPlayer").hidden = false;

  // Older tracks kept their words only in the file's own tags.
  if (!t.lyrics) {
    try {
      const m = await (await fetch(`/api/trackmeta?file=${encodeURIComponent(file)}`)).json();
      if (state.playingFile === file && m.lyrics) $("fpLyrics").textContent = m.lyrics;
      if (state.playingFile === file && m.caption && !t.caption) $("fpStyle").textContent = m.caption;
    } catch { /* leave it blank */ }
  }
}
/* The arrow is a toggle, and it turns over to say so — the same control that
 * raised the panel puts it back, rather than making you find a separate close
 * button in the far corner. */
function setFullPlayer(open) {
  $("fullPlayer").hidden = !open;
  $("pExpand").textContent = open ? "⌄" : "⌃";
  $("pExpand").title = open ? "Close the full player" : "Open the full player";
  $("pExpand").setAttribute("aria-expanded", String(open));
  if (open) openFullPlayer();
}
$("pExpand").onclick = () => setFullPlayer($("fullPlayer").hidden);
$("fpClose").onclick = () => setFullPlayer(false);
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("fullPlayer").hidden) setFullPlayer(false);
});
// Follow the queue: skipping tracks while it is open should update it, not
// leave the previous song's words on screen.
audio.addEventListener("play", () => { if (!$("fullPlayer").hidden) openFullPlayer(); });
// The glyph has to start out matching the closed state.
setFullPlayer(false);

/* ── re-roll the mix ──────────────────────────────────── */
/* Re-render THAT track, not whatever happens to be in the form.
 *
 * This previously called generate() with the form's current contents and only
 * swapped the seed field, so re-rolling a track while the form held something
 * else produced an unrelated song. It has to rebuild the spec from the track's
 * own stored settings.
 *
 * Getting that exactly right is also what makes it fast: hold caption, lyrics,
 * seed and composition guidance identical and change only the mix seed, and
 * ComfyUI reuses the cached AR stage — measured 16 s against 64 s. Any drift in
 * those four fields silently costs a full render. */
async function rerollMix(file) {
  let t = (state.library || []).find((x) => x.file === file);
  if (!t) return;
  /* No mix seed on YuE2: every render is the full model writing and singing
   * the song, so "same take, new mix" is not a thing it can do. Say so here,
   * the one choke point both the row menu and the song panel reach. */
  if (/yue2/i.test(String(t.model || ""))) {
    $("ctaNote").textContent = "YuE2 has no mix seed — every render is the full model writing and singing "
      + "the song. Use Reuse prompt and press Create for a new take.";
    return;
  }

  if (!t.lyrics || !t.caption) {
    try {
      const m = await (await fetch(`/api/trackmeta?file=${encodeURIComponent(file)}`)).json();
      t = { ...t, lyrics: t.lyrics || m.lyrics || "", caption: t.caption || m.caption || "" };
    } catch { /* proceed with what we have */ }
  }
  if (!t.caption) { $("ctaNote").textContent = "That track has no stored style, so it cannot be re-rolled."; return; }

  await fetch("/api/generate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: t.title,
      caption: t.caption,
      lyrics: t.lyrics || "",
      // Identical performance seed — this is what hits the AR cache.
      seed: t.seed,
      // New mix seed — this is the only thing that changes.
      mixSeed: Math.floor(Math.random() * 4294967296),
      steps: t.steps,
      arCfg: t.arCfg,
      flowCfg: t.flowCfg ?? t.cfg,
      model: t.model,
      instrumental: t.instrumental,
      reusesConditioning: true,
    }),
  }).catch(() => {});
  $("ctaNote").textContent = `Re-rolling “${t.title}” — same take, new render (~4× faster).`;
  poll();
}

/* ── reuse prompt ─────────────────────────────────────── */
/* Load a track's words and settings back into the form WITHOUT generating.
 * Distinct from re-roll, which fires immediately with everything unchanged —
 * the point here is to start from a take you liked and then change something.
 * Nothing is queued; the user presses Create when they are ready. */
async function reusePrompt(file) {
  let t = (state.library || []).find((x) => x.file === file);
  if (!t) return;

  // Older tracks kept their words only in the FLAC tags.
  if (!t.lyrics || !t.caption) {
    try {
      const m = await (await fetch(`/api/trackmeta?file=${encodeURIComponent(file)}`)).json();
      t = { ...t, lyrics: t.lyrics || m.lyrics, caption: t.caption || m.caption };
    } catch { /* fall through with what we have */ }
  }

  const nativeRow = t.engine === "yue2-gguf" || /yue2.*gguf/i.test(String(t.model || ""));
  if (nativeRow) {
    state.musicEngine = "yue2-gguf";
    const precision = ["q4_0", "q8_0"].includes(t.quantization) ? t.quantization
      : /\bQ8(?:_0)?\b/i.test(String(t.model || "")) ? "q8_0" : "q4_0";
    selectGgufPrecision(precision);
  }
  stopExtend();
  setView("create");
  setMode(t.instrumental ? "instrumental" : "song");
  $("title").value = t.title || "";
  setGuided(false);
  $("caption").value = t.caption || "";
  if (!t.instrumental) $("lyrics").value = t.lyrics || "";

  // The settings too, or "reuse" only half means it — routed to the controls
  // of the engine that made the row. A YuE2 row's `cfg` IS its cfg_scale
  // (null = the model's default) and its `steps` is the NAR solver's count;
  // writing those into MiniMax's hidden sliders would clamp 32 to 30 and set
  // the precision select to a value it has no option for.
  const yueRow = nativeRow || t.engine === "yue2" || /yue2/i.test(String(t.model || ""));
  if (yueRow) {
    if ($("yCfg")) $("yCfg").value = t.cfg == null ? "" : String(t.cfg);
    if ($("yCot") && t.cot) $("yCot").value = t.cot;
    if ($("ySteps") && (t.steps === 16 || t.steps === 32)) $("ySteps").value = String(t.steps);
    if (!nativeRow && $("yPrecision")) $("yPrecision").value = t.quantization === "fp8" ? "fp8" : "none";
  } else {
    if (t.steps) $("qSteps").value = t.steps;
    if (t.arCfg) $("qArCfg").value = t.arCfg;
    if (t.cfg || t.flowCfg) $("qCfg").value = t.flowCfg ?? t.cfg;
    if (t.model) $("qModel").value = t.model;
  }
  // A NEW seed by default: reusing a prompt to get the identical file back is
  // what re-roll is for. Lock it in Advanced if you want the same performance.
  $("seed").value = Math.floor(Math.random() * 4294967296);
  state.seedLocked = false;

  paintSeed();
  $("qSteps").oninput();
  $("qCfg").oninput();
  $("qArCfg").oninput();
  countChars();
  $("ctaNote").textContent = `Loaded from “${t.title || file}” — edit anything, then press Create.`;
  $("caption").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/* ── extend, in the input panel ───────────────────────── */
/* Extending is an editing job, not a settings job: you want the lyrics in front
 * of you and a picture of the audio to pick the joining point from. So this
 * takes over the Create panel — song loaded, waveform on top, KEEP and NEW
 * either side of a draggable handle — and Create becomes Extend.
 *
 * Peaks come from the same server endpoint the editor uses; decoding FLAC in
 * the browser was unreliable and is why the editor once hung on "reading audio". */
const xt = { file: null, dur: 0, at: 0, to: 0, mode: "extend", peaks: null, drag: false, dragWhich: "at" };

/* One panel, two jobs. Extend keeps [0, at) and writes a new ending; Replace
 * keeps [0, at) and [to, end) and writes the stretch between — the same
 * waveform, a second handle, and the Create button says which. */
function setXtMode(mode) {
  xt.mode = mode === "replace" ? "replace" : "extend";
  const rep = xt.mode === "replace";
  if (rep && !(xt.to > xt.at + 0.5)) xt.to = Math.min(xt.dur || xt.at + 10, xt.at + 10);
  $("xtModeExtend").setAttribute("aria-pressed", rep ? "false" : "true");
  $("xtModeReplace").setAttribute("aria-pressed", rep ? "true" : "false");
  $("xtHeadLab").textContent = rep ? "Replacing a section of" : "Extending";
  $("xtFromLab").textContent = rep ? "Replace" : "Extend from";
  $("xtToWrap").hidden = !rep;
  $("xtAll").hidden = rep;
  $("xtKeep2").hidden = !rep;
  $("xtHandle2").hidden = !rep;
  $("btnCreate").textContent = rep ? "Replace" : "Extend";
  paintXt();
}

async function startExtend(file, mode = "extend") {
  const t = (state.library || []).find((x) => x.file === file);
  if (!t) return;
  if (!t.codes && !t.yueDir && !state.tokenizerReady) {
    $("xtNote").textContent = "This take has no saved performance, so it cannot be extended. With the YuE2 real-audio tokenizer (Models screen) any recording can be.";
    return;
  }
  xt.file = file;
  xt.dur = t.durationSeconds || 0;
  /* A recording rather than a take: say so, and say what it takes. */
  if (!t.codes && !t.yueDir) {
    $("xtNote").textContent = "A recording: it is read into YuE2's own codes first (on the CPU while the card is busy), then YuE2 3B continues it — give it a style, and words or none.";
  }
  xt.at = Math.max(1, xt.dur * (mode === "replace" ? 0.4 : 0.8));
  xt.to = mode === "replace" ? Math.min(Math.max(xt.at + 0.5, xt.dur * 0.6), Math.max(xt.at + 0.5, xt.dur)) : 0;
  xt.peaks = null;

  // Load the song back into the form so the words can be edited before extending.
  $("title").value = t.title || "";
  setGuided(false);
  $("caption").value = t.caption || "";
  $("lyrics").value = t.lyrics || "";
  if (!t.lyrics) {
    fetch(`/api/trackmeta?file=${encodeURIComponent(file)}`).then((r) => r.json())
      .then((m) => { if (xt.file === file && m.lyrics) $("lyrics").value = m.lyrics; })
      .catch(() => {});
  }

  $("xtTitle").textContent = t.title || file;
  $("xtPanel").hidden = false;
  $("songPanel").hidden = true;
  $("xtLoad").hidden = false;
  setXtMode(mode);
  countChars();

  try {
    const j = await (await fetch(`/api/peaks/${encodeURIComponent(file)}`)).json();
    if (!j.ok) throw new Error(j.error || "no peaks");
    xt.dur = j.seconds || xt.dur;
    xt.peaks = Float32Array.from(j.peaks);
    xt.at = Math.min(xt.at, Math.max(1, xt.dur - 0.5));
    if (xt.mode === "replace") xt.to = Math.min(Math.max(xt.to, xt.at + 0.5), xt.dur);
    $("xtLoad").hidden = true;
    drawXt();
    paintXt();
  } catch {
    // Never a dead end — the numeric field still works without a picture.
    $("xtLoad").textContent = "Couldn’t draw the waveform — type a time below instead.";
  }
}

function stopExtend() {
  xt.file = null;
  $("xtPanel").hidden = true;
  $("btnCreate").textContent = "Create";
  $("xtNote").textContent = "";
}
$("xtCancel").onclick = stopExtend;
$("xtAll").onclick = () => { xt.at = Math.max(1, xt.dur - 0.2); paintXt(); };

// Tenths, because that is the precision the magnifier implies.
const tf = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}.${Math.floor((s % 1) * 10)}`;
const parseT = (v) => {
  const m = String(v).match(/^(\d+):(\d+(?:\.\d+)?)$/);
  return m ? +m[1] * 60 + +m[2] : parseFloat(v) || 0;
};

function paintXt() {
  const rep = xt.mode === "replace";
  const pct = xt.dur ? (xt.at / xt.dur) * 100 : 0;
  const pctB = rep && xt.dur ? (Math.min(xt.to, xt.dur) / xt.dur) * 100 : 100;
  $("xtKeep").style.width = `${pct}%`;
  const nw = $("xtNew");
  nw.style.left = `${pct}%`; nw.style.right = "auto";
  nw.style.width = `${Math.max(0, pctB - pct)}%`;
  $("xtHandle").style.left = `${pct}%`;
  if (rep) {
    $("xtKeep2").style.width = `${Math.max(0, 100 - pctB)}%`;
    $("xtHandle2").style.left = `${pctB}%`;
  }
  if (document.activeElement !== $("xtFrom")) $("xtFrom").value = tf(xt.at);
  if (rep && document.activeElement !== $("xtTo")) $("xtTo").value = tf(xt.to);
  $("xtNote").textContent = !xt.dur ? ""
    : rep
      ? `Keeps everything before ${tf(xt.at)} and from ${tf(xt.to)} on exactly as it is, and writes the ${tf(Math.max(0, xt.to - xt.at))} between again. The original file is never changed.`
      : `Keeps the first ${tf(xt.at)} exactly as it is, then writes a new ending. The original file is never changed.`;
}
$("xtModeExtend").onclick = () => setXtMode("extend");
$("xtModeReplace").onclick = () => setXtMode("replace");

function drawXt() {
  const c = $("xtWave");
  const w = c.clientWidth || 500, h = 72;
  const dpr = devicePixelRatio || 1;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext("2d");
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  if (!xt.peaks) return;
  const n = xt.peaks.length / 2, mid = h / 2;
  g.fillStyle = "hsl(195,100%,60%)";
  for (let x = 0; x < w; x++) {
    const i = Math.floor((x / w) * n);
    const lo = xt.peaks[i * 2], hi = xt.peaks[i * 2 + 1];
    g.fillRect(x, mid + lo * mid, 1, Math.max(1, (hi - lo) * mid));
  }
}

// Drag anywhere on the waveform to move the split.
const xtAtFromEvent = (e) => {
  const r = $("xtWrap").getBoundingClientRect();
  const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  return Math.min(Math.max(0.5, p * xt.dur), Math.max(0.5, xt.dur - 0.2));
};
/* In Replace mode the drag takes whichever handle is nearer, and the two
 * never cross: at least half a second between them. */
const xtDragTo = (e) => {
  const v = xtAtFromEvent(e);
  if (xt.mode !== "replace") { xt.at = v; return; }
  if (xt.dragWhich === "to") xt.to = Math.min(xt.dur, Math.max(v, xt.at + 0.5));
  else xt.at = Math.min(v, xt.to - 0.5);
};
$("xtWrap").addEventListener("pointerdown", (e) => {
  if (!xt.dur) return;
  xt.drag = true;
  try { $("xtWrap").setPointerCapture(e.pointerId); } catch { /* drag on, untracked past the edge */ }
  const v = xtAtFromEvent(e);
  xt.dragWhich = xt.mode === "replace" && Math.abs(v - xt.to) < Math.abs(v - xt.at) ? "to" : "at";
  xtDragTo(e); paintXt();
});
$("xtWrap").addEventListener("pointerup", () => { xt.drag = false; });
$("xtWrap").addEventListener("pointermove", (e) => {
  if (!xt.dur) return;
  if (xt.drag) { xtDragTo(e); paintXt(); }
  drawZoom(e);
});
$("xtWrap").addEventListener("pointerleave", () => { $("xtZoom").hidden = true; });

/* Magnifier. A 72 px-tall picture of three minutes is ~2.5 seconds per pixel,
 * so choosing a joining point by eye alone is hopeless. This blows up a
 * two-second window around the cursor. */
function drawZoom(e) {
  if (!xt.peaks) return;
  const wrap = $("xtWrap").getBoundingClientRect();
  const at = xtAtFromEvent(e);
  const box = $("xtZoom");
  box.hidden = false;
  box.style.left = `${Math.min(Math.max(e.clientX - wrap.left, 78), wrap.width - 78)}px`;
  $("xtZoomT").textContent = tf(at);

  const c = $("xtZoomC");
  const g = c.getContext("2d");
  const w = 150, h = 46, mid = h / 2;
  g.clearRect(0, 0, w, h);
  const n = xt.peaks.length / 2;
  const span = 2;                                   // seconds shown
  const from = at - span / 2;
  g.fillStyle = "hsl(195,100%,60%)";
  for (let x = 0; x < w; x++) {
    const t = from + (x / w) * span;
    if (t < 0 || t > xt.dur) continue;
    const i = Math.floor((t / xt.dur) * n);
    const lo = xt.peaks[i * 2], hi = xt.peaks[i * 2 + 1];
    g.fillRect(x, mid + lo * mid, 1, Math.max(1, (hi - lo) * mid));
  }
  g.fillStyle = "hsl(320,100%,70%)";
  g.fillRect(w / 2, 0, 1, h);
}

$("xtFrom").onchange = () => {
  xt.at = Math.min(Math.max(0.5, parseT($("xtFrom").value)), Math.max(0.5, xt.dur - 0.2));
  if (xt.mode === "replace" && xt.to < xt.at + 0.5) xt.to = Math.min(xt.dur, xt.at + 0.5);
  paintXt();
};
$("xtTo").onchange = () => {
  const v = parseT($("xtTo").value);
  if (!(v > xt.at + 0.5)) { $("xtNote").textContent = "\"Keep the ending from\" must be a time past the extend point."; paintXt(); return; }
  xt.to = Math.min(v, xt.dur || v);
  paintXt();
};
$("xtPlayFrom").onclick = () => {
  if (!xt.file) return;
  audio.src = `/api/audio/${encodeURIComponent(xt.file)}`;
  audio.currentTime = Math.max(0, xt.at - 3);   // a run-up, so the join has context
  audio.play().catch(() => {});
  $("pTitle").textContent = $("xtTitle").textContent;
};
// Follow playback on the waveform so "from here" is visibly from here.
audio.addEventListener("timeupdate", () => {
  if (!xt.file || !xt.dur) return;
  const head = $("xtHead");
  head.style.display = "block";
  head.style.left = `${(audio.currentTime / xt.dur) * 100}%`;
});

/* ── generation ───────────────────────────────────────── */
function currentSpec(preview, mixSeed) {
  const instrumental = state.mode === "instrumental";
  if (yueEngine() && $("yAbcUse")?.checked) {
    if (!$("yAbc")?.value.trim()) throw new Error("Add an ABC score or turn off ‘Use this score’.");
    if ($("yCot")?.value === "off") throw new Error("A supplied score needs chain of thought full or melody.");
    if (state.musicEngines?.[state.musicEngine]?.score && $("scoreUse")?.checked) throw new Error("Choose one score source: this ABC draft or the saved score, not both.");
  }
  const firstLine = $("lyrics").value.trim().split("\n").find((l) => l && !l.startsWith("["));
  if ((state.musicEngines || {})[state.musicEngine]?.runtime === "audiocpp") {
    return {
      engine: "yue2-gguf",
      title: ($("title").value.trim() || firstLine || "YuE2 GGUF song").slice(0, 60),
      caption: captionValue(), lyrics: instrumental ? "" : $("lyrics").value,
      instrumental, preview: !!preview, seed: Number($("seed").value) || 0,
      cot: $("yCot").value, narSteps: Number($("ySteps").value) || 32,
      cfgScale: $("yCfg").value.trim() === "" ? undefined : Number($("yCfg").value),
      quantization: ggufPrecision(),
      abc: $("yAbcUse")?.checked ? $("yAbc")?.value.trim() : undefined,
    };
  }
  return {
    // Title is metadata only — the model has no title input. It names the library
    // entry and goes into the exported file's tags, nothing more.
    title: ($("title").value.trim() || firstLine || (instrumental ? "Instrumental" : "Untitled")).slice(0, 60),
    caption: captionValue(),
    // Instrumental sends the section scaffold on MiniMax, not an empty string
    // (see above) — and an empty string on YuE2, which sings brackets; the
    // server phrases "no vocals" into the style there.
    lyrics: instrumental ? (aceEngine() ? "[Instrumental]" : yueEngine() ? "" : scaffold(+$("sections").value)) : $("lyrics").value,
    instrumental,
    /* YuE2 through ComfyUI reads its OWN controls. This spec is the MiniMax
     * shape, and without these three the Music tab's "chain of thought" and
     * "steps" choices never reached the server, which rendered its defaults. */
    ...(state.musicEngine === "ace-step15" ? aceSpec() : {}),
    ...(state.musicEngine === "yue2-comfy"
      ? { engine: "yue2-comfy", cot: $("yCot")?.value || "full", narSteps: Number($("ySteps")?.value) || 32,
          /* "" is an explicit none — the server would otherwise fall back to its saved choice. */
          lora: $("yLora")?.value || "", loraStrength: Number($("yLoraStrength")?.value ?? 100) / 100,
          loraClip: $("yLoraClip")?.value || "", loraClipStrength: Number($("yLoraClipStrength")?.value ?? 100) / 100 }
      : {}),
    steps: +$("qSteps").value,
    arCfg: +$("qArCfg").value,
    flowCfg: +$("qCfg").value,
    // The performance. Held steady across a re-roll.
    model: $("qModel").value,
    seed: Number($("seed").value) || 0,
    // The mix. Undefined means "same as seed" — a fresh value is what makes a
    // re-roll produce a different render of the same take.
    mixSeed,
    maxDuration: +$("maxDur").value,
    /* Audio reference, when one has been encoded. The slider IS the denoise
     * value — left keeps more of the reference, right keeps less — so there is
     * no inversion to get wrong, and the words under it say what each end does. */
    audioRef: state.audioRef?.latent,
    audioRefDenoise: state.audioRef ? +$("arefStrength").value / 100 : undefined,
    preview,
    /* YuE2's own parameters (protocol.py SongRequest): the chain-of-thought
     * mode, an optional guidance scale (empty = the model's default), and the
     * precision the driver runs the AR half at. Sent whatever the engine —
     * the MiniMax path ignores them, and the server validates each one. */
    ...yueSpec(),
  };
}

/* The YuE2 rows in Advanced, and the score panel's "render from this score"
 * — read only when the rows exist in the DOM (index.html data-engine="yue2").
 * A supplied score travels with the slug and version it was loaded from, so
 * the render lands as a child of that version rather than as a new score. */
/* ── hum a melody (Advanced Options): MediaRecorder → /api/hum → the ABC box ── */
let humRecorder = null, humChunks = [];
function humSay(text) { const n = $("humNote"); if (n) n.textContent = text; }
async function humSend(blob, name) {
  const data_url = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => resolve(String(fr.result));
    fr.readAsDataURL(blob);
  });
  return humSendSource({ data_url, name });
}
/* One sender for every source shape: a recording or a dropped file arrives as
 * a data URL, a library song as its name — which is the shape the vocal-stem
 * option needs, because a stem is filed under the library name. */
async function humSendSource(source) {
  humSay("Listening for the notes…");
  try {
    /* A hummed line goes to the pitch tracker; a whole song to SheetSage2, which
     * holds the card for a while and needs the Cover row installed. */
    const song = $("humEngine")?.value === "song";
    const r = await (await fetch(song ? "/api/song_to_score" : "/api/hum", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(song
        ? { source, mode: $("humMode")?.value || "melody", stem: $("humStem")?.checked && source.library_file ? "vocals" : undefined }
        : { source }),
    })).json();
    if (r.error) { humSay(r.error + (r.needsModel ? " Open the Models screen to install it." : "")); return false; }
    if ($("yAbc")) $("yAbc").value = r.abc;
    if ($("yAbcUse")) $("yAbcUse").checked = true;
    // A supplied score needs the chain of thought on; "melody" plans the tune only.
    if ($("yCot") && $("yCot").value === "off") $("yCot").value = "melody";
    humSay(r.notes != null
      ? `${r.notes} notes over ${r.bars} bar${r.bars === 1 ? "" : "s"} · key ${r.key} (${r.keyFrom}) · ${Math.round(r.bpm)} bpm (${r.bpmFrom}) · the score is in the box below and ticked for Create`
      : `transcribed (${r.mode}) · ${r.bars ?? "?"} bars · key ${r.key ?? "?"} · ${r.bpm ?? "?"} bpm · the score is in the box below and ticked for Create — for a cover, write the new voice into the style line and press Create`);
    return true;
  } catch (e) { humSay(String(e.message || e)); return false; }
}
$("humRec")?.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
      .find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
    humChunks = [];
    humRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    humRecorder.ondataavailable = (e) => { if (e.data && e.data.size) humChunks.push(e.data); };
    humRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const type = humRecorder.mimeType || mime || "audio/webm";
      const ext = /ogg/.test(type) ? "ogg" : /mp4/.test(type) ? "m4a" : "webm";
      $("humRec").hidden = false; $("humStop").hidden = true;
      if ($("humState")) $("humState").textContent = "";
      humSend(new Blob(humChunks, { type }), `hum.${ext}`);
    };
    humRecorder.start();
    $("humRec").hidden = true; $("humStop").hidden = false;
    if ($("humState")) $("humState").textContent = "recording… hum one phrase, then Stop";
    humSay("");
  } catch (e) { humSay(`The microphone could not be opened: ${e.message || e}`); }
});
$("humStop")?.addEventListener("click", () => { if (humRecorder && humRecorder.state !== "inactive") humRecorder.stop(); });
$("humFile")?.addEventListener("change", () => {
  const f = $("humFile").files?.[0];
  if (f) humSend(f, f.name);
  $("humFile").value = "";
});
/* The song-only rows (library picker, Voice only) show with the whole-song
 * transcriber; the picker is filled from the Library each time it opens. */
function paintHumRows() {
  const song = $("humEngine")?.value === "song";
  for (const el of document.querySelectorAll("[data-humsong]")) el.hidden = !song;
  /* The prime needs the real-audio tokenizer; without it the row still shows,
   * at 0 and disabled, with the reason — a control that vanishes teaches
   * nobody what would bring it back. */
  const prime = $("covPrime");
  if (prime) {
    prime.disabled = !state.tokenizerReady;
    if (!state.tokenizerReady) { prime.value = 0; if ($("covPrimeValue")) $("covPrimeValue").textContent = "off"; }
    const note = $("covPrimeNote");
    if (note && !state.tokenizerReady) {
      note.textContent = "Starting from the original needs the YuE2 real-audio tokenizer — download it on the Models screen. "
        + "Without it a cover is the transcribed score performed in your style, which is the recipe that existed before.";
    }
  }
  const sel = $("humSong");
  if (sel && song) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">Pick a song to cover…</option>'
      + (state.library || []).filter((t) => /\.(flac|mp3|opus|wav)$/i.test(t.file))
        .map((t) => `<option value="${esc(t.file)}">${esc(t.title || t.file)}</option>`).join("");
    sel.value = cur;
  }
  if ($("humGo")) $("humGo").hidden = !(song && sel?.value);
}
$("humEngine")?.addEventListener("change", paintHumRows);
$("humSong")?.addEventListener("change", () => { if ($("humGo")) $("humGo").hidden = !$("humSong").value; });
$("humGo")?.addEventListener("click", () => {
  const file = $("humSong")?.value;
  if (file) humSendSource({ library_file: file });
});
paintHumRows();

/* ── the YuE2 LoRA picker (Advanced Options, ComfyUI engine only) ────────── */
let musicLoraShelfKey = null;
async function musicLoadLoras(force = false) {
  const sel = $("yLora");
  if (!sel) return;
  const ck = state.musicYue2Checkpoint || "";
  if (!force && musicLoraShelfKey === ck) return;
  musicLoraShelfKey = ck;
  let rows = [];
  try {
    const d = await (await fetch(`/api/loras${ck ? `?for=${encodeURIComponent(ck)}` : ""}`)).json();
    rows = (d.loras || []).filter((l) => l.isLora);
  } catch { rows = []; }
  const fit = (l) => l.fits?.fit || "unknown";
  const chosen = state.musicYue2Lora || "";
  sel.innerHTML = '<option value="">none</option>' + rows.map((l) => {
    const mark = fit(l) === "yes" ? "" : fit(l) === "no" ? " · ✗ " + (l.base || "?") : " · ? " + (l.base || "?");
    /* A mismatch is disabled, not hidden, and its base is the useful part. */
    return `<option value="${esc(l.name)}"${fit(l) === "no" ? " disabled" : ""} title="${esc(l.fits?.why || l.base || "")}">${esc(l.name.replace(/\.safetensors$/i, ""))}${mark}</option>`;
  }).join("");
  sel.value = rows.some((l) => l.name === chosen) ? chosen : "";
  /* ⚠ THE SHELF COUNT GOES IN ITS OWN SPAN. It used to be written over
   * `yLoraNote`, whose markup explains what the two doors are — so the page
   * shipped a sentence saying "the composer is not patched" directly under the
   * control that patches the composer, every time the shelf was painted. The
   * explanation is static in the HTML; only the count changes here. */
  const shelf = $("yLoraShelf");
  if (shelf) {
    shelf.textContent = chosen && sel.value !== chosen
      ? `· ${chosen} is not in a loras folder any more — pick another, or none.`
      : rows.length
        ? `· ${rows.length} in models/loras.`
        : "· nothing in models/loras yet — a YuE2 LoRA goes there.";
  }
  const st = $("yLoraStrength");
  if (st && Number.isFinite(state.musicYue2LoraStrength)) {
    st.value = Math.round(state.musicYue2LoraStrength * 100);
    if ($("yLoraStrengthValue")) $("yLoraStrengthValue").textContent = Number(state.musicYue2LoraStrength).toFixed(2);
  }
  /* The planner's shelf: the same files, none disabled — the fit check above
   * reads a LoRA against the AUDIO model, and a planner LoRA matches the other
   * half, so its verdict says nothing here. */
  const clipSel = $("yLoraClip");
  if (clipSel) {
    const chosenClip = state.musicYue2LoraClip || "";
    clipSel.innerHTML = '<option value="">none</option>' + rows.map((l) =>
      `<option value="${esc(l.name)}">${esc(l.name.replace(/\.safetensors$/i, ""))}</option>`).join("");
    clipSel.value = rows.some((l) => l.name === chosenClip) ? chosenClip : "";
    const cst = $("yLoraClipStrength");
    if (cst && Number.isFinite(state.musicYue2LoraClipStrength)) {
      cst.value = Math.round(state.musicYue2LoraClipStrength * 100);
      if ($("yLoraClipStrengthValue")) $("yLoraClipStrengthValue").textContent = Number(state.musicYue2LoraClipStrength).toFixed(2);
    }
  }
}
async function musicSavePlannerLora() {
  const value = $("yLoraClip")?.value || "";
  const strength = Number($("yLoraClipStrength")?.value ?? 100) / 100;
  state.musicYue2LoraClip = value; state.musicYue2LoraClipStrength = strength;
  try {
    const r = await (await fetch("/api/music", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "planner-lora", value, strength }) })).json();
    if (r.error && $("yLoraShelf")) $("yLoraShelf").textContent = `· ${r.error}`;
  } catch (e) { if ($("yLoraShelf")) $("yLoraShelf").textContent = `· ${String(e.message || e)}`; }
}
$("yLoraClip")?.addEventListener("change", musicSavePlannerLora);
$("covPrime")?.addEventListener("input", () => {
  const v = Number($("covPrime").value);
  if ($("covPrimeValue")) $("covPrimeValue").textContent = v ? `${v}s` : "score only";
});
$("yLoraClipStrength")?.addEventListener("input", () => { if ($("yLoraClipStrengthValue")) $("yLoraClipStrengthValue").textContent = (Number($("yLoraClipStrength").value) / 100).toFixed(2); });
$("yLoraClipStrength")?.addEventListener("change", musicSavePlannerLora);
async function musicSaveLora() {
  const value = $("yLora")?.value || "";
  const strength = Number($("yLoraStrength")?.value ?? 100) / 100;
  state.musicYue2Lora = value; state.musicYue2LoraStrength = strength;
  try {
    const r = await (await fetch("/api/music", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "lora", value, strength }) })).json();
    if (r.error && $("yLoraShelf")) $("yLoraShelf").textContent = `· ${r.error}`;
  } catch (e) { if ($("yLoraShelf")) $("yLoraShelf").textContent = `· ${String(e.message || e)}`; }
}
$("yLora")?.addEventListener("change", musicSaveLora);
$("yLoraStrength")?.addEventListener("input", () => { if ($("yLoraStrengthValue")) $("yLoraStrengthValue").textContent = (Number($("yLoraStrength").value) / 100).toFixed(2); });
$("yLoraStrength")?.addEventListener("change", musicSaveLora);

/* ── ACE-Step 1.5: its options panel (Advanced → ACE-Step Options) ─────── */
const ACE_KEYS = ["C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B"]
  .flatMap((r) => [`${r} major`, `${r} minor`]);
const ACE_LANGS = [["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"],
  ["nl", "Dutch"], ["pl", "Polish"], ["ru", "Russian"], ["uk", "Ukrainian"], ["bg", "Bulgarian"], ["cs", "Czech"], ["ro", "Romanian"],
  ["sv", "Swedish"], ["da", "Danish"], ["no", "Norwegian"], ["fi", "Finnish"], ["el", "Greek"], ["tr", "Turkish"], ["ar", "Arabic"],
  ["he", "Hebrew"], ["fa", "Persian"], ["hi", "Hindi"], ["bn", "Bengali"], ["ur", "Urdu"], ["ta", "Tamil"], ["te", "Telugu"],
  ["pa", "Punjabi"], ["ne", "Nepali"], ["zh", "Chinese (Mandarin)"], ["yue", "Cantonese"], ["ja", "Japanese"], ["ko", "Korean"],
  ["vi", "Vietnamese"], ["th", "Thai"], ["id", "Indonesian"], ["ms", "Malay"], ["tl", "Tagalog"], ["sw", "Swahili"],
  ["hu", "Hungarian"], ["hr", "Croatian"], ["sr", "Serbian"], ["sk", "Slovak"], ["lt", "Lithuanian"], ["is", "Icelandic"],
  ["ca", "Catalan"], ["az", "Azerbaijani"], ["ht", "Haitian Creole"], ["la", "Latin"], ["sa", "Sanskrit"], ["unknown", "Other / none"]];
let aceCover = null;   // { upload } or { song }, and a label
let aceLoraShelfKey = null;
function acePaintOptions() {
  const key = $("aKey"), lang = $("aLang");
  if (key && key.options.length < 2) key.innerHTML += ACE_KEYS.map((k) => `<option>${esc(k)}</option>`).join("");
  if (lang && !lang.options.length) lang.innerHTML = ACE_LANGS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
  const choice = (state.musicModels || []).find((c) => c.engine === "ace-step15" && c.dit === state.musicAceModel)
    || (state.musicModels || []).find((c) => c.engine === "ace-step15");
  const lm = $("aLm"), lms = choice?.lms || [];
  const sig = lms.join("|") + "#" + (choice?.lm || "");
  if (lm && lm.dataset.sig !== sig) {
    lm.innerHTML = lms.length
      ? lms.map((n) => `<option value="${esc(n)}">${esc(/4b/i.test(n) ? "4B (best, most memory)" : /1\.7b/i.test(n) ? "1.7B (lighter)" : n)}</option>`).join("")
      : '<option value="">none on a shelf</option>';
    lm.value = choice?.lm || lms[0] || "";
    lm.dataset.sig = sig;
  }
  const song = $("aCoverSong");
  const lib = (state.library || []).slice(0, 200);
  const libSig = lib.map((t) => t.file).join("|");
  if (song && song.dataset.sig !== libSig) {
    const was = song.value;
    song.innerHTML = '<option value="">none</option>' + lib.map((t) => `<option value="${esc(t.file)}">${esc(t.title || t.file)}</option>`).join("");
    song.value = lib.some((t) => t.file === was) ? was : "";
    song.dataset.sig = libSig;
  }
  aceLoadLoras();
}
async function aceLoadLoras(force = false) {
  const sel = $("aLora");
  if (!sel) return;
  const dit = state.musicAceModel || (state.musicModels || []).find((c) => c.engine === "ace-step15" && c.dit)?.dit || "";
  if (!force && aceLoraShelfKey === dit) return;
  aceLoraShelfKey = dit;
  let rows = [];
  try {
    const d = await (await fetch(`/api/loras${dit ? `?for=${encodeURIComponent(dit)}` : ""}`)).json();
    rows = (d.loras || []).filter((l) => l.isLora);
  } catch { rows = []; }
  const fit = (l) => l.fits?.fit || "unknown";
  const chosen = state.musicAceLora || "";
  sel.innerHTML = '<option value="">none</option>' + rows.map((l) => {
    const mark = fit(l) === "yes" ? "" : fit(l) === "no" ? " · ✗ " + (l.base || "?") : " · ? " + (l.base || "?");
    return `<option value="${esc(l.name)}"${fit(l) === "no" ? " disabled" : ""} title="${esc(l.fits?.why || l.base || "")}">${esc(l.name.replace(/\.safetensors$/i, ""))}${mark}</option>`;
  }).join("");
  sel.value = rows.some((l) => l.name === chosen) ? chosen : "";
  const fits = rows.filter((l) => fit(l) === "yes").length;
  if ($("aLoraNote")) {
    $("aLoraNote").textContent = rows.length
      ? `${fits} of ${rows.length} in models/loras are ACE-Step 1.5 LoRAs. With a LoRA the planner switches off, as ACE-Step's own LoRA card advises.`
      : "Nothing in models/loras yet. An ACE-Step 1.5 LoRA goes there.";
  }
  const st = $("aLoraStrength");
  if (st && Number.isFinite(state.musicAceLoraStrength)) {
    st.value = Math.round(state.musicAceLoraStrength * 100);
    if ($("aLoraStrengthValue")) $("aLoraStrengthValue").textContent = Number(state.musicAceLoraStrength).toFixed(2);
  }
}
async function aceSaveLora() {
  const value = $("aLora")?.value || "";
  const strength = Number($("aLoraStrength")?.value ?? 100) / 100;
  state.musicAceLora = value; state.musicAceLoraStrength = strength;
  // ACE-Step's LoRA card: render with the DiT only, not the planner.
  if (value && $("aCodes")) $("aCodes").checked = false;
  try {
    const r = await (await fetch("/api/music", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "aceLora", value, strength }) })).json();
    if (r.error && $("aLoraNote")) $("aLoraNote").textContent = r.error;
  } catch (e) { if ($("aLoraNote")) $("aLoraNote").textContent = String(e.message || e); }
}
$("aLora")?.addEventListener("change", aceSaveLora);
$("aLoraStrength")?.addEventListener("input", () => { if ($("aLoraStrengthValue")) $("aLoraStrengthValue").textContent = (Number($("aLoraStrength").value) / 100).toFixed(2); });
$("aLoraStrength")?.addEventListener("change", aceSaveLora);
$("aLm")?.addEventListener("change", async () => {
  state.musicAceLm = $("aLm").value;
  try {
    const r = await (await fetch("/api/music", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "aceLm", value: $("aLm").value }) })).json();
    if (r.error) alert(r.error);
  } catch { /* the next status poll repaints it */ }
});
function aceCoverPaint() {
  $("aCoverState").textContent = aceCover ? `Covering: ${aceCover.label}` : "";
  $("aCoverClear").hidden = !aceCover;
  if (aceCover && $("aCodes")) $("aCodes").checked = false;
}
$("aCoverSong")?.addEventListener("change", () => {
  const f = $("aCoverSong").value;
  const t = (state.library || []).find((x) => x.file === f);
  aceCover = f ? { song: f, label: t?.title || f } : null;
  aceCoverPaint();
});
$("aCoverFile")?.addEventListener("change", async () => {
  const file = $("aCoverFile").files?.[0];
  if (!file) return;
  $("aCoverState").textContent = "Uploading…";
  try {
    const r = await (await fetch("/api/refaudio", { method: "POST", body: file })).json();
    if (r.error) throw new Error(r.error);
    aceCover = { upload: r.name, label: file.name };
    if ($("aCoverSong")) $("aCoverSong").value = "";
  } catch (e) { aceCover = null; $("aCoverState").textContent = String(e.message || e); return; }
  finally { $("aCoverFile").value = ""; }
  aceCoverPaint();
});
$("aCoverClear")?.addEventListener("click", () => {
  aceCover = null;
  if ($("aCoverSong")) $("aCoverSong").value = "";
  aceCoverPaint();
});
/** What the ACE-Step rows ask for. Blank rows are left out: the server decides them. */
function aceSpec() {
  const num = (id) => { const v = ($(id)?.value ?? "").trim(); return v === "" ? undefined : Number(v); };
  return {
    engine: "ace-step15",
    bpm: num("aBpm"),
    keyscale: $("aKey")?.value || undefined,
    timesignature: $("aMeter")?.value || undefined,
    language: $("aLang")?.value || "en",
    aceSteps: num("aSteps"),
    aceCfg: num("aCfg"),
    aceCodes: !!$("aCodes")?.checked,
    acePlanTemp: num("aPlanTemp"),
    /* "" is an explicit none; the server would otherwise use the saved choice. */
    lora: $("aLora")?.value || "",
    loraStrength: Number($("aLoraStrength")?.value ?? 100) / 100,
    aceCover: aceCover ? (aceCover.upload ? { upload: aceCover.upload } : { song: aceCover.song }) : undefined,
  };
}

function yueSpec() {
  const cot = $("yCot");
  if (!cot) return {};
  const cfg = ($("yCfg")?.value ?? "").trim();
  const out = {
    cot: cot.value,
    cfgScale: cfg === "" ? undefined : Number(cfg),
    quantization: $("yPrecision")?.value || undefined,
    narSteps: $("ySteps")?.value ? Number($("ySteps").value) : undefined,
  };
  /* Key / tempo / meter and the sampler dials: sent only when set, so the
   * GGUF door (which refuses unknown fields) and the vendor defaults hold. */
  const num = (id) => { const v = $(id)?.value; return v === undefined || v === null || String(v).trim() === "" ? undefined : Number(v); };
  if ($("yKey")?.value.trim()) out.key = $("yKey").value.trim();
  if (num("yBpm") !== undefined) out.bpm = num("yBpm");
  if ($("yMeter")?.value) out.meter = $("yMeter").value;
  if (num("yTemp") !== undefined) out.temperature = num("yTemp");
  if (num("yTopP") !== undefined) out.topP = num("yTopP");
  if (num("yPlanTemp") !== undefined) out.planTemperature = num("yPlanTemp");
  /* A COVER is the score plus a prime: the score in `abc` came from a library
   * song (the Transcriber set to "Whole song"), and the slider says how many
   * seconds of that song's own performance the model hears first. At 0 nothing
   * is sent and this is the plain score recipe. */
  const covFile = $("humEngine")?.value === "song" ? ($("humSong")?.value || "") : "";
  const covSecs = Number($("covPrime")?.value ?? 0);
  const use = $("scoreUse");
  if (yueEngine() && $("yAbcUse")?.checked) out.abc = $("yAbc")?.value.trim();
  if (out.abc && covFile && covSecs > 0 && state.tokenizerReady) {
    const covStem = $("covStem")?.value || "";
    out.coverOf = { file: covFile, seconds: covSecs, ...(covStem ? { stem: covStem } : {}) };
  }
  // The hum-to-song recipe: with a score, leave it open for the planner.
  if (out.abc && $("yAbcOpen")?.checked) out.abcOpen = true;
  if (state.musicEngines?.[state.musicEngine]?.score && use?.checked && typeof scorePanelSelection === "function") {
    const sel = scorePanelSelection();
    if (sel?.abc?.trim()) Object.assign(out, { abc: sel.abc, scoreSlug: sel.slug || undefined, scoreVersion: sel.version || undefined });
  }
  return out;
}

/** A re-roll is: same conditioning inputs, different sampling. ComfyUI reuses the
 *  cached autoregressive stage, so it costs ~60% of a full render. */
function reusesConditioning(spec) {
  const p = state.lastSpec;
  // cfg is part of the conditioning, so changing it invalidates the cache too.
  return !!p && p.caption === spec.caption && p.lyrics === spec.lyrics &&
         p.seed === spec.seed && p.maxDuration === spec.maxDuration && p.cfg === spec.cfg;
}

/* ── audio reference ──────────────────────────────────────
 *
 * Upload once, encode once, then re-roll as often as you like: the server names
 * the .latent after the source's content, so the same file never pays for a
 * second encode.
 *
 * The bands come from a measured sweep (see workflow.js). They are named rather
 * than numbered because "0.85" tells nobody anything, and the useful range is
 * narrow enough that a wrong guess wastes a whole render.
 */
const AREF_BANDS = [
  [0.62, "less denoising", "More source audio remains in the decoder initialization. This is not a restoration guarantee."],
  [0.72, "moderate denoising", "An experimental balance between the source initialization and newly generated audio."],
  [0.82, "more denoising", "The decoder can change more of the source. Melody and timing are not constrained."],
  [0.88, "high denoising", "More of the result comes from generation. Compare with the source before keeping a take."],
  [1.01, "loose reference", "Little source initialization remains; continuity may be weak."],
];
function arefBand(d) {
  return AREF_BANDS.find(([hi]) => d < hi) || AREF_BANDS[AREF_BANDS.length - 1];
}
function paintAref() {
  const on = !!state.audioRef;
  $("arefTune").hidden = !on;
  $("arefClear").hidden = !on;
  if (!on) { $("arefState").textContent = "off"; return; }
  const d = +$("arefStrength").value / 100;
  const [, name, note] = arefBand(d);
  $("arefStrengthV").textContent = name;
  $("arefStrengthNote").textContent = note;
  $("arefState").textContent = `${state.audioRef.name} · ${name}`;
}
$("arefStrength").oninput = paintAref;
$("arefClear").onclick = () => { state.audioRef = null; $("arefFile").value = ""; paintAref(); };
$("arefFile").onchange = async () => {
  const f = $("arefFile").files?.[0];
  if (!f) return;
  $("arefState").textContent = "encoding…";
  try {
    // Raw bytes, not a data URI: a lossless master is tens of megabytes and
    // base64 would inflate it by a third for nothing.
    const r = await fetch(`/api/audioref?name=${encodeURIComponent(f.name)}`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f,
    });
    const j = await r.json();
    if (j.error) { $("arefState").textContent = "off"; alert(j.error); return; }
    state.audioRef = { latent: j.latent, name: f.name, seconds: j.seconds };
    // A reference the autoencoder reconstructs badly will produce a bad song
    // for a reason nobody could guess from the result. Say it now instead.
    if (j.weak) {
      alert(`This reference only reconstructs at ${j.siSdrDb} dB, which is low — `
        + `the model may not have much to hold on to. It will still run.`);
    }
    paintAref();
  } catch (err) {
    $("arefState").textContent = "off";
    alert(String(err.message || err));
  }
};

async function generate(preview, mixSeed) {
  /* 🎲 RANDOM MEANS RANDOM ON EVERY CREATE.
   *
   * The button used to set ONE seed when pressed, and Create reused it until
   * somebody pressed 🎲 again — while the note under it promised "a fresh seed
   * each time". A second Create therefore sent an identical graph, ComfyUI
   * served it from its cache in 0.00 s, and the runner filed the previous song
   * as a success: measured on 2026-09-16, eighteen "renders" in six seconds, no
   * new audio and no message. A re-roll (mixSeed set) keeps the seed on purpose. */
  if (!state.seedLocked && mixSeed == null) $("seed").value = Math.floor(Math.random() * 4294967296);
  musicOutcomeMsg = null;   // a new Create replaces the last song's warning
  let spec;
  try { spec = currentSpec(preview, mixSeed); }
  catch (error) { alert(error.message); return; }
  if (spec.engine === "yue2-gguf" && !nativeMusicReady(state.musicEngines?.[spec.engine])) {
    alert(`${ggufPrecisionLabel()} is not ready. Review its optional setup before generating.`);
    return;
  }
  if (!spec.caption.trim()) { $("caption").focus(); return; }
  if (spec.engine !== "yue2-gguf") spec.reusesConditioning = reusesConditioning(spec);
  $("btnCreate").disabled = $("btnPreview").disabled = true;
  try {
    // Queue N takes, each with its own seed so they are different performances
    // rather than different mixes of one. A preview is always a single take.
    const n = preview || mixSeed != null ? 1 : (state.takes || 1);
    const r = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    });
    const j = await r.json();
    if (j.error) { alert(j.error); return; }
    else state.lastSpec = { ...spec };

    for (let i = 1; i < n; i++) {
      await fetch("/api/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...spec,
          seed: Math.floor(Math.random() * 4294967296),
          title: `${spec.title} · take ${i + 1}`,
        }),
      }).catch(() => {});
    }
  } finally {
    setTimeout(() => {
      const eng = (state.musicEngines || {})[state.musicEngine];
      $("btnCreate").disabled = $("btnPreview").disabled = eng?.runtime === "audiocpp" ? !nativeMusicReady(eng) : !state.engineReady;
    }, 400);
  }
}
/* Takes per generation. Each is a separate queued run — the AR stage is fixed at
 * batch 2 (conditional + unconditional) and cannot render two performances at
 * once, so this costs time rather than VRAM. */
state.takes = Number(localStorage.getItem("aiplayTakes")) || 1;
for (const b of document.querySelectorAll("[data-n]")) {
  b.classList.toggle("on", +b.dataset.n === state.takes);
  b.onclick = () => {
    state.takes = +b.dataset.n;
    localStorage.setItem("aiplayTakes", String(state.takes));
    for (const o of document.querySelectorAll("[data-n]")) o.classList.toggle("on", o === b);
    fetch("/api/status").then((r) => r.json()).then(applyStatus).catch(() => {});
  };
}

// Send the current prompt to the overnight list instead of rendering it now.
$("btnToOvernight").onclick = () => {
  const caption = captionValue().trim();
  if (!caption) { $("caption").focus(); return; }
  const instrumental = state.mode === "instrumental";
  ov.ideas.push({
    title: $("title").value.trim() || "Untitled",
    caption,
    lyrics: instrumental ? $("scaffold").textContent : $("lyrics").value.trim(),
    instrumental,
    maxDuration: +$("maxDur").value,
  });
  ovRender();
  $("ctaNote").textContent =
    `Added to the overnight list — ${ov.ideas.length} idea${ov.ideas.length > 1 ? "s" : ""} queued. Set takes and start it in Overnight.`;
};

$("btnCreate").onclick = () => (xt.file ? runExtend() : generate(false));

/* Extend uses the same button as Create, because it is the same act — you have
 * a form full of words and a picture of the audio, and you press the big one. */
async function runExtend() {
  const file = xt.file;
  $("btnCreate").disabled = true;
  try {
    /* Replace mode: the original comes back at the second handle. */
    const replacing = xt.mode === "replace";
    const toSec = xt.to;
    /* A recording is read into YuE2's codes BEFORE the job exists — the route
     * awaits the tokenizer — so nothing enters the queue and no progress
     * arrives. A disabled button with a static line under it reads as a hang
     * on a six-minute import, so the line counts: the estimate is the measured
     * CPU rate (30 s of song in 16 s), and the elapsed seconds tick beside it. */
    const track = (state.library || []).find((x) => x.file === file);
    let tokTimer = null;
    if (track && !track.codes && !track.yueDir) {
      const est = Math.max(5, Math.round((track.durationSeconds || 60) * 0.55));
      const t0 = Date.now();
      const tick = () => {
        const s = Math.round((Date.now() - t0) / 1000);
        $("xtNote").textContent = `Reading the recording into YuE2's codes — ${s}s of about ${est}s. `
          + "It is read once and kept, so the next continuation of this track starts at once.";
      };
      tick();
      tokTimer = setInterval(tick, 1000);
    }
    const stopTok = () => { if (tokTimer) { clearInterval(tokTimer); tokTimer = null; } };
    if (replacing && !(toSec > xt.at + 0.5)) { $("xtNote").textContent = "\"Keep the ending from\" must be a time past the extend point."; $("btnCreate").disabled = false; return; }
    const r = await fetch(replacing ? "/api/replace" : "/api/extend", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file,
        fromSeconds: xt.at,
        ...(replacing ? { toSeconds: toSec } : {}),
        seconds: 45,
        caption: captionValue(),
        // Send the edited words. Leaving this out makes the server append its own
        // continuation sections; supplying them means you decide where it goes.
        lyrics: $("lyrics").value,
        // A longer score for a YuE2 take, when Advanced Options holds one.
        abc: $("yAbcUse")?.checked ? ($("yAbc")?.value.trim() || undefined) : undefined,
        /* Which layer of a recording primes it — the mix unless one is chosen.
         * A take ignores this: its own performance is already the prefix. */
        stem: $("spStem")?.value || undefined,
        seed: Math.floor(Math.random() * 4294967296),
      }),
    }).then((x) => x.json());
    stopTok();
    if (r.error) { $("xtNote").textContent = r.error; return; }
    stopExtend();
    poll();
  } finally {
    $("btnCreate").disabled = false;
  }
}
$("btnPreview").onclick = () => generate(true);
$("btnCancel").onclick = () => fetch("/api/cancel", { method: "POST" });

/* The queue's own stop button. Same endpoint as btnCancel, which now stops the
 * art lane as well as the song job — so this one button covers songs, covers,
 * boards, clips, stems and lyrics.
 *
 * It reports what it actually stopped rather than going quiet: "nothing was
 * running" and "stopped a 28-minute clip" deserve different feedback, and a
 * button that looks identical either way teaches nobody anything. */
{
  const stop = $("qStop");
  if (stop) {
    stop.onclick = async () => {
      stop.disabled = true;
      const before = stop.textContent;
      stop.textContent = "stopping…";
      try {
        const r = await fetch("/api/cancel", { method: "POST" });
        const j = await r.json().catch(() => ({}));
        const a = j.artStopped || {};
        const bits = [];
        if (a.wasRunning) bits.push(`stopped ${a.wasRunning}`);
        if (a.dropped) bits.push(`dropped ${a.dropped}`);
        stop.textContent = bits.length ? bits.join(", ") : "nothing was running";
      } catch {
        stop.textContent = "could not stop";
      }
      setTimeout(() => { stop.textContent = before; stop.disabled = false; }, 2600);
    };
  }
}

/* ── live state ───────────────────────────────────────── */
const STAGES = ["composing", "arranging", "mixing", "saving"];
const LABEL = { composing: "composing", arranging: "arranging", mixing: "mixing down", saving: "saving" };
/* YuE2's stages are the driver's (yue.js STAGES), which the runner passes
 * through by key: the score is written, then sung, then the audio is solved
 * and decoded. `waiting` and `load` come before all four and draw as "none
 * done yet"; the row's stageLabel names them in words. */
const YUE_STAGES = ["plan", "semantic", "nar", "vae"];
const YUE_LABEL = { plan: "writing the score", semantic: "composing", nar: "synthesising", vae: "decoding" };
// The normal native CLI does not report its inner phases. Do not invent them,
// derive percentages from elapsed time, or borrow another engine's ETA.
/* The native render's phases, read live from audio.cpp's own timing lines
 * (music/yue-gguf.js). Its ETA exists once this machine has finished one
 * native render to measure from; until then the phase is live and the ETA
 * says why it is missing. */
const GGUF_STAGES = ["waiting", "load", "plan", "semantic", "nar", "decode", "verify"];
const GGUF_LABEL = { waiting: "Waiting for GPU", load: "Load model", plan: "Score", semantic: "Sing",
  nar: "Synthesise", decode: "Decode", verify: "Verify audio" };
const ggufEtaKnown = (j) => Number.isFinite(j?.etaSeconds) && j.etaSeconds >= 0;
function nativeMusicPending(s) {
  // Only a native job with no measured ETA leaves the queue total unknown.
  return (s.current?.engine === "yue2-gguf" && !ggufEtaKnown(s.current))
    || (s.queue || []).some((j) => j.engine === "yue2-gguf");
}

function musicWarningHtml(track, compact = false) {
  const warnings = Array.isArray(track?.warnings)
    ? track.warnings.filter((w) => w && typeof w.message === "string" && w.message.trim()).slice(0, 5)
    : [];
  if (!warnings.length) return "";
  if (compact) {
    const label = warnings.some((w) => w.code === "possible_semantic_limit") ? "Check ending" : "Check take";
    return `<button type="button" class="badge generation-warning" data-info="${encodeURIComponent(track.file)}" title="${esc(warnings.map((w) => w.message).join("\n"))}">${label}</button>`;
  }
  return warnings.map((w) => `<p>${esc(w.message)}</p>`).join("");
}

/**
 * EVERYTHING THAT IS COMING, and what it adds up to.
 *
 * Three separate things were already visible one at a time — the song rendering
 * now, the art queue's count, and the overnight run's own ETA — and none of them
 * answered the question anyone actually has at midnight, which is "will this be
 * finished before I get up". So they are summed here, in the rail, where the
 * answer survives a tab switch.
 *
 * The overnight run's remaining time comes from the SERVER, which measures its
 * own pace on the real card once a run is going, rather than from a guess made
 * here. A number that improves as the night proves itself is worth more than a
 * confident one made at the start.
 */
function renderQueue(s) {
  const box = $("queueBox");
  if (!box) return;
  const rows = [];
  let secs = 0;
  const unknownNative = nativeMusicPending(s);

  const cur = s.current;
  if (cur) {
    rows.push({ now: true, what: cur.title || "rendering", secs: null });
  }
  /* ⚠ AND THE ART JOB THAT IS ACTUALLY RUNNING.
   *
   * `s.current` is the SONG job; the art lane's running job was never a row
   * here — only its QUEUE was, via queuedKinds. So during a long clip render
   * with nothing waiting behind it, this panel had no rows at all and hid
   * itself. The Stop button disappeared exactly while there was something to
   * stop, and reappeared the moment another job queued up: the flicker Senzu
   * saw, and the reason the box seemed to come and go at random.
   *
   * A render is work in progress and belongs in the list of work in progress. */
  const art = s.art || {};
  if (art.current) {
    const el = Number(art.current.elapsed) || 0;
    const pc = Number(art.current.progress) || 0;
    /* Remaining from measured progress, not a guess: at 40% after 4 minutes the
     * honest answer is 6 more, and the panel already knows both numbers. */
    const left = (pc > 0.02 && el > 5) ? Math.max(0, Math.round(el / pc - el)) : 0;
    rows.push({
      now: true,
      what: `${art.current.title || art.current.kind || "rendering"}${pc ? ` · ${Math.round(pc * 100)}%` : ""}`,
      secs: left || null,
    });
    secs += left;
  }
  for (const j of (s.queue || [])) {
    if (j.engine === "yue2-gguf") {
      rows.push({ what: j.title || "song", unknown: true });
      continue;
    }
    /* The server's own estimate rides on the row (jobs.js #estimate knows
     * each engine's measured ratio); the MiniMax figure is the fallback for
     * a row that predates it. */
    const est = Number(j.etaSeconds) > 0 ? Number(j.etaSeconds) : 150 * (state.realtimeRatio || 1.53);
    secs += est;
    rows.push({ what: j.title || "song", secs: est });
  }

  /* The art lane drains covers, clips, stems and lyrics. Counting KINDS rather
   * than a flat total, because a cover is three seconds and a clip is minutes —
   * a single number over both is the kind of average that is never true. */
  const kinds = (s.art && s.art.queuedKinds) || {};
  const ART_SECS = { cover: 4, clip: 90, stems: 60, lrc: 36, enhance: 16, upscale: 99 };
  for (const [k, n] of Object.entries(kinds)) {
    if (!n) continue;
    const est = (ART_SECS[k] ?? 30) * n;
    secs += est;
    rows.push({ what: `${n} ${k}${n > 1 ? "s" : ""}`, secs: est });
  }

  const run = s.run;
  if (run && (run.state === "running" || run.state === "paused")) {
    const left = Number(run.secondsLeft) || 0;
    secs += left;
    const kind = run.kind === "image" ? "picture" : run.kind === "video" ? "clip" : "song";
    rows.push({
      what: `overnight · ${Math.max(0, (run.total || 0) - (run.done || 0))} ${kind}s left${run.state === "paused" ? " (paused)" : ""}`,
      secs: left,
    });
  }

  /* ⚠ DO NOT HIDE THE INSTANT THE QUEUE EMPTIES.
   *
   * Between two jobs there is a moment with nothing running and nothing queued,
   * and this used to hide the whole box for it — so a long batch flashed the
   * panel away and back on every handover, and everything under it in the rail
   * jumped up and down with it. That reads as the app glitching.
   *
   * Two seconds of grace: long enough to cover a handover, short enough that a
   * genuinely finished queue still tidies itself away. */
  if (!rows.length) {
    if (!renderQueue.emptyAt) renderQueue.emptyAt = Date.now();
    if (Date.now() - renderQueue.emptyAt > 2000) box.hidden = true;
    return;
  }
  renderQueue.emptyAt = 0;
  box.hidden = false;
  $("qTotal").textContent = unknownNative ? "ETA unavailable" : secs ? `~${dur(secs)} of work` : "working";
  /* The clock time, not just a duration: "done by 06:40" is the form the
   * decision is actually made in. */
  $("qEta").textContent = unknownNative
    ? (secs ? `~${dur(secs)} estimated for other jobs` : "Native music runtime is not measured")
    : secs ? `done by ${clock(Date.now() + secs * 1000)}` : "";
  $("qRows").innerHTML = rows.map((r) =>
    `<div class="qrow${r.now ? " now" : ""}"><span>${esc(r.what)}</span><b>${r.unknown ? "unknown" : r.secs ? dur(r.secs) : "now"}</b></div>`).join("");
}

function renderNow(cur, queued = 0) {
  const box = $("nowBox");
  if (!cur) { box.hidden = true; return; }
  box.hidden = false;
  // Position first, then time. With a queue running, "which one is this" is the
  // question people actually have — the ETA only covers the song in flight.
  const total = queued + 1;
  const pos = total > 1 ? `1 of ${total} in queue · ` : "";
  const gguf = cur.engine === "yue2-gguf";
  const elapsed = typeof cur.elapsedSeconds === "number" && Number.isFinite(cur.elapsedSeconds) && cur.elapsedSeconds >= 0
    ? `${dur(cur.elapsedSeconds)} elapsed · ` : "";
  $("nowTitle").textContent = (cur.preview ? "Preview · " : "") + (cur.title || "Untitled");
  $("nowEta").textContent = gguf && cur.state === "running" && !ggufEtaKnown(cur)
    ? pos + elapsed + "ETA after the first native render"
    : gguf && cur.state === "running"
    ? pos + elapsed + (cur.etaSeconds > 60 ? `~${Math.floor(cur.etaSeconds / 60)} min ${String(cur.etaSeconds % 60).padStart(2, "0")} s left` : `~${cur.etaSeconds} s left`)
    : cur.state === "running"
    ? pos + (cur.etaSeconds > 60 ? `~${Math.floor(cur.etaSeconds / 60)} min ${String(cur.etaSeconds % 60).padStart(2, "0")} s left` : `~${cur.etaSeconds} s left`)
    : pos + cur.state;

  /* Each engine draws its own stages: the row says which engine made it. A
   * YuE2 stage that precedes the four drawn ones (waiting, load) leaves them
   * all pending, and the meta line below names it in words. */
  const yue = cur.engine === "yue2";
  const stages = gguf ? GGUF_STAGES : yue ? YUE_STAGES : STAGES;
  const labels = gguf ? GGUF_LABEL : yue ? YUE_LABEL : LABEL;
  const at = stages.indexOf(cur.stage);
  $("nowStages").innerHTML = stages.map((s, i) => {
    const cls = i < at ? "done" : i === at ? "now" : "";
    const pct = !gguf && i === at && cur.stageProgress ? ` ${Math.round(cur.stageProgress * 100)}%` : "";
    return `<span class="s ${cls}">${i < at ? "✓ " : i === at ? "◆ " : ""}${labels[s]}${pct}</span>`;
  }).join('<span class="sep"></span>');

  const noBar = gguf && !(cur.overall > 0);
  $("nowBar").classList.toggle("indeterminate", noBar);
  $("nowBar").style.width = noBar ? "100%" : `${Math.round((cur.overall || 0) * 100)}%`;
  const progress = $("nowProgress");
  if (progress) {
    progress.setAttribute("aria-label", noBar ? "Generation progress unavailable" : "Generation progress");
    if (noBar) progress.removeAttribute("aria-valuenow");
    else progress.setAttribute("aria-valuenow", String(Math.round(Math.max(0, Math.min(1, cur.overall || 0)) * 100)));
  }
  $("nowMeta").textContent = gguf
    ? `YuE2 GGUF ${cur.quantization === "q8_0" ? "Q8_0" : "Q4_0"} · non-commercial · ${cur.error || GGUF_LABEL[cur.stage] || cur.stageLabel || cur.stage} · seed ${cur.seed}`
    /* YuE2 through ComfyUI: the graph's own sampler (buildYue2ComfyGraph). */
    : cur.engine === "yue2-comfy"
    ? `YuE2 3B (ComfyUI) · ${cur.cot === "off" ? "no score plan" : `${cur.cot || "full"} score plan`} · dpm_2 · ${cur.narSteps || 32} steps · seed ${cur.seed}`
    : yue
    ? `${cur.stageLabel || "YuE2"} · ${cur.rung?.label || "Standard"}${cur.quantization === "fp8" ? " · 8-bit AR" : ""} · seed ${cur.seed}`
    : cur.preview ? "preview · 6 steps" : "shift 5 · 15 steps · seed " + cur.seed;
}

function art(seed) {
  // Deterministic from the seed, so a track always looks the same, but varied in
  // form as well as hue — one conic gradient for every row made the library read
  // as a colour chart rather than a set of distinct covers.
  const r = (n) => ((Math.sin(seed * 9301 + n * 49297) * 233280) % 1 + 1) % 1;
  const h = Math.floor(r(1) * 360), h2 = (h + 40 + Math.floor(r(2) * 200)) % 360;
  const h3 = (h + 180 + Math.floor(r(5) * 60)) % 360;
  const s1 = 55 + Math.floor(r(3) * 35), l1 = 32 + Math.floor(r(4) * 26);
  const a1 = Math.floor(r(6) * 360), x = 20 + Math.floor(r(7) * 60), y = 20 + Math.floor(r(8) * 60);
  const A = `hsl(${h},${s1}%,${l1}%)`;
  const B = `hsl(${h2},${s1 - 10}%,${l1 + 22}%)`;
  const C = `hsl(${h3},70%,${Math.max(12, l1 - 18)}%)`;
  switch (Math.floor(r(9) * 6)) {
    case 0: return `conic-gradient(from ${a1}deg at ${x}% ${y}%, ${A}, ${B}, ${C}, ${A})`;
    case 1: return `radial-gradient(circle at ${x}% ${y}%, ${B}, ${A} 55%, ${C})`;
    case 2: return `linear-gradient(${a1}deg, ${A}, ${B} 45%, ${C})`;
    case 3: return `repeating-linear-gradient(${a1}deg, ${A} 0 7px, ${C} 7px 14px)`;
    case 4: return `radial-gradient(ellipse at ${x}% 0%, ${B}, transparent 62%), conic-gradient(from ${a1}deg, ${A}, ${C}, ${A})`;
    default: return `linear-gradient(${a1}deg, ${C}, ${A} 30%, ${B} 70%, ${C})`;
  }
}

/**
 * Background for a track's artwork slot: the drawn cover if there is one, and
 * the deterministic gradient if there is not.
 *
 * Every surface goes through here so art stays purely additive — a track with no
 * cover looks exactly as it did before, and a cover appearing mid-session is a
 * one-property change rather than a different code path. `background` shorthand
 * on purpose: it clears any previous gradient when swapping to an image, which
 * `background-image` alone would leave underneath.
 */
function artBg(t, big = false) {
  // The list paints one 44px square per track. Pointing those at the full 1024²
  // covers meant the browser decoding ~81 MB to draw thumbnails, so anything
  // that is not a hero image asks for the 256px copy. `big` is for the song
  // panel and the full-screen player, where it is one image rather than fifty.
  const src = (!big && t && t.thumb) || (t && t.cover);
  if (src) {
    // ?v=<mtime>. Covers are cached for a day, but regenerating rewrites the
    // SAME filename — without this the browser keeps painting the old picture
    // and a full re-render of the library looks like it did nothing at all.
    const v = t.coverV ? `?v=${t.coverV}` : "";
    // SINGLE quotes inside url(), and it matters: this string is interpolated
    // into a double-quoted style="" attribute in rowHtml. Double quotes here
    // close the attribute early, and the browser silently computes
    // `background-image: url("")` — a 44px black square with no error anywhere.
    return `#0a0a0a center / cover no-repeat url('/api/cover/${encodeURIComponent(src)}${v}')`;
  }
  return art((t && t.seed) || 0);
}

/** Relative time, with the absolute stamp on hover — you want "8 minutes ago" at a
 *  glance but the real timestamp when comparing two takes. */
function when(ts) {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}
const stamp = (ts) => (ts ? new Date(ts).toLocaleString() : "");

function renderPlaylists(snap) {
  const sel = $("plSelect");
  const keep = sel.value;
  sel.innerHTML = '<option value="">All tracks</option>' +
    (snap.playlists || []).map((p) => `<option value="${p.id}">${esc(p.name)} (${p.files.length})</option>`).join("");
  sel.value = keep;
  state.playlists = snap.playlists || [];
}

function renderList(snap) {
  // Disk is the source of truth — the library survives restarts and shows anything
  // already in the output folder, not just what this session generated.
  //
  // The websocket pushes job state only, with no `library` field. Falling back to
  // session history there emptied the list on every progress tick and the 4 s poll
  // put it back, which read as flicker while generating. Remember the last real
  // library and reuse it whenever a snapshot does not carry one.
  if (snap.library) {
    state.library = snap.library;
    /* The YuE2 example list is the Library's own rows, so it can only be
     * painted once they are here — and repainted as new songs land. The
     * typeof guards are for server/daw/ui_test.js, which lifts this function
     * out of the file and runs it with only the names it injects. */
    if (typeof yueEngine === "function" && typeof paintExamples === "function" && yueEngine()) paintExamples(true);
  }
  // The trash list rides the same snapshot (websocket job pushes carry
  // neither), remembered for the same reason the library is.
  if (snap.trash) state.trash = snap.trash;
  /* The Video panel's "open on a cover" list is built FROM the library, and
   * setView paints it before the first snapshot has arrived — so opening Video
   * straight after a cold load showed an empty dropdown that never filled in.
   * Repaint whenever the library changes, but only while that view is up. */
  if (state.view === "video" && snap.library) vidPaint();
  // Kept so a purely-local interaction — collapsing a group, changing the
  // grouping mode — can redraw immediately instead of waiting up to four
  // seconds for the next poll to supply a snapshot.
  state.lastSnap = snap;
  let done = state.library?.length
    ? state.library
    : snap.history.filter((j) => j.state === "done" && j.file);

  const plId = $("plSelect").value;
  if (plId) {
    const pl = (snap.playlists || []).find((p) => p.id === plId);
    if (pl) done = done.filter((t) => pl.files.includes(t.file));
  }

  // Search across everything we hold, not just the title. With fifty overnight
  // takes the title is the LEAST distinguishing field — they are all "Untitled
  // take 7". Style and lyrics are what people actually remember.
  const q = ($("libSearch").value || "").trim().toLowerCase();
  if (q) {
    done = done.filter((t) => [t.title, t.caption, t.lyrics, String(t.seed)]
      .some((v) => String(v ?? "").toLowerCase().includes(q)));
  }

  const f = $("libFilter").value;
  /* Trash is a different LIST, not a predicate over the library — the library
   * is by definition what is NOT in the trash, so "filtering" it here showed
   * the whole living library under a Trash heading. Render the real trash and
   * stop; everything below (sorts, pins, groups, queue rows) belongs to the
   * living list. */
  if (f === "trash") {
    $("pinned").hidden = true;
    let tr = state.trash || [];
    if (q) tr = tr.filter((t) => `${t.title} ${t.file}`.toLowerCase().includes(q));
    $("listCount").textContent = tr.length ? `${tr.length} in trash` : "";
    const rowsEl = $("rows");
    rowsEl.classList.remove("grid");
    rowsEl.innerHTML = tr.length ? tr.map(trashRowHtml).join("")
      : `<p class="empty">${q ? "Nothing in the trash matches that." : "The trash is empty."}</p>`;
    pruneSelection(new Set((state.trash || []).map((t) => t.file)));
    state.libVisible = tr.map((t) => t.file);
    paintBatchBar();
    return;
  }
  // Archived songs leave the everyday list; the Archived filter is where they are.
  done = f === "archived" ? done.filter((t) => t.archived) : done.filter((t) => !t.archived);
  pruneSelection(new Set((state.library || done).map((t) => t.file)));
  if (f === "starred") done = done.filter((t) => t.starred);
  else if (f === "pinned") done = done.filter((t) => t.pinned);
  else if (f === "up") done = done.filter((t) => t.rating === 1);
  else if (f === "song") done = done.filter((t) => !t.instrumental);
  else if (f === "instrumental") done = done.filter((t) => t.instrumental);

  done = [...done].sort(LIB_SORTS[$("libSort").value] || LIB_SORTS.new);

  // A counter that also totals the time and the disk — "11 tracks" alone does not
  // tell you whether that is ten minutes or two hours, and FLAC at 44.1 kHz runs
  // ~30 MB per song, so an overnight run of 50 is real disk worth watching.
  const total = done.reduce((s, t) => s + (t.durationSeconds || 0), 0);
  const bytes = done.reduce((s, t) => s + (t.sizeBytes || 0), 0);
  $("listCount").textContent = done.length
    ? `${done.length} track${done.length > 1 ? "s" : ""}${total ? ` · ${fmt(total)}` : ""}${bytes ? ` · ${size(bytes)}` : ""}`
    : "";

  // Pinned float to their own section rather than being sorted to the top of the
  // main list, so "come back to this" survives changing the sort.
  const pins = done.filter((t) => t.pinned);
  // Also gated on the view: this runs on every poll, so without the check it
  // re-showed the pinned strip over Settings and Community seconds after
  // setView had hidden it.
  $("pinned").hidden = !pins.length || Boolean(q) || state.view !== "create";
  if (pins.length) $("pinRows").innerHTML = pins.map(rowHtml).join("");

  const rows = $("rows");
  rows.classList.toggle("grid", state.gridView);
  if (!done.length && !snap.queue.length) {
    rows.innerHTML = `<p class="empty">${q || f
      ? "Nothing matches. Try a different search or filter."
      : "Nothing yet. Write something and hit Create."}</p>`;
    return;
  }
  const queueHtml = snap.queue.map((j, i) => `
      <div class="row"><span class="rsel"></span><div class="art" style="background:${art(j.seed)}"></div>
        <div class="rmeta"><span class="rtitle">${esc(j.title)}</span>
          <span class="rsub">${i + 2} of ${snap.queue.length + 1} in queue${j.preview ? " · preview" : ""}</span></div>
        <div class="rside"><span>~${fmt(j.etaSeconds)}</span></div></div>`).join("");

  // Grouping is suppressed while searching: a search is already a filter across
  // the whole library, and slicing three matches into three separate groups
  // makes them harder to see rather than easier.
  const mode = q ? "" : $("libGroup").value;
  rows.innerHTML = queueHtml + (mode ? groupedHtml(done, mode) : done.map(rowHtml).join(""));
  // A session box half ticked shows as half ticked; HTML has no attribute for it.
  for (const box of rows.querySelectorAll("[data-grpsel][data-some]")) box.indeterminate = true;
  state.libVisible = done.map((t) => t.file);
  paintBatchBar();
}

/**
 * Group the library.
 *
 * SESSION is the default because it matches how the tracks were actually made:
 * somebody sits down, generates a burst, and leaves. Any gap longer than
 * `SESSION_GAP` starts a new one, so the boundaries fall where the person
 * actually stopped rather than on an arbitrary clock division like "today".
 *
 * TITLE is the alternative for the other way people think — every take of one
 * song together, however far apart they were made.
 *
 * Collapsed state lives in `state.collapsed`, a Set keyed by group id, because
 * this function re-runs on every 4-second poll and anything stored in the DOM
 * would be discarded — the same poll-driven-render trap that ate the playing-row
 * highlight and the pinned strip.
 */
const SESSION_GAP = 30 * 60 * 1000;

/* Module-scoped: renderList sorts the flat list with these, and groupsOf
 * re-applies the SAME comparator inside each session — otherwise session
 * grouping (the default view) hard-coded newest-first and the Sort dropdown
 * visibly did nothing. */
const LIB_SORTS = {
  new:   (a, b) => b.createdAt - a.createdAt,
  old:   (a, b) => a.createdAt - b.createdAt,
  long:  (a, b) => (b.durationSeconds || 0) - (a.durationSeconds || 0),
  short: (a, b) => (a.durationSeconds || 0) - (b.durationSeconds || 0),
  title: (a, b) => String(a.title).localeCompare(String(b.title)),
};

function groupsOf(tracks, mode) {
  if (mode === "title") {
    const by = new Map();
    for (const t of tracks) {
      const k = (t.title || "Untitled").trim().toLowerCase();
      if (!by.has(k)) by.set(k, { id: `t:${k}`, label: t.title || "Untitled", items: [] });
      by.get(k).items.push(t);
    }
    return [...by.values()];
  }
  // Session: walk in time order and cut whenever the gap exceeds the threshold.
  // Sorted ascending here regardless of the display sort, or "newest first"
  // would put every track in its own session.
  const byTime = [...tracks].sort((a, b) => a.createdAt - b.createdAt);
  const runs = [];
  for (const t of byTime) {
    const last = runs[runs.length - 1];
    if (last && t.createdAt - last.items[last.items.length - 1].createdAt <= SESSION_GAP) {
      last.items.push(t);
    } else {
      runs.push({ items: [t] });
    }
  }
  // Number sessions per DAY, so the label reads the way someone would say it.
  const perDay = new Map();
  for (const r of runs) {
    const d = new Date(r.items[0].createdAt);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const n = (perDay.get(day) || 0) + 1;
    perDay.set(day, n);
    r.id = `s:${day}#${n}`;
    r.day = day;
    r.label = `${day} · session ${n}`;
    r.when = r.items[0].createdAt;
  }
  /* The Sort dropdown applies INSIDE each session, and to the session order
   * where time is what is being sorted: Oldest lists the sessions oldest
   * first, everything else keeps newest-session-first (the one you just made
   * is the one you want — a duration or title sort says nothing about which
   * SESSION should lead). Before this, groups re-sorted newest-first
   * unconditionally and the dropdown was inert in the default view. */
  const sortKey = $("libSort").value;
  const cmp = LIB_SORTS[sortKey] || LIB_SORTS.new;
  if (sortKey !== "old") runs.reverse();
  return runs.map((r) => ({ ...r, items: [...r.items].sort(cmp) }));
}

/* WHICH GROUPS START OPEN. Sessions from today and yesterday; everything older
 * starts folded, so a long library opens on what was just made rather than on
 * every session at once (and when nothing is that recent, the newest one).
 * A group someone opened or folded by hand stays that way: `state.opened` and
 * `state.collapsed` remember it across the four-second repaint. */
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function groupedHtml(tracks, mode) {
  if (!state.collapsed) state.collapsed = new Set();
  if (!state.opened) state.opened = new Set();
  const groups = groupsOf(tracks, mode);
  const now = new Date(), yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const recent = new Set([dayKey(now), dayKey(yest)]);
  const anyRecent = groups.some((g) => g.day && recent.has(g.day));
  state.grpFiles = new Map(groups.map((g) => [g.id, g.items.map((t) => t.file)]));
  return groups.map((g, i) => {
    const byDefault = mode !== "session" || (anyRecent ? recent.has(g.day) : i === 0);
    const open = state.opened.has(g.id) || (!state.collapsed.has(g.id) && byDefault);
    const secs = g.items.reduce((s, t) => s + (t.durationSeconds || 0), 0);
    const picked = g.items.filter((t) => state.libSel?.has(t.file)).length;
    const all = picked === g.items.length && picked > 0;
    return `
      <div class="grp${open ? " open" : ""}">
        <div class="grphead-row">
        <label class="rsel" title="Select every song in this ${mode === "session" ? "session" : "group"}"><input type="checkbox"
          data-grpsel="${esc(g.id)}"${all ? " checked" : ""}${picked && !all ? ' data-some="1"' : ""}
          aria-label="Select every song in ${esc(g.label)}"></label>
        <button class="grphead" type="button" data-grp="${esc(g.id)}" aria-expanded="${open}">
          <span class="caret">${open ? "▾" : "▸"}</span>
          <span class="glabel">${esc(g.label)}</span>
          <span class="gmeta">${g.items.length} track${g.items.length > 1 ? "s" : ""}${secs ? ` · ${fmt(secs)}` : ""}</span>
        </button>
        </div>
        ${open ? `<div class="grpbody">${g.items.map(rowHtml).join("")}</div>` : ""}
      </div>`;
  }).join("");
}

/**
 * Where this take sits in its family of continuations.
 *
 * Every extension of one song shares a title and a style line, so in the library
 * they are an indistinguishable run of identical rows — you cannot tell the
 * second continuation from the fifth without opening each one. Returning
 * {n, of} lets a row say "extend 2/3" in place of nothing at all.
 *
 * Returns null for a track that is not part of a chain, which is most of them.
 */
function extendIndex(t) {
  if (!t?.extendedFrom) return null;
  const fam = familyOf(t, state.library || []);
  if (fam.length < 2) return null;
  const n = fam.findIndex((x) => x.file === t.file) + 1;
  return n > 0 ? { n, of: fam.length } : null;
}

/* One row, used by both the pinned strip and the main list.
 *
 * `.sel` is applied HERE rather than by play(), because the list re-renders on
 * every poll — setting the class imperatively after clicking meant the highlight
 * vanished within four seconds. With duplicate titles from a batch run, knowing
 * which row is sounding is the whole point. */
/* One word per post-processing kind, for the row badge. Short on purpose — the
 * badge sits inline with the title and a phrase would push the metadata out. */
const STAGE_WORD = { cover: "cover", stems: "stems", lrc: "lyrics", video: "clip" };

/* A trash row: what it was, when it went, and the one action that matters.
 * Restore is the point of the view — a trash you can see but not put back is
 * just a delete with extra steps. The file plays no more tricks than that:
 * restore hands it straight back to the library scan. */
function trashRowHtml(t) {
  const d = t.trashedAt ? new Date(t.trashedAt) : null;
  return `
    <div class="row${state.libSel?.has(t.file) ? " picked" : ""}">
      <label class="rsel" title="Select"><input type="checkbox" data-sel="${encodeURIComponent(t.file)}"${state.libSel?.has(t.file) ? " checked" : ""} aria-label="Select ${esc(t.title)}"></label>
      <div class="art" style="background:linear-gradient(135deg,#444,#222);display:flex;align-items:center;justify-content:center;font-size:18px">🗑</div>
      <div class="rmeta">
        <span class="rtitle">${esc(t.title)}</span>
        <span class="rsub">${d ? `trashed ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "in output/trash"}${t.sizeBytes ? ` · ${size(t.sizeBytes)}` : ""}</span>
      </div>
      <div class="rside">
        <button class="rbtn" data-restore="${encodeURIComponent(t.file)}" title="Move it back into the library">↩ restore</button>
      </div>
    </div>`;
}

function rowHtml(j) {
  const f = encodeURIComponent(j.file);
  const playing = state.playingFile === j.file;
  // Style under the title, the way Suno does it — for a batch of takes it is the
  // only line that distinguishes them at a glance.
  //
  // TRUNCATED IN JS, not just clamped in CSS. A structured caption runs to ~1,400
  // characters, and putting that in the DOM let one row blow the grid out to the
  // full viewport width the moment anything upstream lost its min-width:0. The
  // row only ever needs the opening phrase; the whole thing lives in the panel.
  const cap = String(j.caption || "");
  const sub = cap
    ? esc(cap.length > 120 ? `${cap.slice(0, 120).trimEnd()}…` : cap)
    : `seed ${j.seed}${j.reroll ? " · re-roll" : ""}`;
  return `
    <div class="row${playing ? " playing" : ""}${state.libSel?.has(j.file) ? " picked" : ""}" draggable="true" data-file="${f}" data-seed="${j.seed}" data-title="${esc(j.title)}">
      <label class="rsel" title="Select (shift-click for a range)"><input type="checkbox" data-sel="${f}"${state.libSel?.has(j.file) ? " checked" : ""} aria-label="Select ${esc(j.title)}"></label>
      <div class="art" style="background:${artBg(j)}">${playing ? '<span class="eq"><i></i><i></i><i></i></span>' : ""}</div>
      <div class="rmeta">
        <span class="rtitle" data-info="${f}" title="Lyrics, style and settings">${esc(j.title)}
          <button class="rpen" data-rename="${f}" title="Edit title" aria-label="Edit title">✎</button>
          <span class="ver">${esc(j.model || "int8")}</span>
          ${/* What this file actually IS. Studio can write flac, mp3 or opus
               depending on a setting, so a library can hold all three and the
               rows looked identical -- you had to open the folder to find out. */
            (() => { const x = (j.file.match(/\.([a-z0-9]+)$/i) || [])[1];
              return x ? `<span class="ver fmt" title="File format">${esc(x.toUpperCase())}</span>` : ""; })()}
          ${(() => { const x = extendIndex(j); return x
            ? `<span class="badge ext" title="Continuation ${x.n} of ${x.of} from the same take">↳ ${x.n}/${x.of}</span>` : ""; })()}
          ${j.preview ? '<span class="badge">preview</span>' : ""}
          ${j.instrumental ? '<span class="badge">instrumental</span>' : ""}
          ${musicWarningHtml(j, true)}
          ${/* A track that has a lead sheet says so with a small badge; the
               LINK lives in the row's ⋯ menu (rowMenuHtml), where "Open the
               lead sheet" and "PDF" sit beside Reuse and Extend. It used to be
               an <a class="badge sheet"> — and `.sheet` is the overlay panel's
               class, so the link rendered as a full-width box on every row.
               Both halves are still required: the sheet route resolves a
               version id, so a row that knows its score but not a version
               gets no menu items rather than broken ones. */
            (j.scoreSlug && j.scoreVersion) ? '<span class="badge" title="Has a lead sheet — open it from the ⋯ menu">♪</span>' : ""}
          ${/* What is being made FOR THIS TRACK right now.
               The server has reported art.current.kind for a while and only the
               Settings tab ever read it, so an overnight run gave no clue which
               song was having its stems split or its clip rendered. */
            state.artNow?.file === j.file
              ? `<span class="badge work" title="Running now">${esc(STAGE_WORD[state.artNow.kind] || "working")}…</span>`
              : ""}</span>
        <span class="rsub">${sub}</span>
        <span class="rsub dim" title="${stamp(j.createdAt)}">${when(j.createdAt)} · seed ${j.seed} · ${j.steps || 15} steps${j.renderSeconds ? ` · rendered in ${fmt(j.renderSeconds)}` : ""}</span>
      </div>
      <div class="rside">
        <span class="dur">${j.durationSeconds ? fmt(j.durationSeconds) : "—"}</span>
        <button class="rbtn ic${j.starred ? " on" : ""}" data-flag="starred" data-f="${f}" title="Favourite">${j.starred ? "★" : "☆"}</button>
        <button class="rbtn ic${j.pinned ? " on" : ""}" data-flag="pinned" data-f="${f}" title="Pin to revisit">📌</button>
        <button class="rbtn ic" data-menu="${f}" title="More actions" aria-haspopup="menu">⋯</button>
      </div></div>`;
}

/* ── row overflow menu ────────────────────────────────────
 *
 * Ten buttons per row was most of the row's width, and eight of them are things
 * you do ONCE to a track rather than while listening. Star and pin stay out —
 * they are the two judgments made in passing, and they carry state worth seeing
 * at a glance. Everything else moves in here.
 *
 * ⓘ was dropped rather than moved: clicking the row TITLE already opens the same
 * panel, so it was a second button for a thing that already had one.
 *
 * ONE menu element on <body>, not one per row. `renderList` re-runs every four
 * seconds and would otherwise destroy the open menu mid-click — the same
 * poll-driven-render trap that ate the playing-row highlight. It also carries the
 * SAME data-* attributes the rows use, so the existing delegated handler runs it
 * unchanged; the only new wiring is attaching that handler here too.
 */
/**
 * NO EMOJI, deliberately.
 *
 * The first version prefixed every item with one and the menu read as ragged:
 * emoji have inconsistent advance widths across fonts so the labels could never
 * line up, they render full-colour inside a UI that is otherwise monochrome plus
 * one cyan, two of them (a fader and a clock) did not read as their action at
 * all, and one item had no icon — which left the text column visibly uneven.
 *
 * Plain labels in one column, current state right-aligned in another, and a
 * divider before the destructive item. That is what a desktop menu looks like.
 */
function rowMenuHtml(t) {
  const f = encodeURIComponent(t.file);
  const fam = t.extendedFrom ? familyOf(t, state.library || []) : [];
  const pct = t.lrcConfidence != null ? `${Math.round(t.lrcConfidence * 100)}%` : "";
  const items = [
    // Offered right here rather than only in the song panel: by the time you are
    // looking at a run of continuations in the list, merging them is the thing
    // you want, and a trip through the panel is friction.
    ...(fam.length >= 2
      ? [["data-merge", f, "Merge continuations", String(fam.length),
          "Combine them into one song, keeping the shared opening once"]]
      : []),
    ["data-reroll", f, "Re-roll mix", "", "Same performance, new render — about 60% of a full one"],
    ["data-reuse", f, "Reuse prompt", "", "Load this track's words and settings into the form"],
    ["data-rate", "1", t.rating === 1 ? "Remove like" : "Like", t.rating === 1 ? "✓" : "", "Rate this take", f],
    ["data-stems", f, "Separate stems", t.stems?.length ? `✓ ${t.stems.length}` : "",
      t.stems?.length ? "Already separated — runs again if you pick this" : "Drums, bass, vocals and other, once the engine is idle"],
    ["data-lrc", f, "Time the lyrics", t.lrc ? `✓ ${pct}` : "",
      t.lrc ? `${pct} of words timed by measurement, the rest interpolated`
            : "Write .lrc files (per line and per word) for visualisers"],
    /* Hidden entirely unless the H3 weights are enabled. A menu item that
     * always 400s teaches people to distrust the menu, and this one is 34 GB
     * and region-locked — it should not advertise itself on a machine that
     * cannot run it. */
    /* ALWAYS listed.
     *
     * This used to be hidden unless video was already switched on — which, since
     * it defaults to off, meant a machine with 34 GB of H3 weights sitting on it
     * had no way to make a video and nothing anywhere saying why. Hiding a
     * feature is not the same as explaining it.
     *
     * Off: the item says so and clicking offers to switch it on. Weights absent:
     * the server answers with a message that names the Models screen. */
    ["data-clip", f, "Make a video clip",
      t.clip ? "✓" : (state.video?.enabled ? "" : "off"),
      t.clip ? "Already has a clip — runs again if you pick this"
        : state.video?.enabled
          ? `${state.video.seconds || 2}s of video, once the engine is idle`
          : "Video is switched off in Settings — this will offer to turn it on"],
    /* Convert to another container. Encoded by ComfyUI, which already writes
     * these formats -- not by shelling out to ffmpeg, which this app
     * deliberately never does.
     *
     * The format the track ALREADY is gets no entry: "Save as FLAC" on a FLAC
     * is a button whose only possible outcome is an error.
     *
     * ⚠ No WAV. `SaveAudioAdvanced` accepts `format: "wav"` at validation and
     * then fails at execution with the argument dropped, while the same node
     * takes "flac" happily -- so the option does not exist and a button for it
     * would spin and produce nothing. */
    ...(["mp3", "opus", "flac"]
      .filter((x) => !new RegExp(`\.${x}$`, "i").test(t.file))
      .map((x) => ["data-export", x, `Save as ${x.toUpperCase()}`, "",
        x === "flac"
          ? "Lossless, and larger than the original"
          : `Smaller, and lossy — ${/\.flac$/i.test(t.file) ? "the original is lossless" : "converting again loses a little more"}`,
        f])),
    /* Extend and Replace section, where Suno keeps them too — only on takes
     * that kept their performance (a MiniMax trajectory or a YuE2 run). */
    ...((t.codes || t.yueDir || state.tokenizerReady) && t.durationSeconds ? [
      ["data-extend", f, "Extend", "", "Continue the song from a point you choose; the original is kept"],
      ["data-replace", f, "Replace section", "", "Write a stretch between two points again; the original returns after it"],
    ] : []),
    ["data-edit", f, "Edit audio", "", "Trim, cut, fade, reverse, speed"],
    ["data-addpl", f, "Add to playlist", "", "Add to a playlist"],
    ["data-reveal", f, "Show in Explorer", "", "The file already exists on disk"],
    ["data-trash", f, "Move to trash", "", "Reversible — it moves to output/trash"],
  ];
  /* The lead sheet, when the track has one: the engraved page and the PDF
   * beside it, as plain links — the menu's click handler dispatches on
   * data-* attributes and leaves an <a> to the browser. Both halves of the
   * address are required (the sheet route resolves a version id). This is
   * where the ♪ badge on the row points. */
  const sheet = (t.scoreSlug && t.scoreVersion)
    ? `<a class="rmitem" href="/api/score/sheet/${esc(t.scoreSlug)}/${esc(t.scoreVersion)}.html" target="_blank" rel="noopener"
         title="The lead sheet the model wrote before the audio — the plan, not a transcription"><span>Open the lead sheet</span><em>♪</em></a>`
      + `<a class="rmitem" href="/api/score/sheet/${esc(t.scoreSlug)}/${esc(t.scoreVersion)}.pdf" target="_blank" rel="noopener"
         title="The same sheet as a PDF, if this machine could print it"><span>Sheet as PDF</span></a>`
    : "";
  return sheet + items
    .filter(([attr]) => attr !== "data-addpl" || state.playlists?.length)
    .map(([attr, val, label, meta, title, extraF]) =>
      `<button class="rmitem${attr === "data-trash" ? " warn sep" : ""}" ${attr}="${val}"${
        extraF ? ` data-f="${extraF}"` : ""} title="${esc(title)}"
        ><span>${esc(label)}</span>${meta ? `<em>${esc(meta)}</em>` : ""}</button>`)
    .join("");
}

function closeRowMenu() {
  const m = $("rowMenu");
  if (m && !m.hidden) { m.hidden = true; state.rowMenuFile = null; }
}

function openRowMenu(file, anchor) {
  const t = (state.library || []).find((x) => x.file === file);
  if (!t) return;
  const m = $("rowMenu");
  m.innerHTML = rowMenuHtml(t);
  m.hidden = false;
  state.rowMenuFile = file;
  // Position after unhiding, so the measured height is real. Flip above the
  // button when there is not room below — at the bottom of a 50-row library that
  // is most of the time.
  const r = anchor.getBoundingClientRect();
  const h = m.offsetHeight, w = m.offsetWidth;
  const top = r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6;
  m.style.top = `${top}px`;
  m.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
}

/* ── community — advertising, not the draw ────────────── */
/* Hidden entirely when the feed is empty. "0 sessions live" advertises exactly
 * the wrong thing for a community that is still small. */

/* The feed sends a pre-formatted "2291h 54m in", which is a real value — a dev
 * test session left marked live for 95 days — but reads as a broken clock. Roll
 * anything past a day up into days so the label degrades gracefully instead. */
function elapsed(label) {
  const m = /^(?:(\d+)h\s*)?(?:(\d+)m)?/.exec(String(label || ""));
  const mins = (Number(m?.[1]) || 0) * 60 + (Number(m?.[2]) || 0);
  if (!mins) return label || "";
  if (mins < 60) return `${mins}m in`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ${mins % 60}m in`;
  const d = Math.floor(mins / (24 * 60));
  return d < 7 ? `${d}d in` : "running a while";
}

async function loadCommunity() {
  let feed = null;
  try {
    const r = await fetch("/api/community", { signal: AbortSignal.timeout(4000) });
    if (r.ok) feed = await r.json();
  } catch { /* offline or endpoint not built yet */ }

  /* Rooms you can walk into now, and rooms starting soon: counted apart. The
   * upcoming ones used to be added in, so the app said "9 rooms live" with one
   * open. */
  const live = (feed?.sessions || []).length;
  const soon = (feed?.parties || []).length;
  state.commLive = live;
  $("commPip").hidden = !live;

  // The condensed banner, shown on the working views only. Leads with the
  // challenge if there is one, because that is the item that gives someone a
  // reason to make something today.
  const chal = (feed?.sessions || []).find((s) => s.isChallenge);
  // One predicate, called from here AND from setView. This used to hold its own
  // opinion, and because it re-runs on a 120-second timer it would quietly undo
  // whatever setView had decided a couple of minutes earlier.
  paintComm();
  if (live) {
    $("commBarText").innerHTML = chal
      ? `Challenge: <b>${esc(chal.title)}</b>`
      : `<b>${live}</b> ${live === 1 ? "room" : "rooms"} live on AI PLAY`;
    $("commBar").title = chal ? `${chal.title}: submit a track on AI PLAY` : "Open AI PLAY";
  }
  /* Style packs live on the Welcome page now ("or Start from a template"),
   * filled whatever tab is open: they do not expire, and Welcome is where
   * someone starts. */
  const packs = feed?.stylePacks || [];
  state.packs = packs;
  $("homeOr").hidden = $("homePackBtn").hidden = !packs.length;
  if (!packs.length) $("homePacks").hidden = true;
  $("homePacks").innerHTML = packs.map((p, i) => `
    <div class="card pack" data-pack="${i}" role="button" tabindex="0">
      <h3>${esc(p.name)}</h3>
      <div class="packchips">${(p.chips || []).map((c) => `<span class="tag">${esc(c)}</span>`).join("")}</div>
      <div class="foot"><span>${(p.chips || []).length} tags</span><span class="use">Use this →</span></div>
    </div>`).join("");

  // Visibility is paintComm's job; from here down we only fill the pane. Skip
  // the work when it is not on screen — the refresh timer runs regardless of
  // which tab is open.
  if (!["community", "radio", "blog"].includes(state.view)) return;

  /* Blog posts. The one section on this page that works regardless of the
   * desktop feed, so it is also the answer to "why is this tab empty". Opens in
   * the browser rather than in-app: these are articles, and Studio is not a
   * reader. */
  // `blogPosts`, not `posts` — this function already has a `posts` further down
  // (the feed's own social posts) and shadowing it silently killed all of app.js.
  const blogPosts = feed?.articles || [];
  const blogSite = (state.site || "https://aiplay.live").replace(/\/+$/, "");
  $("blogEmpty").hidden = blogPosts.length > 0;
  $("commBlog").innerHTML = blogPosts.map((a) => `
    <a class="blogcard" href="${esc(blogSite)}/blog/${encodeURIComponent(a.slug)}"
       target="_blank" rel="noopener">
      ${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy">`
                : '<span class="blognoimg"></span>'}
      <span class="blogbody">
        <b>${esc(a.title)}</b>
        <span class="blogex">${esc(a.excerpt || "")}</span>
        <span class="blogmeta">${esc(a.category || "")}${
          a.likes ? ` · ${a.likes} like${a.likes === 1 ? "" : "s"}` : ""}</span>
      </span>
    </a>`).join("");

  /* The rest of the feed.
   *
   * Every block hides itself when its array is empty, so a quiet day degrades to
   * a shorter page rather than a row of empty headings — the same rule the live
   * sessions block already followed.
   *
   * ⚠ Every string here is UNTRUSTED: sessions, posts and especially the Discord
   * list are user-submitted (one row in that table has a URL pasted into its name
   * field). esc() on all of them, and links open with noopener. */
  const stations = feed?.stations || [];
  $("radioEmpty").hidden = stations.length > 0;
  $("commRadio").innerHTML = stations.map((s) => `
    <div class="card">
      ${s.art ? `<div class="cardart"><img class="blur" src="${esc(s.art)}" alt="" aria-hidden="true" loading="lazy" referrerpolicy="no-referrer"><img class="fit" src="${esc(s.art)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>` : `<div class="cardart none"></div>`}
      <div class="cardtop">${s.live ? '<span class="livepip"></span><span class="lab">Live</span>' : '<span class="lab soon">Offline</span>'}
        ${s.viewers ? `<span class="when">${s.viewers} watching</span>` : ""}</div>
      <h3>${esc(s.name)}</h3>
      ${s.blurb ? `<p class="by">${esc(s.blurb.slice(0, 90))}</p>` : ""}
      <div class="foot"><span>${s.number != null ? `channel ${s.number}` : ""}</span>
        <button class="join" data-url="${esc(s.url)}">Watch ↗</button></div>
    </div>`).join("");

  const tracks = feed?.tracks || [];
  $("commTracksHead").hidden = !tracks.length;
  $("commTracks").innerHTML = tracks.map((t) => `
    <a class="tk" href="#" data-url="${esc(t.url)}" title="${esc(t.title)} — ${esc(t.artist)}">
      <span class="tkart"><img src="${esc(t.art)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>
      <span class="tkt">${esc(t.title)}</span>
      <span class="tka">${esc(t.artist)}</span>
    </a>`).join("");

  const posts = feed?.posts || [];
  $("commPostsHead").hidden = !posts.length;
  $("commPosts").innerHTML = posts.map((p) => `
    <div class="card">
      ${p.image ? `<div class="cardart"><img src="${esc(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>` : ""}
      <p class="by">${esc(p.excerpt)}</p>
      <div class="foot"><span>${p.at ? esc(when(new Date(p.at).getTime())) : ""}</span>
        <button class="join" data-url="${esc(p.url)}">Read ↗</button></div>
    </div>`).join("");

  const discords = feed?.discords || [];
  // Ours in the header, so the one room we actually run is reachable without
  // scrolling past twenty-four other people's.
  const main = discords.find((d) => d.primary);
  $("commDiscordTop").hidden = !main;
  if (main) {
    $("commDiscordTop").onclick = () => window.open(main.url, "_blank", "noopener");
    $("commDiscordTop").title = main.blurb || main.name;
  }
  $("commDiscordHead").hidden = !discords.length;
  $("commDiscord").innerHTML = discords.map((d) => `
    <div class="dc${d.primary ? " main" : ""}">
      <span class="dcn">${esc(d.name)}${d.primary ? '<span class="badge">ours</span>' : ""}</span>
      <span class="dcb">${esc(d.blurb)}</span>
      <span class="dcm">${d.members ? `${d.members.toLocaleString()} members` : ""}${
        d.online ? ` · ${d.online.toLocaleString()} online` : ""}</span>
      <button class="join" data-url="${esc(d.url)}">Join ↗</button>
    </div>`).join("");

  // One handler for every "open this in the real browser" button on the tab.
  for (const id of ["commRadio", "commTracks", "commPosts", "commDiscord", "commSoon"]) {
    $(id).onclick = (e) => {
      const b = e.target.closest("[data-url]");
      if (!b) return;
      e.preventDefault();
      window.open(b.dataset.url, "_blank", "noopener");
    };
  }

  /* ⚠ `blogPosts` was missing from this test, and that is the SHIPPED state.
   *
   * Production serves the blog but has no desktop feed, so today every install
   * shows six real blog cards with "not reachable" sitting on top of them. The
   * panel means "there is nothing here"; anything that fills the pane has to
   * count towards it. */
  $("commEmpty").hidden = live > 0 || soon > 0 || discords.length > 0;
  $("commLiveHead").hidden = !live;
  $("commCount").textContent = "";
  /* Who is on right now, from what the feed really reports: the AI Play
   * Discord's own online count and the rooms that are live. The site sends no
   * head count of its own, so none is made up. */
  const on = [];
  if (main?.online) on.push(`<b>${main.online.toLocaleString()}</b> online in the Discord`);
  if (live) on.push(`<b>${live}</b> ${live === 1 ? "room" : "rooms"} live`);
  if (soon) on.push(`<b>${soon}</b> starting soon`);
  $("commOnline").hidden = !on.length && !(!feed || feed.offline);
  $("commOnline").innerHTML = on.length ? `<i class="livepip"></i>${on.join(" · ")}` : "aiplay.live is not reachable right now";
  paintSoon(feed);
  if (!live) { $("commGrid").innerHTML = ""; $("commNote").textContent = ""; return; }

  // Challenges first and marked. They are the only item that answers "what
  // should I make right now", which is the whole reason to look at this pane.
  const all = feed.sessions || [];
  const ordered = [...all.filter((s) => s.isChallenge), ...all.filter((s) => !s.isChallenge)];
  $("commGrid").innerHTML = [
    ...ordered.map((s) => `
      <div class="card live${s.isChallenge ? " chal" : ""}">
        ${s.art ? `<div class="cardart"><img class="blur" src="${esc(s.art)}" alt="" aria-hidden="true" loading="lazy" referrerpolicy="no-referrer"><img class="fit" src="${esc(s.art)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>` : `<div class="cardart none"></div>`}
        <div class="cardtop"><span class="livepip"></span><span class="lab">${s.isChallenge ? "Challenge" : "Live"}</span><span class="when">${esc(elapsed(s.startedAgo))}</span></div>
        <h3>${esc(s.title)}</h3><p class="by">hosted by ${esc(s.host)}</p>
        <div class="foot"><span>${
          /* ⚠ Three states, not two. The feed does not currently SEND
           * `submissionsOpen` at all, and `undefined` is not `false` — reading
           * it as false made every card claim "submissions closed", which is a
           * statement about the session rather than about our own ignorance.
           * When the field is absent, say nothing about it. */
          s.submissionsOpen === undefined
            ? (Number.isFinite(s.slotsFree) ? `${s.slotsFree} slots free` : "")
            : s.submissionsOpen
              ? (s.slotsPerUser ? `${s.slotsPerUser} songs each` : "submissions open")
              : "submissions closed"
        }</span>
          ${/* Watch and Join answer different questions: one is "let me listen from
                here", the other is "let me take part". Only shown when the operator
                actually set a stream URL — a dead button is worse than none. */
            s.streamUrl ? `<button class="join watch" data-url="${esc(s.streamUrl)}">Watch ↗</button>` : ""}
          <button class="join" data-url="${esc(s.url)}">Join ↗</button></div></div>`),
  ].join("");

  // Everything opens in the real browser, where the user is already signed in.
  $("commGrid").querySelectorAll(".join").forEach((b) => {
    b.onclick = () => window.open(b.dataset.url, "_blank", "noopener");
  });
  // Name the host we will actually open, rather than always claiming aiplay.live
  // while pointing at dev.
  const host = state.site ? state.site.replace(/^https?:\/\//, "") : "aiplay.live";
  $("commNote").textContent = `Opens on ${host} in your browser, where you are already signed in.`;
}
/* Upcoming, within 24 hours only.
 * Its own block rather than mixed into "Happening now" — a room that has not
 * started yet is a different proposition from one you can walk into, and
 * merging them makes the live count a lie. Painted whether or not anything is
 * live: it used to sit after the "nothing live" return and never showed then. */
function paintSoon(feed) {
  const parties = feed?.parties || [];
  $("commSoonHead").hidden = !parties.length;
  $("commSoon").innerHTML = parties.map((p) => `
    <div class="card">
      ${p.art ? `<div class="cardart"><img class="blur" src="${esc(p.art)}" alt="" aria-hidden="true" loading="lazy" referrerpolicy="no-referrer"><img class="fit" src="${esc(p.art)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>` : `<div class="cardart none"></div>`}
      <div class="cardtop"><span class="lab soon">Soon</span><span class="when">${esc(p.startsIn || "")}</span></div>
      <h3>${esc(p.title)}</h3><p class="by">hosted by ${esc(p.host)}</p>
      <div class="foot"><span>${p.going ? `${p.going} going` : ""}</span>
        ${p.streamUrl ? `<button class="join watch" data-url="${esc(p.streamUrl)}">Watch ↗</button>` : ""}
        <button class="join" data-url="${esc(p.url)}">Open ↗</button></div></div>`).join("");
}
/* A pack fills the form and takes you to Create.
 *
 * Deliberately NOT a link to the website. Everything else on this tab sends the
 * user away to listen; a style pack is the one item that gives them something to
 * make, so it should land in the editor with the fields already filled. */
/* Shown, not just filled: the Styles box lights up for a moment, the style
 * types itself in letter by letter, then Create lights up. Create is never
 * pressed for you. A key, a click in the box or another pack finishes it at
 * once; with reduced motion on it fills in one go. */
let packTurn = 0;
/* THE VEIL. Everything but `keep` goes dark and a little blurry: every sibling
 * of each of its ancestors up to the page, so `keep` itself stays sharp. One
 * veil at a time: moving it to another element only changes what differs, so
 * it stays up from the Styles box to Create; `veilOnly(null)` lifts it. It
 * fades in and out at the same slow pace (the "unveiling" class carries the
 * fade out, since a class that is removed takes its transition with it). */
let veilSet = new Set();
function veilOnly(keep) {
  const want = new Set();
  for (let el = keep; el && el !== document.body; el = el.parentElement) {
    for (const sib of el.parentElement?.children || []) {
      if (sib !== el && !/^(SCRIPT|STYLE|LINK)$/.test(sib.tagName)) want.add(sib);
    }
  }
  for (const x of veilSet) {
    if (want.has(x)) continue;
    x.classList.remove("veiled");
    x.classList.add("unveiling");
    setTimeout(() => x.classList.remove("unveiling"), 950);
  }
  for (const x of want) { x.classList.remove("unveiling"); x.classList.add("veiled"); }
  veilSet = want;
}
async function usePack(i) {
  const p = (state.packs || [])[i];
  if (!p) return;
  const turn = ++packTurn;
  const text = (p.chips || []).join(", ");
  const cap = $("caption"), box = $("stylesBox"), go = $("btnCreate");
  /* The pack's name as the title, unless you wrote one (another pack's name
   * is not yours, so it is replaced). */
  const t = $("title").value.trim();
  if (!t || (state.packs || []).some((x) => x.name === t)) $("title").value = p.name;
  setView("create");
  if (state.simple) await setSimple(false, true);   // Create and the Styles box live in Advanced
  box.open = true;
  for (const el of [box, go]) el.classList.remove("spot");
  const still = () => turn === packTurn;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let skip = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const stop = () => { skip = true; };
  cap.addEventListener("keydown", stop, { once: true });
  cap.addEventListener("pointerdown", stop, { once: true });
  box.scrollIntoView({ block: "center", behavior: skip ? "auto" : "smooth" });
  cap.value = "";
  /* 1. The Styles box pops up and glows; the rest of the page dims. */
  box.classList.add("spot");
  veilOnly(box);
  if (!skip) await wait(2500);
  if (!still()) return;
  /* 2. The style types itself in: about two seconds, however long it is. */
  const step = Math.max(12, Math.min(45, 2000 / Math.max(1, text.length)));
  for (let n = 1; n <= text.length && !skip; n++) {
    cap.value = text.slice(0, n);
    await wait(step);
    if (!still()) return;
  }
  cap.value = text;
  cap.dispatchEvent(new Event("input", { bubbles: true }));
  cap.removeEventListener("keydown", stop);
  cap.removeEventListener("pointerdown", stop);
  /* 3. The same dim, now around Create, which pops up and glows. Pressing it
   * stays yours; the veil lifts when you do, or after four seconds. */
  box.classList.remove("spot");
  go.classList.add("spot");
  veilOnly(go);
  go.scrollIntoView({ block: "nearest", behavior: skip ? "auto" : "smooth" });
  const off = () => {
    go.removeEventListener("click", off);
    if (!still()) return;
    go.classList.remove("spot");
    veilOnly(null);
  };
  go.addEventListener("click", off);
  await wait(4000);
  off();
}
$("homePackBtn").onclick = () => {
  const open = $("homePacks").hidden;
  $("homePacks").hidden = !open;
  $("homePackBtn").setAttribute("aria-expanded", String(open));
};
$("homePacks").addEventListener("click", (e) => {
  const c = e.target.closest("[data-pack]");
  if (c) usePack(Number(c.dataset.pack));
});
$("homePacks").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const c = e.target.closest("[data-pack]");
  if (c) { e.preventDefault(); usePack(Number(c.dataset.pack)); }
});

$("commOpen").onclick = () => window.open(state.siteSessions || "https://aiplay.live/sessions", "_blank", "noopener");
$("commRefresh").onclick = () => loadCommunity();
$("commBar").onclick = () => { setView("community"); loadCommunity(); };

async function onRowClick(e) {
  // The overflow toggle comes first: it is the only action that opens UI rather
  // than doing something to the track.
  const mn = e.target.closest("[data-menu]");
  if (mn) {
    const file = decodeURIComponent(mn.dataset.menu);
    if (state.rowMenuFile === file) closeRowMenu();
    else openRowMenu(file, mn);
    return;
  }
  // Any other action inside the menu dismisses it before running.
  if (e.target.closest("#rowMenu")) closeRowMenu();

  const rr = e.target.closest("[data-reroll]");
  if (rr) { rerollMix(decodeURIComponent(rr.dataset.reroll)); return; }
  const xe = e.target.closest("[data-extend]");
  if (xe) { startExtend(decodeURIComponent(xe.dataset.extend), "extend"); return; }
  const xr = e.target.closest("[data-replace]");
  if (xr) { startExtend(decodeURIComponent(xr.dataset.replace), "replace"); return; }
  // Generated locally — the file already exists on disk, so "download" would just
  // duplicate it. Reveal the real one instead.
  const rev = e.target.closest("[data-reveal]");
  if (rev) { fetch("/api/reveal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: decodeURIComponent(rev.dataset.reveal) }) }); return; }

  const st = e.target.closest("[data-stems]");
  if (st) {
    fetch("/api/stems", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "run", file: decodeURIComponent(st.dataset.stems) }),
    }).then(poll);
    return;
  }

  // The only way to ask for a clip. /api/video action=run existed with nothing
  // calling it, so clips could be produced by curl and by nothing else.
  const cl = e.target.closest("[data-clip]");
  if (cl) {
    const file = decodeURIComponent(cl.dataset.clip);
    (async () => {
      // Switching it on is one confirm rather than a trip to Settings and back.
      if (!state.video?.enabled) {
        if (!(await appConfirm(`Video clips are switched off.${await videoEngineFacts()} `
          + "Switch it on and make a clip?"))) return;
        const on = await (await fetch("/api/video", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "enable", value: true }),
        })).json();
        if (on.error) { alert(on.error); return; }
        state.video = { ...(state.video || {}), ...(on.video || {}) };
        $("qVideo").value = "1";
        $("qVideoWhen").disabled = false;
      }
      const r = await (await fetch("/api/video", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run", file }),
      })).json();
      if (r.error) alert(r.error);
      poll();
    })();
    return;
  }

  /* Rename. Checked BEFORE data-info, because the pencil lives inside the title
   * span and would otherwise open the song panel instead. */
  const pen = e.target.closest("[data-rename]");
  if (pen) {
    e.stopPropagation();
    const file = decodeURIComponent(pen.dataset.rename);
    const cur = (state.library || []).find((x) => x.file === file);
    const next = (await appPrompt("Title for this track:", cur?.title || ""));
    if (next !== null) trackAction({ action: "rename", file, title: next });
    return;
  }

  const mg = e.target.closest("[data-merge]");
  if (mg) {
    const t = (state.library || []).find((x) => x.file === decodeURIComponent(mg.dataset.merge));
    const files = familyOf(t, state.library || []).map((x) => x.file);
    if (files.length >= 2) {
      fetch("/api/merge", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      }).then((r) => r.json()).then((r) => {
        if (r.error) alert(r.error); else openSong(r.file);
      }).then(poll);
    }
    return;
  }

  const lr = e.target.closest("[data-lrc]");
  if (lr) {
    fetch("/api/lyrics", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "run", file: decodeURIComponent(lr.dataset.lrc) }),
    }).then((r) => r.json()).then((r) => { if (r.error) alert(r.error); }).then(poll);
    return;
  }

  const ed = e.target.closest("[data-edit]");
  if (ed) { openEditor(decodeURIComponent(ed.dataset.edit)); return; }

  const ap = e.target.closest("[data-addpl]");
  if (ap) {
    const file = decodeURIComponent(ap.dataset.addpl);
    const names = state.playlists.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
    const pick = (await appPrompt(`Add to which playlist?\n\n${names}`, "1"));
    const pl = state.playlists[Number(pick) - 1];
    if (pl) fetch("/api/playlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "toggle", id: pl.id, file }) }).then(poll);
    return;
  }

  const fl = e.target.closest("[data-flag]");
  if (fl) {
    const on = !fl.classList.contains("on");
    fl.classList.toggle("on", on);   // optimistic, so the click feels instant
    trackAction({ action: "flag", file: decodeURIComponent(fl.dataset.f), flag: fl.dataset.flag, value: on });
    return;
  }
  const rt = e.target.closest("[data-rate]");
  if (rt) {
    const on = !rt.classList.contains("on");
    rt.classList.toggle("on", on);
    trackAction({ action: "flag", file: decodeURIComponent(rt.dataset.f), flag: "rating", value: on ? 1 : 0 });
    return;
  }
  const tr = e.target.closest("[data-trash]");
  if (tr) { trackAction({ action: "trash", file: decodeURIComponent(tr.dataset.trash) }); return; }

  const rs = e.target.closest("[data-restore]");
  if (rs) { trackAction({ action: "restore", file: decodeURIComponent(rs.dataset.restore) }); return; }

  const inf = e.target.closest("[data-info]");
  if (inf) { openSong(decodeURIComponent(inf.dataset.info)); return; }

  const ex = e.target.closest("[data-export]");
  if (ex) {
    const fmt = ex.dataset.export;
    const file = decodeURIComponent(ex.dataset.f);
    const label = ex.querySelector("span");
    const was = label.textContent;
    label.textContent = `Converting to ${fmt.toUpperCase()}…`;
    ex.disabled = true;
    fetch("/api/export", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file, format: fmt }) })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        /* SHOW where it went, rather than say it. The converted file lands in
         * a subfolder of the output directory, not in the library list, and
         * an alert naming a folder still leaves you to go and find it. The
         * reveal route already selects a file in Explorer for the row menu's
         * "Show in Explorer"; it joins a name under the output directory, so
         * the subfolder travels in the name (no "..", not absolute — its two
         * refusals). Best effort: a failed reveal keeps the note. */
        const rel = `${d.subfolder ? d.subfolder + "/" : ""}${d.file}`;
        $("ctaNote").textContent = `Saved ${d.file} in ${d.subfolder || "output"} — opening the folder.`;
        fetch("/api/reveal", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: rel }) })
          .then((r) => r.json())
          .then((v) => { if (v.error) $("ctaNote").textContent = `Saved ${d.file} in ${d.subfolder || "output"} (${v.error}).`; })
          .catch(() => {});
      })
      .catch((err) => alert(err.message))
      .finally(() => { label.textContent = was; ex.disabled = false; });
    return;
  }

  const ru = e.target.closest("[data-reuse]");
  if (ru) { reusePrompt(decodeURIComponent(ru.dataset.reuse)); return; }

  const row = e.target.closest("[data-file]");
  if (row) {
    /* Clicking the artwork of the row that is already playing STOPS it.
     * Starting a track was a click and stopping it meant travelling to the
     * player at the bottom of the window, which is a long way to go to undo the
     * thing you just did. Only the artwork does this -- the rest of the row
     * still means "play", so nothing that used to start a track now silently
     * stops one. */
    const onArt = !!e.target.closest(".art");
    const isPlaying = decodeURIComponent(row.dataset.file) === state.playingFile && !audio.paused;
    /* No repaint: the row highlight means "this is the loaded track", not
     * "sound is coming out", so it correctly stays while paused. An earlier
     * version called paintRows() here, which does not exist -- `?.()` would
     * have swallowed that forever. */
    /* Suno's way (2026-09-16): a click anywhere on the row opens the details
     * panel; the artwork is the play/stop button and opens the panel too. */
    if (!onArt && e.target.closest("button, a, input, select, textarea, label")) return;
    if (onArt) {
      if (isPlaying) { audio.pause(); $("pPlay").textContent = "▶"; }
      else play(row.dataset.file, row.dataset.title, row.dataset.seed);
    }
    openSong(decodeURIComponent(row.dataset.file));
  }
}
// Pinned rows are the same markup, so they share the handler rather than
// duplicating it.
/* Collapse/expand a group.
 *
 * Registered BEFORE onRowClick on the same element, and it returns early rather
 * than falling through, so a click on a group header never also reaches a row
 * action underneath it. */
$("rows").addEventListener("click", (e) => {
  const h = e.target.closest("[data-grp]");
  if (!h) return;
  e.stopPropagation();
  if (!state.collapsed) state.collapsed = new Set();
  if (!state.opened) state.opened = new Set();
  const id = h.dataset.grp;
  if (h.getAttribute("aria-expanded") === "true") { state.collapsed.add(id); state.opened.delete(id); }
  else { state.opened.add(id); state.collapsed.delete(id); }
  renderList(state.lastSnap || { queue: [], history: [], library: state.library });
});
$("libGroup").onchange = () => {
  // Collapsed ids are mode-specific ("s:..." vs "t:..."), so switching mode
  // starts from each mode's defaults rather than half-collapsing the new grouping.
  state.collapsed = new Set();
  state.opened = new Set();
  renderList(state.lastSnap || { queue: [], history: [], library: state.library });
};

$("rows").addEventListener("click", onRowClick);
$("pinRows").addEventListener("click", onRowClick);
// The floating menu carries the same data-* attributes, so it reuses the whole
// handler rather than duplicating seven actions.
$("rowMenu").addEventListener("click", onRowClick);
// Dismissal. Scroll is included because the menu is positioned in viewport
// coordinates against a row that moves underneath it.
document.addEventListener("click", (e) => {
  if (!e.target.closest("#rowMenu") && !e.target.closest("[data-menu]")) closeRowMenu();
}, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeRowMenu(); });
window.addEventListener("scroll", closeRowMenu, true);

/* ── selecting songs, and acting on several at once ─────────────────────
 * `state.libSel` is a Set of file names that survives the four-second repaint
 * (the rows are rebuilt from it). The bar under the search row acts on it with
 * one request per action (/api/track action "batch"), not one per song. */
function pruneSelection(universe) {
  if (!state.libSel) state.libSel = new Set();
  for (const f of state.libSel) if (!universe.has(f)) state.libSel.delete(f);
}
function paintBatchBar() {
  const bar = $("batchBar");
  if (!bar) return;
  if (!state.libSel) state.libSel = new Set();
  const n = state.libSel.size, trash = $("libFilter").value === "trash", archived = $("libFilter").value === "archived";
  bar.classList.toggle("on", n > 0);
  $("batchCount").textContent = n ? `${n} selected` : "Tick songs to act on several at once";
  const lib = new Map((state.library || []).map((t) => [t.file, t]));
  const sel = [...state.libSel].map((f) => lib.get(f)).filter(Boolean);
  const every = (k) => sel.length > 0 && sel.every((t) => t[k]);
  for (const b of bar.querySelectorAll("[data-batch]")) {
    const k = b.dataset.batch;
    if (k === "restore") b.hidden = !trash;
    else if (k !== "clear") b.hidden = trash;
    b.disabled = !n;
    if (k === "star") { b.classList.toggle("on", every("starred")); b.title = every("starred") ? "Remove from favourites" : "Favourite"; }
    if (k === "pin") { b.classList.toggle("on", every("pinned")); b.title = every("pinned") ? "Unpin" : "Pin to revisit"; }
    if (k === "archive") b.title = archived || every("archived") ? "Unarchive: back into the list" : "Archive: out of the list, kept on disk (Archived shows them)";
    if (k === "playlist") b.disabled = !n || !state.playlists?.length;
  }
  const vis = state.libVisible || [];
  const shown = vis.filter((f) => state.libSel.has(f)).length;
  const all = $("batchAll");
  all.disabled = !vis.length;
  all.checked = vis.length > 0 && shown === vis.length;
  all.indeterminate = shown > 0 && shown < vis.length;
}
function reList() { renderList(state.lastSnap || { queue: [], history: [], library: state.library }); }

function onSelClick(e) {
  if (!state.libSel) state.libSel = new Set();
  const box = e.target.closest?.("input[data-sel]");
  if (box) {
    e.stopPropagation();
    const file = decodeURIComponent(box.dataset.sel);
    const boxes = [...$("rows").querySelectorAll("input[data-sel]")].map((x) => decodeURIComponent(x.dataset.sel));
    const a = boxes.indexOf(state.libSelLast), b = boxes.indexOf(file);
    // Shift-click ticks (or unticks) everything between the last box and this one.
    const span = e.shiftKey && a >= 0 && b >= 0 ? boxes.slice(Math.min(a, b), Math.max(a, b) + 1) : [file];
    for (const f of span) { if (box.checked) state.libSel.add(f); else state.libSel.delete(f); }
    state.libSelLast = file;
    reList();
    return;
  }
  const g = e.target.closest?.("input[data-grpsel]");
  if (g) {
    e.stopPropagation();
    for (const f of state.grpFiles?.get(g.dataset.grpsel) || []) { if (g.checked) state.libSel.add(f); else state.libSel.delete(f); }
    reList();
  }
}
$("rows").addEventListener("click", onSelClick, true);
$("pinRows").addEventListener("click", onSelClick, true);
$("batchAll").addEventListener("change", (e) => {
  if (!state.libSel) state.libSel = new Set();
  for (const f of state.libVisible || []) { if (e.target.checked) state.libSel.add(f); else state.libSel.delete(f); }
  reList();
});
// A selection belongs to the list it was made in: the trash and the library are different lists.
$("libFilter").addEventListener("change", () => { state.libSel = new Set(); });

async function runBatch(kind) {
  const files = [...(state.libSel || [])];
  if (!files.length && kind !== "clear") return;
  const lib = new Map((state.library || []).map((t) => [t.file, t]));
  const every = (k) => files.every((f) => lib.get(f)?.[k]);
  const n = files.length, songs = `${n} song${n === 1 ? "" : "s"}`;
  const batch = async (body) => {
    const r = await (await fetch("/api/track", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "batch", files, ...body }) })).json();
    if (r.error) alert(r.error);
    else if (r.failed?.length) alert(`${r.failed.length} of ${songs} could not be changed: ${r.failed[0].error}`);
    return r;
  };
  if (kind === "clear") { state.libSel = new Set(); reList(); return; }
  if (kind === "star") await batch({ op: "flag", flag: "starred", value: !every("starred") });
  else if (kind === "pin") await batch({ op: "flag", flag: "pinned", value: !every("pinned") });
  else if (kind === "archive") {
    const value = !($("libFilter").value === "archived" || every("archived"));
    await batch({ op: "flag", flag: "archived", value });
    state.libSel = new Set();          // they leave this list, so the ticks go with them
  } else if (kind === "trash") {
    if (!(await appConfirm(`Move ${songs} to the trash? You can restore them from 🗑 Trash.`))) return;
    await batch({ op: "trash" });
    state.libSel = new Set();
  } else if (kind === "restore") {
    await batch({ op: "restore" });
    state.libSel = new Set();
  } else if (kind === "playlist") {
    const names = (state.playlists || []).map((p, i) => `${i + 1}. ${p.name}`).join("\n");
    const pick = await appPrompt(`Add ${songs} to which playlist?\n\n${names}`, "1");
    const pl = (state.playlists || [])[Number(pick) - 1];
    if (!pl) return;
    await fetch("/api/playlist", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add", id: pl.id, files }) });
  } else if (kind === "stems" || kind === "lrc") {
    // Queued one by one: each waits for an idle card, exactly as from the row menu.
    const errors = [];
    for (const file of files) {
      const r = await fetch(kind === "stems" ? "/api/stems" : "/api/lyrics", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run", file }),
      }).then((x) => x.json()).catch((err) => ({ error: err.message }));
      if (r?.error) errors.push(r.error);
    }
    if (errors.length) alert(`${errors.length} of ${songs} were not queued: ${errors[0]}`);
  }
  poll();
}
$("batchBar").addEventListener("click", (e) => {
  const b = e.target.closest("[data-batch]");
  if (b && !b.disabled) runBatch(b.dataset.batch);
});

function trackAction(body) {
  return fetch("/api/track", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) }).then((r) => r.json()).then((r) => { if (r.library) poll(); }).catch(() => {});
}

/* ── library toolbar ──────────────────────────────────── */
for (const id of ["libSearch", "libFilter", "libSort"]) {
  $(id).addEventListener("input", () => poll());
}
$("viewList").onclick = () => setGrid(false);
$("viewGrid").onclick = () => setGrid(true);
function setGrid(on) {
  state.gridView = on;
  localStorage.setItem("aiplayGrid", on ? "1" : "0");
  $("viewGrid").setAttribute("aria-pressed", String(on));
  $("viewList").setAttribute("aria-pressed", String(!on));
  poll();
}

/* ── song panel ───────────────────────────────────────── */
/* Everything that made a track is already stored; nothing showed it back. The
   panel is the place to read the style and lyrics of a take before deciding
   whether to keep re-rolling it. */
function openSong(file) {
  const t = (state.library || []).find((x) => x.file === file);
  if (!t) return;
  state.songFile = file;

  $("spArt").style.background = artBg(t, true);
  $("spTitle").textContent = t.title || "Untitled";
  $("spSub").textContent = [
    t.durationSeconds ? fmt(t.durationSeconds) : null,
    stamp(t.createdAt),
    t.instrumental ? "instrumental" : null,
    t.preview ? "preview" : null,
  ].filter(Boolean).join(" · ");
  const warnings = $("spWarnings");
  if (warnings) {
    warnings.innerHTML = musicWarningHtml(t);
    warnings.hidden = !warnings.innerHTML;
  }

  $("spStyle").textContent = t.caption || "—";
  $("spStyle").classList.add("clamp");
  $("spStyle").classList.remove("open");
  $("spStyleMore").textContent = "Show more";
  $("spStyleMore").hidden = (t.caption || "").length < 160;
  $("spLyricsSec").hidden = !t.lyrics;
  $("spLyrics").textContent = t.lyrics || "";

  // Older tracks predate the sidecar storing lyrics — but the words went into
  // the FLAC's own tags at generation time, so ask the file rather than showing
  // an empty panel.
  if (!t.lyrics) {
    fetch(`/api/trackmeta?file=${encodeURIComponent(file)}`)
      .then((r) => r.json())
      .then((m) => {
        if (state.songFile !== file) return;   // panel moved on while we waited
        if (m.lyrics) {
          t.lyrics = m.lyrics;
          $("spLyrics").textContent = m.lyrics;
          $("spLyricsSec").hidden = false;
        }
        if (m.caption && !t.caption) {
          t.caption = m.caption;
          $("spStyle").textContent = m.caption;
        }
      })
      .catch(() => {});
  }

  // Only what the render actually used. A row of blank fields would suggest the
  // settings were lost rather than simply never recorded for older files.
  const rows = [
    ["seed", t.seed], ["mix seed", t.mixSeed], ["steps", t.steps],
    ["style strength", t.cfg], ["precision", t.model],
    ["render time", t.renderSeconds ? fmt(t.renderSeconds) : null],
    ["file", t.file],
  ].filter(([, v]) => v !== undefined && v !== null && v !== "");
  $("spSettings").innerHTML = rows
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");

  /* The clip. library.js has emitted a `clip` field and the server has served
   * /api/clip/ with Range support for a while, but nothing ever read either —
   * so a rendered clip was written to disk and then invisible forever.
   *
   * `src` is only assigned when there IS one, and cleared otherwise: leaving a
   * stale src on a hidden <video> keeps the previous song's clip buffering in
   * the background as you click down the library. */
  const vid = $("spClip");
  if (t.clip) {
    // #t=0.1 makes the browser seek to a real frame, so the element shows the
    // clip instead of a black rectangle before you press play.
    vid.src = `/api/clip/${encodeURIComponent(t.clip)}#t=0.1`;
    $("spClipSec").hidden = false;
  } else {
    vid.removeAttribute("src");
    vid.load();
    $("spClipSec").hidden = true;
  }

  paintLineage(t);
  renderMerge(t);
  paintExtend(t);
  paintProvenance(t);
  $("songPanel").hidden = false;
}

/* ── output rights: may you sell it? ────────────────────────────────────────
 *
 * Two surfaces and no third: a chip on a picture's origin row, and one line in
 * the export dialog. Deliberately NOT a gate. Studio cannot know where a file
 * is going — a wallpaper, a client's album cover, a joke in a group chat — so
 * it states the terms and gets out of the way. A tool that guesses wrong about
 * that gets routed around, and a tool nobody uses informs nobody.
 *
 * The verdict comes from the LEDGER (stamped when the file was generated); the
 * verbatim quote comes from the catalogue, which is where the licence text
 * lives. When those two disagree the chip says so out loud rather than quietly
 * showing today's answer for last year's file — that disagreement is the whole
 * reason the class is stamped at generation time.
 */
let rightsCatalogCache = null;
async function rightsCatalog() {
  if (rightsCatalogCache) return rightsCatalogCache;
  try {
    const d = await (await fetch("/api/models")).json();
    rightsCatalogCache = Object.fromEntries((d.capabilities || []).map((c) => [c.id, c]));
  } catch { rightsCatalogCache = {}; }
  return rightsCatalogCache;
}

/**
 * WHAT THE VIDEO ENGINE COSTS, AND WHERE ITS LICENCE DOES NOT REACH — read
 * from the catalogue at the moment somebody is asked to switch video on.
 *
 * That sentence used to be typed into the confirm below: "about 34 GB", and
 * three excluded territories where server/models.js has listed four all along.
 * It was one of five hand-typed copies of that list found on 2026-09-02;
 * server/territory_test.js is the gate that now refuses a sixth. This page
 * cannot import models.js, but /api/models sends every row with its
 * `region.excluded` — the same payload the welcome window, the Models screen
 * and the Thanks page already read.
 *
 * Two rules here, both about not guessing:
 *
 *   · The row is found by the ENGINE'S OWN LABEL, taken from the config payload
 *     the engine select is built from, rather than by a key→capability map
 *     retyped in this file. That map lives in server/models.js — server/index.js
 *     says why it is one map and not a ternary in three places — and a copy of
 *     it here would be the same mistake in a new spot.
 *   · If the payload has not arrived, or matches nothing, the clause is simply
 *     not said. A missing sentence is recoverable; a confidently wrong territory
 *     list is what this is cleaning up. The download itself is gated by the
 *     blocking acknowledgement on the Models screen either way, so nothing is
 *     riding on this dialog's wording.
 */
async function videoEngineFacts() {
  const label = state.video?.engines?.[state.video?.engine]?.label;
  if (!label) return "";
  const caps = Object.values(await rightsCatalog());
  /* Two rows can carry one engine's name — the clip weights and the reference
   * checkpoint that runs alongside them — and this dialog asks about clips,
   * which is the whole model rather than the add-on. */
  const cap = caps.filter((c) => String(c.label).includes(label))
    .sort((a, b) => (b.totalBytes || 0) - (a.totalBytes || 0))[0];
  if (!cap) return "";
  const facts = [
    cap.totalBytes ? `${label} is ${gb(cap.totalBytes)}` : "",
    cap.region?.excluded?.length
      ? `its licence excludes ${cap.region.excluded.join(", ")}` : "",
  ].filter(Boolean);
  return facts.length ? ` ${facts.join(", and ")}.` : "";
}

/* One place decides the words. `models.js` holds the same strings server-side;
 * these are what a person actually reads, so they say "you". */
const RIGHTS_WORDS = {
  "unrestricted": { chip: "Yours to sell", tone: "ok",
    line: "Nothing in this model's licence touches what you make with it." },
  "yours-with-conditions": { chip: "Yours to sell", tone: "warn",
    line: "The licence says in writing that what you generate is yours to use commercially — and it attaches conditions." },
  "not-for-sale": { chip: "Not for sale (model licence)", tone: "bad",
    line: "This model's licence bans commercial use of the material it generates, not only of the weights." },
  "unknown": { chip: "Rights unverified", tone: "unknown",
    line: "Nobody has read the operative text, so Studio makes no claim either way. Read it before you rely on it." },
};

/** The chip's own words, including the condition count. */
function rightsChipLabel(cls, conditions) {
  const w = RIGHTS_WORDS[cls] || RIGHTS_WORDS.unknown;
  const n = (conditions || []).length;
  if (cls === "yours-with-conditions" && n) {
    return `${w.chip} — ${n} condition${n > 1 ? "s" : ""}`;
  }
  return w.chip;
}

/**
 * Chip + collapsed detail for one stamped generation.
 *
 * `stamp` is what the ledger recorded ({ class, capability, url }); `cap` is the
 * catalogue row for that capability, or null when the model is not one of ours
 * (a checkpoint the user supplied — the honest answer there is "unknown", and
 * the note says why).
 */
function rightsChipHtml(stamp, cap) {
  if (!stamp || !stamp.class) return "";
  const or = cap?.outputRights || null;
  const cls = stamp.class;
  const w = RIGHTS_WORDS[cls] || RIGHTS_WORDS.unknown;
  const conds = or && or.class === cls ? (or.conditions || []) : [];
  // The catalogue moved under a file that was already made: say it, don't hide it.
  const drifted = or && or.class && or.class !== cls;
  const id = `rd${Math.random().toString(36).slice(2, 9)}`;
  const detail = `
    <div class="rdetail" id="${id}" hidden>
      <p class="rline">${esc(w.line)}</p>
      ${conds.length ? `<ul class="rconds">${conds.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
      ${or?.quote ? `<blockquote class="rquote">${esc(or.quote)}</blockquote>
         <p class="rclause">${esc(or.clause || "")}</p>` : ""}
      ${or?.publisher ? `<p class="rpub"><b>What the authors said</b> — ${esc(or.publisher.by)},
         <a href="${esc(or.publisher.where)}" target="_blank" rel="noopener">discussion</a>, ${esc(or.publisher.on)}:
         <q>${esc(or.publisher.said)}</q> ${esc(or.publisher.caveat)}${or.publisher.support
           ? ` <a href="${esc(or.publisher.support)}" target="_blank" rel="noopener">Support the authors.</a>` : ""}</p>` : ""}
      ${or?.note ? `<p class="rnote">${esc(or.note)}</p>` : ""}
      ${drifted ? `<p class="rdrift">⚠ This file was made when the licence answer here was
         “${esc(RIGHTS_WORDS[cls]?.chip || cls)}”. The catalogue now reads
         “${esc(RIGHTS_WORDS[or.class]?.chip || or.class)}” — the ledger keeps what was true at the time.</p>` : ""}
      ${stamp.url || or?.url
        ? `<p><a href="${esc(stamp.url || or.url)}" target="_blank" rel="noopener">read the licence at the source</a></p>`
        : ""}
      <p class="rnever">Studio never blocks an export on this. It is your call and your file.</p>
    </div>`;
  return `<span class="rights"><button type="button" class="rchip r-${w.tone}" data-rights="${id}"
      title="What this model's licence says about selling what you made">${esc(rightsChipLabel(cls, conds))}</button>${detail}</span>`;
}

/** Chip for an asset, straight from its ledger summary. Empty string when the
 *  asset predates the stamp — silence beats a back-dated guess. */
async function rightsChipFor(summary) {
  const stamp = summary?.outputRights;
  if (!stamp) return "";
  const cat = await rightsCatalog();
  return rightsChipHtml(stamp, stamp.capability ? cat[stamp.capability] : null);
}

/* One delegated listener for every chip on every page — chips are rendered
 * into innerHTML in five places and per-element handlers would be five chances
 * to forget one. */
document.addEventListener("click", (e) => {
  const b = e.target?.closest?.("[data-rights]");
  if (!b) return;
  const d = document.getElementById(b.dataset.rights);
  if (d) d.hidden = !d.hidden;
});

/* ── provenance panel (SPEC D2.2) ──────────────────────────────
 * Human contributions FIRST, every AI part named with its model, and nothing
 * claimed without an event to back it: a track made before the ledger existed
 * says so instead of guessing. The display toggle hides this section only —
 * capture and embedding are not its business. */
function paintProvenance(t) {
  const sec = $("spProvSec");
  if (!sec) return;
  if (state.provenance && state.provenance.showBadges === false) { sec.hidden = true; return; }
  sec.hidden = false;
  const file = t.file;
  $("spProv").innerHTML = "";
  $("spProvSum").textContent = "";
  $("spProvNote").hidden = true;
  fetch(`/api/provenance?asset=${encodeURIComponent(file)}`)
    .then((r) => r.json())
    .then((d) => {
      if (state.songFile !== file) return;             // panel moved on
      const ev = d.events || [];
      const s = d.summary || {};
      if (!ev.length) {
        // Honest about the gap: pre-ledger tracks still carry their embedded
        // tags, but nobody recorded who did what, so nothing is claimed.
        $("spProvSum").textContent = "no record";
        $("spProvNote").textContent =
          "Made before the provenance ledger existed — the file still carries its "
          + "generation tags, but per-part origin was not recorded.";
        $("spProvNote").hidden = false;
        return;
      }
      const rows = [];
      const pill = (cls, label) => `<span class="pvpill ${cls}">${esc(label)}</span>`;
      // Lyrics first — the human part leads when a human made it.
      const authored = ev.filter((e) => e.type === "author_text");
      const userTyped = authored.some((e) => e.actor === "user");
      const agentTyped = authored.find((e) => String(e.actor).startsWith("agent:"));
      if (t.instrumental) {
        rows.push(["Lyrics", `${pill("pv-none", "none")} instrumental — scaffold text is never labeled human`]);
      } else if (userTyped) {
        const chars = authored.find((e) => e.actor === "user")?.data?.chars;
        rows.push(["Lyrics", `${pill("pv-h", "HUMAN")} typed${chars ? `, ${chars} chars` : ""}`]);
      } else if (agentTyped) {
        rows.push(["Lyrics", `${pill("pv-ai", esc(agentTyped.actor))} written by the agent`]);
      } else if (t.lyrics) {
        rows.push(["Lyrics", `${pill("pv-none", "unrecorded")} present, author not recorded`]);
      }
      const gen = ev.filter((e) => e.type === "generate").pop();
      if (gen) {
        const model = gen.data?.model || "model";
        if (!t.instrumental) {
          rows.push(["Vocals", `${pill("pv-ai", `AI (${esc(model)})`)} sings the ${userTyped ? "human" : "provided"} lyrics`]);
        }
        rows.push([t.instrumental ? "Music" : "Instrumental",
          `${pill("pv-ai", `AI (${esc(model)})`)} seed ${gen.data?.seed ?? "?"}${gen.data?.params?.steps ? `, ${gen.data.params.steps} steps` : ""}`]);
      }
      const edits = s.editsBy || {};
      if (edits.user) rows.push(["Edits", `${pill("pv-he", "AI + HUMAN EDIT")} ${edits.user} by you${edits.agent ? `, ${edits.agent} by an agent` : ""}`]);
      else if (edits.agent || edits.system) rows.push(["Edits", `${pill("pv-ai", "AGENT/SYSTEM")} ${(edits.agent || 0) + (edits.system || 0)} — not human edits`]);
      $("spProv").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("");
      const cls = s.class || "unrecorded";
      $("spProvSum").textContent = cls.replace(/-/g, " ");
      // Cover art rides its own asset id; one extra read, only when open.
      if (t.cover) {
        fetch(`/api/provenance?asset=${encodeURIComponent(`covers/${t.cover}`)}`)
          .then((r) => r.json())
          .then((c) => {
            if (state.songFile !== file) return;
            const cg = (c.events || []).find((e) => e.type === "generate");
            if (cg) {
              $("spProv").insertAdjacentHTML("beforeend",
                `<dt>Cover art</dt><dd><span class="pvpill pv-ai">AI (${esc(cg.data?.model || "model")})</span></dd>`);
            }
          }).catch(() => {});
      }
    })
    .catch(() => { $("spProvSum").textContent = ""; });
}

/* Walk the extension chain back to the original.
 *
 * Each join already writes a COMPLETE song — kept prefix plus new ending — and
 * splices the trajectories, so extending an extension continues the whole thing
 * rather than just the last section. That means the newest link IS the finished
 * track and there is nothing to "combine"; what was missing was any way to see
 * that the files are one lineage rather than unrelated takes. */
function paintLineage(t) {
  const chain = [];
  let cur = t, guard = 0;
  while (cur?.extendedFrom && guard++ < 12) {
    const parent = (state.library || []).find((x) => x.file === cur.extendedFrom);
    if (!parent) { chain.push({ title: cur.extendedFrom, missing: true }); break; }
    chain.push(parent);
    cur = parent;
  }
  $("spLineage").hidden = !chain.length;
  if (!chain.length) return;
  // Each step carries its own artwork. Every take in a chain shares a title, so
  // the picture is the only thing that tells them apart at a glance — which is
  // exactly what you need when choosing WHICH continuation to keep.
  const step = (p, i, now = false) => `
    <div class="clink${p.missing ? " gone" : ""}${now ? " now" : ""}"${
      p.file ? ` data-info="${encodeURIComponent(p.file)}"` : ""}>
      <span class="n">${i}</span>
      ${p.missing ? '<span class="cart gone"></span>' : `<span class="cart" style="background:${artBg(p)}"></span>`}
      <span class="t">${esc(p.title || p.file)}${now ? " · this one" : ""}</span>
      <span class="d">${p.durationSeconds ? fmt(p.durationSeconds) : ""}</span>
    </div>`;
  $("spChain").innerHTML =
    chain.reverse().map((p, i) => step(p, i + 1)).join("") + step(t, chain.length + 1, true);
}
$("spChain").addEventListener("click", (e) => {
  const l = e.target.closest("[data-info]");
  if (l) openSong(decodeURIComponent(l.dataset.info));
});

/* ── edit song details ────────────────────────────────────
 *
 * One dialog for everything a track carries ABOUT itself: its artwork, its name,
 * a note of your own, and the style and words it was made from.
 *
 * The last two are shown but explicitly labelled as a record rather than a
 * control — they are what produced the audio, and changing them cannot change a
 * rendering that already happened. Hiding them would be worse: they are the most
 * useful thing to copy out of a take you liked.
 */
function openEdit(file) {
  const t = (state.library || []).find((x) => x.file === file);
  if (!t) return;
  state.editFile = file;
  $("edArt").style.background = artBg(t, true);
  $("edTitle").value = t.title || "";
  $("edNotes").value = t.notes || "";
  $("edCaption").value = t.caption || "";
  $("edLyrics").value = t.lyrics || "";
  $("edit").hidden = false;
  $("edTitle").focus();

  // Older takes kept their words only in the file's tags. Recover them so the
  // box is not misleadingly empty on a track that definitely has lyrics.
  if (!t.lyrics) {
    fetch(`/api/trackmeta?file=${encodeURIComponent(file)}`)
      .then((r) => r.json())
      .then((d) => {
        if (state.editFile !== file) return;          // dialog moved on
        if (d.lyrics && !$("edLyrics").value) $("edLyrics").value = d.lyrics;
        if (d.caption && !$("edCaption").value) $("edCaption").value = d.caption;
      })
      .catch(() => {});
  }
}
const closeEdit = () => { $("edit").hidden = true; state.editFile = null; };
$("edPanelClose").onclick = closeEdit;
$("edCancel").onclick = closeEdit;
$("edit").addEventListener("click", (e) => { if (e.target.id === "edit") closeEdit(); });

$("edSave").onclick = async () => {
  const file = state.editFile;
  if (!file) return;
  $("edSave").disabled = true;
  try {
    await trackAction({
      action: "details", file,
      title: $("edTitle").value, notes: $("edNotes").value,
      caption: $("edCaption").value, lyrics: $("edLyrics").value,
    });
    closeEdit();
    openSong(file);
  } finally {
    $("edSave").disabled = false;
  }
};

$("edRegen").onclick = async () => {
  const file = state.editFile;
  if (!file) return;
  await fetch("/api/art", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "regenerate", file }),
  });
  $("edArt").title = "Queued — drawn as soon as nothing is generating";
};
$("edUpload").onclick = () => $("edArtFile").click();
$("edArtFile").onchange = async () => {
  const f = $("edArtFile").files?.[0];
  if (!f || !state.editFile) return;
  // Read as a data URL: this is a local page talking to a local server, so a
  // multipart parser would be a dependency bought for nothing.
  const data = await new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(f);
  });
  const r = await fetch("/api/art", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "upload", file: state.editFile, data }),
  }).then((x) => x.json());
  if (r.error) { alert(r.error); return; }
  if (r.library) state.library = r.library;
  const t = state.library.find((x) => x.file === state.editFile);
  // Cache-bust: the filename is unchanged, so without this the browser keeps
  // painting the picture it already has.
  if (t) { t.coverV = Date.now(); $("edArt").style.background = artBg(t, true); }
  poll();
};
$("edRemove").onclick = async () => {
  if (!state.editFile) return;
  const r = await fetch("/api/art", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "remove", file: state.editFile }),
  }).then((x) => x.json());
  if (r.library) state.library = r.library;
  const t = state.library.find((x) => x.file === state.editFile);
  if (t) $("edArt").style.background = artBg(t, true);
  poll();
};
$("spArtEdit").onclick = (e) => { e.stopPropagation(); if (state.songFile) openEdit(state.songFile); };

/* ── merge a tree of continuations ────────────────────────
 *
 * The family of a take is every continuation that shares its root — including
 * the one being viewed. Ordered oldest-first, because that is the order they
 * were written and the only ordering the user can reason about.
 *
 * Each is a COMPLETE song already, so merging appends only the part past each
 * one's own resume point. The server does that arithmetic; here we only decide
 * which takes take part.
 */
function familyOf(t, lib) {
  const rootOf = (f, guard = 0) => {
    const m = lib.find((x) => x.file === f);
    return (m && m.extendedFrom && guard < 20) ? rootOf(m.extendedFrom, guard + 1) : f;
  };
  const root = rootOf(t.file);
  return lib
    .filter((x) => x.extendedFrom && rootOf(x.file) === root)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function renderMerge(t) {
  const lib = state.library || [];
  const fam = familyOf(t, lib);
  // Nothing to combine unless there are at least two continuations.
  $("spMergeSec").hidden = fam.length < 2;
  if (fam.length < 2) return;
  state.mergeFamily = fam.map((x) => x.file);
  $("spMergeList").innerHTML = fam.map((x, i) => `
    <div class="clink${x.file === t.file ? " now" : ""}" data-info="${encodeURIComponent(x.file)}">
      <span class="n">${i + 1}</span>
      <span class="cart" style="background:${artBg(x)}"></span>
      <span class="t">${esc(x.title || x.file)}${x.file === t.file ? " · this one" : ""}</span>
      <span class="d">${x.durationSeconds ? fmt(x.durationSeconds) : ""}</span>
    </div>`).join("");
  const naive = fam.reduce((s, x) => s + (x.durationSeconds || 0), 0);
  $("spMergeNote").textContent =
    `${fam.length} continuations of the same take. They each contain the shared opening, `
    + `so merging keeps it once instead of ${fam.length} times — roughly ${fmt(naive)} of audio `
    + `becomes one song. The originals are kept.`;
}
$("spMergeList").addEventListener("click", (e) => {
  const l = e.target.closest("[data-info]");
  if (l) openSong(decodeURIComponent(l.dataset.info));
});
$("spMerge").onclick = async () => {
  const files = state.mergeFamily || [];
  if (files.length < 2) return;
  const b = $("spMerge");
  b.disabled = true; b.textContent = "Merging…";
  try {
    const r = await fetch("/api/merge", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    }).then((x) => x.json());
    if (r.error) { $("spMergeNote").textContent = r.error; return; }
    $("spMergeNote").textContent = `Merged ${r.merged} takes into one ${fmt(r.seconds)} song.`;
    await poll();
    openSong(r.file);
  } finally {
    b.disabled = false; b.textContent = "Merge into one song";
  }
};

/* ── extend ───────────────────────────────────────────── */
/* Only offered where it can actually work. A track has to carry a saved
 * trajectory, which means it was generated after the capture update; older
 * files have none and never will, so the control hides rather than failing. */
/* Only offered where it can work: the track needs a saved performance, which
 * means it was generated after the capture update. Older files have none and
 * never will, so the control hides rather than failing on click. */
/* ── Training ─────────────────────────────────────────────────────────────
 *
 * Teach the music model one of your own songs. The door refuses before the hour
 * is spent rather than during it, and every refusal names one fixable thing —
 * so this screen mostly just prints what the door said.
 *
 * ⚠ IT SAYS WHAT IS NOT PROVEN, ON THE SCREEN. That the loop runs is measured.
 * Whether a given number of steps yields an adapter you can HEAR is not, and a
 * page that implied otherwise would cost somebody an hour of their card before
 * they found out. Both sentences come from the door, so there is one author.
 */
const tr = (body) => fetch("/api/train", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}).then((r) => r.json());

/* Survives a reload, because training outlives the page that started it. */
const trRemember = (v) => { try { v ? localStorage.setItem("train.run", JSON.stringify(v)) : localStorage.removeItem("train.run"); } catch { /* a private window is not a reason to fail */ } };
const trRecall = () => { try { return JSON.parse(localStorage.getItem("train.run") || "null"); } catch { return null; } };

async function paintTraining() {
  const st = await tr({ action: "status" }).catch((e) => ({ error: String(e.message || e) }));
  if (st.error && !st.reason) { if ($("trNote")) $("trNote").textContent = st.error; return; }

  /* The two sentences that must be read before pressing, not after. */
  if ($("trLicence")) $("trLicence").textContent = st.licence || "";
  if ($("trHonest")) $("trHonest").textContent = st.honest || "";

  const blocked = $("trBlocked");
  if (blocked) {
    blocked.hidden = !!st.ready;
    blocked.textContent = st.ready ? "" : (st.why || st.error || "");
  }
  if ($("trForm")) $("trForm").hidden = !st.ready;

  paintTrainedList(st.trained || []);

  /* The library, for the one control that matters. It rides on /api/status,
   * which is where every other screen reads it from — a second listing route
   * would be a second answer to "what songs are on this machine". */
  try {
    const r = await (await fetch("/api/status")).json();
    const rows = (r.library || []).filter((t) => t && t.file && /\.(flac|wav|mp3|ogg|opus|m4a)$/i.test(t.file));
    const sel = $("trFile");
    if (sel) {
      sel.innerHTML = rows.map((t) => `<option value="${esc(t.file)}">${esc(t.title || t.file)}</option>`).join("")
        || '<option value="">no songs in the library yet</option>';
    }
  } catch { /* an empty picker is survivable; the door validates anyway */ }

  const run = trRecall();
  if (run?.runId) { showTrainLive(run); trCheckRun(); }
}

function paintTrainedList(rows) {
  const host = $("trList");
  if (!host) return;
  cbCount("trCount", rows.length);
  host.innerHTML = rows.map((t) => `
    <div class="cbpeer">
      <b>${esc(t.name.replace(/^mine_/, "").replace(/\.safetensors$/, ""))}</b>
      <code>${esc(t.name)}</code>
      <span class="meta">${Math.round(t.bytes / 1048576)} MB</span>
      <span class="cbres">Pick it on the Music screen, under the YuE2 engine.</span>
    </div>`).join("") || '<div class="cbempty">None yet. The one you train will appear here and on the Music screen.</div>';
}

function showTrainLive(run) {
  if ($("trLive")) $("trLive").hidden = false;
  if ($("trLiveName")) $("trLiveName").textContent = `Training “${String(run.name || "").replace(/^mine_/, "")}”`;
}

$("trStart")?.addEventListener("click", async () => {
  const note = $("trNote");
  if (note) note.textContent = "Cutting the song and reading it into codes…";
  const r = await tr({
    action: "start",
    file: $("trFile")?.value,
    name: $("trName")?.value,
    seconds: Number($("trSeconds")?.value) || undefined,
    steps: Number($("trSteps")?.value) || undefined,
    rank: Number($("trRank")?.value) || undefined,
    learningRate: Number($("trLr")?.value) || undefined,
  });
  if (r.error) { if (note) note.textContent = r.error; return; }
  if (note) note.textContent = r.note || "Started.";
  trRemember({ runId: r.runId, name: r.name });
  showTrainLive(r);
  trCheckRun();
});

async function trCheckRun() {
  const run = trRecall();
  const state = $("trLiveState");
  if (!run?.runId) { if ($("trLive")) $("trLive").hidden = true; return; }
  const r = await tr({ action: "check", runId: run.runId, name: run.name });
  if (r.error) { if (state) state.textContent = r.error; return; }
  if (!r.done) {
    const s = Math.round(Number(r.runningSec) || 0);
    if (state) state.textContent = `Still training — ${Math.floor(s / 60)}m ${s % 60}s so far. The card is busy until it finishes.`;
    return;
  }
  if (r.failed) {
    if (state) state.textContent = `It stopped: ${r.error}`;
    trRemember(null);
    return;
  }
  if (state) state.textContent = r.note || "Finished.";
  trRemember(null);
  /* ⚠ REPAINT FROM THE FOLDER, not from this reply. The adapter is only real
   * once it is in models/loras, which is the folder every picker reads. */
  const list = await tr({ action: "list" });
  paintTrainedList(list.trained || []);
}
$("trCheck")?.addEventListener("click", trCheckRun);

/* ── Collab ───────────────────────────────────────────────────────────────
 *
 * Who this Studio is, who it knows, what it sends and what has arrived. Every
 * call goes to /api/collab; the page holds no key material and never sees one.
 *
 * ⚠ THE IDENTITY IS MADE ON FIRST SIGHT OF THIS SCREEN, not at boot — a Studio
 * that never collaborates should never have a keypair on its disk. That is why
 * this paints on the view change rather than at start-up.
 *
 * ⚠ THREE TABS, BECAUSE THE PAGE DOES THREE JOBS. It used to show all eight
 * sections at once with a paragraph under each: about a thousand words before
 * you had done anything, and three separate boxes asking a person to type a
 * file path for a folder the server can already list. What follows is the same
 * feature with nothing removed — the numbers moved behind `details.adv`, the
 * prose moved next to the thing it qualifies, and the inbox finally read.
 */
const cb = (body) => fetch("/api/collab", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}).then((r) => r.json());

/* ⚠ ONE VISIBLE LANDING PLACE FOR EVERY MESSAGE, OUTSIDE ALL THREE PANES.
 * Five handlers used to write into #cbFreeNote, which was safe only while the
 * page was one flat scroll. With panes, a message can land on a tab nobody is
 * looking at — and `send_back`'s refusal ("That errand has not rendered yet.
 * Approve its plan on the Plan screen") is the single most important recovery
 * sentence in the feature. #cbFreeNote now answers the busy question and
 * nothing else. */
function cbSay(msg) {
  const el = $("cbSay");
  if (!el) return;
  el.textContent = String(msg || "");
  el.hidden = !msg;
}

const CB_TABS = ["In", "Send", "Friends"];
function setCbTab(which) {
  for (const t of CB_TABS) {
    const btn = $(`cbTab${t}`), pane = $(`cbPane${t}`);
    if (btn) btn.setAttribute("aria-pressed", String(t === which));
    if (pane) pane.hidden = t !== which;
  }
  /* Changing tab disarms: see disarm() for why that matters. */
  disarmCollab();
}
for (const t of CB_TABS) $(`cbTab${t}`)?.addEventListener("click", () => setCbTab(t));
$("cbGoFriends")?.addEventListener("click", () => setCbTab("Friends"));

/* ⚠ THE CONSENT BINDING, AND IT IS THE PAGE'S JOB BECAUSE IT CANNOT BE THE
 * DOOR'S. The door refuses an accept that does not say `seen: true` and hands
 * the prompt back with the refusal — deliberately stateless, so that no mistake
 * on the page can skip it. But it binds a PATH, not the bytes you were shown.
 * With one field and a clickable list, you could read row A's prompt and
 * pictures, click row B, press "Yes", and accept B having read A. So the file
 * that was SHOWN is stamped here, and the yes-press refuses unless the field
 * still holds it. Any row click, tab change or repaint clears the stamp. */
function disarmCollab() {
  const card = $("cbFileCard");
  if (card) delete card.dataset.armed;
  if ($("cbAcceptYes")) $("cbAcceptYes").hidden = true;
  if ($("cbOrderPrompt")) { $("cbOrderPrompt").hidden = true; $("cbOrderPrompt").textContent = ""; }
}

let collabPainted = false;
async function paintCollab(force = false) {
  if (collabPainted && !force) return;
  collabPainted = true;
  const nick = (() => { try { return localStorage.getItem("collab.nickname") || ""; } catch { return ""; } })();
  if ($("cbNickname")) $("cbNickname").value = nick;
  try {
    const me = await cb({ action: "me", nickname: nick });
    if (me.error) { $("cbFp").textContent = me.error; return; }
    $("cbFp").textContent = me.fp;
    $("cbWords").textContent = (me.words || []).join(" ");
    $("cbCard").value = me.card || "";
  } catch (e) { $("cbFp").textContent = String(e.message || e); }
  /* What this Studio can do. Painted from the DOOR rather than composed here,
   * because the redaction lives in one module and a page that assembled its own
   * version of this sentence would be a second place to leak from. */
  try {
    const r = await cb({ action: "resources", note: $("cbNote")?.value || "" });
    const said = r.error || r.describes || "—";
    if ($("cbMine")) $("cbMine").textContent = said;
    if ($("cbMine2")) $("cbMine2").textContent = said;
  } catch { /* a card that will not read is not a reason to hide the screen */ }
  /* The projects to send: the same list the music-video screen uses. */
  try {
    const r = await (await fetch("/api/mv/projects")).json();
    const rows = r.projects || r || [];
    const sel = $("cbProject");
    if (sel && Array.isArray(rows)) {
      sel.innerHTML = rows.map((p) => `<option value="${esc(p.slug)}">${esc(p.title || p.slug)}</option>`).join("");
    }
  } catch { /* a project list that will not load is not a reason to hide the screen */ }
  await refreshCollab();
  paintCbKind();
}

/* Repainting is SEPARATE from paintCollab, which mints the keys on first sight
 * and must stay bound to the view change exactly as it is. */
async function refreshCollab() {
  const peers = await paintPeers().catch(() => []);
  await Promise.all([paintInbox().catch(() => {}), paintErrands().catch(() => {}),
    paintTakes().catch(() => {}), paintOutbox().catch(() => {})]);
  /* An empty roster cannot have anything actionable in its inbox: accept,
   * receive and open all refuse a bundle from somebody not on the roster. So a
   * first-time visitor opens on Friends, which is the only thing they can do. */
  if (!collabTabChosen) setCbTab(peers.length ? "In" : "Friends");
}
let collabTabChosen = false;
for (const t of CB_TABS) $(`cbTab${t}`)?.addEventListener("click", () => { collabTabChosen = true; });

/* ⚠ THE AGE IS NOT DECORATION, AND THIS DOES NOT COMPUTE ITS OWN. A resource
 * card looks exactly like a live status line and is nothing of the kind — it is
 * what somebody's machine could do when they pressed send. This page used to do
 * that sum itself and disagreed with the module that owns it: on a card stamped
 * ten days in the FUTURE the module printed nothing and the page printed "just
 * now", permanently. The door hands the sentence down with the row; the page
 * prints it. */
function shortResources(c, said) {
  const gpu = c.gpu?.name ? c.gpu.name.replace(/^NVIDIA (GeForce )?/, "") : "a card it has not read yet";
  return `${gpu}, ${(c.ready || []).length} models · said ${said || "at a time this machine cannot read"}`;
}

const cbCount = (id, n) => { const el = $(id); if (el) el.textContent = n ? ` ${n}` : ""; };

async function paintPeers() {
  const r = await cb({ action: "roster" });
  const peers = r.peers || [];
  const host = $("cbPeers"), to = $("cbTo");
  const withRole = peers.filter((p) => p.role !== "none");
  if (to) {
    to.innerHTML = withRole
      .map((p) => `<option value="${esc(p.fp)}">${esc(p.nickname || p.fp.slice(0, 8))} · ${esc(p.role)}</option>`).join("")
      || '<option value="">nobody with a role yet</option>';
  }
  /* Nobody with a role means nothing can be packed: the form is replaced by the
   * reason and the one button that fixes it, rather than left there to fail. */
  if ($("cbSendForm")) $("cbSendForm").hidden = !withRole.length;
  if ($("cbNobody")) $("cbNobody").hidden = !!withRole.length;
  cbCount("cbFriendCount", peers.length);
  if (!host) return peers;
  host.innerHTML = peers.map((p) => `
    <div class="cbpeer" data-fp="${esc(p.fp)}">
      <b>${esc(p.nickname || "(no name)")}</b>
      <code>${esc(p.fp.slice(0, 8))}…</code>
      <span class="${p.verified ? "ok" : "warn"}">${p.verified ? "verified aloud" : "you have not read the words together yet"}</span>
      <select class="sel2 cbrole" ${p.verified ? "" : "disabled"}>
        ${[["none", "nothing yet"], ["lender", "may render single scenes for me"], ["collaborator", "may have my whole project"]]
      .map(([x, label]) => `<option value="${x}"${x === p.role ? " selected" : ""}>${label}</option>`).join("")}
      </select>
      <label>minutes of this computer a day <input class="line cbmin" type="number" min="0" max="1440" step="5" value="${Number(p.lendMinutesPerDay) || 0}"></label>
      <span class="cbres">${p.resources ? esc(shortResources(p.resources, p.resourcesSaid)) : "has not said what they can do"}</span>
      ${p.build ? `<span class="cbres cbbuild${cbBuildOdd(p.build) ? " warn" : ""}">${esc(cbBuildLine(p.build))}</span>` : ""}
      ${p.verified ? "" : `<span class="cbres"><b>Their twelve words:</b> <code>${esc((p.words || []).join(" "))}</code> — have them read these to you.</span>
      <button class="btn sm cbverify" type="button">I read the words and they matched</button>`}
      <button class="btn sm ghost cbremove" type="button">Remove</button>
    </div>`).join("");
  const note = $("cbPeersNote");
  if (note) {
    note.textContent = peers.length
      ? `${peers.length} friend${peers.length === 1 ? "" : "s"} · ${peers.filter((p) => p.verified).length} verified · a friend added is not a friend trusted.`
      : "Nobody yet. A friend added is not a friend trusted: they arrive with no role and no minutes of your card.";
  }
  return peers;
}

/* ── What arrived ─────────────────────────────────────────────────────────
 *
 * ⚠ THE `inbox` DOOR EXISTED FROM THE START AND NOTHING EVER CALLED IT. The
 * page asked a person to type "a path, or a name in the inbox" in three
 * separate boxes, for a folder the server can list — including whether each
 * file is a sealed bundle, read from its first eleven bytes.
 *
 * Every sentence below comes from the door. scanInbox already distinguishes
 * "could not read it" from "not a bundle" and already names the real folder;
 * composing a second copy here is the exact habit the warning above
 * shortResources() is about.
 */
async function paintInbox() {
  const host = $("cbInbox");
  if (!host) return;
  const r = await cb({ action: "inbox" });
  if (r.error) {
    /* "Could not look" is not "nothing arrived", and must never be painted as it. */
    host.innerHTML = `<div class="cbempty warn">${esc(r.error)}</div>`;
    cbCount("cbInCount", 0);
    return;
  }
  const items = r.items || [];
  if ($("cbInboxDir") && r.dir) {
    $("cbInboxDir").innerHTML = `Or drop it into <code>${esc(r.dir)}</code> and press <b>Look again</b>.`;
  }
  const sealed = items.filter((i) => i.sealed);
  cbCount("cbInCount", sealed.length);
  host.innerHTML = items.map((i) => `
    <div class="cbpeer" data-file="${esc(i.file)}">
      <b>${esc(i.name)}</b>
      <span class="meta">${Math.max(1, Math.round(i.bytes / 1024))} kB</span>
      ${i.sealed ? '<button class="btn sm cbpick" type="button">See what this is</button>' : ""}
      <span class="cbres ${i.unreadable ? "warn" : ""}">${esc(i.note || "")}</span>
    </div>`).join("") || `<div class="cbempty">${esc(r.note || "Nothing has arrived yet.")}</div>`;
}

/* One listener on the list rather than one per row, because the list is
 * repainted after every change and per-row listeners would leak with it. */
$("cbInbox")?.addEventListener("click", (ev) => {
  const row = ev.target.closest(".cbpeer");
  if (!row || !ev.target.classList.contains("cbpick")) return;
  openCollabFile(row.dataset.file);
});
$("cbLookAgain")?.addEventListener("click", () => { paintInbox().catch(() => {}); });
$("cbPathGo")?.addEventListener("click", () => {
  /* ⚠ EXPLORER'S "Copy as path" IS QUOTED. Left alone, `path.isAbsolute('"C:\…"')`
   * is false, the door falls to its inbox branch, and it answers by telling the
   * person to do the thing they just did. One strip fixes it. */
  const v = ($("cbPath")?.value || "").trim().replace(/^"(.*)"$/, "$1");
  if (v) openCollabFile(v);
});

$("cbShowFolder")?.addEventListener("click", async () => {
  const r = await fetch("/api/reveal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: "collab/in" }),
  }).then((x) => x.json()).catch(() => ({ error: "could not open the folder" }));
  if (r.error) cbSay(r.error);
});

/* The browser never hands over a path, so the bytes go to the door and land in
 * the inbox folder under a name the server sanitises. */
$("cbPickFile")?.addEventListener("change", async (ev) => {
  const f = ev.target.files?.[0];
  if (!f) return;
  cbSay(`Copying ${f.name} into your inbox…`);
  try {
    const r = await fetch(`/api/collab-drop?name=${encodeURIComponent(f.name)}`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f,
    }).then((x) => x.json());
    if (r.error) { cbSay(r.error); return; }
    cbSay("");
    await paintInbox();
    openCollabFile(r.file);
  } catch (e) { cbSay(String(e.message || e)); }
  ev.target.value = "";
});

/* Opening tells us WHAT it is, and the card wears one of three faces. The app
 * works that out so a person does not have to know whether the thing their
 * friend sent is an order, a take or a project. */
async function openCollabFile(file) {
  disarmCollab();
  const card = $("cbFileCard");
  const r = await cb({ action: "open", file });
  if ($("cbFile")) $("cbFile").value = r.file || file || "";
  for (const face of ["cbOrderFace", "cbReturnFace", "cbReadFace"]) if ($(face)) $(face).hidden = true;
  if (card) card.hidden = false;
  if (r.error) {
    /* A refusal is a row state with one remedy, not a dead end. */
    if ($("cbReadFace")) $("cbReadFace").hidden = false;
    if ($("cbReadWho")) $("cbReadWho").textContent = "This one cannot be opened";
    if ($("cbOpened")) { $("cbOpened").hidden = false; $("cbOpened").textContent = r.error; }
    if (r.reason === "unknown-sender") cbSay("Add their key card on the Friends tab first — a signature can only be checked against a key you already hold.");
    return;
  }
  const who = esc(r.from?.nickname || r.from?.fp?.slice(0, 8) || "a friend");
  /* Their build, said once on the card rather than buried in the packet. A
   * newer-protocol file never reaches here: the door refuses it above with the
   * sentence naming both numbers, which lands in this card's own error face. */
  if (r.madeBy || r.compatNote) cbSay([r.madeBy ? `Made by ${r.madeBy}.` : "", r.compatNote || ""].filter(Boolean).join(" "));
  if (r.kind === "order") {
    if ($("cbOrderFace")) $("cbOrderFace").hidden = false;
    if ($("cbOrderWho")) $("cbOrderWho").innerHTML = `${who} is asking this computer to render one scene`;
  } else if (r.kind === "return") {
    if ($("cbReturnFace")) $("cbReturnFace").hidden = false;
    if ($("cbReturnWho")) $("cbReturnWho").innerHTML = `A finished scene has come back from ${who}`;
  } else {
    if ($("cbReadFace")) $("cbReadFace").hidden = false;
    if ($("cbReadWho")) $("cbReadWho").innerHTML = `${who} sent you something to look at`;
    if ($("cbOpened")) {
      $("cbOpened").hidden = false;
      /* ⚠ BOTH HALVES OF THIS LINE TOGETHER. `open` has no verified gate — only
       * accept and receive do — so "Read and verified" is shown precisely for
       * senders nobody has verified, and "verified" there means the signature,
       * not the person. */
      $("cbOpened").textContent =
        `From ${r.from.nickname || r.from.fp} (${r.from.verified ? "verified" : "NOT verified"})\n${r.describes}\n\n`
        + (r.packet?.prompt ? `The prompt they are asking you to render:\n${r.packet.prompt}\n\n` : "")
        + r.note;
    }
  }
}

/* A friend's build, as their row shows it. `state.collabProtocol` is this
 * Studio's own number, read once from /api/version; a difference is worth a
 * colour because it is the thing that decides whether their file will open. */
function cbBuildLine(b) {
  const bits = [b.app, b.commit, Number(b.protocol) ? `collab ${b.protocol}` : ""].filter(Boolean).join(" · ");
  if (!cbBuildOdd(b)) return bits;
  return `${bits} — ${Number(b.protocol) > (state.collabProtocol || 1)
    ? "newer than this Studio; update to open what they send"
    : "older than this Studio; they may not open what you send"}`;
}
function cbBuildOdd(b) {
  const mine = state.collabProtocol || 1;
  return Number.isFinite(Number(b?.protocol)) && Number(b.protocol) !== mine;
}

$("cbCopy")?.addEventListener("click", () => {
  const v = $("cbCard")?.value || "";
  if (v) navigator.clipboard?.writeText(v).then(() => { $("cbCopy").textContent = "Copied"; setTimeout(() => { $("cbCopy").textContent = "Copy"; }, 1200); });
});

/* The nickname is not stored on this machine's identity — `me` composes the
 * card with whatever it is handed — so the page remembers it and sends it. */
$("cbNickname")?.addEventListener("change", async () => {
  const v = ($("cbNickname").value || "").slice(0, 40);
  try { localStorage.setItem("collab.nickname", v); } catch { /* a private window is not a reason to fail */ }
  const me = await cb({ action: "me", nickname: v });
  if (!me.error && $("cbCard")) $("cbCard").value = me.card || "";
  cbSay(v ? `Your friends will see you as “${v}”. Send them your key card again so they get the new name.` : "");
});

$("cbAddBtn")?.addEventListener("click", async () => {
  const card = $("cbAdd")?.value.trim();
  if (!card) return;
  const r = await cb({ action: "add_peer", card });
  if (r.error) { cbSay(r.error); return; }
  $("cbAdd").value = "";
  cbSay(`${r.peer?.nickname || "They"} are on your roster, with no role and nothing they can receive yet. Read these twelve words to them, and have them read theirs back: ${(r.words || []).join(" ")}`);
  await paintPeers();
  /* ⚠ ADDING SOMEBODY USED TO LOOK LIKE NOTHING HAPPENING: the field emptied,
   * a sentence appeared above the fold, and the new row was one of several
   * identical ones further down. The row says which one is new and the page
   * goes to it. */
  const fresh = r.peer?.fp && $("cbPeers")?.querySelector(`.cbpeer[data-fp="${CSS.escape(r.peer.fp)}"]`);
  if (fresh) {
    fresh.classList.add("justadded");
    fresh.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setTimeout(() => fresh.classList.remove("justadded"), 4000);
  }
});

$("cbPeers")?.addEventListener("click", async (ev) => {
  const row = ev.target.closest(".cbpeer");
  if (!row) return;
  const fp = row.dataset.fp;
  if (ev.target.classList.contains("cbverify")) {
    await cb({ action: "verify_peer", fp, verified: true });
    await paintPeers();
  } else if (ev.target.classList.contains("cbremove")) {
    await cb({ action: "remove_peer", fp });
    await paintPeers();
  }
});
$("cbPeers")?.addEventListener("change", async (ev) => {
  const row = ev.target.closest(".cbpeer");
  if (!row) return;
  const fp = row.dataset.fp;
  let r = null;
  if (ev.target.classList.contains("cbrole")) r = await cb({ action: "set_role", fp, role: ev.target.value });
  else if (ev.target.classList.contains("cbmin")) r = await cb({ action: "set_lend_minutes", fp, minutesPerDay: Number(ev.target.value) });
  if (r?.error) cbSay(r.error);
  await paintPeers();
});

/* ── Send ─────────────────────────────────────────────────────────────────── */

/* Only the rows that belong to the chosen kind. The three numbers used to sit
 * there always, each labelled "(order)", whatever you were sending. */
function paintCbKind() {
  const kind = $("cbKind")?.value || "shot";
  const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
  show("cbSegmentRow", kind === "shot" || kind === "order");
  show("cbNoteRow", kind === "resources");
  show("cbMine", kind === "resources");
  show("cbNumbers", kind === "order");
}
$("cbKind")?.addEventListener("change", paintCbKind);

/* The scenes of the chosen project, so "which scene" stops being a box wanting
 * a string like s1_24 that only the sender's own board knows. */
$("cbProject")?.addEventListener("change", async () => {
  const list = $("cbSegments");
  if (!list) return;
  try {
    const slug = $("cbProject").value;
    const r = await (await fetch(`/api/mv/project?slug=${encodeURIComponent(slug)}`)).json();
    const segs = (r.doc?.segments || r.segments || []).flatMap((sg) => (sg.shots || []).map((sh) => sh.id || sh.segmentId)).filter(Boolean);
    list.innerHTML = segs.map((x) => `<option value="${esc(x)}">`).join("");
  } catch { /* no list is survivable: the field still takes a typed id */ }
});

$("cbPack")?.addEventListener("click", async () => {
  const note = $("cbPackNote");
  const kind = $("cbKind")?.value || "shot";
  if (note) note.textContent = "Packing…";
  if ($("cbHandoff")) $("cbHandoff").hidden = true;
  const r = await cb({
    action: "pack", slug: $("cbProject")?.value, to: $("cbTo")?.value, kind,
    ...(kind === "shot" ? { segmentId: $("cbSegment")?.value.trim() } : {}),
    ...(kind === "resources" ? { note: $("cbNote")?.value || "" } : {}),
    ...(kind === "order" ? {
      segmentId: $("cbSegment")?.value.trim(),
      ...($("cbSeed")?.value ? { seed: Number($("cbSeed").value) } : {}),
      ...($("cbSteps")?.value ? { steps: Number($("cbSteps").value) } : {}),
      ...($("cbEngineMode")?.value ? { engineMode: $("cbEngineMode").value } : {}),
    } : {}),
  });
  if (r.error) { if (note) note.textContent = r.error; return; }
  if (note) note.textContent = `${r.describes} · ${Math.round(r.bytes / 1024)} kB`;
  showHandoff(r.file, r.describes);
  await paintOutbox().catch(() => {});
});

/* ⚠ THE ONE SCREEN WHOSE PREMISE IS THAT A HUMAN MOVES A FILE, and its entire
 * answer used to be an absolute path in grey `meta` with no way to act on it —
 * while the key card two hundred lines above had a Copy button for a string
 * that matters less. /api/reveal has existed all along and this page called it
 * zero times. */
function showHandoff(file, what) {
  const box = $("cbHandoff");
  if (!box) return;
  box.hidden = false;
  box.dataset.file = file || "";
  if ($("cbHandoffWhat")) $("cbHandoffWhat").textContent = `${what || "Your sealed file"} — ${file || ""}`;
}
$("cbReveal")?.addEventListener("click", async () => {
  const file = $("cbHandoff")?.dataset.file || "";
  const rel = file.replace(/^.*[\\/]collab[\\/]/, "collab/").replace(/\\/g, "/");
  const r = await fetch("/api/reveal", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: rel }),
  }).then((x) => x.json()).catch(() => ({ error: "could not open the folder" }));
  if (r.error) cbSay(r.error);
});
$("cbCopyPath")?.addEventListener("click", () => {
  const file = $("cbHandoff")?.dataset.file || "";
  if (file) navigator.clipboard?.writeText(file).then(() => {
    $("cbCopyPath").textContent = "Copied";
    setTimeout(() => { $("cbCopyPath").textContent = "Copy its location"; }, 1200);
  });
});

/* ⚠ THE ORDERER'S HALF OF THE LOOP, WHICH THE PAGE NEVER SHOWED. You packed an
 * order, handed over a file, and the app forgot you had: "did I send that to
 * Mika, and has she done it?" was unanswerable on the screen whose job it is.
 * The door has defaulted to `side: "out"` from the start and nothing asked. */
async function paintOutbox() {
  const host = $("cbOutbox"), wrap = $("cbOutboxWrap");
  if (!host) return;
  const r = await cb({ action: "orders", side: "out" });
  const rows = r.orders || [];
  if (wrap) wrap.hidden = !rows.length;
  const plain = {
    sent: "sent — nothing back yet", claimed: "they have taken it on",
    returned: "came back — waiting for you under “What arrived”",
    adopted: "kept", refused: "refused", cancelled: "cancelled", rendered: "rendered",
  };
  host.innerHTML = rows.map((o) => `
    <div class="cbpeer">
      <b>${esc(o.to?.nickname || o.to?.fp?.slice(0, 8) || "a friend")}</b>
      <code>${esc(o.order?.segmentId || "?")}</code>
      <span class="meta">${esc(plain[o.state] || o.state || "sent")}</span>
      <span class="cbres">project ${esc(o.slug || "?")}</span>
    </div>`).join("");
}

$("cbFree")?.addEventListener("click", async () => {
  const n = $("cbFreeNote");
  if (n) n.textContent = "Asking…";
  const r = await cb({ action: "free" });
  if (n) n.textContent = r.error || `${r.busy ? "BUSY" : "free"} — ${r.why}`;
});

/* What friends have asked of this machine, and what came back from them. Both
 * lists are painted from the door; nothing here decides anything. */
async function paintErrands() {
  const host = $("cbErrands"), wrap = $("cbErrandsWrap");
  if (!host) return;
  const r = await cb({ action: "orders", side: "in" });
  const rows = r.orders || [];
  if (wrap) wrap.hidden = !rows.length;
  host.innerHTML = rows.map((o) => `
    <div class="cbpeer" data-id="${esc(o.id)}">
      <b>${esc(o.from?.nickname || o.from?.fp?.slice(0, 8) || "a friend")}</b>
      <code>${esc(o.order?.segmentId || "?")}</code>
      <span class="meta">seed ${esc(String(o.order?.seed ?? "?"))} · ${esc(String(o.order?.steps ?? "?"))} steps · ${esc(o.order?.engineMode || "?")}</span>
      <span class="${o.state === "rendered" ? "ok" : "warn"}">${esc(o.state || "landed")}</span>
      <span class="cbres">project ${esc(o.slug || "?")}${o.planId ? ` · plan ${esc(o.planId)}` : ""}</span>
      ${o.state === "rendered" ? "" : '<button class="btn sm cbsend" type="button">Send the take back</button>'}
    </div>`).join("");
}

async function paintTakes() {
  const host = $("cbTakes"), wrap = $("cbTakesWrap");
  if (!host) return;
  const r = await cb({ action: "quarantine" });
  const rows = r.takes || [];
  if (wrap) wrap.hidden = !rows.length;
  host.innerHTML = rows.map((t) => `
    <div class="cbpeer" data-from="${esc(t.from)}" data-file="${esc(t.file)}">
      <b>${esc(t.segmentId || "?")}</b>
      <code>${esc(String(t.from).slice(0, 8))}</code>
      <span class="${t.ok ? "ok" : "warn"}">${t.adopted ? "kept" : t.ok ? "checked" : esc(t.reason || "refused")}</span>
      <span class="cbres">${esc(t.why || "")}</span>
      ${t.adopted ? "" : '<button class="btn sm cbadopt" type="button">Keep it</button><button class="btn sm ghost cbdrop" type="button">Throw it away</button>'}
    </div>`).join("");
}

/* ⚠ TWO PRESSES, AND THE FIRST ONE IS READING. The door refuses an accept that
 * does not say the prompt was seen, and hands the prompt back with the refusal
 * — so this is not the page being polite, it is the page showing what the door
 * insisted on. The arming below is the page's own half: see disarmCollab(). */
$("cbAcceptBtn")?.addEventListener("click", async () => {
  const out = $("cbOrderPrompt"), yes = $("cbAcceptYes"), card = $("cbFileCard");
  const file = $("cbFile")?.value.trim();
  const r = await cb({ action: "accept", file });
  if (r.reason === "not-seen") {
    if (out) {
      out.hidden = false;
      /* ⚠ `esc()` ON EVERY ONE OF THESE. This element stopped being
       * `textContent` the moment it had to hold pictures, and the nickname, the
       * prompt and the description are all strings a peer chose. */
      const pics = Array.isArray(r.pictures) ? r.pictures : [];
      out.innerHTML =
        `<b>${esc(r.describes || "")}</b>\n\nFrom ${esc(r.from?.nickname || r.from?.fp || "")}\n\n`
        + `It will ask your machine to render:\n\n${esc(r.prompt || "(nothing, which is itself a reason not to run it)")}\n\n`
        + (pics.length
          ? `...using ${pics.length} picture${pics.length === 1 ? "" : "s"}, which the model sees as much as it sees the words:\n`
            + pics.map((p) => (p.dataUrl
              ? `<img src="${esc(p.dataUrl)}" alt="" style="max-height:140px;margin:6px 6px 0 0;border:1px solid var(--edge);border-radius:4px"> `
              : `<span class="warn">one picture this Studio could not read as a picture (${esc(String(p.bytes))} bytes) — that alone is a reason to refuse</span> `)).join("")
          : "It carries no pictures.");
    }
    /* The file that was SHOWN is the only one the yes-press may send. */
    if (card) card.dataset.armed = file;
    if (yes) yes.hidden = false;
    cbSay(r.error);
    return;
  }
  cbSay(r.error || r.note || "Accepted.");
  await refreshCollab();
});

$("cbAcceptYes")?.addEventListener("click", async () => {
  const card = $("cbFileCard");
  const file = $("cbFile")?.value.trim();
  /* ⚠ THE REFUSAL THAT MAKES THE ARMING REAL. Without it, reading row A and
   * clicking row B accepts B with `seen: true`, and the door cannot tell. */
  if (!card || card.dataset.armed !== file) {
    cbSay("That is not the file whose prompt you just read. Press “Show me exactly what they want” again for this one.");
    disarmCollab();
    return;
  }
  const r = await cb({ action: "accept", file, seen: true });
  cbSay(r.error || r.note || "Accepted. Approve its plan on the Plan screen when you are ready.");
  if (!r.error) disarmCollab();
  await refreshCollab();
});

$("cbReceiveBtn")?.addEventListener("click", async () => {
  const r = await cb({ action: "receive", file: $("cbFile")?.value.trim() });
  cbSay(r.error || r.note || "");
  await refreshCollab();
});

$("cbErrands")?.addEventListener("click", async (ev) => {
  const row = ev.target.closest(".cbpeer");
  if (!row || !ev.target.classList.contains("cbsend")) return;
  const r = await cb({ action: "send_back", id: row.dataset.id });
  if (r.error) { cbSay(r.error); return; }
  cbSay("");
  setCbTab("Send");
  showHandoff(r.file, "The finished take, sealed for them");
  await paintErrands();
});

$("cbTakes")?.addEventListener("click", async (ev) => {
  const row = ev.target.closest(".cbpeer");
  if (!row) return;
  const body = { from: row.dataset.from, file: row.dataset.file };
  if (ev.target.classList.contains("cbadopt")) {
    const r = await cb({ action: "adopt", ...body });
    cbSay(r.error || r.note || "Kept.");
  } else if (ev.target.classList.contains("cbdrop")) {
    await cb({ action: "drop", ...body });
  } else return;
  await paintTakes();
});

$("cbCredit")?.addEventListener("click", async () => {
  const out = $("cbCredits"), note = $("cbCreditNote");
  const r = await cb({ action: "credit", slug: $("cbProject")?.value });
  if (!out) return;
  out.hidden = false;
  if (r.error) { out.textContent = r.error; return; }
  out.textContent = (r.lines || []).join("\n") || "Nothing recorded for this project yet.";
  /* The caveat is not a footnote a page may drop — see server/collab/credit.js. */
  if (note) note.textContent = `${r.events} recorded acts · ${r.note}`;
});


function paintExtend(t) {
  // MiniMax keeps a trajectory (codes); a YuE2 take keeps its run folder (yueDir).
  $("spExtendSec").hidden = !((t?.codes || t?.yueDir || state.tokenizerReady) && t?.durationSeconds);
  /* "Read for YuE2" is offered only where it buys something: a RECORDING (no
   * trajectory, no run folder) on a machine that has the tokenizer. A take
   * already carries its own performance and needs no reading. */
  const recording = !!(state.tokenizerReady && t?.durationSeconds && !t?.codes && !t?.yueDir);
  const tok = $("spTokenize");
  if (tok) tok.hidden = !recording;
  const stemWrap = $("spStemWrap");
  if (stemWrap) stemWrap.hidden = !recording;
  /* Sounds-like works on anything that HAS codes or can get them, which is any
   * track once the tokenizer is installed. */
  const snd = $("spSounds");
  if (snd) snd.hidden = !(t?.durationSeconds && (state.tokenizerReady || t?.yueDir));
}

/* Rank the library against this track, over YuE2's own tokens. Free on a track
 * whose codes are kept; a reading first on one whose are not, which the note
 * says while it waits. */
async function soundsLikeCurrent() {
  const t = currentSong();
  if (!t) return;
  const btn = $("spSounds"), note = $("spExtendNote");
  btn.disabled = true;
  if (note) note.textContent = `Comparing ${t.title || t.file} against the library…`;
  try {
    const r = await (await fetch("/api/sounds_like", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: t.file, limit: 6 }),
    })).json();
    if (note) {
      note.textContent = r.error
        ? r.error
        : r.matches?.length
          ? `Closest of ${r.compared}: ` + r.matches.map((m) => `${(m.title || m.file || "?").slice(0, 28)} (${Math.round(m.similarity * 100)}%)`).join(", ")
            + " · same kind of sound, not the same tune."
          : `Nothing else on this machine has been read into tokens yet, so there is nothing to compare against.`;
    }
  } catch (e) {
    if (note) note.textContent = String(e.message || e);
  } finally {
    btn.disabled = false;
  }
}
$("spSounds")?.addEventListener("click", soundsLikeCurrent);

/* Read the selected recording into YuE2's codes and say what came of it. The
 * route keeps them by the decoded audio, so pressing it twice is free and says
 * "already read". */
async function tokenizeCurrent() {
  const t = currentSong();
  if (!t) return;
  const btn = $("spTokenize"), note = $("spExtendNote");
  const est = Math.max(5, Math.round((t.durationSeconds || 60) * 0.55));
  const t0 = Date.now();
  btn.disabled = true;
  const timer = setInterval(() => {
    if (note) note.textContent = `Reading ${t.title || t.file} into YuE2's codes — ${Math.round((Date.now() - t0) / 1000)}s of about ${est}s…`;
  }, 1000);
  if (note) note.textContent = `Reading ${t.title || t.file} into YuE2's codes — about ${est}s…`;
  try {
    const r = await (await fetch("/api/tokenize", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: t.file }),
    })).json();
    if (note) {
      note.textContent = r.error
        ? r.error
        : r.cached
          ? `Already read: ${r.frames} tokens for ${Math.round(r.seconds)}s. Continuing this track starts at once.`
          : `Read into ${r.frames} tokens (${Math.round(r.seconds)}s) on the ${r.device === "cpu" ? "processor" : "card"}`
            + `${r.timing?.total ? ` in ${Math.round(r.timing.total)}s` : ""}. Continuing this track now starts at once.`;
    }
  } catch (e) {
    if (note) note.textContent = String(e.message || e);
  } finally {
    clearInterval(timer);
    btn.disabled = false;
  }
}
$("spTokenize")?.addEventListener("click", tokenizeCurrent);

const currentSong = () => (state.library || []).find((x) => x.file === state.songFile);

// Hands off to the input panel, where the lyrics and the waveform are.
$("spExtend").onclick = () => { if (state.songFile) startExtend(state.songFile, "extend"); };
$("spReplace").onclick = () => { if (state.songFile) startExtend(state.songFile, "replace"); };

$("spStyleMore").onclick = () => {
  const open = $("spStyle").classList.toggle("open");
  $("spStyle").classList.toggle("clamp", !open);
  $("spStyleMore").textContent = open ? "Show less" : "Show more";
};

$("spClose").onclick = () => { $("songPanel").hidden = true; };
$("spPlay").onclick = () => {
  const t = (state.library || []).find((x) => x.file === state.songFile);
  if (t) play(encodeURIComponent(t.file), t.title, t.seed);
};
$("spReuse").onclick = () => {
  if (!state.songFile) return;
  reusePrompt(state.songFile);
  $("songPanel").hidden = true;
};
$("spEdit").onclick = () => { if (state.songFile) openEditor(state.songFile); };
$("spReveal").onclick = () => {
  if (!state.songFile) return;
  fetch("/api/reveal", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: state.songFile }) });
};
$("spReroll").onclick = () => { if (state.songFile) rerollMix(state.songFile); };
// Copy buttons write the source text, not the rendered node, so lyric line
// breaks survive the trip to another app.
for (const b of document.querySelectorAll("[data-copy]")) {
  b.onclick = () => {
    navigator.clipboard.writeText($(b.dataset.copy).textContent || "").then(() => {
      const was = b.textContent; b.textContent = "copied";
      setTimeout(() => { b.textContent = was; }, 1200);
    }).catch(() => {});
  };
}

/* ── views ────────────────────────────────────────────── */
/* The rail links carried data-view from the start but nothing ever read it, so
   Community was reachable only by scrolling past the library. */
/* Move the set-once controls out of Create and into Settings.
 *
 * Done by relocating the existing rows rather than duplicating them, so every
 * handler, id and help entry keeps working untouched. Advanced is left with the
 * five things people actually turn per song: seed, length, quality, and the two
 * guidances. Precision, graphics memory, schedule and the visualiser are machine
 * setup and were only crowding the column they shared. */
function extractSettings() {
  const grid = $("settingsParams");
  const adv = document.querySelector("details.adv .params");
  if (!grid || !adv) return;
  const move = (labelEl) => {
    if (!labelEl) return;
    const value = labelEl.nextElementSibling;      // the paired .pv cell
    grid.appendChild(labelEl);
    if (value) grid.appendChild(value);
  };
  move(document.querySelector('label[for="qTier"]'));
  move(document.querySelector('label[for="qModel"]'));
  move([...adv.querySelectorAll(".pk")].find((e) => e.textContent.trim().startsWith("Schedule")));
  move([...adv.querySelectorAll(".pk")].find((e) => e.textContent.trim().startsWith("Visualiser")));
  // The notes that belong with them travel too.
  const set = $("setNote");
  for (const id of ["modelNote", "tierHint"]) {
    const el = $(id);
    if (el) set.after(el);
  }
}

/* ── settings: output format + cover art ──────────────────
 *
 * Format applies to the NEXT render. Nothing already queued changes underneath
 * the user and the engine is not restarted, because the graph is rebuilt per
 * job — so this is genuinely a per-song choice rather than a mode.
 */
const FMT_NOTE = {
  flac: "Lossless. Lyrics and style are readable back out of the file, which is "
      + "how older takes recover their words.",
  mp3:  "About a seventh of the size — fifty songs is roughly 200 MB instead of "
      + "1.5 GB. Tags are copied without re-encoding, so nothing degrades.",
  opus: "Smallest for the quality, and the best choice if you are keeping "
      + "hundreds. Some older players do not read it.",
};
function paintFormat() {
  $("fmtNote").textContent = FMT_NOTE[$("qFormat").value] || "";
}
$("qFormat").onchange = async () => {
  paintFormat();
  await fetch("/api/format", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format: $("qFormat").value }),
  });
};
$("qArt").onchange = async () => {
  await fetch("/api/art", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "enable", value: $("qArt").value === "1" }),
  });
};
/* Provenance toggles (SPEC D5). Display and the Tier-2 record — the two
 * things that ARE the user's call. The Tier-1 AI marker has no control here
 * or anywhere; the Settings note beside these explains why. */
async function provSettingsSend(patch) {
  const r = await (await fetch("/api/provenance/settings", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })).json();
  if (r.provenance) state.provenance = r.provenance;
}
$("qProvShow").onchange = () => provSettingsSend({ showBadges: $("qProvShow").value === "1" });
$("qProvEmbed").onchange = () => provSettingsSend({ embedRecord: $("qProvEmbed").value === "1" });
$("qStems").onchange = async () => {
  await fetch("/api/stems", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "when", value: $("qStems").value }),
  });
};
$("qVideo").onchange = async () => {
  const on = $("qVideo").value === "1";
  const r = await (await fetch("/api/video", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "enable", value: on }),
  })).json();
  // Follow the server rather than assuming: switching the model off also forces
  // `when` back to off there, and the control has to show that.
  $("qVideoWhen").disabled = !on;
  $("qVideoWhen").value = r.video?.when || "off";
  state.video = { ...(state.video || {}), ...(r.video || {}) };
  ovPaintPlan();
};
$("qVideoWhen").onchange = async () => {
  const r = await (await fetch("/api/video", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "when", value: $("qVideoWhen").value }),
  })).json();
  if (r.error) { alert(r.error); $("qVideoWhen").value = state.video?.when || "off"; return; }
  state.video = { ...(state.video || {}), ...(r.video || {}) };
};
/* Folders. The only two settings that persist to disk, and the only two that
 * need a restart — the engine takes them as launch arguments, so pretending
 * they apply immediately would mean songs written somewhere the library is not
 * looking, with no error to explain it. */
$("btnSaveDirs").onclick = async () => {
  const body = { outputDir: $("qOutDir").value.trim(), rig: $("qRigDir").value.trim() };
  $("btnSaveDirs").disabled = true;
  try {
    const r = await (await fetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })).json();
    $("dirsNote").textContent = r.error || r.note || "Saved.";
    $("dirsNote").classList.toggle("warn", !!r.error);
  } finally {
    $("btnSaveDirs").disabled = false;
  }
};
$("qLyrics").onchange = async () => {
  await fetch("/api/lyrics", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "when", value: $("qLyrics").value }),
  });
};
/* Covers live beside the audio as loose PNGs; this puts them INSIDE it.
 *
 * Separate from "draw any missing covers" because it is a different operation
 * with a different cost: each file is re-tagged in full, so this is minutes for
 * a large library, and it is worth being an explicit choice rather than a
 * surprise. New songs embed automatically as their art lands. */
$("btnEmbedArt").onclick = async () => {
  const b = $("btnEmbedArt");
  b.disabled = true;
  const was = b.textContent;
  b.textContent = "Embedding…";
  try {
    const r = await (await fetch("/api/art", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "embed" }),
    })).json();
    if (r.library) state.library = r.library;
    $("artNote").textContent = r.done || r.failed
      ? `${r.done} embedded${r.failed ? `, ${r.failed} failed` : ""}`
        + (r.skippedMp3 ? ` · ${r.skippedMp3} MP3s skipped (ID3 pictures are not supported yet)` : "")
      : "Every cover is already inside its file.";
  } finally {
    b.disabled = false;
    b.textContent = was;
  }
};

$("btnBackfillArt").onclick = async () => {
  const b = $("btnBackfillArt");
  b.disabled = true;
  try {
    const r = await fetch("/api/art", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "backfill" }),
    }).then((x) => x.json());
    $("artNote").textContent = r.queued
      ? `${r.queued} queued. They are drawn only while nothing is generating, so music never waits.`
      : "Every track already has a cover.";
  } finally {
    b.disabled = false;
  }
};

/* ── models ───────────────────────────────────────────────
 *
 * The screen that makes every optional feature real for someone who did not
 * build this. Each capability states what it needs, how large that is, and under
 * what licence — and downloads only when asked. A capability whose python
 * package is missing says so rather than failing later with a stack trace.
 */
const gb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.round(n / 1e6)} MB`);

async function loadModels() {
  let d = null;
  try { d = await (await fetch("/api/models")).json(); } catch { /* server busy */ }
  if (!d?.capabilities) return;
  // Music-only lists the two YuE2 builds it can run: native GGUF, and the ComfyUI checkpoint.
  if (state.musicOnly) d.capabilities = d.capabilities.filter(c => c.nativeSetup || c.id === "musicYue2Comfy");
  state.models = d;

  const missing = d.capabilities.filter((c) => !c.ready && !c.managedByPackage).length;
  $("modelPip").hidden = missing === 0;

  // Free space next to the download buttons: "12.45 GB to download" is only half
  // the question, and running out mid-download leaves a .part and a puzzle.
  const disk = d.disk ? ` · ${gb(d.disk.freeBytes)} free on disk` : "";
  $("modelsTotal").textContent =
    `${d.capabilities.filter((c) => c.ready).length} of ${d.capabilities.length} ready${disk}`;
  state.diskFree = d.disk?.freeBytes ?? Infinity;
  if (d.musicModels) state.musicModels = d.musicModels;
  const htmls = d.capabilities.map((c) => {
    /* The native GGUF card carries its OWN progress now. It used to show only
     * "Setup needed" and a button to the Music tab, so a download started there
     * was invisible from the Models screen — the screen people watch downloads
     * on. It runs on any card now: setup fetches the audio.cpp build that fits
     * it (CUDA, Vulkan or CPU), and the card says which. */
    if (c.nativeSetup) {
      const pr = c.progress, pct = pr?.total ? Math.round((100 * pr.received) / pr.total) : 0;
      const foot = c.downloading
          ? `<span class="mmiss">Installing…</span><button class="btn sm ghost" type="button" data-native-cancel>Cancel</button>`
          : `<span class="${c.ready ? "mok" : "mmiss"}">${c.ready ? "Ready" : "Setup needed"}</span>
             ${c.runtimeLabel ? `<span class="mmiss">${esc(c.ready && c.backend ? `runs on ${c.backend === "cpu" ? "the CPU" : c.backend}` : c.runtimeLabel)}</span>` : ""}
             <button class="btn sm" type="button" data-native-setup>Review Q4 / Q8 setup</button>`;
      return `<div class="modelcard${c.ready ? " ready" : ""}" data-cap="${esc(c.id)}">
      <div class="mhead"><b>${esc(c.label)}</b><span class="badge">optional</span><span class="mlic">${esc(c.licence)}</span></div>
      <p class="mwhy">${esc(c.why || "Native music generation without Python or ComfyUI.")}</p>
      <p class="hint">${esc(c.note || "Runtime and weights install together after explicit licence acceptance.")}</p>
      <div class="mfoot">${foot}</div>
      ${c.downloading ? `<div class="gpubar"><i style="width:${pct}%"></i></div>
        <p class="hint">${esc(pr?.file || "Preparing verified downloads")} · ${gb(pr?.received || 0)} of ${gb(pr?.total || 0)} (${pct}%)</p>` : ""}
      </div>`;
    }
    const pr = c.progress;
    const pct = pr && pr.total ? Math.round((pr.received / pr.total) * 100) : 0;
    /* Four distinct states, because they call for four different actions.
     *
     * The awkward one is a capability whose model is fetched by its own python
     * package (whisper): it has no files WE download, so an earlier version
     * showed "3.09 GB to download" next to no button at all. Say what actually
     * happens instead — the package pulls it the first time it runs. */
    const state_ =
      c.managedByPackage
        ? (c.packageReady
            ? `<span class="mok">✓ Ready</span><span class="mmiss">fetches ${gb(c.totalBytes)} the first time it runs</span>`
            : `<span class="mwarn">Needs the ${esc(c.needsPackage)} python package</span>`)
      : c.ready && c.packageReady ? `<span class="mok">✓ Ready</span>`
      : c.ready && !c.packageReady ? `<span class="mwarn">Weights ready · needs the ${esc(c.needsPackage)} python package</span>`
      : `<span class="mmiss">${gb(c.totalBytes - c.haveBytes)} to download</span>`;
    const need = c.totalBytes - c.haveBytes;
    const tooBig = need > (state.diskFree ?? Infinity);
    const btn = pr
      ? `<button class="btn sm ghost" data-mcancel="${c.id}">Cancel</button>`
      : (c.ready || c.managedByPackage)
        ? ""
        // Refuse up front rather than failing 80% through a 12 GB download.
        : tooBig
          ? `<span class="mwarn">Not enough free disk — needs ${gb(need)}</span>`
          // A region-locked capability starts DISABLED. The checkbox below
          // enables it; the server refuses regardless, so this is the honest
          // affordance rather than the enforcement.
          : c.gated
            // The built-in downloader has no credential path and must not grow
            // one — a token belongs in the user's keychain, not this app.
            ? `<span class="mwarn">needs a HuggingFace login</span>`
            : `<button class="btn sm" data-mget="${c.id}"${c.region ? " disabled" : ""}>Download ${gb(need)}</button>`;
    return `
      <div class="modelcard${c.ready ? " ready" : ""}" data-cap="${esc(c.id)}">
        <div class="mhead">
          <b>${c.home
        ? `<a href="${esc(c.home)}" target="_blank" rel="noopener">${esc(c.label)}</a>`
        : esc(c.label)}</b>
          ${c.required ? '<span class="badge">required</span>' : ""}
          <span class="mlic">${esc(c.licence)}</span>
        </div>
        <p class="mwhy">${esc(c.why)}</p>
        ${c.requires ? `<div class="mreq">
          <span title="Graphics memory">VRAM ${c.requires.vramMinGb}+ GB<b> · ${c.requires.vramRecGb} recommended</b></span>
          <span title="System memory">RAM ${c.requires.ramMinGb}+ GB<b> · ${c.requires.ramRecGb} recommended</b></span>
          <span>Disk ${gb(c.totalBytes)}</span>
        </div>${c.requires.note ? `<p class="hint">${esc(c.requires.note)}</p>` : ""}` : ""}
        ${c.note ? `<p class="hint">${esc(c.note)}</p>` : ""}
        ${/* Gated repo: the publisher requires an accepted licence and a token.
             Say how, rather than showing a button that fails with a 401 that
             looks like a network problem. */
          c.gated && !c.ready ? `<div class="mregion">
          <b>Requires a HuggingFace account</b>
          <p>${esc(c.gated.how)}</p>
          <p><a href="${esc(c.gated.url)}" target="_blank" rel="noopener">Open the model page to accept the licence</a></p>
        </div>` : ""}
        ${/* The only capability here that is not Apache-2.0 or MIT. Its licence
             is territorial, so the choice has to be put in front of the person
             making it — before the button, not in a footnote after it. Studio
             hosts nothing; the link goes straight to the publisher. */
          /* Shown whether or not the weights are present. The restriction is on
             USING them, not on downloading them, so hiding this once a machine
             reads as "ready" would hide it from exactly the people it applies
             to. Only the acknowledgement is conditional — there is nothing left
             to gate once the files are already on disk. */
          c.region ? `<div class="mregion">
          <b>Not licensed in ${c.region.excluded.map(esc).join(", ")}</b>
          <p>${esc(c.region.text)}</p>
          ${c.ready
            ? `<p>These weights are already on this machine. <a href="${esc(c.region.url)}" target="_blank" rel="noopener">Read the licence</a> before using them.</p>`
            : `<label><input type="checkbox" data-mack="${c.id}">
            I am outside ${c.region.excluded.map(esc).join(", ")} and accept the
            <a href="${esc(c.region.url)}" target="_blank" rel="noopener">MiniMax H3 licence</a>.</label>`}
        </div>` : ""}
        ${c.variants?.length ? `<details class="mvar"><summary>Other builds of this model (${c.variants.length})</summary>
          <table>${c.variants.map((v) => `<tr><td>${esc(v.label)}</td><td class="n">${gb(v.bytes)}</td>
            <td class="vn">${esc(v.note || "")}</td></tr>`).join("")}</table></details>` : ""}
        <div class="mfoot">${state_}${btn}</div>
        ${pr ? `<div class="gpubar"><i style="width:${pct}%"></i></div>
                <p class="hint">${esc(pr.file || "")} · ${gb(pr.received)} of ${gb(pr.total)} (${pct}%)${
                  pr.state === "failed" ? ` — ${esc(pr.error || "failed")}` : ""}</p>` : ""}
      </div>`;
  });
  $("modelList").innerHTML = groupModelCards(d, htmls);

  $("modelsNote").textContent = d.python?.packages && !d.python.packages.torch
    ? (state.musicOnly ? "Native music mode needs no Python. Start full Studio for optional image, video and stem tools." : `No python found at ${d.python.path} — the stem and lyric features need it.`)
    : "";

  /* THE RECOMMENDATION, from the same payload and the same reading of the card.
   * Last, and after the list exists, because it stamps a fit badge onto the rows
   * above by their `data-cap`. web/modelfit.js renders it; nothing about which
   * model suits which machine is decided here or there — server/fit.js decided
   * it, and models_for_this_machine returns the same verdicts to an agent. */
  paintFit(d);
  paintLocal(d);
  paintModelMusicPanel();

  /* The native GGUF install is not a ModelManager download, so no "update"
   * push arrives while it runs. Poll instead, only while one is running and
   * only while the Models screen is on screen. */
  clearTimeout(nativeModelsPoll);
  if (d.capabilities.some((c) => c.nativeSetup && c.downloading)) {
    nativeModelsPoll = setTimeout(() => { if ($("modelList")?.offsetParent) loadModels(); }, 2000);
  }
}
let nativeModelsPoll = null;

/* The catalogue in collapsible sections, labelled and ordered by the server.
 * Music & audio starts open; a section with a download running is always open;
 * otherwise each keeps whatever the user last did with it. */
function groupModelCards(d, htmls) {
  if (state.musicOnly || !d.groups?.length) return htmls.join("");
  state.modelGroupsOpen ||= new Set(["music"]);
  const order = d.groups.map((g) => g.id);
  const labels = Object.fromEntries(d.groups.map((g) => [g.id, g.label]));
  const by = {};
  d.capabilities.forEach((c, i) => (by[c.group || "other"] ||= []).push(i));
  const rank = (g) => (order.includes(g) ? order.indexOf(g) : order.length);
  return Object.keys(by).sort((a, b) => rank(a) - rank(b)).map((g) => {
    const caps = by[g].map((i) => d.capabilities[i]);
    const ready = caps.filter((c) => c.ready).length;
    const open = caps.some((c) => c.progress) || state.modelGroupsOpen.has(g);
    return `<details class="mgroup" data-mgroup="${esc(g)}"${open ? " open" : ""}>
      <summary>${esc(labels[g] || g)}<span class="mgcount">${ready} of ${caps.length} ready</span></summary>
      <div class="mgbody">${by[g].map((i) => htmls[i]).join("")}</div>
    </details>`;
  }).join("");
}
/* `toggle` does not bubble, so listen in the capture phase. */
$("modelList").addEventListener("toggle", (e) => {
  const g = e.target;
  if (!g?.matches?.("details.mgroup")) return;
  state.modelGroupsOpen ||= new Set(["music"]);
  if (g.open) state.modelGroupsOpen.add(g.dataset.mgroup);
  else state.modelGroupsOpen.delete(g.dataset.mgroup);
}, true);
// Delegated once, at load, so the "show me this row" buttons survive repaints.
initFit();
initLocal(() => loadModels());
/* Advanced → Precision is the same choice as the music model picker. */
$("qModel")?.addEventListener("change", () => chooseMusicModel(`minimax-music3:${$("qModel").value}`));
/* The acknowledgement toggles its own card's button. Handled on `change` rather
 * than inside the click handler because ticking the box must not also start a
 * 34 GB download — two deliberate actions, in order. */
$("modelList").addEventListener("change", (e) => {
  const ack = e.target.closest("[data-mack]");
  if (!ack) return;
  const btn = $("modelList").querySelector(`[data-mget="${CSS.escape(ack.dataset.mack)}"]`);
  if (btn) btn.disabled = !ack.checked;
});

$("modelList").addEventListener("click", async (e) => {
  if (e.target.closest("[data-native-cancel]")) {
    await fetch("/api/music-gguf/setup", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }),
    }).catch(() => {});
    loadModels();
    return;
  }
  if (e.target.closest("[data-native-setup]")) {
    state.musicEngine = "yue2-gguf";
    setView("create"); musicEnginePaint();
    $("ggufSetup")?.scrollIntoView({ block: "center", behavior: "smooth" });
    refreshGgufSetup();
    return;
  }
  const get = e.target.closest("[data-mget]");
  const can = e.target.closest("[data-mcancel]");
  if (!get && !can) return;
  const ack = get && $("modelList").querySelector(`[data-mack="${CSS.escape(get.dataset.mget)}"]`);
  const r = await fetch("/api/models", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(get
      ? { action: "download", id: get.dataset.mget, acceptRegion: !!ack?.checked }
      : { action: "cancel", id: can.dataset.mcancel }),
  });
  // The server refuses region-locked weights independently of the checkbox, so
  // surface that refusal rather than repainting as if it had started.
  if (!r.ok) {
    const b = await r.json().catch(() => ({}));
    if (b.error) alert(b.error);
  }
  loadModels();
});

/* ── video ────────────────────────────────────────────────
 *
 * A third creator column. Clips made here are NOT library entries — they belong
 * to no song, so they live in the clips folder and are listed from it rather
 * than from the library sidecar.
 *
 * The most useful control is "open on a cover": H3's `first_frame` is optional,
 * and handing it the song's own artwork makes the clip read as that picture
 * moving, rather than a second unrelated image of the same track.
 */
// The model rounds UP to its own 17k+5 grid, so a "3 second" request is not 72
// frames. Showing the real number avoids a clip that is quietly longer than asked.
const alignedFrames = (secs) => { let n = Math.max(5, Math.round(secs * 24)); while (n % 17 !== 5) n++; return n; };

/* ONE reader for the video size, because there were two and a custom option
 * would have had to be added to both — which is how a pair drifts. The estimate
 * and the render must never disagree about what is being asked for. */
function vidWH() {
  if ($("vidSize").value === "custom") {
    return [Number($("vidW").value) || 1280, Number($("vidH").value) || 704];
  }
  return ($("vidSize").value || "1280x704").split("x").map(Number);
}

function vidPaint() {
  const on = !!state.video?.enabled;
  const engines = state.video?.engines || {};
  const cur = state.video?.engine || "ltx";
  const eng = engines[cur] || {};

  // Painted once; after that the select is left alone so it cannot fight a change.
  if (!state.vidEnginesPainted && Object.keys(engines).length) {
    state.vidEnginesPainted = true;
    vidModelShape();
    const opts = Object.entries(engines)
      .map(([k, e]) => '<option value="' + esc(k) + '">' + esc(e.label) + "</option>").join("");
    $("vidEngine").innerHTML = opts;
    $("qVideoEngine").innerHTML = opts;
  }
  $("vidEngine").value = cur;
  $("qVideoEngine").value = cur;

  /* Sizes are PER ENGINE and rebuilt on every switch. H3's native 1344x768 is
   * not a legal LTX size, and two of H3's four options quantise to something
   * else under LTX's halve-then-double pipeline — so the lists cannot be shared. */
  if (state.vidSizeFor !== cur && eng.sizes) {
    state.vidSizeFor = cur;
    $("vidSize").innerHTML = eng.sizes
      .map((z) => '<option value="' + z.w + "x" + z.h + '">' + esc(z.label) + "</option>").join("")
      + '<option value="custom">custom…</option>';
  }

  /* WHAT YOU WILL ACTUALLY GET. LTX renders at HALF and doubles back, flooring
   * each half to the 32px latent grid, so its real output is floor(n/64)*64.
   * Shown rather than silently applied: this app shipped a "960 x 544" option
   * that rendered 512 for months, directly under a comment warning about
   * exactly this flooring. */
  const vidCustom = $("vidSize").value === "custom";
  if ($("vidCustomL")) $("vidCustomL").hidden = !vidCustom;
  if ($("vidCustomW")) $("vidCustomW").hidden = !vidCustom;
  if (vidCustom && $("vidSizeNote")) {
    const w = Math.min(Math.max(Number($("vidW").value) || 1280, 256), 1920);
    const h = Math.min(Math.max(Number($("vidH").value) || 704, 256), 1920);
    const q = (n) => (cur === "ltx" ? Math.max(32, Math.floor(n / 2 / 32) * 32) * 2 : n);
    const rw = q(w), rh = q(h);
    const nat = eng.width && eng.height ? (w * h) / (eng.width * eng.height) : null;
    $("vidSizeNote").textContent =
      (rw !== w || rh !== h ? `renders ${rw}×${rh} · ` : "")
      + (nat ? `${Math.round(nat * 100)}% of native` : "")
      /* Both ends are worth saying. H3's own config records that 40% of native
       * pixels measured 2.7x worse, so small is not merely fast. */
      + (nat && nat > 1.6 ? " · slow" : nat && nat < 0.5 ? " · noticeably softer" : "");
  }

  $("vidCreate").disabled = !on;
  $("vidIntro").textContent = on
    ? "Short clips with " + (eng.label || "the video engine") + "."
    : "Video is switched off in Settings — switch it on there to render clips.";
  $("vidEngineNote").textContent = cur === "ltx"
    ? "Two passes: most of the sampling happens at half size, then a latent upscale and a short refine. Measured here at 121 s for 5 s of 1280x704 with sound. Takes exact frames (open on / end on / pass through) — references are an H3 feature."
    : "One pass at full size. Measured here at 308 s for 5 s at 1344x768, or 660 s at 20 steps. Takes references — pictures and sounds the description can call by name.";
  // LTX has no single step count — it is baked into two fixed sigma schedules.
  const stepRow = $("vidSteps").closest(".pv");
  if (stepRow) {
    stepRow.hidden = cur === "ltx";
    if (stepRow.previousElementSibling) stepRow.previousElementSibling.hidden = cur === "ltx";
  }
  $("vidSecsV").textContent = $("vidSecs").value + "s";
  $("vidStepsV").textContent = $("vidSteps").value;
  /* The quality chips are the step slider in three words; they hide with it
   * (LTX has no step count) and light up when the slider sits on their value.
   * Fast reads the server: 3 where the TaoMate build is on disk, else 8. */
  const qRow = $("vidQualityRow");
  if (qRow) {
    qRow.hidden = cur === "ltx";
    const fastSteps = eng.turbo3Ready ? 3 : 8;
    const stNow = +$("vidSteps").value;
    for (const b of qRow.querySelectorAll("[data-vq]")) {
      const want = b.dataset.vq === "fast" ? fastSteps : b.dataset.vq === "standard" ? 8 : 20;
      b.setAttribute("aria-pressed", stNow === want ? "true" : "false");
    }
    /* Without the TaoMate build Fast IS Standard (8 steps on the same model):
     * two chips doing one thing, lit together. Fast shows only when it is
     * really faster; the "!" says how to get it. */
    $("vidQFast").hidden = !eng.turbo3Ready;
    $("vidQualityNote").textContent = eng.turbo3Ready
      ? "3 steps on the TaoMate build: as sharp as the 8-step build, a third less time."
      : "Install the TaoMate 3-step row on the Models screen and Fast drops to 3 steps.";
  }

  /* Loop only makes sense with an opening picture — the trick IS reusing that
   * same picture as the closing one, so with nothing to reuse there is nothing
   * to offer. */
  const hasFrame = !!$("vidFrom").value || !!state.frameUploads?.vidFrom;
  $("vidLoopRow").hidden = !hasFrame;
  /* A closing frame is offered whether or not there is an opening one — ending
   * ON a picture is a legitimate thing to ask for by itself. It is hidden only
   * while "seamless loop" is on, since that mode already decides the answer. */
  const looping = hasFrame && $("vidLoop").checked;
  $("vidToRow").hidden = looping;
  $("vidToNote").textContent = $("vidTo").value
    ? "The clip is steered to arrive on that picture. Both engines take it; H3 was trained with it, LTX applies it as a guide."
    : "Leave this alone unless you want the clip to land on a specific picture.";
  /* Waypoints ride the GUIDED path, which needs a picture at BOTH ends -- and
   * only LTX has that path. `videoGraphH3` does not take midFrames at all, so
   * offering this control with H3 selected would be a picker that silently does
   * nothing, which is the worst kind of control there is. */
  const hasEnd = looping || !!$("vidTo").value || !!state.frameUploads?.vidTo;
  $("vidMidRow").hidden = !(cur === "ltx" && hasFrame && hasEnd);

  /* References are H3's ref2va path; the LTX graph has no equivalent, so the
   * whole section hides rather than sitting there doing nothing. Anything
   * already attached is KEPT while hidden — switching engines back and forth
   * must not eat the user's references — and the submit only sends them when
   * H3 is the engine that will render. */
  $("vidRefWrap").hidden = cur !== "h3";
  /* The soundtrack works on BOTH engines now — LTX freezes the audio latent,
   * H3 freezes it AND anchors it so the model can read the vocal (the lip-sync
   * pair). The section shows everywhere. */
  $("vidSndWrap").hidden = false;
  const sndPicked = state.sndUpload || $("vidSndSong").value;
  $("vidSndRow").hidden = !sndPicked;
  $("vidSndWho").textContent = state.sndUpload ? state.sndUpload.label
    : ($("vidSndSong").selectedOptions[0]?.textContent || "");

  $("vidLoopNote").hidden = !hasFrame || !$("vidLoop").checked;
  $("vidLoopNote").textContent = cur === "ltx"
    ? "Uses the same picture at both ends. This drops the two-pass upscale — the vendor's first-and-last graph is single pass — so it is slower per pixel but the clip cuts to its own beginning."
    : "Uses the same picture at both ends, so the clip cuts back to its own beginning.";

  /* `frame hold` is the strength the first and last frames are pinned at, and it
   * is the dial that decides whether a loop MOVES. At 100% the ends dominate and
   * the middle stalls; the vendor ships 70%, which measurably still animates. */
  $("vidPinLabel").hidden = !hasFrame;
  $("vidPin").closest(".pv").hidden = !hasFrame;
  $("vidPinV").textContent = $("vidPin").value + "%";
  $("vidGuideV").textContent = (+$("vidGuide").value).toFixed(1).replace(/\.0$/, "");
  $("vidNeg").placeholder = cur === "ltx"
    ? "pc game, console game, cartoon, childish, ugly" : "(H3 takes no negative prompt)";
  $("vidNeg").disabled = cur !== "ltx";
  $("vidAdvNote").textContent = cur === "ltx"
    ? "Guidance moves BOTH the video and audio scales together on purpose: when they differ, LTX takes a path that doubles the work on every step."
    : "H3 has no negative prompt and no dual guidance — its distilled path runs at a fixed guidance.";
  const bits = [];
  if ($("vidSeed").value.trim()) bits.push("seed " + $("vidSeed").value.trim());
  if (+$("vidGuide").value !== 1) bits.push("guidance " + $("vidGuide").value);
  if (hasFrame && +$("vidPin").value !== 70) bits.push("hold " + $("vidPin").value + "%");
  $("vidAdvState").textContent = bits.join(" · ");

  // Only songs that HAVE a cover can lend a first frame.
  const withArt = (state.library || []).filter((t) => t.cover);
  // Renamed: `cur` is the ENGINE above. This is the selected cover.
  const curCover = $("vidFrom").value;
  $("vidFrom").innerHTML = '<option value="">Start from nothing</option>'
    + withArt.map((t) => `<option value="${esc(t.cover)}" data-caption="${esc(t.caption || "")}" data-title="${esc(t.title || "")}">${esc(t.title || t.file)}</option>`).join("");
  $("vidFrom").value = curCover;
  const curTo = $("vidTo").value;
  $("vidTo").innerHTML = '<option value="">Let it end wherever it goes</option>'
    + withArt.map((t) => `<option value="${esc(t.cover)}" data-title="${esc(t.title || "")}">${esc(t.title || t.file)}</option>`).join("");
  $("vidTo").value = curTo;
  /* ANY song can lend its sound as a reference — unlike the frame dropdowns,
   * no cover is needed. This select is an action, not a state: picking adds a
   * chip and it snaps back to the placeholder, so no value to preserve. */
  $("vidRefSong").innerHTML = '<option value="">Add a song from the library…</option>'
    + (state.library || []).map((t) => `<option value="${esc(t.file)}">${esc(t.title || t.file)}</option>`).join("");
  // The soundtrack select IS state (like vidFrom), so its value is preserved.
  const curSnd = $("vidSndSong").value;
  $("vidSndSong").innerHTML = '<option value="">No soundtrack — the engine makes its own</option>'
    + (state.library || []).map((t) => `<option value="${esc(t.file)}">${esc(t.title || t.file)}</option>`).join("");
  $("vidSndSong").value = curSnd;

  paintFramePreviews();

  /* Cost model fitted to four measured points (see config.video). Superlinear in
   * pixels x frames, because attention is quadratic in token count — a linear
   * rate under-quotes the native size by well over a minute. */
  const [w, h] = vidWH();
  const fps = eng.fps || 24;
  // Frame rule differs: H3 rounds up to n mod 17 == 5, LTX is fps * seconds + 1.
  const frames = eng.frameRule === "fpsPlus1"
    ? Math.round(+$("vidSecs").value * fps) + 1
    : alignedFrames(+$("vidSecs").value);
  const mpxf = (w * h * frames) / 1e6;
  const stepScale = cur === "ltx" ? 1 : (+$("vidSteps").value) / 8;
  const secs = Math.round((eng.costFixedSeconds ?? 15)
    + (eng.costRate ?? 0.84) * Math.pow(mpxf, eng.costExponent ?? 1.2) * stepScale);

  /* ⚠ Below the trained range the model falls apart, and that is not obvious
   * from a slider. 124 frames is the documented floor; under it you get the
   * short-clip morphing rather than a shorter good clip. */
  /* H3-only warnings: below its trained range it morphs and below native size it
   * softens. Neither applies to LTX, which is BUILT around sampling small. */
  const short = cur !== "ltx" && frames < 124;
  const small = cur !== "ltx" && w * h < 1280 * 720;
  /* WHICH DISTILLATION THE STEP COUNT LANDS ON — and the thresholds now come
   * from the server rather than being retyped here. They were hardcoded as 8
   * and 12, then a 4-step build was added to config.js with its own threshold
   * (turbo4MaxSteps: 5) and this copy never learned about it. The result was a
   * warning that fired at 4-5 steps, where the 4-step LoRA is exactly the right
   * one to load, and stayed silent at 6-7, which is the only range where the
   * step count really is below what any available build was distilled for. */
  const st = +$("vidSteps").value;
  const t4 = eng.turbo4MaxSteps ?? 5;
  const t8 = eng.turboMaxSteps ?? 12;
  /* ⚠ THE REFERENCE PATH HAS NO 8-STEP BUILD. Three turbo files ship: a ref2v
   * 4-step, an fl2v 4-step and an fl2v 8-step. With reference images attached
   * the render uses the ref2v checkpoint, and the only distillation matching it
   * is the 4-step one — so between t4 and t8 the fallback resolves to that
   * 4-step file and runs it at up to 12 steps. config.js names that exact move:
   * "a distillation trained for 4 steps run at 8 is not a faster model, it is a
   * different one used wrongly."
   *
   * There is no good option in that band on this path, so it is named rather
   * than quietly used: 4 for the matched build, or 13+ for the bare model on
   * its native schedule (measured cleanest at 20 with shift 12). */
  const hasRefs = ((state.refImages || []).length + (state.refAudios || []).length) > 0;
  const stepPath = cur === "ltx" ? ""
    : st <= t4 ? " · " + t4 + "-step turbo path"
    : st <= t8 ? (hasRefs ? " · " + t4 + "-step build run at " + st + " steps"
                          : " · 8-step turbo path")
    : " · full-model path";
  const refMismatch = cur !== "ltx" && hasRefs && st > t4 && st <= t8;
  const betweenBuilds = cur !== "ltx" && !hasRefs && st > t4 && st < 8;

  $("vidEst").textContent = on
    ? "about " + fmt(secs) + " once the engine is idle · " + frames + " frames at " + fps + " fps"
      + (short ? " · ⚠ under the model's trained range (124+)" : "")
      + (small && !short ? " · ⚠ below native size, expect softer detail" : "")
      // Only 6-7 is genuinely orphaned: at or below t4 the 4-step build loads,
      // at 8 and up the 8-step one does, and between them neither fits.
      + (refMismatch ? " · ⚠ no reference build for " + st + " steps — use "
          + t4 + " (fast) or 13+ (best)" : "")
      + (betweenBuilds ? " · ⚠ between the " + t4 + "-step and 8-step builds — use " + t4 + " or 8" : "")
      + stepPath
      // Reference tokens are attended on every step, so they cost time. One
      // measured point: one picture at 864x480x124 added ~10% — more and
      // larger references cost more.
      + (cur === "h3" && ((state.refImages || []).length + (state.refAudios || []).length)
          ? " · references ride along, expect it slower" : "")
      + (cur === "ltx" && sndPicked ? " · the finished clip plays your chosen audio" : "")
    : "switch video on in Settings first";
}

for (const id of ["vidSecs", "vidSteps", "vidSize", "vidW", "vidH", "vidGuide", "vidPin", "vidSeed"]) $(id).oninput = vidPaint;
for (const b of document.querySelectorAll("#vidQualityRow [data-vq]")) {
  b.onclick = () => {
    const eng = (state.video?.engines || {})[$("vidEngine").value || state.video?.engine || "h3"] || {};
    const steps = b.dataset.vq === "fast" ? (eng.turbo3Ready ? 3 : 8) : b.dataset.vq === "standard" ? 8 : 20;
    $("vidSteps").value = String(steps);
    vidPaint();
  };
}
$("vidTo").onchange = () => {
  if ($("vidTo").value && state.frameUploads?.vidTo) {
    URL.revokeObjectURL(state.frameUploads.vidTo.url);
    delete state.frameUploads.vidTo;
    $("vidToPick").textContent = "Use a file…";
  }
  vidPaint();
};
$("vidLoop").onchange = vidPaint;
$("vidSeedRand").onclick = () => {
  $("vidSeed").value = Math.floor(Math.random() * 4294967296);
  vidPaint();
};

/* ── your own video model ──────────────────────────────────────────────────
 * The engines above are MiniMax H3 and LTX, and each one normally loads the
 * files the catalogue fetched for it. A community model of either family is
 * the same architecture re-trained, so the engine's graph drives it with only
 * a name changed — which is what these four rows do. "Auto" everywhere is the
 * engine's own, which is what runs when nothing is touched.
 *
 * The audio VAE row appears for H3 alone: LTX's graph has no audio decoder to
 * replace, and offering a control that does nothing is the failure this
 * codebase keeps writing down. */
let vidShelf = null;           // { models, encoders, vaes } from /api/videomodels

async function vidLoadModels() {
  if (vidShelf) return vidShelf;
  try { vidShelf = await (await fetch("/api/videomodels")).json(); }
  catch { vidShelf = { models: [], encoders: [], vaes: [] }; }
  return vidShelf;
}

async function vidModelShape() {
  const eng = $("vidEngine").value || state.video?.engine || "h3";
  const shelf = await vidLoadModels();
  /* Files this engine can drive, plus the ones it cannot — those are shown
   * greyed WITH THE REASON, so a misplaced or mis-detected file is visible
   * rather than mysteriously absent. With nothing usable at all that list is
   * every image model on the disk and no help, so it collapses to one line. */
  const usable = (shelf.models || []).filter((m) => m.ok && m.engine === eng);
  const mine = usable.length
    ? [...usable, ...(shelf.models || []).filter((m) => !usable.includes(m))]
    : [];
  const box = $("vidModelRow");
  if (box) box.hidden = false;
  const label = (m) => m.name + (m.family ? "  ·  " + m.family : "")
    + (m.bytes ? "  ·  " + (m.bytes / 1e9).toFixed(1) + " GB" : "");
  $("vidModel").innerHTML = '<option value="auto">auto &middot; the files this engine came with</option>'
    + (mine.length ? "" : '<option value="" disabled>nothing of your own in models/diffusion_models that this engine can load</option>')
    + mine.map((m) =>'<option value="' + esc(m.name) + '"' + (m.ok ? "" : " disabled")
      + ' title="' + esc(m.why || m.family || "") + '">' + esc(label(m))
      + (m.ok ? "" : "  —  cannot drive a video render") + "</option>").join("");
  const shelfOpts = (rows, what) => '<option value="auto">auto &middot; the ' + what + " this engine came with</option>"
    + rows.map((r) => '<option value="' + esc(r.name) + '">' + esc(r.name) + "</option>").join("");
  $("vidEncoder").innerHTML = shelfOpts(shelf.encoders || [], "text encoder");
  $("vidVideoVae").innerHTML = shelfOpts(shelf.vaes || [], "video VAE");
  $("vidAudioVae").innerHTML = shelfOpts(shelf.vaes || [], "audio VAE");
  /* LTX has no audio decoder in its graph, so there is nothing to replace. */
  for (const id of ["vidAudioVaeL", "vidAudioVaeW"]) { const el = $(id); if (el) el.hidden = eng !== "h3"; }
}

/** What the render should be pointed at, or nothing when it is all auto. */
function vidModelChoice() {
  const pick = (id) => { const el = $(id); return el && !el.closest("[hidden]") && el.value && el.value !== "auto" ? el.value : undefined; };
  return {
    modelFile: pick("vidModel"),
    encoder: pick("vidEncoder"),
    videoVae: pick("vidVideoVae"),
    audioVae: pick("vidAudioVae"),
  };
}

async function setVideoEngine(v) {
  const r = await (await fetch("/api/video", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "engine", value: v }),
  })).json();
  if (r.error) { alert(r.error); return false; }
  state.video = { ...(state.video || {}), engine: v };
  state.vidSizeFor = null;          // force the size list to rebuild
  vidPaint();
  return true;
}
$("ovEngine").onchange = async () => {
  if (!(await setVideoEngine($("ovEngine").value))) $("ovEngine").value = state.video?.engine || "ltx";
};
$("vidEngine").onchange = async () => {
  if (!(await setVideoEngine($("vidEngine").value))) $("vidEngine").value = state.video?.engine || "ltx";
  /* The model shelf is per engine: an LTX file cannot drive H3. */
  vidModelShape();
};
$("qVideoEngine").onchange = async () => {
  if (!(await setVideoEngine($("qVideoEngine").value))) $("qVideoEngine").value = state.video?.engine || "ltx";
};

/**
 * Show the chosen frames, and say when their shape disagrees with the render.
 *
 * Covers are 1:1. Every size either engine offers is 16:9 or 9:16, because that
 * is what they are trained at — there is deliberately no square option. So a
 * cover used as a first frame is ALWAYS the wrong shape, and the model has to
 * squash it or crop it. That is a real effect on the output and it was
 * happening with nothing on screen to explain it.
 *
 * The tolerance is 12%: enough that 1280x704 (1.82) against 1280x720 (1.78)
 * stays quiet, tight enough that a square against any of them does not.
 */
function paintFramePreviews() {
  const shapes = [];
  for (const [sel, box, img, meta] of [
    ["vidFrom", "vidFromPrev", "vidFromImg", "vidFromMeta"],
    ["vidTo", "vidToPrev", "vidToImg", "vidToMeta"],
  ]) {
    /* An uploaded picture WINS over the dropdown. Both can be set — you might
     * pick a cover, change your mind and choose a file — and silently preferring
     * the stale one is how you render the wrong thing and cannot see why. */
    const up = state.frameUploads?.[sel];
    const v = up ? up.name : $(sel).value;
    $(box).hidden = !v;
    if (!v) continue;
    // An upload is previewed from the browser's own copy: it lives in ComfyUI's
    // input directory, which Studio does not serve, and adding a route to serve
    // arbitrary input files would be a worse trade than an object URL.
    const src = up ? up.url : `/api/cover/${encodeURIComponent(v)}`;
    if ($(img).getAttribute("src") !== src) $(img).src = src;
    const probe = new Image();
    probe.onload = () => {
      const ar = probe.naturalWidth / probe.naturalHeight;
      $(meta).textContent = `${probe.naturalWidth}x${probe.naturalHeight} · ${ar.toFixed(2)}:1`;
      shapes.push(ar);
      checkShape(shapes);
    };
    probe.src = src;
  }
  if (!$("vidFrom").value && !$("vidTo").value
      && !state.frameUploads?.vidFrom && !state.frameUploads?.vidTo) {
    $("vidShapeNote").hidden = true;
  }
}

function checkShape(shapes) {
  if (!shapes.length) { $("vidShapeNote").hidden = true; return; }
  const [w, h] = vidWH();
  const want = w / h;
  /* Aspect ratios compare in LOG space, not linearly.
   *
   * Linearly, a square cover looks "closer" to 9:16 (0.55) than to 16:9 (1.82)
   * — 0.45 away versus 0.82 — so the naive version recommended a vertical render
   * for a square picture. But 1/1.82 = 0.55: those two are the same shape turned
   * on its side and crop a square by exactly the same amount. |ln(a/b)| says so
   * and linear subtraction does not. */
  const dist = (a, b) => Math.abs(Math.log(a / b));
  const worst = shapes.reduce((a, b) => (dist(b, want) > dist(a, want) ? b : a));
  const off = dist(worst, want);
  if (off < 0.12) { $("vidShapeNote").hidden = true; return; }

  // Offer the closest size the ACTIVE engine actually has, rather than inventing
  // one: an untrained aspect is how you get the stretched, mushy output this
  // note exists to prevent.
  const sizes = [...$("vidSize").options].map((o) => {
    const [a, b] = o.value.split("x").map(Number);
    return { value: o.value, ar: a / b, label: o.textContent };
  });
  const best = sizes.reduce((p, c) => (dist(c.ar, worst) < dist(p.ar, worst) ? c : p));
  // Only worth interrupting for if it is a MEANINGFUL improvement. For a square
  // cover every option is equidistant, and the honest answer there is "there is
  // no right size", not a coin-flip recommendation.
  const bestOff = dist(best.ar, worst);
  $("vidShapeNote").hidden = false;
  $("vidShapeNote").innerHTML =
    `Your picture is ${worst.toFixed(2)}:1 but you are rendering ${want.toFixed(2)}:1, so it will be `
    + `squashed or cropped to fit. `
    + (bestOff < off * 0.75
        ? `<button type="button" class="linkbtn" id="vidFitBtn">Use ${esc(best.label.split("·")[0].trim())} instead</button>`
        : `Neither engine is trained on square, so there is no size that matches a cover exactly — expect some cropping.`);
  const btn = $("vidFitBtn");
  if (btn) btn.onclick = () => { $("vidSize").value = best.value; vidPaint(); };
}

/**
 * Upload a picture to use as a frame.
 *
 * The bytes go to the server, which checks them, names the file itself and puts
 * it where ComfyUI can read it. What comes back is that name — the page never
 * chooses it. The local File is kept only to draw the preview.
 */
async function pickFrame(selId, fileId) {
  const f = $(fileId).files?.[0];
  if (!f) return;
  const btn = $(selId === "vidFrom" ? "vidFromPick" : "vidToPick");
  const was = btn.textContent;
  btn.textContent = "Uploading…";
  btn.disabled = true;
  try {
    const r = await (await fetch("/api/frame", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: f,
    })).json();
    if (r.error) throw new Error(r.error);
    state.frameUploads = state.frameUploads || {};
    // Release the previous object URL — a few of these per session is nothing,
    // but leaking them for the life of the page is untidy for no reason.
    if (state.frameUploads[selId]?.url) URL.revokeObjectURL(state.frameUploads[selId].url);
    state.frameUploads[selId] = { name: r.name, url: URL.createObjectURL(f), label: f.name };
    // The dropdown and the upload are two answers to one question; choosing a
    // file clears the other so the UI shows exactly what will be rendered.
    $(selId).value = "";
    btn.textContent = `${f.name.slice(0, 22)} ✕`;
    vidPaint();
  } catch (e) {
    alert(e.message);
    btn.textContent = was;
  } finally {
    btn.disabled = false;
    $(fileId).value = "";
  }
}

function wireFramePick(selId, fileId, btnId) {
  $(btnId).onclick = () => {
    // The same button clears the choice once one is made, so there is no extra
    // control sitting there doing nothing for the 90% case.
    if (state.frameUploads?.[selId]) {
      URL.revokeObjectURL(state.frameUploads[selId].url);
      delete state.frameUploads[selId];
      $(btnId).textContent = "Use a file…";
      vidPaint();
      return;
    }
    $(fileId).click();
  };
  $(fileId).onchange = () => pickFrame(selId, fileId);
}
wireFramePick("vidFrom", "vidFromFile", "vidFromPick");
wireFramePick("vidTo", "vidToFile", "vidToPick");

/* Waypoints — pictures the clip passes THROUGH.
 *
 * Separate from `pickFrame` on purpose: that one owns a single slot and the
 * button doubles as its clear control, which does not extend to a list. This
 * keeps its own array and its own previews.
 *
 * Capped at four. A guide every few frames leaves the sampler no room to move
 * anything and the clip degrades into a crossfade of stills — measured at 27
 * guides over 121 frames. Four across a clip is about what the reference
 * implementations use.
 */
const MID_MAX = 4;

async function addMidFrames(files) {
  state.midFrames = state.midFrames || [];
  const room = MID_MAX - state.midFrames.length;
  if (room <= 0) return;
  const btn = $("vidMidPick");
  const was = btn.textContent;
  btn.disabled = true;
  try {
    for (const f of [...files].slice(0, room)) {
      btn.textContent = `Uploading ${state.midFrames.length + 1}/${MID_MAX}…`;
      const r = await (await fetch("/api/frame", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: f,
      })).json();
      if (r.error) throw new Error(r.error);
      state.midFrames.push({ name: r.name, url: URL.createObjectURL(f), label: f.name });
    }
  } catch (e) {
    alert(e.message);
  } finally {
    btn.textContent = was;
    btn.disabled = false;
    $("vidMidFile").value = "";
    paintMidFrames();
  }
}

function paintMidFrames() {
  const list = state.midFrames || [];
  const box = $("vidMidPrev");
  box.hidden = !list.length;
  $("vidMidClear").hidden = !list.length;
  $("vidMidPick").hidden = list.length >= MID_MAX;
  /* Say WHERE each one lands, as a share of the clip. A frame number would mean
   * guessing the engine's frame rate here and would be wrong the moment that
   * changed; the spacing is (i+1)/(n+1) by construction, so a percentage is
   * exact whatever the clip's length turns out to be. */
  box.innerHTML = list.map((m, i) => {
    const pct = Math.round((100 * (i + 1)) / (list.length + 1));
    return `<figure class="midthumb">
      <img src="${esc(m.url)}" alt="">
      <figcaption>${pct}% in
        <button class="midx" type="button" data-midx="${i}" title="Remove">✕</button></figcaption>
    </figure>`;
  }).join("");
}

$("vidMidPick").onclick = () => $("vidMidFile").click();
$("vidMidFile").onchange = () => addMidFrames($("vidMidFile").files || []);
$("vidMidClear").onclick = () => {
  for (const m of state.midFrames || []) URL.revokeObjectURL(m.url);
  state.midFrames = [];
  paintMidFrames();
};
$("vidMidPrev").addEventListener("click", (e) => {
  const b = e.target.closest("[data-midx]");
  if (!b) return;
  const i = Number(b.dataset.midx);
  const [gone] = (state.midFrames || []).splice(i, 1);
  if (gone) URL.revokeObjectURL(gone.url);
  paintMidFrames();
});

/* References — H3's ref2va path. The opposite of a frame or a waypoint: those
 * pin a picture AT a moment, a reference hands the model a subject and lets
 * the words place it. The prompt calls them by name — <Picture 1>, <Audio 2> —
 * ordinals per type, in the order shown here, which is why removing one
 * renumbers everything after it and the painter always re-derives the tags
 * from position rather than storing them.
 *
 * Caps are the ComfyUI node's own: nine pictures, three sounds. */
const REF_IMG_MAX = 9, REF_AUD_MAX = 3;

/* Drop a tag into the description at the caret, padded so it never welds onto
 * a neighbouring word. Focus returns to the textarea with the caret after the
 * tag, because the next thing typed is almost always "…doing something". */
function insertPromptTag(tag) {
  const t = $("vidPrompt");
  const s = t.selectionStart ?? t.value.length, e = t.selectionEnd ?? s;
  const before = t.value.slice(0, s), after = t.value.slice(e);
  const pad = before && !/\s$/.test(before) ? " " : "";
  const pad2 = after && !/^\s/.test(after) ? " " : "";
  t.value = before + pad + tag + pad2 + after;
  const at = (before + pad + tag).length;
  t.focus();
  t.setSelectionRange(at, at);
  paintRefTagNote();
}

async function addRefImages(files) {
  state.refImages = state.refImages || [];
  const room = REF_IMG_MAX - state.refImages.length;
  if (room <= 0) return;
  const btn = $("vidRefImgPick");
  const was = btn.textContent;
  btn.disabled = true;
  try {
    for (const f of [...files].slice(0, room)) {
      btn.textContent = `Uploading ${state.refImages.length + 1}/${REF_IMG_MAX}…`;
      const r = await (await fetch("/api/frame", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: f,
      })).json();
      if (r.error) throw new Error(r.error);
      state.refImages.push({ name: r.name, url: URL.createObjectURL(f), label: f.name });
    }
  } catch (e) {
    alert(e.message);
  } finally {
    btn.textContent = was;
    btn.disabled = false;
    $("vidRefImgFile").value = "";
    paintRefs();
  }
}

async function addRefAudioFile(f) {
  state.refAudios = state.refAudios || [];
  if (!f || state.refAudios.length >= REF_AUD_MAX) return;
  const btn = $("vidRefAudPick");
  const was = btn.textContent;
  btn.textContent = "Uploading…";
  btn.disabled = true;
  try {
    const r = await (await fetch("/api/refaudio", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: f,
    })).json();
    if (r.error) throw new Error(r.error);
    state.refAudios.push({ name: r.name, label: f.name, start: 0 });
  } catch (e) {
    alert(e.message);
  } finally {
    btn.textContent = was;
    btn.disabled = false;
    $("vidRefAudFile").value = "";
    paintRefs();
  }
}

function paintRefs() {
  const imgs = state.refImages || [];
  const auds = state.refAudios || [];
  const ibox = $("vidRefImgPrev");
  ibox.hidden = !imgs.length;
  /* `data-refname` carries the SERVER's staged name, not the blob URL. Added so
   * a surface that did not upload these pictures can still name them — the Video
   * lab's comparison renders the same references through several engines, and
   * without this the only reference identity in the DOM is an object URL that
   * means nothing to the render route. Additive: nothing reads it but that. */
  ibox.innerHTML = imgs.map((m, i) => `<figure class="midthumb" data-refname="${esc(m.name)}">
      <img src="${esc(m.url)}" alt="" data-reftag="&lt;Picture ${i + 1}&gt;" title="Insert the tag">
      <figcaption><button class="reftag" type="button"
        data-reftag="&lt;Picture ${i + 1}&gt;" title="Insert into the description">&lt;Picture ${i + 1}&gt;</button>
        <button class="midx" type="button" data-refimgx="${i}" title="Remove">✕</button></figcaption>
    </figure>`).join("");
  const abox = $("vidRefAudPrev");
  abox.hidden = !auds.length;
  abox.innerHTML = auds.map((a, i) => `<div class="refaud" data-refname="${esc(a.name)}" data-refstart="${Number(a.start) || 0}">
      <button class="reftag" type="button"
        data-reftag="&lt;Audio ${i + 1}&gt;" title="Insert into the description">&lt;Audio ${i + 1}&gt;</button>
      <span class="who" title="${esc(a.label)}">${esc(a.label)}</span>
      <label>from <input class="line sm num" type="number" min="0" step="1"
        value="${Number(a.start) || 0}" data-refaudstart="${i}"> s</label>
      <button class="midx" type="button" data-refaudx="${i}" title="Remove">✕</button>
    </div>`).join("");
  $("vidRefImgPick").hidden = imgs.length >= REF_IMG_MAX;
  $("vidRefAudPick").hidden = auds.length >= REF_AUD_MAX;
  $("vidRefSong").hidden = auds.length >= REF_AUD_MAX;
  $("vidRefClear").hidden = !(imgs.length || auds.length);
  $("vidRefCostNote").hidden = !(imgs.length || auds.length);
  paintRefTagNote();
}

/* Say when the description names a reference that is not attached — the render
 * would go ahead and the model would just see a strange word, which looks like
 * the model ignoring the user. The inverse (attached but never named) is fine:
 * references condition the render whether or not the words mention them. */
function paintRefTagNote() {
  const nImg = (state.refImages || []).length;
  const nAud = (state.refAudios || []).length;
  const bad = [];
  for (const m of $("vidPrompt").value.matchAll(/<\s*(Picture|Audio)\s+(\d+)\s*>/gi)) {
    const n = Number(m[2]);
    const have = /^p/i.test(m[1]) ? nImg : nAud;
    if (n < 1 || n > have) bad.push(`<${m[1]} ${n}>`);
  }
  $("vidRefTagNote").hidden = !bad.length;
  $("vidRefTagNote").textContent = bad.length
    ? `The description names ${bad.join(", ")} but no such reference is attached — add it, or fix the number.`
    : "";
}

$("vidRefImgPick").onclick = () => $("vidRefImgFile").click();
$("vidRefImgFile").onchange = () => addRefImages($("vidRefImgFile").files || []);
$("vidRefAudPick").onclick = () => $("vidRefAudFile").click();
$("vidRefAudFile").onchange = () => addRefAudioFile($("vidRefAudFile").files?.[0]);
$("vidRefSong").onchange = () => {
  const o = $("vidRefSong").selectedOptions[0];
  if (!o || !$("vidRefSong").value) return;
  state.refAudios = state.refAudios || [];
  if (state.refAudios.length < REF_AUD_MAX) {
    // The name is the library file itself — the server stages it for ComfyUI,
    // so there is no upload round-trip for a song already on disk.
    state.refAudios.push({ name: $("vidRefSong").value, label: o.textContent, start: 0 });
  }
  $("vidRefSong").value = "";
  paintRefs();
};
$("vidRefClear").onclick = () => {
  for (const m of state.refImages || []) URL.revokeObjectURL(m.url);
  state.refImages = [];
  state.refAudios = [];
  paintRefs();
};
$("vidRefWrap").addEventListener("click", (e) => {
  const tag = e.target.closest("[data-reftag]");
  if (tag) return insertPromptTag(tag.dataset.reftag.replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  const ix = e.target.closest("[data-refimgx]");
  if (ix) {
    const [gone] = (state.refImages || []).splice(Number(ix.dataset.refimgx), 1);
    if (gone) URL.revokeObjectURL(gone.url);
    return paintRefs();
  }
  const ax = e.target.closest("[data-refaudx]");
  if (ax) {
    (state.refAudios || []).splice(Number(ax.dataset.refaudx), 1);
    return paintRefs();
  }
});
$("vidRefAudPrev").addEventListener("input", (e) => {
  const inp = e.target.closest("[data-refaudstart]");
  if (!inp) return;
  const a = (state.refAudios || [])[Number(inp.dataset.refaudstart)];
  if (a) a.start = Math.max(0, Number(inp.value) || 0);
});
$("vidPrompt").addEventListener("input", paintRefTagNote);

/* Soundtrack — one audio, LTX only. The select is state (like vidFrom); an
 * uploaded file WINS over it and the button doubles as the clear control. */
$("vidSndSong").onchange = () => {
  if ($("vidSndSong").value && state.sndUpload) {
    state.sndUpload = null;
    $("vidSndPick").textContent = "Use a file…";
  }
  vidPaint();
};
$("vidSndPick").onclick = () => {
  if (state.sndUpload) {
    state.sndUpload = null;
    $("vidSndPick").textContent = "Use a file…";
    vidPaint();
    return;
  }
  $("vidSndFile").click();
};
$("vidSndFile").onchange = async () => {
  const f = $("vidSndFile").files?.[0];
  if (!f) return;
  const btn = $("vidSndPick");
  const was = btn.textContent;
  btn.textContent = "Uploading…";
  btn.disabled = true;
  try {
    const r = await (await fetch("/api/refaudio", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: f,
    })).json();
    if (r.error) throw new Error(r.error);
    state.sndUpload = { name: r.name, label: f.name };
    $("vidSndSong").value = "";
    btn.textContent = `${f.name.slice(0, 22)} ✕`;
    vidPaint();
  } catch (e) {
    alert(e.message);
    btn.textContent = was;
  } finally {
    btn.disabled = false;
    $("vidSndFile").value = "";
  }
};


$("vidFrom").onchange = () => {
  // Borrow the song's style as a starting description, but never overwrite words
  // already typed — losing a prompt to a dropdown is unforgivable.
  const o = $("vidFrom").selectedOptions[0];
  if (o?.dataset.caption && !$("vidPrompt").value.trim()) $("vidPrompt").value = o.dataset.caption;
  if ($("vidFrom").value && state.frameUploads?.vidFrom) {
    URL.revokeObjectURL(state.frameUploads.vidFrom.url);
    delete state.frameUploads.vidFrom;
    $("vidFromPick").textContent = "Use a file…";
  }
  vidPaint();
};
$("vidCreate").onclick = async () => {
  /* ⚠ THROUGH vidWH(), never by re-parsing the select. This line used to be
   * `$("vidSize").value.split("x").map(Number)`, which on the custom option
   * splits the literal string "custom" and yields [NaN] — so a custom size
   * showed correctly in the estimate and then rendered at the engine default.
   * Type 1920x1080, read "1920x1080", receive 1280x704.
   *
   * vidWH() was written to be the ONE reader for exactly this reason, and says
   * so in its own comment: "the estimate and the render must never disagree
   * about what is being asked for". This was the single call site that ignored
   * it, which is how the pair drifted apart again. */
  const [width, height] = vidWH();
  $("vidCreate").disabled = true;
  try {
    const r = await (await fetch("/api/video", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        prompt: $("vidPrompt").value,
        title: $("vidFrom").selectedOptions[0]?.dataset.title || "",
        fromCover: $("vidFrom").value || undefined,
        // Already sitting in ComfyUI's input directory, named by the server.
        fromUpload: state.frameUploads?.vidFrom?.name,
        seconds: +$("vidSecs").value, steps: +$("vidSteps").value,
        width, height, keepAudio: $("vidAudio").value === "1",
        loop: $("vidLoop").checked && !!$("vidFrom").value,
        // Ignored by the server when `loop` is set — the loop IS the closing
        // frame — but sent regardless so unticking loop restores the choice.
        toCover: $("vidTo").value || undefined,
        toUpload: state.frameUploads?.vidTo?.name,
        // Waypoints, in the order they were added. The server spaces them.
        midUploads: (state.midFrames || []).map((m) => m.name),
        /* Files named instead of the engine’s own; absent when all are auto. */
        ...vidModelChoice(),
        /* References, H3 only — kept client-side across an engine switch but
         * only SENT when H3 renders, so the server's refusal can never eat
         * work the user did under the other engine. Order matters: it is the
         * ordinal the prompt's <Picture n> / <Audio n> tags resolve to. */
        refImages: state.video?.engine === "h3"
          ? (state.refImages || []).map((m) => m.name) : undefined,
        refAudios: state.video?.engine === "h3"
          ? (state.refAudios || []).map((a) => ({ name: a.name, start: a.start || 0 })) : undefined,
        /* Soundtrack — both engines take it now. */
        audioTrack: (state.sndUpload || $("vidSndSong").value)
          ? { name: state.sndUpload?.name || $("vidSndSong").value,
              start: Math.max(0, +$("vidSndStart").value || 0) }
          : undefined,
        negative: $("vidNeg").value.trim() || undefined,
        // Blank means "surprise me" — the server rolls one and records it, so a
        // clip you like can still be reproduced afterwards.
        seed: $("vidSeed").value.trim() ? Number($("vidSeed").value.trim()) : undefined,
        guidance: +$("vidGuide").value,
        guideStrength: +$("vidPin").value / 100,
      }),
    })).json();
    if (r.error) { alert(r.error); return; }
    $("clipNote").textContent = "Queued. It renders once the engine is idle — music always goes first.";
  } finally {
    vidPaint();
  }
};

async function loadClips() {
  let d = null;
  try { d = await (await fetch("/api/clips")).json(); } catch { /* server busy */ }
  if (!d) return;
  state.clips = d.clips;
  /* ⚠ KEEP THE MEMORY CEILING. /api/clips sends `enhanceLimitBytes` for one
   * reason, and says so at the seam that writes it: "So the dialog's warning
   * and the route's refusal cannot disagree." This function dropped it, so
   * `state.enhanceLimitBytes` was never once set and the Enhance dialog fell
   * back to its 8 GB default — while the server's real ceiling here is
   * totalmem * 0.55, i.e. ~17.6 GB on 32 GB of RAM.
   *
   * The visible symptom: "Bigger" on an ordinary 5-second 1080p clip needs
   * ~12 GB, so the dialog greyed out its own button and told the user to try a
   * shorter clip, over a job the server accepts and completes. Measured: that
   * exact upscale ran at 12.0 GB peak, 38 times in a row. */
  if (d.enhanceLimitBytes) state.enhanceLimitBytes = d.enhanceLimitBytes;
  paintClips();
}

/* The clip library. Same job as the music library — find one out of dozens — so
 * it gets the same tools: search, filter, sort. Everything is client-side
 * because the whole list is already in memory and a round trip per keystroke
 * would be slower and worse. */
function paintClips() {
  /* Tear the hover preview down BEFORE the repaint. innerHTML is replaced below,
   * which detaches whatever tile the pointer is resting on — and no mouseout
   * ever fires for a node that was removed, so `hoverVid` would keep a detached
   * <video> alive until the next hover. Reachable without touching the mouse:
   * the poll-driven loadClips() repaints when a render finishes. */
  stopHoverPreview();
  const all = state.clips || [];
  const q = ($("clipSearch").value || "").toLowerCase().trim();
  const filter = $("clipFilter").value;
  const sort = $("clipSort").value;

  let rows = all.filter((c) => {
    /* A FINISHED FILM is one the Studio assembled — renderTimeline stamps
     * source:"timeline" when it writes the output, so this asks the library
     * what a clip IS rather than pattern-matching its name. A 600-clip folder
     * holds maybe a dozen of these and they are the only ones anybody wants to
     * show somebody. */
    if (filter === "finished" && c.meta?.source !== "timeline") return false;
    if (filter === "track" && !c.track) return false;
    if (filter === "standalone" && c.track) return false;
    if (filter === "loop" && !c.meta?.loop) return false;
    if (filter === "ltx" && c.meta?.engine !== "ltx") return false;
    if (filter === "h3" && c.meta?.engine !== "h3") return false;
    if (!q) return true;
    // Search the prompt too — for a standalone clip the prompt IS its name.
    return [c.title, c.name, c.meta?.prompt].filter(Boolean)
      .some((x) => String(x).toLowerCase().includes(q));
  });
  rows.sort((a, b) => (
    sort === "old" ? a.at - b.at
      : sort === "big" ? b.bytes - a.bytes
      : sort === "slow" ? (b.seconds || 0) - (a.seconds || 0)
      : b.at - a.at));

  $("vidCount").textContent = all.length
    ? (rows.length === all.length ? `${all.length} clip${all.length > 1 ? "s" : ""}`
                                  : `${rows.length} of ${all.length}`)
    : "";

  if (!rows.length) {
    $("clipGrid").innerHTML = all.length
      ? '<p class="clipempty">Nothing matches that.</p>'
      : '<p class="clipempty">No clips yet. Describe one on the left.</p>';
    return;
  }

  const mode = q ? "" : $("clipGroup").value;
  $("clipGrid").innerHTML = mode
    ? clipGroupedHtml(rows, mode)
    : `<div class="clipgridinner">${rows.map(clipCard).join("")}</div>`;
  observeLazyVideos($("clipGrid"));
}

/* Grouping, keyed the same way the music library keys it: an id per group, and
 * a Set of collapsed ids on `state` rather than in the DOM. Clips do not poll
 * as aggressively as tracks do, but putting the state in the same place means
 * one mental model instead of two. Ids are prefixed `c:` so they can never
 * collide with the track groups sharing `state.collapsed`. */
function clipGroupsOf(rows, mode) {
  const by = new Map();
  const put = (id, label, c) => {
    if (!by.has(id)) by.set(id, { id, label, items: [] });
    by.get(id).items.push(c);
  };
  for (const c of rows) {
    const m = c.meta || {};
    if (mode === "engine") {
      const e = m.engine === "ltx" ? "LTX 2.5" : m.engine === "h3" ? "MiniMax H3" : "Unknown engine";
      put(`c:e:${e}`, e, c);
    } else if (mode === "track") {
      // A clip made on its own has no song above it, and saying so is more use
      // than filing it under a blank heading.
      put(c.track ? `c:t:${c.track}` : "c:t:", c.title || (c.track ? "Untitled song" : "Made on their own"), c);
    } else {
      const d = new Date(c.at);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      put(`c:d:${day}`, day, c);
    }
  }
  const out = [...by.values()];
  // Days newest first; the others alphabetically, but "made on their own" last
  // because it is a fallback bucket rather than a name.
  if (mode === "day") out.sort((a, b) => b.id.localeCompare(a.id));
  else out.sort((a, b) => (a.id === "c:t:") - (b.id === "c:t:") || a.label.localeCompare(b.label));
  return out;
}

function clipGroupedHtml(rows, mode) {
  if (!state.collapsed) state.collapsed = new Set();
  return clipGroupsOf(rows, mode).map((g) => {
    const open = !state.collapsed.has(g.id);
    const secs = g.items.reduce((t, c) => t + (c.seconds || 0), 0);
    return `
      <div class="grp${open ? " open" : ""}">
        <button class="grphead" type="button" data-cgrp="${esc(g.id)}" aria-expanded="${open}">
          <span class="caret">${open ? "▾" : "▸"}</span>
          <span class="glabel">${esc(g.label)}</span>
          <span class="gmeta">${g.items.length} clip${g.items.length > 1 ? "s" : ""}${secs ? ` · ${fmt(secs)} of GPU` : ""}</span>
        </button>
        ${open ? `<div class="grpbody"><div class="clipgridinner">${g.items.map(clipCard).join("")}</div></div>` : ""}
      </div>`;
  }).join("");
}

/* ABSOLUTE, not "3 hours ago". A render library is something you scan for "the
 * batch I ran on Tuesday night", and a relative stamp makes two clips from one
 * session look unrelated the moment a day rolls over. The year is dropped when
 * it is this one — it is noise on every row until it isn't. */
function clipDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const opts = { day: "numeric", month: "short" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return `${d.toLocaleDateString(undefined, opts)} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function clipCard(c) {
  {
    const m = c.meta || {};
    const stem = c.name.replace(/\.(mp4|webm)$/, "");
    const badges = [
      m.engine === "ltx" ? "LTX" : m.engine === "h3" ? "H3" : null,
      m.loop ? "loop" : null,
      m.width && m.height ? `${m.width}×${m.height}` : null,
    ].filter(Boolean);
    return `<div class="clipcard" data-cview="${esc(c.name)}" title="Click to view large">
      ${/\.(png|jpg|jpeg|webp|gif)$/i.test(c.name)
        // Imported stills and audio live in the same folder as generated clips,
        // so this grid renders three kinds of thing now. A <video> pointed at a
        // PNG shows nothing and logs a media error on every repaint.
        ? `<img class="cthumb" src="/api/clip/${encodeURIComponent(c.name)}" alt="" loading="lazy">`
        : /\.(mp3|wav|flac|ogg|opus|m4a)$/i.test(c.name)
          ? `<audio src="/api/clip/${encodeURIComponent(c.name)}" controls preload="metadata"></audio>`
          /* A PICTURE, not a media element — and the history is the argument.
           *
           * This grid used to hold one <video> per clip. Carrying a plain src
           * they fetched even while the page was hidden (measured: 29 requests
           * and 4 MB before the user had looked at anything), so they moved to
           * data-src behind an observer. But DEFERRING is not the same as not
           * having them: the folder holds 438 clips now, and every tile that
           * scrolled into view still pulled 1-3 MB of MP4 to show ONE frame.
           *
           * The poster is ~25 KB — measured 111x and 181x smaller than the two
           * clips it was first tried on — and `loading="lazy"` is native on an
           * <img>, so no observer is needed here at all. The video is attached
           * on hover, one at a time, by the handler further down. */
          : `<img class="cthumb" src="/api/clipthumb/${encodeURIComponent(c.name)}" alt="" loading="lazy" decoding="async" data-vsrc="/api/clip/${encodeURIComponent(c.name)}">`}
      <div class="clipacts">
        <button data-cview="${esc(c.name)}" title="View large (also: click the clip)">&#10530; view</button>
        ${m.prompt ? `<button data-creuse="${esc(c.name)}" title="Load this clip's settings into the form">reuse</button>` : ""}
        <button data-cboost="${esc(c.name)}" title="Smoother and bigger in one click — steps down if this machine cannot hold it">✦ boost</button>
        <button data-cenh="${esc(c.name)}" title="Choose: smoother motion, slow motion, or a larger size">enhance</button>
        ${/\.(mp4|webm)$/i.test(c.name) ? `<button data-cext="${esc(c.name)}" title="Continue this clip: H3 picks up from its last second and renders what happens next">extend</button>` : ""}
        <button data-creveal="${esc(c.name)}" title="Show the file in Explorer">file</button>
        <button class="warn" data-ctrash="${esc(c.name)}" title="Move to trash — reversible">✕</button>
      </div>
      <div class="clipmeta">
        <b title="${esc(m.prompt || "")}">${esc(c.title || stem)}</b>
        ${badges.map((b) => `<span class="cbadge">${esc(b)}</span>`).join("")}
        <span>${c.at ? `${clipDate(c.at)} · ` : ""}${c.seconds ? `took ${fmt(c.seconds)} · ` : ""}${Math.round(c.bytes / 1024)} KB</span>
      </div>
    </div>`;
  }
}

/* -- the clip viewer -------------------------------------
 *
 * The grid shows a 25 KB poster per clip, which is the right call for 600 of
 * them and useless for actually WATCHING one. Clicking a poster now opens it
 * large, and -- the part that matters when reviewing a render -- steps to the
 * next clip without closing.
 *
 * It walks the SAME list the grid is showing, not the raw library: if you have
 * filtered to one project or sorted by newest, up and down follow what is on
 * screen. Stepping through a different order than the one you can see is
 * disorienting in a way that is hard to name and easy to feel.
 */
let clipView = { name: null, list: [] };

function clipViewList() {
  const src = (state.clipsShown && state.clipsShown.length) ? state.clipsShown : (state.clips || []);
  return src.map((c) => c.name).filter((n) => !/\.(mp3|wav|flac|ogg|opus|m4a)$/i.test(n));
}

function openClipView(name) {
  clipView.list = clipViewList();
  clipView.name = name;
  const box = $("clipView");
  if (!box) return;
  box.hidden = false;
  paintClipView();
}

function paintClipView() {
  const name = clipView.name;
  if (!name) return;
  const c = (state.clips || []).find((x) => x.name === name) || {};
  const m = c.meta || {};
  const at = clipView.list.indexOf(name);
  const isImg = /\.(png|jpg|jpeg|webp|gif)$/i.test(name);
  $("clipViewMedia").innerHTML = isImg
    ? `<img src="/api/clip/${encodeURIComponent(name)}" alt="">`
    : `<video src="/api/clip/${encodeURIComponent(name)}" controls autoplay loop playsinline></video>`;
  $("clipViewName").textContent = c.title || name;
  $("clipViewMeta").textContent = [
    m.engine ? String(m.engine).toUpperCase() : "",
    (m.width && m.height) ? `${m.width}x${m.height}` : "",
    c.seconds ? `took ${fmt(c.seconds)}` : "",
    c.bytes ? `${Math.round(c.bytes / 1024)} KB` : "",
  ].filter(Boolean).join("  .  ");
  $("clipViewPos").textContent = at >= 0 ? `${at + 1} / ${clipView.list.length}` : "";
  $("clipViewPrev").disabled = at <= 0;
  $("clipViewNext").disabled = at < 0 || at >= clipView.list.length - 1;
}

function clipViewStep(delta) {
  const at = clipView.list.indexOf(clipView.name);
  if (at < 0) return;
  const next = clipView.list[Math.min(clipView.list.length - 1, Math.max(0, at + delta))];
  if (!next || next === clipView.name) return;
  clipView.name = next;
  paintClipView();
}

function closeClipView() {
  const box = $("clipView");
  if (!box || box.hidden) return;
  /* Empty the container before hiding. A hidden <video> keeps playing -- the
   * element is still in the document, it is only invisible -- so closing on a
   * clip with sound would leave it audible with nothing on screen. */
  $("clipViewMedia").innerHTML = "";
  box.hidden = true;
  clipView.name = null;
}

document.addEventListener("click", (e) => {
  const open = e.target.closest("[data-cview]");
  /* The CARD carries data-cview, so every control inside it matches too. The
   * explicit view button is the one exception -- it carries its own. */
  const onControl = e.target.closest("a, audio, input, select, textarea")
    || (e.target.closest("button") && !e.target.closest("button[data-cview]"));
  if (open && !onControl) { e.preventDefault(); openClipView(open.dataset.cview); return; }
  if (e.target.closest("[data-cvprev]")) { clipViewStep(-1); return; }
  if (e.target.closest("[data-cvnext]")) { clipViewStep(1); return; }
  if (e.target.closest("[data-cvclose]")) { closeClipView(); return; }
  /* The backdrop closes; the video itself must not, or the transport controls
   * would be unusable. */
  const box = $("clipView");
  if (box && !box.hidden && e.target === box) closeClipView();
});

document.addEventListener("keydown", (e) => {
  const box = $("clipView");
  if (!box || box.hidden) return;
  if (e.target.matches("input, textarea, select")) return;
  if (e.key === "Escape") { e.preventDefault(); closeClipView(); }
  else if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); clipViewStep(-1); }
  else if (e.key === "ArrowDown" || e.key === "PageDown") { e.preventDefault(); clipViewStep(1); }
});

/* The wheel steps outright, with no mode to turn on -- unlike the image editor,
 * where the wheel already meant zoom and stepping had to be opt-in. Throttled
 * for the same reason: one flick of a wheel is a dozen events. */
{
  let lastStep = 0;
  document.addEventListener("wheel", (e) => {
    const box = $("clipView");
    if (!box || box.hidden) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastStep < 220) return;
    lastStep = now;
    clipViewStep(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });
}

/* ── Enhance ────────────────────────────────────────────────────────────────
 *
 * Four named outcomes, each expanding to the settings the server wants. The
 * table is the whole feature: everything else here is showing what it costs and
 * refusing when that is too much.
 */
const ENH_MODES = {
  smooth: { interpolate: true, upscale: false, multiplier: 2, slow: false, scale: 1 },
  slowmo: { interpolate: true, upscale: false, multiplier: 2, slow: true,  scale: 1 },
  bigger: { interpolate: false, upscale: true, multiplier: 1, slow: false, scale: 2 },
  both:   { interpolate: true, upscale: true, multiplier: 2, slow: false, scale: 2 },
};
let enhClip = null;
let enhMode = "smooth";

function openEnhance(name) {
  enhClip = (state.clips || []).find((c) => c.name === name) || null;
  if (!enhClip) return;
  enhMode = "smooth";
  for (const b of document.querySelectorAll(".enhopt")) b.classList.toggle("on", b.dataset.mode === "smooth");
  $("enhName").textContent = enhClip.title || enhClip.name;
  paintEnhance();
  $("enh").hidden = false;
}

/**
 * What this will produce, and whether it will fit.
 *
 * Mirrors `enhanceCost` on the server. The server's copy is the one that
 * refuses — a client can be stale, and the check that matters is the one a
 * hand-rolled request also hits — but a number shown BEFORE the click is worth
 * more to the person than an error shown after it.
 */
/**
 * The source clip's true shape, for the cost estimate.
 *
 * Recorded metadata first, then the `<video>` element the card is already
 * showing — it has loaded metadata to draw the preview, so its `videoWidth`,
 * `videoHeight` and `duration` are exact and cost nothing. The fallbacks are
 * deliberately LARGE rather than typical: an over-estimate shows a scary number,
 * an under-estimate runs the machine out of memory.
 */
function enhSource() {
  const meta = enhClip?.meta || {};
  const el = document.querySelector(`.clipcard video[src*="${encodeURIComponent(enhClip?.name || "")}"]`);
  const okDur = el && Number.isFinite(el.duration) && el.duration > 0;
  return {
    width: Number(meta.width) || el?.videoWidth || 1920,
    height: Number(meta.height) || el?.videoHeight || 1080,
    seconds: Number(meta.clipSeconds) || (okDur ? el.duration : 0) || 20,
  };
}

function paintEnhance() {
  const m = ENH_MODES[enhMode];
  const { width: w, height: h, seconds: secs } = enhSource();
  const frames = Math.round(secs * 24) * m.multiplier;
  const ow = Math.round(w * m.scale);
  const oh = Math.round(h * m.scale);
  const gb = (frames * ow * oh * 3 * 4) / 1e9;

  const parts = [`${w}×${h} → ${ow}×${oh}`, `${frames} frames`];
  if (m.slow) parts.push(`${secs.toFixed(1)}s → ${(secs * m.multiplier).toFixed(1)}s, no sound`);
  else if (m.interpolate) parts.push("24 → 48 fps, same length");
  if (gb > 1) parts.push(`about ${gb.toFixed(1)} GB memory`);
  $("enhCost").textContent = parts.join(" · ");

  /* Two different warnings, and they are not the same kind of thing. One is a
   * hard refusal; the other is the honest caveat about per-frame upscaling that
   * the catalogue entry also carries. Neither is hidden behind a tooltip. */
  const warn = $("enhWarn");
  // The server owns this number — it is the one that actually refuses. Falling
  // back to a small value rather than a large one keeps a stale client
  // conservative instead of encouraging a job the server will reject.
  const limit = (state.enhanceLimitBytes || 8e9) / 1e9;
  const tooBig = gb > limit;
  warn.hidden = !(tooBig || m.upscale);
  warn.textContent = tooBig
    ? `Too large — that needs about ${gb.toFixed(0)} GB of memory, and this machine `
      + `can safely give about ${limit.toFixed(0)} GB. Try a shorter clip.`
    : m.upscale
      ? "Upscaling works one frame at a time, so very fine texture can shimmer slightly."
      : "";
  warn.style.color = tooBig ? "" : "var(--ghost)";
  $("enhGo").disabled = tooBig;
}

$("enhOpts").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mode]");
  if (!b) return;
  enhMode = b.dataset.mode;
  for (const x of document.querySelectorAll(".enhopt")) x.classList.toggle("on", x === b);
  paintEnhance();
});
$("enhClose").onclick = () => { $("enh").hidden = true; };
$("enh").addEventListener("click", (e) => { if (e.target.id === "enh") $("enh").hidden = true; });

$("enhGo").onclick = async () => {
  if (!enhClip) return;
  const m = ENH_MODES[enhMode];
  const src = enhSource();
  const btn = $("enhGo");
  btn.disabled = true;
  try {
    const r = await (await fetch("/api/clips", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "enhance", name: enhClip.name,
        interpolate: m.interpolate, upscale: m.upscale,
        multiplier: m.multiplier, slow: m.slow, scale: m.scale,
        // What the cost line was computed from, so the server's refusal and the
        // number on screen cannot disagree. Clamped server-side, not trusted.
        srcWidth: src.width, srcHeight: src.height, seconds: src.seconds,
      }),
    })).json();
    if (r.error) { alert(r.error); return; }
    $("enh").hidden = true;
    // It joins the same queue as everything else, so the existing job strip
    // reports it and the grid picks the result up on its next load.
    loadClips();
  } finally {
    btn.disabled = false;
  }
};

/* Continue a clip. The sheet carries the source's own prompt so a plain
 * "Continue" keeps the same action going; edit the words to change it. */
let cextClip = null;
function openExtendClip(name) {
  cextClip = (state.clips || []).find((c) => c.name === name) || null;
  if (!cextClip) return;
  $("cextName").textContent = cextClip.title || cextClip.name;
  $("cextPrompt").value = cextClip.meta?.prompt || "";
  $("cextWarn").hidden = true;
  $("cext").hidden = false;
}
$("cextClose").onclick = () => { $("cext").hidden = true; };
$("cextGo").onclick = async () => {
  if (!cextClip) return;
  const btn = $("cextGo");
  btn.disabled = true;
  try {
    const r = await (await fetch("/api/video", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "extend", clip: cextClip.name,
        prompt: $("cextPrompt").value.trim() || undefined,
        seconds: Number($("cextSecs").value) || 3,
      }),
    })).json();
    if (r.error) { $("cextWarn").textContent = r.error; $("cextWarn").hidden = false; return; }
    $("cext").hidden = true;
    loadClips();
  } finally {
    btn.disabled = false;
  }
};

for (const id of ["clipSearch", "clipFilter", "clipSort", "clipGroup"]) {
  $(id).oninput = paintClips;
  $(id).onchange = paintClips;
}
$("clipGroup").onchange = () => {
  // Collapsed ids carry their mode ("c:d:" vs "c:e:"), so dropping the set on a
  // mode change starts fresh rather than half-collapsing the new grouping.
  state.collapsed = new Set();
  paintClips();
};

/* One observer for every lazy <video> on the page. Re-running it after a repaint
 * is safe: anything already given a src has no data-src left to match.
 *
 * ⚠ The clip grid no longer produces video[data-src] — its tiles are posters and
 * the video is attached on hover. This is kept for any other grid that still
 * emits one, and is a no-op for the clip library. */
let lazyVidIO = null;
function observeLazyVideos(root = document) {
  if (!root) return;
  if (!("IntersectionObserver" in window)) {
    root.querySelectorAll("video[data-src]").forEach((v) => { v.src = v.dataset.src; delete v.dataset.src; });
    return;
  }
  lazyVidIO ||= new IntersectionObserver((entries, obs) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const v = e.target;
      if (v.dataset.src) { v.src = v.dataset.src; v.preload = "metadata"; delete v.dataset.src; }
      obs.unobserve(v);
    }
  }, { rootMargin: "300px 0px", threshold: 0.01 });
  root.querySelectorAll("video[data-src]").forEach((v) => lazyVidIO.observe(v));
}

/* Hover preview, on a DWELL timer.
 *
 * The tiles are posters precisely so the grid stops pulling megabytes of MP4 to
 * show single frames, and attaching a <video> on every mouseover hands that
 * straight back: dragging across twenty tiles starts twenty full-clip fetches
 * and cancels nineteen of them a few milliseconds later. /api/clip/ sets no
 * Cache-Control either, so a second pass over the same tile refetches.
 *
 * A ~180ms dwell is what fixes it — not element reuse, which was the first idea
 * and does nothing: assigning .src to a reused element and calling play() issues
 * the identical request. One element at a time is still torn down properly
 * (removeAttribute then load(), or Chrome keeps the buffer for a src-less node).
 *
 * mouseover/mouseout rather than mouseenter/mouseleave: only the former bubble,
 * so this is one listener on the grid instead of one per card. */
let hoverVid = null;
let hoverTimer = null;
function stopHoverPreview() {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  if (!hoverVid) return;
  hoverVid.pause();
  hoverVid.removeAttribute("src");
  hoverVid.load();
  hoverVid.remove();
  hoverVid = null;
}
$("clipGrid").addEventListener("mouseover", (e) => {
  const img = e.target.closest?.("img.cthumb[data-vsrc]");
  if (!img) return;
  const card = img.closest(".clipcard");
  if (!card || (hoverVid && hoverVid.parentElement === card)) return;
  stopHoverPreview();
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    // The card can be gone by now — a repaint may have landed during the dwell.
    if (!card.isConnected) return;
    const v = document.createElement("video");
    v.className = "chover";
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = "auto";
    v.src = img.dataset.vsrc;
    card.appendChild(v);
    hoverVid = v;
    // Autoplay can still be refused; the poster underneath is the fallback.
    v.play().catch(() => {});
  }, 180);
});
$("clipGrid").addEventListener("mouseout", (e) => {
  /* Keyed to the card that actually HOLDS the preview, not to the event's own
   * card: with both sides outside a .clipcard, comparing the two gives
   * null === null and swallows the exit. */
  const holder = hoverVid ? hoverVid.parentElement : null;
  const to = e.relatedTarget;
  if (holder && to && to.closest?.(".clipcard") === holder) return;
  stopHoverPreview();
});

$("clipGrid").addEventListener("click", async (e) => {
  /* Group headers first and returning early, same as the track list: a click on
   * a header must never also reach a card action sitting underneath it. */
  const head = e.target.closest("[data-cgrp]");
  if (head) {
    e.stopPropagation();
    if (!state.collapsed) state.collapsed = new Set();
    const id = head.dataset.cgrp;
    if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
    paintClips();
    return;
  }
  const reuse = e.target.closest("[data-creuse]");
  const reveal = e.target.closest("[data-creveal]");
  const enh = e.target.closest("[data-cenh]");
  const cext = e.target.closest("[data-cext]");
  const boost = e.target.closest("[data-cboost]");
  const trash = e.target.closest("[data-ctrash]");
  if (enh) { openEnhance(enh.dataset.cenh); return; }
  if (cext) { openExtendClip(cext.dataset.cext); return; }
  if (boost) {
    /* One click, no dialog. The server picks the largest option that fits and
     * tells us which one it used — reported rather than assumed, because on a
     * big clip "boost" quietly becoming "smoother only" is exactly the kind of
     * thing that makes people distrust a button. */
    const c = (state.clips || []).find((x) => x.name === boost.dataset.cboost);
    if (!c) return;
    enhClip = c;
    const src = enhSource();
    const r = await (await fetch("/api/clips", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "enhance", name: c.name, auto: "both",
        srcWidth: src.width, srcHeight: src.height, seconds: src.seconds,
      }),
    })).json();
    if (r.error) { alert(r.error); return; }
    const said = { both: "smoother and bigger", bigger: "bigger", smooth: "smoother" }[r.mode] || r.mode;
    alert(`Queued: ${said}.${r.steppedDown ? "\n\nThe full boost needed more memory than this machine can give, so it did the most it could." : ""}`);
    loadClips();
    return;
  }
  if (reuse) {
    /* Load a clip's own settings back into the form. This is why clips carry
     * metadata at all — a clip you liked used to be a dead end. */
    const c = (state.clips || []).find((x) => x.name === reuse.dataset.creuse);
    const m = c?.meta; if (!m) return;
    $("vidPrompt").value = m.prompt || "";
    if (m.seed != null) $("vidSeed").value = m.seed;
    if (m.clipSeconds) $("vidSecs").value = m.clipSeconds;
    if (m.width && m.height) {
      const want = `${m.width}x${m.height}`;
      if ([...$("vidSize").options].some((o) => o.value === want)) $("vidSize").value = want;
    }
    $("vidLoop").checked = !!m.loop;
    if (m.engine && m.engine !== state.video?.engine) await setVideoEngine(m.engine);
    vidPaint();
    $("vidPrompt").focus();
    return;
  }
  if (reveal) {
    fetch("/api/reveal", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clip: reveal.dataset.creveal }) }).catch(() => {});
    return;
  }
  if (trash) {
    const name = trash.dataset.ctrash;
    if (!(await appConfirm(`Move ${name} to trash? It stays on disk in output/trash.`))) return;
    const r = await (await fetch("/api/clips", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "trash", name }) })).json();
    if (r.error) { alert(r.error); return; }
    loadClips();
  }
});

/* ── ticking images and clips, and acting on several at once ──────────────
 * The Music library's selection bar, for the Images and Video galleries. The
 * grids repaint from data every few seconds, so the tick boxes are not part of
 * the card templates: they are put back on every tile after each repaint (a
 * MutationObserver), from a Set of names that survives it. A tick never opens
 * the tile under it. */
function mountPickBar({ grid, bar, tile, nameOf, noun, actions }) {
  const g = $(grid), b = $(bar);
  if (!g || !b) return;
  const sel = new Set();
  let last = null;
  const names = () => [...g.querySelectorAll(tile)].map(nameOf).filter(Boolean);
  const paint = () => {
    const shown = names();
    for (const f of [...sel]) if (!shown.includes(f)) sel.delete(f);   // gone from the list: gone from the selection
    const n = sel.size;
    b.classList.toggle("on", n > 0);
    g.classList.toggle("picking", n > 0);
    b.querySelector(".bcount").textContent = n ? `${n} selected` : `Tick ${noun}s to act on several at once`;
    for (const x of b.querySelectorAll("[data-pick]")) x.disabled = !n || (x.dataset.pick === "collage" && n < 2);
    const all = b.querySelector("[data-pickall]");
    all.disabled = !shown.length;
    all.checked = shown.length > 0 && shown.every((f) => sel.has(f));
    all.indeterminate = n > 0 && !all.checked;
  };
  const dress = () => {
    for (const t of g.querySelectorAll(tile)) {
      const f = nameOf(t);
      if (!f) continue;
      let box = t.querySelector(":scope > .rsel input");
      if (!box) {
        const l = document.createElement("label");
        l.className = "rsel";
        l.title = `Select this ${noun}`;
        l.innerHTML = `<input type="checkbox" aria-label="Select this ${noun}">`;
        t.prepend(l);
        box = l.firstChild;
      }
      box.dataset.pick = f;
      box.checked = sel.has(f);
      t.classList.toggle("picked", sel.has(f));
    }
    paint();
  };
  new MutationObserver(() => dress()).observe(g, { childList: true, subtree: false });
  /* Capture phase: the tile's own click (open, view) never hears a tick. */
  g.addEventListener("click", (e) => {
    const box = e.target.closest?.(".rsel");
    if (!box) return;
    e.stopPropagation();
    const input = box.querySelector("input");
    if (e.target !== input) return;               // the label's click reaches the input next
    const f = input.dataset.pick;
    const order = names();
    const a = order.indexOf(last), z = order.indexOf(f);
    const span = e.shiftKey && a >= 0 && z >= 0 ? order.slice(Math.min(a, z), Math.max(a, z) + 1) : [f];
    for (const x of span) { if (input.checked) sel.add(x); else sel.delete(x); }
    last = f;
    dress();
  }, true);
  b.querySelector("[data-pickall]").addEventListener("change", (e) => {
    for (const f of names()) { if (e.target.checked) sel.add(f); else sel.delete(f); }
    dress();
  });
  b.addEventListener("click", async (e) => {
    const x = e.target.closest("[data-pick]");
    if (!x || x.disabled) return;
    if (x.dataset.pick === "clear") { sel.clear(); dress(); return; }
    const files = [...sel];
    const done = await actions[x.dataset.pick]?.(files);
    if (done) { sel.clear(); dress(); }
  });
  dress();
}
/* One request per item: these routes take one name at a time. */
async function pickEach(url, files, body) {
  const errors = [];
  for (const name of files) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, name }) }).then((x) => x.json()).catch((err) => ({ error: err.message }));
    if (r?.error) errors.push(`${name}: ${r.error}`);
  }
  if (errors.length) alert(`${errors.length} of ${files.length} did not work: ${errors[0]}`);
  return errors.length < files.length;
}
mountPickBar({
  grid: "imgGrid", bar: "imgBatch", tile: ".imtile", nameOf: (t) => t.dataset.imgopen, noun: "image",
  actions: {
    collage: async (files) => {
      const names = files.filter((n) => /\.(png|jpe?g|webp)$/i.test(n)).slice(0, 36);
      if (names.length < 2) { alert("A collage needs two or more PNG, JPG or WebP images."); return false; }
      const r = await (await fetch("/api/images/sheet", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names, cols: +$("imgCollageCols").value || 0, cell: 420, gap: 6, fit: "cover", labels: $("imgCollageLab").checked }) })).json();
      if (r.error) { alert(r.error); return false; }
      await loadImages();
      openImageEditor(r.name);
      return true;
    },
    trash: async (files) => {
      if (!(await appConfirm(`Move ${files.length} image${files.length === 1 ? "" : "s"} to trash? They stay on disk in output/trash.`))) return false;
      const ok = await pickEach("/api/images", files, { action: "trash" });
      loadImages();
      return ok;
    },
  },
});
mountPickBar({
  grid: "clipGrid", bar: "clipBatch", tile: ".clipcard", nameOf: (t) => t.dataset.cview, noun: "clip",
  actions: {
    boost: async (files) => {
      const vids = files.filter((n) => /\.(mp4|webm)$/i.test(n));
      if (!vids.length) { alert("Boost works on video clips, and none of the selected ones is a video."); return false; }
      if (!(await appConfirm(`Boost ${vids.length} clip${vids.length === 1 ? "" : "s"}? Each one is made smoother and bigger on the graphics card, one after another.`))) return false;
      const ok = await pickEach("/api/clips", vids, { action: "enhance", auto: "both" });
      loadClips();
      return ok;
    },
    trash: async (files) => {
      if (!(await appConfirm(`Move ${files.length} clip${files.length === 1 ? "" : "s"} to trash? They stay on disk in output/trash.`))) return false;
      const ok = await pickEach("/api/clips", files, { action: "trash" });
      loadClips();
      return ok;
    },
  },
});

/* ── Images ─────────────────────────────────────────────────────────────────
 *
 * Same engine as cover art, so a custom ComfyUI workflow assigned to "cover" in
 * Settings drives this screen as well — which is the whole reason it was built
 * on the cover pipeline rather than as a fourth engine.
 */
async function loadImages() {
  try {
    const d = await (await fetch("/api/images")).json();
    state.images = d.images || [];
  } catch { state.images = state.images || []; }
  imgPaint();
}

function imgCard(im) {
  const m = im.meta || {};
  const d = m.at ? new Date(m.at) : null;
  const when = d ? `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  const dur = m.durationMs ? ` · ${(m.durationMs / 1000).toFixed(1)}s render` : "";
  /* Name the format when it is not the engine's native png — an exported jpg
   * tile is otherwise indistinguishable from the original it came from. */
  const ext = (im.name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || "";
  const kind = ext === "svg" ? " · SVG"
    : ext && ext !== "png" ? ` · ${ext.toUpperCase()}`
    : m.editedFrom ? " · edit" : "";
  return `<figure class="imtile${m.blur ? " blurred" : ""}" data-imgopen="${esc(im.name)}">
    <img src="/api/image/${encodeURIComponent(im.name)}" alt="" loading="lazy">
    <figcaption>
      <b title="${esc(m.prompt || "")}">${esc((m.prompt || im.name).slice(0, 70))}</b>
      <span>${when}${dur}${m.seed != null ? ` · seed ${m.seed}` : ""}${kind}</span>
      ${im.model ? `<span class="immodel">${im.modelUrl
        ? `<a data-modellink href="${esc(im.modelUrl)}" target="_blank" rel="noreferrer noopener"
             title="Read about this model — opens ${esc(im.modelUrl)}">${esc(im.model)}</a>`
        : `<span title="Your own file from models/checkpoints. The app lists that shelf, it does not curate it, so there is no page to link to.">${esc(im.model)}</span>`
      }</span>` : ""}
    </figcaption>
  </figure>`;
}

/* The gallery lays out in justified ROWS (see .masonry), and that needs each
 * picture's aspect ratio -- which the library does not record: /api/images
 * returns prompt, seed, engine and checkpoint, and no dimensions at all.
 *
 * So every tile learns its own shape from the decoded bitmap. Tiles start
 * square and correct themselves, which is why --ar has a sane default rather
 * than being left unset. */
function imgTileAspect(img) {
  const tile = img.closest(".imtile");
  if (!tile || !img.naturalWidth || !img.naturalHeight) return;
  tile.style.setProperty("--ar", (img.naturalWidth / img.naturalHeight).toFixed(4));
}

/* Anything already in the browser cache is `complete` the moment it is parsed
 * and its load event has ALREADY fired, so the delegated listener below never
 * hears about it. On a revisit that is most of the gallery. */
function imgFitAspect(grid) {
  for (const img of grid.querySelectorAll(".imtile img")) {
    if (img.complete) imgTileAspect(img);
  }
}

function imgPaint() {
  const all = state.images || [];
  const q = ($("imgSearch")?.value || "").trim().toLowerCase();
  const rows = q
    /* Search the MODEL too: "everything I made with oneObsession" is a question
     * the library can now answer, and it is the reason to record the name. */
    ? all.filter((im) => `${(im.meta || {}).prompt || ""} ${im.name} ${im.model || ""}`.toLowerCase().includes(q))
    : all;
  const grid = $("imgGrid");
  if (grid) {
    grid.innerHTML = rows.length
      ? `<div class="masonry">${rows.map(imgCard).join("")}</div>`
      : `<p class="clipempty">${q ? "Nothing matches that." : "No images yet — describe one on the left."}</p>`;
    imgFitAspect(grid);
  }
  const c = $("imgCountLbl");
  if (c) c.textContent = `${rows.length}${q && rows.length !== all.length ? ` of ${all.length}` : ""} image${rows.length === 1 ? "" : "s"}`;
  if ($("imgRefPick")) imgRefsPaint();
}

$("imgSearch").oninput = imgPaint;

/* Collage: whatever the gallery is SHOWING becomes one picture. Searching
 * first is the selection mechanism — "raven" then collage gives a raven
 * sheet, no multi-select ceremony. */
$("imgCollage").onclick = async () => {
  const q = ($("imgSearch")?.value || "").trim().toLowerCase();
  const rows = (state.images || [])
    /* Match what /api/images/sheet will actually ACCEPT (png/jpg/webp) — it
     * skips other names silently, so counting an avif here would promise a
     * tile the sheet then quietly leaves out. */
    .filter((im) => /\.(png|jpe?g|webp)$/i.test(im.name))
    .filter((im) => !q || `${im.meta?.prompt || ""} ${im.name}`.toLowerCase().includes(q))
    .slice(0, 36);
  if (rows.length < 2) { alert("Two or more images have to be showing — search to narrow, or clear the search."); return; }
  const btn = $("imgCollage"); btn.disabled = true; btn.textContent = "tiling\u2026";
  try {
    const r = await (await fetch("/api/images/sheet", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        names: rows.map((im) => im.name),
        cols: +$("imgCollageCols").value || 0,
        cell: 420, gap: 6, fit: "cover",
        labels: $("imgCollageLab").checked,
      }) })).json();
    if (r.error) { alert(r.error); return; }
    await loadImages();
    openImageEditor(r.name);
  } finally { btn.disabled = false; btn.innerHTML = "\u25a6 collage these"; }
};

/* ── the image editor ────────────────────────────────────────────────────
 * Live preview by CSS filter; the committed edit renders server-side through
 * server/imagetools.py — the exact same engine MCP's image_adjust uses. */
const ied = { name: null, rotate: 0, flipH: false, flipV: false,
  crop: null, cropping: false, key: null, picking: false,
  curves: { master: [], r: [], g: [], b: [] }, curveCh: "master",
  autoLevels: false, hsl: {}, text: null, placingText: false,
  /* The console: which tool owns the canvas pointer, and where the picture is.
   * `cropping` / `picking` / `placingText` are still the flags the rest of this
   * file reads — they are now DERIVED from the tool rather than set by three
   * buttons that could each be on at once. */
  tool: "move", view: { zoom: 1, x: 0, y: 0 }, fitted: true,
  cropDrag: null, panning: false, space: false,
  /* Everything the pipeline in IMAGE_SPEC §2 can carry that is not a slider.
   * They are all ARRAYS in pipeline order, because the server applies them in
   * the order given and the docks that show them must not reorder anything. */
  fx: [], fxSel: -1,                     // §4 — {type, params, on}
  sel: [], selDraft: null,               // §3 — shapes, plus the one being dragged
  strokes: [], strokeDraft: null, cloneSrc: null,   // §5
  shapes: [], shapeDraft: null,          // §6
  canvas: null, geom: null,              // §7 — set by their dialogs, else absent
  levels: null,                          // ops.levels — the engine had it, the UI never did
  /* The pen and its dock. `paths` are SAVED geometry — nothing until a gesture
   * turns one into a selection, a queued stroke or a queued fill. `pathDraws`
   * are queued ops.paths entries (stage 8), pipeline order like everything
   * else here. */
  paths: [], pathSel: -1, pathDraft: null, pathDraws: [],
  /* The full imgtext spec, built from the SERVER's catalog when the text
   * capability is live — the Character/Paragraph dock edits this; the legacy
   * `text` object above stays as the fallback for a server without imgtext. */
  text2: null,
  chanView: null,                        // which plane the Channels dock shows — a view, never sent
  ptr: null };                           // last pointer position, for the status bar

function iedOps() {
  const curves = {};
  for (const ch of ["master", "r", "g", "b"]) {
    if (ied.curves[ch].length >= 1) curves[ch] = [[0, 0], ...ied.curves[ch], [255, 255]];
  }
  const hsl = {};
  for (const [band, adj] of Object.entries(ied.hsl)) {
    if (adj.h || adj.s || adj.l) hsl[band] = adj;
  }
  return {
    brightness: +$("iedB").value, contrast: +$("iedC").value, saturation: +$("iedS").value,
    gamma: +$("iedG").value / 100, temperature: +$("iedT").value,
    sharpen: +$("iedSh").value, blur: +$("iedBl").value, vignette: +$("iedV").value,
    shadows: +$("iedShd").value, highlights: +$("iedHl").value,
    // Zeroed when §7 is live — iedStageOps() carries them under `geometry` then.
    rotate: iedCapLive("geometry") ? 0 : ied.rotate,
    flipH: iedCapLive("geometry") ? false : ied.flipH,
    flipV: iedCapLive("geometry") ? false : ied.flipV,
    ...(ied.autoLevels ? { autoLevels: true } : {}),
    ...(Object.keys(curves).length ? { curves } : {}),
    ...(Object.keys(hsl).length ? { hsl } : {}),
    ...($("iedGray").classList.contains("on") ? { grayscale: true } : {}),
    ...($("iedSepia").classList.contains("on") ? { sepia: true } : {}),
    ...($("iedInv").classList.contains("on") ? { invert: true } : {}),
    ...(+$("iedPost").value ? { posterize: +$("iedPost").value } : {}),
    ...(+$("iedDn").value ? { denoise: +$("iedDn").value } : {}),
    ...(+$("iedGr").value ? { grain: +$("iedGr").value } : {}),
    ...iedTextOp(),
    ...($("iedRw").value > 15 && $("iedRh").value > 15
      ? { resize: { w: +$("iedRw").value, h: +$("iedRh").value } } : {}),
    ...(ied.crop ? { crop: ied.crop } : {}),
    ...(ied.key ? { chromaKey: { color: ied.key, tolerance: +$("iedKeyTol").value, softness: +$("iedKeySoft").value } } : {}),
    /* §2 stages 3-8. Each of these is omitted entirely when empty rather than
     * sent as [] — the engine skips an absent op, and an empty list would still
     * make it walk a stage it has nothing to do in. */
    ...iedStageOps(),
  };
}

/* The stages IMAGE_SPEC adds beyond the sliders, in ONE place so that Apply,
 * the preset writer and the history snapshot all send the same thing.
 *
 * `geometry` is gated: while the engine still reads a top-level `rotate`
 * (0/90/180/270 only), the ninety-degree buttons keep writing that. The moment
 * the §7 module lands, rotation moves WHOLESALE into `geometry.rotate` —
 * sending both would rotate twice, and that is exactly the kind of thing that
 * ships silently. */
function iedStageOps() {
  const o = {};
  /* `levels` has been implemented in imagetools.py — per channel, with black,
   * white, gamma and both output points — for as long as the file has existed,
   * and nothing has ever sent one. A capability with no UI is the same as no
   * capability; Adjust → Levels is the dialog it never had. */
  if (ied.levels) o.levels = JSON.parse(JSON.stringify(ied.levels));
  const fx = ied.fx.filter((e) => e.on).map((e) => ({ type: e.type, params: { ...e.params } }));
  if (fx.length && iedCapLive("effects")) o.effects = fx;
  /* Gated on the capability, not only on "is there anything to send". The tools
   * that fill these are dark without it, but a PRESET can carry a selection or
   * a stroke from a machine where the module exists — and posting one to a
   * pipeline with no stage for it returns ok and an unchanged file. An op the
   * server cannot run is not sent. */
  if (iedCapLive("selection") && (ied.sel.length || $("iedSelInvert").checked)) o.selection = iedSelectionOp();
  /* `_ghost` is the overlay's flattened polyline for a path-stroke — client
   * bookkeeping, same rule as the selection's `at`: a key the spec does not
   * define has no business in the payload. */
  if (iedCapLive("strokes") && ied.strokes.length) o.strokes = ied.strokes.map(({ _ghost, _pathName, ...s }) => ({ ...s }));
  if (iedCapLive("shapes") && ied.shapes.length) o.shapes = ied.shapes.map((s) => ({ ...s }));
  if (iedCapLive("paths") && ied.pathDraws.length) o.paths = ied.pathDraws.map((d) => JSON.parse(JSON.stringify(d)));
  if (iedCapLive("geometry") && ied.canvas) o.canvas = { ...ied.canvas };
  /* §2 stage 3 is `geometry`, and §7 gives it rotate / flipH / flipV — which is
   * the SAME stage the engine's top-level `rotate` / `flipH` / `flipV` are
   * today. So exactly one of the two forms is ever sent: the legacy keys while
   * §7 is missing, and the geometry object once it lands. Sending both would
   * rotate twice, and the picture would simply be wrong with no error anywhere.
   *
   * Direction: the engine does `im.rotate(-rot, expand=True)`, and PIL's
   * positive angle is anticlockwise, so `ops.rotate` is degrees CLOCKWISE.
   * `geometry.rotate` is written in the same units — §7 does not say, and this
   * is the only convention the codebase already has. */
  if (iedCapLive("geometry")) {
    const g = { ...(ied.geom || {}) };
    const steps = ied.rotate || 0;
    if (steps || g.rotate) g.rotate = (g.rotate || 0) + steps;
    if (ied.flipH) g.flipH = true;
    if (ied.flipV) g.flipV = true;
    if (Object.keys(g).length) o.geometry = g;
  }
  return o;
}

/* Exactly one of the two text forms is ever sent: the full catalog spec with
 * `_v2: true` when the Character dock is live, else the legacy one-liner the
 * engine has always read. Sending both keys is impossible — there is one key. */
function iedTextOp() {
  if (ied.text2 && String(ied.text2.content || "").trim()) {
    return { text: { ...JSON.parse(JSON.stringify(ied.text2)), _v2: true } };
  }
  return ied.text?.content ? { text: JSON.parse(JSON.stringify(ied.text)) } : {};
}

/* ── the Tone panel: histogram behind a draggable monotone curve ──────── */
function iedHistogram() {
  const img = $("iedImg");
  if (!img.naturalWidth) return null;
  const cv = document.createElement("canvas");
  const w = 256, h = Math.max(1, Math.round(img.naturalHeight * (256 / img.naturalWidth)));
  cv.width = w; cv.height = h;
  const x = cv.getContext("2d");
  x.drawImage(img, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data;
  const bins = new Float32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    bins[(d[i] * 3 + d[i + 1] * 4 + d[i + 2]) >> 3]++;
  }
  const peak = Math.max(...bins) || 1;
  return { bins, peak };
}

function iedCurveY(pts, x) {
  // piecewise Catmull-Rom-ish via monotone linear blend — the DISPLAY only;
  // the server renders the true PCHIP. Close enough to steer by.
  const all = [[0, 0], ...pts, [255, 255]].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < all.length - 1; i++) {
    const [x0, y0] = all[i], [x1, y1] = all[i + 1];
    if (x >= x0 && x <= x1) {
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      const s = t * t * (3 - 2 * t);          // smoothstep — visually cubic
      return y0 + (y1 - y0) * s;
    }
  }
  return x;
}

let iedHist = null;
function iedDrawCurve() {
  const cv = $("iedCurve"); const x = cv.getContext("2d");
  const W = cv.width, Hh = cv.height;
  x.clearRect(0, 0, W, Hh);
  x.fillStyle = "hsla(220,15%,10%,.9)"; x.fillRect(0, 0, W, Hh);
  // histogram
  if (iedHist) {
    x.fillStyle = "hsla(190,60%,55%,.25)";
    for (let i = 0; i < 256; i++) {
      const bh = Math.pow(iedHist.bins[i] / iedHist.peak, 0.5) * (Hh - 8);
      x.fillRect((i / 255) * (W - 8) + 4, Hh - 4 - bh, (W - 8) / 256 + 0.5, bh);
    }
  }
  // grid
  x.strokeStyle = "hsla(0,0%,60%,.15)"; x.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    x.beginPath(); x.moveTo(4 + (W - 8) * i / 4, 4); x.lineTo(4 + (W - 8) * i / 4, Hh - 4); x.stroke();
    x.beginPath(); x.moveTo(4, 4 + (Hh - 8) * i / 4); x.lineTo(W - 4, 4 + (Hh - 8) * i / 4); x.stroke();
  }
  const CH_COLOR = { master: "#e8e8ec", r: "#ff6b6b", g: "#7bd88f", b: "#6bb1ff" };
  // every non-empty channel faint, the active one bright
  for (const ch of ["master", "r", "g", "b"]) {
    const pts = ied.curves[ch];
    if (ch !== ied.curveCh && !pts.length) continue;
    x.strokeStyle = CH_COLOR[ch] + (ch === ied.curveCh ? "" : "55");
    x.lineWidth = ch === ied.curveCh ? 2 : 1.2;
    x.beginPath();
    for (let px = 0; px <= 255; px += 2) {
      const py = iedCurveY(pts, px);
      const cx = 4 + (px / 255) * (W - 8), cy = Hh - 4 - (py / 255) * (Hh - 8);
      px === 0 ? x.moveTo(cx, cy) : x.lineTo(cx, cy);
    }
    x.stroke();
    if (ch === ied.curveCh) {
      x.fillStyle = CH_COLOR[ch];
      for (const [ptx, pty] of pts) {
        x.beginPath();
        x.arc(4 + (ptx / 255) * (W - 8), Hh - 4 - (pty / 255) * (Hh - 8), 4, 0, Math.PI * 2);
        x.fill();
      }
    }
  }
}

/* ── the viewport: one transform, and the two coordinate spaces it hides ──
 *
 * The picture is no longer laid out by the browser. It is a plane at its own
 * natural size, rotated inside a frame, and the frame is translated and scaled
 * into the canvas. Every pointer interaction has to come back through that, and
 * there are TWO destinations, because imagetools.py does not treat them alike:
 *
 *   SOURCE space — the file's own pixels. Crop lives here (the server crops
 *     BEFORE it rotates) and so does the eyedropper (it samples the natural-size
 *     <img>). iedImgPoint().
 *   FRAME space — the picture after rotate and flip, which is what you see.
 *     The type tool lives here, because the server draws text LAST, on the
 *     already-rotated image. iedFramePoint().
 *
 * The old code took one bounding rect and called it both. With no rotation the
 * two agree, which is why it survived; rotate 90° and a crop landed sideways. */
function iedRotSize() {
  const im = $("iedImg");
  const nw = im.naturalWidth || 1, nh = im.naturalHeight || 1;
  return (ied.rotate % 180) ? { w: nh, h: nw, nw, nh } : { w: nw, h: nh, nw, nh };
}

/* canvas-viewport pixels for an event — the one place clientX is read */
function iedCanvasXY(e) {
  const c = $("iedCanvas").getBoundingClientRect();
  return { x: e.clientX - c.left, y: e.clientY - c.top };
}

/* FRAME pixels: undo the translate and the scale, nothing else. What you see. */
function iedFramePoint(e) {
  const { w, h } = iedRotSize();
  const p = iedCanvasXY(e);
  return {
    x: Math.max(0, Math.min(w, Math.round((p.x - ied.view.x) / ied.view.zoom))),
    y: Math.max(0, Math.min(h, Math.round((p.y - ied.view.y) / ied.view.zoom))),
  };
}

/* SOURCE pixels: frame, then back through the flips and the rotation.
 * Clamped — a drag that leaves the picture must still name a pixel inside it,
 * or crop hands the server a rectangle that starts outside the file. */
function iedImgPoint(e) {
  const { w, h, nw, nh } = iedRotSize();
  let { x: fx, y: fy } = iedFramePoint(e);
  if (ied.flipH) fx = w - fx;
  if (ied.flipV) fy = h - fy;
  let x = fx, y = fy;
  if (ied.rotate === 90) { x = fy; y = nh - fx; }
  else if (ied.rotate === 180) { x = nw - fx; y = nh - fy; }
  else if (ied.rotate === 270) { x = nw - fy; y = fx; }
  return { x: Math.max(0, Math.min(nw - 1, Math.round(x))),
           y: Math.max(0, Math.min(nh - 1, Math.round(y))) };
}

/* the same walk forwards, for drawing the crop marquee where the drag was */
function iedSrcToView(x, y) {
  const { w, h, nw, nh } = iedRotSize();
  let fx = x, fy = y;
  if (ied.rotate === 90) { fx = nh - y; fy = x; }
  else if (ied.rotate === 180) { fx = nw - x; fy = nh - y; }
  else if (ied.rotate === 270) { fx = y; fy = nw - x; }
  if (ied.flipH) fx = w - fx;
  if (ied.flipV) fy = h - fy;
  return { x: ied.view.x + fx * ied.view.zoom, y: ied.view.y + fy * ied.view.zoom };
}

/* STAGE space — the third coordinate space, and the one IMAGE_SPEC's new
 * stages live in.
 *
 * §2 fixes the order: canvas, crop, geometry, THEN selection, adjustments,
 * effects, strokes, shapes. So a selection or a brush path is resolved against
 * the picture AFTER the crop has already taken a bite out of it and after the
 * rotation. With a crop pending, that is NOT what is on screen — the screen
 * still shows the whole picture with a marquee on it. Drawing a selection with
 * a crop armed and posting screen coordinates would land it offset by exactly
 * the crop origin, silently, and only in the cases where someone did both.
 *
 * So: source pixel, minus the crop origin, then forward through the geometry.
 * iedStageToView() is the same walk backwards, for painting the overlay. */
function iedStageSize() {
  const { nw, nh } = iedRotSize();
  const W = ied.crop ? ied.crop.w : nw, H = ied.crop ? ied.crop.h : nh;
  return (ied.rotate % 180) ? { w: H, h: W, W, H } : { w: W, h: H, W, H };
}
function iedSrcToStage(sx, sy) {
  const { w, h, W, H } = iedStageSize();
  let x = sx - (ied.crop ? ied.crop.x : 0), y = sy - (ied.crop ? ied.crop.y : 0);
  let fx = x, fy = y;
  if (ied.rotate === 90) { fx = H - y; fy = x; }
  else if (ied.rotate === 180) { fx = W - x; fy = H - y; }
  else if (ied.rotate === 270) { fx = y; fy = W - x; }
  if (ied.flipH) fx = w - fx;
  if (ied.flipV) fy = h - fy;
  return { x: Math.round(fx), y: Math.round(fy) };
}
function iedStagePoint(e) {
  const p = iedImgPoint(e);
  return iedSrcToStage(p.x, p.y);
}
/* the exact inverse of iedSrcToStage — a wand seed has to name a real pixel */
function iedStageToSrc(x, y) {
  const { w, h, W, H } = iedStageSize();
  let fx = x, fy = y;
  if (ied.flipH) fx = w - fx;
  if (ied.flipV) fy = h - fy;
  let sx = fx, sy = fy;
  if (ied.rotate === 90) { sx = fy; sy = H - fx; }
  else if (ied.rotate === 180) { sx = W - fx; sy = H - fy; }
  else if (ied.rotate === 270) { sx = W - fy; sy = fx; }
  return { x: sx + (ied.crop ? ied.crop.x : 0), y: sy + (ied.crop ? ied.crop.y : 0) };
}
/* stage pixel -> canvas-viewport pixel, so the overlay draws where the drag was */
function iedStageToView(x, y) {
  const s = iedStageToSrc(x, y);
  return iedSrcToView(s.x, s.y);
}

const iedBytes = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(2)} MB` : `${Math.round(b / 1e3)} kB`);

function iedApplyView() {
  const { w, h, nw, nh } = iedRotSize();
  const v = ied.view, f = $("iedFrame"), im = $("iedImg");
  f.style.width = `${w}px`; f.style.height = `${h}px`;
  /* Flips ride on the FRAME, after the rotation and before the scale, which is
   * the order imagetools.py applies them in. */
  const flip = (ied.flipH ? ` translateX(${w}px) scaleX(-1)` : "")
             + (ied.flipV ? ` translateY(${h}px) scaleY(-1)` : "");
  f.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})${flip}`;
  f.style.setProperty("--iedz", String(v.zoom));
  im.style.width = `${nw}px`; im.style.height = `${nh}px`;
  im.style.transform = ied.rotate === 90 ? `translate(${nh}px,0) rotate(90deg)`
    : ied.rotate === 180 ? `translate(${nw}px,${nh}px) rotate(180deg)`
    : ied.rotate === 270 ? `translate(0,${nw}px) rotate(270deg)` : "none";
  /* The Channels view sits exactly where the picture sits — same plane, same
   * rotation — so it inherits the frame's zoom, pan and flips for free. */
  const chan = $("iedChanCanvas");
  if (chan && !chan.hidden) {
    chan.style.width = im.style.width; chan.style.height = im.style.height;
    chan.style.transform = im.style.transform;
  }
  iedPaintCrop(); iedTextSync(); iedStatus();
  // Everything drawn in VIEWPORT pixels re-derives from the same transform.
  iedOverlayPaint(); iedNavPaint();
}

function iedFit() {
  const c = $("iedCanvas"), { w, h } = iedRotSize();
  const vw = c.clientWidth, vh = c.clientHeight;
  // A canvas with no size yet would fit to 2% and stay there; the observer
  // below re-fits the moment it has one.
  if (vw < 8 || vh < 8) { ied.fitted = true; iedApplyView(); return; }
  ied.view.zoom = Math.max(0.02, Math.min(8, Math.min((vw - 36) / w, (vh - 36) / h)));
  ied.view.x = Math.round((vw - w * ied.view.zoom) / 2);
  ied.view.y = Math.round((vh - h * ied.view.zoom) / 2);
  ied.fitted = true;
  iedApplyView();
}

/* zoom about a point, so the pixel under the cursor stays under the cursor */
function iedZoomAt(cx, cy, nz) {
  const c = $("iedCanvas").getBoundingClientRect();
  const px = cx - c.left, py = cy - c.top;
  nz = Math.max(0.02, Math.min(32, nz));
  const k = nz / ied.view.zoom;
  ied.view.x = px - (px - ied.view.x) * k;
  ied.view.y = py - (py - ied.view.y) * k;
  ied.view.zoom = nz; ied.fitted = false;
  iedApplyView();
}
function iedZoomCentre(nz) {
  const c = $("iedCanvas").getBoundingClientRect();
  iedZoomAt(c.left + c.width / 2, c.top + c.height / 2, nz);
}

function iedPaintCrop() {
  const box = $("iedCropBox");
  const r = ied.cropDrag || ied.crop;
  if (!r || !$("iedImg").naturalWidth) { box.hidden = true; return; }
  const a = iedSrcToView(r.x, r.y), b = iedSrcToView(r.x + r.w, r.y + r.h);
  box.hidden = false;
  box.style.left = `${Math.min(a.x, b.x)}px`; box.style.top = `${Math.min(a.y, b.y)}px`;
  box.style.width = `${Math.abs(b.x - a.x)}px`; box.style.height = `${Math.abs(b.y - a.y)}px`;
}

const IED_HINT = {
  move: "wheel zooms · space-drag pans · Ctrl+0 fit, Ctrl+1 100%",
  crop: "drag a rectangle — Apply keeps only that",
  eye: "click the screen colour to key it out",
  type: "click the picture to place the words",
  zoom: "click to zoom in, alt-click out",
  hand: "drag to pan",
  /* Keyed by capability as well as by tool, so twelve brush tools do not need
   * twelve near-identical lines. iedStatus() falls back to the family's. */
  selection: "drag a region — every adjustment and all 88 effects then apply only there",
  strokes: "drag to paint — the path goes to the server, which decides the pixels",
  shapes: "drag to draw · double-click closes a polygon",
  pen: "click each anchor · double-click or Enter saves the path — the Paths dock does the rest",
};
function iedStatus() {
  const { nw, nh } = iedRotSize();
  const pct = `${Math.round(ied.view.zoom * 100)}%`;
  $("iedStZoom").textContent = pct; $("iedZoomV").textContent = pct;
  const im = (state.images || []).find((x) => x.name === ied.name);
  $("iedStDim").textContent = $("iedImg").naturalWidth ? `${nw}×${nh}` : "—";
  $("iedStSize").textContent = im?.bytes ? iedBytes(im.bytes) : "—";
  $("iedStPtr").textContent = ied.ptr ? `${ied.ptr.x},${ied.ptr.y}` : "—";
  const inv = $("iedSelInvert")?.checked;
  $("iedStSel").textContent = ied.sel.length
    ? `sel ${ied.sel.length} shape${ied.sel.length === 1 ? "" : "s"}${inv ? " inverted" : ""}`
    : (inv ? "sel inverted" : "");
  /* What is queued but not committed. An editor that hides pending work is how
   * you press Apply and get a surprise. */
  const q = [];
  if (ied.fx.filter((f) => f.on).length) q.push(`${ied.fx.filter((f) => f.on).length} fx`);
  if (ied.strokes.length) q.push(`${ied.strokes.length} stroke${ied.strokes.length === 1 ? "" : "s"}`);
  if (ied.shapes.length) q.push(`${ied.shapes.length} shape${ied.shapes.length === 1 ? "" : "s"}`);
  if (ied.pathDraws.length) q.push(`${ied.pathDraws.length} path fill${ied.pathDraws.length === 1 ? "" : "s"}`);
  $("iedStQueue").textContent = q.join(" · ");
  if (Date.now() >= iedToastUntil) {
    $("iedStHint").textContent = IED_HINT[ied.tool] || IED_HINT[IED_FAMOF[ied.tool]?.cap] || "";
  }
}

function iedDocInfo() {
  const im = (state.images || []).find((x) => x.name === ied.name);
  const w = $("iedImg").naturalWidth, h = $("iedImg").naturalHeight;
  $("iedDocName").textContent = [ied.name, w ? `${w}×${h}` : "",
    im?.bytes ? iedBytes(im.bytes) : ""].filter(Boolean).join("  ·  ");
  $("iedDocName").title = ied.name || "";
  iedStatus();
}

/* ── the tool strip ────────────────────────────────────────────────────────
 * One selected tool at a time, and it is the only thing that decides what a
 * pointer press on the canvas means. Crop and the eyedropper used to be modes
 * armed from two buttons in the rail with nothing stopping both being on. */
/* ── what the SERVER can do, probed rather than assumed ────────────────────
 *
 * IMAGE_SPEC defines selections, strokes, shapes and canvas geometry precisely,
 * and four other agents are building them right now. This console is built to
 * the spec, which means most of it addresses routes that do not exist yet.
 *
 * The rule: never a control that appears to work. `/api/images/edit` takes an
 * `ops` object and SILENTLY IGNORES a key its pipeline has no stage for, so
 * posting a stroke today would return ok:true and a byte-identical file — the
 * exact failure §9 names. So each capability is probed once, everything
 * defaults to OFF, and an off capability disables its tools and menu rows with
 * a title that says which file and which op are missing.
 *
 * The probes follow the one convention this server already has: the effect
 * catalog is served at /api/images/effects, so a module's catalog is served at
 * /api/images/<its noun>. An explicit /api/images/capabilities wins over all of
 * them if the integrator provides one. Help → "What the server can do" prints
 * exactly what was asked and exactly what came back, so a wrong guess here is
 * visible rather than mysterious. */
const IED_CAPS = {
  effects:   { spec: "§4", label: "Effects",   probe: "/api/images/effects",
    needs: "server/vfx/effects.py via GET /api/images/effects", live: false },
  selection: { spec: "§3", label: "Selection", probe: "/api/images/selection",
    needs: "server/imgselect.py + ops.selection in /api/images/edit", live: false },
  strokes:   { spec: "§5", label: "Strokes",   probe: "/api/images/strokes",
    needs: "server/imgstroke.py + ops.strokes in /api/images/edit", live: false },
  shapes:    { spec: "§6", label: "Shapes",    probe: "/api/images/shapes",
    needs: "server/imgshape.py + ops.shapes in /api/images/edit", live: false },
  geometry:  { spec: "§7", label: "Canvas & geometry", probe: "/api/images/geometry",
    needs: "server/imgshape.py + ops.canvas / ops.geometry in /api/images/edit", live: false },
  paths:     { spec: "§2·8", label: "Pen paths", probe: "/api/images/paths",
    needs: "server/imgpath.py + ops.paths in /api/images/edit", live: false },
  text:      { spec: "§2·9", label: "Type · full spec", probe: "/api/images/text",
    needs: "server/imgtext.py + ops.text in /api/images/edit", live: false },
  /* The one capability IMAGE_SPEC does NOT define. A layer document with
   * masks, groups and adjustment layers was asked for, and no section owns it,
   * so it says "unspecced" rather than borrowing a section number it has no
   * claim to. */
  layerdoc:  { spec: null, label: "Layer document", probe: "/api/images/document",
    needs: "a layer document — masks, groups, adjustment layers. No route, and no section of IMAGE_SPEC defines one", live: false },
};
const iedCapLive = (k) => !k || !!IED_CAPS[k]?.live;
const iedCapSpec = (k) => IED_CAPS[k]?.spec || "unspecced";
const iedCapWhy = (k) => (k && IED_CAPS[k])
  ? `Not built yet — needs ${IED_CAPS[k].needs}${IED_CAPS[k].spec ? ` (IMAGE_SPEC ${IED_CAPS[k].spec})` : ""}.` : "";

/* ── the tool rail ─────────────────────────────────────────────────────────
 * Twenty-nine tools. A flat rail of twenty-nine icons is a wall, so tools that
 * answer the same question share a SLOT: one rail button, siblings as chips in
 * the options bar. Shift+<key> cycles the slot, which is the habit every
 * editor has trained. Groups are separated by a rule, in the order you reach
 * for them: navigate, select, frame, paint, draw. */
const IED_ICON = {
  move: '<path d="M8 1.5v13M1.5 8h13M8 1.5 5.9 3.6M8 1.5l2.1 2.1M8 14.5l-2.1-2.1M8 14.5l2.1-2.1M1.5 8l2.1-2.1M1.5 8l2.1 2.1M14.5 8l-2.1-2.1M14.5 8l-2.1 2.1"/>',
  hand: '<path d="M4.6 8.2V4.4a1.15 1.15 0 0 1 2.3 0v2.9M6.9 7.3V3.1a1.15 1.15 0 0 1 2.3 0v4.2M9.2 7.3V4.6a1.15 1.15 0 0 1 2.3 0v5.5c0 2.4-1.6 4.3-3.9 4.3s-3.9-1.9-3.9-4.1V8.4a1.05 1.05 0 0 1 2.1 0"/>',
  zoom: '<circle cx="6.8" cy="6.8" r="4.6"/><path d="M10.3 10.3 14 14M4.6 6.8h4.4M6.8 4.6v4.4"/>',
  marquee: '<path d="M2 2.6h3M6.5 2.6h3M11 2.6h2.4v2M13.4 6.5v3M13.4 11v2.4H11M9.5 13.4h-3M5 13.4H2.6V11M2.6 9.5v-3M2.6 5V2.6"/>',
  lasso: '<path d="M8 2.3c3.2 0 5.7 1.9 5.7 4.3S11.2 10.9 8 10.9 2.3 9 2.3 6.6 4.8 2.3 8 2.3z"/><path d="M6.2 10.6 5.5 13a1.1 1.1 0 1 0 1.4.7"/>',
  wand: '<path d="m11.4 1.8.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9zM8.6 7.4 2 14M4.6 3.2l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2L2.9 4.9l1.2-.5z"/>',
  crop: '<path d="M4.5 1.5v10h10M1.5 4.5h10v10"/>',
  eye: '<path d="M13.6 2.4a1.9 1.9 0 0 0-2.7 0L9.3 4l-.9-.9-1.2 1.2 4.5 4.5 1.2-1.2-.9-.9 1.6-1.6a1.9 1.9 0 0 0 0-2.7z"/><path d="M8.2 6.6 2.6 12.2v1.7h1.7l5.6-5.6"/>',
  brush: '<path d="M8.6 9.1 13.5 4.2a1.5 1.5 0 0 0-2.1-2.1L6.5 7"/><path d="M4.8 8.9c1.2 0 2.1 1 2.1 2.2 0 1.5-1.2 2.5-2.9 2.5-.9 0-1.9-.2-2.6-.6 1-.3 1.3-.9 1.3-1.9 0-1.3.9-2.2 2.1-2.2z"/>',
  eraser: '<path d="M9.3 2.5 2.5 9.3a1.4 1.4 0 0 0 0 2l2.2 2.2h3.6l5.2-5.2a1.4 1.4 0 0 0 0-2l-2.2-2.2a1.4 1.4 0 0 0-2 0zM5.9 5.9l4.2 4.2M4.3 13.5h9.2"/>',
  bucket: '<path d="M6.1 2.2 12.4 8.5a1 1 0 0 1 0 1.4l-3.9 3.9a1 1 0 0 1-1.4 0L2.2 9a1 1 0 0 1 0-1.4l3.9-3.9zM3.6 7.6h8.6"/><path d="M14 10.6c.6.9.9 1.5.9 2a.9.9 0 1 1-1.8 0c0-.5.3-1.1.9-2z"/>',
  stamp: '<path d="M4.4 13.6h7.2M5.2 13.6v-2.3h5.6v2.3M6.3 11.3V9.6a1.7 1.7 0 0 1 3.4 0v1.7M5.7 2.4h4.6v3.2H5.7z"/>',
  retouch: '<path d="M8 2.1c1.3 1.5 4.2 4.9 4.2 7.1A4.2 4.2 0 0 1 8 13.4 4.2 4.2 0 0 1 3.8 9.2c0-2.2 2.9-5.6 4.2-7.1z"/>',
  tone: '<circle cx="8" cy="8" r="4.9"/><path d="M8 3.1v9.8M8 1.2v1M8 13.8v1M1.2 8h1M13.8 8h1"/>',
  shape: '<path d="M2.3 2.3h6.2v6.2H2.3z"/><circle cx="10.4" cy="10.4" r="3.3"/>',
  type: '<path d="M2.8 3h10.4M8 3v10M5.6 13h4.8"/>',
  pen: '<path d="M9.8 2.4 13.6 6.2 7 12.8 2.2 14.2a.4.4 0 0 1-.4-.4L3.2 9 9.8 2.4z"/><path d="M3.2 9l3.8 3.8M9.8 2.4l1.5-1.5 2.8 2.8-1.5 1.5"/>',
};

/* slot, key, capability, and the tools that share it. `sep` starts a new group
 * in the rail. Anything with a `cap` is dark until that capability is live. */
const IED_FAM = [
  { slot: "move", key: "v", icon: "move", cap: null, sep: false,
    tools: [["move", "Move"]] },
  { slot: "hand", key: "h", icon: "hand", cap: null,
    tools: [["hand", "Hand"]] },
  { slot: "zoom", key: "z", icon: "zoom", cap: null,
    tools: [["zoom", "Zoom"]] },
  { slot: "marquee", key: "m", icon: "marquee", cap: "selection", sep: true,
    tools: [["rectSelect", "Rectangle select"], ["ellipseSelect", "Ellipse select"]] },
  { slot: "lasso", key: "l", icon: "lasso", cap: "selection",
    tools: [["lasso", "Lasso"], ["polySelect", "Polygon lasso"]] },
  { slot: "wand", key: "w", icon: "wand", cap: "selection",
    tools: [["wand", "Magic wand"], ["colorRange", "Colour range"]] },
  { slot: "crop", key: "c", icon: "crop", cap: null, sep: true,
    tools: [["crop", "Crop"]] },
  { slot: "eye", key: "i", icon: "eye", cap: null,
    tools: [["eye", "Eyedropper"]] },
  { slot: "brush", key: "b", icon: "brush", cap: "strokes", sep: true,
    tools: [["brush", "Brush"]] },
  { slot: "eraser", key: "e", icon: "eraser", cap: "strokes",
    tools: [["eraser", "Eraser"]] },
  { slot: "fill", key: "g", icon: "bucket", cap: "strokes",
    tools: [["bucket", "Paint bucket"], ["gradient", "Gradient"]] },
  { slot: "stamp", key: "s", icon: "stamp", cap: "strokes",
    tools: [["clone", "Clone stamp"], ["heal", "Healing brush"]] },
  { slot: "retouch", key: "r", icon: "retouch", cap: "strokes",
    tools: [["smudge", "Smudge"], ["blur", "Blur"], ["sharpen", "Sharpen"]] },
  { slot: "tone", key: "o", icon: "tone", cap: "strokes",
    tools: [["dodge", "Dodge"], ["burn", "Burn"], ["sponge", "Sponge"]] },
  { slot: "shape", key: "u", icon: "shape", cap: "shapes", sep: true,
    tools: [["shapeRect", "Rectangle"], ["shapeEllipse", "Ellipse"], ["shapeLine", "Line"],
      ["shapePolygon", "Polygon"], ["shapeArrow", "Arrow"]] },
  { slot: "pen", key: "p", icon: "pen", cap: "paths",
    tools: [["pen", "Pen"]] },
  { slot: "type", key: "t", icon: "type", cap: null,
    tools: [["type", "Type"]] },
];
for (const f of IED_FAM) f.cur = f.tools[0][0];

const IED_TOOLS = IED_FAM.flatMap((f) => f.tools.map(([id]) => id));
const IED_KEYS = Object.fromEntries(IED_FAM.map((f) => [f.key, f.slot]));
const IED_FAMOF = Object.fromEntries(IED_FAM.flatMap((f) => f.tools.map(([id]) => [id, f])));
const IED_LABEL = Object.fromEntries(IED_FAM.flatMap((f) => f.tools.map(([id, lab]) => [id, lab])));
/* Which §5 tool a stroke is; the shape kind a §6 tool draws. Written as maps
 * rather than string surgery on the tool id, because "shapeRect" -> "rect" is
 * the kind of derivation that survives until someone adds "shapeRoundRect". */
const IED_SHAPEKIND = { shapeRect: "rect", shapeEllipse: "ellipse", shapeLine: "line",
  shapePolygon: "polygon", shapeArrow: "arrow" };
const IED_SELKIND = { rectSelect: "rect", ellipseSelect: "ellipse", lasso: "polygon",
  polySelect: "polygon", wand: "wand", colorRange: "colorRange" };
const iedIsStroke = (t) => IED_FAMOF[t]?.cap === "strokes";
const iedIsSelect = (t) => !!IED_SELKIND[t];
const iedIsShape = (t) => !!IED_SHAPEKIND[t];

function iedRailBuild() {
  const rail = $("iedTools");
  if (!rail) return;
  rail.innerHTML = IED_FAM.map((f) => {
    const multi = f.tools.length > 1;
    const names = f.tools.map(([, lab]) => lab).join(" · ");
    return (f.sep ? '<div class="iedtoolgap"></div>' : "")
      + `<button class="iedtool${multi ? " multi" : ""}" data-iedslot="${f.slot}"`
      + ` data-iedtool="${f.cur}" data-key="${f.key.toUpperCase()}"`
      + ` title="${esc(names)} — ${f.key.toUpperCase()}${multi ? ", Shift+" + f.key.toUpperCase() + " cycles" : ""}">`
      + `<svg viewBox="0 0 16 16" aria-hidden="true">${IED_ICON[f.icon]}</svg></button>`;
  }).join("");
  for (const b of rail.querySelectorAll("[data-iedslot]")) {
    b.onclick = () => iedSetTool(IED_FAM.find((f) => f.slot === b.dataset.iedslot).cur);
  }
  iedRailEnable();
}

/* One place decides whether a rail button is live, so "SVG has no pixel tools"
 * and "the stroke module has not landed" cannot each half-set it. */
function iedRailEnable() {
  const svg = !!ied.name && ied.name.toLowerCase().endsWith(".svg");
  for (const f of IED_FAM) {
    const b = document.querySelector(`[data-iedslot="${f.slot}"]`);
    if (!b) continue;
    const viewOnly = f.slot === "move" || f.slot === "zoom" || f.slot === "hand";
    const off = (svg && !viewOnly) || !iedCapLive(f.cap);
    b.disabled = off;
    const names = f.tools.map(([, lab]) => lab).join(" · ");
    b.title = off
      ? `${names} — ${svg && !viewOnly ? "an SVG has no pixels to edit." : iedCapWhy(f.cap)}`
      : `${names} — ${f.key.toUpperCase()}${f.tools.length > 1 ? ", Shift+" + f.key.toUpperCase() + " cycles" : ""}`;
  }
}

/* The siblings of the active slot, as chips in the options bar. A slot holding
 * one tool renders nothing, and :empty hides the strip. */
function iedVariantsPaint() {
  const f = IED_FAMOF[ied.tool];
  const el = $("iedVariants");
  if (!el) return;
  if (!f || f.tools.length < 2) { el.innerHTML = ""; return; }
  el.innerHTML = f.tools.map(([id, lab]) =>
    `<button class="iedvarb${id === ied.tool ? " on" : ""}" data-iedvar="${id}"
       title="Shift+${f.key.toUpperCase()} cycles">${esc(lab)}</button>`).join("");
  for (const b of el.querySelectorAll("[data-iedvar]")) b.onclick = () => iedSetTool(b.dataset.iedvar);
}

function iedCursor() {
  const c = $("iedCanvas");
  c.className = "iedcanvas" + (
    ied.panning ? " grabbing"
    : (ied.space || ied.tool === "hand") ? " grab"
    : ied.tool === "type" ? " text"
    : ied.tool === "zoom" ? " zoomin"
    : (ied.tool === "crop" || ied.tool === "eye" || ied.tool === "pen" || iedIsSelect(ied.tool)
       || iedIsShape(ied.tool) || iedIsStroke(ied.tool)) ? " cross" : "");
}

function iedSetTool(t) {
  if (!IED_TOOLS.includes(t)) return;
  const fam = IED_FAMOF[t];
  const btn = document.querySelector(`[data-iedslot="${fam.slot}"]`);
  if (btn?.disabled) return;
  fam.cur = t;
  ied.tool = t;
  ied.cropping = t === "crop";
  ied.picking = t === "eye";
  ied.placingText = t === "type";
  // A half-drawn lasso, polygon or pen path does not survive a tool change.
  ied.selDraft = null; ied.shapeDraft = null; ied.strokeDraft = null; ied.pathDraft = null;
  for (const b of document.querySelectorAll("[data-iedslot]")) {
    b.classList.toggle("on", b.dataset.iedslot === fam.slot);
    if (b.dataset.iedslot === fam.slot) b.dataset.iedtool = t;
  }
  /* `data-optfor` holds a LIST — twelve brush tools share one options group,
   * and six selection tools share another. The old identity compare would have
   * shown none of them. */
  for (const o of document.querySelectorAll("[data-optfor]")) {
    o.hidden = !o.dataset.optfor.split(/\s+/).includes(t);
  }
  iedVariantsPaint(); iedStrokeOpts(); iedShapeOpts();
  iedCursor(); iedStatus(); iedOverlayPaint();
}

/* Shift+<key> cycles inside the slot; the plain key selects it. */
function iedCycleFam(f) {
  const i = f.tools.findIndex(([id]) => id === f.cur);
  iedSetTool(f.tools[(i + 1) % f.tools.length][0]);
}
iedRailBuild();
for (const b of document.querySelectorAll("[data-iedzoom]")) {
  b.onclick = () => {
    const v = b.dataset.iedzoom;
    if (v === "fit") iedFit();
    else if (v === "in") iedZoomCentre(ied.view.zoom * 1.6);
    else if (v === "out") iedZoomCentre(ied.view.zoom / 1.6);
    else iedZoomCentre(+v);
  };
}

/* Which docks a person keeps open is a working preference, not a session
 * detail, so it survives the reload. */
$("iedChkSave").onclick = iedChkExpectSave;
$("iedChkPass").onclick = () => iedChkVerdict(true);
$("iedChkFail").onclick = () => iedChkVerdict(false);

for (const d of document.querySelectorAll("[data-dock]")) {
  const key = `ied.dock.${d.dataset.dock}`;
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) d.open = saved === "1";
  } catch { /* private mode — the defaults in the markup stand */ }
  d.addEventListener("toggle", () => {
    try { localStorage.setItem(key, d.open ? "1" : "0"); } catch { /* ditto */ }
  });
}

/* Shortcuts are dead while the caret is in a field — the type tool's own input
 * lives in the options bar, so "crop" would otherwise cost you a C. */
addEventListener("keydown", (e) => {
  if ($("imgEd").hidden) return;
  const el = e.target;
  const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ""));
  if (e.key === "Escape" && !typing) {
    /* Escape peels one layer at a time. It used to close the whole console
     * from anywhere, which meant dismissing a dialog threw away the document. */
    if (!$("iedDlg").hidden) { iedDlgClose(); return; }
    if (document.querySelector(".iedmenu.open")) { iedMenuClose(); return; }
    if (ied.selDraft || ied.shapeDraft || ied.pathDraft) {
      ied.selDraft = null; ied.shapeDraft = null; ied.pathDraft = null; iedOverlayPaint(); return;
    }
    $("imgEd").hidden = true; return;
  }
  // Enter finishes the pen the way a double-click does — the options bar says
  // both, so both must be true.
  if (e.key === "Enter" && !typing && ied.pathDraft?.pending) {
    e.preventDefault(); iedPenClose(); return;
  }
  if (typing || e.metaKey || e.altKey) return;
  /* Every chord is looked up in the SAME table the menu renders from, so a
   * shortcut cannot drift from the row that advertises it. */
  const chord = (e.ctrlKey ? "Ctrl+" : "") + (e.shiftKey ? "Shift+" : "")
    + (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  const cmd = IED_BYKEY[chord];
  if (cmd) {
    e.preventDefault();
    if (iedCmdEnabled(cmd)) cmd.run();
    else iedToast(cmd.why ? cmd.why() : iedCapWhy(cmd.need));
    return;
  }
  if (e.ctrlKey) return;
  if (e.code === "Space") {
    if (!ied.space) { ied.space = true; iedCursor(); }
    e.preventDefault();
    return;
  }
  const slot = IED_KEYS[(e.key || "").toLowerCase()];
  if (slot) {
    e.preventDefault();
    const f = IED_FAM.find((x) => x.slot === slot);
    // A rail button that is dark cannot be clicked, so the key is the only
    // place left to say WHY. Silence here would read as a broken shortcut.
    if (!iedCapLive(f.cap)) { iedToast(`${f.tools[0][1]} — ${iedCapWhy(f.cap)}`); return; }
    if (e.shiftKey) iedCycleFam(f); else iedSetTool(f.cur);
  }
});
addEventListener("keyup", (e) => {
  if (e.code === "Space" && ied.space) { ied.space = false; iedCursor(); }
});
/* Watching the canvas rather than the window: collapsing a dock resizes it too,
 * and on open it has no size at all until the console is unhidden. */
if (typeof ResizeObserver === "function") {
  new ResizeObserver(() => {
    if (!$("imgEd").hidden && ied.fitted && $("iedImg").naturalWidth) iedFit();
  }).observe($("iedCanvas"));
}

/* chroma preview: the key applied at thumbnail size on a canvas — honest
 * enough to tune tolerance by eye; the exact render happens on Apply */
function iedKeyPreview() {
  const cv = $("iedKeyPrev");
  if (!ied.key) { cv.hidden = true; return; }
  const img = $("iedImg");
  const w = 260, h = Math.max(1, Math.round(img.naturalHeight * (260 / img.naturalWidth)));
  cv.width = w; cv.height = h; cv.hidden = false;
  const x = cv.getContext("2d");
  x.drawImage(img, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h);
  const [kr, kg, kb] = ied.key;
  const tol = (+$("iedKeyTol").value / 100) * 0.75 * 255, soft = (+$("iedKeySoft").value / 100) * 0.5 * 255;
  for (let i = 0; i < d.data.length; i += 4) {
    const dr = d.data[i] - kr, dg = d.data[i + 1] - kg, db = d.data[i + 2] - kb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    d.data[i + 3] = Math.min(255, Math.max(0, ((dist - tol) / Math.max(1, soft)) * 255));
  }
  x.putImageData(d, 0, 0);
}

function iedPreview() {
  const o = iedOps();
  for (const [id, v] of [["iedB", o.brightness], ["iedC", o.contrast], ["iedS", o.saturation],
    ["iedT", o.temperature], ["iedSh", o.sharpen], ["iedBl", o.blur], ["iedV", o.vignette]]) {
    $(id).nextElementSibling.textContent = v;
  }
  $("iedG").nextElementSibling.textContent = o.gamma.toFixed(2);
  // gamma approximated as a brightness nudge — exact only on Apply
  for (const [id, v] of [["iedShd", o.shadows], ["iedHl", o.highlights]]) {
    $(id).nextElementSibling.textContent = v;
  }
  const gApprox = Math.pow(0.5, 1 / Math.max(0.3, o.gamma)) / 0.5;
  const fx = [
    o.grayscale ? "grayscale(1)" : "", o.sepia ? "sepia(.9)" : "", o.invert ? "invert(1)" : "",
  ].filter(Boolean).join(" ");
  $("iedImg").style.filter = `brightness(${(o.brightness / 100) * gApprox}) contrast(${o.contrast / 100}) saturate(${o.saturation / 100}) blur(${o.blur}px) ${fx}`;
  // rotate/flip are part of the view transform now — iedApplyView owns transform
  iedApplyView();
  const t = o.temperature;
  const tint = $("iedTint");
  tint.style.background = t >= 0 ? "rgb(255,140,40)" : "rgb(40,120,255)";
  tint.style.opacity = Math.abs(t) / 100 * 0.28;
  $("iedVig").style.opacity = o.vignette / 100;
}

/* ── the image check ──────────────────────────────────────────────────────
 *
 * A person's verdict, going to the same place the agent's does. The two must
 * not diverge: a picture that an agent passed and a person failed is a
 * disagreement worth seeing, and that is only possible if both write the same
 * record. The only difference is the `by` field, which the server fills in
 * from who is asking.
 */
let iedChkName = null;

function iedChkPaint(d) {
  const state = d.state || "unchecked";
  const chip = $("iedChkState");
  chip.className = "chkstate " + state;
  const v = d.verdict;
  chip.textContent =
    state === "unchecked" ? "Nobody has looked at this yet."
    : state === "pass" ? `Checked by ${v.by} — looked right.`
    : state === "fail" ? `Checked by ${v.by} — ${v.failed.length} problem${v.failed.length === 1 ? "" : "s"}.`
    : "Checked, but the picture or the checklist has changed since — look again.";

  /* An empty checklist gets the suggestions, greyed as a placeholder rather
   * than filled in — typed-looking text nobody typed is how a checklist ends up
   * signed off without being read. Saving is what adopts them. */
  const suggested = d.suggested || [];
  const box = $("iedChkExpect");
  box.value = (d.expect || []).join("\n");
  box.placeholder = suggested.length
    ? suggested.join("\n")
    : "six strings\nfive fingers per hand\nno text in the frame";
  const sug = $("iedChkSuggest");
  sug.hidden = !(suggested.length && !(d.expect || []).length);
  sug.onclick = () => { box.value = suggested.join("\n"); iedChkExpectSave(); };
  $("iedChkNotes").value = v?.notes || "";

  /* Tick what FAILED, not what passed. The failures are the short list and the
   * useful one — nobody wants to confirm eleven things that were fine. */
  const failed = new Set(v?.failed || []);
  $("iedChkList").innerHTML = (d.expect || []).length
    ? (d.expect || []).map((e, i) =>
        `<label><input type="checkbox" data-chk="${i}"${failed.has(e) ? " checked" : ""}>
           <span>${esc(e)}</span></label>`).join("")
    : `<div class="none">No checklist yet — say what it was meant to contain above.</div>`;
}

function iedChkLoad(name) {
  iedChkName = name;
  fetch("/api/images/review", {
    method: "POST", headers: { "content-type": "application/json" },
    /* No thumbnail wanted here: the picture is already on screen at full size.
     * max_edge 256 is the smallest the server will make and it is thrown away —
     * the reply is being read for its checklist and verdict. */
    body: JSON.stringify({ name, max_edge: 256 }),
  }).then((r) => r.json()).then((d) => {
    if (d.error) return;
    iedChkPaint(d);
  }).catch(() => {});
}

function iedChkExpectSave() {
  if (!iedChkName) return;
  const expect = $("iedChkExpect").value.split("\n").map((l) => l.trim()).filter(Boolean);
  fetch("/api/images/expect", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: iedChkName, expect }),
  }).then((r) => r.json()).then(() => iedChkLoad(iedChkName)).catch(() => {});
}

function iedChkVerdict(ok) {
  if (!iedChkName) return;
  const boxes = [...document.querySelectorAll("[data-chk]")];
  const expect = $("iedChkExpect").value.split("\n").map((l) => l.trim()).filter(Boolean);
  const failed = boxes.filter((b) => b.checked).map((b) => expect[Number(b.dataset.chk)]).filter(Boolean);
  fetch("/api/images/verdict", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: iedChkName, ok, failed, notes: $("iedChkNotes").value }),
  }).then((r) => r.json()).then(() => iedChkLoad(iedChkName)).catch(() => {});
}

function openImageEditor(name) {
  const im = (state.images || []).find((x) => x.name === name);
  const m = im?.meta || {};
  ied.name = name; ied.rotate = 0; ied.flipH = false; ied.flipV = false;
  $("iedImg").src = `/api/image/${encodeURIComponent(name)}?v=${Date.now()}`;
  const d = m.at ? new Date(m.at) : null;
  $("iedMeta").innerHTML = [
    m.prompt ? esc(m.prompt) : esc(name),
    [d ? d.toLocaleString() : "", m.durationMs ? `${(m.durationMs / 1000).toFixed(1)}s render` : "",
     m.seed != null ? `seed ${m.seed}` : "", m.engine || "", m.editedFrom ? `edited from ${esc(m.editedFrom)}` : "",
     m.vectorFrom ? `traced from ${esc(m.vectorFrom)}` : ""].filter(Boolean).join(" · "),
  ].filter(Boolean).join("<br>");
  /* The per-item origin line (SPEC D2.4), from the ledger. One quiet line —
   * class + who edited — honouring the display toggle; a pre-ledger image
   * gets nothing rather than a guess. */
  if (!state.provenance || state.provenance.showBadges !== false) {
    fetch(`/api/provenance?asset=${encodeURIComponent(`images/${name}`)}`)
      .then((r) => r.json())
      .then((p) => {
        if (ied.name !== name || !p.summary || !p.summary.events) return;
        const s = p.summary;
        const bits = [`origin: ${s.class ? s.class.replace(/-/g, " ") : "unrecorded"}`];
        if (s.model) bits.push(s.model);
        if (s.editsBy?.user) bits.push(`${s.editsBy.user} human edit${s.editsBy.user > 1 ? "s" : ""}`);
        if (s.editsBy?.agent) bits.push(`${s.editsBy.agent} agent edit${s.editsBy.agent > 1 ? "s" : ""}`);
        $("iedMeta").insertAdjacentHTML("beforeend",
          `<br><span class="pvline">${esc(bits.join(" · "))}</span>`);
        /* The rights chip sits ON the origin row, because it is an answer about
         * the same fact that row states: this model made this picture, and this
         * is what that model's licence says about selling it. Appended after the
         * line rather than built into it — the catalogue read is a second fetch,
         * and the origin line must never wait on it. */
        rightsChipFor(s).then((html) => {
          if (ied.name !== name || !html) return;
          $("iedMeta").insertAdjacentHTML("beforeend", `<br>${html}`);
        });
      }).catch(() => {});
  }
  /* SVG is not the only view-only member any more: the gallery lists avif
   * exports (a browser renders them), but no pixel route takes one back as a
   * source — so the tool strip goes dark for ANY format outside png/jpg/webp,
   * exactly the set iedHasPixels() reads. */
  const isFinal = !/\.(png|jpe?g|webp)$/i.test(name);
  ied.crop = null; ied.cropping = false; ied.key = null; ied.picking = false;
  ied.curves = { master: [], r: [], g: [], b: [] }; ied.curveCh = "master";
  ied.autoLevels = false; ied.hsl = {}; ied.text = null; ied.placingText = false;
  ied.cropDrag = null; ied.panning = false; ied.space = false;
  ied.view = { zoom: 1, x: 0, y: 0 }; ied.fitted = true;
  /* A new document starts with an empty pipeline. Listed one by one rather
   * than by rebuilding `ied` from a key list — that is exactly how five
   * features in this codebase lost a field nobody noticed. */
  ied.fx = []; ied.fxSel = -1;
  ied.sel = []; ied.selDraft = null;
  ied.strokes = []; ied.strokeDraft = null; ied.cloneSrc = null;
  ied.shapes = []; ied.shapeDraft = null;
  ied.canvas = null; ied.geom = null; ied.levels = null; ied.ptr = null;
  ied.paths = []; ied.pathSel = -1; ied.pathDraft = null; ied.pathDraws = [];
  ied.text2 = null; ied.chanView = null;
  const chanCv = $("iedChanCanvas");
  if (chanCv) { chanCv.hidden = true; chanCv.width = chanCv.height = 0; }
  if ($("iedSelInvert")) { $("iedSelInvert").checked = false; $("iedSelAA").checked = true; }
  $("iedAutoLv").classList.remove("on");
  for (const id of ["iedGray", "iedSepia", "iedInv"]) $(id).classList.remove("on");
  $("iedPost").value = "0"; $("iedTxt").value = ""; $("iedTxtPrev").hidden = true;
  $("iedRw").value = ""; $("iedRh").value = "";
  for (const id of ["iedShd", "iedHl", "iedDn", "iedGr"]) { $(id).value = 0; $(id).nextElementSibling.textContent = "0"; }
  iedHslLoad();
  if (!$("iedTxtFont").options.length) {
    fetch("/api/fonts").then((r) => r.json()).then((d) => {
      const nice = (d.fonts || []).filter((f) => /^(arial|georgia|times|verdana|tahoma|impact|cour|comic|segoe|calibri|cambria|consol|trebuc|bahnschrift|garamond|palatino|book)/i.test(f));
      $("iedTxtFont").innerHTML = (nice.length ? nice : d.fonts || []).map((f) =>
        `<option${/^georgia/i.test(f) ? " selected" : ""}>${f}</option>`).join("");
    }).catch(() => {});
  }
  iedLayers.length = 0; iedLayerSel = -1; iedLayersPaint(); iedPresetsLoad();
  iedChkLoad(name);
  /* The ancestry strip: an edit chain nobody can see is just clutter in the
   * gallery. Click any ancestor to open it — that is the undo. */
  fetch(`/api/images/lineage/${encodeURIComponent(name)}`).then((r) => r.json()).then((d) => {
    const chain = (d.chain || []).slice(1);
    $("iedLineage").innerHTML = chain.length
      ? `<span class="hint">made from:</span> ` + chain.map((c) =>
          `<button class="lchip${c.exists ? "" : " gone"}" ${c.exists ? `data-lineage="${esc(c.name)}"` : "disabled"}
             title="${esc(c.via || "source")}${c.exists ? "" : " — file is gone"}">${esc(c.via || "source")}</button>`).join("")
      : "";
    for (const b of document.querySelectorAll("[data-lineage]")) {
      b.onclick = () => openImageEditor(b.dataset.lineage);
    }
  }).catch(() => { $("iedLineage").innerHTML = ""; });
/* The histogram and curve panel need the PIXELS. A cached image fires no
   * load event, so paint immediately when it is already decoded — otherwise
   * reopening a seen image showed the previous one's histogram. */
  const paintFromPixels = () => {
    iedHist = iedHistogram(); iedDrawCurve();
    iedFit();                            // fit needs naturalWidth, so it waits here too
    iedDocInfo(); iedTextSync();
    iedChanPaint();                      // the channel thumbnails need the pixels too
  };
  $("iedImg").onload = paintFromPixels;
  if ($("iedImg").complete && $("iedImg").naturalWidth) paintFromPixels();
  $("iedCropLbl").textContent = "drag on the image"; $("iedCropClear").hidden = true;
  $("iedKeyChip").hidden = true; $("iedKeyPrev").hidden = true;
  $("iedCropBox").hidden = true;
  /* An SVG — or any format the pixel routes refuse — is final: download or
   * trash it. Every pixel surface goes away, and so do the tools that would
   * drive one; the whole point of a tool strip is that what is lit is what
   * works. */
  for (const id of ["iedSliders", "iedVec", "iedKey", "iedKeyPanel", "iedXform", "iedResize",
    "iedApply", "iedDockAdjust", "iedDockEffects", "iedDockLayers", "iedDockPresets",
    "iedDockFx", "iedDockSel", "iedDockPaint",
    "iedDockChannels", "iedDockPaths", "iedDockChar"]) {
    $(id).hidden = isFinal;
  }
  for (const id of ["iedCut", "iedUp"]) $(id).disabled = isFinal;
  iedRailEnable();
  iedSetTool("move");
  iedFxPaint(); iedSelPaint(); iedPaintQueuePaint(); iedCapNotes();
  iedPathsPaint(); iedCharPaint(); iedChanPaint(); iedSwLoad();
  iedUndoReset();
  /* Ask the server what it can do, once per session. Everything above has
   * already rendered in its OFF state, so a slow or failed probe leaves an
   * honest console rather than a half-built one. */
  iedProbeCaps().then(() => {
    iedFxPaint(); iedRailEnable();
    // The Character dock is generated from the tool catalog, fetched once —
    // after the probe, so a dark text capability never shows live controls.
    iedToolsLoad().then(() => iedCharPaint());
  });
  for (const [id, v] of [["iedB", 100], ["iedC", 100], ["iedS", 100], ["iedG", 100],
    ["iedT", 0], ["iedSh", 0], ["iedBl", 0], ["iedV", 0]]) $(id).value = v;
  $("iedDl").href = `/api/image/${encodeURIComponent(name)}`;
  $("iedDl").setAttribute("download", name);
  /* Download opens the EXPORT dialog — format, quality, byte budget — through
   * /api/images/export, the same encoder image_export drives over MCP. An SVG
   * is already its final format, so it keeps the raw one-click download. */
  $("iedDl").onclick = (e) => {
    if (/\.svg$/i.test(name)) return;
    e.preventDefault();
    iedExportDlg();
  };
  $("iedDocName").textContent = name;
  iedPaintNav();
  iedPreview();
  $("imgEd").hidden = false;
  /* The canvas has no size until the console is on screen, so the first fit has
   * to happen after the unhide — a cached image would otherwise fit to zero. */
  if ($("iedImg").complete && $("iedImg").naturalWidth) { iedFit(); iedDocInfo(); }
}

for (const id of ["iedB", "iedC", "iedS", "iedG", "iedT", "iedSh", "iedBl", "iedV", "iedShd", "iedHl"]) {
  $(id).oninput = iedPreview;
}

/* curve interaction: click adds, drag moves, double-click removes */
{
  const cv = $("iedCurve");
  let dragging = -1;
  const toVal = (e) => {
    const r = cv.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / r.width) * 255),
            Math.round((1 - (e.clientY - r.top) / r.height) * 255)];
  };
  cv.addEventListener("pointerdown", (e) => {
    const [vx, vy] = toVal(e);
    const pts = ied.curves[ied.curveCh];
    dragging = pts.findIndex(([px]) => Math.abs(px - vx) < 12);
    if (dragging === -1) { pts.push([vx, vy]); pts.sort((a, b) => a[0] - b[0]); dragging = pts.findIndex(([px]) => px === vx); }
    try { cv.setPointerCapture(e.pointerId); } catch { /* the point is already pushed; draw it regardless */ }
    iedDrawCurve();
  });
  cv.addEventListener("pointermove", (e) => {
    if (dragging === -1) return;
    const [vx, vy] = toVal(e);
    const pts = ied.curves[ied.curveCh];
    pts[dragging] = [Math.max(1, Math.min(254, vx)), Math.max(0, Math.min(255, vy))];
    pts.sort((a, b) => a[0] - b[0]);
    iedDrawCurve();
  });
  cv.addEventListener("pointerup", () => { dragging = -1; });
  cv.addEventListener("dblclick", (e) => {
    const [vx] = toVal(e);
    const pts = ied.curves[ied.curveCh];
    const i = pts.findIndex(([px]) => Math.abs(px - vx) < 12);
    if (i !== -1) { pts.splice(i, 1); iedDrawCurve(); }
  });
}
for (const b of document.querySelectorAll("[data-curvech]")) {
  b.onclick = () => {
    ied.curveCh = b.dataset.curvech;
    document.querySelectorAll("[data-curvech]").forEach((x) => x.classList.toggle("on", x === b));
    iedDrawCurve();
  };
}
$("iedCurveReset").onclick = () => { ied.curves = { master: [], r: [], g: [], b: [] }; iedDrawCurve(); };
$("iedAutoLv").onclick = () => {
  ied.autoLevels = !ied.autoLevels;
  $("iedAutoLv").classList.toggle("on", ied.autoLevels);
};

/* HSL panel: sliders edit the selected band's entry */
function iedHslLoad() {
  const b = ied.hsl[$("iedHslBand").value] || {};
  $("iedHslH").value = b.h || 0; $("iedHslS").value = b.s || 0; $("iedHslL").value = b.l || 0;
  for (const id of ["iedHslH", "iedHslS", "iedHslL"]) $(id).nextElementSibling.textContent = $(id).value;
  const active = Object.entries(ied.hsl).filter(([, a]) => a.h || a.s || a.l).map(([k]) => k);
  $("iedHslActive").textContent = active.length ? `edited: ${active.join(", ")} — exact on Apply` : "";
}
$("iedHslBand").onchange = iedHslLoad;
for (const [id, key] of [["iedHslH", "h"], ["iedHslS", "s"], ["iedHslL", "l"]]) {
  $(id).oninput = () => {
    const band = $("iedHslBand").value;
    ied.hsl[band] = ied.hsl[band] || {};
    ied.hsl[band][key] = +$(id).value;
    $(id).nextElementSibling.textContent = $(id).value;
    iedHslLoad();
  };
}

/* effect toggles preview via CSS filter where CSS can */
for (const id of ["iedGray", "iedSepia", "iedInv"]) {
  $(id).onclick = () => { $(id).classList.toggle("on"); iedPreview(); };
}
$("iedPost").onchange = iedPreview; $("iedDn").oninput = iedPreview; $("iedGr").oninput = iedPreview;

/* The type tool: live overlay, exact on Apply.
 * The overlay lives in the VIEWPORT, not inside the scaled frame: the frame
 * carries the flips, and text drawn into a mirrored frame previews backwards
 * while the server renders it the right way round. Positions are frame pixels
 * scaled into view — the same walk iedFramePoint() does in reverse. */
function iedTextSync() {
  const p = $("iedTxtPrev");
  /* One preview for both spellings: the v2 spec keeps position in box[0..1]
   * (anchor "center" by default, which is exactly the -50%,-50% below), the
   * legacy one in x/y. */
  const t = ied.text2
    ? (String(ied.text2.content || "").trim()
      ? { content: ied.text2.content, x: ied.text2.box[0], y: ied.text2.box[1], size: ied.text2.size }
      : null)
    : (ied.text?.content ? ied.text : null);
  if (!t) { p.hidden = true; return; }
  const z = ied.view.zoom;
  p.hidden = false;
  p.textContent = t.content;
  p.style.left = `${ied.view.x + t.x * z}px`;
  p.style.top = `${ied.view.y + t.y * z}px`;
  p.style.transform = "translate(-50%,-50%)";     // "mm" anchor, same as Pillow's
  p.style.fontSize = `${t.size * z}px`;
  p.style.color = $("iedTxtColor").value;
  p.style.fontFamily = ($("iedTxtFont").value || "arial.ttf").replace(/\.(ttf|otf)$/i, "");
  const sw = +$("iedTxtStroke").value;
  p.style.webkitTextStroke = sw ? `${Math.max(1, sw * z)}px ${$("iedTxtStrokeC").value}` : "";
}
const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function iedTextUpdate() {
  const content = $("iedTxt").value.trim();
  /* With the text capability live and the catalog fetched, the options bar
   * writes into the FULL spec the Character dock also edits — one object, two
   * views of it. Without them, the legacy path below runs byte for byte. */
  if (iedCapLive("text") && iedToolsCat?.text?.text?.params) {
    if (!content) { ied.text2 = null; ied.text = null; iedTextSync(); iedCharPaint(); return; }
    iedText2Ensure();
    const t = ied.text2;
    t.content = content;
    t.size = +$("iedTxtSize").value || 72;
    t.font = $("iedTxtFont").value || "arial.ttf";
    t.fill.color = hex2rgb($("iedTxtColor").value);
    t.outline.width = +$("iedTxtStroke").value;
    t.outline.color = hex2rgb($("iedTxtStrokeC").value);
    iedTextSync(); iedCharPaint();
    return;
  }
  if (!content) { ied.text = null; iedTextSync(); return; }
  ied.text = {
    content, size: +$("iedTxtSize").value || 72,
    color: hex2rgb($("iedTxtColor").value),
    font: $("iedTxtFont").value || "arial.ttf",
    align: "center",
    stroke: +$("iedTxtStroke").value, strokeColor: hex2rgb($("iedTxtStrokeC").value),
    // frame pixels, not source: the server draws type after the rotation
    x: ied.text?.x ?? Math.round(iedRotSize().w / 2),
    y: ied.text?.y ?? Math.round(iedRotSize().h * 0.9),
  };
  iedTextSync();
}
for (const id of ["iedTxt", "iedTxtSize", "iedTxtColor", "iedTxtStrokeC", "iedTxtStroke", "iedTxtFont"]) {
  $(id).oninput = iedTextUpdate;
}
$("iedAuto").onclick = async () => {
  const btn = $("iedAuto"); btn.disabled = true; btn.textContent = "reading\u2026";
  try {
    const r = await (await fetch("/api/images/analyze", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: ied.name }) })).json();
    if (r.error) { alert(r.error); return; }
    const o = r.ops || {};
    if (o.saturation != null) $("iedS").value = o.saturation;
    if (o.shadows != null) $("iedShd").value = o.shadows;
    if (o.highlights != null) $("iedHl").value = o.highlights;
    ied.autoLevels = !!o.autoLevels;
    $("iedAutoLv").classList.toggle("on", ied.autoLevels);
    if (o.curves?.master) ied.curves.master = o.curves.master.slice(1, -1);
    iedDrawCurve(); iedPreview();
    $("iedLineage").insertAdjacentHTML("afterbegin",
      `<p class="hint autonote">${(r.notes || []).map(esc).join("<br>") || "nothing to fix — it already reads well"}</p>`);
  } finally { btn.disabled = false; btn.innerHTML = "\u2726 auto"; }
};
/* Rotating changes the frame's aspect, so a view that was fitted re-fits and a
 * view somebody zoomed in by hand is left where they put it. */
const iedReframe = () => { if (ied.fitted) iedFit(); iedPreview(); };
/* Each of these PUSHES a history step — the clip-toggle lesson again: the
 * snapshot has always carried rotate/flipH/flipV, so an unpushed rotation was
 * silently reset by clicking ANY history entry, with nothing to redo. */
$("iedRot").onclick = () => { ied.rotate = (ied.rotate + 90) % 360; iedReframe(); iedPush(`rotate to ${ied.rotate}°`); };
$("iedFH").onclick = () => { ied.flipH = !ied.flipH; iedReframe(); iedPush(ied.flipH ? "flip horizontal" : "unflip horizontal"); };
$("iedFV").onclick = () => { ied.flipV = !ied.flipV; iedReframe(); iedPush(ied.flipV ? "flip vertical" : "unflip vertical"); };
$("iedReset").onclick = () => { ied.rotate = 0; ied.flipH = false; ied.flipV = false;
  for (const [id, v] of [["iedB", 100], ["iedC", 100], ["iedS", 100], ["iedG", 100],
    ["iedT", 0], ["iedSh", 0], ["iedBl", 0], ["iedV", 0]]) $(id).value = v;
  iedReframe(); iedPush("reset adjustments"); };
$("iedClose").onclick = () => { $("imgEd").hidden = true; };
/* No click-outside-to-close any more: the console fills the screen and the
 * canvas is something you drag on. A stray pointer-up must not throw the edit
 * away. Escape and ✕ close it. */

$("iedApply").onclick = async () => {
  const btn = $("iedApply"); btn.disabled = true; btn.textContent = "Rendering…";
  try {
    const r = await (await fetch("/api/images/edit", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: ied.name, ops: iedOps() }) })).json();
    if (r.error) { alert(r.error); return; }
    await loadImages();
    openImageEditor(r.name);           // chain further edits on the result
  } finally { btn.disabled = false; btn.textContent = "Apply → new image"; }
};

$("iedVecGo").onclick = async () => {
  const btn = $("iedVecGo"); btn.disabled = true; btn.textContent = "Tracing…";
  try {
    const r = await (await fetch("/api/images/vectorize", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: ied.name, colors: +$("iedVecColors").value }) })).json();
    if (r.error) { alert(r.error); return; }
    await loadImages();
    openImageEditor(r.name);
  } finally { btn.disabled = false; btn.textContent = "Trace to SVG"; }
};

$("iedReuse2").onclick = () => {
  const m = (state.images || []).find((x) => x.name === ied.name)?.meta;
  if (!m?.prompt) return;
  $("imgPrompt").value = m.prompt; if (m.seed != null) $("imgSeed").value = m.seed;
  $("imgEd").hidden = true; $("imgPrompt").focus();
};
$("iedBlur").onclick = async () => {
  const m = (state.images || []).find((x) => x.name === ied.name)?.meta || {};
  const r = await (await fetch("/api/images/flag", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: ied.name, blur: !m.blur }) })).json();
  if (r.error) { alert(r.error); return; }
  await loadImages();
  $("iedBlur").textContent = r.blur ? "unblur in gallery" : "blur in gallery";
};
$("iedReveal2").onclick = () => {
  fetch("/api/reveal", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: ied.name }) }).catch(() => {});
};
/* ── crop: drag a rectangle over the picture ── */
$("iedCrop").onclick = () => {
  iedSetTool("crop");
  ied.crop = null; ied.cropDrag = null;
  $("iedCropLbl").textContent = "drag on the image…"; $("iedCropClear").hidden = true;
  iedPaintCrop();
};
$("iedCropClear").onclick = () => {
  ied.crop = null; ied.cropDrag = null;
  $("iedCropLbl").textContent = "drag on the image"; $("iedCropClear").hidden = true;
  iedPaintCrop();
};

/* eyedropper: read the pixel from an offscreen sample at natural size */
function iedPickAt(e) {
  const img = $("iedImg");
  if (!img.naturalWidth) return;
  const p = iedImgPoint(e);
  const cv = document.createElement("canvas");
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const x = cv.getContext("2d");
  x.drawImage(img, 0, 0);
  const px = x.getImageData(Math.min(p.x, cv.width - 1), Math.min(p.y, cv.height - 1), 1, 1).data;
  ied.key = [px[0], px[1], px[2]];
  const chip = $("iedKeyChip");
  chip.hidden = false;
  chip.style.background = `rgb(${px[0]},${px[1]},${px[2]})`;
  chip.title = `rgb(${px[0]},${px[1]},${px[2]}) — keyed to transparency on Apply`;
  iedKeyPreview();
}

/* ── the canvas pointer: the active tool decides, and pan always wins ──────
 * Attached to the VIEWPORT rather than the <img>, so a drag that starts or ends
 * off the picture still resolves (iedImgPoint clamps it) instead of silently
 * dropping the gesture the way the old <img>-bound handlers did. */
{
  const cv = $("iedCanvas");
  let mode = null, start = null, from = null;
  // capture keeps a drag alive past the edge of the canvas; a browser that
  // refuses it must not take the whole gesture down with it
  const grab = (e) => { try { cv.setPointerCapture(e.pointerId); } catch { /* keep dragging */ } };
  cv.addEventListener("pointerdown", (e) => {
    if ($("imgEd").hidden || !$("iedImg").naturalWidth) return;
    if (e.button === 1 || ied.space || ied.tool === "hand") {
      mode = "pan"; from = { x: e.clientX, y: e.clientY, vx: ied.view.x, vy: ied.view.y };
      ied.panning = true; iedCursor();
      grab(e); e.preventDefault(); return;
    }
    if (e.button !== 0) return;
    if (ied.tool === "zoom") {
      iedZoomAt(e.clientX, e.clientY, ied.view.zoom * (e.altKey || e.shiftKey ? 1 / 1.6 : 1.6));
      e.preventDefault(); return;
    }
    if (ied.tool === "eye") { iedPickAt(e); e.preventDefault(); return; }
    if (ied.tool === "type") {
      const has = ied.text2 ? String(ied.text2.content || "").trim() : ied.text?.content;
      if (!has) { $("iedTxt").focus(); return; }
      const p = iedFramePoint(e);
      if (ied.text2) { ied.text2.box[0] = p.x; ied.text2.box[1] = p.y; iedCharPaint(); }
      else { ied.text.x = p.x; ied.text.y = p.y; }
      iedTextSync();
      e.preventDefault(); return;
    }
    if (ied.tool === "crop") {
      mode = "crop"; start = iedImgPoint(e);
      ied.cropDrag = { x: start.x, y: start.y, w: 0, h: 0 };
      iedPaintCrop(); grab(e); e.preventDefault();
      return;
    }
    /* §3, §5, §6 all live in STAGE coordinates — post-crop, post-geometry —
     * because that is the frame the server resolves them in. iedStagePoint()
     * is the one place that walk happens. */
    const sp = iedStagePoint(e);
    if (ied.tool === "pen") {
      if (!ied.pathDraft?.pending) ied.pathDraft = { pending: true, points: [] };
      ied.pathDraft.points.push([sp.x, sp.y]);
      iedOverlayPaint();
      e.preventDefault(); return;
    }
    if (iedIsSelect(ied.tool)) {
      mode = iedSelDown(sp, e); if (mode) { grab(e); e.preventDefault(); }
      return;
    }
    if (iedIsStroke(ied.tool)) {
      // Alt-click is where a clone or heal SAMPLES from; §5 fixes the offset at
      // stroke start, so it has to be set before the first drag, not after.
      if (e.altKey && (ied.tool === "clone" || ied.tool === "heal")) {
        ied.cloneSrc = [sp.x, sp.y]; iedStrokeOpts(); iedOverlayPaint(); e.preventDefault(); return;
      }
      mode = iedStrokeDown(sp, e); if (mode) { grab(e); e.preventDefault(); }
      return;
    }
    if (iedIsShape(ied.tool)) {
      mode = iedShapeDown(sp); if (mode) { grab(e); e.preventDefault(); }
    }
  });
  cv.addEventListener("pointermove", (e) => {
    // The readout is the cheapest honesty in the console: it says which pixel
    // the server would be told about, in the space the server works in.
    if (!$("iedImg").naturalWidth) return;
    ied.ptr = iedStagePoint(e);
    if (mode === "pan") {
      ied.view.x = from.vx + (e.clientX - from.x);
      ied.view.y = from.vy + (e.clientY - from.y);
      ied.fitted = false; iedApplyView();
      return;
    }
    if (mode === "crop") {
      const p = iedImgPoint(e);
      ied.cropDrag = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      iedPaintCrop(); return;
    }
    if (mode === "sel") { iedSelMove(ied.ptr); return; }
    if (mode === "stroke") { iedStrokeMove(ied.ptr, e); return; }
    if (mode === "shape") { iedShapeMove(ied.ptr); return; }
    iedStatus();
    if (ied.selDraft?.pending || ied.shapeDraft?.pending || ied.pathDraft?.pending) iedOverlayPaint();
  });
  const end = (e) => {
    if (mode === "pan") { ied.panning = false; iedCursor(); }
    if (mode === "crop") {
      const r = ied.cropDrag; ied.cropDrag = null;
      // 8px of slop, same threshold as before — a click is not a crop
      if (r && r.w > 8 && r.h > 8) {
        ied.crop = r;
        $("iedCropLbl").textContent = `${r.w}×${r.h} @ ${r.x},${r.y}`;
        $("iedCropClear").hidden = false;
        iedPush(`crop ${r.w}×${r.h}`);
      }
      iedPaintCrop();
    }
    if (mode === "sel") iedSelUp();
    if (mode === "stroke") iedStrokeUp();
    if (mode === "shape") iedShapeUp();
    mode = null; start = null;
    if (e?.pointerId != null) { try { cv.releasePointerCapture(e.pointerId); } catch { /* already gone */ } }
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("wheel", (e) => {
    if ($("imgEd").hidden || !$("iedImg").naturalWidth) return;
    e.preventDefault();
    /* SCROLL LOCK: the wheel walks the library instead of zooming.
     *
     * Throttled, because one flick of a wheel is a dozen events and without
     * this it would skip half the library in a heartbeat. 220 ms is about the
     * fastest a person can actually look at an image and decide. */
    if (ied.scrollLock) {
      const now = Date.now();
      if (now - (ied.lastStep || 0) < 220) return;
      ied.lastStep = now;
      iedStep(e.deltaY > 0 ? 1 : -1);
      return;
    }
    iedZoomAt(e.clientX, e.clientY, ied.view.zoom * Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  /* A polygon — lasso or shape — is closed by the second click, and the browser
   * would otherwise select the whole console under the drag. */
  cv.addEventListener("dblclick", (e) => {
    e.preventDefault();
    if (ied.selDraft?.pending) iedSelClosePoly();
    else if (ied.shapeDraft?.pending) iedShapeClosePoly();
    else if (ied.pathDraft?.pending) iedPenClose();
  });
}
/* ── stepping through the library from inside the editor ──
 *
 * Reviewing a batch meant close, scroll, find the next one, reopen — per
 * image. The editor already knows the whole list (state.images is what it was
 * opened from), so it can just move along it.
 *
 * ⚠ IT REOPENS RATHER THAN SWAPPING THE SRC. openImageEditor resets rotation,
 * flips, the layer stack, history and the preview; assigning a new src alone
 * would carry the previous image's edit state onto the next picture, which is
 * the kind of bug that quietly destroys work. */
function iedList() {
  return (state.images || []).map((x) => x.name);
}
function iedStep(delta) {
  const list = iedList();
  if (!list.length || !ied.name) return;
  const at = list.indexOf(ied.name);
  if (at < 0) return;
  const next = list[Math.min(list.length - 1, Math.max(0, at + delta))];
  if (!next || next === ied.name) return;
  const keep = ied.scrollLock;          // the mode survives the reopen
  openImageEditor(next);
  ied.scrollLock = keep;
  iedPaintNav();
}
function iedPaintNav() {
  const list = iedList();
  const at = list.indexOf(ied.name);
  const pos = $("iedPos");
  if (pos) pos.textContent = at >= 0 ? `${at + 1} / ${list.length}` : "";
  const prev = $("iedPrev"), next = $("iedNext");
  if (prev) prev.disabled = at <= 0;
  if (next) next.disabled = at < 0 || at >= list.length - 1;
  const lock = $("iedScrollLock");
  if (lock) {
    lock.classList.toggle("on", !!ied.scrollLock);
    lock.setAttribute("aria-pressed", ied.scrollLock ? "true" : "false");
  }
}
$("iedPrev").onclick = () => iedStep(-1);
$("iedNext").onclick = () => iedStep(1);
$("iedScrollLock").onclick = () => { ied.scrollLock = !ied.scrollLock; iedPaintNav(); };
/* Page Up/Down as well — the wheel is not the only way people move a list, and
 * these do not collide with any editor shortcut. */
document.addEventListener("keydown", (e) => {
  if ($("imgEd").hidden) return;
  if (e.target.matches("input, textarea, select")) return;
  if (e.key === "PageUp") { e.preventDefault(); iedStep(-1); }
  else if (e.key === "PageDown") { e.preventDefault(); iedStep(1); }
});

$("iedPick").onclick = () => iedSetTool("eye");
$("iedKeyTol").oninput = iedKeyPreview;
$("iedKeySoft").oninput = iedKeyPreview;

/* ── model tools: cutout + upscale, both new library files ── */
async function iedModelTool(url, btnId, busy) {
  const btn = $(btnId); const was = btn.textContent;
  btn.disabled = true; btn.textContent = busy;
  try {
    const r = await (await fetch(url, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: ied.name }) })).json();
    if (r.error) { alert(r.error); return; }
    await loadImages();
    openImageEditor(r.name);
  } finally { btn.disabled = false; btn.textContent = was; }
}
$("iedCut").onclick = () => iedModelTool("/api/images/cutout", "iedCut", "removing…");
$("iedUp").onclick = () => iedModelTool("/api/images/upscale", "iedUp", "upscaling…");

/* -- layers + presets ------------------------------------------------- */
const iedLayers = [];
let iedLayerSel = -1;

function iedLayersPaint() {
  /* Each row is followed by a thin clip zone \u2014 the BORDER BENEATH it, between
   * this layer and whatever is below (another layer, or the base image, which
   * counts as a base too). Alt-clicking it is Photoshop's clipping-mask
   * gesture: the layer above the border keeps the alpha of the layer below as
   * its matte. A clipped row renders indented behind the bent-arrow marker,
   * exactly the familiar look. The list is painted top-down (reverse), so the
   * zone emitted AFTER row i lands visually beneath it. */
  $("iedLayerList").innerHTML = iedLayers.map((l, i) => `
    <div class="wrow layerrow${i === iedLayerSel ? " on" : ""}${l.clipped ? " clipped" : ""}" data-layersel="${i}">
      <span>${l.clipped ? `<b class="clipmark" title="clipped to the layer below">\u21b4</b>` : ""}${i + 1}\u00b7 ${esc(l.src.slice(0, 18))} <i class="dim">${esc(l.mode)}</i></span>
      <button class="edtool sm" data-layerdel="${i}">\u2715</button></div>
    <div class="layerclipzone${l.clipped ? " on" : ""}" data-clipzone="${i}"
      title="Alt-click: clip \u201c${esc(l.src.slice(0, 18))}\u201d to the layer below"></div>`).reverse().join("");
  for (const el of document.querySelectorAll("[data-layersel]")) {
    el.onclick = (e) => {
      if (e.target.closest("[data-layerdel]")) return;
      iedLayerSel = +el.dataset.layersel;
      const l = iedLayers[iedLayerSel];
      $("iedLx").value = l.xPct; $("iedLy").value = l.yPct;
      $("iedLs").value = Math.round(l.scale * 100); $("iedLo").value = Math.round(l.opacity * 100);
      iedLayersPaint();
    };
  }
  for (const z of document.querySelectorAll("[data-clipzone]")) {
    z.onclick = (e) => {
      if (!e.altKey) return;               // the gesture is ALT-click, as ever
      const l = iedLayers[+z.dataset.clipzone];
      if (l) {
        l.clipped = !l.clipped; iedLayersPaint();
        iedPush(l.clipped ? "clip to the layer below" : "release clipping mask");
      }
    };
  }
  for (const b of document.querySelectorAll("[data-layerdel]")) {
    b.onclick = () => {
      const [gone] = iedLayers.splice(+b.dataset.layerdel, 1);
      iedLayerSel = -1; iedLayersPaint();
      iedPush(`remove layer · ${(gone?.src || "").slice(0, 18)}`);
    };
  }
  $("iedLayerCtl").hidden = iedLayerSel < 0;
  $("iedCompose").hidden = !iedLayers.length;
  const pick = $("iedLayerPick");
  pick.innerHTML = `<option value="">+ add image\u2026</option>` + (state.images || []).slice(0, 60)
    .filter((im) => im.name !== ied.name && !im.name.endsWith(".svg"))
    .map((im) => `<option value="${esc(im.name)}">${esc((im.meta?.prompt || im.name).slice(0, 36))}</option>`).join("");
}
$("iedLayerPick").onchange = () => {
  const v = $("iedLayerPick").value;
  if (!v) return;
  iedLayers.push({ src: v, xPct: 50, yPct: 50, scale: 1, opacity: 1, mode: $("iedLayerMode").value });
  iedLayerSel = iedLayers.length - 1;
  iedLayersPaint();
  iedPush(`add layer · ${v.slice(0, 18)}`);
};
for (const [id, key, div] of [["iedLx", "xPct", 1], ["iedLy", "yPct", 1], ["iedLs", "scale", 100], ["iedLo", "opacity", 100]]) {
  $(id).oninput = () => {
    $(id).nextElementSibling.textContent = $(id).value + (div === 1 ? "%" : "");
    if (iedLayerSel < 0) return;
    iedLayers[iedLayerSel][key] = +$(id).value / div;
  };
  // One history step on release, the same grain the adjustment sliders record
  // at — `change` fires when the drag ends, `input` on every pixel of it.
  $(id).onchange = () => { if (iedLayerSel >= 0) iedPush(`layer ${key} ${$(id).value}`); };
}
$("iedCompose").onclick = async () => {
  const btn = $("iedCompose"); btn.disabled = true; btn.textContent = "compositing\u2026";
  try {
    const W = $("iedImg").naturalWidth, H = $("iedImg").naturalHeight;
    const r = await (await fetch("/api/images/composite", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base: ied.name, layers: iedLayers.map((l) => ({
        src: l.src, x: Math.round((l.xPct / 100) * W), y: Math.round((l.yPct / 100) * H),
        scale: l.scale, opacity: l.opacity, mode: l.mode, anchor: "center",
        clipped: !!l.clipped,
      })) }) })).json();
    if (r.error) { alert(r.error); return; }
    iedLayers.length = 0; iedLayerSel = -1;
    await loadImages();
    openImageEditor(r.name);
  } finally { btn.disabled = false; btn.textContent = "Composite \u2192 new image"; }
};

async function iedPresetsLoad() {
  try {
    const d = await (await fetch("/api/images/presets")).json();
    const keep = $("iedPreset").value;
    $("iedPreset").innerHTML = `<option value="">\u2014 none \u2014</option>` +
      Object.keys(d.presets || {}).map((k) => `<option${k === keep ? " selected" : ""}>${esc(k)}</option>`).join("");
    window._iedPresets = d.presets || {};
  } catch { /* none yet */ }
}
$("iedPresetSave").onclick = async () => {
  const name = (await appPrompt("Name this look:", ""));
  if (!name) return;
  const r = await (await fetch("/api/images/presets", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ops: iedOps() }) })).json();
  if (r.error) { alert(r.error); return; }
  await iedPresetsLoad();
  $("iedPreset").value = name;
};
$("iedPresetDel").onclick = async () => {
  const name = $("iedPreset").value;
  if (!name || !(await appConfirm(`Delete the preset "${name}"?`))) return;
  await fetch("/api/images/presets", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, remove: true }) });
  await iedPresetsLoad();
};
$("iedPresetApply").onclick = () => {
  const ops = (window._iedPresets || {})[$("iedPreset").value];
  if (!ops) return;
  const set = (id, v) => { if (v != null) $(id).value = v; };
  set("iedB", ops.brightness); set("iedC", ops.contrast); set("iedS", ops.saturation);
  set("iedG", ops.gamma != null ? Math.round(ops.gamma * 100) : null);
  set("iedT", ops.temperature); set("iedSh", ops.sharpen); set("iedBl", ops.blur);
  set("iedV", ops.vignette); set("iedShd", ops.shadows); set("iedHl", ops.highlights);
  set("iedDn", ops.denoise); set("iedGr", ops.grain);
  ied.curves = { master: [], r: [], g: [], b: [], ...(ops.curves || {}) };
  ied.autoLevels = !!ops.autoLevels; $("iedAutoLv").classList.toggle("on", ied.autoLevels);
  ied.hsl = ops.hsl || {};
  for (const [id, on] of [["iedGray", ops.grayscale], ["iedSepia", ops.sepia], ["iedInv", ops.invert]]) {
    $(id).classList.toggle("on", !!on);
  }
  $("iedPost").value = String(ops.posterize || 0);
  /* A preset is written by iedOps(), so it carries the effect stack, the
   * selection, the strokes, the shapes and the canvas too. Reading back only
   * the sliders would drop all of them on the floor without a word — the exact
   * "rebuilt from a key list" failure §9 names, and the reason this reader now
   * follows the writer rather than a remembered subset of it. */
  ied.levels = ops.levels ? iedClone(ops.levels) : null;
  ied.fx = (ops.effects || []).map((e) => ({ type: e.type, params: iedClone(e.params) || {}, on: true }));
  ied.fxSel = ied.fx.length ? 0 : -1;
  ied.sel = iedClone(ops.selection?.shapes) || [];
  if (ops.selection) {
    $("iedSelFeather").value = ops.selection.feather ?? 0;
    $("iedSelExpand").value = ops.selection.expand ?? 0;
    $("iedSelInvert").checked = !!ops.selection.invert;
    $("iedSelAA").checked = ops.selection.antialias !== false;
  }
  ied.strokes = iedClone(ops.strokes) || [];
  ied.shapes = iedClone(ops.shapes) || [];
  ied.pathDraws = iedClone(ops.paths) || [];
  if (ops.text?._v2) {
    ied.text2 = iedClone(ops.text);
    delete ied.text2._v2;                          // iedTextOp() re-stamps it
    iedTextBarSync(); iedTextSync();
  }
  ied.canvas = ops.canvas ? iedClone(ops.canvas) : null;
  ied.geom = ops.geometry ? iedClone(ops.geometry) : null;
  ied.crop = ops.crop ? iedClone(ops.crop) : ied.crop;
  $("iedCropClear").hidden = !ied.crop;
  $("iedCropLbl").textContent = ied.crop
    ? `${ied.crop.w}×${ied.crop.h} @ ${ied.crop.x},${ied.crop.y}` : "drag on the image";
  iedFxPaint(); iedSelPaint(); iedPaintQueuePaint(); iedPathQueuePaint(); iedCharPaint();
  iedHslLoad(); iedDrawCurve(); iedPreview();
  iedPush(`preset · ${$("iedPreset").value}`);
  /* A preset written where the modules exist can carry stages this server
   * cannot run. They are loaded, shown and NOT sent — and said out loud,
   * because silently dropping half a preset is how a recipe stops matching the
   * picture it was named after. */
  const dark = [["selection", ops.selection], ["strokes", ops.strokes?.length],
    ["shapes", ops.shapes?.length], ["geometry", ops.canvas || ops.geometry],
    ["paths", ops.paths?.length], ["text", ops.text?._v2]]
    .filter(([k, v]) => v && !iedCapLive(k)).map(([k]) => IED_CAPS[k].label);
  if (dark.length) iedToast(`This preset also carries ${dark.join(" and ")} — loaded, but this server has no stage for it yet, so Apply will leave it out.`);
};

/* ══ the console's second half ═════════════════════════════════════════════
 * Menu bar, effect stack, selection, strokes, shapes, navigator and an
 * uncommitted history. Everything below either drives a route that exists
 * today or is visibly dark with a reason — nothing pretends. */

/* A message in the status bar's hint slot, which is where the eye already is
 * when a control refuses. An alert() for "that is not built yet" is a punishment. */
let iedToastT = 0, iedToastUntil = 0;
function iedToast(msg) {
  if (!msg) return;
  $("iedStHint").textContent = msg;
  /* The timestamp, not just the timer: iedStatus() runs on every pointer move,
   * so without this the refusal was on screen for one frame and the user saw
   * a control that did nothing and said nothing. */
  iedToastUntil = Date.now() + 5000;
  clearTimeout(iedToastT);
  iedToastT = setTimeout(() => { iedToastUntil = 0; iedStatus(); }, 5000);
}

/* ── the capability probe ─────────────────────────────────────────────── */
let iedCapLog = null;
async function iedProbeCaps(force) {
  if (iedCapLog && !force) return iedCapLog;
  const log = [];
  let explicit = null;
  try {
    const r = await fetch("/api/images/capabilities");
    log.push({ url: "/api/images/capabilities", status: String(r.status) });
    if (r.ok) { const d = await r.json(); explicit = (d && (d.capabilities || d)) || null; }
  } catch { log.push({ url: "/api/images/capabilities", status: "unreachable" }); }
  for (const [k, c] of Object.entries(IED_CAPS)) {
    if (k === "effects") {
      // Already fetched for the Filter menu; asking twice would be theatre.
      await iedFxLoad();
      c.live = !!iedFxCat && Object.keys(iedFxCat).length > 0;
      log.push({ key: k, url: c.probe,
        status: c.live ? `200 · ${Object.keys(iedFxCat).length} effects` : (iedFxErr || "failed") });
      continue;
    }
    if (explicit && typeof explicit === "object" && k in explicit) {
      c.live = !!explicit[k];
      log.push({ key: k, url: "(declared by /api/images/capabilities)", status: c.live ? "yes" : "no" });
      continue;
    }
    try {
      const r = await fetch(c.probe);
      c.live = r.ok;
      log.push({ key: k, url: c.probe, status: String(r.status) });
    } catch {
      c.live = false;
      log.push({ key: k, url: c.probe, status: "unreachable" });
    }
  }
  iedCapLog = log;
  iedRailEnable(); iedMenuBuild(); iedCapNotes();
  return log;
}

/* The two docks whose whole contents depend on a capability say so at the top,
 * once, instead of every row carrying the same sentence. */
function iedCapNotes() {
  for (const [id, k] of [["iedSelCap", "selection"], ["iedPaintCap", "strokes"],
    ["iedPathCap", "paths"], ["iedCharCap", "text"]]) {
    const el = $(id); if (!el) continue;
    el.hidden = iedCapLive(k);
    el.textContent = iedCapWhy(k);
  }
  // The dock's own buttons go dark with the menu rows they mirror — one of the
  // two staying live would be a control that appears to work.
  for (const [id, k] of [["iedSelAll", "selection"], ["iedSelNone", "selection"],
    ["iedSelInv", "selection"], ["iedSelFromCrop", "selection"], ["iedSelClear", "selection"],
    ["iedStrokeUndo", "strokes"], ["iedPaintClear", "strokes"],
    ["iedPathFromSel", "paths"], ["iedPathSvg", "paths"], ["iedPathToSel", "paths"],
    ["iedPathStroke", "paths"], ["iedPathFill", "paths"]]) {
    const el = $(id); if (!el) continue;
    el.disabled = !iedCapLive(k);
    // The markup's own tooltip survives a disable/enable round trip.
    if (el.dataset.ownTitle === undefined) el.dataset.ownTitle = el.title || "";
    el.title = el.disabled ? iedCapWhy(k) : el.dataset.ownTitle;
  }
  for (const id of ["iedSelFeather", "iedSelExpand", "iedSelTol", "iedSelContig", "iedSelInvert", "iedSelAA"]) {
    $(id).disabled = !iedCapLive("selection");
  }
}

/* ── the overlay: ants, paths and rubber bands, in viewport pixels ─────── */
function iedOverlaySize() {
  const cv = $("iedOverlay"), host = $("iedCanvas");
  if (!cv || !host) return null;
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return null;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = `${w}px`; cv.style.height = `${h}px`;
  }
  const x = cv.getContext("2d");
  if (!x) return null;
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, w, h);
  return x;
}

/* A canvas cannot read a CSS variable, so the two would drift the moment the
 * palette moved — the overlay is drawn with the SAME tokens the sheet uses,
 * fetched once. */
const iedTokCache = {};
function iedTok(name, fallback) {
  if (iedTokCache[name] === undefined) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    iedTokCache[name] = v || fallback;
  }
  return iedTokCache[name];
}
const iedLiveInk = () => iedTok("--accent", "hsl(190,100%,57%)");
const iedRestInk = () => iedTok("--ink", "hsl(0,0%,96%)");
const iedMarkInk = () => iedTok("--secondary", "hsl(320,100%,70%)");

/* Marching ants without the marching: a dark line under a light dashed one,
 * which reads on any picture and costs no animation frame. */
function iedAnts(x, path, live) {
  x.lineWidth = 1;
  x.setLineDash([]);
  x.strokeStyle = "rgba(0,0,0,.75)";
  path(); x.stroke();
  x.setLineDash(live ? [3, 3] : [5, 4]);
  x.strokeStyle = live ? iedLiveInk() : iedRestInk();
  path(); x.stroke();
  x.setLineDash([]);
}

function iedPolyPath(x, pts, close) {
  x.beginPath();
  pts.forEach((p, i) => {
    const v = iedStageToView(p[0], p[1]);
    if (i) x.lineTo(v.x, v.y); else x.moveTo(v.x, v.y);
  });
  if (close) x.closePath();
}

/* An ellipse in stage space is not an ellipse in view space once the picture is
 * rotated, so it is walked as a polygon and every vertex goes through the same
 * transform as everything else. One transform, no special cases. */
function iedEllipsePts(cx, cy, rx, ry, n = 72) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
}

function iedShapePts(s) {
  if (s.kind === "rect") return [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]];
  if (s.kind === "ellipse") return iedEllipsePts(s.cx, s.cy, s.rx, s.ry);
  return s.points || [];
}

function iedOverlayPaint() {
  const x = iedOverlaySize();
  if (!x || !$("iedImg").naturalWidth) return;
  for (const s of ied.sel) {
    if (s.kind === "wand" || s.kind === "colorRange") { iedSeedMark(x, s); continue; }
    if (s.kind === "channel") continue;   // the mask IS the plane — no outline exists
    if (s.kind === "path") { iedPathAnts(x, s.paths, false); continue; }
    iedAnts(x, () => iedPolyPath(x, iedShapePts(s), true), false);
  }
  const d = ied.selDraft;
  if (d) {
    const pts = d.kind === "polygon" ? d.points
      : d.kind === "ellipse" ? iedEllipsePts(d.x + d.w / 2, d.y + d.h / 2, d.w / 2, d.h / 2)
      : [[d.x, d.y], [d.x + d.w, d.y], [d.x + d.w, d.y + d.h], [d.x, d.y + d.h]];
    if (pts.length) iedAnts(x, () => iedPolyPath(x, pts, !d.pending), true);
  }
  /* Queued strokes are drawn as the PATH they are, at the width they will be
   * stamped at — never as a fake brush. What the server makes of it is the
   * server's business, and pretending otherwise is how a preview lies. */
  for (const s of [...ied.strokes, ...(ied.strokeDraft ? [ied.strokeDraft] : [])]) {
    /* A path-stroke has no points of its own; `_ghost` is the dock's flattened
     * copy of the geometry, one polyline per subpath. */
    if (!s.points?.length && s._ghost) {
      for (const poly of s._ghost) iedStrokeGhost(x, { ...s, points: poly }, s === ied.strokeDraft);
      continue;
    }
    iedStrokeGhost(x, s, s === ied.strokeDraft);
  }
  for (const s of [...ied.shapes, ...(ied.shapeDraft ? [ied.shapeDraft] : [])]) {
    iedShapeGhost(x, s, s === ied.shapeDraft);
  }
  // Queued pen fills, then the SELECTED saved path, then the pen's own draft —
  // the same rest-vs-live inks everything else on this overlay uses.
  for (const d of ied.pathDraws) iedPathGhost(x, d);
  const selPath = ied.paths[ied.pathSel];
  if (selPath) iedPathAnts(x, selPath.subs, true);
  if (ied.pathDraft?.points?.length) {
    iedAnts(x, () => iedPolyPath(x, ied.pathDraft.points, false), true);
  }
  if (ied.cloneSrc && (ied.tool === "clone" || ied.tool === "heal")) {
    const v = iedStageToView(ied.cloneSrc[0], ied.cloneSrc[1]);
    x.strokeStyle = iedMarkInk(); x.lineWidth = 1.2;
    x.beginPath(); x.arc(v.x, v.y, 7, 0, Math.PI * 2); x.moveTo(v.x - 10, v.y);
    x.lineTo(v.x + 10, v.y); x.moveTo(v.x, v.y - 10); x.lineTo(v.x, v.y + 10); x.stroke();
  }
}

/* A wand seed has no client-side mask — the server decides which pixels the
 * tolerance reaches. Marking the seed is the honest amount of preview. */
function iedSeedMark(x, s) {
  const p = s.kind === "wand" ? [s.x, s.y] : (s.at || null);
  if (!p) return;
  const v = iedStageToView(p[0], p[1]);
  x.strokeStyle = iedLiveInk(); x.lineWidth = 1.4;
  x.beginPath(); x.arc(v.x, v.y, 5, 0, Math.PI * 2); x.stroke();
  x.beginPath(); x.moveTo(v.x - 9, v.y); x.lineTo(v.x + 9, v.y);
  x.moveTo(v.x, v.y - 9); x.lineTo(v.x, v.y + 9); x.stroke();
}

/* A saved path's outline. Point-subpaths draw; an SVG-d subpath has no client
 * geometry (the server flattens it) and is listed in the dock instead of
 * pretending to a shape here. */
function iedPathAnts(x, subs, live) {
  for (const sub of (subs || [])) {
    const pts = sub?.points;
    if (!pts || pts.length < 2) continue;
    iedAnts(x, () => iedPolyPath(x, pts, sub.closed !== false), live);
  }
}

/* A queued pen fill, drawn the way a queued shape is: translucent fill under a
 * quiet outline — the path, not a preview of the render. */
function iedPathGhost(x, d) {
  for (const sub of (d.paths || [])) {
    const pts = sub?.points;
    if (!pts || pts.length < 3) continue;
    iedPolyPath(x, pts, true);
    x.setLineDash([]);
    if (d.fill) { x.fillStyle = `rgba(${d.fill[0]},${d.fill[1]},${d.fill[2]},.35)`; x.fill(); }
    x.lineWidth = 1;
    x.strokeStyle = "rgba(242,242,242,.6)";
    x.stroke();
  }
}

/* ── §3 selections ─────────────────────────────────────────────────────── */
const iedSelMode = () => document.querySelector("[data-selmode].on")?.dataset.selmode || "new";

/* The op, §3 verbatim. Written in ONE place so Apply, the preset writer and the
 * history snapshot cannot each build a slightly different one. */
function iedSelectionOp() {
  /* `at` is the console's own note of where a colour-range sample was taken, so
   * the overlay can mark it. §3 does not define it, and a key the spec does not
   * define has no business in the payload — the client's version of "a schema
   * that accepts a parameter the code ignores". */
  const shapes = ied.sel.map(({ at, ...s }) => s);
  return {
    shapes,
    /* §3's example carries `mode` at the top level and its comment says "per
     * shape". Both are written: each shape holds the mode it was drawn with,
     * and the top level holds the first shape's. Whichever the Select module
     * reads, it reads something true — and the ambiguity is reported rather
     * than guessed at in silence. */
    mode: shapes[0]?.mode || "add",
    feather: +($("iedSelFeather").value || 0),
    invert: !!$("iedSelInvert").checked,
    expand: +($("iedSelExpand").value || 0),
    antialias: !!$("iedSelAA").checked,
  };
}

function iedSelAdd(shape) {
  if (iedSelMode() === "new") ied.sel.length = 0;
  ied.sel.push(shape);
  iedSelPaint(); iedOverlayPaint(); iedStatus();
  iedPush(`select ${shape.kind}`);
}

/* the pixel under a stage point, for colour range — sampled from the file's own
 * pixels, which is what §3 says wand and colour range see at stage 4 */
function iedSampleStage(sp) {
  const s = iedStageToSrc(sp.x, sp.y);
  const img = $("iedImg");
  const cv = document.createElement("canvas");
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const x = cv.getContext("2d");
  x.drawImage(img, 0, 0);
  const px = x.getImageData(Math.max(0, Math.min(cv.width - 1, s.x)),
    Math.max(0, Math.min(cv.height - 1, s.y)), 1, 1).data;
  return [px[0], px[1], px[2]];
}

function iedSelDown(sp, e) {
  const kind = IED_SELKIND[ied.tool];
  const uiMode = iedSelMode();
  const mode = uiMode === "new" ? "add" : uiMode;
  const tol = +($("iedSelTol").value || 32);
  if (ied.tool === "wand") {
    iedSelAdd({ kind: "wand", x: sp.x, y: sp.y, tolerance: tol,
      contiguous: !!$("iedSelContig").checked, mode });
    return null;
  }
  if (ied.tool === "colorRange") {
    iedSelAdd({ kind: "colorRange", color: iedSampleStage(sp), tolerance: tol,
      softness: +($("iedSelFeather").value || 8) || 8, mode, at: [sp.x, sp.y] });
    return null;
  }
  if (ied.tool === "polySelect") {
    if (!ied.selDraft?.pending) ied.selDraft = { kind: "polygon", pending: true, points: [], mode };
    ied.selDraft.points.push([sp.x, sp.y]);
    iedOverlayPaint();
    return null;
  }
  ied.selDraft = kind === "polygon"
    ? { kind, mode, points: [[sp.x, sp.y]] }
    : { kind, mode, ox: sp.x, oy: sp.y, x: sp.x, y: sp.y, w: 0, h: 0, shift: !!e.shiftKey };
  return "sel";
}

function iedSelMove(sp) {
  const d = ied.selDraft;
  if (!d) return;
  if (d.kind === "polygon") {
    const last = d.points[d.points.length - 1];
    if (Math.abs(last[0] - sp.x) + Math.abs(last[1] - sp.y) >= 2) d.points.push([sp.x, sp.y]);
  } else {
    d.x = Math.min(d.ox, sp.x); d.y = Math.min(d.oy, sp.y);
    d.w = Math.abs(sp.x - d.ox); d.h = Math.abs(sp.y - d.oy);
  }
  iedOverlayPaint(); iedStatus();
}

function iedSelUp() {
  const d = ied.selDraft;
  if (!d || d.pending) return;
  ied.selDraft = null;
  if (d.kind === "polygon") {
    if (d.points.length >= 3) iedSelAdd({ kind: "polygon", points: d.points, mode: d.mode });
  } else if (d.w > 2 && d.h > 2) {
    iedSelAdd(d.kind === "ellipse"
      ? { kind: "ellipse", cx: d.x + d.w / 2, cy: d.y + d.h / 2, rx: d.w / 2, ry: d.h / 2, mode: d.mode }
      : { kind: "rect", x: d.x, y: d.y, w: d.w, h: d.h, mode: d.mode });
  }
  iedOverlayPaint();
}

function iedSelClosePoly() {
  const d = ied.selDraft;
  if (!d?.pending) return;
  ied.selDraft = null;
  if (d.points.length >= 3) iedSelAdd({ kind: "polygon", points: d.points, mode: d.mode });
  iedOverlayPaint();
}

function iedSelDescribe(s) {
  if (s.kind === "rect") return `rect ${Math.round(s.w)}×${Math.round(s.h)} @ ${Math.round(s.x)},${Math.round(s.y)}`;
  if (s.kind === "ellipse") return `ellipse r${Math.round(s.rx)}×${Math.round(s.ry)} @ ${Math.round(s.cx)},${Math.round(s.cy)}`;
  if (s.kind === "polygon") return `polygon · ${s.points.length} points`;
  if (s.kind === "wand") return `wand @ ${s.x},${s.y} · tol ${s.tolerance}${s.contiguous ? " · contiguous" : ""}`;
  if (s.kind === "channel") return `channel ${s.channel} — the plane as the mask`;
  if (s.kind === "path") {
    const n = (s.paths || []).length;
    return `pen path · ${n} subpath${n === 1 ? "" : "s"}`;
  }
  return `colour range rgb(${s.color.join(",")}) · tol ${s.tolerance}`;
}

function iedSelPaint() {
  const list = $("iedSelList");
  if (!list) return;
  list.innerHTML = ied.sel.length
    ? ied.sel.map((s, i) => `<div class="iedfxrow" data-selrow="${i}">
        <span class="iedfxname" title="${esc(iedSelDescribe(s))}">${esc(iedSelDescribe(s))}</span>
        <span class="iedfxbadge">${esc(s.mode)}</span>
        <button class="edtool sm" data-seldel="${i}" title="drop this shape">✕</button></div>`).join("")
    : `<p class="hint">Nothing selected — every op works on the whole frame.</p>`;
  for (const b of list.querySelectorAll("[data-seldel]")) {
    b.onclick = () => { ied.sel.splice(+b.dataset.seldel, 1); iedSelPaint(); iedOverlayPaint(); iedStatus(); iedPush("drop selection shape"); };
  }
  iedStatus();
}

for (const b of document.querySelectorAll("[data-selmode]")) {
  b.onclick = () => {
    for (const o of document.querySelectorAll("[data-selmode]")) o.classList.toggle("on", o === b);
  };
}
$("iedSelClear").onclick = () => iedCmdRun("select.none");
$("iedSelNone").onclick = () => iedCmdRun("select.none");
$("iedSelAll").onclick = () => iedCmdRun("select.all");
$("iedSelInv").onclick = () => iedCmdRun("select.invert");
$("iedSelFromCrop").onclick = () => iedCmdRun("select.fromcrop");
for (const id of ["iedSelFeather", "iedSelExpand", "iedSelInvert", "iedSelAA"]) {
  $(id).onchange = () => { iedOverlayPaint(); iedStatus(); iedPush("selection settings"); };
}

/* ── §5 strokes ────────────────────────────────────────────────────────────
 * The client sends a PATH, never pixels. Everything here captures points in
 * stage coordinates, with pressure when the device has any, and hands them to
 * the server exactly as §5 spells them.
 *
 * The one rule that decides whether this reads as a real brush is not in the
 * UI at all — it is the server stamping along the path at spacing × size. What
 * the overlay draws is the path, at the width it will be stamped at, and it is
 * labelled as the path so nobody reads it as a preview of the brush. */
const IED_STROKEC = { size: "iedStSize2", hardness: "iedStHard", opacity: "iedStOpacity",
  flow: "iedStFlow", amount: "iedStAmount", color: "iedStColor", spacing: "iedStSpacing" };
// input id -> readout id, written out because iedStSize2 does not follow the rule
const IED_STROKEV = { iedStSize2: "iedStSizeV", iedStHard: "iedStHardV",
  iedStOpacity: "iedStOpacityV", iedStFlow: "iedStFlowV",
  iedStAmount: "iedStAmountV", iedStSpacing: "iedStSpacingV" };

/* the fields this tool has, read off the markup that also shows the controls */
function iedStrokeFields(tool) {
  const out = [];
  for (const el of document.querySelectorAll("[data-strokefield]")) {
    if (el.dataset.strokefor.split(/\s+/).includes(tool)) out.push(el.dataset.strokefield);
  }
  return out;
}

function iedStrokeOpts() {
  if (!iedIsStroke(ied.tool)) return;
  const fields = iedStrokeFields(ied.tool);
  for (const el of document.querySelectorAll("[data-strokefield]")) {
    el.hidden = !fields.includes(el.dataset.strokefield);
  }
  $("iedStrokeLab").textContent = IED_LABEL[ied.tool] || "Brush";
  $("iedStSrcLbl").textContent = ied.cloneSrc
    ? `source ${ied.cloneSrc[0]},${ied.cloneSrc[1]} — alt-click to move it`
    : "alt-click sets the source";
  for (const [id, vid] of Object.entries(IED_STROKEV)) {
    $(vid).textContent = id === "iedStSize2" ? $(id).value
      : (+$(id).value / 100).toFixed(2).replace(/^0\./, ".");
  }
}
for (const id of Object.values(IED_STROKEC)) $(id).oninput = iedStrokeOpts;

/* Everything the tool has, and nothing it does not. §5's colours are 0-255 —
 * a 0-1 triple is a legal near-black that draws perfectly and is simply wrong. */
function iedStrokeSpec(tool, points) {
  const f = iedStrokeFields(tool);
  const s = { tool, points };
  if (f.includes("size")) s.size = +$("iedStSize2").value;
  if (f.includes("hardness")) s.hardness = +$("iedStHard").value / 100;
  if (f.includes("opacity")) s.opacity = +$("iedStOpacity").value / 100;
  if (f.includes("flow")) s.flow = +$("iedStFlow").value / 100;
  if (f.includes("amount")) s.amount = +$("iedStAmount").value / 100;
  if (f.includes("color")) s.color = [...hex2rgb($("iedStColor").value), 255];
  if (f.includes("spacing")) s.spacing = +$("iedStSpacing").value / 100;
  if (f.includes("source") && ied.cloneSrc) s.source = [...ied.cloneSrc];
  return s;
}

/* A mouse has no pressure. Reporting 0.5 for every mouse point would be a
 * fiction the server cannot tell from a real reading, so a mouse sends
 * two-element points and lets §5's "default 1" mean what it says. */
const iedPressure = (e) => (e.pointerType === "mouse" ? null
  : Math.max(0.01, Math.min(1, e.pressure || 0.5)));

function iedStrokeDown(sp, e) {
  if ((ied.tool === "clone" || ied.tool === "heal") && !ied.cloneSrc) {
    iedToast("Alt-click the picture first to set where the clone samples from — §5 fixes the offset at stroke start.");
    return null;
  }
  const p = iedPressure(e);
  ied.strokeDraft = { tool: ied.tool, points: [p == null ? [sp.x, sp.y] : [sp.x, sp.y, p]] };
  iedOverlayPaint();
  return "stroke";
}

function iedStrokeMove(sp, e) {
  const d = ied.strokeDraft;
  if (!d) return;
  const last = d.points[d.points.length - 1];
  // One point per pixel of travel is plenty; the server interpolates between.
  if (Math.abs(last[0] - sp.x) + Math.abs(last[1] - sp.y) < 1) return;
  const p = iedPressure(e);
  d.points.push(p == null ? [sp.x, sp.y] : [sp.x, sp.y, p]);
  iedOverlayPaint(); iedStatus();
}

function iedStrokeUp() {
  const d = ied.strokeDraft;
  ied.strokeDraft = null;
  if (!d) return;
  // A bucket fill is one point; every other tool needs a path to walk.
  if (d.tool !== "bucket" && d.points.length < 2) { iedOverlayPaint(); return; }
  ied.strokes.push(iedStrokeSpec(d.tool, d.points));
  iedPaintQueuePaint(); iedOverlayPaint(); iedStatus();
  iedPush(`${IED_LABEL[d.tool].toLowerCase()} · ${d.points.length} pts`);
}

function iedStrokeGhost(x, s, live) {
  if (!s.points?.length) return;
  const zoom = ied.view.zoom;
  const w = Math.max(1, (s.size || 24) * zoom);
  x.lineCap = "round"; x.lineJoin = "round";
  x.setLineDash([]);
  x.globalAlpha = live ? 0.3 : 0.2;
  x.strokeStyle = live ? iedLiveInk() : iedRestInk();
  x.lineWidth = w;
  iedPolyPath(x, s.points, false);
  if (s.points.length === 1) {
    const v = iedStageToView(s.points[0][0], s.points[0][1]);
    x.beginPath(); x.arc(v.x, v.y, w / 2, 0, Math.PI * 2); x.fillStyle = x.strokeStyle; x.fill();
  } else { x.stroke(); }
  x.globalAlpha = 1;
  x.lineWidth = 1;
  x.strokeStyle = live ? iedLiveInk() : "rgba(242,242,242,.65)";
  iedPolyPath(x, s.points, false);
  if (s.points.length > 1) x.stroke();
}

/* ── §6 shapes ─────────────────────────────────────────────────────────── */
function iedShapeOpts() {
  if (!iedIsShape(ied.tool)) return;
  $("iedShapeLab").textContent = IED_LABEL[ied.tool] || "Shape";
  for (const el of document.querySelectorAll("[data-shapefor]")) {
    el.hidden = !el.dataset.shapefor.split(/\s+/).includes(ied.tool);
  }
  const closed = ied.tool === "shapeRect" || ied.tool === "shapeEllipse" || ied.tool === "shapePolygon";
  /* §6: "a shape with neither fill nor stroke is an error, not a no-op". A line
   * has nothing to fill, so its stroke is forced on rather than left as a way
   * to build a shape the server will refuse. */
  if (!closed) { $("iedShStrokeOn").checked = true; $("iedShFillOn").checked = false; }
  $("iedShFillOn").disabled = !closed;
  $("iedShHint").textContent = ied.tool === "shapePolygon"
    ? "click each corner · double-click closes it" : "drag on the image";
  iedShapeGuard();
}

/* Neither fill nor stroke cannot be built here, so it cannot be posted. */
function iedShapeGuard() {
  const ok = $("iedShFillOn").checked || $("iedShStrokeOn").checked;
  $("iedShHint").classList.toggle("iedcapwarn", !ok);
  if (!ok) $("iedShHint").textContent = "pick a fill or a line — a shape with neither is an error, not a no-op";
  return ok;
}
for (const id of ["iedShFillOn", "iedShStrokeOn", "iedShFill", "iedShStroke", "iedShWidth", "iedShRadius", "iedShBlend"]) {
  $(id).onchange = () => { iedShapeOpts(); };
}

function iedShapeSpec(kind, points) {
  const s = { kind, points, blend: $("iedShBlend").value };
  if (kind === "rect") s.radius = +$("iedShRadius").value || 0;
  if ($("iedShFillOn").checked && !$("iedShFillOn").disabled) s.fill = [...hex2rgb($("iedShFill").value), 255];
  if ($("iedShStrokeOn").checked) {
    s.stroke = [...hex2rgb($("iedShStroke").value), 255];
    s.strokeWidth = +$("iedShWidth").value || 1;
  }
  return s;
}

function iedShapeDown(sp) {
  if (!iedShapeGuard()) { iedToast("A shape needs a fill or a line — §6 makes 'neither' an error."); return null; }
  const kind = IED_SHAPEKIND[ied.tool];
  if (kind === "polygon") {
    if (!ied.shapeDraft?.pending) ied.shapeDraft = { kind, pending: true, points: [] };
    ied.shapeDraft.points.push([sp.x, sp.y]);
    iedOverlayPaint();
    return null;
  }
  ied.shapeDraft = { kind, ox: sp.x, oy: sp.y, points: [[sp.x, sp.y], [sp.x, sp.y]] };
  return "shape";
}

function iedShapeMove(sp) {
  const d = ied.shapeDraft;
  if (!d || d.pending) return;
  d.points[1] = [sp.x, sp.y];
  iedOverlayPaint(); iedStatus();
}

function iedShapeUp() {
  const d = ied.shapeDraft;
  if (!d || d.pending) return;
  ied.shapeDraft = null;
  const [a, b] = d.points;
  if (Math.abs(a[0] - b[0]) < 2 && Math.abs(a[1] - b[1]) < 2) { iedOverlayPaint(); return; }
  ied.shapes.push(iedShapeSpec(d.kind, d.points));
  iedPaintQueuePaint(); iedOverlayPaint(); iedStatus();
  iedPush(`shape · ${d.kind}`);
}

function iedShapeClosePoly() {
  const d = ied.shapeDraft;
  if (!d?.pending) return;
  ied.shapeDraft = null;
  if (d.points.length >= 3) {
    ied.shapes.push(iedShapeSpec("polygon", d.points));
    iedPaintQueuePaint(); iedStatus(); iedPush("shape · polygon");
  }
  iedOverlayPaint();
}

/* A shape drawn from two corners is drawn as those two corners — a rect and an
 * ellipse inscribe the drag, a line and an arrow ARE the drag. */
function iedShapeGhost(x, s, live) {
  const pts = s.points || [];
  if (pts.length < 2 && !s.pending) return;
  const kind = s.kind;
  let path = pts;
  if (kind === "rect" || kind === "ellipse") {
    const [a, b] = pts;
    const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
    const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
    path = kind === "rect"
      ? [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]
      : iedEllipsePts(x0 + w / 2, y0 + h / 2, w / 2, h / 2);
  }
  const closed = kind === "rect" || kind === "ellipse" || (kind === "polygon" && !s.pending);
  iedPolyPath(x, path, closed);
  x.setLineDash([]);
  if (s.fill && closed) { x.fillStyle = `rgba(${s.fill[0]},${s.fill[1]},${s.fill[2]},.45)`; x.fill(); }
  x.lineWidth = Math.max(1, (s.strokeWidth || 1) * ied.view.zoom);
  x.strokeStyle = live ? iedLiveInk()
    : s.stroke ? `rgb(${s.stroke[0]},${s.stroke[1]},${s.stroke[2]})` : "rgba(242,242,242,.7)";
  x.stroke();
  x.lineWidth = 1;
}

/* ── the queue dock: what will be drawn, before anything is ────────────── */
function iedPaintQueuePaint() {
  const sl = $("iedStrokeList"), sh = $("iedShapeList");
  if (!sl || !sh) return;
  sl.innerHTML = ied.strokes.map((s, i) => `<div class="iedfxrow">
      <span class="iedfxname">${esc(IED_LABEL[s.tool] || s.tool)} · ${s.points?.length
        ? `${s.points.length} pt${s.points.length === 1 ? "" : "s"}`
        : `along ${esc(s._pathName || "a path")}`}${s.size ? ` · ${s.size}px` : ""}</span>
      <button class="edtool sm" data-strokedel="${i}" title="drop this stroke">✕</button></div>`).join("")
    || `<p class="hint">No strokes queued.</p>`;
  sh.innerHTML = ied.shapes.map((s, i) => `<div class="iedfxrow">
      <span class="iedfxname">${esc(s.kind)}${s.fill ? " · filled" : ""}${s.stroke ? ` · ${s.strokeWidth}px line` : ""}</span>
      <button class="edtool sm" data-shapedel="${i}" title="drop this shape">✕</button></div>`).join("")
    || `<p class="hint">No shapes queued.</p>`;
  for (const b of sl.querySelectorAll("[data-strokedel]")) {
    b.onclick = () => { ied.strokes.splice(+b.dataset.strokedel, 1); iedPaintQueuePaint(); iedOverlayPaint(); iedStatus(); };
  }
  for (const b of sh.querySelectorAll("[data-shapedel]")) {
    b.onclick = () => { ied.shapes.splice(+b.dataset.shapedel, 1); iedPaintQueuePaint(); iedOverlayPaint(); iedStatus(); };
  }
  iedStatus();
}
$("iedStrokeUndo").onclick = () => {
  if (ied.shapes.length) ied.shapes.pop(); else ied.strokes.pop();
  iedPaintQueuePaint(); iedOverlayPaint(); iedPush("undo last mark");
};
$("iedPaintClear").onclick = () => {
  ied.strokes.length = 0; ied.shapes.length = 0;
  iedPaintQueuePaint(); iedOverlayPaint(); iedPush("clear paint queue");
};

/* ── the Channels dock ─────────────────────────────────────────────────────
 * Three different verbs, and keeping them distinct is the whole design:
 * VIEWING a plane is a client canvas (nothing queued, Apply unchanged);
 * LOADING one is a real §3 selection shape the server resolves (the plane IS
 * the mask — Photoshop's ctrl-click); and EDITING one goes through the
 * per-channel curve, because that is the apply-to-one-channel this pipeline
 * actually has. An agent gets the same three: image_adjust `channel` renders
 * the view, selection kind `channel` loads it, `curves.r/g/b` edits it. */
const IED_CHANROWS = [["rgb", "RGB"], ["r", "Red"], ["g", "Green"], ["b", "Blue"], ["a", "Alpha"]];

function iedChanData(w, h) {
  const img = $("iedImg");
  if (!img.naturalWidth) return null;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const x = cv.getContext("2d");
  x.drawImage(img, 0, 0, w, h);
  return x.getImageData(0, 0, w, h);
}

function iedChanGray(d, ch) {
  const o = new ImageData(d.width, d.height);
  const p = d.data, q = o.data;
  for (let i = 0; i < p.length; i += 4) {
    const v = ch === "rgb" ? p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114
      : ch === "r" ? p[i] : ch === "g" ? p[i + 1] : ch === "b" ? p[i + 2] : p[i + 3];
    q[i] = q[i + 1] = q[i + 2] = v; q[i + 3] = 255;
  }
  return o;
}

function iedChanPaint() {
  const list = $("iedChanList");
  if (!list) return;
  list.innerHTML = IED_CHANROWS.map(([ch, label]) => `
    <div class="iedchanrow${ied.chanView === ch ? " on" : ""}" data-chanrow="${ch}">
      <canvas data-chanthumb="${ch}" width="34" height="24"></canvas>
      <span class="iedfxname">${label}</span>
      <button class="edtool sm" data-chansel="${ch}" title="Load this plane as the ACTIVE SELECTION — Photoshop's ctrl-click on a channel. The mask is the plane itself, soft edges and all.">load</button>
      ${ch === "a" ? "" : `<button class="edtool sm" data-chancurve="${ch}" title="Point the Adjustments curve at this channel — the pipeline's way to edit one channel only.">curve</button>`}
    </div>`).join("");
  // Thumbnails from one small sample of the picture, split five ways.
  const img = $("iedImg");
  if (img.naturalWidth) {
    const d = iedChanData(34, 24);
    if (d) {
      for (const cv of list.querySelectorAll("[data-chanthumb]")) {
        cv.getContext("2d").putImageData(iedChanGray(d, cv.dataset.chanthumb), 0, 0);
      }
    }
  }
  for (const row of list.querySelectorAll("[data-chanrow]")) {
    row.onclick = (ev) => {
      if (ev.target.closest("button")) return;
      iedChanShow(ied.chanView === row.dataset.chanrow ? null : row.dataset.chanrow);
    };
  }
  for (const b of list.querySelectorAll("[data-chansel]")) {
    b.onclick = () => {
      if (!iedCapLive("selection")) { iedToast(iedCapWhy("selection")); return; }
      const uiMode = iedSelMode();
      iedSelAdd({ kind: "channel",
        channel: b.dataset.chansel === "rgb" ? "luminosity" : b.dataset.chansel,
        mode: uiMode === "new" ? "add" : uiMode });
    };
  }
  for (const b of list.querySelectorAll("[data-chancurve]")) {
    b.onclick = () => {
      const ch = b.dataset.chancurve === "rgb" ? "master" : b.dataset.chancurve;
      document.querySelector(`[data-curvech="${ch}"]`)?.click();
      iedFocus("iedDockAdjust", "iedCurve");
    };
  }
}

function iedChanShow(ch) {
  ied.chanView = ch;
  const cv = $("iedChanCanvas"), img = $("iedImg");
  if (!ch || !img.naturalWidth) {
    cv.hidden = true; cv.width = cv.height = 0;   // free the plane's memory
    iedChanPaint(); return;
  }
  /* Backing capped at 2048 on the long side — a view, not the pixels the
   * server reads — and stretched to the picture's own CSS size so the frame's
   * transform (zoom, pan, flips, rotation) carries it untouched. */
  const s = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * s));
  const h = Math.max(1, Math.round(img.naturalHeight * s));
  const d = iedChanData(w, h);
  if (!d) { cv.hidden = true; return; }
  cv.width = w; cv.height = h;
  cv.getContext("2d").putImageData(iedChanGray(d, ch), 0, 0);
  cv.hidden = false;
  iedApplyView();                                  // size + transform sync
  iedChanPaint();
}

/* ── the Paths dock ────────────────────────────────────────────────────────
 * A saved path is GEOMETRY: { name, subs: [{points, closed} | {d}] }. The
 * three gestures hand it to the three modules that own the concerns — the
 * selection to imgselect (kind "path", rasterised by imgpath), the stroke to
 * imgstroke (`path` on a stamped tool), the fill to imgpath (ops.paths) — so
 * the panel owns nothing but the list. */
let iedPathN = 0;

function iedPenClose() {
  const d = ied.pathDraft;
  ied.pathDraft = null;
  if (!d || d.points.length < 3) { iedOverlayPaint(); return; }
  ied.paths.push({ name: `path ${++iedPathN}`, subs: [{ points: d.points, closed: true }] });
  ied.pathSel = ied.paths.length - 1;
  $("iedDockPaths").open = true;
  iedPathsPaint(); iedOverlayPaint();
  iedPush(`pen path · ${d.points.length} anchors`);
}

function iedPathsPaint() {
  const list = $("iedPathList");
  if (!list) return;
  list.innerHTML = ied.paths.length ? ied.paths.map((p, i) => {
    const n = p.subs.length;
    const pts = p.subs.reduce((a, s) => a + (s.points?.length || 0), 0);
    return `<div class="iedfxrow${i === ied.pathSel ? " on" : ""}" data-pathrow="${i}">
      <span class="iedfxname">${esc(p.name)}</span>
      <span class="hint">${p.subs.some((s) => s.d) ? "svg d" : `${pts} pts`}${n > 1 ? ` · ${n} subs` : ""}</span>
      <button class="edtool sm" data-pathdel="${i}" title="forget this path">✕</button></div>`;
  }).join("") : `<p class="hint">No saved paths. The pen (P) draws one; <b>from
    selection</b> traces the marquee you have.</p>`;
  for (const r of list.querySelectorAll("[data-pathrow]")) {
    r.onclick = (ev) => {
      if (ev.target.closest("button")) return;
      ied.pathSel = ied.pathSel === +r.dataset.pathrow ? -1 : +r.dataset.pathrow;
      iedPathsPaint(); iedOverlayPaint();
    };
  }
  for (const b of list.querySelectorAll("[data-pathdel]")) {
    b.onclick = () => {
      ied.paths.splice(+b.dataset.pathdel, 1);
      if (ied.pathSel >= ied.paths.length) ied.pathSel = ied.paths.length - 1;
      iedPathsPaint(); iedOverlayPaint(); iedPush("forget path");
    };
  }
  iedPathQueuePaint();
}

function iedPathQueuePaint() {
  const q = $("iedPathQueue");
  if (!q) return;
  q.innerHTML = ied.pathDraws.map((d, i) => `<div class="iedfxrow">
      <span class="iedfxname">fill · rgb(${(d.fill || []).slice(0, 3).join(",")})</span>
      <button class="edtool sm" data-pathqdel="${i}" title="drop this fill">✕</button></div>`).join("");
  for (const b of q.querySelectorAll("[data-pathqdel]")) {
    b.onclick = () => {
      ied.pathDraws.splice(+b.dataset.pathqdel, 1);
      iedPathQueuePaint(); iedOverlayPaint(); iedStatus(); iedPush("drop path fill");
    };
  }
}

const iedPathCur = () => {
  const p = ied.paths[ied.pathSel] || ied.paths[ied.paths.length - 1];
  if (!p) iedToast("No path yet — draw one with the pen (P), or make one from the selection.");
  return p;
};

$("iedPathFromSel").onclick = () => {
  const subs = [];
  for (const s of ied.sel) {
    if (s.kind !== "rect" && s.kind !== "ellipse" && s.kind !== "polygon") continue;
    const pts = iedShapePts(s);
    if (pts.length >= 3) subs.push({ points: pts.map((p) => [p[0], p[1]]), closed: true });
  }
  if (!subs.length) {
    iedToast("From selection needs a rect, ellipse or polygon shape — wand, colour range and channel have no outline to trace.");
    return;
  }
  ied.paths.push({ name: `path ${++iedPathN}`, subs });
  ied.pathSel = ied.paths.length - 1;
  iedPathsPaint(); iedOverlayPaint(); iedPush("path from selection");
};

$("iedPathSvg").onclick = () => {
  iedDlgOpen("Path from SVG",
    `<p class="hint">Paste a <code>d</code> attribute — M L H V C S Q T A Z and
      their relative forms, exactly what <code>imgpath</code> reads. The server
      flattens it; the overlay lists it without pretending to draw it.</p>
     <textarea id="iedPathD" class="sel2" style="width:100%;height:90px" placeholder="M 20 20 C 60 10 80 50 40 80 Z"></textarea>`,
    `<button class="btn primary sm" id="iedPathDOk">save path</button>`);
  $("iedPathDOk").onclick = () => {
    const d = $("iedPathD").value.trim();
    if (!d) { iedToast("An empty d saves nothing."); return; }
    ied.paths.push({ name: `path ${++iedPathN}`, subs: [{ d }] });
    ied.pathSel = ied.paths.length - 1;
    iedDlgClose(); iedPathsPaint(); iedPush("path from SVG d");
  };
};

$("iedPathToSel").onclick = () => {
  if (!iedCapLive("selection")) { iedToast(iedCapWhy("selection")); return; }
  const p = iedPathCur();
  if (!p) return;
  const uiMode = iedSelMode();
  iedSelAdd({ kind: "path", paths: JSON.parse(JSON.stringify(p.subs)),
    mode: uiMode === "new" ? "add" : uiMode });
};

$("iedPathStroke").onclick = () => {
  if (!iedCapLive("strokes")) { iedToast(iedCapWhy("strokes")); return; }
  const p = iedPathCur();
  if (!p) return;
  /* The CURRENT brush-class tool with its CURRENT options — bucket and
   * gradient are not walks, so anything else falls back to the brush. */
  const tool = iedIsStroke(ied.tool) && ied.tool !== "bucket" && ied.tool !== "gradient"
    ? ied.tool : "brush";
  if ((tool === "clone" || tool === "heal") && !ied.cloneSrc) {
    iedToast("Alt-click the picture first to set where the clone samples from — §5 fixes the offset at stroke start.");
    return;
  }
  const s = iedStrokeSpec(tool, []);
  delete s.points;
  s.path = JSON.parse(JSON.stringify(p.subs));
  s._pathName = p.name;
  s._ghost = p.subs.filter((sub) => sub.points?.length >= 2)
    .map((sub) => (sub.closed !== false ? [...sub.points, sub.points[0]] : [...sub.points]));
  ied.strokes.push(s);
  iedPaintQueuePaint(); iedOverlayPaint();
  iedPush(`${IED_LABEL[tool].toLowerCase()} along ${p.name}`);
};

$("iedPathFill").onclick = () => {
  if (!iedCapLive("paths")) { iedToast(iedCapWhy("paths")); return; }
  const p = iedPathCur();
  if (!p) return;
  ied.pathDraws.push({ paths: JSON.parse(JSON.stringify(p.subs)),
    fill: [...hex2rgb($("iedShFill").value), 255] });
  iedPathQueuePaint(); iedOverlayPaint(); iedStatus();
  iedPush(`fill ${p.name}`);
};

/* ── the Character / Paragraph dock ────────────────────────────────────────
 * Generated, never listed: every row comes out of /api/images/tools
 * module=text, the way the effect stack comes out of /api/images/effects. A
 * hard-coded parameter list is this codebase's recurring silent-drift bug —
 * the schema grows a control, the panel doesn't, and nobody is told. */
let iedToolsCat = null, iedToolsErr = null;

async function iedToolsLoad(force) {
  if (iedToolsCat && !force) return iedToolsCat;
  try {
    const d = await (await fetch("/api/images/tools")).json();
    if (d.error) throw new Error(d.error);
    iedToolsCat = d.tools || {};
    iedToolsErr = null;
  } catch (err) {
    iedToolsCat = null; iedToolsErr = err.message || String(err);
  }
  return iedToolsCat;
}

/* Every parameter at the catalog's default, objects expanded through their
 * `of` reference — never a hand-picked subset (the fx dock's rule). */
function iedTextDefaults() {
  const cat = iedToolsCat?.text;
  if (!cat?.text?.params) return null;
  const build = (entry) => {
    const out = {};
    for (const [k, d] of Object.entries(entry.params || {})) {
      if (d.type === "object" && cat[d.of]?.params) out[k] = build(cat[d.of]);
      else out[k] = Array.isArray(d.default) ? JSON.parse(JSON.stringify(d.default)) : d.default;
    }
    return out;
  };
  return build(cat.text);
}

function iedText2Ensure() {
  if (ied.text2) return ied.text2;
  const t = iedTextDefaults();
  if (!t) return null;
  /* The defaults the legacy tool established: centred anchor (the preview's
   * -50%,-50%), centred alignment, placed low like the old caption. */
  t.anchor = "center"; t.align = "center";
  t.box = [Math.round(iedRotSize().w / 2), Math.round(iedRotSize().h * 0.9), 0, 0];
  ied.text2 = t;
  return t;
}

// spec path -> options-bar control, so the two views of one object agree.
const IED_CHAR_MIRROR = { "size": "iedTxtSize", "font": "iedTxtFont",
  "fill.color": "iedTxtColor", "outline.width": "iedTxtStroke",
  "outline.color": "iedTxtStrokeC" };

/* Push the spec back into the options bar wholesale — used when the spec
 * arrived from somewhere other than the bar (a preset, a restore). A select
 * only takes a value it actually has; the spec stays the truth either way. */
function iedTextBarSync() {
  const t = ied.text2;
  if (!t) return;
  $("iedTxt").value = t.content || "";
  $("iedTxtSize").value = String(t.size ?? 72);
  if ([...$("iedTxtFont").options].some((o) => o.value === t.font)) $("iedTxtFont").value = t.font;
  if (t.fill?.color) $("iedTxtColor").value = iedHex(t.fill.color);
  if (t.outline?.color) $("iedTxtStrokeC").value = iedHex(t.outline.color);
  const sw = String(t.outline?.width ?? 0);
  if ([...$("iedTxtStroke").options].some((o) => o.value === sw)) $("iedTxtStroke").value = sw;
}

const iedCharGet = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);
function iedCharSet(obj, path, v) {
  const ks = path.split(".");
  const last = ks.pop();
  ks.reduce((o, k) => o[k], obj)[last] = v;
}

function iedCharPaint() {
  const host = $("iedCharBody");
  if (!host) return;
  if (!iedCapLive("text")) { host.innerHTML = ""; return; }   // the capwarn line says why
  if (!iedToolsCat && iedToolsErr) {
    host.innerHTML = `<p class="hint iedcapwarn">The tool catalog did not load: ${esc(iedToolsErr)}</p>`;
    return;
  }
  const cat = iedToolsCat?.text;
  if (!cat?.text?.params) { host.innerHTML = `<p class="hint">Waiting for the tool catalog…</p>`; return; }
  const spec = ied.text2 || iedTextDefaults();
  if (!spec) { host.innerHTML = ""; return; }

  const row = (base, k, d) => {
    const path = base ? `${base}.${k}` : k;
    const v = iedCharGet(spec, path);
    const why = esc(d.desc || "");
    if (d.type === "bool") {
      return `<div class="iedparam"><span>${esc(k)}</span>
        <input type="checkbox" data-charp="${path}"${v ? " checked" : ""}><b></b>
        <span class="iedparamwhy">${why}</span></div>`;
    }
    if (d.type === "enum") {
      return `<div class="iedparam"><span>${esc(k)}</span>
        <select class="sel2 sm" data-charp="${path}">${(d.options || []).map((o) =>
          `<option${o === v ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>
        <span class="iedparamwhy">${why}</span></div>`;
    }
    if (d.type === "color") {
      return `<div class="iedparam"><span>${esc(k)}</span>
        <input type="color" data-charp="${path}" value="${iedHex(v || d.default || [255, 255, 255])}">
        <span class="iedparamwhy">${why} — 0-255 RGB</span></div>`;
    }
    if (d.type === "number") {
      const min = d.min ?? 0, max = d.max ?? 100;
      // A 0..2000 slider has no useful precision; wide ranges get a number box.
      if (max - min > 1500) {
        return `<div class="iedparam"><span>${esc(k)}</span>
          <input type="number" class="sel2 sm" data-charp="${path}" value="${v}"
            min="${min}" max="${max}" step="${d.integer ? 1 : "any"}"><b></b>
          <span class="iedparamwhy">${why}${d.unit ? ` (${esc(d.unit)})` : ""}</span></div>`;
      }
      return `<div class="iedparam"><span>${esc(k)}</span>
        <input type="range" data-charp="${path}" min="${min}" max="${max}"
          step="${d.integer ? 1 : "any"}" value="${v}">
        <b data-charv="${path}">${d.integer ? Math.round(v) : (+v).toFixed(2)}</b>
        <span class="iedparamwhy">${why}${d.unit ? ` (${esc(d.unit)})` : ""}</span></div>`;
    }
    if (d.type === "rect" || d.type === "vec2") {
      const vals = (v || d.default || []).map((n) => +n);
      const labels = d.type === "rect" ? ["x", "y", "w", "h"] : ["x", "y"];
      return `<div class="iedparam"><span>${esc(k)}</span>
        <span style="display:flex;gap:3px">${labels.map((lab, i) =>
          `<input type="number" class="sel2 sm" style="width:52px" title="${lab}"
            data-charp="${path}" data-charidx="${i}" value="${vals[i] ?? 0}">`).join("")}</span>
        <span class="iedparamwhy">${why}</span></div>`;
    }
    if (d.type === "string") {
      if (path === "font") {
        // The same shelf the options bar shows, from /api/fonts.
        const opts = [...$("iedTxtFont").options].map((o) =>
          `<option${o.value === v ? " selected" : ""}>${esc(o.value)}</option>`).join("");
        return `<div class="iedparam"><span>font</span>
          <select class="sel2 sm" data-charp="${path}">${opts}</select>
          <span class="iedparamwhy">${why}</span></div>`;
      }
      if (path === "content") return "";           // the options bar's textarea owns it
      return `<div class="iedparam"><span>${esc(k)}</span>
        <input type="text" class="sel2 sm" data-charp="${path}" value="${esc(String(v ?? ""))}">
        <span class="iedparamwhy">${why}</span></div>`;
    }
    // points / stops: honest note rather than a dead control (the fx rule).
    return `<div class="iedparam"><span>${esc(k)}</span>
      <span class="hint">${Array.isArray(v) ? v.length : 0} entries, at the catalog default</span><b></b>
      <span class="iedparamwhy">${why} — set via MCP's image_adjust text op</span></div>`;
  };

  const groups = [];
  const top = Object.entries(cat.text.params)
    .filter(([, d]) => d.type !== "object")
    .map(([k, d]) => row("", k, d)).join("");
  groups.push(`<div class="iedgrp"><b class="iedgrph">Type</b>${top}</div>`);
  for (const [k, d] of Object.entries(cat.text.params)) {
    if (d.type !== "object" || !cat[d.of]?.params) continue;
    const body = Object.entries(cat[d.of].params).map(([pk, pd]) => row(k, pk, pd)).join("");
    groups.push(`<div class="iedgrp"><b class="iedgrph">${esc(cat[d.of].label || k)}</b>${body}</div>`);
  }
  groups.push(`<p class="hint">Every row above came out of
    <code>/api/images/tools</code> module=text. Rendered exactly on Apply;
    the overlay previews position and size only.</p>`);
  host.innerHTML = groups.join("");

  for (const el of host.querySelectorAll("[data-charp]")) {
    const path = el.dataset.charp;
    const write = () => {
      const t = iedText2Ensure();
      if (!t) return;
      if (el.type === "checkbox") iedCharSet(t, path, el.checked);
      else if (el.dataset.charidx != null) {
        const arr = iedCharGet(t, path);
        if (Array.isArray(arr)) arr[+el.dataset.charidx] = +el.value || 0;
      } else if (el.type === "color") iedCharSet(t, path, hex2rgb(el.value));
      else if (el.type === "range" || el.type === "number") {
        iedCharSet(t, path, +el.value);
        const out = host.querySelector(`[data-charv="${CSS.escape(path)}"]`);
        if (out) out.textContent = String(el.step === "1" ? Math.round(+el.value) : +(+el.value).toFixed(2));
      } else iedCharSet(t, path, el.value);
      // Mirror into the options bar, so the two views of the spec agree.
      const mirror = IED_CHAR_MIRROR[path];
      if (mirror) {
        const m = $(mirror);
        if (m.type === "color") m.value = iedHex(iedCharGet(t, path));
        else if (m.tagName === "SELECT" && ![...m.options].some((o) => o.value === String(iedCharGet(t, path)))) { /* keep */ }
        else m.value = String(iedCharGet(t, path));
      }
      iedTextSync();
    };
    el.oninput = write;
    el.onchange = () => { write(); iedPush(`type · ${path}`); };
  }
}

/* ── the Swatches dock ─────────────────────────────────────────────────────
 * The shelf itself lives server-side (see the route for the persistence
 * decision); this is only its face. Click applies the colour to the brush and
 * the shape fill — the console's two working colours. */
let iedSwatches = null, iedSwSel = -1;

async function iedSwLoad(force) {
  if (iedSwatches && !force) { iedSwPaint(); return; }
  try {
    const d = await (await fetch("/api/images/swatches")).json();
    iedSwatches = d.swatches || [];
  } catch { iedSwatches = null; }
  iedSwPaint();
}

function iedSwPaint() {
  const grid = $("iedSwGrid");
  if (!grid) return;
  if (!iedSwatches) { grid.innerHTML = `<p class="hint">The shelf did not load.</p>`; return; }
  grid.innerHTML = iedSwatches.length ? iedSwatches.map((s, i) =>
    `<button class="iedsw${i === iedSwSel ? " on" : ""}" data-sw="${i}"
       style="background:rgb(${s.color.join(",")})"
       title="${esc(s.name || `rgb(${s.color.join(",")})`)} — click to use"></button>`).join("")
    : `<p class="hint">Empty shelf — save the brush colour with + add current.</p>`;
  $("iedSwDel").hidden = iedSwSel < 0 || iedSwSel >= iedSwatches.length;
  for (const b of grid.querySelectorAll("[data-sw]")) {
    b.onclick = () => {
      const i = +b.dataset.sw;
      const c = iedSwatches[i].color;
      $("iedStColor").value = iedHex(c);
      $("iedShFill").value = iedHex(c);
      iedSwSel = i;
      iedSwPaint(); iedStrokeOpts();
      iedToast(`rgb(${c.join(",")}) is now the brush and shape colour.`);
      // Both colour fields are in IED_SNAPCTL, so the restore side already
      // worked — only the step was missing.
      iedPush(`swatch · rgb(${c.join(",")})`);
    };
  }
}

async function iedSwPost(body) {
  try {
    const r = await (await fetch("/api/images/swatches", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
    if (r.error) { iedToast(r.error); return; }
    iedSwatches = r.swatches || [];
  } catch (err) { iedToast(String(err.message || err)); }
  iedSwPaint();
}
$("iedSwAdd").onclick = () => iedSwPost({ color: hex2rgb($("iedStColor").value) });
$("iedSwDel").onclick = () => {
  if (iedSwSel < 0) return;
  const i = iedSwSel;
  iedSwSel = -1;
  iedSwPost({ remove: i });
};

/* ── §4: the eighty-eight ──────────────────────────────────────────────────
/* ── §4: the effect registry ───────────────────────────────────────────────
 *
 * Every effect name, every group, every parameter and every default below is
 * read from GET /api/images/effects at runtime. There is deliberately not one
 * effect name written in this file: a hard-coded list is a list that silently
 * stops matching the registry the day someone adds the seventy-sixth, and the
 * only symptom is a menu that quietly lacks it. */
let iedFxCat = null;                       // name -> catalog entry
let iedFxOrder = [];                       // groups, in the registry's own order
let iedFxErr = null;

async function iedFxLoad(force) {
  if (iedFxCat && !force) return iedFxCat;
  try {
    const d = await (await fetch("/api/images/effects")).json();
    if (d.error) throw new Error(d.error);
    iedFxCat = d.effects || {};
    iedFxErr = null;
  } catch (err) {
    iedFxCat = null; iedFxErr = err.message || String(err);
    IED_CAPS.effects.live = false;
    return null;
  }
  IED_CAPS.effects.live = Object.keys(iedFxCat).length > 0;
  // Group order follows the catalog's own key order, which is the order the
  // registry declares them in — not alphabetical, which would scatter them.
  const seen = new Map();
  for (const [name, e] of Object.entries(iedFxCat)) {
    if (!seen.has(e.group)) seen.set(e.group, []);
    seen.get(e.group).push(name);
  }
  iedFxOrder = [...seen.entries()];
  iedFxPickBuild(); iedMenuBuild();
  return iedFxCat;
}

const iedHex = (c) => "#" + [c[0], c[1], c[2]]
  .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

function iedFxPickBuild() {
  const sel = $("iedFxPick");
  if (!sel || !iedFxCat) return;
  sel.innerHTML = `<option value="">+ add effect…</option>`
    + iedFxOrder.map(([g, names]) => `<optgroup label="${esc(g)}">`
      + names.map((n) => `<option value="${esc(n)}">${esc(iedFxCat[n].label)}</option>`).join("")
      + `</optgroup>`).join("");
}
$("iedFxPick").onchange = () => {
  const v = $("iedFxPick").value;
  $("iedFxPick").value = "";
  if (v) iedFxAdd(v);
};
$("iedFxClear").onclick = () => {
  ied.fx.length = 0; ied.fxSel = -1; iedFxPaint(); iedStatus(); iedPush("clear effects");
};

/* Every parameter the catalog declares, at the catalog's default — never a
 * hand-picked subset. An effect whose params were rebuilt from a key list
 * would silently drop whatever that list forgot. */
function iedFxDefaults(type) {
  const e = iedFxCat?.[type];
  const p = {};
  for (const [k, d] of Object.entries(e?.params || {})) {
    p[k] = Array.isArray(d.default) ? JSON.parse(JSON.stringify(d.default)) : d.default;
  }
  return p;
}

function iedFxAdd(type) {
  if (!iedFxCat?.[type]) { iedToast(`The catalog has no effect called "${type}".`); return; }
  ied.fx.push({ type, params: iedFxDefaults(type), on: true });
  ied.fxSel = ied.fx.length - 1;
  $("iedDockFx").open = true;
  iedFxPaint(); iedStatus();
  iedPush(`effect · ${iedFxCat[type].label}`);
}

function iedFxPaint() {
  const list = $("iedFxList");
  if (!list) return;
  if (iedFxErr) {
    list.innerHTML = `<p class="hint iedcapwarn">The effect catalog did not load: ${esc(iedFxErr)}</p>`;
    $("iedFxParams").innerHTML = ""; return;
  }
  list.innerHTML = ied.fx.length ? ied.fx.map((f, i) => {
    const e = iedFxCat?.[f.type] || { label: f.type };
    return `<div class="iedfxrow${i === ied.fxSel ? " on" : ""}${f.on ? "" : " off"}" data-fxrow="${i}">
      <span class="iedfxname" title="${esc(e.why || "")}">${i + 1}. ${esc(e.label || f.type)}</span>
      ${e.needsTimeline ? `<span class="iedfxbadge" title="A still has no previous frames — §4 says this returns the image untouched rather than pretending the name is wrong.">no-op on a still</span>` : ""}
      <button class="edtool sm" data-fxon="${i}" title="${f.on ? "skip this one" : "include it again"}">${f.on ? "●" : "○"}</button>
      <button class="edtool sm" data-fxup="${i}" title="earlier in the chain">▲</button>
      <button class="edtool sm" data-fxdn="${i}" title="later in the chain">▼</button>
      <button class="edtool sm" data-fxdel="${i}" title="remove">✕</button></div>`;
  }).join("") : `<p class="hint">Nothing stacked. Filter → any group, or the picker above.</p>`;

  for (const b of list.querySelectorAll("[data-fxrow]")) {
    b.onclick = (ev) => { if (ev.target.closest("button")) return; ied.fxSel = +b.dataset.fxrow; iedFxPaint(); };
  }
  for (const b of list.querySelectorAll("[data-fxon]")) {
    b.onclick = () => { const i = +b.dataset.fxon; ied.fx[i].on = !ied.fx[i].on; iedFxPaint(); iedStatus(); };
  }
  for (const b of list.querySelectorAll("[data-fxup]")) {
    b.onclick = () => iedFxMove(+b.dataset.fxup, -1);
  }
  for (const b of list.querySelectorAll("[data-fxdn]")) {
    b.onclick = () => iedFxMove(+b.dataset.fxdn, 1);
  }
  for (const b of list.querySelectorAll("[data-fxdel]")) {
    b.onclick = () => {
      const i = +b.dataset.fxdel;
      ied.fx.splice(i, 1);
      if (ied.fxSel >= ied.fx.length) ied.fxSel = ied.fx.length - 1;
      iedFxPaint(); iedStatus(); iedPush("remove effect");
    };
  }
  iedFxParams();
  const timeline = ied.fx.filter((f) => f.on && iedFxCat?.[f.type]?.needsTimeline);
  $("iedFxNote").textContent = timeline.length
    ? `${timeline.length} of these read a timeline. A still has none, so they come back untouched — §4.`
    : "Applied in the order listed, after the adjustments and before the strokes — §2. No live preview: these render server-side on Apply.";
  $("iedFxNote").classList.toggle("iedcapwarn", timeline.length > 0);
}

function iedFxMove(i, d) {
  const j = i + d;
  if (j < 0 || j >= ied.fx.length) return;
  [ied.fx[i], ied.fx[j]] = [ied.fx[j], ied.fx[i]];
  ied.fxSel = j; iedFxPaint(); iedPush("reorder effects");
}

/* The parameter panel is generated from the catalog entry — type, range,
 * default and the one line of prose the registry carries about each. */
function iedFxParams() {
  const host = $("iedFxParams");
  if (!host) return;
  const f = ied.fx[ied.fxSel];
  const e = f && iedFxCat?.[f.type];
  if (!f || !e) { host.innerHTML = ""; return; }
  const rows = Object.entries(e.params || {}).map(([k, d]) => {
    const v = f.params[k];
    const id = `iedFxP_${k}`;
    if (d.type === "bool") {
      return `<div class="iedparam"><span>${esc(k)}</span>
        <input type="checkbox" id="${id}" data-fxp="${esc(k)}"${v ? " checked" : ""}><b></b>
        <span class="iedparamwhy">${esc(d.desc || "")}</span></div>`;
    }
    if (d.type === "enum") {
      return `<div class="iedparam"><span>${esc(k)}</span>
        <select class="sel2 sm" id="${id}" data-fxp="${esc(k)}">${(d.options || []).map((o) =>
          `<option${o === v ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>
        <span class="iedparamwhy">${esc(d.desc || "")}</span></div>`;
    }
    if (d.type === "color") {
      return `<div class="iedparam"><span>${esc(k)}</span>
        <input type="color" id="${id}" data-fxp="${esc(k)}" value="${iedHex(v || d.default)}">
        <span class="iedparamwhy">${esc(d.desc || "")} — 0-255 RGB</span></div>`;
    }
    if (d.type === "points") {
      /* A curve editor for every points parameter is a second console. The
       * default is sent verbatim and the row says so, rather than showing a
       * control that cannot change anything. */
      return `<div class="iedparam"><span>${esc(k)}</span>
        <span class="hint">${(v || []).length} points, at the catalog default</span><b></b>
        <span class="iedparamwhy">${esc(d.desc || "")} — not editable here; the Adjustments curve is the console's curve editor</span></div>`;
    }
    const min = d.min ?? 0, max = d.max ?? 100;
    return `<div class="iedparam"><span>${esc(k)}</span>
      <input type="range" id="${id}" data-fxp="${esc(k)}" min="${min}" max="${max}"
        step="${d.integer ? 1 : "any"}" value="${v}">
      <b id="${id}_v">${d.integer ? Math.round(v) : (+v).toFixed(2)}</b>
      <span class="iedparamwhy">${esc(d.desc || "")}${d.unit ? ` (${esc(d.unit)})` : ""}</span></div>`;
  });
  host.innerHTML = `<div class="iedgrp"><b class="iedgrph">${esc(e.label)} · ${esc(e.group)}</b>
    <p class="hint">${esc((e.why || "").split(". ")[0])}.</p>${rows.join("")}</div>`;

  for (const el of host.querySelectorAll("[data-fxp]")) {
    const k = el.dataset.fxp;
    const d = e.params[k];
    const write = () => {
      if (d.type === "bool") f.params[k] = el.checked;
      else if (d.type === "enum") f.params[k] = el.value;
      else if (d.type === "color") f.params[k] = hex2rgb(el.value);
      else {
        f.params[k] = d.integer ? Math.round(+el.value) : +el.value;
        const out = $(`iedFxP_${k}_v`);
        if (out) out.textContent = d.integer ? Math.round(+el.value) : (+el.value).toFixed(2);
      }
      iedFxRowLabel();
    };
    el.oninput = write;
    el.onchange = () => { write(); iedPush(`${e.label} · ${k}`); };
  }
}

// keeps the row's tooltip honest while a slider moves, without a full repaint
function iedFxRowLabel() {
  const row = $("iedFxList")?.querySelector(`[data-fxrow="${ied.fxSel}"] .iedfxname`);
  const f = ied.fx[ied.fxSel];
  if (row && f) row.title = `${iedFxCat?.[f.type]?.why || f.type}\n\n${JSON.stringify(f.params)}`;
}

/* ── the navigator ─────────────────────────────────────────────────────────
 * The picture small, with a box round what the viewport shows. Drawn through
 * the SAME rotate-then-flip walk iedApplyView() applies to the DOM, so a
 * rotated document does not show a navigator that disagrees with the canvas. */
function iedNavPaint() {
  const cv = $("iedNav"), img = $("iedImg"), host = $("iedCanvas");
  if (!cv || !img?.naturalWidth) return;
  const cw = cv.clientWidth;
  if (!cw) return;                                  // dock collapsed — nothing to draw on
  const { w, h, nw, nh } = iedRotSize();
  const ch = Math.max(56, Math.min(220, Math.round(cw * (h / w))));
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
  }
  cv.style.height = `${ch}px`;
  const x = cv.getContext("2d");
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, cw, ch);
  const s = Math.min(cw / w, ch / h);
  cv._s = s;                                        // the drag handler needs the same scale
  x.save();
  x.scale(s, s);
  if (ied.flipH) { x.translate(w, 0); x.scale(-1, 1); }
  if (ied.flipV) { x.translate(0, h); x.scale(1, -1); }
  if (ied.rotate === 90) { x.translate(nh, 0); x.rotate(Math.PI / 2); }
  else if (ied.rotate === 180) { x.translate(nw, nh); x.rotate(Math.PI); }
  else if (ied.rotate === 270) { x.translate(0, nw); x.rotate(-Math.PI / 2); }
  try { x.drawImage(img, 0, 0, nw, nh); } catch { /* not decoded yet */ }
  x.restore();
  if (ied.crop) {
    const a = iedSrcToViewNav(ied.crop.x, ied.crop.y, s), b = iedSrcToViewNav(ied.crop.x + ied.crop.w, ied.crop.y + ied.crop.h, s);
    x.strokeStyle = iedMarkInk(); x.lineWidth = 1;
    x.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  }
  const z = ied.view.zoom;
  const vx = -ied.view.x / z, vy = -ied.view.y / z;
  const vw = host.clientWidth / z, vh = host.clientHeight / z;
  x.strokeStyle = iedLiveInk(); x.lineWidth = 1.4;
  x.strokeRect(vx * s + 0.5, vy * s + 0.5, vw * s, vh * s);
}
/* source pixel -> navigator pixel: iedSrcToView without the pan and the zoom */
function iedSrcToViewNav(sx, sy, s) {
  const { w, h, nw, nh } = iedRotSize();
  let fx = sx, fy = sy;
  if (ied.rotate === 90) { fx = nh - sy; fy = sx; }
  else if (ied.rotate === 180) { fx = nw - sx; fy = nh - sy; }
  else if (ied.rotate === 270) { fx = sy; fy = nw - sx; }
  if (ied.flipH) fx = w - fx;
  if (ied.flipV) fy = h - fy;
  return { x: fx * s, y: fy * s };
}
{
  const cv = $("iedNav");
  let dragging = false;
  const goto = (e) => {
    const r = cv.getBoundingClientRect();
    const s = cv._s || 1, host = $("iedCanvas");
    const fx = (e.clientX - r.left) / s, fy = (e.clientY - r.top) / s;
    ied.view.x = host.clientWidth / 2 - fx * ied.view.zoom;
    ied.view.y = host.clientHeight / 2 - fy * ied.view.zoom;
    ied.fitted = false; iedApplyView();
  };
  cv.addEventListener("pointerdown", (e) => {
    if (!$("iedImg").naturalWidth) return;
    dragging = true; try { cv.setPointerCapture(e.pointerId); } catch { /* keep going */ }
    goto(e); e.preventDefault();
  });
  cv.addEventListener("pointermove", (e) => { if (dragging) goto(e); });
  const stop = () => { dragging = false; };
  cv.addEventListener("pointerup", stop);
  cv.addEventListener("pointercancel", stop);
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    iedZoomCentre(ied.view.zoom * Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
}

/* ── history: the edit that has not been committed yet ─────────────────────
 *
 * The lineage strip below is the history of FILES. This is the history of the
 * console — every control, snapshot whole and restored whole. Written as one
 * snapshot/restore pair rather than an undo per control, because a per-control
 * undo is where a codebase learns that half its state was never captured.
 *
 * The list of ids is exhaustive on purpose: a snapshot that quietly omits a
 * field is the "rebuilt from a key list" failure, and it looks like working
 * software right up until the field you forgot is the one you changed. */
const IED_SNAPCTL = ["iedB", "iedC", "iedS", "iedG", "iedT", "iedSh", "iedBl", "iedV",
  "iedShd", "iedHl", "iedPost", "iedDn", "iedGr", "iedRw", "iedRh",
  "iedKeyTol", "iedKeySoft", "iedTxt", "iedTxtSize", "iedTxtColor", "iedTxtStrokeC",
  "iedTxtStroke", "iedTxtFont", "iedHslBand", "iedVecColors",
  "iedSelFeather", "iedSelExpand", "iedSelTol", "iedSelContig", "iedSelInvert", "iedSelAA",
  "iedStSize2", "iedStHard", "iedStOpacity", "iedStFlow", "iedStAmount", "iedStColor", "iedStSpacing",
  "iedShFillOn", "iedShFill", "iedShStrokeOn", "iedShStroke", "iedShWidth", "iedShRadius", "iedShBlend"];
const IED_SNAPTOG = ["iedGray", "iedSepia", "iedInv"];
const iedClone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

function iedSnap() {
  const ctl = {};
  for (const id of IED_SNAPCTL) {
    const el = $(id);
    ctl[id] = el.type === "checkbox" ? !!el.checked : el.value;
  }
  return {
    rotate: ied.rotate, flipH: ied.flipH, flipV: ied.flipV, autoLevels: ied.autoLevels,
    curveCh: ied.curveCh, cloneSrc: iedClone(ied.cloneSrc),
    crop: iedClone(ied.crop), key: iedClone(ied.key), curves: iedClone(ied.curves),
    hsl: iedClone(ied.hsl), text: iedClone(ied.text), levels: iedClone(ied.levels),
    canvas: iedClone(ied.canvas), geom: iedClone(ied.geom),
    fx: iedClone(ied.fx), fxSel: ied.fxSel, sel: iedClone(ied.sel),
    strokes: iedClone(ied.strokes), shapes: iedClone(ied.shapes),
    paths: iedClone(ied.paths), pathSel: ied.pathSel, pathDraws: iedClone(ied.pathDraws),
    text2: iedClone(ied.text2),
    // The staging layer list — it holds OBJECTS (src, clipped, transform), so
    // it is deep-cloned like every other structured field here. It sat outside
    // the snapshot for as long as the file's own warning above described:
    // toggling a clipping mask was unrecorded and unrecoverable.
    layers: iedClone(iedLayers), layerSel: iedLayerSel,
    // ied.chanView is deliberately ABSENT: which plane the Channels dock shows
    // is view state, not document state — Photoshop's undo ignores it too.
    ctl, tog: IED_SNAPTOG.map((id) => $(id).classList.contains("on")),
    selMode: iedSelMode(), tool: ied.tool,
  };
}

function iedRestore(s) {
  for (const [id, v] of Object.entries(s.ctl)) {
    const el = $(id);
    if (el.type === "checkbox") { el.checked = !!v; continue; }
    /* A <select> filled asynchronously — the font shelf comes from /api/fonts —
     * is EMPTY in a snapshot taken before it arrived. Assigning that back blanks
     * a perfectly good choice, and the only symptom is a font picker that
     * mysteriously empties when you undo. Restore a select only to an option it
     * actually has. */
    if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === String(v))) continue;
    el.value = v;
  }
  IED_SNAPTOG.forEach((id, i) => $(id).classList.toggle("on", !!s.tog[i]));
  ied.rotate = s.rotate; ied.flipH = s.flipH; ied.flipV = s.flipV;
  ied.autoLevels = s.autoLevels; ied.curveCh = s.curveCh;
  ied.crop = iedClone(s.crop); ied.key = iedClone(s.key); ied.curves = iedClone(s.curves);
  ied.hsl = iedClone(s.hsl); ied.text = iedClone(s.text); ied.levels = iedClone(s.levels);
  ied.canvas = iedClone(s.canvas); ied.geom = iedClone(s.geom);
  ied.fx = iedClone(s.fx); ied.fxSel = s.fxSel; ied.sel = iedClone(s.sel);
  ied.strokes = iedClone(s.strokes); ied.shapes = iedClone(s.shapes);
  ied.paths = iedClone(s.paths) || []; ied.pathSel = s.pathSel ?? -1;
  ied.pathDraws = iedClone(s.pathDraws) || [];
  ied.text2 = iedClone(s.text2) ?? null;
  ied.cloneSrc = iedClone(s.cloneSrc);
  // In place: iedLayers is a shared const binding.
  iedLayers.length = 0;
  iedLayers.push(...(iedClone(s.layers) || []));
  iedLayerSel = Math.min(s.layerSel ?? -1, iedLayers.length - 1);
  ied.selDraft = null; ied.strokeDraft = null; ied.shapeDraft = null; ied.pathDraft = null;
  $("iedAutoLv").classList.toggle("on", !!s.autoLevels);
  for (const b of document.querySelectorAll("[data-curvech]")) {
    b.classList.toggle("on", b.dataset.curvech === s.curveCh);
  }
  for (const b of document.querySelectorAll("[data-selmode]")) {
    b.classList.toggle("on", b.dataset.selmode === s.selMode);
  }
  $("iedCropClear").hidden = !ied.crop;
  $("iedCropLbl").textContent = ied.crop
    ? `${ied.crop.w}×${ied.crop.h} @ ${ied.crop.x},${ied.crop.y}` : "drag on the image";
  const chip = $("iedKeyChip");
  chip.hidden = !ied.key;
  if (ied.key) chip.style.background = `rgb(${ied.key[0]},${ied.key[1]},${ied.key[2]})`;
  iedKeyPreview();
  iedHslLoad(); iedDrawCurve();
  iedFxPaint(); iedSelPaint(); iedPaintQueuePaint();
  iedPathsPaint(); iedCharPaint(); iedLayersPaint();
  if (s.tool && s.tool !== ied.tool) iedSetTool(s.tool);
  iedStrokeOpts(); iedShapeOpts();
  iedPreview(); iedTextSync();
}

const iedU = { stack: [], at: -1, restoring: false };
function iedUndoReset() {
  iedU.stack = [{ label: "opened", snap: iedSnap() }];
  iedU.at = 0;
  iedStepsPaint();
}
function iedPush(label) {
  if (iedU.restoring || !iedU.stack.length) return;
  iedU.stack.length = iedU.at + 1;
  iedU.stack.push({ label, snap: iedSnap() });
  // 60 steps is more than anyone scrolls back through, and a snapshot is small.
  if (iedU.stack.length > 60) iedU.stack.shift();
  iedU.at = iedU.stack.length - 1;
  iedStepsPaint();
}
function iedStepTo(i) {
  if (i < 0 || i >= iedU.stack.length || i === iedU.at) return;
  iedU.restoring = true;
  try { iedRestore(iedU.stack[i].snap); } finally { iedU.restoring = false; }
  iedU.at = i;
  iedStepsPaint();
}
function iedStepsPaint() {
  const el = $("iedSteps");
  if (!el) return;
  el.innerHTML = iedU.stack.map((s, i) =>
    `<button class="iedstep${i === iedU.at ? " on" : ""}${i > iedU.at ? " future" : ""}" data-step="${i}">
      <i>${String(i).padStart(2, "0")}</i>${esc(s.label)}</button>`).join("");
  for (const b of el.querySelectorAll("[data-step]")) b.onclick = () => iedStepTo(+b.dataset.step);
  const cur = el.querySelector(".iedstep.on");
  if (cur?.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
}

/* ── the modal ─────────────────────────────────────────────────────────── */
/**
 * The export dialog. Every knob it shows is read by imgexport.py (a knob that
 * is accepted and ignored comes back in `ignored` and is said out loud), the
 * exported file lands in the images library, and the browser download starts
 * the moment the encoder answers. The raw working PNG stays one link away.
 */
function iedExportDlg() {
  const name = $("iedDl").getAttribute("download") || "";
  if (!name) return;
  iedDlgOpen("Export",
    `<div class="wrow"><label>format
        <select id="iedXFmt" class="sel2 sm">
          ${["png", "jpeg", "webp", "avif", "tiff", "ico", "pdf"].map((f) => `<option value="${f}"${f === "png" ? " selected" : ""}>${f}</option>`).join("")}
        </select></label>
      <label>quality <input id="iedXQ" type="number" min="1" max="100" step="1" value="90"
        title="Lossy formats only — png and tiff ignore it, and the reply says so rather than dropping it quietly"></label>
      <label>max KB <input id="iedXKB" type="number" min="1" step="10" placeholder="&mdash;"
        title="Searches quality to land under this many kilobytes and reports the quality it reached; blank is one encode at the quality box's value"></label>
    </div>
    <p class="hint" id="iedXNote">A format that cannot carry alpha flattens onto white &mdash; never silently black.
      EXIF is stripped. png, jpeg, webp and avif exports also show up in the images library;
      tiff, ico and pdf are download-only &mdash; saved in the images folder, but the gallery cannot display them.</p>
    <p class="hint">Need the untouched working PNG?
      <a href="/api/image/${encodeURIComponent(name)}" download="${esc(name)}">download it raw</a>.</p>
    <p class="hint rightsline" id="iedXRights"></p>`,
    `<button class="btn primary sm" id="iedXGo">Export</button>
     <button class="edtool sm" data-dlgclose>cancel</button>`);
  /* ONE LINE AT EXPORT, and the Export button is never disabled by it.
   *
   * This is the moment the file stops being a private experiment, so it is the
   * moment worth saying it — but the studio has no idea whether this PNG is
   * going to a paying client or a group chat, and a tool that guesses wrong and
   * refuses gets routed around by everyone, including the people it was
   * protecting. State the terms; let the person decide. */
  fetch(`/api/provenance?asset=${encodeURIComponent(`images/${name}`)}`)
    .then((r) => r.json())
    .then(async (p) => {
      const html = await rightsChipFor(p.summary);
      const box = $("iedXRights");
      if (!box || !html) return;
      box.innerHTML = `Before you sell it: ${html}`;
    }).catch(() => {});
  $("iedXGo").onclick = async () => {
    const kb = parseFloat($("iedXKB").value);
    const opts = { format: $("iedXFmt").value,
                   quality: Math.max(1, Math.min(100, parseInt($("iedXQ").value, 10) || 90)) };
    if (Number.isFinite(kb) && kb > 0) opts.maxBytes = Math.round(kb * 1024);
    $("iedXNote").textContent = "Encoding\u2026";
    $("iedXGo").disabled = true;
    try {
      const r = await fetch("/api/images/export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, opts }),
      }).then((x) => x.json());
      if (r.error) { $("iedXNote").textContent = r.error; return; }
      const a = document.createElement("a");
      a.href = `/api/image/${encodeURIComponent(r.name)}`;
      a.download = r.name;
      document.body.appendChild(a); a.click(); a.remove();
      $("iedXNote").textContent = `${r.name} \u2014 ${Math.round((r.bytes || 0) / 1024)} KB`
        + `${r.quality ? ` at quality ${r.quality}` : ""}`
        + `${r.ignored && r.ignored.length ? ` \u00b7 ignored: ${r.ignored.join(", ")}` : ""}`;
    } catch (e) {
      $("iedXNote").textContent = String(e.message || e);
    } finally {
      $("iedXGo").disabled = false;
    }
  };
}

function iedDlgOpen(title, body, foot) {
  $("iedDlgTitle").textContent = title;
  $("iedDlgBody").innerHTML = body;
  $("iedDlgFoot").innerHTML = foot || `<button class="edtool sm" data-dlgclose>close</button>`;
  $("iedDlg").hidden = false;
  for (const b of $("iedDlg").querySelectorAll("[data-dlgclose]")) b.onclick = iedDlgClose;
}
function iedDlgClose() { $("iedDlg").hidden = true; }
$("iedDlgX").onclick = iedDlgClose;
$("iedDlg").onclick = (e) => { if (e.target === $("iedDlg")) iedDlgClose(); };

const iedFocus = (dock, ctl) => {
  $(dock).open = true;
  const el = $(ctl);
  el.scrollIntoView?.({ block: "nearest" });
  el.focus?.();
};

/* Levels — the one op the engine has always had and the console never showed.
 * Per channel: where black starts, where white clips, the midtone between, and
 * both output points. imagetools.py reads exactly these five keys. */
function iedLevelsDlg() {
  const L = ied.levels || {};
  const row = (ch, name) => {
    const a = L[ch] || {};
    return `<div class="iedgrp"><b class="iedgrph">${esc(name)}</b>
      <div class="wrow">
        <label class="hint">black <input type="number" class="sel2 sm" data-lv="${ch}.black" value="${a.black ?? 0}" min="0" max="255" style="width:64px"></label>
        <label class="hint">white <input type="number" class="sel2 sm" data-lv="${ch}.white" value="${a.white ?? 255}" min="0" max="255" style="width:64px"></label>
        <label class="hint">gamma <input type="number" class="sel2 sm" data-lv="${ch}.gamma" value="${a.gamma ?? 1}" min="0.05" max="9.99" step="0.01" style="width:64px"></label>
      </div>
      <div class="wrow">
        <label class="hint">out black <input type="number" class="sel2 sm" data-lv="${ch}.outBlack" value="${a.outBlack ?? 0}" min="0" max="255" style="width:64px"></label>
        <label class="hint">out white <input type="number" class="sel2 sm" data-lv="${ch}.outWhite" value="${a.outWhite ?? 255}" min="0" max="255" style="width:64px"></label>
      </div></div>`;
  };
  iedDlgOpen("Levels",
    `<p class="hint">Applied before the curve, exactly as <code>ops.levels</code>.
      A channel whose black is 0 and white is 255 with gamma 1 is left alone.</p>
     ${row("master", "RGB")}${row("r", "Red")}${row("g", "Green")}${row("b", "Blue")}`,
    `<button class="edtool sm warn" id="iedLvOff">remove levels</button>
     <button class="btn primary sm" id="iedLvOk">set</button>`);
  $("iedLvOff").onclick = () => { ied.levels = null; iedDlgClose(); iedPush("levels off"); };
  $("iedLvOk").onclick = () => {
    const out = {};
    for (const el of $("iedDlgBody").querySelectorAll("[data-lv]")) {
      const [ch, key] = el.dataset.lv.split(".");
      (out[ch] = out[ch] || {})[key] = +el.value;
    }
    // A channel at its identity does nothing; sending it would only be noise.
    for (const [ch, a] of Object.entries(out)) {
      if (a.black === 0 && a.white === 255 && Math.abs(a.gamma - 1) < 0.001
          && a.outBlack === 0 && a.outWhite === 255) delete out[ch];
    }
    ied.levels = Object.keys(out).length ? out : null;
    iedDlgClose(); iedPush("levels");
  };
}

/* §7 canvas size: a frame change with a 9-way anchor. The anchor is where the
 * OLD picture sits inside the NEW frame — which is the thing every canvas-size
 * dialog gets asked about and none of them say. */
const IED_ANCHORS = [["topleft", "↖"], ["top", "↑"], ["topright", "↗"],
  ["left", "←"], ["center", "■"], ["right", "→"],
  ["bottomleft", "↙"], ["bottom", "↓"], ["bottomright", "↘"]];
function iedCanvasDlg() {
  const { w, h } = iedStageSize();
  const c = ied.canvas || {};
  iedDlgOpen("Canvas size",
    `<p class="hint">Changes the FRAME, not the content — §2 stage 1, before the crop.
      The anchor is where this picture sits inside the new frame.</p>
     <div class="wrow">
       <label class="hint">width <input type="number" id="iedCvW" class="sel2 sm" value="${c.width ?? w}" min="1" max="16384" style="width:86px"></label>
       <label class="hint">height <input type="number" id="iedCvH" class="sel2 sm" value="${c.height ?? h}" min="1" max="16384" style="width:86px"></label>
       <label class="hint">background <input type="color" id="iedCvBg" value="${iedHex(c.background || [0, 0, 0])}"></label>
       <label class="hint"><input type="checkbox" id="iedCvTrans"${(c.background?.[3] ?? 0) === 0 ? " checked" : ""}> transparent</label>
     </div>
     <div class="iedanchor" id="iedCvAnchor">${IED_ANCHORS.map(([k, g]) =>
       `<button data-anchor="${k}" class="${(c.anchor || "center") === k ? "on" : ""}" title="${k}">${g}</button>`).join("")}</div>`,
    `<button class="edtool sm warn" id="iedCvOff">no canvas change</button>
     <button class="btn primary sm" id="iedCvOk">set</button>`);
  for (const b of $("iedCvAnchor").querySelectorAll("[data-anchor]")) {
    b.onclick = () => { for (const o of $("iedCvAnchor").querySelectorAll("[data-anchor]")) o.classList.toggle("on", o === b); };
  }
  $("iedCvOff").onclick = () => { ied.canvas = null; iedDlgClose(); iedStatus(); iedPush("canvas size off"); };
  $("iedCvOk").onclick = () => {
    ied.canvas = {
      width: +$("iedCvW").value, height: +$("iedCvH").value,
      anchor: $("iedCvAnchor").querySelector(".on")?.dataset.anchor || "center",
      background: [...hex2rgb($("iedCvBg").value), $("iedCvTrans").checked ? 0 : 255],
      ...(ied.canvas?.trim ? { trim: ied.canvas.trim } : {}),
    };
    iedDlgClose(); iedStatus(); iedPush(`canvas ${ied.canvas.width}×${ied.canvas.height}`);
  };
}

/* §7 geometry: an arbitrary angle, which is the whole point — the engine takes
 * multiples of 90 today and the ⟳ button in Properties still uses that path. */
function iedRotateDlg() {
  const g = ied.geom || {};
  iedDlgOpen("Rotate",
    `<p class="hint">Any angle, with a clean antialiased edge — §7. The 90° button in
      Properties writes the old <code>ops.rotate</code>; this writes
      <code>ops.geometry.rotate</code>, and only one of the two is sent.</p>
     <div class="iedparam"><span>angle</span>
       <input type="range" id="iedGeoA" min="-180" max="180" step="0.1" value="${g.rotate ?? 0}">
       <b id="iedGeoAV">${(g.rotate ?? 0).toFixed(1)}°</b></div>
     <label class="hint"><input type="checkbox" id="iedGeoExp"${g.expand !== false ? " checked" : ""}> grow the frame to fit the rotation</label>`,
    `<button class="edtool sm warn" id="iedGeoOff">no rotation</button>
     <button class="btn primary sm" id="iedGeoOk">set</button>`);
  $("iedGeoA").oninput = () => { $("iedGeoAV").textContent = `${(+$("iedGeoA").value).toFixed(1)}°`; };
  $("iedGeoOff").onclick = () => { ied.geom = null; iedDlgClose(); iedStatus(); iedPush("rotation off"); };
  $("iedGeoOk").onclick = () => {
    ied.geom = { ...(ied.geom || {}), rotate: +$("iedGeoA").value, expand: $("iedGeoExp").checked };
    iedDlgClose(); iedStatus(); iedPush(`rotate ${(+$("iedGeoA").value).toFixed(1)}°`);
  };
}

function iedSmartResizeDlg() {
  const { w, h } = iedStageSize();
  const s = ied.geom?.smartResize || {};
  iedDlgOpen("Content-aware resize",
    `<p class="hint">Seam carving — §7. It removes the least interesting columns and
      rows rather than squashing everything equally, so it is for changing an
      aspect ratio, not for scaling. Plain scaling is Image → Image size.</p>
     <div class="wrow">
       <label class="hint">width <input type="number" id="iedSrW" class="sel2 sm" value="${s.width ?? w}" min="16" max="16384" style="width:92px"></label>
       <label class="hint">height <input type="number" id="iedSrH" class="sel2 sm" value="${s.height ?? h}" min="16" max="16384" style="width:92px"></label>
     </div>`,
    `<button class="edtool sm warn" id="iedSrOff">off</button>
     <button class="btn primary sm" id="iedSrOk">set</button>`);
  $("iedSrOff").onclick = () => {
    if (ied.geom) delete ied.geom.smartResize;
    if (ied.geom && !Object.keys(ied.geom).length) ied.geom = null;
    iedDlgClose(); iedStatus(); iedPush("smart resize off");
  };
  $("iedSrOk").onclick = () => {
    ied.geom = { ...(ied.geom || {}), smartResize: { width: +$("iedSrW").value, height: +$("iedSrH").value } };
    iedDlgClose(); iedStatus(); iedPush("content-aware resize");
  };
}

function iedPerspectiveDlg() {
  const { w, h } = iedStageSize();
  const q = ied.geom?.perspective || [[0, 0], [w, 0], [w, h], [0, h]];
  const names = ["top left", "top right", "bottom right", "bottom left"];
  iedDlgOpen("Perspective / free transform",
    `<p class="hint">The DESTINATION quad — where each corner of this picture ends up,
      in pixels. §7.</p>` + q.map((p, i) =>
      `<div class="wrow"><span class="hint">${names[i]}</span><span>
        <input type="number" class="sel2 sm" data-pq="${i}.0" value="${p[0]}" style="width:88px">
        <input type="number" class="sel2 sm" data-pq="${i}.1" value="${p[1]}" style="width:88px"></span></div>`).join(""),
    `<button class="edtool sm warn" id="iedPqOff">off</button>
     <button class="btn primary sm" id="iedPqOk">set</button>`);
  $("iedPqOff").onclick = () => {
    if (ied.geom) delete ied.geom.perspective;
    if (ied.geom && !Object.keys(ied.geom).length) ied.geom = null;
    iedDlgClose(); iedStatus(); iedPush("perspective off");
  };
  $("iedPqOk").onclick = () => {
    const pts = [[0, 0], [0, 0], [0, 0], [0, 0]];
    for (const el of $("iedDlgBody").querySelectorAll("[data-pq]")) {
      const [i, j] = el.dataset.pq.split(".").map(Number);
      pts[i][j] = +el.value;
    }
    ied.geom = { ...(ied.geom || {}), perspective: pts };
    iedDlgClose(); iedStatus(); iedPush("perspective");
  };
}

function iedResizeDlg() {
  const { w, h } = iedStageSize();
  iedDlgOpen("Image size",
    `<p class="hint">Plain resampling, applied LAST so nothing is resized twice — §2 stage 10.</p>
     <div class="wrow">
       <label class="hint">width <input type="number" id="iedRzW" class="sel2 sm" value="${$("iedRw").value || w}" min="16" max="8192" style="width:92px"></label>
       <label class="hint">height <input type="number" id="iedRzH" class="sel2 sm" value="${$("iedRh").value || h}" min="16" max="8192" style="width:92px"></label>
       <label class="hint"><input type="checkbox" id="iedRzLock" checked> keep the aspect</label>
     </div>`,
    `<button class="edtool sm warn" id="iedRzOff">keep the size</button>
     <button class="btn primary sm" id="iedRzOk">set</button>`);
  const ratio = h / w;
  $("iedRzW").oninput = () => { if ($("iedRzLock").checked) $("iedRzH").value = Math.round(+$("iedRzW").value * ratio); };
  $("iedRzH").oninput = () => { if ($("iedRzLock").checked) $("iedRzW").value = Math.round(+$("iedRzH").value / ratio); };
  $("iedRzOff").onclick = () => { $("iedRw").value = ""; $("iedRh").value = ""; iedDlgClose(); iedPush("size unchanged"); };
  $("iedRzOk").onclick = () => {
    $("iedRw").value = $("iedRzW").value; $("iedRh").value = $("iedRzH").value;
    iedDlgClose(); iedPush(`resize ${$("iedRw").value}×${$("iedRh").value}`);
  };
}

/* Help → what the server can do. The probe result, verbatim: which URL was
 * asked, what it answered, and what is therefore dark. A guess that turns out
 * wrong is then visible in one click instead of looking like a broken app. */
function iedCapsDlg() {
  const rows = Object.entries(IED_CAPS).map(([k, c]) => {
    const hit = (iedCapLog || []).find((l) => l.key === k);
    return `<tr><td>${esc(c.label)}</td><td>${esc(iedCapSpec(k))}</td>
      <td class="${c.live ? "iedok" : "iedno"}">${c.live ? "live" : "not built"}</td>
      <td><code>${esc(hit?.url || c.probe)}</code> → ${esc(hit?.status ?? "not asked")}</td></tr>`;
  }).join("");
  iedDlgOpen("What the server can do",
    `<p class="hint">Probed at open, once. Everything defaults to OFF, because
      <code>/api/images/edit</code> accepts an ops key it has no stage for and
      returns ok — so a control that assumed would look like it worked.</p>
     <table><tr><th>capability</th><th>spec</th><th>state</th><th>probe</th></tr>${rows}</table>
     <p class="hint">The probe follows this server's one convention: the effect catalog is
       at <code>/api/images/effects</code>, so a module's catalog is at
       <code>/api/images/&lt;noun&gt;</code>. An explicit
       <code>/api/images/capabilities</code> overrides all of it.</p>
     <p class="hint">The 404s this leaves in the browser console are the probe, once per
       session, and are the point &mdash; the alternative is assuming.</p>`,
    `<button class="edtool sm" id="iedCapRe">probe again</button>
     <button class="btn primary sm" data-dlgclose>close</button>`);
  $("iedCapRe").onclick = async () => { await iedProbeCaps(true); await iedFxLoad(true); iedCapsDlg(); };
}

function iedKeysDlg() {
  const chords = IED_CMDS.filter((c) => c.key).map((c) =>
    `<tr><td><kbd>${esc(c.key)}</kbd></td><td>${esc(c.menu)} → ${esc(c.label)}</td></tr>`).join("");
  const tools = IED_FAM.map((f) =>
    `<tr><td><kbd>${f.key.toUpperCase()}</kbd>${f.tools.length > 1 ? ` <kbd>Shift+${f.key.toUpperCase()}</kbd>` : ""}</td>
      <td>${esc(f.tools.map(([, l]) => l).join(" · "))}</td></tr>`).join("");
  iedDlgOpen("Keyboard",
    `<table><tr><th>chord</th><th>does</th></tr>${chords}</table>
     <p class="hint">Tools. Shift cycles inside a slot.</p>
     <table><tr><th>key</th><th>tool</th></tr>${tools}</table>
     <p class="hint">Space-drag pans from any tool · the wheel zooms about the cursor ·
       Escape closes a dialog, then a menu, then a half-drawn shape, then the console.</p>`);
}

/* ── the command table ─────────────────────────────────────────────────────
 * ONE list. The menu bar renders from it, the keyboard resolves chords against
 * it, and the enable rule is read from it — so a row cannot advertise a
 * shortcut the keyboard does not have, and a shortcut cannot fire something the
 * menu says is unavailable. `need` names a capability; a row with one is dark
 * until the probe says otherwise. */
const SEP = { sep: true };
const IED_CMDS = [
  { id: "file.apply", menu: "File", label: "Apply → new image", key: "Ctrl+Enter",
    run: () => $("iedApply").click() },
  { ...SEP, menu: "File" },
  { id: "file.download", menu: "File", label: "Download", key: "Ctrl+S", run: () => $("iedDl").click() },
  { id: "file.reveal", menu: "File", label: "Show the file", run: () => $("iedReveal2").click() },
  { id: "file.reuse", menu: "File", label: "Reuse this prompt", run: () => $("iedReuse2").click() },
  { id: "file.blur", menu: "File", label: "Blur in the gallery", run: () => $("iedBlur").click() },
  { ...SEP, menu: "File" },
  { id: "file.trash", menu: "File", label: "Move to trash…", run: () => $("iedTrash2").click() },
  { id: "file.close", menu: "File", label: "Close", key: "Escape", run: () => { $("imgEd").hidden = true; } },

  { id: "edit.undo", menu: "Edit", label: "Undo", key: "Ctrl+Z",
    enabled: () => iedU.at > 0, run: () => iedStepTo(iedU.at - 1),
    why: () => "Nothing to undo — this is where the file opened." },
  { id: "edit.redo", menu: "Edit", label: "Redo", key: "Ctrl+Shift+Z",
    enabled: () => iedU.at < iedU.stack.length - 1, run: () => iedStepTo(iedU.at + 1),
    why: () => "Nothing to redo." },
  { ...SEP, menu: "Edit" },
  { id: "edit.reset", menu: "Edit", label: "Reset the adjustments", run: () => { $("iedReset").click(); iedPush("reset adjustments"); } },
  { id: "edit.curvereset", menu: "Edit", label: "Reset the curve", run: () => { $("iedCurveReset").click(); iedPush("reset curve"); } },
  { id: "edit.clearqueue", menu: "Edit", label: "Clear everything queued",
    run: () => {
      ied.fx.length = 0; ied.fxSel = -1; ied.sel.length = 0;
      ied.strokes.length = 0; ied.shapes.length = 0;
      iedFxPaint(); iedSelPaint(); iedPaintQueuePaint(); iedOverlayPaint(); iedStatus();
      iedPush("clear the queue");
    } },
  { ...SEP, menu: "Edit" },
  { id: "edit.presetsave", menu: "Edit", label: "Save these settings as a preset…", run: () => $("iedPresetSave").click() },
  { id: "edit.presetapply", menu: "Edit", label: "Apply the chosen preset", run: () => $("iedPresetApply").click() },
  { id: "edit.presetdel", menu: "Edit", label: "Delete the chosen preset", run: () => $("iedPresetDel").click() },

  { id: "image.rot90", menu: "Image", label: "Rotate 90° clockwise", key: "Ctrl+]",
    run: () => { $("iedRot").click(); iedPush("rotate 90°"); } },
  { id: "image.rot270", menu: "Image", label: "Rotate 90° anticlockwise", key: "Ctrl+[",
    run: () => { ied.rotate = (ied.rotate + 270) % 360; iedReframe(); iedPush("rotate -90°"); } },
  { id: "image.fliph", menu: "Image", label: "Flip horizontally", run: () => { $("iedFH").click(); iedPush("flip H"); } },
  { id: "image.flipv", menu: "Image", label: "Flip vertically", run: () => { $("iedFV").click(); iedPush("flip V"); } },
  { ...SEP, menu: "Image" },
  { id: "image.rotate", menu: "Image", label: "Rotate by any angle…", need: "geometry", run: iedRotateDlg },
  { id: "image.canvas", menu: "Image", label: "Canvas size…", need: "geometry", run: iedCanvasDlg },
  { id: "image.trim", menu: "Image", label: "Trim the transparent edges", need: "geometry",
    run: () => {
      ied.canvas = { ...(ied.canvas || {}), trim: "transparent" };
      iedStatus(); iedPush("trim"); iedToast("Trim queued — it runs at stage 1, before the crop.");
    } },
  { id: "image.perspective", menu: "Image", label: "Perspective / free transform…", need: "geometry", run: iedPerspectiveDlg },
  { id: "image.smart", menu: "Image", label: "Content-aware resize…", need: "geometry", run: iedSmartResizeDlg },
  { ...SEP, menu: "Image" },
  { id: "image.size", menu: "Image", label: "Image size…", run: iedResizeDlg },
  { id: "image.cropsel", menu: "Image", label: "Crop to the selection", need: "selection",
    run: () => {
      const r = ied.sel.find((s) => s.kind === "rect");
      if (!r) { iedToast("Crop to selection needs a rectangular selection."); return; }
      const s0 = iedStageToSrc(r.x, r.y), s1 = iedStageToSrc(r.x + r.w, r.y + r.h);
      ied.crop = { x: Math.min(s0.x, s1.x), y: Math.min(s0.y, s1.y),
        w: Math.abs(s1.x - s0.x), h: Math.abs(s1.y - s0.y) };
      $("iedCropLbl").textContent = `${ied.crop.w}×${ied.crop.h} @ ${ied.crop.x},${ied.crop.y}`;
      $("iedCropClear").hidden = false;
      iedPaintCrop(); iedPush("crop to selection");
    } },
  { ...SEP, menu: "Image" },
  { id: "image.cutout", menu: "Image", label: "Remove the background", run: () => $("iedCut").click() },
  { id: "image.upscale", menu: "Image", label: "Upscale ×2", run: () => $("iedUp").click() },
  { id: "image.vector", menu: "Image", label: "Trace to SVG", run: () => $("iedVecGo").click() },
  { id: "image.analyze", menu: "Image", label: "Read the histogram and set the sliders", run: () => $("iedAuto").click() },

  { id: "layer.add", menu: "Layer", label: "Add an image layer…", run: () => iedFocus("iedDockLayers", "iedLayerPick") },
  { id: "layer.composite", menu: "Layer", label: "Composite → new image",
    enabled: () => iedLayers.length > 0, run: () => $("iedCompose").click(),
    why: () => "Add at least one layer first." },
  { id: "layer.clipmask", menu: "Layer", label: "Create / release clipping mask",
    enabled: () => iedLayerSel >= 0,
    run: () => {
      const l = iedLayers[iedLayerSel];
      if (l) {
        l.clipped = !l.clipped; iedLayersPaint(); iedFocus("iedDockLayers", "iedLayerList");
        iedPush(l.clipped ? "clip to the layer below" : "release clipping mask");
      }
    },
    why: () => "Select a layer row first — or Alt-click the border between two rows." },
  { ...SEP, menu: "Layer" },
  { id: "layer.new", menu: "Layer", label: "New layer", need: "layerdoc", run: () => {} },
  { id: "layer.dup", menu: "Layer", label: "Duplicate the layer", need: "layerdoc", run: () => {} },
  { id: "layer.group", menu: "Layer", label: "Group the layers", need: "layerdoc", run: () => {} },
  { id: "layer.mask", menu: "Layer", label: "Add a layer mask", need: "layerdoc", run: () => {} },
  { id: "layer.adjlayer", menu: "Layer", label: "New adjustment layer", need: "layerdoc", run: () => {} },

  { id: "select.all", menu: "Select", label: "All", key: "Ctrl+A", need: "selection",
    run: () => {
      const { w, h } = iedStageSize();
      ied.sel = [{ kind: "rect", x: 0, y: 0, w, h, mode: "add" }];
      iedSelPaint(); iedOverlayPaint(); iedPush("select all");
    } },
  { id: "select.none", menu: "Select", label: "Deselect", key: "Ctrl+D", need: "selection",
    run: () => { ied.sel.length = 0; ied.selDraft = null; iedSelPaint(); iedOverlayPaint(); iedPush("deselect"); } },
  { id: "select.invert", menu: "Select", label: "Invert", key: "Ctrl+Shift+I", need: "selection",
    run: () => { $("iedSelInvert").checked = !$("iedSelInvert").checked; iedStatus(); iedPush("invert selection"); } },
  { id: "select.fromcrop", menu: "Select", label: "From the crop rectangle", need: "selection",
    run: () => {
      if (!ied.crop) { iedToast("Drag a crop rectangle first."); return; }
      const a = iedSrcToStage(ied.crop.x, ied.crop.y);
      const b = iedSrcToStage(ied.crop.x + ied.crop.w, ied.crop.y + ied.crop.h);
      ied.sel.push({ kind: "rect", x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), mode: "add" });
      iedSelPaint(); iedOverlayPaint(); iedPush("selection from crop");
    } },
  { id: "select.frompath", menu: "Select", label: "From the pen path", need: "paths",
    run: () => $("iedPathToSel").click() },
  { id: "select.channel", menu: "Select", label: "Load a channel…", need: "selection",
    run: () => iedFocus("iedDockChannels", "iedChanList") },
  { ...SEP, menu: "Select" },
  { id: "select.feather", menu: "Select", label: "Feather and expand…", need: "selection",
    run: () => iedFocus("iedDockSel", "iedSelFeather") },

  { id: "adjust.auto", menu: "Adjust", label: "Auto tone", run: () => $("iedAuto").click() },
  { id: "adjust.autolv", menu: "Adjust", label: "Auto levels", run: () => $("iedAutoLv").click() },
  { id: "adjust.levels", menu: "Adjust", label: "Levels…", run: iedLevelsDlg },
  { id: "adjust.curves", menu: "Adjust", label: "Curves", run: () => iedFocus("iedDockAdjust", "iedCurve") },
  { ...SEP, menu: "Adjust" },
  { id: "adjust.bc", menu: "Adjust", label: "Brightness / contrast", run: () => iedFocus("iedDockAdjust", "iedB") },
  { id: "adjust.sat", menu: "Adjust", label: "Saturation", run: () => iedFocus("iedDockAdjust", "iedS") },
  { id: "adjust.gamma", menu: "Adjust", label: "Gamma", run: () => iedFocus("iedDockAdjust", "iedG") },
  { id: "adjust.temp", menu: "Adjust", label: "Temperature", run: () => iedFocus("iedDockAdjust", "iedT") },
  { id: "adjust.sh", menu: "Adjust", label: "Shadows / highlights", run: () => iedFocus("iedDockAdjust", "iedShd") },
  { id: "adjust.hsl", menu: "Adjust", label: "Hue / saturation by band", run: () => iedFocus("iedDockAdjust", "iedHslBand") },
  { id: "adjust.sharp", menu: "Adjust", label: "Sharpen", run: () => iedFocus("iedDockAdjust", "iedSh") },
  { id: "adjust.blur", menu: "Adjust", label: "Blur", run: () => iedFocus("iedDockAdjust", "iedBl") },
  { id: "adjust.vig", menu: "Adjust", label: "Vignette", run: () => iedFocus("iedDockAdjust", "iedV") },
  { ...SEP, menu: "Adjust" },
  { id: "adjust.gray", menu: "Adjust", label: "Black and white",
    checked: () => $("iedGray").classList.contains("on"), run: () => $("iedGray").click() },
  { id: "adjust.sepia", menu: "Adjust", label: "Sepia",
    checked: () => $("iedSepia").classList.contains("on"), run: () => $("iedSepia").click() },
  { id: "adjust.invert", menu: "Adjust", label: "Invert",
    checked: () => $("iedInv").classList.contains("on"), run: () => $("iedInv").click() },
  { id: "adjust.post", menu: "Adjust", label: "Posterize", run: () => iedFocus("iedDockEffects", "iedPost") },
  { id: "adjust.denoise", menu: "Adjust", label: "Denoise", run: () => iedFocus("iedDockEffects", "iedDn") },
  { id: "adjust.grain", menu: "Adjust", label: "Grain", run: () => iedFocus("iedDockEffects", "iedGr") },
  { id: "adjust.key", menu: "Adjust", label: "Chroma key", run: () => iedSetTool("eye") },

  { id: "filter.stack", menu: "Filter", label: "Show the effect stack", run: () => { $("iedDockFx").open = true; } },
  { id: "filter.clear", menu: "Filter", label: "Clear the stack",
    enabled: () => ied.fx.length > 0, run: () => $("iedFxClear").click(),
    why: () => "The stack is empty." },

  { id: "view.fit", menu: "View", label: "Fit on screen", key: "Ctrl+0", run: iedFit },
  { id: "view.100", menu: "View", label: "100%", key: "Ctrl+1", run: () => iedZoomCentre(1) },
  { id: "view.in", menu: "View", label: "Zoom in", key: "Ctrl+=", run: () => iedZoomCentre(ied.view.zoom * 1.6) },
  { id: "view.out", menu: "View", label: "Zoom out", key: "Ctrl+-", run: () => iedZoomCentre(ied.view.zoom / 1.6) },

  { id: "help.keys", menu: "Help", label: "Keyboard…", key: "Ctrl+/", run: iedKeysDlg },
  { id: "help.caps", menu: "Help", label: "What the server can do…", run: iedCapsDlg },
];

/* Dock toggles are commands too, so View lists them and the checkmarks are the
 * dock's real state rather than a copy of it that can go stale. */
for (const [dock, label] of [["iedDockNav", "Navigator"], ["iedDockAdjust", "Adjustments"],
  ["iedDockEffects", "Effects · quick"], ["iedDockFx", "Effect stack"], ["iedDockSel", "Selection"],
  ["iedDockPaint", "Paint & shapes"], ["iedDockLayers", "Layers"],
  ["iedDockChannels", "Channels"], ["iedDockPaths", "Paths"],
  ["iedDockChar", "Character / Paragraph"], ["iedDockSwatches", "Swatches"],
  ["iedDockProps", "Properties"],
  ["iedDockHistory", "History"], ["iedDockPresets", "Presets"]]) {
  if (label === "Navigator") IED_CMDS.push({ ...SEP, menu: "View" });
  IED_CMDS.push({ id: `view.${dock}`, menu: "View", label, checked: () => $(dock).open,
    run: () => { $(dock).open = !$(dock).open; } });
}

/* An SVG has no pixels. The docks that edit them are hidden for one, and the
 * menu rows that drive those docks go dark for the same reason — marked here,
 * in one place, rather than as a flag repeated forty times down the table. */
const IED_PIXELCMD = new Set(["file.apply", "edit.reset", "edit.curvereset", "edit.clearqueue",
  "edit.presetsave", "edit.presetapply", "edit.presetdel",
  "image.rot90", "image.rot270", "image.fliph", "image.flipv", "image.rotate", "image.canvas",
  "image.trim", "image.perspective", "image.smart", "image.size", "image.cropsel",
  "image.cutout", "image.upscale", "image.vector", "image.analyze",
  "layer.add", "layer.composite"]);
for (const c of IED_CMDS) {
  if (["Adjust", "Filter", "Select"].includes(c.menu) || IED_PIXELCMD.has(c.id)) c.pixels = true;
}
/* What the server's edit pipeline accepts as a SOURCE (every /api/images/*
 * pixel route guards png/jpg/webp). An SVG has no pixels at all; an avif
 * export HAS pixels but no edit route will take it back — either way a lit
 * pixel tool would promise an Apply that must fail. */
const iedHasPixels = () => !!ied.name && /\.(png|jpe?g|webp)$/i.test(ied.name);

const IED_BYID = Object.fromEntries(IED_CMDS.filter((c) => c.id).map((c) => [c.id, c]));
const IED_BYKEY = Object.fromEntries(IED_CMDS.filter((c) => c.key).map((c) => [c.key, c]));
const iedCmdEnabled = (c) =>
  (c.enabled ? c.enabled() : true) && iedCapLive(c.need) && (!c.pixels || iedHasPixels());
/* Why a row is dark, most useful answer first: a document with no pixels, then
 * a module that does not exist, then a local condition like an empty stack. */
function iedCmdWhy(c) {
  if (c.pixels && !iedHasPixels()) return "View-only here — download or trash it. (Pixel editing takes png, jpg or webp.)";
  if (!iedCapLive(c.need)) return iedCapWhy(c.need);
  return c.why ? c.why() : "";
}
function iedCmdRun(id) {
  const c = IED_BYID[id];
  if (!c) return;
  if (iedCmdEnabled(c)) c.run(); else iedToast(iedCmdWhy(c));
}

/* ── rendering the bar ─────────────────────────────────────────────────── */
const IED_MENUS = ["File", "Edit", "Image", "Layer", "Select", "Adjust", "Filter", "View", "Help"];

function iedMiHTML(c) {
  const en = iedCmdEnabled(c);
  const why = en ? "" : iedCmdWhy(c);
  /* A row that is dark because a MODULE is missing says which section of the
   * spec owns it, right in the row. A row that is dark because there is
   * nothing to undo just keeps its shortcut. */
  const badge = (!en && c.need) ? `<kbd>${esc(iedCapSpec(c.need))} pending</kbd>`
    : (c.key ? `<kbd>${esc(c.key)}</kbd>` : "");
  const btn = `<button class="iedmi${c.checked?.() ? " on" : ""}" data-cmd="${c.id}"${en ? "" : " disabled"}
      title="${esc(en ? "" : why)}"><span>${esc(c.label)}</span>${badge}</button>`;
  // A disabled <button> swallows its own hover in Chrome, so the reason rides
  // on a wrapper. Dim AND labelled beats dim alone.
  return en ? btn : `<span class="iedmiwrap" title="${esc(why)}">${btn}</span>`;
}

function iedFilterHTML() {
  if (!iedFxCat) {
    return `<span class="iedmiwrap" title="${esc(iedFxErr || "the catalog has not been fetched yet")}">
      <button class="iedmi" disabled><span>The effect catalog has not loaded</span></button></span>`;
  }
  return iedFxOrder.map(([g, names]) => `<div class="iedsub">
      <button class="iedmi"><span>${esc(g)}</span><kbd>${names.length}</kbd></button>
      <div class="iedmenupop">${names.map((n) => {
        const e = iedFxCat[n];
        return `<button class="iedmi" data-fxadd="${esc(n)}"
          title="${esc((e.why || "").slice(0, 240))}"><span>${esc(e.label)}</span>${
          e.needsTimeline ? '<kbd>still: no-op</kbd>' : ""}</button>`;
      }).join("")}</div></div>`).join("")
    + `<div class="iedsep"></div>`
    + IED_CMDS.filter((c) => c.menu === "Filter" && c.id).map(iedMiHTML).join("");
}

/* Rows are generated when the menu OPENS, not once at load. Undo goes from
 * dark to live the moment there is something to undo, and a menu built at
 * startup would still be advertising the state the console had then. */
function iedMenuFill(menu) {
  const m = menu.dataset.menu;
  const pop = menu.querySelector(".iedmenupop");
  pop.innerHTML = m === "Filter" ? iedFilterHTML()
    : IED_CMDS.filter((c) => c.menu === m)
      .map((c) => (c.sep ? '<div class="iedsep"></div>' : iedMiHTML(c))).join("");
  for (const b of pop.querySelectorAll("[data-cmd]")) {
    b.onclick = () => { iedMenuClose(); iedCmdRun(b.dataset.cmd); };
  }
  for (const b of pop.querySelectorAll("[data-fxadd]")) {
    b.onclick = () => { iedMenuClose(); iedFxAdd(b.dataset.fxadd); };
  }
}

function iedMenuBuild() {
  const bar = $("iedMenuBar");
  if (!bar) return;
  bar.innerHTML = IED_MENUS.map((m) =>
    `<div class="iedmenu" data-menu="${m}"><button class="iedmenubtn" data-menubtn="${m}">${m}</button>
      <div class="iedmenupop"></div></div>`).join("");
  for (const b of bar.querySelectorAll("[data-menubtn]")) {
    b.onclick = (e) => { e.stopPropagation(); iedMenuToggle(b.parentElement); };
    // Once one menu is open, sliding across the bar opens the next — the habit
    // every menu bar has, and its absence is what makes a fake one feel fake.
    b.onmouseenter = () => { if (bar.querySelector(".iedmenu.open")) iedMenuToggle(b.parentElement, true); };
  }
  for (const m of bar.querySelectorAll(".iedmenu")) iedMenuFill(m);
}

function iedMenuClose() {
  for (const m of document.querySelectorAll(".iedmenu.open")) m.classList.remove("open");
}
function iedMenuToggle(menu, force) {
  const was = menu.classList.contains("open");
  iedMenuClose();
  if (!was || force) {
    iedMenuFill(menu);
    menu.classList.add("open");
    // The ninth group's submenu would open off the right edge; flip it once,
    // when the geometry is actually known.
    const pop = menu.querySelector(".iedmenupop");
    const r = pop.getBoundingClientRect?.();
    if (r) for (const s of pop.querySelectorAll(".iedsub")) s.classList.toggle("flip", r.right + 250 > window.innerWidth);
  }
}
document.addEventListener("click", (e) => {
  if (!$("imgEd") || $("imgEd").hidden) return;
  if (!e.target.closest?.(".iedmenu")) iedMenuClose();
});
iedMenuBuild();

/* Sliders preview on every input and record ONE history step on release —
 * `change` on a range fires when the drag ends, which is exactly the grain a
 * history list wants. Named, because "c 140" is a history entry and "iedc" is
 * a variable name that leaked into the product. */
const IED_STEPNAME = { iedB: "brightness", iedC: "contrast", iedS: "saturation", iedG: "gamma",
  iedT: "temperature", iedSh: "sharpen", iedBl: "blur", iedV: "vignette", iedShd: "shadows",
  iedHl: "highlights", iedDn: "denoise", iedGr: "grain", iedPost: "posterize",
  iedHslH: "hue band", iedHslS: "sat band", iedHslL: "light band",
  iedRw: "output width", iedRh: "output height" };
for (const [id, name] of Object.entries(IED_STEPNAME)) {
  $(id).addEventListener("change", () => iedPush(`${name} ${$(id).value}`));
}
/* The three toggles and the auto-levels button are recorded HERE rather than in
 * their menu rows, so pressing the dock button and choosing the menu row leave
 * the same history — a step that appears only when you took the long way round
 * is worse than no step at all. */
for (const [id, name] of [["iedGray", "black & white"], ["iedSepia", "sepia"],
  ["iedInv", "invert"], ["iedAutoLv", "auto levels"]]) {
  $(id).addEventListener("click", () => iedPush(`${name} ${$(id).classList.contains("on") ? "on" : "off"}`));
}

$("iedTrash2").onclick = async () => {
  if (!(await appConfirm(`Move ${ied.name} to trash? It stays on disk in output/trash.`))) return;
  const r = await (await fetch("/api/images", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "trash", name: ied.name }) })).json();
  if (r.error) { alert(r.error); return; }
  $("imgEd").hidden = true;
  await loadImages();
};
$("imgSteps").oninput = () => { $("imgStepsV").textContent = $("imgSteps").value; };
$("imgCfg").oninput = () => { $("imgCfgV").textContent = $("imgCfg").value; };

/* Reference images for FLUX in-context editing — the API had this from day one;
 * the form finally does, in the Video screen's shape because that is what the
 * owner asked for and because the two are the same idea.
 *
 * ORDER IS THE FEATURE. FLUX has no tag syntax: the prompt says "image 1",
 * "image 2", and those numbers are positions in this strip. A picker that
 * could add and remove but not REORDER would leave "image 2" un-nameable
 * without emptying the list, so the arrows are part of the contract, not
 * polish. Each entry is { name, url } — a cover and a standalone image live in
 * different folders and are served from different routes, so the thumbnail URL
 * has to travel with the name. The server resolves the bare name in both
 * folders exactly the way the Video screen's frames do.
 */
const IMG_REF_MAX = 10;
const imgRefs = [];

/** Every picture the library can lend, both kinds, newest first. */
function imgRefCandidates() {
  const out = (state.images || [])
    // SVG has no raster to VAE-encode; _t thumbs are already filtered upstream.
    .filter((im) => !/\.svg$/i.test(im.name))
    .map((im) => ({ name: im.name, url: `/api/image/${encodeURIComponent(im.name)}`,
                    label: (im.meta?.prompt || im.name).slice(0, 48), group: "Images" }));
  /* Covers count. They live in another folder for storage reasons, and that
   * was never meant to be a capability boundary — the same argument that got
   * them admitted as video opening frames. */
  for (const t of state.library || []) {
    if (!t.cover) continue;
    out.push({ name: t.cover, url: `/api/cover/${encodeURIComponent(t.cover)}`,
               label: (t.title || t.file).slice(0, 48), group: "Song covers" });
  }
  return out;
}

/**
 * WHICH ENGINE IS REALLY GOING TO RENDER THIS.
 *
 * The dropdown says "Your own model file"; the FILE says what it is. A FLUX.2
 * transformer picked from models/diffusion_models renders on FLUX.2's graph —
 * the server resolves that before any of its rules run — so the screen must
 * ask the same question, or it refuses references on a FLUX.2 model while the
 * server would happily have taken them. "loads as" overrules both, because
 * that is what it is for.
 */
function imgEffectiveEngine() {
  const eng = $("imgEngine").value;
  if (eng !== "checkpoint") return eng;
  const said = $("imgDitKind")?.value;
  if (said && said !== "auto") return said;
  const ck = imgCkptShelf.find((c) => c.name === $("imgCkpt").value);
  return ck?.engine || "checkpoint";
}

function imgRefsPaint() {
  const eng = imgEffectiveEngine();
  const fluxOnly = eng !== "flux2";
  const n = imgRefs.length;

  const prev = $("imgRefPrev");
  prev.hidden = !n;
  prev.innerHTML = imgRefs.map((m, i) => `<figure class="midthumb">
      <span class="refnum">${i + 1}</span>
      <img src="${esc(m.url)}" alt="" loading="lazy" data-refsay="${i + 1}" title="${esc(m.name)} — click to say &quot;image ${i + 1}&quot;">
      <figcaption><button class="refmove" type="button" data-refup="${i}" ${i === 0 ? "disabled" : ""} title="Earlier">&#9664;</button>
        <button class="reftag" type="button" data-refsay="${i + 1}" title="Insert into the description">image ${i + 1}</button>
        <button class="refmove" type="button" data-refdown="${i}" ${i === n - 1 ? "disabled" : ""} title="Later">&#9654;</button>
        <button class="midx" type="button" data-refx="${i}" title="Remove">&#10005;</button></figcaption>
    </figure>`).join("");

  const chosen = new Set(imgRefs.map((m) => m.name));
  const rows = imgRefCandidates().filter((c) => !chosen.has(c.name));
  const groups = ["Images", "Song covers"].map((g) => {
    const inG = rows.filter((c) => c.group === g).slice(0, 60);
    return inG.length ? `<optgroup label="${g}">${inG
      .map((c) => `<option value="${esc(c.name)}">${esc(c.label)}</option>`).join("")}</optgroup>` : "";
  }).join("");
  const full = n >= IMG_REF_MAX;
  $("imgRefPick").innerHTML = `<option value="">${full ? `That is all ${IMG_REF_MAX}` : "Add a reference…"}</option>${full ? "" : groups}`;
  $("imgRefPick").disabled = full || fluxOnly;
  $("imgRefClear").hidden = !n;
  $("imgRefLimit").textContent = `${n ? `${n} of ${IMG_REF_MAX}` : `up to ${IMG_REF_MAX}`} · FLUX.2 only · optional`;

  /* The honest cost, from the same measurement the MCP tool description
   * quotes. References ride through every sampling step, so they are not
   * free and the form should not pretend otherwise. */
  $("imgRefCostNote").hidden = !n;
  $("imgRefCostNote").textContent = n
    ? `${n} reference${n === 1 ? "" : "s"} — each one is VAE-encoded into the conditioning, so it costs render time: `
      + `measured about 12 s for one, 8 s for two warm, and roughly 4 s per reference past the second.`
    : "";

  /* ⚠ The whole point of leaving this block visible on the other engines.
   * Ideogram and a bring-your-own checkpoint have no reference input, and the
   * old form HID the row — so the pictures stayed selected, invisible, and
   * were dropped from the POST without a word. Now it says so, and the
   * request is sent WITH the references anyway so the server's own refusal is
   * what stops the render: one rule, stated once, on the server. */
  /* ⚠ Z-Image is NOT a "no reference input" engine in the way the other two
   * are, and saying so straight is the point of this block. ComfyUI ships the
   * node (TextEncodeZImageOmni, image1/image2/image3 — a hard cap of three),
   * but the checkpoints it was written for, Z-Image-Edit and
   * Z-Image-Omni-Base, are both listed by Tongyi-MAI as "to be released", and
   * feeding a reference to the SHIPPING weights returns that reference's own
   * composition covered in colour noise with the prompt ignored (measured).
   * Wiring a picker to weights that cannot use it would be the worst of the
   * three options; naming the exact reason is the honest one. */
  const why = eng === "ideogram4"
    ? "Ideogram 4 has no reference input — in-context editing is FLUX.2's trick."
    : eng === "krea2"
      ? "Krea 2 has no reference input — in-context editing is FLUX.2's trick."
    : eng === "zimage" || eng === "zimage-base"
      ? "No released Z-Image checkpoint takes references. ComfyUI has the node — up to 3 images — but the weights it needs (Z-Image-Edit, Z-Image-Omni-Base) are still unreleased."
      : "A bring-your-own checkpoint has no reference input — in-context editing is FLUX.2's trick.";
  $("imgRefEngineNote").hidden = !fluxOnly;
  $("imgRefEngineNote").textContent = fluxOnly
    ? (n ? `${why} These ${n} picture${n === 1 ? "" : "s"} will NOT be used, and the render will be refused rather than quietly ignoring them — switch the engine back to FLUX.2, or Clear.`
         : `${why} Switch the engine to FLUX.2 to use references.`)
    : "";
  /* OUT OF THE WAY WHEN IT CANNOT BE USED — asked for, and right: a picker for
   * something this engine has no input for is furniture. It comes BACK the
   * moment references are attached, because pictures already chosen must never
   * disappear quietly; that was the old behaviour and it dropped them from the
   * POST without a word. So: hidden when unusable AND empty, visible with the
   * reason when unusable and something is attached. */
  const wrap = $("imgRefWrap");
  if (wrap) wrap.hidden = fluxOnly && !n;
  imgRefTagNote();
}

/* Say when the description names a reference that is not attached. Same guard
 * as the Video screen's, and the same reason: the render would go ahead and
 * the model would read "image 3" as a strange phrase, which looks like the
 * model ignoring the user. */
function imgRefTagNote() {
  const n = imgRefs.length;
  const bad = [];
  for (const m of ($("imgPrompt").value || "").matchAll(/\bimage\s+(\d+)\b/gi)) {
    const k = Number(m[1]);
    if (k < 1 || k > n) bad.push(`image ${k}`);
  }
  $("imgRefTagNote").hidden = !bad.length;
  $("imgRefTagNote").textContent = bad.length
    ? `The description says ${[...new Set(bad)].join(", ")} but ${n ? `only ${n} reference${n === 1 ? " is" : "s are"}` : "no reference is"} attached — add it, or fix the number.`
    : "";
}

/** Drop "image n" into the description at the caret, padded like the Video screen's tags. */
function imgRefSay(k) {
  const t = $("imgPrompt");
  const s = t.selectionStart ?? t.value.length, e = t.selectionEnd ?? s;
  const before = t.value.slice(0, s), after = t.value.slice(e);
  const pad = before && !/\s$/.test(before) ? " " : "";
  const pad2 = after && !/^\s/.test(after) ? " " : "";
  t.value = `${before}${pad}image ${k}${pad2}${after}`;
  const at = `${before}${pad}image ${k}`.length;
  t.focus();
  t.setSelectionRange(at, at);
  imgRefTagNote();
}

$("imgRefPick").onchange = () => {
  const v = $("imgRefPick").value;
  if (!v || imgRefs.length >= IMG_REF_MAX) return;
  const c = imgRefCandidates().find((x) => x.name === v);
  if (c) imgRefs.push({ name: c.name, url: c.url });
  imgRefsPaint();
};
$("imgRefClear").onclick = () => { imgRefs.length = 0; imgRefsPaint(); };

/* A picture that is not in the library yet. Same endpoint the Video screen's
 * reference upload uses (/api/frame stages it into ComfyUI's input dir and
 * names it by content hash), and the image route already accepts a name of
 * that shape — the capability was there, nothing in the Images form reached
 * it. */
$("imgRefUpload").onclick = () => $("imgRefFile").click();
$("imgRefFile").onchange = async () => {
  const files = [...($("imgRefFile").files || [])].slice(0, IMG_REF_MAX - imgRefs.length);
  const btn = $("imgRefUpload");
  const was = btn.textContent;
  btn.disabled = true;
  try {
    for (const f of files) {
      btn.textContent = `Uploading ${imgRefs.length + 1}/${IMG_REF_MAX}…`;
      const r = await (await fetch("/api/frame", {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f,
      })).json();
      if (r.error) throw new Error(r.error);
      imgRefs.push({ name: r.name, url: URL.createObjectURL(f) });
    }
  } catch (e) {
    alert(e.message);
  } finally {
    btn.textContent = was;
    btn.disabled = false;
    $("imgRefFile").value = "";
    imgRefsPaint();
  }
};
$("imgPrompt").addEventListener("input", imgRefTagNote);

/* One delegated listener for the strip, like vidRefWrap — the buttons are
 * repainted on every change, so per-element handlers would have to be rebound
 * every time and one missed rebind is a dead control. */
$("imgRefWrap").addEventListener("click", (e) => {
  const say = e.target.closest("[data-refsay]");
  if (say) return imgRefSay(Number(say.dataset.refsay));
  const up = e.target.closest("[data-refup]");
  if (up) {
    const i = Number(up.dataset.refup);
    if (i > 0) imgRefs.splice(i - 1, 0, ...imgRefs.splice(i, 1));
    return imgRefsPaint();
  }
  const down = e.target.closest("[data-refdown]");
  if (down) {
    const i = Number(down.dataset.refdown);
    if (i < imgRefs.length - 1) imgRefs.splice(i + 1, 0, ...imgRefs.splice(i, 1));
    return imgRefsPaint();
  }
  const x = e.target.closest("[data-refx]");
  if (x) {
    imgRefs.splice(Number(x.dataset.refx), 1);
    return imgRefsPaint();
  }
});

/* What each engine actually is, in the words the Models screen uses — the
 * catalogue's own shape, one line each, so the picker is not a list of names
 * whose consequences you have to already know. Steps and cfg here are the
 * numbers the form fills in, and they come from the same vendor templates
 * server/workflow.js builds the graphs from.
 *
 * ⚠ `negative` is the load-bearing field. It decides whether the "avoid"
 * box appears, and it is FALSE for Z-Image Turbo on purpose: at cfg 1.0
 * ComfyUI never evaluates the uncond branch, so a negative prompt there is
 * text nothing reads. The server refuses one rather than dropping it, this
 * table is why the form never offers it, and server/mcp-image_test.js diffs
 * this flag against ZIMAGE_PRESET.cfgs in workflow.js — the browser cannot
 * import a server module, so this copy is the one that could drift. */
const IMG_ENGINES = {
  /* `sampling`: the pair the engine renders with. `fixed` = its graph always
   * uses it (shown locked); otherwise it is the default and can be changed. */
  flux2: {
    steps: 4, negative: false, maxSteps: 30, sampling: { sampler: "euler", scheduler: "simple", fixed: true },
    note: "FLUX.2 klein 4B, Apache-2.0 — 4 steps, no CFG (distilled) — the only engine that takes reference images — about 3 s a picture once loaded.",
  },
  zimage: {
    steps: 8, negative: false, maxSteps: 50, sampling: { sampler: "res_multistep", scheduler: "simple", fixed: true },
    note: "Z-Image Turbo, Apache-2.0 — 8 steps, cfg 1.0, res_multistep/simple — photographic realism, faces, English and Chinese prompts — no negative prompt and no references: distilled at cfg 1.0, so the negative branch is never evaluated, and no released checkpoint takes refs.",
  },
  "zimage-base": {
    steps: 25, negative: true, maxSteps: 50, sampling: { sampler: "res_multistep", scheduler: "simple", fixed: true },
    note: "Z-Image base, Apache-2.0 — 25 steps, cfg 4.0, res_multistep/simple — the undistilled sibling: real CFG, a negative prompt that works, and genuinely different pictures per seed. Roughly four times Turbo's wall clock. Its README suggests up to 50 steps and cfg 3-5.",
  },
  krea2: {
    steps: 8, negative: false, maxSteps: 30, sampling: { sampler: "euler", scheduler: "simple", fixed: true },
    note: "Krea 2 Turbo (12B, int8) — 8 steps, cfg 1.0, euler/simple — the frontier open-weights look: photographic realism and detail. Krea 2 Community Licence: free commercial use under USD 1M a year and 50 seats. No negative prompt (distilled at cfg 1.0) and no references (FLUX.2's trick). Measured here: 52 s for the first picture (the 13.5 GB load), 26 s warm at 1024² — ten times FLUX.2 klein, for the frontier picture.",
  },
  ideogram4: {
    steps: null, negative: false, maxSteps: 30,
    note: "Ideogram 4 (open 9B) — typography, posters, graphic layouts — steps come from the preset (Default 20 / Quality 48) — ⚠ NON-COMMERCIAL licence, and its text is gated: nobody here has read what it says about your pictures.",
  },
  anima: {
    sampling: { sampler: "er_sde", scheduler: "simple", fixed: false },
  },
  checkpoint: {
    steps: 28, negative: true, maxSteps: 60,
    note: "Whatever .safetensors you dropped into ComfyUI/models/checkpoints or models/diffusion_models. A checkpoint is SD-class: real cfg and a real negative prompt. A bare transformer (Z-Image, Anima, FLUX.2, Krea 2) renders on its own family's recipe, and you can name the text encoder and VAE it should load with. The app lists, it does not curate — the licence and the content policy are its author's.",
  },
};

/* Engine choice re-shapes the form: a checkpoint and Z-Image base get a
 * negative prompt and a cfg slider (they run real classifier-free guidance),
 * Ideogram gets its preset pair and hides steps (its presets own them), and
 * every engine's step default is filled in from IMG_ENGINES. The checkpoint
 * shelf is whatever sits in ComfyUI/models/checkpoints — the app lists, it
 * does not curate. */
/* ── the SD-family dials, and the LoRA stack ──────────────────────────────
 *
 * All of this is checkpoint-only for reasons that are arithmetic rather than
 * taste: FLUX.2, Z-Image and Anima have no CLIP text encoder (so CLIP skip
 * would do nothing) and run fixed schedules (so a sampler picker would be a
 * second control that does nothing). LoraLoader takes a CheckpointLoader's
 * model+clip pair, which a bare DiT does not produce.
 */
let imgCkptShelf = [];      // the shelf, with each file's detected architecture

/* WHAT THIS MODEL WANTS. The detector reads the architecture out of the file's
 * header and the shelf carries its presets, so picking a checkpoint can set the
 * numbers instead of leaving FLUX's 4 steps and a 1024 canvas in front of an
 * SD1.5 model — which renders a soft, washed-out picture that reads as a broken
 * VAE and is only undersampling.
 *
 * Set, never locked: the sizes each family was TRAINED on are offered first and
 * "custom…" stays, because a rule the app cannot explain should not be a rule
 * the app imposes. */
function imgApplyArch() {
  const ck = imgCkptShelf.find((c) => c.name === $("imgCkpt").value);
  const d = ck?.defaults;
  const note = $("imgSizeNote");
  if (!d) { if (note) note.textContent = ""; return; }
  $("imgSteps").value = d.steps;
  $("imgStepsV").textContent = d.steps;
  $("imgCfg").value = d.cfg;
  $("imgCfgV").textContent = d.cfg;
  const cur = $("imgSize").value;
  $("imgSize").innerHTML = d.sizes.map(([w, h]) =>
    `<option value="${w}x${h}"${w === d.native && h === d.native ? " selected" : ""}>${w} × ${h}${w === h ? " · square" : w > h ? " · landscape" : " · portrait"}</option>`).join("")
    + '<option value="custom">custom…</option>';
  if ([...$("imgSize").options].some((o) => o.value === cur)) $("imgSize").value = cur;
  if (note) note.textContent = `${ck.variant || ck.family} · trained at ${d.native}`;
  imgLoadLoras();
  imgSampling();                                 // this file's kind of model picks the pair
}

$("imgCkpt").addEventListener("change", imgApplyArch);

/* ── a picked file's other halves ──────────────────────────────────────────
 * A checkpoint is self-contained. A bare transformer (Z-Image, Anima, FLUX.2,
 * Krea 2) is a third of a render: it needs a text encoder and a VAE, and which
 * ones normally follows from what the file IS. Detection answers that from the
 * tensors and is right for every file measured here — but a merge can carry
 * another family's layer names, and no probe can tell which encoder a model was
 * trained against. So the answer is offered as a DEFAULT and these three rows
 * let it be overridden. They are hidden for a plain checkpoint, where the
 * question does not arise: its encoder and VAE are inside the file. */
let imgParts = null;           // { encoders, vaes } from /api/modelparts

const DIT_KINDS = [
  ["zimage", "Z-Image"], ["anima", "Anima"], ["flux2", "FLUX.2"], ["krea2", "Krea 2"],
];

async function imgLoadParts() {
  if (imgParts) return imgParts;
  try { imgParts = await (await fetch("/api/modelparts")).json(); }
  catch { imgParts = { encoders: [], vaes: [] }; }
  return imgParts;
}

async function imgPartsShape() {
  const ck = imgCkptShelf.find((c) => c.name === $("imgCkpt").value);
  const isDit = !!ck && ck.folder && ck.folder !== "checkpoints";
  for (const id of ["imgDitKindL", "imgDitKindW", "imgEncoderL", "imgEncoderW", "imgVaeL", "imgVaeW"]) {
    const el = $(id);
    if (el) el.hidden = !isDit;
  }
  if (!isDit) return;
  const parts = await imgLoadParts();
  const named = DIT_KINDS.find(([id]) => id === ck.engine)?.[1] || ck.family || "not recognised";
  /* A quantised file says nothing about its family, so there is nothing to
   * detect and "auto" would be a promise the loader cannot keep. The first
   * option asks instead, and the route refuses a render that leaves it. */
  const auto = ck.needsKind
    ? '<option value="auto">choose what this is &mdash; a .gguf name does not say</option>'
    : '<option value="auto">detected &middot; ' + esc(named) + "</option>";
  $("imgDitKind").innerHTML = auto
    + DIT_KINDS.map(([id, label]) => '<option value="' + id + '">' + esc(label) + " &mdash; load it as this</option>").join("");
  const shelf = (rows, what) => '<option value="auto">auto &middot; the ' + what + " for this model</option>"
    + rows.map((r) => '<option value="' + esc(r.name) + '">' + esc(r.name) + "</option>").join("");
  $("imgEncoder").innerHTML = shelf(parts.encoders || [], "usual text encoder");
  $("imgVae").innerHTML = shelf(parts.vaes || [], "usual VAE");
}

$("imgCkpt").addEventListener("change", imgPartsShape);
/* Both of these change what the render will actually be, so both repaint the
 * reference block — a FLUX.2 file makes references legal again. */
$("imgCkpt").addEventListener("change", imgRefsPaint);
$("imgDitKind").addEventListener("change", imgRefsPaint);


let imgLoraStack = [];      // [{ name, strength, fit }]
let imgLoraShelf = [];      // what the folder holds, judged against the checkpoint

/* The sampler and schedule for the engine on the screen — and for your own
 * file, for the KIND of model it is. er_sde / simple is ANIMA's (its own
 * preset), and only Anima's: an Illustrious, NoobAI, Pony or Animagine file is
 * an SDXL model however anime it looks, and gets what SDXL anime merges are
 * run with, euler_ancestral / normal. (The first version sent every name with
 * "anime" or "Illustrious" in it to er_sde.) Other SDXL and SD 1.5 files:
 * dpmpp_2m / karras. A bare transformer: its own family's pair. Set every time
 * the engine or the file changes; the person can still pick another. */
export function ckptSampling(ck, fallbackName = "") {
  const name = String(ck?.name || fallbackName || "").toLowerCase();
  const kind = `${ck?.family || ""} ${ck?.variant || ""}`.toLowerCase();
  if (/\banima\b/.test(kind) || /anima(?!gine|l|te|tion|ted)/.test(name)) return { sampler: "er_sde", scheduler: "simple", why: "Anima model" };
  if (/z-image|lumina|zimage/.test(`${kind} ${name}`)) return { sampler: "res_multistep", scheduler: "simple", why: "Z-Image model" };
  if (/krea/.test(`${kind} ${name}`)) return { sampler: "euler", scheduler: "simple", why: "Krea model" };
  if (/flux/.test(`${kind} ${name}`)) return { sampler: "euler", scheduler: "simple", why: "FLUX model" };
  if (/sd3/.test(`${kind} ${name}`)) return { sampler: "dpmpp_2m", scheduler: "sgm_uniform", why: "SD3 model" };
  if (/pony|illustrious|noob|animagine|anime|\bil(xl|v?\d)|_il_|waifu/.test(name)) return { sampler: "euler_ancestral", scheduler: "normal", why: "SDXL anime model" };
  return { sampler: "dpmpp_2m", scheduler: "karras", why: "SD model" };
}
async function imgSampling() {
  const eng = $("imgEngine").value;
  const spec = IMG_ENGINES[eng]?.sampling;
  const want = eng === "checkpoint" ? ckptSampling(imgCkptShelf.find((c) => c.name === $("imgCkpt").value), $("imgCkpt").value) : spec;
  if (!want) return;
  await imgLoadSampling();
  /* The engine may be down (no list yet): show the pair anyway. */
  for (const [id, v] of [["imgSampler", want.sampler], ["imgSched", want.scheduler]]) {
    const sel = $(id);
    if (![...sel.options].some((o) => o.value === v)) sel.insertAdjacentHTML("beforeend", `<option>${esc(v)}</option>`);
    sel.value = v;
    sel.disabled = !!spec?.fixed && eng !== "checkpoint";
    sel.title = sel.disabled ? `${IMG_ENGINES[eng] ? eng : "This engine"} always renders with ${want.sampler} / ${want.scheduler}` : (want.why ? `Set for this ${want.why}; pick another if you like` : "");
  }
}
async function imgLoadSampling() {
  if ($("imgSampler").options.length > 2) return;
  try {
    const d = await (await fetch("/api/sampling/options")).json();
    if (!d.ok || !d.samplers.length) return;
    const opt = (v, sel) => `<option${v === sel ? " selected" : ""}>${esc(v)}</option>`;
    $("imgSampler").innerHTML = d.samplers.map((x) => opt(x, d.defaults.sampler)).join("");
    $("imgSched").innerHTML = d.schedulers.map((x) => opt(x, d.defaults.scheduler)).join("");
  } catch { /* engine down: the selects stay empty and the render uses the defaults */ }
}

/* The shelf, judged against the CHECKPOINT that is selected — a LoRA for the
 * wrong architecture renders with no error and no effect, so the fit is shown
 * before it is picked rather than discovered afterwards. */
async function imgLoadLoras() {
  const ck = $("imgCkpt").value;
  try {
    const d = await (await fetch(`/api/loras${ck ? `?for=${encodeURIComponent(ck)}` : ""}`)).json();
    imgLoraShelf = (d.loras || []).filter((l) => l.isLora);
  } catch { imgLoraShelf = []; }
  const fits = (l) => l.fits?.fit || "unknown";
  $("imgLoraPick").innerHTML = '<option value="">add a LoRA…</option>'
    + imgLoraShelf.map((l) => {
        const mark = fits(l) === "yes" ? "" : fits(l) === "no" ? " · ✗ " + (l.base || "?") : " · ? " + (l.base || "?");
        /* A mismatch is DISABLED rather than hidden: hiding a file someone
         * deliberately downloaded looks like the app losing it, and the reason
         * is the useful part. */
        return `<option value="${esc(l.name)}"${fits(l) === "no" ? " disabled" : ""}
                 title="${esc(l.fits?.why || l.base || "")}">${esc(l.name.replace(/\.safetensors$/i, ""))}${mark}</option>`;
      }).join("");
  $("imgLoraNote").textContent = imgLoraShelf.length
    ? `${imgLoraShelf.length} in models/loras · they stack`
    : "nothing in models/loras yet";
  imgPaintLoras();
}

function imgPaintLoras() {
  $("imgLoras").innerHTML = imgLoraStack.map((l, i) => {
    const shelf = imgLoraShelf.find((x) => x.name === l.name);
    const fit = shelf?.fits?.fit || "unknown";
    return `<div class="lorarow">
      <span class="lname" title="${esc(shelf?.fits?.why || "")}">${esc(l.name.replace(/\.safetensors$/i, ""))}</span>
      <span class="lfit" data-fit="${fit}" title="${esc(shelf?.fits?.why || "")}">${fit === "yes" ? "fits" : fit === "no" ? "wrong base" : "unverified"}</span>
      <input type="range" min="0" max="150" value="${Math.round((l.strength ?? 1) * 100)}" data-lorastr="${i}">
      <b>${(l.strength ?? 1).toFixed(2)}</b>
      <button class="edtool sm" type="button" data-lorax="${i}">✕</button>
    </div>`;
  }).join("");
  /* ⚠ DO NOT REPAINT ON EVERY INPUT EVENT. The slider used to rebuild the whole
   * stack as it moved, which destroys the very element the pointer is dragging:
   * the drag died after one step, every time, and the number under the thumb
   * jumped back. Only the number beside it changes while dragging — the value
   * lives in imgLoraStack either way, and nothing else on the row depends on
   * it. This is most of "the LoRA section is broken". */
  for (const r of document.querySelectorAll("#imgLoras [data-lorastr]")) {
    r.oninput = () => {
      const i = Number(r.dataset.lorastr);
      const v = Number(r.value) / 100;
      imgLoraStack[i].strength = v;
      const b = r.parentElement.querySelector("b");
      if (b) b.textContent = v.toFixed(2);
    };
  }
  /* Scoped to this stack: `[data-lorax]` matches the DAW's LoRA rows too, and
   * a global query here rebound their buttons to this list's indices. */
  for (const b of document.querySelectorAll("#imgLoras [data-lorax]")) {
    b.onclick = () => { imgLoraStack.splice(Number(b.dataset.lorax), 1); imgPaintLoras(); };
  }
}

/* The template shelf. There is no second language model here on purpose — the
 * agent already driving MCP writes these and saves them; this picker is the
 * human half, and a template dropped into the box is editable like any other
 * prompt rather than a thing that runs behind glass. */
async function imgLoadTemplates() {
  if (!$("imgTpl")) return;
  let rows = [];
  try { rows = (await (await fetch("/api/prompts")).json()).templates || []; }
  catch { /* leave it empty */ }
  $("imgTpl").innerHTML = '<option value="">Start from a template…</option>'
    + rows.map((t) => `<option value="${esc(t.id)}" data-tpl="${esc(t.template)}">`
        + `${esc(t.name)}${t.tag ? ` · ${esc(t.tag)}` : ""} · ${t.combinations} variations</option>`).join("");
  /* An empty shelf said "ask the agent for some", which wrapped onto its own
   * line beside two controls and read as an instruction nobody asked for.
   * The dropdown already says what it is; silence is the right empty state. */
  $("imgTplNote").textContent = "";
}

$("imgTpl").onchange = async () => {
  const opt = $("imgTpl").selectedOptions[0];
  const tpl = opt?.dataset.tpl;
  if (!tpl) return;
  /* Replacing what someone typed without asking is how you lose a prompt. */
  const cur = $("imgPrompt").value.trim();
  if (cur && !(await appConfirm("Replace what is in the box with this template?"))) { $("imgTpl").value = ""; return; }
  $("imgPrompt").value = tpl;
  $("imgTpl").value = "";
  $("imgPrompt").focus();
};

$("imgTplSave").onclick = async () => {
  const template = $("imgPrompt").value.trim();
  if (!template) { alert("Write a prompt first — that is what gets saved."); return; }
  const name = (await appPrompt("Name this template:", ""));
  if (!name) return;
  const tag = (await appPrompt("What does it vary? (characters, outfits, sceneries, styles…)", "")) || "";
  try {
    const r = await (await fetch("/api/prompts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, template, tag }),
    })).json();
    if (r.error) { alert(r.error); return; }
    await imgLoadTemplates();
    $("imgTplNote").textContent = `saved · ${r.template.combinations} variations`;
  } catch { alert("Could not save that template."); }
};

/* ── personas ─────────────────────────────────────────────────────────────
 * A saved character: the references that show the face, plus the words that
 * carry what a reference cannot. Judged against the engine, because references
 * are FLUX.2-only and a character that would be silently ignored is worse than
 * one the picker refuses to offer. */
async function imgLoadPersonas() {
  if (!$("imgPersona")) return;
  const eng = $("imgEngine").value;
  let rows = [], fits = null;
  try {
    const d = await (await fetch(`/api/personas?for=${encodeURIComponent(eng)}`)).json();
    rows = d.personas || []; fits = d.fits || null;
  } catch { /* leave the picker empty */ }
  const cur = $("imgPersona").value;
  $("imgPersona").innerHTML = '<option value="">No character…</option>'
    + rows.map((x) => `<option value="${esc(x.name)}"${x.name === cur ? " selected" : ""}>${esc(x.name)}</option>`).join("");
  const bad = fits && fits.fit !== "yes";
  $("imgPersona").disabled = !!bad;
  $("imgPersonaNote").hidden = !(bad && rows.length);
  if (bad && rows.length) $("imgPersonaNote").textContent = `Characters need reference images — ${fits.why}.`;
  $("imgPersonaDel").hidden = !$("imgPersona").value;
}

$("imgPersona").onchange = () => { $("imgPersonaDel").hidden = !$("imgPersona").value; };

$("imgPersonaSave").onclick = async () => {
  if (!imgRefs.length) {
    alert("Add the reference pictures that show this character first — that is what makes them reusable.");
    return;
  }
  const name = (await appPrompt("Name this character (this is how the prompt will refer to them):", ""));
  if (!name) return;
  const fragment = (await appPrompt("Describe them in a few words — what a picture cannot show:", "")) || "";
  try {
    const r = await (await fetch("/api/personas", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, fragment, refImages: imgRefs.map((m) => m.name), engine: $("imgEngine").value }),
    })).json();
    if (r.error) { alert(r.error); return; }
    await imgLoadPersonas();
    $("imgPersona").value = r.persona.name;
    $("imgPersonaDel").hidden = false;
  } catch { alert("Could not save that character."); }
};

$("imgPersonaDel").onclick = async () => {
  const name = $("imgPersona").value;
  if (!name || !(await appConfirm(`Forget "${name}"? The pictures stay in the library.`))) return;
  await fetch("/api/personas", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", name }),
  });
  await imgLoadPersonas();
};

$("imgLoraPick").onchange = () => {
  const name = $("imgLoraPick").value;
  $("imgLoraPick").value = "";
  if (!name || imgLoraStack.some((l) => l.name === name)) return;
  if (imgLoraStack.length >= 8) { alert("Eight LoRAs is the cap — the route refuses more."); return; }
  imgLoraStack.push({ name, strength: 1 });
  imgPaintLoras();
};

$("imgAdvToggle").onclick = () => {
  const open = $("imgAdv").hidden;
  $("imgAdv").hidden = !open;
  $("imgAdvToggle").textContent = open ? "hide" : "show…";
  $("imgAdvToggle").setAttribute("aria-expanded", String(open));
  if (open) { imgLoadSampling(); imgLoadLoras(); }
};

$("imgClipSkip").oninput = () => {
  const v = Number($("imgClipSkip").value);
  $("imgClipSkipV").textContent = v;
  /* Said where it is set, not in a manual: Pony and Illustrious are SDXL
   * underneath and effectively require 2, and nothing in a file's tensors can
   * identify such a merge — so the app cannot set it for you. */
  $("imgClipNote").textContent = v > 1 ? "Pony / Illustrious usually want 2" : "";
};

$("imgSize").onchange = () => {
  const custom = $("imgSize").value === "custom";
  $("imgCustomL").hidden = !custom;
  $("imgCustomW").hidden = !custom;
};

$("imgEngine").onchange = async () => {
  const eng = $("imgEngine").value;
  /* A SPACE-SEPARATED LIST, not one name. cfg and the negative prompt are
   * shared by every engine that really runs CFG, and the old exact-match made
   * that impossible to express — the second such engine would have had to
   * duplicate the markup. */
  for (const el of document.querySelectorAll("[data-engineonly]")) {
    el.hidden = !el.dataset.engineonly.split(/\s+/).includes(eng);
  }
  $("imgSteps").parentElement.hidden = eng === "ideogram4";
  $("imgSteps").parentElement.previousElementSibling.hidden = eng === "ideogram4";
  /* The vendor default for THIS engine, every time the engine changes.
   * Leaving the previous engine's number in place is how FLUX's 4 would reach
   * Z-Image base — a sixth of its schedule, and it looks like the model being
   * bad rather than the form being wrong. */
  const spec = IMG_ENGINES[eng];
  /* The slider's ceiling is the ROUTE's ceiling, per engine. It used to be a
   * flat 20; Z-Image base wanted 50 and the route already allowed 60 on a
   * checkpoint, so a single number was wrong in both directions — the form
   * either refused a legal ask or offered one the server would silently clamp.
   * Kept in step with the clamp in /api/image; mcp-image_test.js diffs them. */
  $("imgSteps").max = spec?.maxSteps || 30;
  if (spec?.steps) {
    $("imgSteps").value = spec.steps;
    $("imgStepsV").textContent = spec.steps;
  }
  /* Cleared rather than carried over: the server refuses a negative on an
   * engine that cannot evaluate one, so a leftover from the checkpoint engine
   * would fail the POST with a message about a box the form is no longer
   * showing. */
  if (spec && !spec.negative) $("imgNeg").value = "";
  $("imgModelNote").textContent = spec?.note || "";
  imgSampling();                                 // this engine's sampler and schedule
  // The reference block is never hidden — it explains itself instead.
  imgRefsPaint();
  imgLoadPersonas();
  imgLoadTemplates();
  /* Anima's DiTs live in models/diffusion_models — see the note on the picker
   * in index.html. Filtered to the family, because offering a Z-Image DiT to
   * the Anima engine would be a choice that can only fail. */
  if (eng === "anima" && !$("imgDit").options.length) {
    try {
      const d = await (await fetch("/api/dits?family=anima")).json();
      $("imgDit").innerHTML = (d.dits || []).map((x) =>
        `<option value="${esc(x.name)}">${esc(x.name.replace(/\.safetensors$/i, ""))}</option>`).join("")
        || '<option value="">no Anima model in models/diffusion_models</option>';
    } catch { /* leave empty */ }
  }
  if (eng === "checkpoint" && !$("imgCkpt").options.length) {
    try {
      const d = await (await fetch("/api/checkpoints")).json();
      imgCkptShelf = d.checkpoints || [];
      $("imgCkpt").innerHTML = ckptOptions(imgCkptShelf)
        || '<option value="">nothing in models/checkpoints or models/diffusion_models yet</option>';
      imgApplyArch();
      imgPartsShape();
    } catch { /* leave empty */ }
  }
};
/* Run it once, now, for whatever the dropdown starts on. The handler is the
 * only thing that fills imgModelNote and the step default, so without this the
 * Images screen opens with an empty description and FLUX's 4 in the box no
 * matter which engine is selected. */
$("imgEngine").onchange();

/* One renderer for both checkpoint pickers. A file that cannot load is shown
 * and DISABLED with the reason, rather than hidden: hiding it makes the app
 * look broken to someone who just put the file there on purpose. */
function ckptOptions(list, selected) {
  const gb = (b) => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
  const when = (t) => t ? new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
  /* TWO SHELVES, ONE MENU. A full checkpoint lives in models/checkpoints and a
   * bare transformer (Z-Image, Anima, FLUX.2, Krea 2) in
   * models/diffusion_models — ComfyUI loads them with different nodes, and the
   * folder is the only thing that says which. Grouping by folder makes that
   * visible without asking anyone to keep two dropdowns in their head. */
  const GROUPS = [
    ["checkpoints", "Checkpoints · models/checkpoints"],
    ["diffusion_models", "Diffusion models · models/diffusion_models"],
    ["unet", "Diffusion models · models/unet"],
  ];
  const groups = GROUPS
    .map(([folder, label]) => [label, list.filter((c) => (c.folder || "checkpoints") === folder)])
    .filter(([, rows]) => rows.length);
  if (groups.length > 1) {
    return groups.map(([label, rows]) =>
      `<optgroup label="${esc(label)}">${options(rows)}</optgroup>`).join("");
  }
  return options(list);

  function options(rows) {
    return rows.map((c) => {
    /* For a classic UNet the VARIANT is the name a person knows it by ("SDXL",
     * "SD1.5") and the family is just "unet". For a DiT it is the other way
     * round: "anima" and "zimage" are the names, and the variant is internals
     * like "dim 3840, layers 30", which belongs in the tooltip. */
    const what = c.family === "unet" ? (c.variant || "UNet") : (c.family || c.variant || "");
    const bits = [what, c.dtype || "", c.bytes ? gb(c.bytes) : "", c.at ? `added ${when(c.at)}` : ""].filter(Boolean).join("  ·  ");
    const label = c.loadable === false ? `${c.name}  —  ${what || "not loadable"} (cannot be loaded from this folder)` : `${c.name}${bits ? "  ·  " + bits : ""}`;
    return `<option value="${esc(c.name)}"${c.name === selected ? " selected" : ""}`
      + `${c.loadable === false ? " disabled" : ""} title="${esc(c.why || bits)}">${esc(label)}</option>`;
    }).join("");
  }
}

$("imgGo").onclick = async () => {
  const prompt = $("imgPrompt").value.trim();
  if (!prompt) { $("imgPrompt").focus(); return; }
  const [w, h] = $("imgSize").value === "custom"
    ? [Number($("imgW").value) || 1024, Number($("imgH").value) || 1024]
    : $("imgSize").value.split("x").map(Number);
  const seedRaw = $("imgSeed").value.trim();
  const btn = $("imgGo");
  btn.disabled = true;
  btn.textContent = "Queued…";
  try {
    const r = await (await fetch("/api/image", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create", prompt,
        engine: $("imgEngine").value,
        /* Sent WHATEVER the engine is, on purpose. Gating this on flux2 here
         * meant that picking Ideogram after choosing references dropped them
         * without a word — the user's own input, discarded by the client. The
         * server already refuses references on ideogram4/checkpoint with a
         * sentence that explains why; letting that refusal happen is one rule
         * in one place, and the alert below shows the server's own words. */
        ...(imgRefs.length ? { refImages: imgRefs.map((m) => m.name) } : {}),
        ...($("imgEngine").value === "ideogram4" ? { quality: $("imgQuality").value } : {}),
        ...($("imgEngine").value === "anima" ? { dit: $("imgDit").value } : {}),
        ...($("imgPersona").value ? { persona: $("imgPersona").value } : {}),
        ...($("imgEngine").value === "checkpoint" ? {
          checkpoint: $("imgCkpt").value,
          /* What the picked file is, and the halves that run it. "auto" is the
           * detected family and its own encoder and VAE — sent as-is so one
           * rule decides on the server rather than two. */
          ...($("imgDitKindW").hidden ? {} : {
            ditEngine: $("imgDitKind").value,
            encoder: $("imgEncoder").value,
            vae: $("imgVae").value,
          }),
          negative: $("imgNeg").value.trim(),
          cfg: Number($("imgCfg").value) || 6,
          /* The SD-family dials. Sent only on the engine that can use them —
           * the server refuses them elsewhere, and sending anyway would earn a
           * refusal for a control the screen never showed. */
          ...(Number($("imgClipSkip").value) > 1 ? { clipSkip: Number($("imgClipSkip").value) } : {}),
          ...($("imgSampler").value ? { sampler: $("imgSampler").value } : {}),
          ...($("imgSched").value ? { scheduler: $("imgSched").value } : {}),
          ...(imgLoraStack.length ? { loras: imgLoraStack.map((l) => ({ name: l.name, strength: l.strength })) } : {}),
        } : {}),
        /* Anima samples with whatever pair is chosen (er_sde / simple unless changed). */
        ...($("imgEngine").value === "anima" && $("imgSampler").value ? { sampler: $("imgSampler").value, scheduler: $("imgSched").value } : {}),
        /* Z-Image base only. Sending these on TURBO would be sending fields
         * the model cannot use, and the server refuses a negative there rather
         * than ignoring it — IMG_ENGINES[eng].negative is where that rule
         * lives on this side. */
        ...($("imgEngine").value === "zimage-base" ? {
          negative: $("imgNeg").value.trim(),
          cfg: Number($("imgCfg").value) || 4,
        } : {}),
        count: Number($("imgCount").value) || 1,
        width: w, height: h,
        steps: Number($("imgSteps").value) || 4,
        // Blank means "roll one", and the roll is RECORDED on the result, so a
        // picture you liked can still be varied afterwards.
        ...(seedRaw === "" ? {} : { seed: Number(seedRaw) }),
      }),
    })).json();
    if (r.error) { imgWatch(null); await appAlert(r.error, "Nothing was queued"); return; }
    $("imgNote").textContent = "Queued. It renders when nothing else is using the GPU.";
    /* The job this screen is now watching — the strip above reads it, and the ✕
     * needs the file name to drop it while it is still only waiting. */
    imgWatch(`image:${r.id}`);
    imgGraceTicks = 0;
    // Poll until the count changes — the art queue has no push channel of its own.
    const before = (state.images || []).length;
    for (let i = 0; i < 300; i++) {
      await new Promise((res) => setTimeout(res, 1500));
      /* The strip is painted from here as well as from the 4-second poll and
       * the live socket: while a person is standing in front of a render they
       * have just asked for, once every second and a half is the right rate to
       * tell them what it is doing. */
      await imgPaintFromServer();
      await loadImages();
      if ((state.images || []).length > before) {
        $("imgNote").textContent = "Done.";
        imgWatch(null);
        break;
      }
      /* ⚠ THE JOB IS OFF THE QUEUE BUT THE PICTURE IS NOT ON THE SCREEN YET.
       *
       * Leaving the loop the moment the lane reports the job finished is what
       * made a fresh picture invisible until something else forced a reload —
       * the grid's last read happened BEFORE the file was written, so the
       * Images tab stayed empty and the only way to see the render was to open
       * it from the Jobs list, which navigates back here and repaints on the
       * way. The file lands within a tick or two of the event, so keep reading
       * for a few more rather than stopping on the first sight of "done". */
      if (!imgWaiting && ++imgGraceTicks > 4) break;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Make image";
  }
};

/* ── the render strip ──────────────────────────────────────────────────────
 *
 * WHAT A RENDER WAS DOING was unknowable from this screen. It said "Queued."
 * the moment the POST returned and then nothing, for all four of the states a
 * picture actually passes through — waiting for ComfyUI to answer at all,
 * waiting behind a song, loading several gigabytes of weights, and sampling —
 * and there was no way to stop one that had stopped moving. A screen that
 * cannot say which of those is happening cannot be debugged by the person
 * looking at it, which is how "it silently fails" became the whole report.
 *
 * Everything here is read from the server's own status; nothing is inferred
 * from how long the button has been grey.
 */
let imgWaiting = null;              // the file: of the render this screen asked for
let imgFailed = null;               // why the last one died, kept on screen until the next
let imgGraceTicks = 0;              // reads of the grid AFTER the lane says it finished

function imgWatch(file) {
  imgWaiting = file;
  if (file) imgFailed = null;       // a new attempt clears the old verdict
  if (!file) paintImgProgress(state.lastStatus || {});
}

/**
 * A PICTURE FINISHED SOMEWHERE — put it on the screen.
 *
 * The grid was only ever re-read by the loop belonging to the button that
 * started a render, so a picture that finished any other way — an agent over
 * MCP, an overnight run, a render whose loop had already given up — did not
 * appear until something else reloaded the tab. The art lane already announces
 * every finished job on the live socket; this watches that announcement and
 * reloads once, and only while the Images screen is the one being looked at.
 */
let imgLastDone = null;
function imgSeeFinished(s) {
  const top = (s?.art?.recent || [])[0];
  const mark = top ? `${top.file}@${top.at || ""}` : null;
  if (!mark || mark === imgLastDone) return;
  const first = imgLastDone === null;
  imgLastDone = mark;
  // Not on the first frame after a reload: that one is history, not news.
  if (first || top.error || top.kind !== "cover") return;
  if (state.view === "images") loadImages();
}

/** One fetch, one paint — used by the create loop while a render is in flight. */
async function imgPaintFromServer() {
  try {
    const s = await (await fetch("/api/status")).json();
    state.lastStatus = s;
    paintImgProgress(s);
  } catch { /* the server is restarting; the next tick will say so */ }
}

function paintImgProgress(s) {
  const box = $("imgProg");
  if (!box) return;
  const art = s?.art || {};
  const cur = art.current || null;
  /* DID IT ALREADY FINISH — and how? The lane keeps every job it completed,
   * with the error if it threw. Without this the strip would go on saying
   * "Queued" after a render had died, which is the exact failure being fixed:
   * the screen must never outlive the truth. */
  if (imgWaiting) {
    const done = (art.recent || []).find((r) => r.file === imgWaiting);
    if (done) {
      imgFailed = done.error || null;
      imgWaiting = null;
      if (imgFailed) $("imgNote").textContent = "That render failed.";
    }
  }
  const ours = !!imgWaiting;
  const mine = ours && cur && cur.file === imgWaiting;
  /* A picture someone else's screen queued still belongs on this bar — it is
   * the same GPU and the same lane, and "something is rendering" is the answer
   * to "why is mine not starting". */
  const showing = ours || imgFailed || (cur && cur.kind === "cover");
  if (!showing) { box.hidden = true; return; }
  box.hidden = false;

  if (!ours && imgFailed) {
    $("imgProgWhat").textContent = "The render failed";
    $("imgProgPct").textContent = "";
    $("imgProgWhy").textContent = imgFailed;
    const f = $("imgProgBar");
    f.classList.remove("sweep");
    f.style.width = "0%";
    $("imgProgStop").hidden = true;
    return;
  }

  const ready = s?.engine ? !!s.engine.ready : state.engineReady !== false;
  const pct = Math.round((Number(cur?.progress) || 0) * 100);
  const el = Number(cur?.elapsed) || 0;
  let what = "Queued";
  let why = "";
  let bar = -1;                     // -1 paints the indeterminate sweep

  if (!ready) {
    what = "Waiting for the engine";
    why = "ComfyUI has not answered yet. It starts with Studio and a cold start takes a minute or two — the Engine screen says where it is.";
  } else if (art.paused) {
    what = "Paused";
    why = "The render queue is paused. Nothing will start until it is resumed.";
  } else if (mine || (cur && !ours)) {
    if (pct > 0) {
      what = mine ? "Rendering your picture" : `Rendering · ${cur.title || cur.kind}`;
      bar = pct;
      const left = pct > 2 && el > 5 ? Math.max(0, Math.round(el / (pct / 100) - el)) : 0;
      why = left ? `${el}s so far, about ${left}s left.` : `${el}s so far.`;
    } else {
      what = "Loading the model";
      why = `Reading the weights into the card — several gigabytes the first time, and nothing reports progress until sampling starts. ${el}s so far.`;
    }
  } else if (ours) {
    /* Our own position, not the queue's size: three jobs waiting with ours
     * first is "next", and saying "3 ahead" there would be a made-up wait. */
    const pos = (art.items || []).findIndex((i) => i.file === imgWaiting);
    const ahead = pos > 0 ? pos : 0;
    what = ahead ? `Queued · ${ahead} ahead` : "Queued · next";
    why = s?.current
      ? "Music is generating. Pictures wait for it so a song never waits for a picture."
      : "Waiting for the GPU to come free.";
  }

  $("imgProgWhat").textContent = what;
  $("imgProgPct").textContent = bar >= 0 ? `${bar}%` : "";
  $("imgProgWhy").textContent = why;
  const fill = $("imgProgBar");
  fill.classList.toggle("sweep", bar < 0);
  fill.style.width = bar < 0 ? "100%" : `${bar}%`;
  /* Only offer to stop what can be stopped: with nothing of ours in the lane
   * the ✕ would be a button that does nothing to somebody else's render. */
  $("imgProgStop").hidden = !ours;
}

/* The ✕. Two different jobs depending on where the render has got to: one that
 * is RUNNING is interrupted at the engine, one that is only waiting is dropped
 * from the queue before it ever gets there. */
$("imgProgStop").onclick = async () => {
  const file = imgWaiting;
  if (!file) return;
  const cur = state.lastStatus?.art?.current;
  const running = cur && cur.file === file;
  $("imgProgStop").disabled = true;
  try {
    const r = await (await fetch("/api/artqueue", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(running ? { action: "stop_current" } : { action: "drop", file }),
    })).json();
    imgWatch(null);
    $("imgNote").textContent = r.error
      ? r.error
      : running ? "Stopped." : "Dropped from the queue.";
  } catch {
    $("imgNote").textContent = "Could not reach the server to stop it.";
  } finally {
    $("imgProgStop").disabled = false;
  }
};

$("imgGrid").addEventListener("load", (e) => {
  if (e.target.tagName === "IMG") imgTileAspect(e.target);
}, true);

$("imgGrid").addEventListener("click", async (e) => {
  /* The model link is INSIDE the tile, and the tile opens the editor. Let the
   * anchor be an anchor: without this, clicking it would both follow the link
   * and open the editor behind it. */
  if (e.target.closest("a[data-modellink]")) return;
  const open = e.target.closest("[data-imgopen]");
  if (open) {
    // a blurred tile reveals on the first click; the editor is the second
    if (open.classList.contains("blurred") && !open.classList.contains("revealed")) {
      open.classList.add("revealed");
      return;
    }
    openImageEditor(open.dataset.imgopen);
    return;
  }
  const reuse = e.target.closest("[data-imgreuse]");
  const reveal = e.target.closest("[data-imgreveal]");
  const trash = e.target.closest("[data-imgtrash]");
  if (reuse) {
    const im = (state.images || []).find((x) => x.name === reuse.dataset.imgreuse);
    const m = im?.meta; if (!m) return;
    $("imgPrompt").value = m.prompt || "";
    if (m.seed != null) $("imgSeed").value = m.seed;
    $("imgPrompt").focus();
    return;
  }
  if (reveal) {
    fetch("/api/reveal", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: reveal.dataset.imgreveal }) }).catch(() => {});
    return;
  }
  if (trash) {
    const name = trash.dataset.imgtrash;
    if (!(await appConfirm(`Move ${name} to trash? It stays on disk in output/trash.`))) return;
    const r = await (await fetch("/api/images", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "trash", name }) })).json();
    if (r.error) { alert(r.error); return; }
    loadImages();
  }
});

const VIEWS = {
  create:    ["rows", "stagehead", "nowBox"],
  images:    ["imagesview"],
  video:     ["videoclips"],
  overnight: ["overnight"],
  community: ["community"],
  models:    ["models"],
  settings:  ["settings"],
  reactive:  ["reactive"],
  training:  ["training"],
  thanks:    ["thanks"],
  mcp:       ["mcp"],
  about:     ["about"],
};

/* The Agent page (cloud models, MCP config, tool list) lives in web/agent.js,
 * which fills itself when told the view opened. */
function loadMcp() {
  document.dispatchEvent(new CustomEvent("aiplay:agent-open"));
}

/**
 * The Thanks page's model table, built from the LIVE catalogue.
 *
 * Typed out by hand it would be correct on the day it was written and wrong
 * from the next model onwards — and a licence table that has drifted is worse
 * than no table, because it is believed. `/api/models` already carries the
 * licence and the territorial restriction for every capability, so this reads
 * the same source the download screen does.
 */
async function loadThanks() {
  const box = $("thanksModels");
  if (!box || box.dataset.loaded) return;
  let caps = null;
  // ⚠ `capabilities`, not `models` — the route is named for what you do on it,
  // not for what it returns.
  try { caps = (await (await fetch("/api/models")).json()).capabilities; } catch { /* offline */ }
  if (!caps?.length) {
    box.textContent = "Could not read the model catalogue — see the NOTICE file in the repository.";
    return;
  }
  box.dataset.loaded = "1";
  rightsCatalogCache = Object.fromEntries(caps.map((c) => [c.id, c]));
  box.innerHTML = caps.map((c) => {
    const { name, note } = licenceParts(c.licence);
    return `
    <div class="thanksrow">
      <b>${c.home
        ? `<a href="${esc(c.home)}" target="_blank" rel="noopener">${esc(c.label)}</a>`
        : esc(c.label)}</b>
      <span class="lic">${esc(name)}</span>
      ${c.outputRights?.publisher?.support
        ? `<a class="support" href="${esc(c.outputRights.publisher.support)}" target="_blank" rel="noopener">support the authors</a>` : ""}
      ${note ? `<p class="licnote">${esc(note)}</p>` : ""}
      <span class="why">${esc(c.why || "")}</span>
      ${/* The rights answer next to the licence NAME, because the name is what
           people mis-read: "non-commercial" is a fact about the weights and
           almost never about the picture. Same chip as the image editor's, same
           source, same quote one click away. */
        c.outputRights
          ? rightsChipHtml({ class: c.outputRights.class, capability: c.id, url: c.outputRights.url }, c)
          : ""}
      ${c.region ? `<span class="warn">⚠ Licensed only outside ${esc((c.region.excluded || []).join(", "))}.</span>` : ""}
    </div>`;
  }).join("");
}

/**
 * A licence field is a NAME and, on the entries that need one, an explanation.
 *
 * The catalogue writes both into one string — `"Ideogram Non-Commercial Model
 * Agreement — the licence NAME, from the repo's own metadata. The agreement
 * text is gated (HTTP 401…)"`, 365 characters of it — and this page put the
 * whole thing inside the pill beside the model's name. A pill is a shape that
 * promises two or three words; four sentences in one came out as a tall grey
 * ribbon of text a few words wide, which is how a reader learns to skip the
 * column that carries the licence.
 *
 * So the pill keeps the name and the sentences move to their own line under it,
 * where prose belongs. Nothing is dropped — on a page whose whole argument is
 * that the terms are shown before anything is downloaded, shortening a licence
 * would be the one unacceptable fix. The split is the catalogue's own
 * punctuation, and a short licence ("MIT", "Apache-2.0") is left alone.
 */
export function licenceParts(licence) {
  const s = String(licence || "").trim() || "see publisher";
  const cut = s.indexOf(" — ");
  if (s.length <= 46 || cut < 0) return { name: s, note: "" };
  return { name: s.slice(0, cut).trim(), note: s.slice(cut + 3).trim() };
}

/**
 * The About page's rights list — the same catalogue, the same chips, said
 * where the promise is made.
 *
 * A hand-typed version of this paragraph would be right on the day it was
 * written and wrong from the next model onwards, and a rights claim that has
 * drifted is worse than none because it is believed. So the prose in
 * index.html states the PRINCIPLE and this fills in the per-model answers live.
 */
/**
 * THE REPORT: objective -> agent -> MCP -> execution.
 *
 * The About page has claimed for a while that an AI built the VFX shots over
 * MCP, and backed it with three hand-typed tool-call counts whose source comps
 * are not on this machine. That is an assertion, not a record — and this app
 * spends the rest of its time refusing to trust exactly that kind of number.
 *
 * Everything here is read live at the moment the page opens: the objective from
 * the project briefs, the actor split from the provenance ledger, the tool
 * surface from the running MCP, and the execution counts from the project
 * documents' own `runs` entries. Nothing is stored, so nothing can go stale.
 *
 * Hidden rather than zeroed on a fresh install: a report of nothing is worse
 * than no report.
 */
async function loadAboutReport() {
  const box = $("aboutReport");
  if (!box || box.dataset.loaded) return;
  const grab = async (u) => { try { return await (await fetch(u)).json(); } catch { return null; } };
  const [projs, prov, mcp] = await Promise.all([
    grab("/api/mv/projects"), grab("/api/provenance"), grab("/api/mcp"),
  ]);

  const rows = (projs && projs.projects) || [];
  const mv = rows.filter((p) => p.kind === "mv");
  let clips = 0, done = 0, timelines = 0, runs = 0, tools = new Set(), briefs = [];
  await Promise.all(mv.map(async (p) => {
    const d = await grab(`/api/mv/project/${encodeURIComponent(p.slug)}`);
    const doc = d && d.project;
    if (!doc) return;
    clips += (doc.clips || []).length;
    done += (doc.clips || []).filter((c) => c.clipFile).length;
    if (doc.timelineProject) timelines += 1;
    for (const r of doc.runs || []) { runs += 1; if (r.tool) tools.add(r.tool); }
    if (doc.brief && doc.brief.directionSummary) briefs.push({ t: doc.title, d: doc.brief.directionSummary });
  }));

  const events = (prov && (prov.events || prov.entries || prov)) || [];
  const actors = {};
  if (Array.isArray(events)) {
    for (const e of events) { const a = e.actor || "unknown"; actors[a] = (actors[a] || 0) + 1; }
  }
  const agentEvents = Object.entries(actors).filter(([a]) => /^agent/.test(a)).reduce((n, [, v]) => n + v, 0);
  const toolCount = (mcp && (mcp.tools || []).length) || 0;

  if (!mv.length && !runs && !toolCount) { box.hidden = true; return; }

  const band = (label, big, sub) =>
    `<div class="repband"><span class="replabel">${esc(label)}</span>` +
    `<b class="repbig">${esc(String(big))}</b>` +
    `<span class="repsub">${sub}</span></div>`;

  $("aboutReportBands").innerHTML = [
    band("Objective", `${mv.length} brief${mv.length === 1 ? "" : "s"}`,
      briefs.length
        ? briefs.slice(0, 3).map((b) => `<i>${esc(b.t)}</i> &mdash; ${esc(b.d.slice(0, 70))}`).join("<br>")
        : "no direction summary recorded yet"),
    band("Agent", agentEvents ? `${agentEvents} agent action${agentEvents === 1 ? "" : "s"}` : "not separated",
      Object.entries(actors).sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([a, n]) => `${esc(a)} ${n}`).join(" &middot; ") || "the ledger records no actors"),
    band("MCP", `${toolCount} tools`,
      tools.size ? `${tools.size} of them actually used in these projects` : "none used yet"),
    band("Execution", `${done} / ${clips} clips`,
      `${runs} recorded tool call${runs === 1 ? "" : "s"} &middot; ${timelines} timeline${timelines === 1 ? "" : "s"} built`),
  ].join("");

  $("aboutReportNote").textContent =
    "Read live when this page opened. The agent count is only what the provenance "
    + "ledger attributes to an agent actor; MV tools do not yet record a caller, so "
    + "the execution row counts the work without claiming who asked for it.";
  box.hidden = false;
  box.dataset.loaded = "1";
}

/**
 * The territory line under that list, from the same payload.
 *
 * index.html states the principle and leaves the LIST to this — it used to
 * type the four names out, and it disagreed with server/models.js the day
 * somebody added the fourth. One list or none: if the region-limited rows do
 * not all name the same territories, no single sentence is true of them and the
 * clause stays hidden rather than picking one. (server/territory_test.js holds
 * the catalogue to that same invariant from the other side.)
 */
function paintAboutTerritory(caps) {
  const clause = $("aboutTerritoryClause"), list = $("aboutTerritory");
  if (!clause || !list) return;
  const lists = [...new Set((caps || [])
    .filter((c) => c.region?.excluded?.length)
    .map((c) => c.region.excluded.join(", ")))];
  if (lists.length !== 1) { clause.hidden = true; return; }
  list.textContent = lists[0];
  clause.hidden = false;
}

/* ── which build, and whether either repository has moved ──────────────────
 * The numbers come from /api/version, which reads them from git or from the
 * stamp in the zip and asks nothing of the network. The button is the only
 * part that talks to GitHub, and its answer is written by the server so the
 * launcher and this page say the same sentence. */
async function loadVersion() {
  let d = null;
  try { d = await (await fetch("/api/version")).json(); } catch { /* server gone */ }
  const v = d?.version;
  if (!v) return;
  $("verLine").textContent = v.line + (v.commit ? ` · ${v.commit}` : "");
  const base = v.base ? `based on ${v.base.line} · ${v.base.commit}`
    : v.fork ? "the same commit as the original" : "";
  $("verBase").textContent = base;
  const notes = [];
  if (v.modified) notes.push("This copy has edits that are not in any commit.");
  if (v.base?.staleStamp) notes.push("Its recorded base is out of date (run scripts/stamp-lineage.mjs).");
  if (v.source === "unknown") notes.push("This build carries no commit, so it can only name its lineage.");
  notes.push(`Collab protocol ${v.protocol}: what decides whether a friend's file opens here, and it moves only when that format changes.`);
  $("verWhat").textContent = notes.join(" ");
  if (d.says) $("verSays").textContent = d.says;
  state.collabProtocol = v.protocol;                 // what a friend's row compares against
  const ver = $("homeVer");
  if (ver) {
    ver.textContent = [v.line, v.commit, base && base.replace("based on ", "on ")].filter(Boolean).join(" · ");
    ver.hidden = false;
  }
}
$("verCheck").onclick = async () => {
  const b = $("verCheck"), say = $("verSays");
  b.disabled = true;
  say.textContent = "Asking GitHub…";
  try {
    const r = await (await fetch("/api/version", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "check" }) })).json();
    say.textContent = r.says || "Nothing to report.";
  } catch (err) { say.textContent = `Could not ask: ${err.message}`; }
  b.disabled = false;
};

async function loadAboutRights() {
  const box = $("aboutRights");
  if (!box || box.dataset.loaded) return;
  let caps = null;
  try { caps = (await (await fetch("/api/models")).json()).capabilities; } catch { /* offline */ }
  if (!caps?.length) { box.hidden = true; return; }
  box.dataset.loaded = "1";
  paintAboutTerritory(caps);
  rightsCatalogCache = Object.fromEntries(caps.map((c) => [c.id, c]));
  box.innerHTML = caps.filter((c) => c.outputRights).map((c) => `
    <div class="rightsrow">
      <b>${esc(c.label)}</b>
      ${rightsChipHtml({ class: c.outputRights.class, capability: c.id, url: c.outputRights.url }, c)}
    </div>`).join("");
}
/* ── Reactive ───────────────────────────────────────────────────────────────
 *
 * Pictures that move with a song, on the Studio's OWN compositor. The page
 * gathers a song, pictures (picked, or made from a prompt), a look and a cut,
 * posts /api/reactive/run, and then watches the comp's render row until the
 * movie lands in the clips library. The comp itself opens on the VFX screen,
 * so "more control" is the whole compositor rather than a second form.
 */
let reactPicked = [];
let reactStyle = "cuts";
let reactStyles = {};

async function loadReactive() {
  const songs = (state.library || []).filter((t) => /\.(flac|mp3|opus|wav)$/i.test(t.file));
  const cur = $("reactSong").value;
  $("reactSong").innerHTML = songs.length
    ? songs.map((t) => `<option value="${esc(t.file)}">${esc(t.title || t.file)}</option>`).join("")
    : '<option value="">Render a song first — its beat is what drives this</option>';
  if (cur) $("reactSong").value = cur;
  /* The Images library is loaded by its own screen; this one may open first. */
  if (!(state.images || []).length) {
    try { state.images = (await (await fetch("/api/images")).json()).images || []; } catch { /* the grid stays empty */ }
  }
  $("reactImgs").innerHTML = (state.images || []).map((im) => `
    <button type="button" class="reactimg" data-rimg="${esc(im.name)}" title="${esc(im.name)}">
      <img src="/api/image/${encodeURIComponent(im.name)}" alt="" loading="lazy"></button>`).join("");
  /* The clips library, newest first: a clip in a slot plays in sync with the song. */
  try {
    const clips = ((await (await fetch("/api/clips")).json()).clips || []).filter((c) => /\.(mp4|webm|mov|mkv|m4v)$/i.test(c.name || ""));
    $("reactClips").innerHTML = clips.slice(0, 48).map((c) => `
      <button type="button" class="reactimg" data-rimg="${esc(c.name)}" title="${esc(c.name)}">
        <video src="/api/clip/${encodeURIComponent(c.name)}#t=0.5" preload="metadata" muted playsinline></video></button>`).join("");
  } catch { $("reactClips").innerHTML = ""; }
  if (!Object.keys(reactStyles).length) {
    let reactStatus = {};
    try { reactStatus = await (await fetch("/api/reactive/status")).json(); } catch { reactStatus = {}; }
    reactStyles = reactStatus.styles || {};
    /* The Motion look's bring-your-own selects: whatever the engine's own
     * folders hold, by name — nothing shipped, so an empty folder is an
     * empty list and the shipped choice stays. */
    const fillOwn = (id, names, first) => {
      const el = $(id); if (!el) return;
      const keep = el.value;
      el.innerHTML = `<option value="">${first}</option>` + (names || []).map((n) => `<option value="${String(n).replace(/"/g, "&quot;")}">${String(n).replace(/</g, "&lt;")}</option>`).join("");
      if ([...el.options].some((o) => o.value === keep)) el.value = keep;
    };
    const own = reactStatus.motion || {};
    fillOwn("reactMotionModel", (own.motionModels || []).filter((n) => n !== "v3_sd15_mm.ckpt"), "v3 (shipped)");
    fillOwn("reactMotionLora", own.motionLoras, "none");
    fillOwn("reactModelLora", own.loras, "none");
    fillOwn("reactMotionSampler", (own.samplers || []).filter((n) => n !== "dpmpp_2m"), "dpmpp_2m");
    fillOwn("reactMotionScheduler", (own.schedulers || []).filter((n) => n !== "karras"), "karras");
    $("reactStyles").innerHTML = Object.entries(reactStyles).map(([id, s]) =>
      `<button class="edtool${id === reactStyle ? " on" : ""}" type="button" data-style="${esc(id)}" title="${esc(s.note)}">${esc(s.label)}</button>`).join("");
    reactSetStyle(reactStyle);
  }
  reactPaintPicked();
}

function reactSetStyle(id) {
  reactStyle = id;
  for (const b of $("reactStyles").querySelectorAll("[data-style]")) b.classList.toggle("on", b.dataset.style === id);
  $("reactStyleHint").textContent = reactStyles[id]?.note || "";
  if ($("reactPaintDials")) $("reactPaintDials").hidden = id !== "paint";
  if ($("reactMotionDials")) $("reactMotionDials").hidden = id !== "motion";
}
$("reactStyles")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-style]");
  if (b) reactSetStyle(b.dataset.style);
});

function reactPaintPicked() {
  $("reactPicked").textContent = reactPicked.length ? `${reactPicked.length} picked` : "none picked";
  for (const b of document.querySelectorAll("#reactImgs [data-rimg], #reactClips [data-rimg]")) {
    const i = reactPicked.indexOf(b.dataset.rimg);
    b.classList.toggle("on", i >= 0);
    b.dataset.order = i >= 0 ? String(i + 1) : "";
  }
}
for (const gridId of ["reactImgs", "reactClips"]) {
  $(gridId)?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-rimg]");
    if (!b) return;
    const name = b.dataset.rimg;
    reactPicked = reactPicked.includes(name) ? reactPicked.filter((x) => x !== name) : [...reactPicked, name];
    reactPaintPicked();
  });
}

/* Watch one render row on the comp until it is done or failed. */
async function reactWatch(slug, jobId) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    let j;
    try { j = await (await fetch(`/api/vfx/comp/${encodeURIComponent(slug)}`)).json(); } catch { continue; }
    const row = (j.renders || []).find((r) => r.id === jobId) || (j.renders || [])[0];
    if (!row) continue;
    $("reactProg").hidden = false;
    $("reactProg").value = Math.round((row.progress || 0) * 100);
    if (row.status === "failed") throw new Error(row.error || "the render failed");
    if (row.status === "done") return row;
  }
}

$("reactGo")?.addEventListener("click", async () => {
  const note = $("reactNote"), out = $("reactOut");
  out.hidden = true; out.innerHTML = "";
  $("reactProg").hidden = true;
  const song = $("reactSong").value;
  if (!song) { note.textContent = "Render a song first; its beat is what drives this."; return; }
  const prompt = $("reactPrompt").value.trim();
  if (!reactPicked.length && !prompt) { note.textContent = "Pick some pictures, or give a prompt to make them from."; return; }
  const secs = Number($("reactSecs").value);
  const paint = reactStyle === "paint" ? {
    denoiseMin: Number($("reactPaintDenoise").value), denoiseRange: Number($("reactPaintRange").value),
    source: Number($("reactPaintSource").value), colour: Number($("reactPaintColour").value),
    fps: Number($("reactPaintFps").value), seed: Number($("reactPaintSeed").value),
  } : undefined;
  /* A dial left where the page loaded it is NOT sent: the recipe then picks
   * the default for the case — the reference's holds when pictures carry the
   * look, the painted ones when a prompt does. A dial you moved is sent as is. */
  const moved = (id) => { const el = $(id); return el.value === el.defaultValue || el.value === "" ? undefined : Number(el.value); };
  const flipped = (id) => { const el = $(id); return el.checked === el.defaultChecked ? undefined : el.checked; };
  const motion = reactStyle === "motion" ? {
    looks: $("reactMotionLooks").value.split("\n").map((s) => s.trim()).filter(Boolean),
    depth: moved("reactMotionDepth"), lineart: moved("reactMotionLine"),
    depthEnd: moved("reactMotionDepthEnd"), lineartEnd: moved("reactMotionLineEnd"),
    motionScale: moved("reactMotionScale"), iris: moved("reactMotionIris"), hintLift: moved("reactMotionHintLift"),
    sourceHold: moved("reactMotionSourceHold"), sourceHoldEnd: moved("reactMotionSourceHoldEnd"),
    cfg: moved("reactMotionCfg"), seed: Number($("reactMotionSeed").value),
    ipWeight: moved("reactMotionIpWeight"), transition: moved("reactMotionTransition"),
    hires: flipped("reactMotionHires"), hiresDenoise: moved("reactMotionHiresDenoise"), smooth: flipped("reactMotionSmooth"),
    hitsOn: $("reactMotionHitsOn").value === "bars" ? "bars" : undefined, hitGap: moved("reactMotionHitGap"),
    motionModel: $("reactMotionModel").value || undefined, motionLora: $("reactMotionLora").value || undefined, motionLoraStrength: moved("reactMotionLoraStrength"),
    modelLora: $("reactModelLora").value || undefined, modelLoraStrength: moved("reactModelLoraStrength"),
    sampler: $("reactMotionSampler").value || undefined, scheduler: $("reactMotionScheduler").value || undefined,
  } : undefined;
  if ((paint || motion) && !reactPicked.some((n) => /\.(mp4|webm|mov|mkv|m4v)$/i.test(n))) { note.textContent = `The ${paint ? "Paint" : "Motion"} look repaints a clip: pick one in the Clips grid.`; return; }
  $("reactGo").disabled = true;
  note.textContent = paint
    ? `Repainting the clip frame by frame${Number.isFinite(secs) && secs > 0 ? ` — about ${Math.ceil(secs * paint.fps * 7.5 / 60)} minutes` : ""}, then the comp…`
    : motion
      ? `Rendering the clip under the motion module${Number.isFinite(secs) && secs > 0 ? ` — about ${Math.ceil(secs * 12 * ($("reactMotionHires").checked ? 7 : 3.4) / 60)} minutes` : ""}, then the comp…`
      : reactPicked.length ? "Analysing the song and building the comp…" : "Making the pictures, then the comp…";
  try {
    const r = await (await fetch("/api/reactive/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        song, pictures: reactPicked, prompt: reactPicked.length ? undefined : prompt,
        count: Number($("reactCount").value) || 6,
        style: reactStyle, cut: $("reactCut").value, hits: $("reactHits").value,
        seconds: Number.isFinite(secs) && secs > 0 ? secs : undefined,
        start: Number($("reactStart").value) > 0 ? Number($("reactStart").value) : undefined,
        paint, motion,
        orientation: $("reactOrient").value,
      }),
    })).json();
    if (r.error) { note.textContent = r.error; return; }
    note.textContent = `${r.cuts} cuts over ${Math.round(r.seconds)} s at ${r.bpm ? Math.round(r.bpm) + " bpm" : "the song's tempo"} — rendering "${r.name}"…`;
    const row = await reactWatch(r.slug, r.jobId);
    note.textContent = `Done — ${row.clip}. The comp "${r.name}" is on the VFX screen if you want to keep editing.`;
    out.innerHTML = `<video controls playsinline src="/api/clip/${encodeURIComponent(row.clip)}"></video>`;
    out.hidden = false;
    if (typeof loadClips === "function") loadClips();
  } catch (err) {
    note.textContent = String(err.message || err);
  } finally {
    $("reactGo").disabled = false;
    $("reactProg").hidden = true;
  }
});

/* ── API mode ───────────────────────────────────────────────────────────────
 *
 * The key is WRITE-ONLY from here. It is posted once and never read back — the
 * server returns only whether one is set, how it is protected, and its last four
 * characters. This page is a web page: anything it holds is one screenshot or
 * one bad extension away from being somewhere else, and it does not need the key
 * to do its job.
 */
/* ── Custom ComfyUI workflows ───────────────────────────────────────────────
 *
 * Broken graphs are LISTED, with what is wrong with them. A file that simply
 * fails to appear is indistinguishable from one Studio never saw, and the most
 * common mistake here — saving the editor document instead of the API format —
 * produces a perfectly valid JSON file that cannot be executed. Silence would
 * send people hunting in the wrong place.
 */
async function loadWorkflows() {
  let d = null;
  try { d = await (await fetch("/api/workflows")).json(); } catch { return; }
  state.workflows = d;

  $("wfDir").textContent = d.dir;
  const ok = d.workflows.filter((w) => w.ok);
  const bad = d.workflows.filter((w) => !w.ok);
  $("wfCount").textContent = d.workflows.length
    ? `${ok.length} usable${bad.length ? `, ${bad.length} with problems` : ""}`
    : "none found";

  const KIND_LABEL = { cover: "cover art", video: "video clips" };
  $("wfPicks").innerHTML = d.kinds.map((k) => `
    <label for="wf_${k}">${esc(KIND_LABEL[k] || k)}</label>
    <span class="pv"><select id="wf_${k}" class="sel2 sm" data-kind="${k}">
      <option value="">Studio's built-in graph</option>
      ${ok.map((w) => `<option value="${esc(w.id)}"${d.assigned[k] === w.id ? " selected" : ""}>${esc(w.id)}</option>`).join("")}
    </select></span>`).join("");

  for (const sel of $("wfPicks").querySelectorAll("select")) {
    sel.onchange = async () => {
      const r = await (await fetch("/api/workflows", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "assign", kind: sel.dataset.kind, workflow: sel.value || null }),
      })).json();
      if (r.error) { alert(r.error); }
      loadWorkflows();
    };
  }

  $("wfList").innerHTML = d.workflows.map((w) => {
    if (!w.ok) {
      return `<p class="hint warnhint"><b>${esc(w.id)}</b> — ${esc(w.problem || "unusable")}</p>`;
    }
    const warn = (w.warnings || []).length
      ? `<span class="wfwarn">${w.warnings.map((x) => esc(x)).join(" ")}</span>` : "";
    return `<p class="hint"><b>${esc(w.id)}</b> — ${w.nodes} nodes, uses `
      + `${w.tokens.length ? w.tokens.map((t) => `<code>${esc(t)}</code>`).join(" ") : "no placeholders"}. ${warn}</p>`;
  }).join("");

  $("wfTokens").innerHTML = Object.entries(d.tokens)
    .map(([t, why]) => `<p class="hint"><code>${esc(t)}</code> — ${esc(why)}</p>`).join("");
}

async function loadArtPrefs() {
  try {
    const d = await (await fetch("/api/artconfig")).json();
    $("artEngine").value = d.engine || "flux2";
    $("artQuality").value = d.quality || "default";
    $("artStyle").value = d.style || "";
    $("artStyle").dataset.def = d.styleDefault || "";
    const ck = await (await fetch("/api/checkpoints")).json();
    $("artCkpt").innerHTML = ckptOptions(ck.checkpoints || [], d.checkpoint)
      || '<option value="">nothing in models/checkpoints or models/diffusion_models</option>';
    artEngineShape();
  } catch { /* settings page still opens */ }
}
function artEngineShape() {
  const eng = $("artEngine").value;
  for (const id of ["artCkptL", "artCkptW"]) $(id).hidden = eng !== "checkpoint";
  for (const id of ["artQualityL", "artQualityW"]) $(id).hidden = eng !== "ideogram4";
}
$("artEngine").onchange = artEngineShape;
$("artReset").onclick = () => { $("artStyle").value = $("artStyle").dataset.def || ""; };
$("artSave").onclick = async () => {
  $("artSaved").textContent = "";
  const body = { engine: $("artEngine").value, quality: $("artQuality").value, style: $("artStyle").value };
  if (body.engine === "checkpoint") body.checkpoint = $("artCkpt").value || null;
  const r = await (await fetch("/api/artconfig", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })).json();
  $("artSaved").textContent = r.error ? `✕ ${r.error}` : "✓ applied — next cover uses this";
};

async function loadApiMode() {
  let d = null;
  try { d = await (await fetch("/api/apimode")).json(); } catch { return; }
  state.apiMode = d;
  applyApiConstraints();
  if (state.musicModels?.length) { paintMusicModelSelect($("musicEngine")); paintMusicPill(); }

  $("apiEnabled").checked = !!d.enabled;
  $("apiBody").hidden = !d.enabled;
  $("apiState").textContent = d.enabled ? "on — renders are billed to you" : "off — renders use your GPU";

  const sel = $("apiProvider");
  if (sel.options.length !== Object.keys(d.providers).length) {
    /* Unverified adapters are LABELLED IN THE LIST, not just in a note below it
     * — the note only appears after you have already picked one, which is the
     * wrong side of the decision. */
    sel.innerHTML = Object.entries(d.providers)
      .map(([k, p]) => `<option value="${esc(k)}">${esc(p.label)}${p.verified ? "" : " — untested, may not work"}</option>`).join("");
  }
  sel.value = d.provider;

  const prov = d.providers[d.provider] || {};
  const key = d.keys?.[d.provider] || {};
  $("apiCap").value = d.spend?.capUsd ?? 20;

  /* Say which adapter has actually been exercised. "We wrote it" and "we watched
   * it work" are different claims and conflating them is how someone loses an
   * evening to a wrong endpoint. */
  $("apiProvNote").innerHTML = prov.verified
    ? `Billed at $${prov.usdPerSecond}/second of audio — about $${(prov.usdPerSecond * 180).toFixed(2)} for a three-minute song. `
      + `<a href="${esc(prov.signup)}" target="_blank" rel="noopener">Get a key ↗</a>`
    : `⚠ This adapter is written from the provider's documentation but has not been run against a live key here. `
      + `If it fails, the local engine and the other provider are unaffected. `
      + `<a href="${esc(prov.signup)}" target="_blank" rel="noopener">Provider ↗</a>`;

  if (!key.set) {
    $("apiKeyState").textContent = prov.keyHelp
      ? `No key saved. ${prov.keyHelp}` : "No key saved.";
  } else if (!key.usable) {
    $("apiKeyState").innerHTML = `<b>A key is saved but cannot be read on this machine.</b> `
      + `That is the encryption doing its job — it is tied to your Windows account and this PC, `
      + `so a copied or restored file will not open. Paste it again.`;
  } else {
    $("apiKeyState").innerHTML = `Key ${esc(key.hint || "")} saved. ${esc(key.protection || "")}`;
  }

  const sp = d.spend || {};
  $("apiMeter").hidden = !d.enabled;
  const pct = sp.capUsd ? Math.min(100, (sp.spentUsd / sp.capUsd) * 100) : 0;
  $("apiBarFill").style.width = `${pct}%`;
  $("apiBarFill").classList.toggle("hot", pct >= 80);
  $("apiSpend").textContent = sp.capUsd != null
    ? `$${(sp.spentUsd ?? 0).toFixed(2)} of $${sp.capUsd} this month · ${sp.tracks || 0} track${sp.tracks === 1 ? "" : "s"}`
      + (sp.overCap ? " · CAP REACHED — renders are refused until you raise it" : "")
    : "";
}

/**
 * Disable what the hosted engine genuinely cannot do.
 *
 * Audio reference works by encoding a real recording into the model's own latent
 * and denoising partially from there. Every hosted endpoint is text-in,
 * audio-out — there is no latent to hand it. Leaving the control live and
 * failing at submit time would waste the upload, the wait and the user's
 * patience, so it is closed and labelled with the reason instead.
 */
function applyApiConstraints() {
  const on = !!state.apiMode?.enabled;
  const f = $("arefField");
  if (!f) return;
  f.classList.toggle("disabled", on);
  for (const el of f.querySelectorAll("input, button, select")) el.disabled = on;
  if (on) f.open = false;
  const note = $("arefState");
  if (note) {
    note.textContent = on
      ? "unavailable in API mode — hosted engines take text only"
      : (state.aref?.name ? "on" : "off");
  }
}

async function apiPost(body) {
  const r = await (await fetch("/api/apimode", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })).json();
  if (r.error) alert(r.error);
  await loadApiMode();
  return r;
}

$("apiEnabled").onchange = () => apiPost({ action: "config", enabled: $("apiEnabled").checked });
$("apiProvider").onchange = () => apiPost({ action: "config", provider: $("apiProvider").value });
$("apiCapSave").onclick = () => apiPost({ action: "config", monthlyCapUsd: Number($("apiCap").value) });
$("apiKeySave").onclick = async () => {
  const key = $("apiKey").value.trim();
  if (!key) return;
  const r = await apiPost({ action: "setKey", provider: $("apiProvider").value, key });
  // Clear the box immediately. A key left sitting in an input is one screen
  // share away from being public, and the server already has it.
  $("apiKey").value = "";
  if (r.method === "file-permissions") {
    alert("Saved, but this machine has no OS keystore available, so it is protected by file permissions rather than encryption. "
        + "Anyone who can read your user profile can read the key.");
  }
};
$("apiKeyClear").onclick = () => apiPost({ action: "clearKey", provider: $("apiProvider").value });

/* ── the ⓘ on every screen ─────────────────────────────────────────────────
 *
 * The owner: "for each component we need to show a little Info part which
 * explains the page and shows what you need for models or other dependencies."
 *
 * THIS MAP IS THE ONLY THING THAT COULD NOT BE DERIVED. The rail already says
 * which views exist and server/welcome/catalogue.js already says what each one
 * is; what neither of them knows is WHICH ELEMENT on this page is that view's
 * container. So one line per view, and nothing else about a screen is written
 * down here — no title, no description, no dependency list.
 *
 * server/welcome/ui_test.js reads these keys straight out of this file and
 * fails the commit if they are not exactly the rail's `data-view` set. Delete a
 * line and the census names it; add a sixteenth view and the census demands
 * one. That is the falsification this map exists to be checked by, and it is
 * why the map is a plain object literal rather than anything clever.
 *
 * The DAW is absent on purpose: it is a `data-page`, not a `data-view`, and it
 * owns web/daw.html — which this strand does not touch. Its catalogue entry and
 * its `screen_info` both exist, so an agent can still ask about it.
 */
const INFO_HOSTS = {
  chat: "#chat",
  create: ".create",
  images: "#imagesview .vidlib",   // on the gallery's heading, as Video's is on Clips
  video: "#videoclips",
  vfx: "#vfx",
  workflow: "#workflow",
  studio: "#studio",
  reactive: "#reactive",
  training: "#training",
  collab: "#collab",
  overnight: "#overnight",
  community: "#community",
  radio: "#radio",
  blog: "#blog",
  games: "#games",
  models: "#models",
  engine: "#engine",
  settings: "#settings",
  mcp: "#mcp",
  about: "#about",
  thanks: "#thanks",
};

/**
 * Mount every one of them. Idempotent — mountInfo returns early where its panel
 * is already in the DOM — and called again on each view change for one reason:
 * the compositor builds its whole container with `root.innerHTML =` the first
 * time it is opened, which throws away anything mounted into it beforehand.
 * Re-running the mounts is two lines and heals that; a boot-only mount left VFX
 * as the single screen in the app with no ⓘ.
 */
function mountAllInfo() {
  for (const [view, selector] of Object.entries(INFO_HOSTS)) mountInfo(view, selector);
}

function setView(name) {
  state.view = name;
  for (const a of document.querySelectorAll(".nav a")) {
    a.classList.toggle("on", a.dataset.view === name);
  }
  // The whole library apparatus belongs to Create — the search bar, the filter
  // row and the pinned strip were all still showing above Settings and
  // Community, which made those views look like a broken library rather than
  // their own thing.
  /* The library shows on Create AND on Overnight.
   *
   * The original ask for Overnight was "creator panel left, library right" —
   * you plan on the left and watch songs appear on the right. It only ever got
   * the run progress, because this flag gated the whole library apparatus on
   * being in Create. The run panel and the library now stack in the right
   * column, progress first. */
  const lib = name === "create" || name === "overnight";
  /* Two views own a left column now: Create writes songs, Overnight plans a run.
   * `solo` collapses the column entirely, so it must only apply to the views that
   * genuinely have nothing to put there. */
  const hasLeft = lib || name === "overnight" || name === "video" || name === "images";  // studio is full width
  document.querySelector(".shell").classList.toggle("solo", !hasLeft);
  /* The song form belongs to Create alone. `lib` now also covers Overnight (so
   * the library shows on the right while a run goes), and reusing it here meant
   * the Create form appeared underneath the Overnight planner — two creator
   * columns at once. */
  document.querySelector(".create").hidden = name !== "create";
  $("ovPanel").hidden = name !== "overnight";
  $("vidPanel").hidden = name !== "video";
  $("imgPanel").hidden = name !== "images";
  /* THE KEYS ARE MADE HERE, on first sight of the screen and never at boot: a
   * Studio that never collaborates should not have a keypair on its disk. */
  if (name === "collab") paintCollab();
  if (name === "training") paintTraining();
  if (name === "overnight") {
    /* Free disk is read by the model catalogue, which only runs when the Models
     * tab is opened — so arriving at Overnight directly showed "free disk
     * unknown", which is the one number that matters when committing to an
     * unattended run. Fetch it once, then repaint. */
    if (state.diskFree == null) {
      fetch("/api/models").then((r) => r.json()).then((d) => {
        state.diskFree = d?.disk?.freeBytes ?? Infinity;
        ovPaintPlan();
      }).catch(() => { state.diskFree = Infinity; });
    }
    ovPaintPlan();
  }
  paintComm();
  $("rows").hidden = !lib;
  // The stage header and the filter row are browsing controls. On Overnight you
  // are watching, not searching, and a duplicate "Library" heading directly
  // under "Overnight run" reads as a layout bug.
  document.querySelector(".stagehead").hidden = name !== "create";
  document.querySelector(".libbar").hidden = name !== "create";
  /* The song-selection bar is the Music library's. It was added after this
   * list was written and so showed on every page; Images and Video have their
   * own (mountPickBar). */
  $("batchBar").hidden = name !== "create";
  if (!lib) $("pinned").hidden = true;
  $("overnight").hidden = name !== "overnight";
  $("videoclips").hidden = name !== "video";
  $("imagesview").hidden = name !== "images";
  if (name === "images") { loadImages(); imgPaint(); }
  $("studio").hidden = name !== "studio";
  // Video Workflow (fork-only). See FORK_DELTA.md.
  $("workflow").hidden = name !== "workflow";
  if (name === "workflow") wfOpen();
  $("settings").hidden = name !== "settings";
  $("models").hidden = name !== "models";
  $("engine").hidden = name !== "engine";
  /* ⚠ Visibility is set HERE, one explicit line per view — the map above is not
   * what unhides anything. Registering there alone gave a page whose own loader
   * ran (it un-hid the form inside) while the container stayed display:none, so
   * the nav highlighted and the screen was blank. */
  $("reactive").hidden = name !== "reactive";
  $("training").hidden = name !== "training";
  /* ⚠ AND THIS LINE IS THE ONE COLLAB WAS MISSING. It was registered in the
   * info map, it had a rail link, and `paintCollab()` ran on the view change —
   * so the nav highlighted, the keys were made, the door was called, and the
   * screen stayed blank, which is precisely what the warning above describes.
   * A view is not visible until a line here says so. */
  $("collab").hidden = name !== "collab";
  /* Chat. One line, like every other view — web/chat.js owns everything inside
   * the container and app.js never touches it, the same bargain #engine has. */
  $("chat").hidden = name !== "chat";
  /* Welcome: the entrance plays each time the page comes into view. */
  $("home").hidden = name !== "home";
  if (name === "home") { const h = $("home"); h.classList.remove("in"); void h.offsetWidth; h.classList.add("in"); }
  $("thanks").hidden = name !== "thanks";
  $("mcp").hidden = name !== "mcp";
  $("about").hidden = name !== "about";
  $("games").hidden = name !== "games";
  $("radio").hidden = name !== "radio";
  $("blog").hidden = name !== "blog";
  $("jobs").hidden = name !== "jobs";
  if (name === "jobs") paintJobs(state.lastStatus);
  if (name === "games") initGames();
  $("vfx").hidden = name !== "vfx";
  if (name === "vfx") { initVfx(); vfxOpen(); }
  if (name === "mcp") loadMcp();
  // Filled once, from the same catalogue the Models screen reads. loadThanks
  // returns early after the first fill, so opening the tab repeatedly is free.
  if (name === "reactive") loadReactive();
  if (name === "thanks") loadThanks();
  // Same catalogue, filled the first time the About page is opened.
  if (name === "about") { loadAboutRights(); loadAboutReport(); loadVersion(); }
  if (name === "video") { vidPaint(); loadClips(); }
  /* The studio is fed rather than fetching: the clip list and the library are
   * both already in memory here, and a second copy that polls independently is
   * how two views start disagreeing about what exists. */
  if (name === "studio") {
    initStudio();
    if (!state.clips) loadClips().then(() => studioRefresh(state.clips, state.library));
    else studioRefresh(state.clips, state.library);
  }
  // NOTE: #community is NOT set here. It is owned entirely by paintComm(), for
  // the reason documented there.
  // Read the catalogue when the tab opens rather than on every poll: it stats
  // every declared file, and doing that four times a second would be silly.
  if (name === "models") loadModels();
  if (name === "settings") { loadApiMode(); loadWorkflows(); loadArtPrefs(); }
  // Create needs it as well: the audio-reference control lives there, and its
  // availability is decided by a setting on another screen.
  if (name === "create") loadApiMode();
  // Same for Community. loadCommunity() returns early unless its tab is open, so
  // without this the pane was only ever filled if its 120-second timer happened
  // to fire while you were looking at it — which is why the style packs rendered
  // as an empty grid on arrival.
  if (name === "community" || name === "radio" || name === "blog") loadCommunity();
  if (name !== "create") $("songPanel").hidden = true;
  /* LAST, and after every loader above has had its turn at the DOM. The mounts
   * are idempotent, so this costs one querySelector per view; what it buys is a
   * screen that rebuilt its own container (VFX does, on first open) getting its
   * ⓘ back rather than silently losing it. */
  mountAllInfo();
}

/**
 * The ONE place that decides whether community chrome is on screen.
 *
 * 🔴 This exists because the old code was a one-way door. `setView` only ever
 * UN-hid `#community` (`if (name === "community") ...`) and never re-hid it, so
 * visiting Community once left the whole AI PLAY hero — heading, "Open
 * aiplay.live", "Refresh" — rendered underneath Settings, underneath Overnight
 * and underneath the Create library, for the rest of the session.
 *
 * Splitting the rule across setView and loadCommunity is what made that possible,
 * and it is why the first attempt at this fix did not hold: loadCommunity runs on
 * a 120-second timer and would re-assert its own opinion a couple of minutes
 * later. Both callers now come here, so there is exactly one rule and no timer
 * can disagree with it.
 */
function paintComm() {
  const v = state.view || "create";
  // The banner is an invitation to break off and go listen — it belongs where
  // songs are written, not over machine settings or a queue editor.
  $("commBar").hidden = v !== "create" || !state.commLive;
  // The pane belongs on its own tab and nowhere else. On that tab it always
  // shows, empty or not — #commEmpty explains the place, which beats a blank
  // screen. Off that tab it is always hidden, which is the half that was missing.
  $("community").hidden = v !== "community";
}
for (const a of document.querySelectorAll(".nav a")) {
  // A rail entry without a data-view is a real page (the DAW), not a view in
  // this document — let the browser navigate instead of eating the click.
  if (!a.dataset.view) continue;
  a.onclick = (e) => { e.preventDefault(); setView(a.dataset.view); };
}
/* Collapse the rail sideways to icons only (Suno's sidebar). Remembered. */
/* ── the column divider ────────────────────────────────────────────────────
 * Drag the border between the left column (Music, Images, Video, Overnight)
 * and the stage to size the column; ←/→ on it step by 20px; a double-click
 * goes back to the default. Remembered in this browser. Never narrower than
 * 320px, and the stage always keeps 380px. */
{
  const shell = document.querySelector(".shell"), grip = $("colGrip");
  const KEY = "aiplayColW";
  const maxW = () => Math.max(320, innerWidth - (document.querySelector(".rail")?.offsetWidth || 220) - 380);
  const clamp = (w) => Math.round(Math.max(320, Math.min(w, maxW())));
  const set = (w, save = true) => {
    if (!w) { shell.style.removeProperty("--colw"); try { localStorage.removeItem(KEY); } catch { /* private mode */ } return; }
    shell.style.setProperty("--colw", `${clamp(w)}px`);
    if (save) try { localStorage.setItem(KEY, String(clamp(w))); } catch { /* private mode */ }
  };
  const now = () => [".create", "#vidPanel", "#imgPanel", "#ovPanel"].map((q) => document.querySelector(q))
    .find((el) => el && !el.hidden && el.offsetWidth)?.offsetWidth || 400;
  try { const w = +localStorage.getItem(KEY); if (w > 0) set(w, false); } catch { /* private mode */ }
  addEventListener("resize", () => { const w = parseInt(shell.style.getPropertyValue("--colw"), 10); if (w) set(w, false); });
  grip?.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, w0 = now();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("drag");
    shell.classList.add("resizing");
    const move = (ev) => set(w0 + ev.clientX - x0, false);
    const up = () => {
      grip.classList.remove("drag");
      shell.classList.remove("resizing");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      set(now());
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  grip?.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    set(now() + (e.key === "ArrowRight" ? 20 : -20));
  });
  grip?.addEventListener("dblclick", () => set(0));
}
function setRailMini(mini) {
  document.querySelector(".shell")?.classList.toggle("railmini", mini);
  const b = $("railToggle");
  if (b) {
    b.setAttribute("aria-expanded", String(!mini));
    b.title = mini ? "Expand the menu" : "Collapse the menu";
    b.setAttribute("aria-label", b.title);
  }
  try { localStorage.setItem("aiplayRailMini", mini ? "1" : "0"); } catch { /* private mode */ }
}
if ($("railToggle")) {
  let mini = false;
  try { mini = localStorage.getItem("aiplayRailMini") === "1"; } catch { /* private mode */ }
  setRailMini(mini);
  $("railToggle").onclick = () => setRailMini(!document.querySelector(".shell").classList.contains("railmini"));
}
/* In-page cross-links (the About page pointing at Agent or Thanks). Delegated,
 * because the rail loop above only wires the rail. */
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]");
  if (go) { e.preventDefault(); setView(go.dataset.go); }
});

/* ── overnight ────────────────────────────────────────── */
/* Deliberately three controls. Anything more is a decision to make at bedtime,
   which is exactly when nobody wants to make one. */
/* Ideas survive a reload.
 *
 * They were browser-memory only while every other preference on this page
 * (takes, grid, auto, visualiser) persisted — so closing the tab before pressing
 * Start threw away a list somebody had just typed out. */
const ov = { ideas: [], kind: "music" };
try { ov.kind = localStorage.getItem("aiplayOvKind") || "music"; } catch { /* private mode */ }

/* THE THREE KINDS drain the identical plan and differ only in what one step
 * asks for, which is why this is a filter on one panel rather than three
 * panels. The ideas are kept per kind: switching to Images and back must not
 * lose the songs that were queued. */
function ovSetKind(k) {
  ov.kind = ["music", "image", "video"].includes(k) ? k : "music";
  try { localStorage.setItem("aiplayOvKind", ov.kind); } catch { /* private mode */ }
  for (const b of document.querySelectorAll("#ovKind [data-kind]")) {
    b.classList.toggle("sel", b.dataset.kind === ov.kind);
  }
  const media = ov.kind !== "music";
  /* The stage chain is what runs AFTER a song. There is no "after" for a
   * picture, so it is hidden rather than shown doing nothing. */
  $("ovStagesField").hidden = media;
  $("ovAdd").hidden = media;
  $("ovAddImage").hidden = !media;
  $("ovAddImage").textContent = ov.kind === "image"
    ? "+ Add what's on the Images tab" : "+ Add what's on the Video tab";
  ovRender();
}
const OV_KEYS = { music: "aiplayIdeas", image: "aiplayIdeasImage", video: "aiplayIdeasVideo" };
function ovLoadIdeas() {
  try { ov.ideas = JSON.parse(localStorage.getItem(OV_KEYS[ov.kind]) || "[]") || []; }
  catch { ov.ideas = []; }
}
ovLoadIdeas();
function ovSaveIdeas() {
  try { localStorage.setItem(OV_KEYS[ov.kind], JSON.stringify(ov.ideas.slice(0, 40))); } catch { /* quota */ }
}

function ovRender() {
  ovSaveIdeas();
  const box = $("ovIdeas");
  if (!ov.ideas.length) {
    box.innerHTML = `<div class="ovempty">${ov.kind === "music"
      ? "No ideas yet. Write one in Create, then add it here."
      : `No prompts yet. Set one up on the ${ov.kind === "image" ? "Images" : "Video"} tab, then add it here. A prompt with {a|b|c} in it makes a different picture each take.`}</div>`;
  } else {
    box.innerHTML = ov.ideas.map((it, i) => {
      /* A media idea has a prompt where a song has a caption, and the prompt is
       * shown UNEXPANDED — that is what was asked for, and every take expands it
       * differently. The combination count is the useful number: it says whether
       * a night of twenty takes will actually be twenty different pictures. */
      if (ov.kind !== "music") {
        /* Counted by the SERVER when the idea was added, not re-derived here:
         * a second expander in the client is a second thing to drift. */
        const combos = it.combinations || 1;
        return `<div class="ovidea">
          <div><div class="t">${esc((it.title || it.prompt).slice(0, 60))}</div>
            <div class="s">${esc([it.engine === "checkpoint" ? (it.checkpoint || "").replace(/\.safetensors$/i, "") : it.engine,
                                  it.width && it.height ? `${it.width}×${it.height}` : "",
                                  it.steps ? `${it.steps} steps` : "",
                                  combos > 1 ? `${combos} variations` : ""].filter(Boolean).join(" · "))}</div></div>
          <button class="x" type="button" data-rm="${i}" aria-label="Remove">✕</button>
        </div>`;
      }
      return `<div class="ovidea">
        <div><div class="t">${esc(it.title)}${it.instrumental ? ' <span class="badge">instrumental</span>' : ""}</div>
          <div class="s">${esc(it.caption)}</div></div>
        <button class="x" type="button" data-rm="${i}" aria-label="Remove">✕</button>
      </div>`;
    }).join("");
  }
  const takes = +$("ovTakes").value;
  const cap = +$("ovCap").value;
  const total = Math.min(ov.ideas.length * takes, cap);
  $("ovStart").disabled = !ov.ideas.length;
  $("ovCount").textContent = ov.ideas.length
    ? `${ov.ideas.length} idea${ov.ideas.length > 1 ? "s" : ""}` : "";

  ovPaintPlan(total);
}

/**
 * What the whole plan costs — time, disk, and whether the disk can take it.
 *
 * Every figure here is per-song and MEASURED on this machine, not guessed:
 *   music   ~1.53x realtime (config.speed.realtimeRatio, refined per machine)
 *   cover   ~3.3 s at 1024², plus a ~20 s model load once per drain
 *   lyrics  ~36 s for a 2.5-minute song
 *   stems   ~12 s for a 30 s track, so roughly 0.4x realtime
 *
 * Shown BEFORE starting because the whole point of an overnight run is that
 * nobody is watching it — discovering at 3am that the disk filled up is the
 * failure this panel exists to prevent.
 */
const OV_COST = {
  // [seconds per song, bytes per song] — all measured on this rig.
  cover: [3.3, 1_850_000],
  lrc: [36, 5_000],
  stems: [60, 22_000_000],
  // 2 s of clip at 864x480 / 8 steps measured ~25 s warm, ~790 KB. By far the
  // most expensive stage, and the one most worth showing a cost for before
  // someone leaves it running on fifty songs.
  video: [25, 800_000],
  /* Measured on this rig, same 5 s 1280x704 clip:
   *     smoother (RIFE 2x)      16 s   515 KB -> 635 KB
   *     bigger (ESRGAN 2x)      99 s   515 KB -> 1586 KB
   * The Overnight default is "smoother", so that is the number shown — it is
   * also the cheap one, and the one that helps a generated clip most. */
  enhance: [16, 650_000],
};

/**
 * What ONE take of a media idea costs, in seconds.
 *
 * Approximate on purpose and labelled as such: the point is planning a night,
 * where being twenty percent out is fine and being an order of magnitude out is
 * not. Anchored on measurements taken on this rig rather than on a formula
 * carried over from the music path, which would have been wrong by a factor of
 * fifty for a picture.
 *
 * VIDEO reuses the engine's own cost curve, which the server already ships in
 * config.video.engines — the same numbers the render deadline is sized from, so
 * the estimate and the timeout cannot disagree about how long something takes.
 */
function ovMediaCost(idea, kind) {
  const mp = ((idea.width || 1024) * (idea.height || 1024)) / 1e6;
  if (kind === "image") {
    /* Measured here 2026-08-27: SDXL 1024² at 28 steps ≈ 35 s warm, the same at
     * 6 steps ≈ 8 s, FLUX.2 klein 4 steps ≈ 8 s including its heavier steps.
     * So roughly a second per step-megapixel, plus a load the first time. */
    const steps = idea.steps || (idea.engine === "flux2" ? 4 : idea.engine === "zimage" ? 8 : 28);
    const count = idea.count || 1;
    /* count > 1 shares ONE text encode, so it is far cheaper than n renders. */
    return 6 + 1.15 * steps * mp * (1 + (count - 1) * 0.75);
  }
  const engines = (state.config && state.config.video && state.config.video.engines) || {};
  const eng = engines[idea.engine || (state.config?.video?.engine) || "ltx"] || {};
  const fps = eng.fps || 24;
  const frames = Math.round((idea.seconds || eng.seconds || 5) * fps) + 1;
  const rate = eng.costRate ?? 0.31, exp = eng.costExponent ?? 1.2, fixed = eng.costFixedSeconds ?? 20;
  return fixed + rate * Math.pow((mp * 1e6 * frames) / 1e6, exp);
}

function ovPaintPlan(total) {
  if (total == null) {
    const takes = +$("ovTakes").value, cap = +$("ovCap").value;
    total = Math.min(ov.ideas.length * takes, cap);
  }
  const stages = {
    cover: $("ovStCover").checked,
    lrc: $("ovStLrc").checked,
    stems: $("ovStStems").checked,
    video: $("ovStVideo").checked,
    // Only meaningful with video — the server drops it from the expected stages
    // otherwise, so a run can never sit waiting on an input that never comes.
    enhance: $("ovStVideo").checked && $("ovStEnhance").checked,
  };
  // Per-song estimate labels next to each checkbox.
  for (const k of Object.keys(OV_COST)) {
    const el = $(`ovSt${k[0].toUpperCase()}${k.slice(1)}Est`);
    if (el) el.textContent = `~${OV_COST[k][0] < 60 ? `${Math.round(OV_COST[k][0])}s` : `${Math.round(OV_COST[k][0] / 60)}m`} each`;
  }

  if (!total) {
    $("ovEst").textContent = "Add an idea to see what it would cost.";
    $("ovBudget").innerHTML = "";
    return;
  }

  /* A MEDIA run costs nothing like a song, so it does not go through the music
   * arithmetic. Sharing that line would have told someone planning a night of
   * pictures to expect two and a half hours of "music". */
  if (ov.kind !== "music") {
    const takes = +$("ovTakes").value;
    const per = ov.ideas.map((it) => ovMediaCost(it, ov.kind));
    /* The plan is round-robin, so a cap that bites takes whole passes off the
     * end rather than trimming every idea equally — estimate it the way the
     * runner will actually drain it. */
    let secs = 0, n = 0;
    for (let t = 0; t < takes && n < total; t++) {
      for (let i = 0; i < per.length && n < total; i++) { secs += per[i]; n++; }
    }
    const bytes = total * (ov.kind === "image" ? 1.6e6 : 3.5e6);
    const free = state.diskFree ?? Infinity;
    const tight = bytes > free * 0.9;
    $("ovBudget").innerHTML = `
      <div><span>${ov.kind === "image" ? "pictures" : "clips"}</span><b>${total} · ${dur(secs)}</b></div>
      <div><span>disk</span><b>${size(bytes)}${tight ? " — not enough free" : ""}</b></div>
      <div><span>total</span><b>${dur(secs)} · done by ${clock(Date.now() + secs * 1000)}</b></div>`;
    $("ovEst").textContent =
      `${total} ${ov.kind === "image" ? "picture" : "clip"}${total > 1 ? "s" : ""} · about ${dur(secs)} · done by ${clock(Date.now() + secs * 1000)}`;
    $("ovStart").disabled = !ov.ideas.length || tight;
    return;
  }

  const musicSecs = total * 150 * (state.realtimeRatio || 1.53);
  // FLAC ~30 MB a song, MP3/Opus ~5 MB. Follows the actual output setting.
  const audioBytes = total * (state.outFormat === "flac" || !state.outFormat ? 30e6 : 5e6);
  let extraSecs = 0, extraBytes = 0;
  for (const [k, on] of Object.entries(stages)) {
    if (!on) continue;
    extraSecs += total * OV_COST[k][0];
    extraBytes += total * OV_COST[k][1];
  }
  const secs = musicSecs + extraSecs;
  const bytes = audioBytes + extraBytes;
  const free = state.diskFree ?? Infinity;
  const tight = bytes > free * 0.9;

  $("ovBudget").innerHTML = `
    <div><span>music</span><b>${dur(musicSecs)} · ${size(audioBytes)}</b></div>
    ${extraSecs ? `<div><span>after</span><b>${dur(extraSecs)} · ${size(extraBytes)}</b></div>` : ""}
    <div><span>total</span><b>${dur(secs)} · ${size(bytes)}</b></div>
    <div class="${tight ? "tight" : ""}"><span>free disk</span><b>${
      free === Infinity ? "unknown" : size(free)}${tight ? " — not enough" : ""}</b></div>`;

  $("ovEst").textContent =
    `${total} song${total > 1 ? "s" : ""} · done by ${clock(Date.now() + secs * 1000)}`;
  // Refuse a plan that cannot fit rather than filling the disk at 3am.
  $("ovStart").disabled = !ov.ideas.length || tight;
}
for (const id of ["ovStCover", "ovStLrc", "ovStStems", "ovStVideo"]) {
  $(id).onchange = () => ovPaintPlan();
}

/** Past runs — what ran, whether it worked, what it cost. */
function ovPaintRuns(s) {
  /* `s.runs` is the archive the server now keeps. The old fallback to `[s.run]`
   * meant this list could only ever show the CURRENT run — a duplicate of the
   * live panel directly above it — because nothing was ever archived. Keep the
   * fallback only for a live run that has not been archived yet, and never show
   * it twice. */
  const archived = s?.runs || [];
  const live = s?.run && !archived.some((r) => r.id === s.run.id) ? [s.run] : [];
  const runs = [...live, ...archived];
  const box = $("ovRuns");
  if (!box) return;
  if (!runs.length) {
    box.innerHTML = '<div class="ovempty">No runs yet.</div>';
    return;
  }
  box.innerHTML = runs.map((r) => {
    // `total` never existed on either shape — the archive calls it `planned`
    // and a live run exposes `plan.length`, so this always read "0/0".
    const total = r.planned ?? r.total ?? r.plan?.length ?? 0;
    const ok = r.state === "done" || (total > 0 && r.done === total);
    const when = r.finishedAt || r.startedAt;
    const mins = r.startedAt && r.finishedAt
      ? Math.max(1, Math.round((r.finishedAt - r.startedAt) / 60000)) : null;
    return `<div class="ovrun">
      <span class="rn">${esc(r.name || "Run")}</span>
      <span class="rs">${r.done ?? 0}/${total}${r.failed ? ` · ${r.failed} failed` : ""}</span>
      ${mins ? `<span class="rs">${mins} min</span>` : ""}
      ${when ? `<span class="rs">${esc(stamp(when))}</span>` : ""}
      <span class="rs ${ok ? "ok" : r.state === "failed" ? "bad" : ""}">${esc(r.state || "")}</span>
    </div>`;
  }).join("");
}

// "about 3h 50m" reads better than a raw seconds count at this scale.
function dur(s) {
  /* Seconds below a minute. This rounded straight to minutes, which was fine
   * when the only caller was an overnight plan measured in hours and became
   * wrong the moment the queue panel used it: a cover takes four seconds and
   * the rail said "0 min of work", which reads as nothing to do. */
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

$("ovAdd").onclick = () => {
  const caption = $("caption").value.trim();
  if (!caption) { $("ovEst").textContent = "Write a style in Create first — that is the one required field."; return; }
  ov.ideas.push({
    title: $("title").value.trim() || "Untitled",
    caption,
    lyrics: state.mode === "instrumental" ? $("scaffold").textContent : $("lyrics").value.trim(),
    instrumental: state.mode === "instrumental",
    maxDuration: +$("maxDur").value,
  });
  ovRender();
};
$("ovClear").onclick = () => { ov.ideas = []; ovRender(); };
$("ovIdeas").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-rm]");
  if (rm) { ov.ideas.splice(+rm.dataset.rm, 1); ovRender(); }
});
$("ovTakes").oninput = () => { $("ovTakesV").textContent = $("ovTakes").value; ovRender(); };
$("ovCap").oninput = () => { $("ovCapV").textContent = $("ovCap").value; ovRender(); };

/* Errors have to reach the person who pressed the button.
 *
 * This used to pipe every response straight into applyBatch and swallow the
 * rest, so a refusal from the server — "a run is already going", an empty idea
 * list — repainted the panel unchanged and looked like a dead button. */
const ovPost = (body) =>
  fetch("/api/batch", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) })
    .then((r) => r.json())
    .then((s) => { if (s?.error) { alert(s.error); return; } applyBatch(s); })
    .catch(() => {});

/* Take what is ON the Images (or Video) screen. Those forms already hold an
 * engine, a model, a size, steps and cfg; re-typing them into this panel would
 * be a second place for them to drift, and the one that is wrong is always the
 * one nobody looked at. */
$("ovAddImage").onclick = async () => {
  const isImg = ov.kind === "image";
  const prompt = (isImg ? $("imgPrompt") : $("vidPrompt"))?.value.trim();
  if (!prompt) {
    alert(`Write a prompt on the ${isImg ? "Images" : "Video"} tab first — that is what this queues.`);
    return;
  }
  const idea = isImg ? {
    prompt,
    engine: $("imgEngine").value,
    ...($("imgEngine").value === "checkpoint" ? {
      checkpoint: $("imgCkpt").value,
      negative: $("imgNeg").value.trim() || undefined,
      cfg: Number($("imgCfg").value) || undefined,
    } : {}),
    ...(() => {
      const [w, h] = $("imgSize").value === "custom"
        ? [Number($("imgW").value), Number($("imgH").value)]
        : $("imgSize").value.split("x").map(Number);
      return { width: w, height: h };
    })(),
    steps: Number($("imgSteps").value) || undefined,
    count: Number($("imgCount").value) || 1,
  } : {
    prompt,
    seconds: Number($("vidSeconds")?.value) || undefined,
  };
  /* Ask the server how many distinct prompts this template makes. It is the
   * number that decides whether twenty takes are twenty pictures or one picture
   * twenty times, and it is worth knowing BEFORE the night rather than after. */
  try {
    const d = await (await fetch("/api/prompt/preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, samples: 1 }),
    })).json();
    idea.combinations = d.combinations || 1;
  } catch { idea.combinations = 1; }
  ov.ideas.push(idea);
  ovRender();
};

for (const b of document.querySelectorAll("#ovKind [data-kind]")) {
  b.onclick = () => { ovSetKind(b.dataset.kind); ovLoadIdeas(); ovRender(); };
}
ovSetKind(ov.kind);

$("ovStart").onclick = () => ovPost({
  action: "start", kind: ov.kind, items: ov.ideas,
  takes: +$("ovTakes").value, cap: +$("ovCap").value,
  /* A name, so the history is readable. Nothing ever sent one, so the server
   * fell back to the literal string "Overnight run" and every archived row was
   * identical. Built from the first idea and the date, which is how you would
   * describe the run to yourself the next morning. */
  name: [ov.ideas[0]?.title || ov.ideas[0]?.caption?.slice(0, 28)
           || ov.ideas[0]?.prompt?.slice(0, 28) || "Overnight",
         ov.ideas.length > 1 ? `+${ov.ideas.length - 1}` : "",
         new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" })]
    .filter(Boolean).join(" · "),
  // The chain that runs AFTER each song. The server hands these to the same
  // idle-drain runner that already does covers, so music always preempts and
  // there is no second scheduler to keep in step.
  /* MUSIC ONLY. There is no "after" for a picture, and sending a stage chain
   * with an image run would ask the server for work that cannot exist. */
  stages: ov.kind !== "music" ? undefined : {
    cover: $("ovStCover").checked,
    lrc: $("ovStLrc").checked,
    stems: $("ovStStems").checked,
    video: $("ovStVideo").checked,
    // Only meaningful with video — the server drops it from the expected stages
    // otherwise, so a run can never sit waiting on an input that never comes.
    enhance: $("ovStVideo").checked && $("ovStEnhance").checked,
  },
});
$("ovPause").onclick = () => ovPost({ action: state.batchState === "paused" ? "resume" : "pause" });
$("ovStop").onclick = () => ovPost({ action: "stop" });

function applyBatch(s) {
  const r = s?.run;
  state.batchState = r?.state || null;
  const live = r && (r.state === "running" || r.state === "paused");
  $("ovPip").hidden = !live;
  $("ovLive").hidden = !r;
  // The planning controls live in the LEFT column now; while a run is live they
  // are replaced by the run itself rather than sitting there inviting a second
  // start.
  $("ovPanel").classList.toggle("running", Boolean(live));
  ovPaintRuns(s);
  if (!r) return;

  $("ovProgress").textContent = `${r.done} of ${r.total}`;
  $("ovNow").textContent = r.state === "running"
    ? `now making ${r.currentItem || "—"}`
    : r.state === "done" ? "finished" : r.state;
  $("ovBar").style.width = `${(r.total ? r.done / r.total : 0) * 100}%`;
  $("ovDoneBy").textContent = r.etaAt ? clock(r.etaAt) : "—";
  $("ovLeft").textContent = r.secondsLeft ? `about ${dur(r.secondsLeft)} left` : "";
  $("ovPause").textContent = r.state === "paused" ? "Resume" : "Pause";
  $("ovNote").textContent = r.note
    || [r.failed ? `${r.failed} failed` : null, r.keepingAwake ? "keeping your PC awake" : null]
       .filter(Boolean).join(" · ");

  ovPaintChain(r, s.postStages);
}

/* What each song is still owed after its music finished.
 *
 * The done/total above counts songs RENDERED. Everything a run promised on top
 * of that — cover, stems, timed lyrics, a clip — is queued per song and drains
 * later, only while the GPU is otherwise idle. Without this the run says
 * "finished" and then quietly works for another hour, and a stage that fails
 * leaves no trace at all. */
const STAGE_LABEL_OV = { cover: "cover", stems: "stems", lrc: "lyrics", video: "clip" };

function ovPaintChain(r, owed) {
  const songs = r.songs || [];
  const box = $("ovChain");
  // Nothing promised beyond the music means nothing to report, and an empty
  // disclosure is just furniture.
  const any = songs.some((x) => Object.keys(x.stages || {}).length);
  box.hidden = !any;
  if (!any) return;

  const waiting = owed?.waiting ?? 0, failed = owed?.failed ?? 0;
  $("ovChainState").textContent = waiting
    ? `${waiting} still to do${failed ? ` · ${failed} failed` : ""}`
    : failed ? `${failed} failed` : "all done";

  $("ovSongs").innerHTML = songs.slice().reverse().map((song) => {
    const pips = Object.entries(song.stages || {}).map(([k, st]) => {
      const cls = st === "done" ? "ok" : st === "failed" ? "bad" : "wait";
      const title = st === "done" ? `${STAGE_LABEL_OV[k] || k} finished`
        : st === "failed" ? `${STAGE_LABEL_OV[k] || k} failed`
        : `${STAGE_LABEL_OV[k] || k} still queued — runs when the card is free`;
      return `<span class="ovpip ${cls}" title="${esc(title)}">${esc(STAGE_LABEL_OV[k] || k)}</span>`;
    }).join("");
    return `<div class="ovsong">
      <span class="ovsongname" title="${esc(song.file)}">${esc(song.title || song.file)}</span>
      <span class="ovpips">${pips || '<span class="ovpip">music only</span>'}</span>
    </div>`;
  }).join("");
}

/* ── editor — waveform, drag to select ────────────────── */
/* Sliders for time ranges are miserable: you cannot see where a chorus starts.
 * Decode the audio in the browser, draw peaks, and let the selection be a lit
 * window over a dimmed waveform — what you keep reads without a legend. */
const ed = { dur: 0, a: 0, b: 0, peaks: null, cutting: false, drag: null };

async function openEditor(file) {
  state.editing = file;
  $("edFile").textContent = file;
  $("edPanel").hidden = false;
  $("waveLoad").hidden = false;
  $("waveLoad").textContent = "reading audio…";
  ed.peaks = null;

  try {
    // Peaks come from the server. Decoding FLAC in the browser via
    // decodeAudioData is unreliable and left this panel stuck on "reading audio…".
    const r = await fetch(`/api/peaks/${encodeURIComponent(file)}`);
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "no peaks");
    ed.dur = j.seconds;
    ed.peaks = Float32Array.from(j.peaks);
    ed.a = 0; ed.b = ed.dur;
    $("waveLoad").hidden = true;
    drawWave();
    paintSel();
  } catch (err) {
    // Never a dead end: say so, and fall back to editing the whole track.
    $("waveLoad").textContent = "Couldn’t draw the waveform — the tools still work on the whole track.";
    ed.dur = 0;
  }
}

/** Min/max envelope per column — a true peak view rather than a smooth average,
 *  so transients and section boundaries stay visible. */
function peaksOf(buf, n) {
  const ch = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(ch.length / n));
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    let lo = 1, hi = -1;
    const s = i * step, e = Math.min(ch.length, s + step);
    for (let j = s; j < e; j++) { const v = ch[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    out[i * 2] = lo; out[i * 2 + 1] = hi;
  }
  return out;
}

function drawWave() {
  const c = $("wave");
  const w = c.clientWidth || 800, h = 96;
  const dpr = window.devicePixelRatio || 1;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext("2d");
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  if (!ed.peaks) return;

  const n = ed.peaks.length / 2, mid = h / 2;
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, "hsl(320,100%,70%)");
  grad.addColorStop(1, "hsl(195,100%,60%)");
  g.fillStyle = grad;
  for (let x = 0; x < w; x++) {
    const i = Math.floor((x / w) * n);
    const lo = ed.peaks[i * 2], hi = ed.peaks[i * 2 + 1];
    const y1 = mid - hi * mid * 0.92, y2 = mid - lo * mid * 0.92;
    g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

function paintSel() {
  const wrap = $("waveWrap"), sel = $("sel");
  if (!ed.dur) { $("edSel").textContent = "—"; return; }
  const w = wrap.clientWidth;
  const l = (ed.a / ed.dur) * w, r = (ed.b / ed.dur) * w;
  sel.style.left = `${l}px`;
  sel.style.width = `${Math.max(2, r - l)}px`;
  sel.classList.toggle("cutting", ed.cutting);
  const len = Math.max(0, ed.b - ed.a);
  $("edSel").textContent = ed.cutting
    ? `removing ${fmt(len)}  (${fmt(ed.a)} → ${fmt(ed.b)})`
    : `keeping ${fmt(len)}  (${fmt(ed.a)} → ${fmt(ed.b)})`;
}

const xToT = (e) => {
  const r = $("waveWrap").getBoundingClientRect();
  return Math.max(0, Math.min(ed.dur, ((e.clientX - r.left) / r.width) * ed.dur));
};

$("waveWrap").addEventListener("pointerdown", (e) => {
  if (!ed.dur) return;
  const t = xToT(e);
  const near = (v) => Math.abs(v - t) < ed.dur * 0.02;
  ed.drag = near(ed.a) ? "a" : near(ed.b) ? "b" : "new";
  if (ed.drag === "new") { ed.a = t; ed.b = t; }
  try { $("waveWrap").setPointerCapture(e.pointerId); } catch { /* drag on, untracked past the edge */ }
  paintSel();
});
$("waveWrap").addEventListener("pointermove", (e) => {
  if (!ed.drag || !ed.dur) return;
  const t = xToT(e);
  if (ed.drag === "a") ed.a = Math.min(t, ed.b);
  else if (ed.drag === "b") ed.b = Math.max(t, ed.a);
  else { ed.b = Math.max(t, ed.a); if (t < ed.a) { ed.b = ed.a; ed.a = t; } }
  paintSel();
});
addEventListener("pointerup", () => { ed.drag = null; });
addEventListener("resize", () => { drawWave(); paintSel(); });

$("edKeep").onclick = () => { ed.cutting = false; $("edKeep").classList.add("on"); $("edCut").classList.remove("on"); paintSel(); };
$("edCut").onclick = () => { ed.cutting = true; $("edCut").classList.add("on"); $("edKeep").classList.remove("on"); paintSel(); };
$("edAll").onclick = () => { ed.a = 0; ed.b = ed.dur; paintSel(); };
$("edSpeed").oninput = () => { $("edSpeedV").textContent = `${(+$("edSpeed").value).toFixed(2)}×`; };
$("edClose").onclick = () => { $("edPanel").hidden = true; };
addEventListener("keydown", (e) => { if (e.key === "Escape") $("edPanel").hidden = true; });
$("edPanel").addEventListener("click", (e) => { if (e.target.id === "edPanel") $("edPanel").hidden = true; });

$("edPlaySel").onclick = () => {
  if (!state.editing) return;
  audio.src = `/api/audio/${encodeURIComponent(state.editing)}`;
  audio.currentTime = ed.a;
  audio.play();
  const stop = () => { if (audio.currentTime >= ed.b) { audio.pause(); audio.removeEventListener("timeupdate", stop); } };
  audio.addEventListener("timeupdate", stop);
};

$("edApply").onclick = async () => {
  const ops = [];
  if (ed.cutting) {
    if (ed.b > ed.a) ops.push({ op: "cut", start: ed.a, end: ed.b });
  } else if (ed.a > 0.05 || ed.b < ed.dur - 0.05) {
    ops.push({ op: "trim", start: ed.a, end: ed.b });
  }
  if ($("edReverse").checked) ops.push({ op: "reverse" });
  if (Math.abs(+$("edSpeed").value - 1) > 0.005) ops.push({ op: "speed", rate: +$("edSpeed").value });
  // Fading the edges is almost always what you want after a trim — a hard cut
  // into a sustained note clicks.
  if ($("edFadeOn").checked) ops.push({ op: "fade", in: 0.4, out: 2.5 });
  if (!ops.length) { $("edResult").textContent = "Nothing to apply — drag a selection first."; return; }

  $("edApply").disabled = true;
  $("edApply").textContent = "Working…";
  try {
    const r = await fetch("/api/edit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: state.editing, ops }),
    });
    const j = await r.json();
    if (j.error) { $("edResult").textContent = j.error; return; }
    $("edResult").textContent = `Saved — ${fmt(j.seconds)}. Original untouched.`;
    poll();
    openEditor(j.file);
  } finally {
    $("edApply").disabled = false;
    $("edApply").textContent = "Apply";
  }
};

/* ── player ───────────────────────────────────────────── */
function play(file, title, seed) {
  audio.src = `/api/audio/${file}`;
  audio.play().catch(() => {});
  $("pTitle").textContent = title || "—";
  $("pSub").textContent = `generated locally · seed ${seed}`;
  // Look the track up rather than taking a seed alone, so the mini player shows
  // the same cover as the row it was launched from.
  const decoded = decodeURIComponent(file);
  const track = (state.library || []).find((x) => x.file === decoded);
  $("pArt").style.background = artBg(track || { seed: Number(seed) || 0 });
  $("pPlay").textContent = "❚❚";
  // Remembered rather than applied as a class, because the list re-renders on
  // every poll and an imperatively-set class vanished within four seconds.
  // `playing`, never `sel` — the editor owns that name (see #sel in styles.css).
  state.playingFile = decodeURIComponent(file);
  document.querySelectorAll(".row").forEach(
    (r) => r.classList.toggle("playing", r.dataset.file === file));
}
$("pPlay").onclick = () => {
  if (!audio.src) return;
  if (audio.paused) { audio.play(); $("pPlay").textContent = "❚❚"; }
  else { audio.pause(); $("pPlay").textContent = "▶"; }
};

/* Transport. The queue is whatever the library is currently showing, so a
   playlist filter also filters what next/previous walk through. */
function visibleTracks() {
  return [...document.querySelectorAll(".row[data-file]")].map((r) => ({
    file: r.dataset.file, title: r.dataset.title, seed: r.dataset.seed,
  }));
}
function step(dir) {
  const list = visibleTracks();
  if (!list.length) return;
  const cur = list.findIndex((t) => audio.src.includes(t.file));
  let next;
  if (state.shuffle) next = Math.floor(Math.random() * list.length);
  else next = cur < 0 ? 0 : (cur + dir + list.length) % list.length;
  const t = list[next];
  play(t.file, t.title, t.seed);
}
$("pNext").onclick = () => step(1);
$("pPrev").onclick = () => {
  // Restart the track first, like every other player, rather than skipping back
  // when you are three seconds in.
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  step(-1);
};
$("pLoop").onclick = () => {
  state.loop = !state.loop;
  $("pLoop").classList.toggle("on", state.loop);
  audio.loop = state.loop;
};
$("pShuffle").onclick = () => {
  state.shuffle = !state.shuffle;
  $("pShuffle").classList.toggle("on", state.shuffle);
};
$("pVol").oninput = () => {
  audio.volume = +$("pVol").value;
  state.lastVol = audio.volume || state.lastVol;
  $("pMute").textContent = audio.volume === 0 ? "🔇" : audio.volume < 0.5 ? "🔉" : "🔊";
};
$("pMute").onclick = () => {
  $("pVol").value = audio.volume > 0 ? 0 : (state.lastVol || 1);
  $("pVol").oninput();
};
audio.ontimeupdate = () => {
  if (scrubbing) return;              // the drag owns the bar until release
  $("pCur").textContent = fmt(audio.currentTime);
  $("pDur").textContent = fmt(audio.duration);
  $("pFill").style.width = `${(audio.currentTime / (audio.duration || 1)) * 100}%`;
};
audio.onended = () => {
  $("pPlay").textContent = "▶";
  // Rolling on is the default, but it fights you when you are judging one take
  // against another — the next render starts before you have decided.
  if (!state.loop && state.autoplay) step(1);
};

// Persisted, because it is a working preference rather than a per-session one.
state.autoplay = localStorage.getItem("aiplayAuto") !== "0";
function paintAuto() {
  $("pAuto").classList.toggle("on", state.autoplay);
  $("pAuto").title = state.autoplay
    ? "Autoplay next: on — click to stop after each track"
    : "Autoplay next: off — click to play through the library";
}
$("pAuto").onclick = () => {
  state.autoplay = !state.autoplay;
  localStorage.setItem("aiplayAuto", state.autoplay ? "1" : "0");
  paintAuto();
};
paintAuto();

// Drive the meters off the element's own events rather than the buttons, so
// they also follow autoplay-next, seeking and the keyboard.
audio.addEventListener("play", visStart);
audio.addEventListener("pause", visStop);
audio.addEventListener("ended", visStop);
/* The player bar only exists once something has been played. */
audio.addEventListener("play", () => document.querySelector(".shell")?.classList.add("hasplayer"));
/* Seeking: press anywhere on the (tall, invisible) hit area and drag; the bar
 * and time follow the pointer, and the jump happens on release. */
let scrubbing = false;
{
  const tr = $("pTrack");
  const frac = (e) => { const r = tr.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const show = (f) => {
    $("pFill").style.width = `${f * 100}%`;
    if (audio.duration) $("pCur").textContent = fmt(f * audio.duration);
  };
  tr.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !audio.duration) return;
    scrubbing = true; tr.classList.add("drag");
    tr.setPointerCapture(e.pointerId); show(frac(e)); e.preventDefault();
  });
  tr.addEventListener("pointermove", (e) => { if (scrubbing) show(frac(e)); });
  const end = (e) => {
    if (!scrubbing) return;
    scrubbing = false; tr.classList.remove("drag");
    if (audio.duration) audio.currentTime = frac(e) * audio.duration;
  };
  tr.addEventListener("pointerup", end);
  tr.addEventListener("pointercancel", () => { scrubbing = false; tr.classList.remove("drag"); });
}
// Browser handoff — the rights questions on the site stay the single consent gate.
/* The player's own "Open AI PLAY sessions" button was removed (2026-09-16):
 * the live-rooms bar on the Music tab is the one way there now. */

/* ── line visualisers ─────────────────────────────────── */
/* The divider rules become level meters while audio plays, one frequency band
   each: the rail foot takes the kick, Advanced the low-mids, the CTA the
   presence, and the player rule across the bottom the whole spectrum.
 *
 * Three rules keep this honest against the perf lesson from the site player:
 * the loop runs only while audio is actually playing, it stops dead when the
 * tab is hidden, and a frame writes four CSS variables and nothing else. */
const vis = { ctx: null, an: null, buf: null, raf: null, lines: [], on: true };

/* Claim the lines at load, not at first play. Doing it inside setup meant that
 * if the audio graph failed the elements were never even marked, so there was
 * nothing to debug and nothing to see. */
function visClaim() {
  if (vis.lines.length) return;
  // [from, to) over 128 bins at 44.1 kHz ⇒ ~172 Hz per bin.
  vis.lines = [
    { el: document.querySelector(".railfoot"), from: 0, to: 4, gain: 1.0 },   // kick
    { el: document.querySelector("details.adv"), from: 4, to: 20, gain: 1.3 }, // low-mid
    { el: document.querySelector(".cta"), from: 20, to: 64, gain: 1.9 },       // presence
    { el: document.querySelector(".player"), from: 0, to: 128, gain: 1.2 },    // everything
  ].filter((l) => l.el);
  for (const l of vis.lines) l.el.classList.add("vz", "vztop");
}

function visSetup() {
  if (vis.ctx) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { console.warn("visualiser: no Web Audio in this browser"); return false; }
  try {
    vis.ctx = new AC();
    // createMediaElementSource can only ever be called once per element, so this
    // is deliberately one-shot and cached.
    const src = vis.ctx.createMediaElementSource(audio);
    vis.an = vis.ctx.createAnalyser();
    vis.an.fftSize = 256;
    vis.an.smoothingTimeConstant = 0.72;
    src.connect(vis.an);
    // Still route to the speakers — an analyser is a tap, not a sink.
    vis.an.connect(vis.ctx.destination);
    vis.buf = new Uint8Array(vis.an.frequencyBinCount);
  } catch (err) {
    // Loud, because a silent failure here looks like "the feature does nothing".
    console.warn("visualiser: audio graph unavailable —", err?.message || err);
    vis.ctx = null;
    return false;
  }
  visClaim();
  return true;
}

function visFrame() {
  vis.raf = null;
  if (!vis.on || audio.paused || document.hidden) return visStop();
  vis.an.getByteFrequencyData(vis.buf);
  let all = 0;
  for (const l of vis.lines) {
    let sum = 0;
    for (let i = l.from; i < l.to; i++) sum += vis.buf[i];
    const v = Math.min(1, (sum / (l.to - l.from) / 255) * l.gain);
    l.el.style.setProperty("--vz", v.toFixed(3));
    all = Math.max(all, v);
  }
  /* Global bands, published on :root.
   *
   * ONE writer, any number of readers. Anything that should move with the music
   * — the playing row, the mini-player art, the progress bar, the equaliser —
   * reads a custom property in CSS instead of getting its own analyser and its
   * own rAF loop. Adding a reactive surface then costs a line of CSS and no
   * extra work per frame.
   *
   * Three bands rather than one level, because they carry different things:
   * bass is the pulse you feel, highs are the detail. A single average moves
   * everything identically and reads as one blinking light. */
  const band = (from, to, gain) => {
    let s = 0;
    for (let i = from; i < to; i++) s += vis.buf[i];
    return Math.min(1, (s / (to - from) / 255) * gain);
  };
  const n = vis.buf.length;
  const root = document.documentElement.style;
  root.setProperty("--vz-all", all.toFixed(3));
  root.setProperty("--vz-bass", band(0, Math.max(1, n >> 5), 1.35).toFixed(3));
  root.setProperty("--vz-mid", band(n >> 5, n >> 2, 1.6).toFixed(3));
  root.setProperty("--vz-high", band(n >> 2, n >> 1, 2.2).toFixed(3));
  vis.raf = requestAnimationFrame(visFrame);
}

function visStart() {
  if (!vis.on || !visSetup()) return;
  // Browsers start the context suspended until a gesture; pressing play is one.
  if (vis.ctx.state === "suspended") vis.ctx.resume().catch(() => {});
  if (!vis.raf) vis.raf = requestAnimationFrame(visFrame);
}

function visStop() {
  if (vis.raf) { cancelAnimationFrame(vis.raf); vis.raf = null; }
  for (const l of vis.lines) l.el.style.setProperty("--vz", "0");
  // Every band back to rest, or the last frame before a pause stays frozen on
  // screen as a permanent glow.
  for (const p of ["--vz-all", "--vz-bass", "--vz-mid", "--vz-high"]) {
    document.documentElement.style.setProperty(p, "0");
  }
}

// Off means off: no analyser reads, no rAF, and the lines return to plain rules.
$("qVis").onchange = () => {
  vis.on = $("qVis").checked;
  localStorage.setItem("aiplayVis", vis.on ? "1" : "0");
  if (vis.on) { if (!audio.paused) visStart(); } else visStop();
};
if (localStorage.getItem("aiplayVis") === "0") { vis.on = false; $("qVis").checked = false; }
// A hidden tab throttles rAF anyway; stopping outright also drops the analyser reads.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) visStop(); else if (!audio.paused) visStart();
});

/* ── engine status + live socket ──────────────────────── */
/* A SONG THAT DID NOT GO WELL, SAID WHERE CREATE WAS PRESSED.
 *
 * The Music page had no place for a finished job's outcome: the queue box
 * lists only what is running or waiting, and the Jobs screen lists the art
 * lane. A render that failed after queueing, or "finished" by returning a
 * cached earlier take, simply vanished from view. Only outcomes that arrive
 * while the page is open are announced — the first status read just arms it,
 * so an old failure is not re-announced on every page load. */
const musicOutcomeSeen = new Set();
let musicOutcomeArmed = false;
/* The outcome stays up until the next Create. The time estimate writes the
 * same line on every status poll, and without this it erased the warning
 * within the same applyStatus call that put it there. */
let musicOutcomeMsg = null;
function setCta(text) { if (!musicOutcomeMsg && $("ctaNote")) $("ctaNote").textContent = text; }
function noticeMusicOutcome(s) {
  const h = s.history?.[0];
  const key = h ? `${h.id}:${h.state}` : null;
  if (!musicOutcomeArmed) { musicOutcomeArmed = true; if (key) musicOutcomeSeen.add(key); return; }
  if (!key || musicOutcomeSeen.has(key)) return;
  musicOutcomeSeen.add(key);
  const title = h.title || "Untitled";
  const msg = h.state === "failed" ? `⚠ “${title}” failed: ${h.error || "no reason was given"}`
    : h.state === "done" && h.note ? `⚠ ${h.note}`
    : h.state === "done" && !h.file ? `⚠ “${title}” finished, but no audio file was found in the output folder.`
    : null;
  if (msg) { musicOutcomeMsg = msg; if ($("ctaNote")) $("ctaNote").textContent = msg; }
}

/* WHETHER COMFYUI IS HOLDING THE MUSIC MODEL — and two optional buttons.
 * Only for the engines that live in ComfyUI; the native GGUF runtime and the
 * Python kit load their model per song, so there is nothing to show for them.
 * Lazy by default: nobody has to press either button. */
let modelLoadBusy = null;
function paintModelLoad(s) {
  const box = $("modelLoad");
  if (!box) return;
  const e = state.musicEngine;
  box.hidden = !(e === "yue2-comfy" || e === "minimax-music3" || e === "ace-step15") || !s.engine?.ready;
  if (box.hidden) return;
  const aceDit = (state.musicModels || []).find((c) => c.engine === "ace-step15" && c.dit === state.musicAceModel)?.dit
    || (state.musicModels || []).find((c) => c.engine === "ace-step15" && c.dit)?.dit;
  const want = e === "ace-step15" ? `ace-step15:${aceDit}`
    : e === "yue2-comfy"
    ? `yue2-comfy:${state.musicYue2Checkpoint}`
    : `minimax-music3:${$("qModel")?.value || state.musicPrecision || "int8"}`;
  const loaded = s.loadedModel;
  const busy = !!(s.current || s.queue?.length) || !!modelLoadBusy;
  $("modelLoadText").textContent = modelLoadBusy === "load" ? "Loading the model into ComfyUI…"
    : modelLoadBusy === "unload" ? "Unloading…"
    : loaded?.key === want ? "✓ Loaded in ComfyUI — songs start straight away."
    : loaded ? "Another model is loaded; it is unloaded automatically when this one starts."
    : "Not loaded yet — the first song loads it.";
  $("btnModelLoad").hidden = !(e === "yue2-comfy" || e === "ace-step15") || loaded?.key === want;
  $("btnModelUnload").hidden = !loaded;
  $("btnModelLoad").disabled = $("btnModelUnload").disabled = busy;
}
async function modelLoadAction(action) {
  modelLoadBusy = action;
  try {
    const r = await (await fetch("/api/music", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
    })).json();
    if (r.error) alert(r.error);
  } catch (err) { alert(err.message); }
  finally { modelLoadBusy = null; fetch("/api/status").then((x) => x.json()).then(applyStatus).catch(() => {}); }
}
$("btnModelLoad")?.addEventListener("click", () => modelLoadAction("load"));
$("btnModelUnload")?.addEventListener("click", () => modelLoadAction("unload"));

function applyStatus(s) {
  if (!s.engine) return;
  noticeMusicOutcome(s);
  paintModelLoad(s);
  if (s.config?.musicOnly && !state.musicOnly) {
    state.musicOnly = true;
    const coreViews = new Set(["create", "models", "settings", "agent", "about", "thanks", "community"]);
    for (const link of document.querySelectorAll(".rail [data-view]")) {
      if (!coreViews.has(link.dataset.view)) link.style.display = "none";
    }
    setView("create");
  }
  state.engineReady = s.engine.ready;
  state.engineExpected = !!s.config?.engineExpected;
  $("engineLine").textContent = state.musicOnly
    ? (s.config?.musicEngine === "yue2-comfy"
        ? (s.engine.ready ? "MUSIC ONLY · YUE2 VIA COMFYUI" : "MUSIC ONLY · STARTING COMFYUI…")
        : s.config?.musicEngines?.["yue2-gguf"]?.ready ? "NATIVE MUSIC READY" : "NATIVE MUSIC · SETUP NEEDED")
    : s.engine.ready ? "RUNNING LOCALLY" : "STARTING…";
  $("btnCreate").disabled = $("btnPreview").disabled = !s.engine.ready;

  const b = s.engine.backend;
  const warn = $("engineWarn");
  if (!state.musicOnly && b && b.ok === false) {
    // The one check that protects the entire product claim.
    warn.hidden = false;
    warn.innerHTML = `<b>This install is running about 5× slower than it should.</b><br>${esc(b.message)}<br><br>${esc(b.fix)}`;
  } else {
    warn.hidden = true;
  }
  // Graphics-memory tier. This is the control that actually helps a small card:
  // the weights we ship are already the smallest that exist, so the only way to
  // fit less VRAM is to keep less of the model resident and stream the rest.
  if (s.config?.tiers && !state.tiersPainted) {
    state.tiersPainted = true;
    $("qTier").innerHTML = s.config.tiers.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join("");
    $("qTier").value = s.config.tier || "auto";
    state.tiers = s.config.tiers;
    paintTier();
    $("qTier").onchange = async () => {
      const t = state.tiers.find((x) => x.id === $("qTier").value);
      if (!(await appConfirm(`Switch to “${t.label}”?\n\n${t.note}\n\nThis restarts the engine, which clears the cached take — your next re-roll will cost a full render.`))) {
        $("qTier").value = state.tier || "auto"; return;
      }
      $("tierHint").textContent = "Restarting the engine…";
      await fetch("/api/tier", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier: $("qTier").value }) });
      state.tier = $("qTier").value;
      paintTier(); poll();
    };
  }
  if (s.config?.tier) state.tier = s.config.tier;
  // Overnight estimates the whole run from this, so keep it in sync with the
  // server rather than hard-coding the cold ratio in two places.
  if (s.config?.realtimeRatio) state.realtimeRatio = s.config.realtimeRatio;
  // Which AIPLAY instance to hand off to. NOTHING ever assigned this, so both
  // "open the site" buttons fell through to a hardcoded production URL while the
  // feed was serving dev session ids — so every Join opened a 404 on the wrong
  // host. The server now derives it from the feed URL and sends it here.
  if (s.config?.siteSessions) state.siteSessions = s.config.siteSessions;
  if (s.config?.site) state.site = s.config.site;
  // Paint the format control once from the server, then leave it alone — the
  // poll runs every few seconds and would otherwise fight the user mid-change.
  if (s.config?.output && !state.fmtPainted) {
    state.fmtPainted = true;
    $("qFormat").value = s.config.output.format || "flac";
    paintFormat();
  }
  /* Overnight's planned-size estimate reads state.outFormat, and NOTHING ever
   * assigned it — so a run of MP3s or Opus was sized as if it were FLAC, and the
   * disk check could refuse to start on a number that was never true. Assigned
   * on every poll, not once, because the format is changeable mid-session. */
  if (s.config?.output) {
    state.outFormat = s.config.output.format || "flac";
  }
  if (s.config?.stems && !state.stemsPainted) {
    state.stemsPainted = true;
    $("qStems").value = s.config.stems.when || "off";
  }
  /* Kept on `state` for the row menu, which has to decide whether to offer
   * "Make a video clip" at all. Unlike the controls below this is re-read on
   * every poll, not painted once — toggling the setting must change the menu
   * without a reload. */
  if (s.config?.video) state.video = s.config.video;
  /* Hoisted to the top of `state` the same way `video` is, and for the same
   * reason: nothing assigns `state.config`, so reading `state.config.music…`
   * silently yields undefined — which is exactly what it did, leaving the
   * selector painted but empty and hidden. The convention in this file is a
   * hoisted key, so follow it rather than inventing a second shape.
   *
   * The user's own choice is never overwritten by a poll: `musicEngine` is only
   * seeded when unset, so a selection survives the next snapshot four seconds
   * later. `state.video` above gets this wrong in the other direction — it
   * replaces the whole object every poll, so a video-engine choice that has
   * not yet reached the server can be reverted by the next snapshot. Seeding
   * once avoids that. */
  if (s.config?.musicEngines) state.musicEngines = s.config.musicEngines;
  state.tokenizerReady = !!s.config?.tokenizer?.ready;
  if (s.config?.musicModels) state.musicModels = s.config.musicModels;
  if (s.config && "musicYue2Lora" in s.config && state.musicYue2Lora === undefined) {
    // Seeded once, like the checkpoint; the picker's own change posts and updates it.
    state.musicYue2Lora = s.config.musicYue2Lora ?? "";
    state.musicYue2LoraStrength = Number.isFinite(s.config.musicYue2LoraStrength) ? s.config.musicYue2LoraStrength : 1;
    state.musicYue2LoraClip = s.config.musicYue2LoraClip ?? "";
    state.musicYue2LoraClipStrength = Number.isFinite(s.config.musicYue2LoraClipStrength) ? s.config.musicYue2LoraClipStrength : 1;
  }
  if (s.config && "musicYue2Checkpoint" in s.config && state.musicYue2Checkpoint === undefined) {
    state.musicYue2Checkpoint = s.config.musicYue2Checkpoint;
  }
  // ACE-Step's remembered choices, seeded once; the page's own changes post and update them.
  if (s.config && "musicAceModel" in s.config && state.musicAceModel === undefined) {
    state.musicAceModel = s.config.musicAceModel;
    state.musicAceLm = s.config.musicAceLm ?? "";
    state.musicAceLora = s.config.musicAceLora ?? "";
    state.musicAceLoraStrength = Number.isFinite(s.config.musicAceLoraStrength) ? s.config.musicAceLoraStrength : 1;
  }
  /* The remembered build, applied once — after that the page's own choice wins. */
  if (s.config?.musicPrecision && !state.musicPrecision) {
    state.musicPrecision = s.config.musicPrecision;
    if ($("qModel")) $("qModel").value = s.config.musicPrecision;
  }
  if (s.config?.musicEngine && !state.musicEngine) state.musicEngine = s.config.musicEngine;
  /* The engine list arrives with this snapshot, so the selector cannot be
   * painted at load time — it was, and it came up empty on a cold start and
   * never filled, the same defect renderList() fixes for the Video picker.
   * Repaint on every status; the painter is idempotent and leaves a user's
   * own selection alone once made. */
  if (state.musicEngines) musicEnginePaint();
  if (s.config?.paths && !state.pathsPainted) {
    state.pathsPainted = true;
    $("qOutDir").value = s.config.paths.outputDir || "";
    $("qRigDir").value = s.config.paths.rig || "";
  }
  if (s.config?.video && !state.videoPainted) {
    state.videoPainted = true;
    $("qVideo").value = s.config.video.enabled ? "1" : "0";
    $("qVideoWhen").value = s.config.video.when || "off";
    $("qVideoWhen").disabled = !s.config.video.enabled;
    $("qVideoEngine").disabled = !s.config.video.enabled;
    // The overnight stage cannot be picked while the model is switched off —
    // the server refuses it anyway, and an enabled checkbox that silently does
    // nothing is worse than a disabled one.
    /* The stage is ALWAYS togglable now.
     *
     * It used to be disabled whenever video was off in Settings, which meant
     * planning tonight's run required a detour to another screen and back. The
     * run stores its own chain anyway, so ticking it here is a statement of
     * intent; the estimate says plainly if the model is not switched on. */
    $("ovStVideo").disabled = false;
    /* Greyed when the WEIGHTS are missing — not when the Settings toggle is off.
     *
     * The two were the same test, so a machine with all 34 GB installed was
     * still told the stage was unavailable because a switch it had never opened
     * defaulted to off. Worse, the server then dropped the stage anyway, so the
     * grey was accurate for the wrong reason. The run's chain now wins on the
     * server, which leaves exactly one honest reason to grey this: no models. */
    const vready = s.config.video.ready !== false;
    $("ovStVideo").closest(".ovstage").classList.toggle("off", !vready);
    const ve = s.config.video.engines?.[s.config.video.engine] || {};
    $("ovStVideoEst").textContent = vready
      ? `${ve.label || "video"} · ${ve.seconds ?? 5}s clip`
      : "video models not installed";

    // Engine picker for the run.
    const row = $("ovEngineRow");
    if (row) {
      row.hidden = !vready;
      if (!state.ovEnginePainted && s.config.video.engines) {
        state.ovEnginePainted = true;
        $("ovEngine").innerHTML = Object.entries(s.config.video.engines)
          .map(([k, e]) => '<option value="' + esc(k) + '">' + esc(e.label) + "</option>").join("");
      }
      $("ovEngine").value = s.config.video.engine;
    }
  }
  if (s.config?.lyrics && !state.lyricsPainted) {
    state.lyricsPainted = true;
    $("qLyrics").value = s.config.lyrics.when || "off";
  }
  if (s.config?.provenance) {
    // Kept on state so the song panel and the image editor can honour the
    // display toggle without their own fetch.
    state.provenance = s.config.provenance;
    if (!state.provPainted) {
      state.provPainted = true;
      $("qProvShow").value = s.config.provenance.showBadges === false ? "0" : "1";
      $("qProvEmbed").value = s.config.provenance.embedRecord === false ? "0" : "1";
    }
  }
  if (s.art) {
    if (!state.artPainted) { state.artPainted = true; $("qArt").value = s.art.enabled ? "1" : "0"; }
    /* Kept on state so the library row for THAT track can say what is happening
     * to it. Repaint only when the subject changes, or every poll would redraw
     * the whole list to move one badge. */
    /* The Video page's live panel. Painted every poll (not only on change),
       because the percentage and the elapsed counter are what move. */
    const c = s.art.current;
    const vn = $("vidNow");
    if (vn) {
      const isVid = c && c.kind === "video";
      vn.hidden = !isVid;
      if (isVid) {
        const pct = Math.round((c.progress || 0) * 100);
        $("vidNowTitle").textContent = `Rendering ${c.title || "a clip"}`;
        $("vidNowPct").textContent = `${pct}%`;
        $("vidNowFill").style.width = `${pct}%`;
        // Elapsed, and a projection only once there is enough signal to make one
        // honest — extrapolating from 3% produces a number that swings wildly.
        /* Before the sampler starts, `progress` is genuinely 0 and the time is
         * going into loading ~19 GB of H3 weights. Saying so beats a bar that
         * sits at zero looking stuck — that load is most of a cold render. */
        const left = pct > 8 ? Math.round((c.elapsed / (pct / 100)) - c.elapsed) : null;
        $("vidNowNote").textContent = pct === 0
          ? `${fmt(c.elapsed)} elapsed · loading the video model — this is most of a cold start`
          : `${fmt(c.elapsed)} elapsed`
            + (left != null ? ` · about ${fmt(left)} to go` : "")
            + " · the engine renders clips only while nothing else needs it";
      } else if (state.vidWasRendering) {
        // Just finished — refresh the gallery so the new clip appears by itself.
        loadClips();
      }
      state.vidWasRendering = isVid;
    }

    const now = s.art.current ? { file: s.art.current.file, kind: s.art.current.kind } : null;
    const key = now ? `${now.file}:${now.kind}` : "";
    if (key !== state.artNowKey) {
      state.artNowKey = key;
      state.artNow = now;
      // renderList is the painter; state.lastSnap is the cached snapshot it
      // wants. Guarded because the first art event can beat the first snapshot.
      if (state.lastSnap) renderList(state.lastSnap);
    }
    /* One queue, four kinds of work — so say which one.
     *
     * This line used to read "Drawing a cover for X…" whatever was running, so a
     * 30 s video render and a 12 s stem separation both reported as cover art.
     * The server now sends `kind`, and `queuedKinds` counts what is waiting. */
    const KIND = {
      cover: ["Drawing a cover for", "cover", "covers"],
      stems: ["Separating stems for", "stem split", "stem splits"],
      lrc: ["Timing the lyrics of", "lyric timing", "lyric timings"],
      video: ["Rendering a clip for", "clip", "clips"],
    };
    const waiting = Object.entries(s.art.queuedKinds || {})
      .map(([k, n]) => `${n} ${KIND[k]?.[n > 1 ? 2 : 1] || k}`)
      .join(", ");
    // Only speak while there is something to say; a permanent "0 queued" is noise.
    $("artNote").textContent = s.art.current
      ? `${KIND[s.art.current.kind]?.[0] || "Working on"} ${s.art.current.title}…`
      : waiting
        ? `${waiting} waiting for the engine to be idle.`
        : (s.art.lastError ? `Last job failed: ${s.art.lastError}` : $("artNote").textContent);
  }

  /* Graphics memory. Shown because "why is it slow" and "why did it fall over"
   * are usually answered by something else already occupying the card.
   *
   * NOT used to cap the number of takes: the queue runs one job at a time, so
   * four takes cost the same memory as one. Only true flow-stage batching would
   * multiply it, and we do not do that. Presenting this as a batch limit would
   * be inventing a constraint. */
  const g = s.gpu;
  $("gpuBox").hidden = !g;
  if (g) {
    const pct = Math.min(100, Math.round((g.usedMb / g.totalMb) * 100));
    $("gpuFill").style.width = `${pct}%`;
    $("gpuFill").style.background = pct > 92 ? "var(--warn)" : "var(--primary)";
    // Labelled now that a second meter sits under it — two bare "x / y GB" rows
    // would be ambiguous about which is the card.
    $("gpuText").textContent = `${(g.usedMb / 1024).toFixed(1)} / ${(g.totalMb / 1024).toFixed(0)} GB VRAM`;
    // The tooltip carries the caveat: driver-reported figures read high because
    // PyTorch keeps freed blocks in its allocator pool.
    $("gpuBox").title = `${g.name}\n${g.utilPct}% busy\n${g.note}`;
  }

  // System RAM, under the card. Shown because the low-VRAM tiers work by
  // streaming weights out of here — "why is it slow" has two possible answers
  // and one meter could only ever explain the first.
  const r = s.ram;
  $("ramBox").hidden = !r;
  if (r) {
    const pct = Math.min(100, Math.round((r.usedMb / r.totalMb) * 100));
    $("ramFill").style.width = `${pct}%`;
    $("ramFill").style.background = pct > 92 ? "var(--warn)" : "var(--secondary)";
    $("ramText").textContent = `${(r.usedMb / 1024).toFixed(1)} / ${(r.totalMb / 1024).toFixed(0)} GB RAM`;
    $("ramBox").title = r.note;
  }

  if (s.config) {
    // Estimate from the song we would actually get, not the ceiling: length
    // follows lyrics (or the instrumental scaffold), not the slider.
    const n = state.takes || 1;
    if ((state.musicEngines || {})[state.musicEngine]?.runtime === "audiocpp") {
      setCta(`${n > 1 ? `${n} takes · ` : ""}Experimental native GGUF · runtime and VRAM not measured here`);
    } else if (state.musicEngine === "yue2-comfy") {
      /* YuE2 THROUGH COMFYUI, from its own measurements — not the Python
       * kit's ratios below. RX 9060 XT 16 GB, 2026-09-16: a warm 30 s song
       * with no score plan in 24 s (0.8 s per second of audio); the plan adds
       * about 1.07 s per second (56 s for 30 s with the plan). The model stays
       * loaded between songs, so only the first one pays for loading it. */
      const want = Math.min(Math.max(+$("maxDur").value || 150, 30), 360);
      const one = Math.round(want * (0.8 + ($("yCot")?.value === "off" ? 0 : 1.07)));
      const loaded = s.loadedModel?.key === `yue2-comfy:${state.musicYue2Checkpoint}`;
      setCta(`${n > 1 ? `${n} takes · about ${fmt(one * n)} in total` : `about ${fmt(one)}`} on your card · `
        + (loaded ? "model already loaded" : "the first song also loads the model"));
    } else if (yueEngine()) {
      /* Mirror server/jobs.js #estimate: the wanted length stands in for an
       * outcome the model decides, times this engine's measured ratio (2.65×
       * with the AR offloaded, which the Long rung is), plus the planning
       * stage when no score is supplied. No cache on a fresh process, so no
       * re-roll promise; 16 solver steps shave the synthesis stage only. */
      const eng = (state.musicEngines || {})[state.musicEngine] || {};
      const want = Math.min(Math.max(+$("maxDur").value || 150, 30), 360);
      const ratio = eng.realtimeRatio || 2.39;
      const plan = $("scoreUse")?.checked ? 0 : 111;
      const steps16 = $("ySteps")?.value === "16" ? 0.9 : 1;
      const one = Math.round((want * ratio * steps16 + plan) * (ratio >= 2.39 ? 2.65 / 2.39 : 1));
      // True for the Python kit only: it starts a new process, and loads the model, for every song.
      setCta(n > 1
        ? `${n} takes · about ${fmt(one * n)} in total on your card`
        : `about ${fmt(one)} on your card · each song starts a fresh Python process and reloads the model`);
    } else {
      // Estimate from the song we would actually get, not the ceiling: length
      // follows lyrics (or the instrumental scaffold), not the slider.
      const est = state.mode === "instrumental"
        ? +$("sections").value * 19
        : Math.min(Math.max(($("lyrics").value.split("\n").filter((l) => l.trim() && !l.startsWith("[")).length) * 8, 30), +$("maxDur").value);
      const one = Math.round(est * s.config.realtimeRatio * (+$("qSteps").value / 15));
      // Takes are sequential runs, so the wait multiplies. Saying "0:46" while
      // queueing four of them would be a lie by omission.
      setCta(n > 1
        ? `${n} takes · about ${fmt(one * n)} in total on your card`
        : `about ${fmt(one)} on your card · re-rolls ~3× faster`);
    }
  }
}

function paintTier() {
  const t = (state.tiers || []).find((x) => x.id === $("qTier").value);
  $("tierHint").textContent = t ? t.note : "";
}

/* Recompute the estimate as the user types, so the number tracks what they will
   actually get rather than sitting at a stale ceiling-based guess. */
for (const el of ["lyrics", "maxDur", "qSteps", "sections"]) {
  $(el).addEventListener("input", () => fetch("/api/status").then((r) => r.json()).then(applyStatus).catch(() => {}));
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/live`);
  let wasBusy = false;
  ws.onmessage = (e) => {
    const snap = JSON.parse(e.data);
    renderNow(snap.current, (snap.queue || []).length);
    renderQueue(snap);
    renderList(snap);
    applyBatch(snap);
    /* The socket fires on every art progress tick and now carries the art lane
     * with it, so the render strip moves in real time rather than in four-second
     * jumps. `engine` is not on this frame — paintImgProgress falls back to the
     * readiness the last poll recorded. */
    paintImgProgress({ ...snap, engine: state.lastStatus?.engine });
    imgSeeFinished(snap);
    // The socket carries job state only — a track that just finished is on disk
    // but not in our remembered library yet. Re-read it the moment the queue
    // drains rather than waiting out the poll interval.
    const busy = Boolean(snap.current);
    if (wasBusy && !busy) poll();
    wasBusy = busy;
  };
  ws.onclose = () => setTimeout(connect, 1500);
}

$("plNew").onclick = async () => {
  const name = (await appPrompt("Playlist name"));
  if (!name) return;
  await fetch("/api/playlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", name }) });
  poll();
};
$("plSelect").onchange = () => poll();

async function poll() {
  try {
    const s = await (await fetch("/api/status")).json();
    applyStatus(s);
    renderPlaylists(s);
    renderNow(s.current, (s.queue || []).length);
    renderQueue(s);
    renderList(s);
    applyBatch(s);
    paintMiniQueue(s);
    paintImgProgress(s);
    imgSeeFinished(s);
    /* Kept so the Jobs view can paint the moment it is opened rather than
     * waiting up to a full poll interval to show anything. */
    state.lastStatus = s;
    if (state.view === "jobs") paintJobs(s);
  } catch { /* server restarting */ }
}

/* ── jobs: everything this session has finished ────────────
 *
 * The queue answers "what is happening now". Nothing answered "what has
 * happened" — art.done has collected every finished job since the beginning and
 * was never exposed, so a night that rendered two hundred assets could only be
 * reviewed by opening four separate libraries and guessing which file came from
 * which job.
 *
 * Each row links to the view its output actually lives in. That is the whole
 * point of the page: a job is only useful if you can get to what it made.
 */
const JOB_VIEW = {
  video: "video", enhance: "video", restyle: "video", upscale: "images",
  cover: "images", image: "images",
  stems: "create", lrc: "create", sfx: "create", music: "create",
  vfx: "vfx",
};
const JOB_LABEL = {
  video: "clip", cover: "image", image: "image", stems: "stems",
  lrc: "lyrics", sfx: "sfx", enhance: "enhance", restyle: "restyle",
  upscale: "upscale", vfx: "vfx",
};

function jobDur(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m}m ${String(sec % 60).padStart(2, "0")}s`
                : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/* What a job actually produced, by its own name — the file is the reason
 * anybody opens this page. */
function jobOutput(j) {
  if (j.clip) return j.clip;
  if (j.covers && j.covers.length) return j.covers[0] + (j.covers.length > 1 ? ` +${j.covers.length - 1}` : "");
  if (j.images && j.images.length) return j.images[0];
  if (j.stems) return `${j.stems} stems`;
  if (j.lrc) return j.lrc;
  return "";
}

let jobFilter = "all";

/* THE LIVE QUEUE, itemised and cancellable.
 *
 * There was a global Stop and nothing between it and waiting: one mistyped job
 * behind forty good ones could only be dealt with by throwing away all
 * forty-one. Each waiting row drops on its own; the running row is stopped
 * separately because interrupting a render in flight costs real work and
 * should not share a button with "remove this from the list". */
function paintJobQueue(s) {
  const box = $("jobQueue");
  if (!box) return;
  const art = (s && s.art) || {};
  const cur = art.current;
  const items = art.items || [];
  if (!cur && !items.length) { box.innerHTML = ""; return; }

  const pct = Math.round((cur?.progress || 0) * 100);
  box.innerHTML =
    (cur ? `<div class="qjob running">
        <span class="jobkind">${esc(JOB_LABEL[cur.kind] || cur.kind || "")}</span>
        <span class="jobtitle">${esc(cur.title || cur.file || "")}</span>
        <span class="qbar"><i style="width:${pct}%"></i></span>
        <span class="jobms">${pct}%${cur.elapsed ? ` · ${jobDur(cur.elapsed * 1000)}` : ""}</span>
        <button type="button" class="qkill" data-stopcurrent="1"
          title="Interrupt this render — the queue behind it carries on">stop</button>
      </div>` : "")
    + items.map((j) => `<div class="qjob">
        <span class="jobkind">${esc(JOB_LABEL[j.kind] || j.kind || "")}</span>
        <span class="jobtitle">${esc(j.title || j.file || "")}</span>
        <span class="qbar"></span>
        <span class="jobms">waiting</span>
        <button type="button" class="qkill" data-drop="${esc(j.file)}"
          title="Remove this from the queue">&times;</button>
      </div>`).join("");
}

document.addEventListener("click", async (e) => {
  const drop = e.target.closest("[data-drop]");
  const stop = e.target.closest("[data-stopcurrent]");
  if (!drop && !stop) return;
  e.preventDefault();
  const btn = drop || stop;
  btn.disabled = true;
  try {
    const body = drop ? { action: "drop", file: drop.dataset.drop } : { action: "stop_current" };
    const r = await fetch("/api/artqueue", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (j.art) { state.lastStatus = { ...(state.lastStatus || {}), art: j.art }; paintJobs(state.lastStatus); }
  } catch { btn.disabled = false; }
});

function paintJobs(s) {
  const list = $("jobList");
  if (!list) return;
  paintJobQueue(s);
  const jobs = (s && s.art && s.art.recent) || [];

  /* ⚠ SAY SO WHEN THERE IS NOTHING, and say WHY. An empty list on a night that
   * clearly rendered things reads as a broken page; the real reason is that
   * this log lives in memory and a server restart clears it. */
  if (!jobs.length) {
    /* NB: paintJobQueue already ran above, so a session with a full queue and
     * no finished jobs yet still shows the queue rather than only "nothing". */
    $("jobSummary").innerHTML = "";
    $("jobFilter").innerHTML = "";
    list.innerHTML = `<p class="hint">No finished jobs yet this session. `
      + `This list is kept in memory, so it starts empty after the server restarts — `
      + `assets from earlier sessions are still in their own libraries.</p>`;
    return;
  }

  const kinds = [...new Set(jobs.map((j) => j.kind))].sort();
  $("jobFilter").innerHTML = ["all", ...kinds].map((k) =>
    `<button type="button" class="jobchip${jobFilter === k ? " on" : ""}" data-jobfilter="${esc(k)}">`
    + `${esc(JOB_LABEL[k] || k)}${k === "all" ? "" : ` ${jobs.filter((j) => j.kind === k).length}`}</button>`).join("");

  const totalMs = jobs.reduce((n, j) => n + (j.ms || 0), 0);
  const failed = jobs.filter((j) => j.error).length;
  const byKind = {};
  for (const j of jobs) {
    const b = byKind[j.kind] || (byKind[j.kind] = { n: 0, ms: 0 });
    b.n++; b.ms += j.ms || 0;
  }
  $("jobSummary").innerHTML =
    `<div class="jobstat"><b>${jobs.length}</b><span>jobs</span></div>`
    + `<div class="jobstat"><b>${jobDur(totalMs) || "—"}</b><span>total render</span></div>`
    + Object.entries(byKind).sort((a, b) => b[1].ms - a[1].ms).slice(0, 4).map(([k, v]) =>
        `<div class="jobstat"><b>${jobDur(v.ms) || "—"}</b><span>${esc(JOB_LABEL[k] || k)} ×${v.n}</span></div>`).join("")
    + (failed ? `<div class="jobstat bad"><b>${failed}</b><span>failed</span></div>` : "");

  const shown = jobs.filter((j) => jobFilter === "all" || j.kind === jobFilter);
  list.innerHTML = shown.map((j) => {
    const view = JOB_VIEW[j.kind] || "create";
    const out = jobOutput(j);
    const when = j.at ? new Date(j.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    return `<div class="jobrow${j.error ? " bad" : ""}">
      <span class="jobkind">${esc(JOB_LABEL[j.kind] || j.kind)}</span>
      <span class="jobtitle">${esc(j.title || j.file || "—")}</span>
      <span class="jobout">${esc(out)}</span>
      <span class="jobms">${jobDur(j.ms)}</span>
      <span class="jobat">${esc(when)}</span>
      ${j.error ? `<span class="joberr" title="${esc(j.error)}">failed</span>`
                : `<a href="#" class="jobgo" data-go="${view}">open ${esc(view)} &rsaquo;</a>`}
    </div>`;
  }).join("");
}

document.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-jobfilter]");
  if (!chip) return;
  jobFilter = chip.dataset.jobfilter;
  paintJobs(state.lastStatus);
});

/* The mini queue under the RAM bar: what is rendering, what is next, and an
 * HONEST remaining estimate. ETAs come from the session's own measured
 * per-kind averages (art.stats) plus the engine's real per-step progress for
 * the current job — never a made-up constant when a measurement exists.
 * (FORK — see FORK_DELTA.md.) */
const KIND_FALLBACK = { video: 420, cover: 15, stems: 120, lrc: 90, restyle: 240, enhance: 180 };
const KIND_LABEL = { video: "video clip", cover: "image", stems: "stems", lrc: "timed lyrics", restyle: "restyle", enhance: "enhance" };
function fmtEta(s) {
  if (!Number.isFinite(s) || s <= 0) return "";
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
function paintMiniQueue(s) {
  const box = $("miniQ");
  if (!box) return;
  const a = s.art || {};
  const music = s.current ? 1 : 0;
  const musicQ = (s.queue || []).length;
  const unknownNative = nativeMusicPending(s);
  const artQ = a.queued || 0;
  const running = a.current || (s.current ? { kind: "music", title: s.current.title } : null);
  const total = music + musicQ + (a.current ? 1 : 0) + artQ;

  if (!total) {
    // Show the tally line briefly after work finishes, then rest.
    if (a.doneCount) {
      box.hidden = false;
      $("miniqNow").textContent = "idle";
      $("miniqNext").hidden = true;
      $("miniqTally").textContent = `${a.doneCount} job${a.doneCount > 1 ? "s" : ""} done this session`;
    } else box.hidden = true;
    return;
  }
  box.hidden = false;

  // Current job + its ETA from the engine's real progress when it has one.
  let curEta = 0;
  if (a.current) {
    const p = a.current.progress, el = a.current.elapsed || 0;
    curEta = p > 0.05 ? Math.max(0, el / p - el)
      : Math.max(0, (a.stats?.[a.current.kind]?.avg ?? KIND_FALLBACK[a.current.kind] ?? 180) - el);
    $("miniqNow").textContent = `▶ ${KIND_LABEL[a.current.kind] || a.current.kind} · ${a.current.title || ""}`.slice(0, 46)
      + (curEta ? ` · ~${fmtEta(curEta)}` : "");
  } else if (s.current) {
    const native = s.current.engine === "yue2-gguf" && !ggufEtaKnown(s.current);
    curEta = native ? 0 : s.current.etaSeconds || 0;
    $("miniqNow").textContent = `▶ song · ${s.current.title || ""}`.slice(0, 46)
      + (native ? " · ETA unavailable" : curEta ? ` · ~${fmtEta(curEta)}` : "");
  } else {
    $("miniqNow").textContent = unknownNative ? "Waiting · ETA unavailable" : "Waiting";
  }

  // What comes next, by name where known, by kind-count otherwise.
  const nexts = (a.nextTitles || []).map((n) => `${KIND_LABEL[n.kind] || n.kind}: ${n.title}`.slice(0, 40));
  if (musicQ) nexts.unshift(`song ×${musicQ}`);
  $("miniqNext").hidden = !nexts.length;
  $("miniqNext").textContent = nexts.length ? "next: " + nexts.slice(0, 2).join(" · ") + (artQ + musicQ > 2 ? " …" : "") : "";

  // The tally: done / total this session, and the honest remaining estimate.
  let remaining = curEta;
  for (const [kind, n] of Object.entries(a.queuedKinds || {})) {
    remaining += n * (a.stats?.[kind]?.avg ?? KIND_FALLBACK[kind] ?? 180);
  }
  for (const job of (s.queue || [])) {
    if (job.engine === "yue2-gguf") continue;
    remaining += Number(job.etaSeconds) > 0 ? Number(job.etaSeconds)
      : (s.current?.engine !== "yue2-gguf" && s.current?.etaSeconds) || 180;
  }
  const done = a.doneCount || 0;
  $("miniqTally").textContent =
    `${total} job${total > 1 ? "s" : ""} remaining${done ? ` · ${done} done` : ""}${unknownNative ? " · ETA unavailable" : remaining > 30 ? ` · eta ≈ ${fmtEta(remaining)}` : ""}`;
}

// Use the real mark if it is there, fall back to the wordmark if not.
// The <img> starts hidden but the browser still loads it, so by the time this
// module runs it is often ALREADY complete and `onload` never fires — which is
// exactly why the logo stayed invisible. Check `complete` first.
const logo = $("logo");
const showLogo = () => { logo.hidden = false; };
if (logo.complete) {
  if (logo.naturalWidth > 0) showLogo(); else logo.remove();
} else {
  logo.onload = showLogo;
  logo.onerror = () => logo.remove();
}

extractSettings();   // before attachHelp, so the ⓘ icons follow their controls
attachHelp();
visClaim();
setMode("song");
/* THE BOOT DEFAULT IS WELCOME (the owner's call, 2026-09-19): the mark, the
 * name and one row of ways in — Chat, Music, Video, Image, Explore. Chat and
 * Music sit under Create in the rail; Explore is Community, to be reworked.
 * setMode("song") still runs above, so the Music form is already in the state
 * it always was the moment you click Music. */
setView("home");
setGrid(localStorage.getItem("aiplayGrid") === "1");
ovRender();
paintSeed();
paintScaffold();
$("maxDur").oninput();
$("qSteps").oninput();
$("qCfg").oninput();
$("qArCfg").oninput();
poll().then(() => initWelcome({autoOpen:!state.musicOnly}));
setInterval(poll, 4000);
connect();
loadCommunity();
setInterval(loadCommunity, 120000);
loadVersion();                                     // the line under the Welcome logo
// Video Workflow (fork-only). The library is passed by reference at boot and the
// picker re-reads it on paint, so the late-arriving track list is picked up.
initWorkflow(state.library || []);
/* The ⓘ on every screen. Mounted at boot so a view nobody has opened yet still
 * carries one, and again from setView for the screens that rebuild themselves.
 * A panel fetches nothing until it is opened. */
mountAllInfo();
/* The score panel's listeners. Mounted at boot rather than on first open so the
 * <details> toggle has something listening the first time it is clicked; it
 * fetches nothing until then. Hidden or shown by musicEnginePaint() from the
 * engine's `score` capability. */
mountScorePanel();
mountMusicPlan();
/* LAST, and asynchronous. One request answers both "what can this studio do"
 * and "has this person been shown around", so a fresh install opens the window
 * on the same round trip that fills it — and an older server with no
 * /api/welcome costs a new user a welcome screen and nothing else. Its own
 * failure is swallowed inside; nothing above depends on it. */
// The first status response chooses the native setup or the full-suite welcome.

/* ── leaving for the DAW or Avatars ─────────────────────────────────────────
 * Those are separate pages, so going there reloads the app and whatever is
 * typed into the Music panel — lyrics, style, title, a message to the Simple
 * assistant, a pasted score — is gone. Ask first, but only when there is
 * something to lose; an empty form just goes. A click with Ctrl/Shift/middle
 * button opens a new tab and loses nothing, so it is left alone. */
function unsavedMusicWork() {
  const typed = ["lyrics", "caption", "title", "capMeta", "capVocal", "capArr", "simpleText", "yAbc"]
    .some((id) => String($(id)?.value || "").trim());
  const chatted = ($("simpleLog")?.querySelectorAll(".simple-row").length || 0) > 0;
  return typed || chatted;
}
document.addEventListener("click", async (e) => {
  const a = e.target.closest?.('a[href$="daw.html"], a[href$="avatars.html"]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  if (a.target && a.target !== "_self") return;
  if (!unsavedMusicWork()) return;
  e.preventDefault();
  const where = /avatars\.html$/.test(a.getAttribute("href")) ? "Avatars" : "the DAW";
  const go = await appConfirm(
    `${where === "Avatars" ? "Avatars opens" : "The DAW opens"} as a separate page, so anything you have written here and not generated yet — lyrics, style, title or a message to the assistant — will be cleared.`,
    { title: `Open ${where}?`, ok: "Leave page", cancel: "Stay here", tone: "warn" });
  if (go) location.href = a.href;
}, true);
