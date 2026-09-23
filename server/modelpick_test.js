/**
 * THE MODEL SHELF: both folders, and the loader each file needs.
 *
 * The bug this guards: the picker read models/checkpoints only, so the
 * Z-Image, Anima, FLUX.2 and Krea 2 files that live in models/diffusion_models
 * — where ComfyUI's UNETLoader reads them from — could not be picked at all.
 *
 * No GPU, no engine: classification is pure, the listing runs on a temp folder,
 * and the wiring is checked in the source the way the other UI contracts are.
 *   node server/modelpick_test.js
 */
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { classify, listPickable, listVideoPickable, listParts, resolvePick, DIT_ENGINE, VIDEO_DIT_ENGINE, isDitFolder } from "./modelpick.js";
import { zImageGraph, krea2Graph, coverGraph, animaGraph, ZIMAGE_DITS, KREA2_FILES } from "./workflow.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(path.join(HERE, ...p), "utf8");

/* ══ 1. what a file is, and how it loads ═════════════════════════════════ */
console.log("\nWHICH LOADER");
const row = (name, folder) => ({ name, folder, bytes: 1e9, at: 1 });

const ck = classify(row("novaAnimeXL.safetensors", "checkpoints"), { family: "unet", variant: "SDXL", bytes: 1e9, at: 1 });
ok("a real checkpoint loads as one", ck.engine === "checkpoint" && ck.ok && ck.dit === null, JSON.stringify(ck.engine));

for (const [family, engine] of Object.entries(DIT_ENGINE)) {
  const r = classify(row(`mine_${family}.safetensors`, "diffusion_models"), { family, bytes: 1e9, at: 1 });
  ok(`a ${family} file in diffusion_models renders on the ${engine} engine, with itself as the model`,
    r.engine === engine && r.ok === true && r.dit === `mine_${family}.safetensors`, JSON.stringify(r.engine));
}

const stray = classify(row("someSDXL.safetensors", "diffusion_models"), { family: "unet", variant: "SDXL", bytes: 1e9, at: 1 });
ok("a full checkpoint in diffusion_models is refused, and the fix named", !stray.ok && /Move it to models\/checkpoints/.test(stray.why || ""), stray.why);

const dit = classify(row("zimageTurbo.safetensors", "checkpoints"), { family: "zimage", bytes: 1e9, at: 1 });
ok("a DiT left in checkpoints is still refused with the move-it advice", !dit.ok && /diffusion_models/.test(dit.why || ""), dit.why);

const ideo = classify(row("ideogram4_fp8.safetensors", "diffusion_models"), { family: "ideogram4", bytes: 1e9, at: 1 });
ok("Ideogram 4 is refused BY NAME rather than hidden — its graph needs two fixed files",
  !ideo.ok && /ideogram4/.test(ideo.why || ""), ideo.why);

const dunno = classify(row("mystery.safetensors", "diffusion_models"), { family: "unknown", bytes: 1e9, at: 1 });
ok("an unrecognised architecture is listed and refused, not hidden", dunno.ok === false && !!dunno.why);
ok("folders that UNETLoader reads are known as such", isDitFolder("diffusion_models") && isDitFolder("unet") && !isDitFolder("checkpoints"));

/* ══ 2. the listing reads BOTH shelves ═══════════════════════════════════ */
console.log("\nBOTH SHELVES");
const base = await mkdtemp(path.join(os.tmpdir(), "aiplay-pick-"));
await mkdir(path.join(base, "checkpoints"), { recursive: true });
await mkdir(path.join(base, "diffusion_models"), { recursive: true });
/* .ckpt is pickle, not safetensors: listed without pretending to know it. */
await writeFile(path.join(base, "checkpoints", "old_sd15.ckpt"), "x");
await writeFile(path.join(base, "diffusion_models", "some_dit.ckpt"), "x");
await writeFile(path.join(base, "checkpoints", "yue2_3b_bf16.safetensors"), "x");
const cfg = { modelsDir: base, comfyDir: base, comfy: { extraArgs: [] } };
const listed = await listPickable(cfg);
ok("files from BOTH folders are listed", listed.some((r) => r.folder === "checkpoints") && listed.some((r) => r.folder === "diffusion_models"),
  JSON.stringify(listed.map((r) => `${r.folder}/${r.name}`)));
ok("checkpoints come first, so the list opens on the familiar shelf", listed[0].folder === "checkpoints");
ok("a music model sharing the folder is not offered as an image model", !listed.some((r) => /yue2/i.test(r.name)));
const found = await resolvePick("some_dit.ckpt", cfg);
ok("one picked file can be resolved by name from either shelf", found?.folder === "diffusion_models");
ok("a name that is not there resolves to nothing", (await resolvePick("nope.safetensors", cfg)) === null);
const movedCfg = { modelsDir: path.join(base, "new-downloads"), modelsAlso: [base], comfyDir: path.join(base, "separate-engine"), comfy: { extraArgs: [] } };
ok("a model in a remembered folder still appears in the image picker", (await listPickable(movedCfg)).some((r) => r.name === "some_dit.ckpt"));
ok("a remembered transformer is also offered to the video picker", (await listVideoPickable(movedCfg)).some((r) => r.name === "some_dit.ckpt"));
ok("a remembered model can still be resolved when a render is requested", (await resolvePick("some_dit.ckpt", movedCfg))?.folder === "diffusion_models");
await rm(base, { recursive: true, force: true });

/* ══ 3. the graphs take the user's own file ══════════════════════════════ */
console.log("\nTHE GRAPHS");
const mine = "ZImage - DarkBeast.safetensors";
ok("Z-Image renders the picked transformer, not the catalogue's",
  zImageGraph({ prompt: "x", seed: 1, dit: mine })["1"].inputs.unet_name === mine
  && zImageGraph({ prompt: "x", seed: 1 })["1"].inputs.unet_name === ZIMAGE_DITS.turbo);
ok("Krea 2 does the same", krea2Graph({ prompt: "x", seed: 1, dit: "k.safetensors" })["1"].inputs.unet_name === "k.safetensors"
  && krea2Graph({ prompt: "x", seed: 1 })["1"].inputs.unet_name === KREA2_FILES.dit);
ok("FLUX.2 does the same", coverGraph({ prompt: "x", seed: 1, dit: "f.safetensors" })["1"].inputs.unet_name === "f.safetensors");
ok("...and the encoder and VAE stay the catalogue's — a community model is a re-trained transformer, not a new architecture",
  zImageGraph({ prompt: "x", seed: 1, dit: mine })["2"].class_type === "CLIPLoader"
  && zImageGraph({ prompt: "x", seed: 1, dit: mine })["3"].class_type === "VAELoader");

/* ══ 4. the wiring ══════════════════════════════════════════════════════ */
console.log("\nWIRED IN");
const INDEX = read("index.js");
const ART = read("art.js");
const APP = readFileSync(path.join(HERE, "..", "web", "app.js"), "utf8");
ok("the route lists both shelves", /\/api\/checkpoints"[\s\S]{0,900}listPickable\(config\)/.test(INDEX));
ok("...and no longer reads models/checkpoints on its own for the picker",
  !/const dir = path\.join\(config\.modelsDir, "checkpoints"\);/.test(INDEX));
const imageRouteStart = INDEX.indexOf('if (p === "/api/image" && req.method === "POST")');
const imageRouteEnd = INDEX.indexOf('if (p === "/api/', imageRouteStart + 20);
const imageRoute = imageRouteStart >= 0 && imageRouteEnd > imageRouteStart ? INDEX.slice(imageRouteStart, imageRouteEnd) : "";
const pickAt = imageRoute.indexOf("const pick = await resolvePick(b.checkpoint)");
const engineAt = imageRoute.indexOf("const engine = b.engine || config.image.engine;");
ok("a picked file is resolved BEFORE the per-engine rules, so it is held to its own",
  pickAt >= 0 && engineAt >= 0 && pickAt < engineAt);
ok("a picked transformer switches the engine and is passed as the model file",
  /b\.engine = pick\.engine; b\.dit = pick\.dit;/.test(INDEX));
ok("with your own model file the catalogue's own copy of it is not demanded",
  /function missingSupport\(cap, ownDit, own = \{\}\)/.test(INDEX)
  && /const isDit = \(f\) => isDitFolder\(f\.folder\) \|\| on\(f, "diffusion_models", "unet"\);/.test(INDEX));
/* AND NEITHER IS ITS ENCODER OR VAE, once you have named your own. Naming both
 * on the Images screen and still being told the model "is not downloaded yet"
 * was the report; FLUX.2 was worse, refusing on cap.ready without even asking
 * whether you had brought a transformer. */
ok("...nor the encoder and VAE you named instead of them",
  /!\(own\.encoder && isEncoder\(f\)\) && !\(own\.vae && isVae\(f\)\)/.test(INDEX));
ok("every image engine asks the same question, FLUX.2 included",
  (INDEX.match(/missingSupport\(cap, b\.dit, \{ encoder: b\.encoder, vae: b\.vae \}\)/g) || []).length >= 4
  && !/The image model is not downloaded yet/.test(INDEX));
ok("covers ask the same question, since they never pass through the route", /const pick = await resolvePick\(ckpt\)/.test(ART));
ok("each family graph gets the picked file", /dit: ownDit \|\| config\.art\.animaDit/.test(ART)
  && (ART.match(/prefix: PREFIX, dit: ownDit/g) || []).length >= 2 && /\n        dit: ownDit,/.test(ART));
ok("the ledger records the file that really painted it", /job\._paintedWith = engine === "checkpoint" \? \(ckpt \|\| null\) : \(ownDit \|\| null\)/.test(ART));
ok("the picker groups the two folders in one dropdown", /optgroup label="\$\{esc\(label\)\}"/.test(APP)
  && /Checkpoints · models\/checkpoints/.test(APP) && /Diffusion models · models\/diffusion_models/.test(APP));

/* ══ 5. the halves a bare transformer needs ══════════════════════════════ */
console.log("\nENCODER AND VAE");
const base2 = await mkdtemp(path.join(os.tmpdir(), "aiplay-parts-"));
for (const d of ["text_encoders", "clip", "vae", "diffusion_models"]) await mkdir(path.join(base2, d), { recursive: true });
await writeFile(path.join(base2, "text_encoders", "qwen_3_4b.safetensors"), "x");
await writeFile(path.join(base2, "clip", "clip_l.safetensors"), "x");
await writeFile(path.join(base2, "vae", "ae.safetensors"), "x");
await writeFile(path.join(base2, "diffusion_models", "some.safetensors"), "x");
const parts = await listParts({ modelsDir: base2, comfyDir: base2, comfy: { extraArgs: [] } });
ok("both encoder shelves are offered (ComfyUI reads text_encoders and clip as one)",
  parts.encoders.some((e) => e.name === "qwen_3_4b.safetensors") && parts.encoders.some((e) => e.name === "clip_l.safetensors"),
  JSON.stringify(parts.encoders.map((e) => e.name)));
ok("VAEs come from models/vae, and a transformer is not offered as one",
  parts.vaes.length === 1 && parts.vaes[0].name === "ae.safetensors", JSON.stringify(parts.vaes));
await rm(base2, { recursive: true, force: true });

ok("a named encoder and VAE replace the family's own in every DiT graph",
  zImageGraph({ prompt: "x", seed: 1, encoder: "my_clip.safetensors", vae: "my_vae.safetensors" })["2"].inputs.clip_name === "my_clip.safetensors"
  && zImageGraph({ prompt: "x", seed: 1, vae: "my_vae.safetensors" })["3"].inputs.vae_name === "my_vae.safetensors"
  && krea2Graph({ prompt: "x", seed: 1, encoder: "e.safetensors" })["2"].inputs.clip_name === "e.safetensors"
  && animaGraph({ dit: "d.safetensors", prompt: "x", seed: 1, vae: "v.safetensors" })["7"].inputs.vae_name === "v.safetensors"
  && coverGraph({ prompt: "x", seed: 1, encoder: "e.safetensors" })["2"].inputs.clip_name === "e.safetensors");
ok("...and the CLIPLoader TYPE still comes from the family, which is what decides how the weights are read",
  zImageGraph({ prompt: "x", seed: 1, encoder: "my_clip.safetensors" })["2"].inputs.type === "lumina2"
  && krea2Graph({ prompt: "x", seed: 1, encoder: "e.safetensors" })["2"].inputs.type === "krea2");

console.log("\nTHE THREE ROWS");
const HTML = readFileSync(path.join(HERE, "..", "web", "index.html"), "utf8");
for (const id of ["imgDitKind", "imgEncoder", "imgVae"]) {
  ok(`the screen has a ${id} row`, new RegExp(`id="${id}"`).test(HTML) && new RegExp(`id="${id}W"`).test(HTML));
}
ok("they are shown only for a file that is not a checkpoint", /ck\.folder && ck\.folder !== "checkpoints"/.test(APP));
ok("the choices are sent with the render", /ditEngine: \$\("imgDitKind"\)\.value/.test(APP)
  && /encoder: \$\("imgEncoder"\)\.value/.test(APP) && /vae: \$\("imgVae"\)\.value/.test(APP));
ok("the route serves the shelves they are filled from", /\/api\/modelparts"[\s\S]{0,400}listParts\(config\)/.test(INDEX));
ok("a kind the app cannot load is refused by name", /is not a model kind this app can load/.test(INDEX));
ok("an encoder or VAE that is not on the shelf is refused rather than sent to ComfyUI",
  /No such \$\{what\}: \$\{want\}/.test(INDEX));
ok("the render carries them to the graphs", /encoder: ownEncoder, vae: ownVae/.test(ART));

/* ══ 6. the Video screen, same bargain ═══════════════════════════════════ */
console.log("\nVIDEO MODELS");
ok("an H3 file drives the h3 engine and an LTX file drives ltx",
  VIDEO_DIT_ENGINE["minimax-h3"] === "h3" && VIDEO_DIT_ENGINE["ltx-video"] === "ltx" && VIDEO_DIT_ENGINE["ltx-av"] === "ltx");

const vidBase = await mkdtemp(path.join(os.tmpdir(), "aiplay-vid-"));
await mkdir(path.join(vidBase, "diffusion_models"), { recursive: true });
await mkdir(path.join(vidBase, "checkpoints"), { recursive: true });
await writeFile(path.join(vidBase, "diffusion_models", "some_video.ckpt"), "x");
await writeFile(path.join(vidBase, "checkpoints", "an_sdxl.ckpt"), "x");
const vidCfg = { modelsDir: vidBase, comfyDir: vidBase, comfy: { extraArgs: [] } };
const vidRows = await listVideoPickable(vidCfg);
ok("only the transformer shelf is offered — a checkpoint cannot drive a video engine",
  vidRows.length === 1 && vidRows[0].folder === "diffusion_models", JSON.stringify(vidRows.map((r) => r.name)));
ok("...and a file that is not a video model is listed and refused, not hidden",
  vidRows[0].ok === false && /not a video model/.test(vidRows[0].why || ""), vidRows[0].why);
await rm(vidBase, { recursive: true, force: true });

console.log("\nVIDEO WIRING");
const WF = read("workflow.js");
ok("both video graphs take named files, merged LAST so one part replaces one part",
  /\.\.\.\(config\.video\.engines\[engine\] \|\| config\.video\.engines\.h3\), \.\.\.\(models \|\| \{\}\)/.test(WF)
  && /\.\.\.config\.video\.engines\.ltx, \.\.\.\(models \|\| \{\}\)/.test(WF));
/* The encoder and VAE rows arrive JUDGED, not just listed. listParts returns
 * every file in models/vae and models/text_encoders by name, which is what let
 * the video-VAE dropdown offer a FLUX autoencoder and a music codec with equal
 * confidence; listVideoParts is the same shelf with a per-engine verdict read
 * off the tensors. Naming both halves, so serving the raw shelf again fails
 * here rather than quietly reaching the screen. */
ok("the route serves the video shelf with its encoders and VAEs",
  /\/api\/videomodels"[\s\S]{0,900}listVideoPickable\(config\)/.test(INDEX));
ok("...and those encoders and VAEs come back with a per-engine verdict on them",
  /\/api\/videomodels"[\s\S]{0,900}listVideoParts\(config\)/.test(INDEX));
/* ⚠ THE DOOR, NOT ONLY THE DROPDOWN. Hiding a part in a <select> is a courtesy
 * to whoever is looking at it; /api/video takes these by name from the MCP
 * tools, a script, or a second window left open on the old page. Until the
 * refusal below, a FLUX autoencoder named as H3's video VAE was accepted here
 * and failed three minutes later inside ComfyUI. The DiT half of that function
 * has always refused by engine; these three now answer to the same standard. */
ok("a text encoder or VAE built for another engine is refused at the door, not just hidden",
  /row\[verdict\]\?\.\[engine\] === "no"/.test(INDEX)
  && /it is built differently from the one it came with/.test(INDEX));
ok("...and only a positive refusal is refused, so an unreadable part still goes through",
  !/row\[verdict\]\?\.\[engine\] !== "yes"/.test(INDEX));
ok("a named video file is checked before the render is queued", /const picked = await videoModelPatch\(b, eng\)/.test(INDEX)
  && /if \(picked\.error\) return json\(res, 400/.test(INDEX));
ok("a model for the OTHER engine is refused by name rather than loaded wrongly",
  /which renders on the \$\{row\.engine\.toUpperCase\(\)\} engine/.test(INDEX));
ok("on H3 a named file stands in for the reference checkpoint too, not half of it",
  /if \(engine === "h3"\) patch\.ditRef = row\.name;/.test(INDEX));
ok("the job carries the patch to the graph", /models: picked\.models \|\| undefined/.test(INDEX) && /models: job\.models/.test(ART));
ok("the Video screen has all four rows", /id="vidModel"/.test(HTML) && /id="vidEncoder"/.test(HTML)
  && /id="vidVideoVae"/.test(HTML) && /id="vidAudioVae"/.test(HTML));
ok("...the audio VAE is offered on the H3 graph (H3, FastH3), not on LTX, which has none to replace",
  /vidAudioVaeL", "vidAudioVaeW"\]\) \{ const el = \$\(id\); if \(el\) el\.hidden = eng === "ltx"; \}/.test(APP));
ok("...the shelf is re-read when the engine changes", /vidModelShape\(\);/.test(APP));
ok("...and nothing is sent while every row says auto", /function vidModelChoice\(\)/.test(APP)
  && /\.\.\.vidModelChoice\(\),/.test(APP));

/* == 5. quantised weights, and what a picked file means for references =====
 *
 * Reported together: a .gguf encoder was offered by the picker and then loaded
 * with ComfyUI's safetensors CLIPLoader, which cannot read one; and a FLUX.2
 * transformer picked from models/diffusion_models was told references are
 * "FLUX.2's trick" -- by the SCREEN, which read the dropdown ("your own model
 * file") instead of what the file turned out to be. */
console.log("\nQUANTISED, AND WHAT THE FILE REALLY IS");
const { isGguf, unetNode, clipNode, GGUF_NODES } = await import("./workflow.js");
const { familyFromName } = await import("./modelpick.js");
const CSS = readFileSync(path.join(HERE, "..", "web", "styles.css"), "utf8");

ok("a .gguf loads through the GGUF pack's nodes, a .safetensors through ComfyUI's own",
  isGguf("m.gguf") && !isGguf("m.safetensors")
  && unetNode("m.gguf").class_type === GGUF_NODES.unet
  && unetNode("m.safetensors").class_type === "UNETLoader"
  && clipNode("e.gguf", "flux2").class_type === GGUF_NODES.clip
  && clipNode("e.safetensors", "flux2").class_type === "CLIPLoader");
ok("...and the encoder TYPE survives the swap -- it is what decides how the weights are read",
  clipNode("e.gguf", "lumina2").inputs.type === "lumina2");
ok("...on every image graph, not just one",
  coverGraph({ prompt: "x", seed: 1, encoder: "e.gguf" })["2"].class_type === GGUF_NODES.clip
  && zImageGraph({ prompt: "x", seed: 1, dit: "z.gguf" })["1"].class_type === GGUF_NODES.unet
  && krea2Graph({ prompt: "x", seed: 1, encoder: "e.gguf" })["2"].class_type === GGUF_NODES.clip
  && animaGraph({ prompt: "x", seed: 1, dit: "a.gguf" })["1"].class_type === GGUF_NODES.unet);
ok("the shelf lists .gguf transformers instead of pretending they are not there",
  /\.\(safetensors\|ckpt\|sft\|gguf\)\$/.test(read("modelpick.js")));
ok("...a .gguf whose name names its family is classified from the name",
  familyFromName("ZImage-turbo-Q8_0.gguf") === "zimage" && familyFromName("mystery-Q4.gguf") === null);
ok("...and one whose name says nothing is offered with the question, not a guess",
  /needsKind: true/.test(read("modelpick.js"))
  && /is a quantised GGUF and its name does not say which family it is/.test(INDEX));
ok("the pack that reads a .gguf is asked for by name when it is missing",
  /Install the ComfyUI-GGUF pack/.test(INDEX) && /objectInfo\(n\)/.test(INDEX));

ok("the screen judges references by what the FILE is, not by the dropdown",
  /function imgEffectiveEngine\(\)/.test(APP) && /const eng = imgEffectiveEngine\(\);/.test(APP));
ok("...so a picked FLUX.2 transformer may take references",
  /return ck\?\.engine \|\| "checkpoint";/.test(APP));
ok("the reference block hides when it cannot be used, and comes back if pictures are attached",
  /wrap\.hidden = fluxOnly && !n;/.test(APP));
ok("a LoRA slider no longer rebuilds the row it is being dragged on",
  /#imgLoras \[data-lorastr\]/.test(APP) && /if \(b\) b\.textContent = v\.toFixed\(2\);/.test(APP));
ok("...and the LoRA stack gets a column of its own in the flat option row",
  /\.pv:has\(> \.lorastack\)/.test(CSS));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
