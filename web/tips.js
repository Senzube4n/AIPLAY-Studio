/**
 * THE "!" TIPS — short hover help for the Music, Images and Video panels.
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
  /* The picker's row itself: the Write | Structure switch took the label away,
   * and a tip anchored on a missing element vanishes without a word. Not
   * #sectionsV, whose text paintScaffold rewrites (the "!" would go with it). */
  structure: { at: "#instrField", text: "Instrumentals need sections to fill, or they stop after about 30 seconds. Edit the skeleton freely, and describe the sound in Styles." },
  simple: { at: ".create .simple-label", text: "Describe the song you want: the mood, the genre, what it is about. The assistant writes the lyrics and the style into the cards below, sets things up, and makes it when you say so. The dropdown picks which model writes; ＋ New starts over." },
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

  /* ── The Images panel ──────────────────────────────────────────────────
   * Same bargain as the Music one: the screen was four paragraphs of prose
   * above a form, including a four-hundred-character description of whichever
   * engine happened to be selected. Everything below used to be on the page.
   * `imgEngine` carries no text of its own — app.js writes the engine's
   * description into #imgModelNote and `from` reads it live, so a new engine
   * explains itself here without anyone editing this table. */
  imgPrompt: { at: 'label[for="imgPrompt"]', text: "One subject, one mood, one light — a list of adjectives makes a picture that looks like a list of adjectives. Write {a|b|c} and one option is picked per render; an empty option like {, at night|} puts the detail in half the takes." },
  imgEngine: { at: 'label[for="imgEngine"]', text: "", from: "imgModelNote" },
  /* The Video panel, quiet like Images: its paragraphs are these now. */
  vidEngine: { at: 'label[for="vidEngine"]', text: "Short clips from a description.", from: "vidEngineNote" },
  vidModel: { at: 'label[for="vidModel"]', text: "Files from models/diffusion_models, models/text_encoders and models/vae. Leave these on auto unless you have a model of your own." },
  vidPrompt: { at: 'label[for="vidPrompt"]', text: "Describe a picture that moves, not a song. One subject, one camera move: a simple shot holds far better than a busy one." },
  vidMid: { at: "#vidMidRow > .flabel", text: "Pictures the clip travels through, spaced evenly between the two ends. They are not style references: the clip lands on each one and moves on. Four at most." },
  vidRefs: { at: "#vidRefWrap > .flabel", text: "Pictures: the model recasts what they show wherever the words put it. Name each one (\"<Picture 1> is Mira.\") and then use the name (\"Mira runs…\"). For one character, 1–3 tight pictures on a plain dark background (face; body + face; body + side + face). Sounds (<Audio 1>) shape the clip's own sound and are re-sung; for lip-sync to your song use Song under the clip." },
  /* Keep my character and Song under the clip: the REWIND A/B, 2026-09-24
   * (DIRECTING.md §2). Both show in Simple. */
  vidKeep: { at: 'label[for="vidCharacter"]', text: "Pictures of the person keep them the same from clip to clip. Pick a saved character (made on Pictures: Character… → Save) or drop 1–3 pictures of them: tight, one person, on a plain dark background (face; body; side). Name each dropped picture in the description (\"<Picture 1> is Mira.\") and write the name where they act. Measured 2026-09-24 on MiniMax H3: with named pictures, the 8-step reference build at 8 steps and the song under the clip, the character matched in all four test shots; from words alone the hair, the mask and the coat changed between clips. No one in the shot? Text only is fine." },
  vidSnd: { at: 'label[for="vidSndSong"]', text: "The song sits under the clip while it renders, and the finished clip plays it. On MiniMax H3 with pictures of the singer (Keep my character), the mouth follows the words (measured 2026-09-24): that is lip-sync; set where the sung line starts. From words alone it is untested, and on LTX mouths were measured not to follow it. Not the same as a sound under References: that one is re-sung in the clip's own time." },
  vidFrom: { at: 'label[for="vidFrom"]', text: "The first frame of the clip: a song's cover from the list, or any picture with Use a file. Picking a cover also fills an empty description from that song's style." },
  vidTo: { at: 'label[for="vidTo"]', text: "", from: "vidToNote" },
  vidLoop: { at: "#vidLoopRow", text: "", from: "vidLoopNote" },
  vidQuality: { at: "#vidQualityRow > label", text: "Fast, Standard and Best set the step count.", from: "vidQualityNote" },
  vidAdv: { at: "#vidAdv > summary", text: "", from: "vidAdvNote" },
  vidLab: { at: "#vidLab > summary", text: "What each size actually buys, the engine's speed switches with the reasons for them, and Compare: one description rendered with several settings side by side." },
  vidAudio: { at: 'label[for="vidAudio"]', text: "H3 always renders sound, so keeping it is free. Clips made under a song discard it: that song is the audio." },
  imgAssist: { at: "#imgPanel .assist .simple-label", text: "Describe the picture. The assistant writes the description, picks the engine, size and settings in the form, and makes it when you say so. Advanced shows everything it chose." },
  vidAssist: { at: "#vidPanel .assist .simple-label", text: "Describe the clip. The assistant writes the description, picks the engine, length, size and starting frame, and renders it when you say so. Advanced shows everything it chose." },
  imgCkpt: { at: 'label[for="imgCkpt"]', text: "Any model file in models/checkpoints or models/diffusion_models. A full checkpoint loads on its own; a bare transformer renders on its family's recipe, and the rows under it name the text encoder and VAE to load with it." },
  imgDitKind: { at: 'label[for="imgDitKind"]', text: "What the file is, read from the weights. Overrule it if a merge carries another family's layer names." },
  imgEncoder: { at: 'label[for="imgEncoder"]', text: "The text encoder loaded beside the model. Auto is the one its family ships with." },
  imgVae: { at: 'label[for="imgVae"]', text: "The VAE that turns the sampler's latent into pixels. Auto is the one its family ships with." },
  imgCount: { at: 'label[for="imgCount"]', text: "How many pictures this press makes. They share one text encode and render one after another." },
  imgSize: { at: 'label[for="imgSize"]', text: "Pixels. Every engine here is happiest near its training size — 1024² for most of them. custom… opens two boxes, 256 to 2048." },
  imgSteps: { at: 'label[for="imgSteps"]', text: "Refinement passes. Each engine's default is its vendor's number; distilled engines (FLUX.2 klein, the Turbos) are done in 4 to 8 and gain nothing from more." },
  imgSeed: { at: 'label[for="imgSeed"]', text: "The random starting point. Leave it empty for a new one each time; type one to make the same picture again." },
  imgCfg: { at: 'label[for="imgCfg"]', text: "How strictly the picture follows the words. Only on engines that really run guidance — the distilled ones sample at cfg 1.0, where it does nothing." },
  imgNeg: { at: 'label[for="imgNeg"]', text: "What the picture must not contain. Only works where the engine evaluates a negative branch, which is why it is not offered on the distilled engines." },
  imgRefs: { at: "#imgRefWrap > .flabel", text: "Show the model pictures from the library, then talk about them BY NUMBER in the description: “the character from image 1, in the room from image 2”. The number is the position in the strip — reorder with ◀ ▶. Click a thumbnail to drop its number in." },
  imgPersona: { at: 'label[for="imgPersona"]', text: "A saved character: reference pictures plus a description, remembered under a name. Not training and not a LoRA — the same in-context path, reusable." },
  imgSampler: { at: 'label[for="imgSampler"]', text: "Read from your ComfyUI, not a list written here, so a sampler a node pack added is offered and one it does not have never is." },
  imgClipSkip: { at: 'label[for="imgClipSkip"]', text: "Stops short of the last CLIP layers. 2 is common for anime checkpoints; 1 means no skipping. SD-family checkpoints only." },
  imgLoras: { at: "#imgAdv label:last-of-type", text: "Trained styles stacked onto a checkpoint. Files go in models/loras.", from: "imgLoraNote" },
};

function tipText(key) {
  const t = TIPS[key];
  if (!t) return "";
  const extra = t.from ? ($(t.from)?.textContent || "").trim() : "";
  /* A tip can be ENTIRELY live — the Images engine row has no text of its own,
   * only whatever app.js wrote about the engine that is selected. */
  return `${t.text} ${extra}`.trim();
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
  /* The Images panel is the same kind of column and gets the same treatment;
   * its controls are repainted whenever the engine changes, which is exactly
   * what this observer is for. */
  for (const el of document.querySelectorAll("#imgPanel .vidform, #vidPanel")) {
    again.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener("scroll", () => hide(true), { passive: true });
  }
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
