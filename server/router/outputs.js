/**
 * COMFY ROUTER, the result half: find the media in a model's native result.
 *
 * There is no common envelope. BFL puts its picture at `result.sample`, xAI
 * returns URL lists, Veo returns `bytesBase64Encoded`, Gemini returns
 * `inlineData`, some models answer with raw bytes, and the language models
 * return text in four different shapes. So this reads the result by RULE:
 *
 *   - every https URL outside the denylisted keys is a candidate asset; the
 *     download decides (an HTML or JSON answer is not an asset and is dropped);
 *   - base64 in the fields that carry it, and data: URIs anywhere;
 *   - text from the families that return text.
 *
 * ⚠ URLs EXPIRE. Comfy-hosted ones live 12 to 24 hours, provider ones often
 * less, and a replay does not renew them, so assets are downloaded as soon as
 * the result arrives. And the Comfy key is never sent to them: they are
 * provider or storage URLs, not api.comfy.org.
 */

/* Keys whose URLs are plumbing, not results. */
const SKIP_KEY = /callback|status_url|cancel_url|response_url|webhook|docs|help|thumbnail_url_small/i;
const B64_KEY = /^(b64_json|bytesBase64Encoded|base64|b64|audio_base64|image_base64|video_base64|data)$/i;

const MAX_ASSETS = 24;

/**
 * Walk a native result. Returns { urls:[{url,key}], inline:[{mime,b64,key}], text }.
 * Pure: no network.
 */
export function findAssets(result) {
  const urls = [], inline = [], seen = new Set();
  const walk = (v, key, parent, depth) => {
    if (depth > 12 || urls.length + inline.length >= MAX_ASSETS * 2) return;
    if (typeof v === "string") {
      if (/^data:[\w.+-]+\/[\w.+-]+;base64,/i.test(v)) {
        const [head, b64] = v.split(",", 2);
        inline.push({ mime: head.slice(5, head.indexOf(";")), b64, key });
      } else if (/^https:\/\//i.test(v) && !SKIP_KEY.test(key || "") && !seen.has(v)) {
        seen.add(v);
        urls.push({ url: v, key });
      } else if (B64_KEY.test(key || "") && v.length > 256 && /^[A-Za-z0-9+/=\s]+$/.test(v.slice(0, 512))) {
        const mime = parent?.mimeType || parent?.mime_type || parent?.mime || parent?.content_type || null;
        inline.push({ mime, b64: v, key });
      }
      return;
    }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, key, parent, depth + 1)); return; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k, v, depth + 1);
  };
  walk(result, "", null, 0);
  return { urls: urls.slice(0, MAX_ASSETS), inline: inline.slice(0, MAX_ASSETS), text: textOf(result) };
}

/**
 * The words a language model answered with, or null. One reader per family,
 * in the shapes their schemas document:
 *   Anthropic   content[] of {type:"text", text}
 *   OpenAI      output_text, or output[].content[] of {type:"output_text", text}
 *   Gemini      candidates[].content.parts[].text (thought parts skipped)
 *   Chat APIs   choices[].message.content (OpenRouter, BytePlus Seed)
 */
export function textOf(r) {
  if (!r || typeof r !== "object") return null;
  const join = (parts) => {
    const t = parts.filter((x) => typeof x === "string" && x.trim()).join("\n\n").trim();
    return t || null;
  };
  if (Array.isArray(r.content) && r.content.some((c) => c?.type === "text")) {
    return join(r.content.filter((c) => c?.type === "text").map((c) => c.text));
  }
  if (typeof r.output_text === "string" && r.output_text.trim()) return r.output_text.trim();
  if (Array.isArray(r.output)) {
    const t = join(r.output.flatMap((o) => (Array.isArray(o?.content) ? o.content : []))
      .filter((c) => c?.type === "output_text" || c?.type === "text").map((c) => c.text));
    if (t) return t;
  }
  if (Array.isArray(r.candidates)) {
    const t = join(r.candidates.flatMap((c) => c?.content?.parts || []).filter((p) => !p?.thought).map((p) => p?.text));
    if (t) return t;
  }
  if (Array.isArray(r.choices)) {
    const t = join(r.choices.map((c) => (typeof c?.message?.content === "string" ? c.message.content : null)));
    if (t) return t;
  }
  return null;
}

const EXT = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "image/svg+xml": "svg", "image/avif": "avif",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-matroska": "mkv",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
  "audio/ogg": "ogg", "audio/opus": "opus", "audio/flac": "flac", "audio/aac": "aac", "audio/mp4": "m4a",
  "model/gltf-binary": "glb", "model/gltf+json": "gltf", "model/obj": "obj", "model/stl": "stl",
  "application/zip": "zip",
};
const OK_EXT = new Set([...Object.values(EXT), "fbx", "usdz", "blend", "3mf", "ply"]);

/** A file extension for bytes, from the content type, the URL or the bytes. */
export function extFor(mime, url = "", bytes = null) {
  const m = String(mime || "").split(";")[0].trim().toLowerCase();
  if (EXT[m]) return EXT[m];
  const fromUrl = (/\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(String(url).split("?")[0]) || [])[1]?.toLowerCase();
  if (fromUrl && OK_EXT.has(fromUrl)) return fromUrl;
  if (bytes && bytes.length >= 12) {
    const b = bytes;
    if (b[0] === 0x89 && b[1] === 0x50) return "png";
    if (b[0] === 0xff && b[1] === 0xd8) return "jpg";
    if (b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP") return "webp";
    if (b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WAVE") return "wav";
    if (b.slice(0, 4).toString() === "glTF") return "glb";
    if (b.slice(4, 8).toString() === "ftyp") return "mp4";
    if (b.slice(0, 3).toString() === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "mp3";
    if (b.slice(0, 4).toString() === "OggS") return "ogg";
    if (b.slice(0, 4).toString() === "fLaC") return "flac";
    if (b[0] === 0x50 && b[1] === 0x4b) return "zip";
  }
  return null;
}

/** Is this download a result, or a web page / JSON document? */
export function isAsset(mime, ext) {
  const m = String(mime || "").toLowerCase();
  if (/^(text\/html|application\/json|text\/plain)/.test(m)) return false;
  return !!ext;
}
