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

import { initStudio, studioRefresh } from "./studio.js";
import { initGames } from "./games.js";
import { initVfx, vfxOpen } from "./vfx.js";
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

const STYLE_CHIPS = [
  "indie folk", "brushed drums", "close-mic vocal", "92 BPM",
  "dark synthwave", "analog pads", "lo-fi hip hop", "warm tape",
  "orchestral", "female vocal", "male vocal", "instrumental",
];

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
  $("seedLock").textContent = state.seedLocked ? "🔒 locked" : "🔓 lock";
  // The caveat has to live in the UI. Lyrics are part of the prompt and are
  // prefilled before any frame is decoded, so editing them changes every frame —
  // a locked seed cannot hold the song across a lyric edit. Without saying so,
  // "I changed one word and got a different song" is a guaranteed support ticket.
  $("seedNote").innerHTML = state.seedLocked
    ? "Same seed and same lyrics gives the identical file, every time. <b>Editing lyrics still gives a new song</b> — the seed can’t hold that."
    : "A fresh seed each time — a different song from the same words.";
}
$("seedLock").onclick = () => { state.seedLocked = true; paintSeed(); };
$("seedRand").onclick = () => {
  state.seedLocked = false;
  $("seed").value = Math.floor(Math.random() * 4294967296);
  paintSeed();
};

/* ── chips + tags ─────────────────────────────────────── */
const chipsEl = $("chips");
for (const c of STYLE_CHIPS) {
  const b = document.createElement("button");
  b.className = "chip";
  b.type = "button";
  b.textContent = c;
  b.onclick = () => {
    const t = $("caption");
    t.value = t.value.trim() ? `${t.value.replace(/,\s*$/, "")}, ${c}` : c;
    t.focus();
  };
  chipsEl.appendChild(b);
}
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
const OFFICIAL_TAGS = ["Intro", "Verse", "Pre-Chorus", "Chorus", "Post-Chorus",
  "Bridge", "Instrumental", "Solo", "Break", "Build", "Drop", "Breakdown", "Outro"];

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

function setMode(m) {
  state.mode = m;
  $("modeSong").setAttribute("aria-pressed", String(m === "song"));
  $("modeInstr").setAttribute("aria-pressed", String(m === "instrumental"));
  $("lyricsField").hidden = m === "instrumental";
  $("instrField").hidden = m !== "instrumental";
  if (m === "instrumental") paintScaffold();
  countChars();
}

/* ── examples ─────────────────────────────────────────── */
$("exPick").innerHTML = '<option value="">Start from an example…</option>' +
  EXAMPLES.map((e) => `<option value="${e.id}">${esc(e.label)}</option>`).join("");

$("exPick").onchange = () => {
  const e = EXAMPLES.find((x) => x.id === $("exPick").value);
  if (!e) return;
  // Loading over unsaved work is the one destructive thing this control can do.
  if (($("caption").value.trim() || $("lyrics").value.trim()) &&
      !confirm("Replace what is in the form with this example?")) {
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
  $("exPick").value = "";
};

$("lyricTags").innerHTML =
  `<button class="ihelp" type="button" data-help="tags" aria-label="What are section tags?">i</button>` +
  OFFICIAL_TAGS.map((t) => `<button class="tag" type="button" data-tag="[${t}]">${t}</button>`).join("");

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
$("modeSong").onclick = () => setMode("song");
$("modeInstr").onclick = () => setMode("instrumental");

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
    if (lab) lab.appendChild(mk(id, title, body));
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

  stopExtend();
  setView("create");
  setMode(t.instrumental ? "instrumental" : "song");
  $("title").value = t.title || "";
  setGuided(false);
  $("caption").value = t.caption || "";
  if (!t.instrumental) $("lyrics").value = t.lyrics || "";

  // The settings too, or "reuse" only half means it.
  if (t.steps) $("qSteps").value = t.steps;
  if (t.arCfg) $("qArCfg").value = t.arCfg;
  if (t.cfg || t.flowCfg) $("qCfg").value = t.flowCfg ?? t.cfg;
  if (t.model) $("qModel").value = t.model;
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
const xt = { file: null, dur: 0, at: 0, peaks: null, drag: false };

async function startExtend(file) {
  const t = (state.library || []).find((x) => x.file === file);
  if (!t) return;
  if (!t.codes) {
    $("xtNote").textContent = "This take has no saved performance, so it cannot be extended.";
    return;
  }
  xt.file = file;
  xt.dur = t.durationSeconds || 0;
  xt.at = Math.max(1, xt.dur * 0.8);
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
  $("btnCreate").textContent = "Extend";
  $("xtLoad").hidden = false;
  paintXt();
  countChars();

  try {
    const j = await (await fetch(`/api/peaks/${encodeURIComponent(file)}`)).json();
    if (!j.ok) throw new Error(j.error || "no peaks");
    xt.dur = j.seconds || xt.dur;
    xt.peaks = Float32Array.from(j.peaks);
    xt.at = Math.min(xt.at, Math.max(1, xt.dur - 0.5));
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
  const pct = xt.dur ? (xt.at / xt.dur) * 100 : 0;
  $("xtKeep").style.width = `${pct}%`;
  $("xtNew").style.width = `${100 - pct}%`;
  $("xtHandle").style.left = `${pct}%`;
  if (document.activeElement !== $("xtFrom")) $("xtFrom").value = tf(xt.at);
  $("xtNote").textContent = xt.dur
    ? `Keeps the first ${tf(xt.at)} exactly as it is, then writes a new ending. The original file is never changed.`
    : "";
}

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
$("xtWrap").addEventListener("pointerdown", (e) => {
  if (!xt.dur) return;
  xt.drag = true;
  try { $("xtWrap").setPointerCapture(e.pointerId); } catch { /* drag on, untracked past the edge */ }
  xt.at = xtAtFromEvent(e); paintXt();
});
$("xtWrap").addEventListener("pointerup", () => { xt.drag = false; });
$("xtWrap").addEventListener("pointermove", (e) => {
  if (!xt.dur) return;
  if (xt.drag) { xt.at = xtAtFromEvent(e); paintXt(); }
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
  const firstLine = $("lyrics").value.trim().split("\n").find((l) => l && !l.startsWith("["));
  return {
    // Title is metadata only — the model has no title input. It names the library
    // entry and goes into the exported file's tags, nothing more.
    title: ($("title").value.trim() || firstLine || (instrumental ? "Instrumental" : "Untitled")).slice(0, 60),
    caption: captionValue(),
    // Instrumental sends the section scaffold, not an empty string. See above.
    lyrics: instrumental ? scaffold(+$("sections").value) : $("lyrics").value,
    instrumental,
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
  };
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
  [0.62, "near-copy", "Almost the same song, re-rendered. Use it to clean up or restyle a take you already like."],
  [0.72, "variation", "Clearly the same piece, different performance and instrumentation."],
  [0.82, "remix", "The arrangement and timing survive; the sound is mostly yours."],
  [0.88, "cover", "A genuine blend — its shape, your character. This is the useful setting for most references."],
  [1.01, "loose", "Barely holds on to the reference. Above this the reference stops mattering at all."],
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
  const spec = currentSpec(preview, mixSeed);
  if (!spec.caption.trim()) { $("caption").focus(); return; }
  spec.reusesConditioning = reusesConditioning(spec);
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
    if (j.error) alert(j.error);
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
    setTimeout(() => { $("btnCreate").disabled = $("btnPreview").disabled = !state.engineReady; }, 400);
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
    const r = await fetch("/api/extend", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file,
        fromSeconds: xt.at,
        seconds: 45,
        caption: captionValue(),
        // Send the edited words. Leaving this out makes the server append its own
        // continuation sections; supplying them means you decide where it goes.
        lyrics: $("lyrics").value,
        seed: Math.floor(Math.random() * 4294967296),
      }),
    }).then((x) => x.json());
    if (r.error) { $("xtNote").textContent = r.error; return; }
    stopExtend();
    poll();
  } finally {
    $("btnCreate").disabled = false;
  }
}
$("btnPreview").onclick = () => generate(true);
$("btnCancel").onclick = () => fetch("/api/cancel", { method: "POST" });

/* ── live state ───────────────────────────────────────── */
const STAGES = ["composing", "arranging", "mixing", "saving"];
const LABEL = { composing: "composing", arranging: "arranging", mixing: "mixing down", saving: "saving" };

function renderNow(cur, queued = 0) {
  const box = $("nowBox");
  if (!cur) { box.hidden = true; return; }
  box.hidden = false;
  // Position first, then time. With a queue running, "which one is this" is the
  // question people actually have — the ETA only covers the song in flight.
  const total = queued + 1;
  const pos = total > 1 ? `1 of ${total} in queue · ` : "";
  $("nowTitle").textContent = (cur.preview ? "Preview · " : "") + (cur.title || "Untitled");
  $("nowEta").textContent = cur.state === "running"
    ? pos + (cur.etaSeconds > 60 ? `~${Math.floor(cur.etaSeconds / 60)} min ${String(cur.etaSeconds % 60).padStart(2, "0")} s left` : `~${cur.etaSeconds} s left`)
    : pos + cur.state;

  const at = STAGES.indexOf(cur.stage);
  $("nowStages").innerHTML = STAGES.map((s, i) => {
    const cls = i < at ? "done" : i === at ? "now" : "";
    const pct = i === at && cur.stageProgress ? ` ${Math.round(cur.stageProgress * 100)}%` : "";
    return `<span class="s ${cls}">${i < at ? "✓ " : i === at ? "◆ " : ""}${LABEL[s]}${pct}</span>`;
  }).join('<span class="sep"></span>');

  $("nowBar").style.width = `${Math.round((cur.overall || 0) * 100)}%`;
  $("nowMeta").textContent = cur.preview ? "preview · 6 steps" : "shift 5 · 15 steps · seed " + cur.seed;
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
  if (snap.library) state.library = snap.library;
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
  if (f === "starred") done = done.filter((t) => t.starred);
  else if (f === "pinned") done = done.filter((t) => t.pinned);
  else if (f === "up") done = done.filter((t) => t.rating === 1);
  else if (f === "song") done = done.filter((t) => !t.instrumental);
  else if (f === "instrumental") done = done.filter((t) => t.instrumental);

  const SORTS = {
    new:   (a, b) => b.createdAt - a.createdAt,
    old:   (a, b) => a.createdAt - b.createdAt,
    long:  (a, b) => (b.durationSeconds || 0) - (a.durationSeconds || 0),
    short: (a, b) => (a.durationSeconds || 0) - (b.durationSeconds || 0),
    title: (a, b) => String(a.title).localeCompare(String(b.title)),
  };
  done = [...done].sort(SORTS[$("libSort").value] || SORTS.new);

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
      <div class="row"><div class="art" style="background:${art(j.seed)}"></div>
        <div class="rmeta"><span class="rtitle">${esc(j.title)}</span>
          <span class="rsub">${i + 2} of ${snap.queue.length + 1} in queue${j.preview ? " · preview" : ""}</span></div>
        <div class="rside"><span>~${fmt(j.etaSeconds)}</span></div></div>`).join("");

  // Grouping is suppressed while searching: a search is already a filter across
  // the whole library, and slicing three matches into three separate groups
  // makes them harder to see rather than easier.
  const mode = q ? "" : $("libGroup").value;
  rows.innerHTML = queueHtml + (mode ? groupedHtml(done, mode) : done.map(rowHtml).join(""));
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
    r.label = `${day} · session ${n}`;
    r.when = r.items[0].createdAt;
  }
  // Newest session first — the one you just made is the one you want.
  return runs.reverse().map((r) => ({ ...r, items: [...r.items].reverse() }));
}

function groupedHtml(tracks, mode) {
  if (!state.collapsed) state.collapsed = new Set();
  return groupsOf(tracks, mode).map((g) => {
    const open = !state.collapsed.has(g.id);
    const secs = g.items.reduce((s, t) => s + (t.durationSeconds || 0), 0);
    return `
      <div class="grp${open ? " open" : ""}">
        <button class="grphead" type="button" data-grp="${esc(g.id)}" aria-expanded="${open}">
          <span class="caret">${open ? "▾" : "▸"}</span>
          <span class="glabel">${esc(g.label)}</span>
          <span class="gmeta">${g.items.length} track${g.items.length > 1 ? "s" : ""}${secs ? ` · ${fmt(secs)}` : ""}</span>
        </button>
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
    <div class="row${playing ? " playing" : ""}" data-file="${f}" data-seed="${j.seed}" data-title="${esc(j.title)}">
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
    ["data-edit", f, "Edit audio", "", "Trim, cut, fade, reverse, speed"],
    ["data-addpl", f, "Add to playlist", "", "Add to a playlist"],
    ["data-reveal", f, "Show in Explorer", "", "The file already exists on disk"],
    ["data-trash", f, "Move to trash", "", "Reversible — it moves to output/trash"],
  ];
  return items
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

  const live = (feed?.sessions || []).length + (feed?.parties || []).length;
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
      ? `<b>${esc(chal.title)}</b> is running — submit a track on AI PLAY.`
      : `<b>${live}</b> ${live === 1 ? "room is" : "rooms are"} live on AI PLAY right now.`;
  }
  // Visibility is paintComm's job; from here down we only fill the pane. Skip
  // the work when it is not on screen — the refresh timer runs regardless of
  // which tab is open.
  if (state.view !== "community") return;

  /* Style packs.
   *
   * Rendered BEFORE the live-room early-return below, deliberately: packs do not
   * expire, so they are the one block that still has something to show when
   * nothing is live. Gating them on `live` — as everything else here is — would
   * have kept the page blank exactly when it most needed content. */
  const packs = feed?.stylePacks || [];
  state.packs = packs;
  $("commPacksHead").hidden = !packs.length;

  /* Blog posts. The one section on this page that works regardless of the
   * desktop feed, so it is also the answer to "why is this tab empty". Opens in
   * the browser rather than in-app: these are articles, and Studio is not a
   * reader. */
  // `blogPosts`, not `posts` — this function already has a `posts` further down
  // (the feed's own social posts) and shadowing it silently killed all of app.js.
  const blogPosts = feed?.articles || [];
  const blogSite = (state.site || "https://aiplay.live").replace(/\/+$/, "");
  $("commBlogHead").hidden = !blogPosts.length;
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
  $("commPacks").innerHTML = packs.map((p, i) => `
    <div class="card pack" data-pack="${i}" role="button" tabindex="0">
      <h3>${esc(p.name)}</h3>
      <div class="packchips">${(p.chips || []).map((c) => `<span class="tag">${esc(c)}</span>`).join("")}</div>
      <div class="foot"><span>${(p.chips || []).length} tags</span><span class="use">Use this →</span></div>
    </div>`).join("");

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
  $("commRadioHead").hidden = !stations.length;
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
  $("commEmpty").hidden = live > 0 || packs.length > 0 || stations.length > 0
    || discords.length > 0 || blogPosts.length > 0;
  $("commLiveHead").hidden = !live;
  $("commCount").textContent = live ? `${live} on now` : "";
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

  /* Upcoming, within 24 hours only.
   * Its own block rather than mixed into "Happening now" — a room that has not
   * started yet is a different proposition from one you can walk into, and
   * merging them makes the live count a lie. */
  const parties = feed.parties || [];
  $("commSoonHead").hidden = !parties.length;
  $("commSoon").innerHTML = parties.map((p) => `
    <div class="card">
      ${p.art ? `<div class="cardart"><img class="blur" src="${esc(p.art)}" alt="" aria-hidden="true" loading="lazy" referrerpolicy="no-referrer"><img class="fit" src="${esc(p.art)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>` : `<div class="cardart none"></div>`}
      <div class="cardtop"><span class="lab soon">Soon</span><span class="when">${esc(p.startsIn || "")}</span></div>
      <h3>${esc(p.title)}</h3><p class="by">hosted by ${esc(p.host)}</p>
      <div class="foot"><span>${p.going ? `${p.going} going` : ""}</span>
        ${p.streamUrl ? `<button class="join watch" data-url="${esc(p.streamUrl)}">Watch ↗</button>` : ""}
        <button class="join" data-url="${esc(p.url)}">Open ↗</button></div></div>`).join("");
  // Everything opens in the real browser, where the user is already signed in.
  $("commGrid").querySelectorAll(".join").forEach((b) => {
    b.onclick = () => window.open(b.dataset.url, "_blank", "noopener");
  });
  // Name the host we will actually open, rather than always claiming aiplay.live
  // while pointing at dev.
  const host = state.site ? state.site.replace(/^https?:\/\//, "") : "aiplay.live";
  $("commNote").textContent = `Opens on ${host} in your browser, where you are already signed in.`;
}
/* A pack fills the form and takes you to Create.
 *
 * Deliberately NOT a link to the website. Everything else on this tab sends the
 * user away to listen; a style pack is the one item that gives them something to
 * make, so it should land in the editor with the fields already filled. */
function usePack(i) {
  const p = (state.packs || [])[i];
  if (!p) return;
  $("caption").value = (p.chips || []).join(", ");
  if (!$("title").value.trim()) $("title").value = p.name;
  setView("create");
  $("caption").dispatchEvent(new Event("input", { bubbles: true }));
  $("caption").focus();
}
$("commPacks").addEventListener("click", (e) => {
  const c = e.target.closest("[data-pack]");
  if (c) usePack(Number(c.dataset.pack));
});
$("commPacks").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const c = e.target.closest("[data-pack]");
  if (c) { e.preventDefault(); usePack(Number(c.dataset.pack)); }
});

$("commOpen").onclick = () => window.open(state.siteSessions || "https://aiplay.live/sessions", "_blank", "noopener");
$("commRefresh").onclick = () => loadCommunity();
$("commBarGo").onclick = () => { setView("community"); loadCommunity(); };

function onRowClick(e) {
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
        if (!confirm("Video clips are switched off. MiniMax H3 is about 34 GB, and its "
          + "licence excludes the EU, the UK and South Korea. Switch it on and make a clip?")) return;
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
    const next = prompt("Title for this track:", cur?.title || "");
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
    const pick = prompt(`Add to which playlist?\n\n${names}`, "1");
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
        /* Say WHERE it went. The converted file lands in the engine's output
         * folder next to the renders, not in the library list, so a silent
         * success looks identical to nothing happening. */
        /* ⚠ `alert`, because this app has no toast. An earlier version wrote
         * `toast?.(...)` as a "safe" call -- but optional chaining only guards
         * a declared binding that is null; on an UNDECLARED identifier it
         * throws ReferenceError. That would have failed on every successful
         * export, which is the one path least likely to get tested. */
        alert(`Saved ${d.file} in ${d.subfolder || "output"}`);
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
    if (onArt && isPlaying) { audio.pause(); $("pPlay").textContent = "▶"; return; }
    // Play and highlight. The details panel used to spring open on every click,
    // which put a sheet over the library just to start a track — the row's own
    // highlight already says which one is playing. Open details deliberately
    // by clicking the title instead.
    play(row.dataset.file, row.dataset.title, row.dataset.seed);
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
  const id = h.dataset.grp;
  if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
  renderList(state.lastSnap || { queue: [], history: [], library: state.library });
});
$("libGroup").onchange = () => {
  // Collapsed ids are mode-specific ("s:..." vs "t:..."), so switching mode
  // starts everything expanded rather than half-collapsing the new grouping.
  state.collapsed = new Set();
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
  $("songPanel").hidden = false;
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
function paintExtend(t) {
  $("spExtendSec").hidden = !(t?.codes && t?.durationSeconds);
}

const currentSong = () => (state.library || []).find((x) => x.file === state.songFile);

// Hands off to the input panel, where the lyrics and the waveform are.
$("spExtend").onclick = () => { if (state.songFile) startExtend(state.songFile); };

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
  move([...adv.querySelectorAll(".pk")].find((e) => e.textContent.trim().startsWith("schedule")));
  move([...adv.querySelectorAll(".pk")].find((e) => e.textContent.trim().startsWith("visualiser")));
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
  if (!d) return;
  state.models = d;

  const missing = d.capabilities.filter((c) => !c.ready && !c.managedByPackage).length;
  $("modelPip").hidden = missing === 0;

  // Free space next to the download buttons: "12.45 GB to download" is only half
  // the question, and running out mid-download leaves a .part and a puzzle.
  const disk = d.disk ? ` · ${gb(d.disk.freeBytes)} free on disk` : "";
  $("modelsTotal").textContent =
    `${d.capabilities.filter((c) => c.ready).length} of ${d.capabilities.length} ready${disk}`;
  state.diskFree = d.disk?.freeBytes ?? Infinity;
  $("modelList").innerHTML = d.capabilities.map((c) => {
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
      <div class="modelcard${c.ready ? " ready" : ""}">
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
  }).join("");

  $("modelsNote").textContent = d.python?.packages && !d.python.packages.torch
    ? `No python found at ${d.python.path} — the stem and lyric features need it.`
    : "";
}
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

function vidPaint() {
  const on = !!state.video?.enabled;
  const engines = state.video?.engines || {};
  const cur = state.video?.engine || "ltx";
  const eng = engines[cur] || {};

  // Painted once; after that the select is left alone so it cannot fight a change.
  if (!state.vidEnginesPainted && Object.keys(engines).length) {
    state.vidEnginesPainted = true;
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
      .map((z) => '<option value="' + z.w + "x" + z.h + '">' + esc(z.label) + "</option>").join("");
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
  $("vidRefSong").innerHTML = '<option value="">…or use a song from the library</option>'
    + (state.library || []).map((t) => `<option value="${esc(t.file)}">${esc(t.title || t.file)}</option>`).join("");
  // The soundtrack select IS state (like vidFrom), so its value is preserved.
  const curSnd = $("vidSndSong").value;
  $("vidSndSong").innerHTML = '<option value="">No soundtrack — LTX invents its own sound</option>'
    + (state.library || []).map((t) => `<option value="${esc(t.file)}">${esc(t.title || t.file)}</option>`).join("");
  $("vidSndSong").value = curSnd;

  paintFramePreviews();

  /* Cost model fitted to four measured points (see config.video). Superlinear in
   * pixels x frames, because attention is quadratic in token count — a linear
   * rate under-quotes the native size by well over a minute. */
  const [w, h] = ($("vidSize").value || "1280x704").split("x").map(Number);
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
  $("vidEst").textContent = on
    ? "about " + fmt(secs) + " once the engine is idle · " + frames + " frames at " + fps + " fps"
      + (short ? " · ⚠ under the model's trained range (124+)" : "")
      + (small && !short ? " · ⚠ below native size, expect softer detail" : "")
      // 8 is the measured fast setting, 20 the measured good one. Anything under
      // 8 is below what the turbo LoRA was distilled for.
      + (cur !== "ltx" && +$("vidSteps").value < 8 ? " · ⚠ fewer steps than the LoRA was distilled for" : "")
      // Which sampling path the step count lands on — the turbo LoRA applies
      // only in its distillation range; above it the bare model runs on its
      // native schedule (the vendor flow, measured smoother).
      + (cur !== "ltx" ? (+$("vidSteps").value <= 12 ? " · fast turbo path" : " · full-model path") : "")
      // Reference tokens are attended on every step, so they cost time. One
      // measured point: one picture at 864x480x124 added ~10% — more and
      // larger references cost more.
      + (cur === "h3" && ((state.refImages || []).length + (state.refAudios || []).length)
          ? " · references ride along, expect it slower" : "")
      + (cur === "ltx" && sndPicked ? " · the finished clip plays your chosen audio" : "")
    : "switch video on in Settings first";
}

for (const id of ["vidSecs", "vidSteps", "vidSize", "vidGuide", "vidPin", "vidSeed"]) $(id).oninput = vidPaint;
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
  const [w, h] = ($("vidSize").value || "1280x704").split("x").map(Number);
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
  ibox.innerHTML = imgs.map((m, i) => `<figure class="midthumb">
      <img src="${esc(m.url)}" alt="" data-reftag="&lt;Picture ${i + 1}&gt;" title="Insert the tag">
      <figcaption><button class="reftag" type="button"
        data-reftag="&lt;Picture ${i + 1}&gt;" title="Insert into the description">&lt;Picture ${i + 1}&gt;</button>
        <button class="midx" type="button" data-refimgx="${i}" title="Remove">✕</button></figcaption>
    </figure>`).join("");
  const abox = $("vidRefAudPrev");
  abox.hidden = !auds.length;
  abox.innerHTML = auds.map((a, i) => `<div class="refaud">
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
  const [width, height] = $("vidSize").value.split("x").map(Number);
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
  paintClips();
}

/* The clip library. Same job as the music library — find one out of dozens — so
 * it gets the same tools: search, filter, sort. Everything is client-side
 * because the whole list is already in memory and a round trip per keystroke
 * would be slower and worse. */
function paintClips() {
  const all = state.clips || [];
  const q = ($("clipSearch").value || "").toLowerCase().trim();
  const filter = $("clipFilter").value;
  const sort = $("clipSort").value;

  let rows = all.filter((c) => {
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

function clipCard(c) {
  {
    const m = c.meta || {};
    const stem = c.name.replace(/\.(mp4|webm)$/, "");
    const badges = [
      m.engine === "ltx" ? "LTX" : m.engine === "h3" ? "H3" : null,
      m.loop ? "loop" : null,
      m.width && m.height ? `${m.width}×${m.height}` : null,
    ].filter(Boolean);
    return `<div class="clipcard">
      ${/\.(png|jpg|jpeg|webp|gif)$/i.test(c.name)
        // Imported stills and audio live in the same folder as generated clips,
        // so this grid renders three kinds of thing now. A <video> pointed at a
        // PNG shows nothing and logs a media error on every repaint.
        ? `<img src="/api/clip/${encodeURIComponent(c.name)}" alt="" loading="lazy">`
        : /\.(mp3|wav|flac|ogg|opus|m4a)$/i.test(c.name)
          ? `<audio src="/api/clip/${encodeURIComponent(c.name)}" controls preload="metadata"></audio>`
          /* data-src, NOT src. MEASURED: this grid held 27 <video> elements all
           * carrying a src with preload="metadata", and they fetched even while
           * the Studio view was on screen and this page was hidden -- 29 requests
           * and 4 MB before the user had looked at anything. `loading="lazy"` is
           * an <img>/<iframe> attribute and does nothing here, so it needs an
           * observer. */
          : `<video data-src="/api/clip/${encodeURIComponent(c.name)}#t=0.1" controls loop muted playsinline preload="none"></video>`}
      <div class="clipacts">
        ${m.prompt ? `<button data-creuse="${esc(c.name)}" title="Load this clip's settings into the form">reuse</button>` : ""}
        <button data-cboost="${esc(c.name)}" title="Smoother and bigger in one click — steps down if this machine cannot hold it">✦ boost</button>
        <button data-cenh="${esc(c.name)}" title="Choose: smoother motion, slow motion, or a larger size">enhance</button>
        <button data-creveal="${esc(c.name)}" title="Show the file in Explorer">file</button>
        <button class="warn" data-ctrash="${esc(c.name)}" title="Move to trash — reversible">✕</button>
      </div>
      <div class="clipmeta">
        <b title="${esc(m.prompt || "")}">${esc(c.title || stem)}</b>
        ${badges.map((b) => `<span class="cbadge">${esc(b)}</span>`).join("")}
        <span>${c.seconds ? `took ${fmt(c.seconds)} · ` : ""}${Math.round(c.bytes / 1024)} KB</span>
      </div>
    </div>`;
  }
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
 * is safe: anything already given a src has no data-src left to match. */
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
  const boost = e.target.closest("[data-cboost]");
  const trash = e.target.closest("[data-ctrash]");
  if (enh) { openEnhance(enh.dataset.cenh); return; }
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
    if (!confirm(`Move ${name} to trash? It stays on disk in output/trash.`)) return;
    const r = await (await fetch("/api/clips", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "trash", name }) })).json();
    if (r.error) { alert(r.error); return; }
    loadClips();
  }
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
  const kind = im.name.toLowerCase().endsWith(".svg") ? " · SVG"
    : m.editedFrom ? " · edit" : "";
  return `<figure class="imtile${m.blur ? " blurred" : ""}" data-imgopen="${esc(im.name)}">
    <img src="/api/image/${encodeURIComponent(im.name)}" alt="" loading="lazy">
    <figcaption>
      <b title="${esc(m.prompt || "")}">${esc((m.prompt || im.name).slice(0, 70))}</b>
      <span>${when}${dur}${m.seed != null ? ` · seed ${m.seed}` : ""}${kind}</span>
    </figcaption>
  </figure>`;
}

function imgPaint() {
  const all = state.images || [];
  const q = ($("imgSearch")?.value || "").trim().toLowerCase();
  const rows = q
    ? all.filter((im) => `${(im.meta || {}).prompt || ""} ${im.name}`.toLowerCase().includes(q))
    : all;
  const grid = $("imgGrid");
  if (grid) {
    grid.innerHTML = rows.length
      ? `<div class="masonry">${rows.map(imgCard).join("")}</div>`
      : `<p class="clipempty">${q ? "Nothing matches that." : "No images yet — describe one on the left."}</p>`;
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
    .filter((im) => !im.name.endsWith(".svg"))
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
    ...(ied.text?.content ? { text: ied.text } : {}),
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
  if (iedCapLive("strokes") && ied.strokes.length) o.strokes = ied.strokes.map((s) => ({ ...s }));
  if (iedCapLive("shapes") && ied.shapes.length) o.shapes = ied.shapes.map((s) => ({ ...s }));
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
  selection: "drag a region — every adjustment and all 87 effects then apply only there",
  strokes: "drag to paint — the path goes to the server, which decides the pixels",
  shapes: "drag to draw · double-click closes a polygon",
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
    : (ied.tool === "crop" || ied.tool === "eye" || iedIsSelect(ied.tool)
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
  // A half-drawn lasso or polygon does not survive a tool change.
  ied.selDraft = null; ied.shapeDraft = null; ied.strokeDraft = null;
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
    if (ied.selDraft || ied.shapeDraft) { ied.selDraft = null; ied.shapeDraft = null; iedOverlayPaint(); return; }
    $("imgEd").hidden = true; return;
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
  const isSvg = name.toLowerCase().endsWith(".svg");
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
  };
  $("iedImg").onload = paintFromPixels;
  if ($("iedImg").complete && $("iedImg").naturalWidth) paintFromPixels();
  $("iedCropLbl").textContent = "drag on the image"; $("iedCropClear").hidden = true;
  $("iedKeyChip").hidden = true; $("iedKeyPrev").hidden = true;
  $("iedCropBox").hidden = true;
  /* An SVG is final — download or trash it. Every pixel surface goes away, and
   * so do the tools that would drive one; the whole point of a tool strip is
   * that what is lit is what works. */
  for (const id of ["iedSliders", "iedVec", "iedKey", "iedKeyPanel", "iedXform", "iedResize",
    "iedApply", "iedDockAdjust", "iedDockEffects", "iedDockLayers", "iedDockPresets",
    "iedDockFx", "iedDockSel", "iedDockPaint"]) {
    $(id).hidden = isSvg;
  }
  for (const id of ["iedCut", "iedUp"]) $(id).disabled = isSvg;
  iedRailEnable();
  iedSetTool("move");
  iedFxPaint(); iedSelPaint(); iedPaintQueuePaint(); iedCapNotes();
  iedUndoReset();
  /* Ask the server what it can do, once per session. Everything above has
   * already rendered in its OFF state, so a slow or failed probe leaves an
   * honest console rather than a half-built one. */
  iedProbeCaps().then(() => { iedFxPaint(); iedRailEnable(); });
  for (const [id, v] of [["iedB", 100], ["iedC", 100], ["iedS", 100], ["iedG", 100],
    ["iedT", 0], ["iedSh", 0], ["iedBl", 0], ["iedV", 0]]) $(id).value = v;
  $("iedDl").href = `/api/image/${encodeURIComponent(name)}`;
  $("iedDl").setAttribute("download", name);
  $("iedDocName").textContent = name;
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
  if (!ied.text?.content) { p.hidden = true; return; }
  const z = ied.view.zoom;
  p.hidden = false;
  p.textContent = ied.text.content;
  p.style.left = `${ied.view.x + ied.text.x * z}px`;
  p.style.top = `${ied.view.y + ied.text.y * z}px`;
  p.style.transform = "translate(-50%,-50%)";     // "mm" anchor, same as Pillow's
  p.style.fontSize = `${ied.text.size * z}px`;
  p.style.color = $("iedTxtColor").value;
  p.style.fontFamily = ($("iedTxtFont").value || "arial.ttf").replace(/\.(ttf|otf)$/i, "");
  const sw = +$("iedTxtStroke").value;
  p.style.webkitTextStroke = sw ? `${Math.max(1, sw * z)}px ${$("iedTxtStrokeC").value}` : "";
}
const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function iedTextUpdate() {
  const content = $("iedTxt").value.trim();
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
$("iedRot").onclick = () => { ied.rotate = (ied.rotate + 90) % 360; iedReframe(); };
$("iedFH").onclick = () => { ied.flipH = !ied.flipH; iedReframe(); };
$("iedFV").onclick = () => { ied.flipV = !ied.flipV; iedReframe(); };
$("iedReset").onclick = () => { ied.rotate = 0; ied.flipH = false; ied.flipV = false;
  for (const [id, v] of [["iedB", 100], ["iedC", 100], ["iedS", 100], ["iedG", 100],
    ["iedT", 0], ["iedSh", 0], ["iedBl", 0], ["iedV", 0]]) $(id).value = v;
  iedReframe(); };
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
      if (!ied.text?.content) { $("iedTxt").focus(); return; }
      const p = iedFramePoint(e);
      ied.text.x = p.x; ied.text.y = p.y; iedTextSync();
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
    if (ied.selDraft?.pending || ied.shapeDraft?.pending) iedOverlayPaint();
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
    iedZoomAt(e.clientX, e.clientY, ied.view.zoom * Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  /* A polygon — lasso or shape — is closed by the second click, and the browser
   * would otherwise select the whole console under the drag. */
  cv.addEventListener("dblclick", (e) => {
    e.preventDefault();
    if (ied.selDraft?.pending) iedSelClosePoly();
    else if (ied.shapeDraft?.pending) iedShapeClosePoly();
  });
}
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
  $("iedLayerList").innerHTML = iedLayers.map((l, i) => `
    <div class="wrow layerrow${i === iedLayerSel ? " on" : ""}" data-layersel="${i}">
      <span>${i + 1}\u00b7 ${esc(l.src.slice(0, 18))} <i class="dim">${esc(l.mode)}</i></span>
      <button class="edtool sm" data-layerdel="${i}">\u2715</button></div>`).reverse().join("");
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
  for (const b of document.querySelectorAll("[data-layerdel]")) {
    b.onclick = () => { iedLayers.splice(+b.dataset.layerdel, 1); iedLayerSel = -1; iedLayersPaint(); };
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
};
for (const [id, key, div] of [["iedLx", "xPct", 1], ["iedLy", "yPct", 1], ["iedLs", "scale", 100], ["iedLo", "opacity", 100]]) {
  $(id).oninput = () => {
    $(id).nextElementSibling.textContent = $(id).value + (div === 1 ? "%" : "");
    if (iedLayerSel < 0) return;
    iedLayers[iedLayerSel][key] = +$(id).value / div;
  };
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
  const name = prompt("Name this look:", "");
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
  if (!name || !confirm(`Delete the preset "${name}"?`)) return;
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
  ied.canvas = ops.canvas ? iedClone(ops.canvas) : null;
  ied.geom = ops.geometry ? iedClone(ops.geometry) : null;
  ied.crop = ops.crop ? iedClone(ops.crop) : ied.crop;
  $("iedCropClear").hidden = !ied.crop;
  $("iedCropLbl").textContent = ied.crop
    ? `${ied.crop.w}×${ied.crop.h} @ ${ied.crop.x},${ied.crop.y}` : "drag on the image";
  iedFxPaint(); iedSelPaint(); iedPaintQueuePaint();
  iedHslLoad(); iedDrawCurve(); iedPreview();
  iedPush(`preset · ${$("iedPreset").value}`);
  /* A preset written where the modules exist can carry stages this server
   * cannot run. They are loaded, shown and NOT sent — and said out loud,
   * because silently dropping half a preset is how a recipe stops matching the
   * picture it was named after. */
  const dark = [["selection", ops.selection], ["strokes", ops.strokes?.length],
    ["shapes", ops.shapes?.length], ["geometry", ops.canvas || ops.geometry]]
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
  for (const [id, k] of [["iedSelCap", "selection"], ["iedPaintCap", "strokes"]]) {
    const el = $(id); if (!el) continue;
    el.hidden = iedCapLive(k);
    el.textContent = iedCapWhy(k);
  }
  // The dock's own buttons go dark with the menu rows they mirror — one of the
  // two staying live would be a control that appears to work.
  for (const [id, k] of [["iedSelAll", "selection"], ["iedSelNone", "selection"],
    ["iedSelInv", "selection"], ["iedSelFromCrop", "selection"], ["iedSelClear", "selection"],
    ["iedStrokeUndo", "strokes"], ["iedPaintClear", "strokes"]]) {
    const el = $(id); if (!el) continue;
    el.disabled = !iedCapLive(k);
    el.title = el.disabled ? iedCapWhy(k) : "";
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
    iedStrokeGhost(x, s, s === ied.strokeDraft);
  }
  for (const s of [...ied.shapes, ...(ied.shapeDraft ? [ied.shapeDraft] : [])]) {
    iedShapeGhost(x, s, s === ied.shapeDraft);
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
      <span class="iedfxname">${esc(IED_LABEL[s.tool] || s.tool)} · ${s.points.length} pt${s.points.length === 1 ? "" : "s"}${s.size ? ` · ${s.size}px` : ""}</span>
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

/* ── §4: the seventy-five ──────────────────────────────────────────────────
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
  ied.cloneSrc = iedClone(s.cloneSrc);
  ied.selDraft = null; ied.strokeDraft = null; ied.shapeDraft = null;
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
  ["iedDockPaint", "Paint & shapes"], ["iedDockLayers", "Layers"], ["iedDockProps", "Properties"],
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
const iedHasPixels = () => !!ied.name && !ied.name.toLowerCase().endsWith(".svg");

const IED_BYID = Object.fromEntries(IED_CMDS.filter((c) => c.id).map((c) => [c.id, c]));
const IED_BYKEY = Object.fromEntries(IED_CMDS.filter((c) => c.key).map((c) => [c.key, c]));
const iedCmdEnabled = (c) =>
  (c.enabled ? c.enabled() : true) && iedCapLive(c.need) && (!c.pixels || iedHasPixels());
/* Why a row is dark, most useful answer first: a document with no pixels, then
 * a module that does not exist, then a local condition like an empty stack. */
function iedCmdWhy(c) {
  if (c.pixels && !iedHasPixels()) return "An SVG has no pixels to edit — download or trash it.";
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
  if (!confirm(`Move ${ied.name} to trash? It stays on disk in output/trash.`)) return;
  const r = await (await fetch("/api/images", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "trash", name: ied.name }) })).json();
  if (r.error) { alert(r.error); return; }
  $("imgEd").hidden = true;
  await loadImages();
};
$("imgSteps").oninput = () => { $("imgStepsV").textContent = $("imgSteps").value; };
$("imgCfg").oninput = () => { $("imgCfgV").textContent = $("imgCfg").value; };

/* Reference images for FLUX in-context editing — the API had this from day
 * one; the form finally does. Chips build the ordered list the prompt talks
 * about as "image 1", "image 2"… */
const imgRefs = [];
function imgRefsPaint() {
  $("imgRefChips").innerHTML = imgRefs.map((n, i) =>
    `<button class="refchip" data-refdel="${i}" title="${esc(n)} — click to remove">${i + 1}·${esc(n.slice(0, 14))}✕</button>`).join("");
  for (const b of document.querySelectorAll("[data-refdel]")) {
    b.onclick = () => { imgRefs.splice(+b.dataset.refdel, 1); imgRefsPaint(); };
  }
  const pick = $("imgRefPick");
  pick.innerHTML = '<option value="">+ add…</option>' + (state.images || []).slice(0, 60)
    .filter((im) => !im.name.endsWith(".svg") && !imgRefs.includes(im.name))
    .map((im) => `<option value="${esc(im.name)}">${esc((im.meta?.prompt || im.name).slice(0, 40))}</option>`).join("");
}
$("imgRefPick").onchange = () => {
  const v = $("imgRefPick").value;
  if (v && imgRefs.length < 10) { imgRefs.push(v); imgRefsPaint(); }
};

/* Engine choice re-shapes the form: checkpoint gets a model picker and a
 * negative prompt (SD-class models use them), Ideogram gets its preset pair
 * and hides steps (its presets own them). The shelf is whatever sits in
 * ComfyUI/models/checkpoints — the app lists, it does not curate. */
$("imgEngine").onchange = async () => {
  const eng = $("imgEngine").value;
  for (const el of document.querySelectorAll("[data-engineonly]")) {
    el.hidden = el.dataset.engineonly !== eng;
  }
  $("imgSteps").parentElement.hidden = eng === "ideogram4";
  $("imgSteps").parentElement.previousElementSibling.hidden = eng === "ideogram4";
  if (eng === "checkpoint" && !$("imgCkpt").options.length) {
    try {
      const d = await (await fetch("/api/checkpoints")).json();
      $("imgCkpt").innerHTML = (d.checkpoints || []).map((f) => `<option>${f}</option>`).join("")
        || '<option value="">nothing in models/checkpoints yet</option>';
    } catch { /* leave empty */ }
  }
};

$("imgGo").onclick = async () => {
  const prompt = $("imgPrompt").value.trim();
  if (!prompt) { $("imgPrompt").focus(); return; }
  const [w, h] = $("imgSize").value.split("x").map(Number);
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
        ...($("imgEngine").value === "flux2" && imgRefs.length ? { refImages: [...imgRefs] } : {}),
        ...($("imgEngine").value === "ideogram4" ? { quality: $("imgQuality").value } : {}),
        ...($("imgEngine").value === "checkpoint" ? {
          checkpoint: $("imgCkpt").value,
          negative: $("imgNeg").value.trim(),
          cfg: Number($("imgCfg").value) || 6,
        } : {}),
        count: Number($("imgCount").value) || 1,
        width: w, height: h,
        steps: Number($("imgSteps").value) || 4,
        // Blank means "roll one", and the roll is RECORDED on the result, so a
        // picture you liked can still be varied afterwards.
        ...(seedRaw === "" ? {} : { seed: Number(seedRaw) }),
      }),
    })).json();
    if (r.error) { alert(r.error); return; }
    $("imgNote").textContent = "Queued. It renders when nothing else is using the GPU.";
    // Poll until the count changes — the art queue has no push channel of its own.
    const before = (state.images || []).length;
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      await loadImages();
      if ((state.images || []).length > before) {
        $("imgNote").textContent = "Done.";
        break;
      }
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Make image";
  }
};

$("imgGrid").addEventListener("click", async (e) => {
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
    if (!confirm(`Move ${name} to trash? It stays on disk in output/trash.`)) return;
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
  thanks:    ["thanks"],
  mcp:       ["mcp"],
};

/**
 * The MCP page, filled from the running MCP server's own tool list.
 *
 * Typed out by hand it would be right today and wrong the next time a tool is
 * added — and a page that advertises a tool an agent then cannot call is worse
 * than one that says nothing.
 */
async function loadMcp() {
  const box = $("mcpTools");
  if (!box || box.dataset.loaded) return;
  let d = null;
  try { d = await (await fetch("/api/mcp")).json(); } catch { /* offline */ }
  if (!d?.tools?.length) {
    box.textContent = "Could not read the tool list — see server/mcp.js.";
    return;
  }
  box.dataset.loaded = "1";

  $("mcpConfig").textContent = JSON.stringify({
    mcpServers: {
      "aiplay-studio": {
        command: d.command,
        args: d.args,
        env: { AIPLAY_URL: d.url },
      },
    },
  }, null, 2);

  box.innerHTML = d.tools.map((t) => `
    <div class="thanksrow mcprow">
      <b><code>${esc(t.name)}</code></b>
      <span class="why">${esc(t.summary)}</span>
      ${t.required?.length
        ? `<span class="lic">needs ${t.required.map(esc).join(", ")}</span>`
        : '<span class="lic">no arguments</span>'}
    </div>`).join("");
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
  box.innerHTML = caps.map((c) => `
    <div class="thanksrow">
      <b>${c.home
        ? `<a href="${esc(c.home)}" target="_blank" rel="noopener">${esc(c.label)}</a>`
        : esc(c.label)}</b>
      <span class="lic">${esc(c.licence || "see publisher")}</span>
      <span class="why">${esc(c.why || "")}</span>
      ${c.region ? `<span class="warn">⚠ Licensed only outside ${esc((c.region.excluded || []).join(", "))}.</span>` : ""}
    </div>`).join("");
}
/* ── Reactive ───────────────────────────────────────────────────────────────
 *
 * A client for a SECOND ComfyUI. The packs are GPL-3.0 and cannot ship inside an
 * Apache-2.0 app, so Studio talks to an engine the user runs themselves — the
 * arms-length boundary that already applies to ComfyUI. When nothing answers,
 * the page shows the setup rather than controls that fail on click.
 */
const REACT_PACKS = [
  ["ComfyUI_Yvann-Nodes", "https://github.com/yvann-ba/ComfyUI_Yvann-Nodes", "GPL-3.0",
   "The audio analysis, peak detection and IPAdapter transitions this is built on. By Yvann Barbot and Lilia."],
  ["ComfyUI_IPAdapter_plus", "https://github.com/cubiq/ComfyUI_IPAdapter_plus", "Apache-2.0",
   "Conditions every frame on a mix of two reference images — the part that makes the blend continuous."],
  ["ComfyUI-AnimateDiff-Evolved", "https://github.com/Kosinkadink/ComfyUI-AnimateDiff-Evolved", "Apache-2.0",
   "Supplies the motion. Needs a motion module, and above 32 frames its context options are mandatory."],
  ["ComfyUI-VideoHelperSuite", "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite", "GPL-3.0",
   "Reads a source clip, for video-to-video."],
];
const REACT_HINTS = {
  images: "Pictures cross-faded into each other, arriving on the beat. No source footage — everything between the pictures is invented.",
  video: "Your clip restyled, keeping its motion and framing. The pictures supply the look; the beat decides when it changes.",
  text: "The prompt decides the scene. The pictures still supply the look, because the blend needs two of them to move between.",
};
let reactMode = "images";
let reactPicked = [];

async function loadReactive() {
  let st = { ok: false, reachable: false, base: "" };
  try { st = await (await fetch("/api/reactive/status")).json(); } catch { /* offline */ }
  $("reactSetup").hidden = !!st.ok;
  $("reactForm").hidden = !st.ok;
  $("reactPip").hidden = !!st.ok;

  if (!st.ok) {
    /* Name what is missing and where it came from. "Not available" tells nobody
     * anything, and a reachable engine missing one pack is a different problem
     * from no engine at all — they need different fixes. */
    $("reactWhere").textContent = st.reachable
      ? `Found an engine on ${st.base}, but it is missing what this needs.`
      : `Nothing is answering on ${st.base || "the reactive engine address"}. Start a second ComfyUI there with the packs below.`;
    const missing = new Set(st.missingPacks || []);
    const mark = (name) => (!st.reachable ? ""
      : missing.has(name) ? '<span class="warn">missing</span>' : '<span class="okpip">present</span>');
    $("reactNeeds").innerHTML = REACT_PACKS.map(([name, url, lic, why]) => `
      <dt><a href="${esc(url)}" target="_blank" rel="noopener">${esc(name)}</a>
        <span class="lic">${esc(lic)}</span> ${mark(name)}</dt>
      <dd>${esc(why)}</dd>`).join("")
      + ((st.missingModels || []).length
        ? `<dt>Weights <span class="warn">missing</span></dt><dd>The engine also needs ${esc(st.missingModels.join(" and "))}, plus an AnimateDiff motion module.</dd>`
        : "");
    return;
  }

  // Fed from what app.js already holds, rather than polling a second copy.
  if (!state.clips) await loadClips();
  if (!state.images) await loadImages();
  const songs = state.library || [];
  $("reactSong").innerHTML = songs.length
    ? songs.map((t) => `<option value="${esc(t.file)}">${esc(t.title || t.file)}</option>`).join("")
    : '<option value="">no songs yet</option>';
  $("reactVideo").innerHTML = (state.clips || [])
    .filter((c) => /\.(mp4|webm)$/i.test(c.name))
    .map((c) => `<option value="${esc(c.name)}">${esc(c.title || c.name)}</option>`).join("");
  $("reactCkpt").innerHTML = (st.checkpoints || [])
    .map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  $("reactImgs").innerHTML = (state.images || []).map((im) => `
    <button type="button" class="reactimg" data-rimg="${esc(im.name)}" title="${esc(im.name)}">
      <img src="/api/image/${encodeURIComponent(im.name)}" alt="" loading="lazy"></button>`).join("");
  reactSetMode(reactMode);
  reactPaintPicked();
}

function reactSetMode(m) {
  reactMode = m;
  for (const b of $("reactModes").querySelectorAll("[data-mode]")) {
    b.classList.toggle("on", b.dataset.mode === m);
  }
  $("reactVideoRow").hidden = m !== "video";
  $("reactPromptRow").hidden = m !== "text";
  $("reactModeHint").textContent = REACT_HINTS[m] || "";
}

function reactPaintPicked() {
  $("reactPicked").textContent = reactPicked.length ? `${reactPicked.length} picked` : "none picked";
  for (const b of $("reactImgs").querySelectorAll("[data-rimg]")) {
    b.classList.toggle("on", reactPicked.includes(b.dataset.rimg));
  }
}

document.addEventListener("click", (e) => {
  const mode = e.target.closest("#reactModes [data-mode]");
  if (mode) { reactSetMode(mode.dataset.mode); return; }
  const img = e.target.closest("#reactImgs [data-rimg]");
  if (!img) return;
  const n = img.dataset.rimg;
  reactPicked = reactPicked.includes(n) ? reactPicked.filter((x) => x !== n) : [...reactPicked, n];
  reactPaintPicked();
});

$("reactGo")?.addEventListener("click", async () => {
  const note = $("reactNote"), out = $("reactOut");
  /* Both of these fail deep inside the engine with an unhelpful message, so they
   * are caught here where the reason can be stated plainly. */
  if (reactPicked.length < 2) { note.textContent = "Pick at least two reference images — the blend moves between them."; return; }
  if (!$("reactSong").value) { note.textContent = "Render a song first; its beat is what drives this."; return; }
  if (reactMode === "video" && !$("reactVideo").value) { note.textContent = "Video mode needs a source clip."; return; }

  const body = {
    mode: reactMode,
    audio: $("reactSong").value,
    images: reactPicked,
    video: reactMode === "video" ? $("reactVideo").value : null,
    ckpt: $("reactCkpt").value,
    band: $("reactBand").value,
    threshold: Number($("reactThresh").value),
    minGap: Number($("reactGap").value),
    transition: Number($("reactTrans").value),
    frames: Number($("reactFrames").value),
  };
  const typed = $("reactPrompt").value.trim();
  if (reactMode === "text" && typed) body.prompt = typed;

  $("reactGo").disabled = true;
  out.hidden = true;
  note.textContent = "Rendering on the reactive engine. This takes minutes, and it does not share Studio's queue — the GPU is shared, so a song will slow it down.";
  try {
    const r = await fetch("/api/reactive/run", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `the engine returned ${r.status}`);
    note.textContent = `Done in ${d.seconds}s.`;
    out.hidden = false;
    out.innerHTML = `<p class="hint">Written by the reactive engine as <code>${esc(d.subfolder ? d.subfolder + "/" : "")}${esc(d.file)}</code>. It is in that engine's output folder, not Studio's library.</p>`;
  } catch (err) {
    note.textContent = String(err.message || err);
  } finally {
    $("reactGo").disabled = false;
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
    $("artCkpt").innerHTML = (ck.checkpoints || []).map((f) =>
      `<option${f === d.checkpoint ? " selected" : ""}>${f}</option>`).join("")
      || '<option value="">nothing in models/checkpoints</option>';
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
  const hasLeft = lib || name === "overnight" || name === "video";  // studio is full width
  document.querySelector(".shell").classList.toggle("solo", !hasLeft);
  /* The song form belongs to Create alone. `lib` now also covers Overnight (so
   * the library shows on the right while a run goes), and reusing it here meant
   * the Create form appeared underneath the Overnight planner — two creator
   * columns at once. */
  document.querySelector(".create").hidden = name !== "create";
  $("ovPanel").hidden = name !== "overnight";
  $("vidPanel").hidden = name !== "video";
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
  if (!lib) $("pinned").hidden = true;
  $("overnight").hidden = name !== "overnight";
  $("videoclips").hidden = name !== "video";
  $("imagesview").hidden = name !== "images";
  if (name === "images") { loadImages(); imgPaint(); }
  $("studio").hidden = name !== "studio";
  $("settings").hidden = name !== "settings";
  $("models").hidden = name !== "models";
  /* ⚠ Visibility is set HERE, one explicit line per view — the map above is not
   * what unhides anything. Registering there alone gave a page whose own loader
   * ran (it un-hid the form inside) while the container stayed display:none, so
   * the nav highlighted and the screen was blank. */
  $("reactive").hidden = name !== "reactive";
  $("thanks").hidden = name !== "thanks";
  $("mcp").hidden = name !== "mcp";
  $("games").hidden = name !== "games";
  if (name === "games") initGames();
  $("vfx").hidden = name !== "vfx";
  if (name === "vfx") { initVfx(); vfxOpen(); }
  if (name === "mcp") loadMcp();
  // Filled once, from the same catalogue the Models screen reads. loadThanks
  // returns early after the first fill, so opening the tab repeatedly is free.
  if (name === "reactive") loadReactive();
  if (name === "thanks") loadThanks();
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
  if (name === "community") loadCommunity();
  if (name !== "create") $("songPanel").hidden = true;
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
  a.onclick = (e) => { e.preventDefault(); setView(a.dataset.view); };
}

/* ── overnight ────────────────────────────────────────── */
/* Deliberately three controls. Anything more is a decision to make at bedtime,
   which is exactly when nobody wants to make one. */
/* Ideas survive a reload.
 *
 * They were browser-memory only while every other preference on this page
 * (takes, grid, auto, visualiser) persisted — so closing the tab before pressing
 * Start threw away a list somebody had just typed out. */
const ov = { ideas: [] };
try { ov.ideas = JSON.parse(localStorage.getItem("aiplayIdeas") || "[]") || []; } catch { /* corrupt */ }
function ovSaveIdeas() {
  try { localStorage.setItem("aiplayIdeas", JSON.stringify(ov.ideas.slice(0, 40))); } catch { /* quota */ }
}

function ovRender() {
  ovSaveIdeas();
  const box = $("ovIdeas");
  if (!ov.ideas.length) {
    box.innerHTML = '<div class="ovempty">No ideas yet. Write one in Create, then add it here.</div>';
  } else {
    box.innerHTML = ov.ideas.map((it, i) => `
      <div class="ovidea">
        <div><div class="t">${esc(it.title)}${it.instrumental ? ' <span class="badge">instrumental</span>' : ""}</div>
          <div class="s">${esc(it.caption)}</div></div>
        <button class="x" type="button" data-rm="${i}" aria-label="Remove">✕</button>
      </div>`).join("");
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

$("ovStart").onclick = () => ovPost({
  action: "start", items: ov.ideas, takes: +$("ovTakes").value, cap: +$("ovCap").value,
  /* A name, so the history is readable. Nothing ever sent one, so the server
   * fell back to the literal string "Overnight run" and every archived row was
   * identical. Built from the first idea and the date, which is how you would
   * describe the run to yourself the next morning. */
  name: [ov.ideas[0]?.title || ov.ideas[0]?.caption?.slice(0, 28) || "Overnight",
         ov.ideas.length > 1 ? `+${ov.ideas.length - 1}` : "",
         new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" })]
    .filter(Boolean).join(" · "),
  // The chain that runs AFTER each song. The server hands these to the same
  // idle-drain runner that already does covers, so music always preempts and
  // there is no second scheduler to keep in step.
  stages: {
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
$("pTrack").onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  if (audio.duration) audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
};
// Browser handoff — the rights questions on the site stay the single consent gate.
$("pSubmit").onclick = () => window.open(state.siteSessions || "https://aiplay.live/sessions", "_blank", "noopener");

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
function applyStatus(s) {
  if (!s.engine) return;
  state.engineReady = s.engine.ready;
  $("engineLine").textContent = s.engine.ready ? "RUNNING LOCALLY" : "STARTING…";
  $("btnCreate").disabled = $("btnPreview").disabled = !s.engine.ready;

  const b = s.engine.backend;
  const warn = $("engineWarn");
  if (b && b.ok === false) {
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
      if (!confirm(`Switch to “${t.label}”?\n\n${t.note}\n\nThis restarts the engine, which clears the cached take — your next re-roll will cost a full render.`)) {
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
    const est = state.mode === "instrumental"
      ? +$("sections").value * 19
      : Math.min(Math.max(($("lyrics").value.split("\n").filter((l) => l.trim() && !l.startsWith("[")).length) * 8, 30), +$("maxDur").value);
    const one = Math.round(est * s.config.realtimeRatio * (+$("qSteps").value / 15));
    const n = state.takes || 1;
    // Takes are sequential runs, so the wait multiplies. Saying "0:46" while
    // queueing four of them would be a lie by omission.
    $("ctaNote").textContent = n > 1
      ? `${n} takes · about ${fmt(one * n)} in total on your card`
      : `about ${fmt(one)} on your card · re-rolls ~3× faster`;
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
    renderList(snap);
    applyBatch(snap);
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
  const name = prompt("Playlist name");
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
    renderList(s);
    applyBatch(s);
  } catch { /* server restarting */ }
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
setView("create");
setGrid(localStorage.getItem("aiplayGrid") === "1");
ovRender();
paintSeed();
paintScaffold();
$("maxDur").oninput();
$("qSteps").oninput();
$("qCfg").oninput();
$("qArCfg").oninput();
poll();
setInterval(poll, 4000);
connect();
loadCommunity();
setInterval(loadCommunity, 120000);
