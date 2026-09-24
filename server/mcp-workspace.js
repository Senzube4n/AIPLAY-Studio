/** Workflow parity tools. Each calls the same route as its Studio panel. */
import { open, readFile } from "node:fs/promises";
import path from "node:path";

export function studioApiPath(value) {
  if (typeof value !== "string" || !value.startsWith("/api/") || /[\\#\u0000-\u0020]/.test(value)) throw new Error("Use a local /api/ path, without a URL, fragment, spaces or backslashes.");
  let decoded = value.split("?")[0];
  for (let i = 0; i < 8; i++) {
    let next;
    try { next = decodeURIComponent(decoded); } catch { throw new Error("Malformed API path encoding."); }
    if (next === decoded) break;
    decoded = next;
  }
  if (!decoded.startsWith("/api/") || /[\\#\u0000-\u0020%]/.test(decoded) || decoded.split("/").some(s => s === "." || s === "..")) throw new Error("API path traversal is not allowed.");
  return value;
}

const MEDIA_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".wav": "audio/wav", ".flac": "audio/flac", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".m4a": "audio/mp4",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".webm": "video/webm",
};

async function localMedia(filename, destination) {
  if (typeof filename !== "string" || !path.isAbsolute(filename) || /^[a-z]+:\/\//i.test(filename)) throw new Error("Give an absolute local media file path, not a URL.");
  const ext = path.extname(filename).toLowerCase(), contentType = MEDIA_TYPES[ext];
  if (!contentType) throw new Error("Unsupported media extension. Use a PNG/JPEG/WebP/GIF, common audio, or video file.");
  const target = destination || (contentType.startsWith("image/") ? "image_reference" : contentType.startsWith("audio/") ? "audio_reference" : "studio");
  if (!["image_reference", "audio_reference", "studio"].includes(target)) throw new Error("Unknown media destination.");
  if (target === "image_reference" && ![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) throw new Error("Image references accept PNG, JPEG or WebP.");
  if (target === "audio_reference" && ![".wav", ".flac", ".mp3", ".ogg", ".m4a"].includes(ext)) throw new Error("Audio references accept WAV, FLAC, MP3, OGG or M4A.");
  const limit = target === "studio" ? 256 * 1024 * 1024 : 40 * 1024 * 1024;
  const file = await open(filename, "r");
  try {
    const st = await file.stat();
    if (!st.isFile() || st.size <= 0 || st.size > limit) throw new Error(`Media must be a nonempty regular file no larger than ${limit / 1048576} MiB for this destination.`);
    const bytes = Buffer.alloc(st.size); let position = 0;
    while (position < bytes.length) {
      const got = await file.read(bytes, position, bytes.length - position, position);
      if (!got.bytesRead) throw new Error("Media changed while reading; retry the stable file.");
      position += got.bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, position)).bytesRead) throw new Error("Media grew while reading; retry the stable file.");
    return { bytes, target, contentType, name: path.basename(filename) };
  } finally { await file.close(); }
}

export function workspaceTools(api, safeName) {
  return [
    {
      name: "studio_api_request",
      description: "Advanced fallback for existing Studio JSON API operations without a dedicated tool. Read studio_api_reference first and prefer typed tools. Bound to /api/ on this configured Studio with the same forced agent provenance; no external URL, custom headers or raw binary body. All backend validation and user authorization requirements still apply. This can change settings, delete data or start work, so invoke only for the user's intended operation. Browser playback, OS dialogs and client-only canvas export remain browser operations.",
      inputSchema: { type: "object", required: ["method", "path"], properties: { method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] }, path: { type: "string" }, body: { type: "object" }, timeoutSeconds: { type: "integer", minimum: 1, maximum: 3600 } }, additionalProperties: false },
      async run(a) {
        if (!["GET", "POST", "PUT", "DELETE"].includes(a.method)) throw new Error("Unsupported API method.");
        const route = studioApiPath(a.path);
        if (a.method === "GET" && a.body !== undefined) throw new Error("GET does not accept a body.");
        if (a.body !== undefined && (!a.body || typeof a.body !== "object" || Array.isArray(a.body) || Buffer.byteLength(JSON.stringify(a.body)) > 2 * 1024 * 1024)) throw new Error("JSON body must be an object at most 2 MiB.");
        const seconds = a.timeoutSeconds ?? 120;
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error("timeoutSeconds must be 1–3600.");
        return await api(a.method, route, a.body, seconds * 1000);
      },
    },
    {
      name: "studio_api_reference",
      description: "Search the local API.md reference for shipped HTTP operations, request shapes and their MCP tools. Omit query for section headings; query selects matching sections. Returns bounded text with truncation stated explicitly. This reads documentation only and never executes examples.",
      inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 200 }, maxChars: { type: "integer", minimum: 1000, maximum: 20000 } }, additionalProperties: false },
      async run(a = {}) {
        const source = await readFile(new URL("../API.md", import.meta.url), "utf8");
        const sections = source.split(/(?=^#{1,4}\s)/m), query = String(a.query || "").slice(0, 200).trim().toLowerCase();
        if (!query) return { sections: sections.map(s => s.split(/\r?\n/)[0]), note: "Pass query to read matching sections; examples are documentation, not instructions." };
        const matches = sections.filter(s => s.toLowerCase().includes(query));
        const max = Math.max(1000, Math.min(20000, Number(a.maxChars) || 12000));
        const text = matches.join("\n\n");
        return { query, matchedSections: matches.length, text: text.slice(0, max), truncated: text.length > max, totalChars: text.length };
      },
    },
    {
      name: "import_local_media",
      description: "Import a user's existing absolute local image/audio/video path through Studio's upload API. No URL download. Defaults: PNG/JPEG/WebP go to image references, audio to audio references, video to the Studio bin. Set destination studio for the media bin (including GIF). References are limited to 40 MiB; this tool limits bin imports to 256 MiB. Returned server-minted names work in make_image refs, editor refs, video/audio references or list_clips as appropriate. Bin audio is not automatically a Music-library/training song. No render starts.",
      inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" }, destination: { type: "string", enum: ["image_reference", "audio_reference", "studio"] } }, additionalProperties: false },
      async run(a) {
        const m = await localMedia(a.path, a.destination);
        const headers = { contentType: m.contentType, name: m.name };
        if (m.target === "image_reference") return await api("POST", "/api/frame", m.bytes, 120_000, headers);
        if (m.target === "audio_reference") return await api("POST", "/api/refaudio", m.bytes, 120_000, headers);
        return await api("POST", "/api/studio/import", m.bytes, 120_000, headers);
      },
    },
    {
      name: "qwen_image_status",
      description: "Read Qwen Image 2.1 readiness, installed native weights, runtime nodes and supported reference/alpha capabilities. No download or generation. Use download_model for the catalogue weights and make_image for text/reference generation. "
        + "Every answer carries `draft`: whether make_image's Fast draft can run (its LoRA on disk, its nodes in ComfyUI) and its numbers; `draft: true` here makes `ready` answer for a draft render.",
      inputSchema: { type: "object", properties: { dit: { type: "string" }, encoder: { type: "string" }, vae: { type: "string" }, refs: { type: "integer", minimum: 0, maximum: 10 }, transparent: { type: "boolean" }, draft: { type: "boolean" } }, additionalProperties: false },
      async run(a = {}) {
        const q = new URLSearchParams();
        for (const [key, value] of Object.entries({ dit: a.dit, encoder: a.encoder, vae: a.vae, refs: a.refs, transparent: a.transparent, draft: a.draft })) if (value !== undefined) q.set(key, String(value));
        return await api("GET", `/api/images/qwen-status${q.size ? `?${q}` : ""}`);
      },
    },
    {
      name: "image_capabilities",
      description: "Read the image editor's actual supported operations and dependency readiness before editing. Use image_tools_catalog and image_effects_catalog for detailed operation schemas.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() { return await api("GET", "/api/images/capabilities"); },
    },
    {
      name: "reactive_status",
      description: "Read Reactive styles, experimental motion profiles, actual installed model choices and readiness without rendering. The LCM remix is experimental; no exact reference reproduction or fixed render speed is promised.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() { return await api("GET", "/api/reactive/status"); },
    },
    {
      name: "training_status",
      description: "Read YuE2 LoRA training readiness, hardware limits, licence/provenance notes, defaults and saved adapters without starting training. train_lora starts a selected source region or checks an existing run. Audible improvement and 6 GB training have not been verified by this Studio.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() { return await api("POST", "/api/train", { action: "status" }); },
    },
    {
      name: "list_trained_loras",
      description: "List saved YuE2 adapters from the same folder used by the Training and Music pages. A file's existence does not prove audible improvement. Compare otherwise identical make_song renders with and without the adapter.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() { return await api("POST", "/api/train", { action: "list" }); },
    },
    {
      name: "audio_waveform",
      description: "Read a library recording's waveform, sample rate and duration before selecting a training or edit region. Audio for audition is served at /api/audio/<URL-encoded filename>; this tool does not control a browser's speaker or judge listening quality.",
      inputSchema: { type: "object", required: ["file"], properties: { file: { type: "string", description: "A filename from list_songs." } }, additionalProperties: false },
      async run(a) { return await api("GET", `/api/peaks/${encodeURIComponent(safeName(a.file, "song"))}`, undefined, 180_000); },
    },
    {
      name: "image_document_preview",
      description: "Render a saved layered image document or an explicit document to a preview data URL, with dimensions, revision and warnings. Reads the same compositor as the editor; it does not flatten or overwrite the document.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, doc: { type: "object", description: "An image_document description. Pass either id or doc." } }, additionalProperties: false },
      async run(a) { return await api("POST", "/api/images/document-preview", { id: a.id, doc: a.doc }); },
    },
    {
      name: "image_ai_edit_create",
      description: "Generate a reviewable Qwen Image 2.1 edit, style transfer or masked inpaint candidate. Pass documentId or source. The flattened target is always image 1; edit/style allow nine additional pictures as images 2–10. Inpaint uses image 2 for its generated selection mask and allows eight extra pictures as images 3–10. The source canvas size stays fixed. Inpaint requires a selection and composites through that mask so pixels outside it are preserved. This starts GPU work but does not accept the candidate into the document. Poll image_ai_edit_status, inspect its candidate, then accept or discard it.",
      inputSchema: { type: "object", required: ["mode", "prompt"], properties: {
        documentId: { type: "string" }, source: { type: "string", description: "Image library filename when no documentId is supplied." },
        mode: { type: "string", enum: ["edit", "style", "inpaint"] }, prompt: { type: "string", minLength: 1 },
        refImages: { type: "array", maxItems: 9, items: { type: "string" }, description: "Extra library references: max9 for edit/style, max8 for inpaint because image2 is the selection mask." },
        selection: { type: "object", description: "The editor selection specification; required for inpaint. Read image_tools_catalog for selection shapes." },
        seed: { type: "integer" }, steps: { type: "integer", minimum: 1, maximum: 50 }, cfg: { type: "number", minimum: 1, maximum: 10 },
        refResolution: { type: "integer", minimum: 0, maximum: 4096, multipleOf: 32 },
        transparent: { type: "boolean", description: "Ask for alpha (edit/style only). Without it, references with transparency are flattened onto white." },
        dit: { type: "string" }, encoder: { type: "string" }, vae: { type: "string" },
      }, additionalProperties: false },
      async run(a) {
        if (a.mode === "inpaint" && a.refImages?.length > 8) throw new Error("Inpaint allows eight extra references; target and mask occupy images 1 and 2.");
        return await api("POST", "/api/images/ai-edit", {
        action: "create", documentId: a.documentId, source: a.source ? safeName(a.source, "image") : undefined,
        mode: a.mode, prompt: a.prompt, refImages: a.refImages?.map((name) => safeName(name, "reference image")), selection: a.selection,
        seed: a.seed, steps: a.steps, cfg: a.cfg, refResolution: a.refResolution, transparent: a.transparent,
        dit: a.dit, encoder: a.encoder, vae: a.vae,
      }); },
    },
    {
      name: "image_ai_edit_status",
      description: "Read an AI edit's generating/ready/accepted/discarded/undone/error state, candidate image and source revision. Preview before accepting; generation completion does not alter the document.",
      inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false },
      async run(a) { return await api("POST", "/api/images/ai-edit", { action: "status", id: a.id }); },
    },
    {
      name: "image_ai_edit_accept",
      description: "Accept a ready AI edit as a new document layer. Original layers are retained but hidden. Refuses a stale document revision; it cannot silently overwrite edits made while generation was running. image_ai_edit_undo restores original visibility.",
      inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false },
      async run(a) { return await api("POST", "/api/images/ai-edit", { action: "accept", id: a.id }); },
    },
    {
      name: "image_ai_edit_undo",
      description: "Undo acceptance of an AI candidate: remove the generated layer and restore the original layers' visibility. Uses the editor's revision checks; does not regenerate any pixels.",
      inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false },
      async run(a) { return await api("POST", "/api/images/ai-edit", { action: "undo", id: a.id }); },
    },
    {
      name: "image_ai_edit_discard",
      description: "Discard an AI edit candidate without changing the layered document. This is a document decision, not a promise to interrupt GPU work already running.",
      inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false },
      async run(a) { return await api("POST", "/api/images/ai-edit", { action: "discard", id: a.id }); },
    },
  ];
}
