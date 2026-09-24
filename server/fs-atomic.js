/**
 * rename(), but survivable on Windows.
 *
 * Lifted verbatim from server/daw/store.js (where it kept DAW saves alive) so
 * the library's tag rewrite can use the same one; server/tag_audio.py carries
 * the same retry around os.replace for the FLAC/MP3 half.
 *
 * Replacing a file there fails with EPERM/EBUSY while ANYONE holds the
 * target open, and Node's readFile does not ask for share-delete. So the
 * live-sync watcher re-reading a document, a backup tool, antivirus, or a
 * player still streaming the song can all lose a save that has nothing to do
 * with them — and the failure lands on the write, which is the one party that
 * did nothing wrong.
 *
 * Those holders let go in milliseconds, so a short backoff turns a lost save
 * into a slightly slower one: 12 retries, waiting min(10·(i+1), 120) ms each,
 * about 0.8 s in all. Anything still failing after that is a real problem and
 * is raised unchanged.
 */
import { rename } from "node:fs/promises";

/** The error codes a transient holder produces. */
export const TRANSIENT_RENAME_CODES = Object.freeze(["EPERM", "EBUSY", "EACCES"]);

export async function renameAtomic(from, to, tries = 12, { renameFn = rename } = {}) {
  for (let i = 0; ; i++) {
    try {
      await renameFn(from, to);
      return;
    } catch (err) {
      const transient = TRANSIENT_RENAME_CODES.includes(err?.code);
      if (!transient || i >= tries) throw err;
      await new Promise((r) => setTimeout(r, Math.min(10 * (i + 1), 120)));
    }
  }
}
