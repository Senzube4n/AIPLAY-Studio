/**
 * COMFY ROUTER: the featured models, and the simple form for the ones whose
 * native body is nested.
 *
 * Most models take a flat body (`prompt`, `width`, `aspect_ratio`…) and the
 * Comfy API page draws their form straight from the schema. A few bury the
 * prompt inside a structure: Seedance and Hailuo in `content[]`, Veo in
 * `instances[]`, Gemini in `contents[].parts[]`, Claude in `messages[]`. For
 * those, an adapter offers the handful of fields a person actually sets and
 * builds the native body from them. "All settings" and "JSON" on the page
 * still reach every field of the real schema.
 *
 * Every adapter here was written from the model's published input schema
 * (docs.comfy.org/router-schemas/<id>.json), and server/router/router_test.js
 * validates each one's output against a trimmed copy of that schema, so a
 * body that the Router would refuse with a 422 fails the commit instead.
 *
 * Media fields arrive from the page as { mime, data } with `data` in base64.
 * How each model wants them differs, and each adapter says so in its build:
 * a data URI, raw base64, or base64 beside a mimeType.
 */

const dataUri = (f) => (f?.data ? `data:${f.mime || "application/octet-stream"};base64,${f.data}` : null);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const num = (v, d) => (v === "" || v === undefined || v === null || !Number.isFinite(Number(v)) ? d : Number(v));
const pick = (v, list, d) => (list.includes(v) ? v : d);

/* Field shapes the page knows how to draw. `media` fields take an upload. */
const F = {
  prompt: (label = "prompt", extra = {}) => ({ name: "prompt", type: "longtext", label, required: true, ...extra }),
  image: (name, label, extra = {}) => ({ name, type: "media", media: "image", label, ...extra }),
  choice: (name, label, options, def) => ({ name, type: "enum", label, options, default: def }),
  int: (name, label, min, max, def) => ({ name, type: "int", label, min, max, default: def }),
  bool: (name, label, def) => ({ name, type: "bool", label, default: def }),
  text: (name, label, extra = {}) => ({ name, type: "text", label, ...extra }),
};

export const ADAPTERS = {
  /* BytePlus Seedance / Dreamina: content[] of text and image_url items, an
   * image as a data URI with a role. */
  seedance: {
    fields: [
      F.prompt(),
      F.image("first_frame", "opening frame"),
      F.image("last_frame", "closing frame"),
      F.choice("ratio", "shape", ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"], "16:9"),
      F.choice("resolution", "resolution", ["480p", "720p", "1080p"], "720p"),
      F.int("duration", "seconds", 4, 15, 5),
      F.bool("generate_audio", "with sound", true),
    ],
    build(s, files = {}) {
      const content = [{ type: "text", text: str(s.prompt) }];
      for (const role of ["first_frame", "last_frame"]) {
        const u = dataUri(files[role]);
        if (u) content.push({ type: "image_url", image_url: { url: u }, role });
      }
      return {
        content,
        ratio: pick(s.ratio, this.fields[3].options, "16:9"),
        resolution: pick(s.resolution, this.fields[4].options, "720p"),
        duration: Math.round(num(s.duration, 5)),
        generate_audio: s.generate_audio !== false,
      };
    },
  },

  /* MiniMax H3 through the Router (MiniMax V2 / Hailuo 03): the same content[]
   * idea, its own options. `ratio` must not be adaptive for text-to-video. */
  hailuo: {
    fields: [
      F.prompt(),
      F.image("first_frame", "opening frame"),
      F.image("last_frame", "closing frame"),
      F.choice("ratio", "shape", ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], "16:9"),
      F.choice("resolution", "resolution", ["768P", "2K"], "768P"),
      F.int("duration", "seconds", 5, 15, 5),
    ],
    build(s, files = {}) {
      const content = [{ type: "text", text: str(s.prompt) }];
      for (const role of ["first_frame", "last_frame"]) {
        const u = dataUri(files[role]);
        if (u) content.push({ type: "image_url", image_url: { url: u }, role });
      }
      return {
        content,
        ratio: pick(s.ratio, this.fields[3].options, "16:9"),
        resolution: pick(s.resolution, this.fields[4].options, "768P"),
        duration: Math.min(15, Math.max(5, Math.round(num(s.duration, 5)))),
      };
    },
  },

  /* Google Veo: instances[] with an optional first frame as raw base64 beside
   * its mimeType (JPEG or PNG only), parameters beside it. */
  veo: {
    fields: [
      F.prompt(),
      F.image("image", "opening frame", { accept: "image/png,image/jpeg" }),
      F.choice("aspectRatio", "shape", ["16:9", "9:16"], "16:9"),
      F.choice("resolution", "resolution", ["720p", "1080p", "4k"], "720p"),
      F.choice("durationSeconds", "seconds", ["4", "6", "8"], "8"),
      F.bool("generateAudio", "with sound", true),
    ],
    build(s, files = {}) {
      const inst = { prompt: str(s.prompt) };
      const f = files.image;
      if (f?.data && /^image\/(png|jpeg)$/.test(f.mime || "")) inst.image = { bytesBase64Encoded: f.data, mimeType: f.mime };
      return {
        instances: [inst],
        parameters: {
          aspectRatio: pick(s.aspectRatio, ["16:9", "9:16"], "16:9"),
          resolution: pick(s.resolution, ["720p", "1080p", "4k"], "720p"),
          durationSeconds: Number(pick(String(s.durationSeconds), ["4", "6", "8"], "8")),
          generateAudio: s.generateAudio !== false,
        },
      };
    },
  },

  /* Wan 3.0 video: input{} and parameters{}. Text only here: its first frame
   * takes a public URL, which a file on this computer is not. */
  wan: {
    fields: [
      F.prompt(),
      F.text("negative_prompt", "avoid"),
      F.choice("resolution", "resolution", ["480P", "720P", "1080P"], "720P"),
      F.choice("ratio", "shape", ["16:9", "9:16", "1:1", "4:3", "3:4", "adaptive"], "16:9"),
      F.int("duration", "seconds", 2, 30, 5),
      F.bool("audio", "with sound", true),
    ],
    build(s) {
      const input = { prompt: str(s.prompt) };
      if (str(s.negative_prompt)) input.negative_prompt = str(s.negative_prompt);
      return {
        input,
        parameters: {
          resolution: pick(s.resolution, ["480P", "720P", "1080P"], "720P"),
          ratio: pick(s.ratio, ["16:9", "9:16", "1:1", "4:3", "3:4", "adaptive"], "16:9"),
          duration: Math.round(num(s.duration, 5)),
          audio: s.audio !== false,
        },
      };
    },
  },

  /* Qwen Image 3.0: one user message whose content is a text item plus up to
   * three image items (URL or base64: a data URI). */
  qwenImage: {
    fields: [
      F.prompt(),
      F.image("image", "edit this picture"),
      F.text("negative_prompt", "avoid"),
      F.text("size", "size", { placeholder: "auto, or 1024*1024" }),
      F.int("n", "pictures", 1, 6, 1),
    ],
    build(s, files = {}) {
      const content = [{ text: str(s.prompt) }];
      const u = dataUri(files.image);
      if (u) content.push({ image: u });
      const parameters = { n: Math.round(num(s.n, 1)) };
      if (str(s.negative_prompt)) parameters.negative_prompt = str(s.negative_prompt);
      if (/^\d{3,4}\*\d{3,4}$/.test(str(s.size))) parameters.size = str(s.size);
      return { input: { messages: [{ role: "user", content }] }, parameters };
    },
  },

  /* Gemini (Vertex AI), pictures and words alike: contents[].parts[] with the
   * text and, optionally, a picture as inlineData. */
  geminiImage: {
    fields: [
      F.prompt(),
      F.image("image", "edit this picture"),
      F.choice("aspectRatio", "shape", ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"], "1:1"),
    ],
    build(s, files = {}) {
      const parts = [{ text: str(s.prompt) }];
      if (files.image?.data) parts.push({ inlineData: { mimeType: files.image.mime || "image/png", data: files.image.data } });
      return {
        contents: [{ role: "user", parts }],
        generationConfig: { imageConfig: { aspectRatio: pick(s.aspectRatio, this.fields[2].options, "1:1") } },
      };
    },
  },
  geminiText: {
    fields: [
      F.prompt("message"),
      F.image("image", "picture"),
      F.text("system", "instructions"),
    ],
    build(s, files = {}) {
      const parts = [{ text: str(s.prompt) }];
      if (files.image?.data) parts.push({ inlineData: { mimeType: files.image.mime || "image/png", data: files.image.data } });
      const body = { contents: [{ role: "user", parts }] };
      if (str(s.system)) body.systemInstruction = { parts: [{ text: str(s.system) }] };
      return body;
    },
  },

  /* Claude: the Anthropic Messages body. A picture rides as a base64 image
   * block before the text, the order Anthropic recommends. */
  anthropic: {
    fields: [
      F.prompt("message"),
      F.image("image", "picture", { accept: "image/png,image/jpeg,image/webp,image/gif" }),
      F.text("system", "instructions"),
      F.int("max_tokens", "max length", 16, 64000, 4096),
    ],
    build(s, files = {}) {
      const text = str(s.prompt);
      const f = files.image;
      const content = f?.data
        ? [{ type: "image", source: { type: "base64", media_type: f.mime || "image/png", data: f.data } }, { type: "text", text }]
        : text;
      const body = { max_tokens: Math.round(num(s.max_tokens, 4096)), messages: [{ role: "user", content }] };
      if (str(s.system)) body.system = str(s.system);
      return body;
    },
  },

  /* OpenAI Responses API: `input` as plain text, `instructions` for the system. */
  openaiText: {
    fields: [
      F.prompt("message"),
      F.text("instructions", "instructions"),
    ],
    build(s) {
      const body = { input: str(s.prompt) };
      if (str(s.instructions)) body.instructions = str(s.instructions);
      return body;
    },
  },

  /* ElevenLabs v3 dialogue: inputs[] of {text, voice_id}. One speaker here. */
  eleven: {
    fields: [
      F.prompt("words"),
      F.text("voice_id", "voice id", { required: true, placeholder: "an ElevenLabs voice ID" }),
    ],
    build(s) {
      return { inputs: [{ text: str(s.prompt), voice_id: str(s.voice_id) }] };
    },
  },

  /* xAI Grok Imagine video: flat, except the opening frame is an object with a
   * public URL or a base64 data URI. */
  grokVideo: {
    fields: [
      F.prompt(),
      F.image("image", "opening frame"),
      F.choice("aspect_ratio", "shape", ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"], "16:9"),
      F.int("duration", "seconds", 1, 15, 8),
    ],
    build(s, files = {}) {
      const body = {
        prompt: str(s.prompt),
        aspect_ratio: pick(s.aspect_ratio, this.fields[2].options, "16:9"),
        duration: Math.round(num(s.duration, 8)),
      };
      const u = dataUri(files.image);
      if (u) body.image = { type: "image_url", url: u };
      return body;
    },
  },

  /* Meshy text to 3D, the preview stage (the model without texture). The
   * refine stage needs the preview's task id and is reachable from JSON. */
  meshy: {
    fields: [
      F.prompt("describe the object"),
      F.choice("art_style", "style", ["realistic", "sculpture"], "realistic"),
      F.choice("topology", "topology", ["triangle", "quad"], "triangle"),
      F.int("target_polycount", "polygons", 100, 300000, 30000),
    ],
    build(s) {
      return {
        mode: "preview",
        prompt: str(s.prompt).slice(0, 600),
        art_style: pick(s.art_style, ["realistic", "sculpture"], "realistic"),
        topology: pick(s.topology, ["triangle", "quad"], "triangle"),
        target_polycount: Math.round(num(s.target_polycount, 30000)),
      };
    },
  },
};

/**
 * The featured models, per kind, in the order the page lists them. `adapter`
 * names a simple form above; without one the page draws the schema's own
 * fields. Checked against the catalogue by the tests.
 */
export const FEATURED = [
  { id: "bfl/flux-2-pro", kind: "image", label: "FLUX.2 Pro" },
  { id: "openai/gpt-image-2", kind: "image", label: "GPT Image 2" },
  { id: "vertexai/gemini-3-pro-image", kind: "image", label: "Nano Banana Pro (Gemini 3 Pro Image)", adapter: "geminiImage" },
  { id: "byteplus/seedream-5-0-pro-260628", kind: "image", label: "Seedream 5.0 Pro" },
  { id: "ideogram/ideogram-v4", kind: "image", label: "Ideogram 4" },
  { id: "qwen/qwen-image-3.0-pro", kind: "image", label: "Qwen Image 3.0 Pro", adapter: "qwenImage" },
  { id: "xai/grok-imagine-image-pro", kind: "image", label: "Grok Imagine Pro" },
  { id: "krea/krea-2", kind: "image", label: "Krea 2" },
  { id: "recraft/recraftv4_1_pro", kind: "image", label: "Recraft V4.1 Pro" },

  { id: "byteplus/dreamina-seedance-2-5-260628", kind: "video", label: "Seedance 2.5", adapter: "seedance" },
  { id: "kling/kling-v3", kind: "video", label: "Kling 3.0" },
  { id: "veo/veo-3.1-generate-001", kind: "video", label: "Veo 3.1", adapter: "veo" },
  { id: "minimax/minimax-h3", kind: "video", label: "MiniMax Hailuo 03", adapter: "hailuo" },
  { id: "ltx/ltx-2-5-pro", kind: "video", label: "LTX 2.5 Pro" },
  { id: "xai/grok-imagine-video-1.5", kind: "video", label: "Grok Imagine Video 1.5", adapter: "grokVideo" },
  { id: "wan/wan3.0-video", kind: "video", label: "Wan 3.0", adapter: "wan" },
  { id: "luma/ray-2", kind: "video", label: "Luma Ray 2" },

  { id: "elevenlabs/eleven_sfx_v2", kind: "audio", label: "ElevenLabs sound effects" },
  { id: "elevenlabs/eleven_v3", kind: "audio", label: "ElevenLabs v3 speech", adapter: "eleven" },
  { id: "byteplus/seed-audio-1.0", kind: "audio", label: "Seed Audio 1.0" },

  { id: "meshy/meshy-7.1", kind: "3d", label: "Meshy 7.1 (text to 3D)", adapter: "meshy" },

  { id: "anthropic/claude-opus-5-5", kind: "text", label: "Claude Opus 5.5", adapter: "anthropic" },
  { id: "anthropic/claude-sonnet-5", kind: "text", label: "Claude Sonnet 5", adapter: "anthropic" },
  { id: "openai/gpt-5.5", kind: "text", label: "GPT-5.5", adapter: "openaiText" },
  { id: "vertexai/gemini-3.5-flash", kind: "text", label: "Gemini 3.5 Flash", adapter: "geminiText" },
];

export const featuredById = (id) => FEATURED.find((f) => f.id === id) || null;

/** The simple form for a model, or null when the page draws the schema. */
export function simpleFor(id) {
  const f = featuredById(id);
  const a = f?.adapter ? ADAPTERS[f.adapter] : null;
  return a ? { adapter: f.adapter, fields: a.fields } : null;
}

/** The native body from a simple form. Throws when a required field is empty. */
export function buildSimple(id, simple = {}, files = {}) {
  const f = featuredById(id);
  const a = f?.adapter ? ADAPTERS[f.adapter] : null;
  if (!a) throw new Error("That model has no simple form. Use All settings.");
  for (const fl of a.fields) {
    if (fl.required && fl.type !== "media" && !str(simple[fl.name])) throw new Error(`Fill in ${fl.label}.`);
  }
  return a.build(simple, files);
}
