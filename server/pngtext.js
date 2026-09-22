/* STRIPPING WHAT COMFYUI WRITES INSIDE THE PICTURE.
 *
 * ComfyUI's SaveImage stamps the executed graph into the PNG itself, as a tEXt
 * chunk keyed "prompt" (and often a "workflow" twin). The graph contains the
 * CLIPTextEncode node, so the prompt text travels INSIDE every file — measured
 * on one real library: 40 of 40 covers carried it, and 4 of 40 images (the rest
 * were clean only because apply_edit had re-saved them through PIL, which drops
 * chunks as a side effect rather than as a policy).
 *
 * ⚠ THIS REWRITES THE CHUNK LIST, IT DOES NOT RE-ENCODE. Loading and re-saving
 * through an image library would also drop the chunks, and would cost a full
 * decode and deflate — measured elsewhere in this app at ~178 ms for a 1024
 * PNG — and would silently change the pixels' bytes. A PNG is a length-prefixed
 * chunk stream: copying every chunk except the text ones is lossless, leaves the
 * IDAT bytes identical, and costs a read and a write.
 *
 * ⚠ IT KEEPS XMP. `iTXt` is also the carrier for the app's OWN provenance
 * record — the IPTC DigitalSourceType disclosure that says a picture is
 * AI-generated, which imgexport writes under the keyword "XML:com.adobe.xmp".
 * Dropping that would turn a privacy feature into a disclosure-removal tool,
 * which is the one thing it must not be. Privacy is about the words somebody
 * typed, never about hiding what made the picture.
 */
import { readFile, writeFile } from "node:fs/promises";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* The three text chunk types, and the one keyword inside them that stays. */
const TEXT_TYPES = new Set(["tEXt", "zTXt", "iTXt"]);
const KEEP_KEYWORDS = ["XML:com.adobe.xmp"];

/** The chunk's keyword — the bytes before the first NUL — or "" if unreadable. */
function keywordOf(data) {
  const nul = data.indexOf(0);
  return nul <= 0 ? "" : data.subarray(0, nul).toString("latin1");
}

/**
 * Drop ComfyUI's text chunks from a PNG, in place.
 *
 * Returns { stripped: [keywords], bytesBefore, bytesAfter } — or
 * { stripped: [], skipped: "why" } when the file is not a PNG this understands,
 * which is not an error: a JPEG cover and a WebP export are both legitimate and
 * simply carry their metadata elsewhere.
 */
export async function stripPngText(file, { keep = KEEP_KEYWORDS } = {}) {
  const buf = await readFile(file);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
    return { stripped: [], skipped: "not a PNG" };
  }
  const out = [buf.subarray(0, 8)];
  const stripped = [];
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString("latin1");
    const end = i + 12 + len;                   // length + type + data + crc
    /* A truncated or lying length must not send this past the buffer: copy the
     * remainder untouched and stop, because a half-written PNG is somebody's
     * picture and this is not the place to decide it is rubbish. */
    if (end > buf.length) { out.push(buf.subarray(i)); i = buf.length; break; }
    const chunk = buf.subarray(i, end);
    if (TEXT_TYPES.has(type)) {
      const kw = keywordOf(buf.subarray(i + 8, i + 8 + len));
      if (keep.includes(kw)) out.push(chunk);
      else stripped.push(kw || type);
    } else {
      out.push(chunk);
    }
    i = end;
    if (type === "IEND") break;
  }
  if (!stripped.length) return { stripped: [], bytesBefore: buf.length, bytesAfter: buf.length };
  const next = Buffer.concat(out);
  await writeFile(file, next);
  return { stripped, bytesBefore: buf.length, bytesAfter: next.length };
}
