/**
 * THE "!" TIPS — short hover help for the Music panel.
 *
 * The panel used to explain itself in paragraphs under every control, which
 * made a narrow column mostly reading. Each explanation now lives behind a
 * small "!" next to the thing it explains: hover or focus shows it, a tap pins
 * it (hover does not exist on a touchscreen).
 *
 * Icons are added at runtime next to their labels and put back if a label is
 * repainted (app.js rewrites the Length label's text when the engine changes),
 * so web/index.html keeps its labels exactly as the layout tests read them.
 *
 * A tip with `from` appends the live text of a hidden status element — the
 * seed caveat and the LoRA folder count are written by app.js and change.
 */

const $ = (id) => document.getElementById(id);

/** key -> { at: CSS selector for where the "!" goes, text, from?: element id } */
export const TIPS = {
  lyrics: { at: "#lyricsBox > summary", text: "The words the model sings. Put section tags like [Verse] and [Chorus] on their own lines. With YuE2, the song's length mostly follows the lyrics." },
  tags: { at: null, text: "Click a tag to insert it at the cursor. Keep tags bare — [Chorus], not [Chorus - big drums]. Anything extra inside the brackets gets sung." },
  structure: { at: 'label[for="structure"]', text: "Instrumentals need sections to fill, or they stop after about 30 seconds. Edit the skeleton freely, and describe the sound in Styles." },
  styles: { at: "#stylesBox > summary", text: "Describe the sound: genre, mood, tempo, instruments and who sings — for example: warm indie folk, 96 BPM, female vocal." },
  more: { at: "details.adv.sbox:not(#yMusicPlan) > summary", text: "Fine control over how the song is made. The defaults are good; you rarely need to change these." },
  aref: { at: "#arefField > summary", text: "Start from an existing song's sound. Experimental: it does not keep the melody, timing or words." },
  musicInput: { at: "#musicInputField > summary", text: "Continue an existing recording with newly generated music. Experimental." },
  seed: { at: ".seedrow .sk", text: "The random starting point. Locked reuses it so you can change one thing at a time; random gives a new song every time.", from: "seedNote" },
  maxDur: { at: 'label[for="maxDur"]', text: "The longest the song may run. YuE2 mostly follows the lyrics' length — this picks the setup and warns past the model's 6:00 limit." },
  qSteps: { at: 'label[for="qSteps"]', text: "Refinement passes. 15 is the measured sweet spot; more is slower for little gain." },
  qArCfg: { at: 'label[for="qArCfg"]', text: "How strictly the notes and structure follow your style text. Higher is more literal. Changing it re-renders the whole song." },
  qCfg: { at: 'label[for="qCfg"]', text: "How strictly the sound follows your style text. It reuses the current take, so it is about 4× faster to try." },
  yCot: { at: 'label[for="yCot"]', text: "How the model plans before singing. Full plans the whole score (default). Melody plans only the tune. Off skips planning and cannot use a supplied score." },
  yCfg: { at: 'label[for="yCfg"]', text: "How closely it follows your style and lyrics, from 0 to 20. Leave it empty for the model's default." },
  yPrecision: { at: 'label[for="yPrecision"]', text: "bf16 is the model as published. fp8 is experimental, needs an RTX 40-series card or newer, and measured slower here." },
  yGgufPrecision: { at: 'label[for="yGgufPrecision"]', text: "Q4_0 is smaller and the default. Q8_0 uses more memory and is not proven to sound better." },
  yKey: { at: 'label[for="yKey"]', text: "The musical key, like Em, G or F#m. Leave it empty and the model chooses." },
  yBpm: { at: 'label[for="yBpm"]', text: "Tempo in beats per minute, 40–240. Leave it empty and the model chooses." },
  yMeter: { at: 'label[for="yMeter"]', text: "Time signature, like 4/4 or 6/8. Model decides is usually right." },
  yTemp: { at: 'label[for="yTemp"]', text: "Randomness of the singing pass. Temperature: lower is steadier, higher is wilder (default 1.0). Top-p default is 0.95." },
  yPlanTemp: { at: 'label[for="yPlanTemp"]', text: "How adventurous the composer is when it plans the score. Default 0.7." },
  ySteps: { at: 'label[for="ySteps"]', text: "Synthesis steps. 32 is the default; 16 measured the same sound in half the time." },
  advanced: { at: "#yMusicPlan > summary", text: "LoRAs, humming or covering a melody, and writing your own score." },
  lora: { at: "#subLora", text: "A LoRA adds a trained style to the audio model. Files go in models/loras.", from: "yLoraNote" },
  yLoraStrength: { at: 'label[for="yLoraStrength"]', text: "How strongly the LoRA applies. 1.00 is full strength." },
  hum: { at: "#subHum", text: "Record or drop audio. A hummed line (1–60 s, one voice) needs no model; a whole song uses SheetSage2 (Models → Cover). The notes land in the score box and the model sings them." },
  humEngine: { at: 'label[for="humEngine"]', text: "Hum: a quick pitch tracker for one voice. Song: SheetSage2, for a full recording." },
  humMode: { at: 'label[for="humMode"]', text: "Keep only the melody (best for covers), or the melody and its chords." },
  yAbcOpen: { at: "#yAbcOpenLabel", text: "Treat the score as an opening and let the model continue it, instead of singing only those bars." },
  score: { at: "#subScore", text: "Steer a new take with your own ABC notation. This is not audio extension — no recording or singer is kept. Planning runs locally, with no GPU." },
  yPlanBpm: { at: 'label[for="yPlanBpm"]', text: "Tempo used to work out how many bars fit the target length." },
  yPlanMeter: { at: 'label[for="yPlanMeter"]', text: "Time signature used for the bar estimate." },
  yPlanLength: { at: 'label[for="yPlanLength"]', text: "How long the notation should be. Only an estimate — the real song can be quite different." },
  yAbc: { at: 'label[for="yAbc"]', text: "Paste a YuE2 two-voice ABC score, or load a .abc or .txt file (up to 64 KiB). Check it before you use it." },
  yAbcUse: { at: "#yAbcUseLabel", text: "Send this score with the next Create. Needs Thinking set to Full or Melody. GGUF can use a score but does not export one." },
  takes: { at: ".howmany .hmlab", text: "How many takes to queue. Each one is a separate performance with its own seed, rendered one after another." },
  sheetPdf: { at: "#sheetPdfLabel", text: "Also save the model's planned score as an engraved PDF. It is the plan, not a transcription of the audio." },
  scoreUse: { at: "#scoreUseLabel", text: "Render from this score next time. The notes are kept; the length is not guaranteed. Needs Thinking on." },
  /* The song panel on the right. */
  spExtend: { at: "#spExtendLab", text: "Opens the track in the editor on the left, where you pick the joining point on the waveform and can edit the words first. The original is never changed." },
  spLineage: { at: "#spLineageLab", text: "The takes this track was extended from, oldest first. Click one to open it." },
  spMerge: { at: "#spMergeLab", text: "Each extension is a separate alternative sharing the same opening. Merge joins them into one song, with each part heard once." },
  spProv: { at: "#spProvSec > summary", text: "Which parts of this track were made by a person and which by an AI model, from the provenance record." },
  spSettings: { at: "#spSettingsSec > summary", text: "The exact settings this take was rendered with — seed, steps, precision and file." },
};

function tipText(key) {
  const t = TIPS[key];
  if (!t) return "";
  const extra = t.from ? ($(t.from)?.textContent || "").trim() : "";
  return extra ? `${t.text} ${extra}` : t.text;
}

function icon(key) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tipi";
  b.dataset.tipKey = key;
  b.textContent = "!";
  b.setAttribute("aria-label", "What is this?");
  b.setAttribute("aria-expanded", "false");
  return b;
}

/** Put every "!" where it belongs; cheap enough to run on any repaint. */
export function ensureTips(root = document) {
  for (const [key, t] of Object.entries(TIPS)) {
    if (!t.at) continue;
    for (const el of root.querySelectorAll(t.at)) {
      if (!el.querySelector(`:scope > .tipi[data-tip-key="${key}"]`)) el.appendChild(icon(key));
    }
  }
}

/* ── the popover ─────────────────────────────────────────────────────────── */

let pop = null;
let pinned = null;
let current = null;

function show(btn) {
  const text = tipText(btn.dataset.tipKey);
  if (!text) return;
  if (!pop) {
    pop = document.createElement("div");
    pop.className = "tippop";
    pop.id = "tipPop";
    pop.setAttribute("role", "tooltip");
    document.body.appendChild(pop);
  }
  if (current && current !== btn) current.setAttribute("aria-expanded", "false");
  current = btn;
  pop.textContent = text;
  btn.setAttribute("aria-expanded", "true");
  btn.setAttribute("aria-describedby", "tipPop");
  pop.classList.add("on");
  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
  const below = r.bottom + 8 + h <= innerHeight - 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - h - 8)}px`;
}

function hide(force = false) {
  if (pinned && !force) return;
  pinned = null;
  if (current) { current.setAttribute("aria-expanded", "false"); current.removeAttribute("aria-describedby"); }
  current = null;
  pop?.classList.remove("on");
}

function init() {
  const panel = document.querySelector(".create");
  if (!panel) return;
  ensureTips();

  /* Re-add icons a repaint removed. Batched to one pass per frame. */
  let queued = false;
  const again = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; ensureTips(); });
  });
  again.observe(panel, { childList: true, subtree: true, characterData: true });
  const side = document.getElementById("songPanel");
  if (side) {
    again.observe(side, { childList: true, subtree: true, characterData: true });
    side.addEventListener("scroll", () => hide(true), { passive: true });
  }

  document.addEventListener("pointerover", (e) => {
    const b = e.target.closest?.(".tipi");
    if (b) show(b);
  });
  document.addEventListener("pointerout", (e) => {
    const b = e.target.closest?.(".tipi");
    if (b && !b.contains(e.relatedTarget)) hide();
  });
  document.addEventListener("focusin", (e) => { if (e.target.classList?.contains("tipi")) show(e.target); });
  document.addEventListener("focusout", (e) => { if (e.target.classList?.contains("tipi")) hide(true); });
  /* Capture phase: the icon sits inside <summary> and <label>, and a click on
   * it must not fold the card or focus the control. */
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.(".tipi");
    if (!b) { if (pinned) hide(true); return; }
    e.preventDefault();
    e.stopPropagation();
    if (pinned === b) { hide(true); return; }
    show(b);
    pinned = b;
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(true); });
  panel.addEventListener("scroll", () => hide(true), { passive: true });
  addEventListener("resize", () => hide(true));
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}
