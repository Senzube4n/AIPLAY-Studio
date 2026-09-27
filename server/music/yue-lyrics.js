/**
 * YuE2 SINGS LABELLED LYRICS (2026-09-27).
 *
 * Reported: a YuE2-through-ComfyUI song about cheese sang none of its words.
 * Its lyrics were one line, "I love raw cheese", 38 times, with no section
 * labels. Whisper (large-v3) on the take heard only "Ah, ah, ah" for three
 * minutes. The same engine's "Cheese Drill" in the same library, labelled
 * [Intro] / [Verse 1] / [Chorus], came back nearly word for word. Every other
 * YuE2 song in that library carried labels too.
 *
 * YuE2 is trained on labelled lyrics (server/music/yue.js refuseLyrics, the
 * vendor's example request, ComfyUI's own YuE2 template, docs/YUE2_GGUF.md),
 * and ComfyUI's node hands the lyrics to the model verbatim
 * (comfy/text_encoders/yue2.py: "[Lyrics]\n{lyrics}"). So lyrics with NO
 * label at all are given them before they reach any YuE2 build: each
 * blank-line block becomes a [Verse], and a block sung again word for word
 * becomes a [Chorus] every time it comes. Lyrics that carry even one label
 * are the writer's structure and are never touched.
 */
import { SECTION_LABEL_RE } from "./yue.js";

const norm = (block) => block.map((l) => l.trim().toLowerCase()).join("\n");

/** → { lyrics, changed }. */
export function labelYueLyrics(lyrics) {
  const text = typeof lyrics === "string" ? lyrics.replace(/\r\n/g, "\n") : "";
  if (!text.trim() || text.split("\n").some((l) => SECTION_LABEL_RE.test(l))) return { lyrics, changed: false };
  const blocks = [];
  let cur = [];
  for (const line of text.split("\n")) {
    if (line.trim()) cur.push(line.trimEnd());
    else if (cur.length) { blocks.push(cur); cur = []; }
  }
  if (cur.length) blocks.push(cur);
  const seen = new Map();
  for (const b of blocks) seen.set(norm(b), (seen.get(norm(b)) || 0) + 1);
  const out = blocks.map((b) => `${seen.get(norm(b)) > 1 ? "[Chorus]" : "[Verse]"}\n${b.join("\n")}`);
  return { lyrics: out.join("\n\n"), changed: true };
}
