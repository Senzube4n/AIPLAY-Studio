/**
 * The vocal stem as a transcription source, 2026-09-17.
 *
 * SheetSage2 reads a whole mix; on a rap it filed the tune under the Ins
 * staff and left Vocal as rests (MEASURED 2026-09-17, aiplay_00095). The
 * separation the Studio already runs (demucs, art.js #separate) puts the
 * voice on its own — so a cover can transcribe THAT, and the melody the
 * planner gets is the one that was sung. This module finds the stem or has
 * it made, through the art queue's own door, and waits for the queue's own
 * "stems" event rather than polling the disk.
 */
import path from "node:path";
import { stat } from "node:fs/promises";

/** Where demucs leaves the vocal stem for a library file. */
export function vocalStemPath(file, { outputDir, model = "htdemucs_ft" }) {
  return stemPath(file, "vocals", { outputDir, model });
}

/** The four stems htdemucs_ft writes, side by side in one folder per song. */
export const STEMS = ["vocals", "drums", "bass", "other"];

/** Where demucs leaves ANY stem for a library file. Reactive cuts on the drum
 *  stem's hits (the way Yvann's workflow detects peaks on "Drums Only"), the
 *  cover path reads the vocal one; same folder, same model. */
export function stemPath(file, stem, { outputDir, model = "htdemucs_ft" }) {
  if (!STEMS.includes(stem)) throw new Error(`No stem called "${stem}". Demucs writes: ${STEMS.join(", ")}.`);
  const base = path.basename(String(file)).replace(/\.(flac|mp3|opus|wav)$/i, "");
  return path.join(outputDir, "stems", model, base, `${stem}.flac`);
}

/**
 * The vocal stem's path — made first when it is not on disk. `art` is the
 * ArtRunner (request + "stems" events); `timeoutMs` bounds the wait.
 * Rejects by sentence when the queue refuses or the separation fails.
 */
export async function ensureVocalStem(file, opts = {}) {
  return ensureStem(file, "vocals", opts);
}

/**
 * Any stem's path — made first when it is not on disk. One separation writes
 * all four, so asking for the drums after the vocals costs nothing.
 */
export async function ensureStem(file, stem, { art, outputDir, model = "htdemucs_ft", actor = "user", timeoutMs = 900_000 } = {}) {
  const target = stemPath(file, stem, { outputDir, model });
  if (await stat(target).then((s) => s.isFile()).catch(() => false)) return { path: target, made: false };
  const name = path.basename(String(file));
  const waited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { art.off("stems", onStems); reject(new Error(`the separation of ${name} did not finish within ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
    function onStems(ev) {
      if (ev?.file !== name) return;
      clearTimeout(timer);
      art.off("stems", onStems);
      if (!ev.stems?.length) return reject(new Error(`the separation of ${name} produced no stems — see the console`));
      resolve();
    }
    art.on("stems", onStems);
  });
  const job = art.request({ file: name, kind: "stems", force: true, actor });
  if (!job) throw new Error(`the art queue refused to separate ${name}`);
  await waited;
  if (!(await stat(target).then((s) => s.isFile()).catch(() => false))) {
    throw new Error(`the separation finished but ${target} is not there`);
  }
  return { path: target, made: true };
}
