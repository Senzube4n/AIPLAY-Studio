/**
 * Convert a finished track to another format.
 *
 * THROUGH COMFYUI, NOT FFMPEG. `workflow.js` states the rule this obeys: the app
 * installs one npm dependency and shells out to nothing, and a feature that
 * quietly required ffmpeg on the user's PATH would break that promise for
 * everyone who does not have it. ComfyUI already encodes these formats — it is
 * what `SaveAudioMP3` and `SaveAudioOpus` do when the output-format setting is
 * changed — so a conversion is a two-node graph submitted to the engine Studio
 * is already talking to. No new dependency, no new binary on the PATH.
 *
 * ⚠ WAV IS NOT OFFERED, and that is measured rather than assumed.
 * `SaveAudioAdvanced` takes a `format` input typed COMFY_DYNAMICCOMBO_V3, whose
 * options are not exposed through /object_info. Submitting `format: "wav"` is
 * ACCEPTED by validation — a dynamic combo cannot be checked statically — and
 * then fails at execution with
 *     SaveAudioAdvanced.execute() missing 1 required positional argument: 'format'
 * because the invalid value was dropped rather than rejected. The same node with
 * `format: "flac"` succeeds, so the combo is real and `wav` simply is not in it.
 * Offering a WAV button would produce a spinner and no file.
 */
import { copyFile, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
/* Through the door like every other graph. A container conversion is cheap and
 * unglamorous, and it is still a render this machine performed on the user's
 * audio — worth a line saying which encoder node ran, on what, and how long it
 * took. It also gets the failure recorded, which is the case that used to
 * vanish entirely: the WAV story below produced a "completed" run that wrote
 * nothing at all. */
import { engine } from "./engine/client.js";

/** What the engine can actually produce, with the quality values its nodes take. */
export const FORMATS = {
  mp3: { ext: ".mp3", node: "SaveAudioMP3", qualities: ["V0", "128k", "320k"], lossy: true },
  opus: { ext: ".opus", node: "SaveAudioOpus", qualities: ["64k", "96k", "128k", "192k", "320k"], lossy: true },
  flac: { ext: ".flac", node: "SaveAudio", qualities: null, lossy: false },
};

/** Only a plain filename from our own output folder — never a path. */
function safeSource(file) {
  const name = path.basename(String(file || ""));
  if (!name || name.includes("..") || !/\.(flac|mp3|opus|wav)$/i.test(name)) return null;
  return name;
}

/**
 * Convert one track. Returns { file, subfolder, seconds }.
 *
 * The source is copied into ComfyUI's input folder because `LoadAudio` reads
 * only from there, and removed afterwards — a conversion should not leave a
 * duplicate of every track it touched sitting in the input directory.
 */
export async function convert({ file, format, quality, actor = "system" }) {
  const spec = FORMATS[String(format || "").toLowerCase()];
  if (!spec) throw new Error("Format must be mp3, opus or flac.");
  const src = safeSource(file);
  if (!src) throw new Error("That is not a track in the library.");

  const base = path.basename(src, path.extname(src));
  if (path.extname(src).toLowerCase() === spec.ext) {
    throw new Error(`That track is already ${format.toUpperCase()}.`);
  }

  const staged = `aiplay_export_${Date.now().toString(36)}${path.extname(src)}`;
  await copyFile(path.join(config.outputDir, src), path.join(config.inputDir, staged));

  try {
    const save = { audio: ["1", 0], filename_prefix: `exports/${base}` };
    if (spec.qualities) {
      save.quality = spec.qualities.includes(quality) ? quality : spec.qualities[spec.qualities.length - 1];
    }
    const graph = {
      1: { class_type: "LoadAudio", inputs: { audio: staged } },
      2: { class_type: spec.node, inputs: save },
    };

    /* Poll rather than take the websocket: this is a two-node graph that
     * finishes in about a second, and the socket is the job runner's. 500 ms,
     * because a 3 s cadence would be six times the work itself.
     *
     * `adopt: false`: an export is a copy of a track the library already holds
     * in another container, not a new asset — filing it would put a second row
     * in the library for one song. The route re-stamps it with the source's own
     * provenance immediately afterwards, which is the correct relationship. */
    const done = await engine.run({
      graph, actor, via: "export.audio", adopt: false,
      timeoutMs: 5 * 60 * 1000, pollMs: 500,
      label: `export ${base}.${format}`,
    });
    if (done.status !== "completed") {
      throw new Error(done.error || `the engine did not finish the conversion (${done.status})`);
    }
    const out = done.outputs.find((o) => o.kind === "audio");
    /* A graph that "completed" without writing anything is the WAV failure
     * mode above. Report it as a failure rather than as success with a
     * missing file. */
    if (!out) throw new Error("the engine finished but wrote no file");
    return {
      file: out.file, subfolder: out.subfolder || "",
      seconds: Math.round(done.elapsedSec),
      runId: done.runId,
    };
  } finally {
    await unlink(path.join(config.inputDir, staged)).catch(() => {});
  }
}
