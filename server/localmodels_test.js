/**
 * WEIGHTS THE USER ALREADY HAS — the gate on reading somebody else's folder.
 *
 * server/localmodels.js is the half of the models story that does not come from
 * the catalogue: it scans whatever folder a person keeps their weights in,
 * writes the YAML that makes ComfyUI load from it, and lets a file they already
 * have STAND IN for a catalogue file. Three of those touch things that are hard
 * to take back if they are wrong:
 *
 *   THE STAND-IN RENAME IS THE ONE THAT MATTERS. applyModelOverrides rewrites a
 *     graph before the provenance ledger records it. Its first version replaced
 *     any string equal to an overridden file name, ANYWHERE in a node's inputs
 *     — which includes the prompt. A song whose lyrics happened to be a file
 *     name would have been silently edited, and the ledger would have recorded
 *     the edited text as what the user asked for. The rule is now "inputs whose
 *     NAME looks like a file input" (ComfyUI's ckpt_name, unet_name, clip_name2
 *     …), and the prompt case below is pinned so it cannot come back.
 *
 *   IDENTITY MATTERS TOO: a graph with no override must come back as the SAME
 *     object, because the ledger hashes it and an untouched render must hash
 *     exactly as it did before this feature existed.
 *
 *   THE SCAN IS A PROMISE ABOUT WHAT COMFYUI WILL SEE. Top level only, weight
 *     extensions only, zero-byte files skipped (a half-finished download is not
 *     a model), and `diffusion_models` ≡ `unet` / `text_encoders` ≡ `clip`,
 *     because a loader reading one lists the other.
 *
 * Everything here runs against a temp folder this suite builds itself: no GPU,
 * no ComfyUI, no network, nothing outside os.tmpdir().
 *
 * Runs standalone (`node server/localmodels_test.js`) and in the pre-commit hook.
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  MODEL_FOLDERS, folderGroup, shelfOf, samePath, uniqueDirs,
  extraBases, scanBases, countByFolder, writeModelPathsYaml, applyModelOverrides,
} from "./localmodels.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "aiplay-localmodels-"));
try {

/* ── the shelves ComfyUI treats as one ─────────────────────────────────── */
{
  ok("diffusion_models and unet are one shelf", folderGroup("unet").includes("diffusion_models")
    && folderGroup("diffusion_models").includes("unet"));
  ok("text_encoders and clip are one shelf", folderGroup("clip").includes("text_encoders"));
  ok("a folder with no alias is its own group", folderGroup("vae").length === 1 && folderGroup("vae")[0] === "vae");
  ok("the shelf name is the first of the group", shelfOf("unet") === "diffusion_models" && shelfOf("clip") === "text_encoders");
  ok("checkpoints and vae are scanned", MODEL_FOLDERS.includes("checkpoints") && MODEL_FOLDERS.includes("vae"));
  /* Every alias must be a folder that is actually scanned, or the shelf points
   * at a place nothing is ever read from. */
  for (const f of ["diffusion_models", "unet", "text_encoders", "clip"]) {
    ok(`${f} is in MODEL_FOLDERS`, MODEL_FOLDERS.includes(f));
  }
}

/* ── paths ─────────────────────────────────────────────────────────────── */
{
  ok("a path equals itself through a different spelling", samePath(path.join(tmp, "a", "..", "a"), path.join(tmp, "a")));
  ok("different folders are different", !samePath(path.join(tmp, "a"), path.join(tmp, "b")));
  if (process.platform === "win32") {
    ok("Windows paths compare case-insensitively", samePath("C:\\Models", "c:\\models"));
  } else {
    ok("POSIX paths compare case-sensitively", !samePath("/Models", "/models"));
  }
  const dirs = uniqueDirs([path.join(tmp, "m"), path.join(tmp, "m", "..", "m"), null, "", path.join(tmp, "n")]);
  ok("uniqueDirs drops duplicates and empties", dirs.length === 2, JSON.stringify(dirs));
  ok("uniqueDirs returns absolute paths", dirs.every((d) => path.isAbsolute(d)));
}

/* ── the scan ──────────────────────────────────────────────────────────── */
const base = path.join(tmp, "models");
{
  const write = async (folder, name, body) => {
    await mkdir(path.join(base, folder), { recursive: true });
    await writeFile(path.join(base, folder, name), body);
  };
  await write("checkpoints", "yue2_3b_bf16.safetensors", "x".repeat(1000));
  await write("checkpoints", "notes.txt", "not a model");
  await write("checkpoints", "half_downloaded.safetensors", "");
  await write("unet", "some_dit_fp16.safetensors", "x".repeat(2000));
  await write("vae", "ae.safetensors", "x".repeat(500));
  await write("loras", "style.gguf", "x".repeat(10));
  await mkdir(path.join(base, "checkpoints", "nested"), { recursive: true });
  await writeFile(path.join(base, "checkpoints", "nested", "deep.safetensors"), "x".repeat(10));
  await mkdir(path.join(base, "not_a_model_folder"), { recursive: true });
  await writeFile(path.join(base, "not_a_model_folder", "stray.safetensors"), "x".repeat(10));

  const files = await scanBases([base]);
  const names = files.map((f) => f.name);
  ok("finds weights in the standard folders", names.includes("yue2_3b_bf16.safetensors")
    && names.includes("some_dit_fp16.safetensors") && names.includes("ae.safetensors"));
  ok("a .gguf is a weight too", names.includes("style.gguf"));
  ok("a .txt beside the weights is not a model", !names.includes("notes.txt"));
  ok("a zero-byte file is not a model (a half-finished download)", !names.includes("half_downloaded.safetensors"));
  ok("nested files are not listed — a loader names files inside the folder", !names.includes("deep.safetensors"));
  ok("a folder ComfyUI does not load from is not scanned", !names.includes("stray.safetensors"));
  const unet = files.find((f) => f.name === "some_dit_fp16.safetensors");
  ok("a unet file is shelved as diffusion_models", unet.folder === "unet" && unet.shelf === "diffusion_models");
  ok("each file carries its size and full path", unet.bytes === 2000 && unet.full.endsWith(path.join("unet", "some_dit_fp16.safetensors")));
  ok("a missing base is not an error, just nothing", (await scanBases([path.join(tmp, "nope")])).length === 0);
  ok("the same base twice is scanned once",
    (await scanBases([base, path.join(base, "..", "models")])).length === files.length);

  const counts = countByFolder(files);
  ok("counts are per folder, with bytes", counts.checkpoints.files === 1 && counts.checkpoints.bytes === 1000
    && counts.unet.files === 1 && counts.vae.bytes === 500);
  ok("a folder with nothing in it is not counted", !("controlnet" in counts));
}

/* ── the YAML that makes ComfyUI look there ────────────────────────────── */
{
  const appData = path.join(tmp, "appdata");
  const file = await writeModelPathsYaml(base, appData);
  const yaml = await readFile(file, "utf-8");
  ok("the YAML lands in the app-data folder", samePath(path.dirname(file), appData));
  ok("it names the chosen folder as base_path", yaml.includes(`base_path: '${base}'`), yaml.split("\n")[3]);
  ok("it maps every folder Studio scans", MODEL_FOLDERS.every((f) => yaml.includes(`  ${f}: ${f}/`)));
  ok("it says it is generated, so an edit is not lost silently", /overwritten/i.test(yaml));

  /* A path with an apostrophe is not exotic on Windows ("Bob's drive") and an
   * unescaped one produces a YAML ComfyUI cannot parse — silently, at startup.
   * Its own app-data folder: the file name is fixed, so writing it here would
   * overwrite the one the next section reads back. */
  const odd = path.join(tmp, "Bob's models");
  const oddFile = await writeModelPathsYaml(odd, path.join(tmp, "appdata-odd"));
  ok("an apostrophe in the path is escaped", (await readFile(oddFile, "utf-8")).includes(`base_path: '${odd.replace(/'/g, "''")}'`));
  ok("the YAML has one fixed name, so a second folder replaces it rather than piling up",
    path.basename(oddFile) === path.basename(file));

  const args = ["--listen", "--extra-model-paths-config", file, "--port", "8188"];
  ok("extraBases reads base_path back out of a launch argv", (await extraBases(args)).some((b) => samePath(b, base)));
  ok("an argv with no YAML yields nothing", (await extraBases(["--listen"])).length === 0);
  ok("an unreadable YAML is not an error", (await extraBases(["--extra-model-paths-config", path.join(tmp, "gone.yaml")])).length === 0);
}

/* ── the stand-in rename ───────────────────────────────────────────────── */
{
  const overrides = { "minimax_music3_dit_int8_convrot.safetensors": "minimax_music3_dit_fp16.safetensors" };
  const graph = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "minimax_music3_dit_int8_convrot.safetensors" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "minimax_music3_dit_int8_convrot.safetensors", clip: ["1", 1] } },
    "3": { class_type: "KSampler", inputs: { steps: 32, seed: 7 } },
  };
  const out = applyModelOverrides(graph, overrides);
  ok("a loader's *_name input is renamed to the stand-in",
    out["1"].inputs.ckpt_name === "minimax_music3_dit_fp16.safetensors");
  ok("⚠ THE PROMPT IS NEVER TOUCHED, even when its whole text is the file name",
    out["2"].inputs.text === "minimax_music3_dit_int8_convrot.safetensors");
  ok("untouched nodes are carried through", out["3"].inputs.steps === 32);
  ok("the original graph is not mutated",
    graph["1"].inputs.ckpt_name === "minimax_music3_dit_int8_convrot.safetensors");

  ok("numbered inputs like clip_name2 are file inputs",
    applyModelOverrides({ "1": { inputs: { clip_name2: "a.safetensors" } } }, { "a.safetensors": "b.safetensors" })["1"].inputs.clip_name2 === "b.safetensors");
  ok("a bare `name` input is a file input",
    applyModelOverrides({ "1": { inputs: { name: "a.safetensors" } } }, { "a.safetensors": "b.safetensors" })["1"].inputs.name === "b.safetensors");
  ok("a filename inside a longer string is not a match",
    applyModelOverrides({ "1": { inputs: { ckpt_name: "sub/a.safetensors" } } }, { "a.safetensors": "b.safetensors" })["1"].inputs.ckpt_name === "sub/a.safetensors");

  /* Identity, three ways — the ledger hashes this object. */
  ok("a graph with no matching override comes back as the SAME object",
    applyModelOverrides(graph, { "other.safetensors": "x.safetensors" }) === graph);
  ok("no overrides at all comes back as the SAME object", applyModelOverrides(graph, {}) === graph
    && applyModelOverrides(graph, null) === graph);
  ok("an override mapped to nothing is ignored", applyModelOverrides(graph, { "minimax_music3_dit_int8_convrot.safetensors": "" }) === graph);
  ok("a node without inputs survives", applyModelOverrides({ "1": { class_type: "X" } }, overrides)["1"].class_type === "X");
  ok("a non-graph is handed back unchanged", applyModelOverrides(null, overrides) === null);
}

} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
