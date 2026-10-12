/**
 * A LIBRARY SONG, COPIED INTO COMFYUI'S INPUT FOLDER FOR A GRAPH.
 *
 * The song under a clip (its soundtrack, the lip-sync), a clip's reference
 * audio, an ACE cover's source and a music video's scenes all hand a graph a
 * Library song. ComfyUI loads inputs by name from its own input folder, so
 * the song is copied there under a name of ours, and the graph carries that
 * name, never a path.
 *
 * ⚠ THE NAME TEST WAS A CHARACTER CLASS, AND IT DROPPED SONGS WITHOUT A WORD
 * (2026-10-08, found preparing REWIND and Voodoo Love). /api/video staged a
 * Library song only when its file name matched [\w. -]+ with one of five
 * extensions. "aiplay_Voodoo Love (K-pop rework).wav" did not, nor did a
 * comma, a bracket, an apostrophe, an "&", an accented letter, or any song
 * Studio wrote with Settings > Output format = opus. The soundtrack was then
 * dropped (`catch {}`), the clip rendered with H3's own sound and no
 * lip-sync, the reply carried no warning, and the plan, which read the
 * request, still said "+ song (lip-sync)".
 *
 * What keeps the route from reading anywhere else is not the character class:
 * it is that the name must be a bare file name (no separator on Windows or
 * POSIX, no drive or stream colon, no control character, not "." or "..")
 * inside the Library's own folder. So any name the Library lists stages, and
 * one that cannot be staged is refused or warned about in a sentence that
 * names it (server/index.js).
 *
 * The staged copy is named from the source's path, size and modification
 * time, so a song replaced under the same file name is copied again (the
 * music-video runner kept its first copy for ever), and an unchanged one is
 * not copied twice. An .opus song is staged as .ogg: the same Ogg bytes the
 * reference-audio upload door already accepts as "ogg".
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { stat, mkdir, readFile, writeFile } from "node:fs/promises";

/** What the Library lists as a song, and the reference-audio upload accepts. */
export const SONG_EXTS = ["flac", "mp3", "opus", "wav", "ogg", "m4a"];

/** Staged names this module (and /api/refaudio) mint: the only input-folder
 *  names a request may hand back as already staged. */
export const STAGED_SONG = /^aiplay_refaud_[0-9a-f]{12}\.(wav|mp3|flac|ogg|m4a)$/;

function songError(text, name) {
  const err = new Error(text);
  err.reason = "song-missing";
  err.song = String(name ?? "");
  return err;
}

/** The bare Library file name, or an error sentence. Never a path. */
export function libraryName(name) {
  const s = String(name ?? "");
  if (!s.trim()) return { error: "No song was named." };
  if (s.length > 255 || /[\x00-\x1f\x7f:]/.test(s) || s === "." || s === ".."
      || path.win32.basename(s) !== s || path.posix.basename(s) !== s || /[. ]$/.test(s)) {
    return { error: `"${s.slice(0, 120)}" is not the name of a song in the Library. Pick it again from the Library.` };
  }
  const ext = path.extname(s).slice(1).toLowerCase();
  if (!SONG_EXTS.includes(ext)) {
    return { error: `"${s}" is not a song file Studio can use (${SONG_EXTS.join(", ")}).` };
  }
  return { name: s, ext };
}

/**
 * Copy a Library song into ComfyUI's input folder and return the staged name.
 * `check: true` only looks (a plan check stages nothing) and returns null.
 * Throws an Error with `reason: "song-missing"` and a sentence naming the song.
 */
export async function stageLibrarySong(name, { outputDir, inputDir, check = false }) {
  const v = libraryName(name);
  if (v.error) throw songError(v.error, name);
  const src = path.join(outputDir, v.name);
  const st = await stat(src).catch(() => null);
  if (!st?.isFile()) throw songError(`The song "${v.name}" is not in the Library's folder any more (${outputDir}).`, v.name);
  if (check) return null;
  const ext = v.ext === "opus" ? "ogg" : v.ext;
  const key = createHash("sha1").update(`${src}\0${st.size}\0${st.mtimeMs}`).digest("hex").slice(0, 12);
  const staged = `aiplay_refaud_${key}.${ext}`;
  await mkdir(inputDir, { recursive: true });
  const dest = path.join(inputDir, staged);
  if ((await stat(dest).catch(() => null))?.size !== st.size) await writeFile(dest, await readFile(src));
  return staged;
}
