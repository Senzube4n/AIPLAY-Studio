/**
 * HOW TO PROMPT EACH MODEL — for the Images and Video panels' Simple assistant
 * (form-tools.js). The page already says which model is chosen (the engine
 * dropdown, and for "your own model file" the file itself), so the assistant is
 * handed the rules for THAT model with every message, and a different set the
 * moment it switches engine (the screen is re-read after each set_form).
 *
 * Guidance, never a refusal: nothing here stops the assistant writing what the
 * person asked for. The shared rules at the bottom are this repo's own measured
 * ones (DIRECTING.md §3, "Prompt craft"); the per-model notes are each model's
 * published prompting style, kept to what changes how the words should be
 * written.
 */

const str = (v) => (v === undefined || v === null ? "" : String(v));

/* What every image and video prompt here should do (DIRECTING.md §3). */
const SHARED = [
  "Say what IS in the frame, never what is not: \"no people\" or \"no text\" tends to put them in. Replace, don't",
  "negate (\"the wall is solid timber shelving\" instead of \"no windows\").",
  "Name what stays lit when you describe light (\"warm key light on her face, the room falling dark\").",
  "Put the subject first and restate who or what it is near the end of a long description.",
];

export const IMAGE_GUIDES = {
  flux2: {
    name: "FLUX.2 klein",
    rules: [
      "Plain descriptive sentences, not a keyword list: subject, what it does, setting, light, camera and lens, style.",
      "Detail helps: materials, colours, textures, the time of day. Words to appear in the picture go in quotes.",
      "Few steps by design (the steps field is small): leave steps and guidance as the form has them.",
      "Takes reference pictures (References rows): say in the description what to take from each.",
    ],
  },
  zimage: {
    name: "Z-Image Turbo",
    rules: [
      "Natural sentences, photographic and specific: subject, action, setting, light, lens. Strong at realism and at",
      "text in the picture (quote the exact words).",
      "Turbo, 8 steps: the negative prompt does little here; put what you want in the description instead.",
    ],
  },
  "zimage-base": {
    name: "Z-Image base",
    rules: [
      "Natural sentences like Z-Image Turbo, and it can take more detail.",
      "Its negative prompt WORKS: keep it short and concrete (blurry, extra fingers, watermark), never the subject.",
    ],
  },
  anima: {
    name: "Anima (anime and illustration)",
    rules: [
      "An anime/illustration model: it usually reads Danbooru-style tags best, then a short sentence. Order: how many",
      "and who (1girl, solo), then appearance (long silver hair, red eyes, school uniform), pose and action, setting,",
      "then style and quality words. Keep tags comma-separated and lowercase.",
      "Use the negative prompt for quality problems (lowres, bad anatomy, extra fingers), not for content.",
    ],
  },
  krea2: {
    name: "Krea 2 Turbo",
    rules: [
      "Aesthetic, photographic sentences: describe it like a photographer's shot list (subject, mood, light, lens,",
      "film look, colour palette). Avoid keyword soup; one clear scene.",
      "8 steps: leave steps and guidance as the form has them.",
    ],
  },
  ideogram4: {
    name: "Ideogram 4",
    rules: [
      "Best at typography and design: posters, covers, logos, signs. Put the exact text in quotes and say where it",
      "goes, its style (bold serif, hand-lettered) and the layout; then the image around it.",
      "Its licence is NON-COMMERCIAL: if they mention selling or a client, say so before making it.",
    ],
  },
};

/* "Your own model file": the family is read off the file name, which is only a
 * hint, so the assistant is told it is a guess. */
export function checkpointGuide(file) {
  const f = str(file).toLowerCase();
  if (!f) return { name: "your own model file (none chosen yet)", rules: ["Ask which model file to use, or choose one in the model file field."] };
  const base = str(file).split(/[\\/]/).pop();
  if (/pony|pdxl/.test(f)) {
    return { name: `${base} (looks like a Pony model)`, rules: [
      "Pony models read Danbooru-style tags and are steered by score tags: start with",
      "\"score_9, score_8_up, score_7_up,\" then source and rating tags if wanted, then the subject tags and a short sentence.",
      "Negative prompt: score_4, score_5, score_6, plus quality problems.",
    ] };
  }
  if (/illustrious|noob|\bill\b|ilxl/.test(f)) {
    return { name: `${base} (looks like an Illustrious/NoobAI model)`, rules: [
      "Danbooru-style tags: count and character first (1girl, solo), appearance, pose, setting, then",
      "\"masterpiece, best quality, very aesthetic\". Negative: lowres, worst quality, bad anatomy.",
    ] };
  }
  if (/flux/.test(f)) {
    return { name: `${base} (looks like a FLUX model)`, rules: ["Plain descriptive sentences, not tags; quote any text to appear."] };
  }
  if (/xl|sdxl/.test(f)) {
    return { name: `${base} (looks like an SDXL model)`, rules: [
      "SDXL: a clear sentence or two, then a few style keywords (photo, 35mm, soft light). Around 1024 px sizes.",
      "Use the negative prompt for quality problems (blurry, deformed hands, watermark).",
    ] };
  }
  if (/1[._-]?5|sd15|v1-5|\bsd1/.test(f)) {
    return { name: `${base} (looks like a Stable Diffusion 1.5 model)`, rules: [
      "SD 1.5: short comma-separated phrases, the most important first; around 512 to 768 px sizes.",
      "Use the negative prompt for quality problems (blurry, extra limbs, watermark).",
    ] };
  }
  return { name: `${base} (family unknown from its name)`, rules: [
    "Write one clear descriptive sentence followed by a few comma-separated style words, which most model",
    "families accept; use the negative prompt for quality problems. If results look off, ask what kind of model it is.",
  ] };
}

export const VIDEO_GUIDES = {
  h3: {
    name: "MiniMax H3",
    rules: [
      "One subject, one action, one camera move: H3 holds a simple shot far better than a busy one.",
      "Name the camera move in plain words (slow push in, pan left, orbit, handheld, static).",
      "It always renders sound: describe what is heard too (rain on glass, a crowd murmuring, one voice singing).",
      "To keep a person the same across clips: 1–3 tight pictures of them (a saved character, or pictures named",
      "in the words: \"<Picture 1> is Mira.\"), and write their name where they act.",
      "To make them sing in time: the song under the clip (Song under the clip), not a sound reference (<Audio 1>),",
      "which re-sings.",
      "A starting (and ending) frame from a picture fixes how it looks; then describe only what MOVES.",
    ],
  },
  ltx: {
    name: "LTX 2.5",
    rules: [
      "One flowing paragraph, in the order things happen, up to about 200 words: start with the main action in one",
      "sentence, then the specific movements and gestures, how the people or things look, the setting, the camera",
      "angle and movement, the light and colours, and any change during the shot. Write it like a cinematographer.",
      "It makes its own sound unless a soundtrack is chosen: describe the sound as well.",
      "With a soundtrack, describe someone or something making that sound (a singer at a microphone, hands on keys).",
    ],
  },
};

/** The rules for the model on the screen, as lines for describeScreen(). */
export function guideLines(kind, fields = []) {
  const val = (id) => str((fields.find((x) => x.id === id) || {}).value);
  let g = null;
  if (kind === "image") {
    const eng = val("imgEngine");
    g = eng === "checkpoint" ? checkpointGuide(val("imgCkpt")) : IMAGE_GUIDES[eng] || null;
  } else if (kind === "video") {
    const eng = val("vidEngine");
    g = VIDEO_GUIDES[eng] || (/ltx/i.test(eng) ? VIDEO_GUIDES.ltx : /h3/i.test(eng) ? VIDEO_GUIDES.h3 : null);
    const own = val("vidModel");
    if (g && own) g = { ...g, name: `${g.name}, with your own model file ${own.split(/[\\/]/).pop()}` };
  }
  const head = g ? `HOW TO PROMPT ${g.name}:` : "HOW TO PROMPT this model (not one this Studio has notes for):";
  /* An entry that does not end a sentence continues on the next line. */
  const list = (rules) => rules.map((r, i) => (i && !/[.:!?)"]$/.test(rules[i - 1]) ? `  ${r}` : `- ${r}`));
  return [head, ...list(g ? g.rules : []), "Always:", ...list(SHARED)];
}

export default guideLines;
