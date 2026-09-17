/**
 * THE TWO MESH ROWS — the licence claim, the territory rule, and the gate that
 * fails while a placeholder remains.
 *
 * ══ THE ONE THAT IS SUPPOSED TO GO RED ═════════════════════════════════════
 *
 * `meshFromImage` and `meshRig` were written against an install that a parallel
 * strand was still performing, so their byte counts and hashes are
 * AWAITING_MEASUREMENT — a sentinel in server/models.js, not a guess. THE
 * PLACEHOLDER BLOCK BELOW FAILS UNTIL THOSE NUMBERS LAND, and that is the whole
 * reason it exists: a placeholder that does not fail the build is a placeholder
 * that ships, and this catalogue's entire discipline is that "sizes are real,
 * and checked".
 *
 * When the install strand reports, three things change together in models.js —
 * the `bytes`, the `sha256`, and the deletion of the row's `awaiting` field —
 * and this file goes green with no edit of its own. If it needs an edit to go
 * green, something was faked.
 *
 * ══ WHAT ELSE IT PINS ══════════════════════════════════════════════════════
 *
 *  · NO `region` FIELD, on either row, ever. `excludedTerritories()` THROWS
 *    when two region-limited rows disagree, so a territory list typed onto a
 *    row that has none would either have to match H3's — a claim about a
 *    licence that says nothing of the sort — or break the build for every
 *    reader of that function. Both models are MIT. That is precisely WHY they
 *    were chosen: the obvious alternative excludes the European Union.
 *  · `makes: "mesh"`, so neither can become a picture model by omission.
 *  · The identifying-file rule, in BOTH directions — the declared tail claims a
 *    render and the bare basename does not. That second half is the safety: the
 *    basenames here are the ones every diffusers repository on earth uses.
 *  · The downloader and the runner look in the SAME folder.
 */
import path from "node:path";
import {
  CATALOG, MODEL_TO_CAPABILITY, isPictureModel, outputRightsFor, rightsStampFor,
  excludedTerritories,
} from "../models.js";
import { modelKeyFromFiles } from "../engine/record.js";
import { config } from "../config.js";
import { MESH_CAP, RIG_CAP, MESH_MODEL, RIG_MODEL } from "./runner.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const mesh = CATALOG.find((c) => c.id === MESH_CAP);
const rig = CATALOG.find((c) => c.id === RIG_CAP);

console.log("\nthe rows exist and say what they make");
ok("meshFromImage is in the catalogue", !!mesh);
ok("meshRig is in the catalogue", !!rig);
for (const [name, row] of [["meshFromImage", mesh], ["meshRig", rig]]) {
  ok(`${name} declares makes: "mesh"`, row?.makes === "mesh", JSON.stringify(row?.makes));
  ok(`...so ${name} is NOT a picture model`, !isPictureModel(row));
  ok(`...and carries a label, a why and a note`,
    !!row?.label && !!row?.why && !!row?.note);
}
ok("the picture set is unchanged by their arrival",
  CATALOG.filter(isPictureModel).map((c) => c.id).join(",")
    === "coverArt,imageIdeogram,imageZImage,imageKrea2,imageZImageBase,imageAnima",
  CATALOG.filter(isPictureModel).map((c) => c.id).join(", "));

console.log("\nthe licence, and the territory rule these two exist under");
for (const [name, row] of [["meshFromImage", mesh], ["meshRig", rig]]) {
  ok(`${name} is MIT`, row?.licence === "MIT", row?.licence);
  ok(`...output rights are unrestricted and sellable`,
    row?.outputRights?.class === "unrestricted" && row?.outputRights?.sellable === true,
    JSON.stringify({ class: row?.outputRights?.class, sellable: row?.outputRights?.sellable }));
  ok(`...with the publisher's own grant paragraph quoted, not paraphrased`,
    /Permission is hereby granted, free of charge/.test(row?.outputRights?.quote || ""));
  ok(`...and a URL pointing at that licence`,
    /^https?:\/\/\S+LICENSE/i.test(row?.outputRights?.url || ""), row?.outputRights?.url);

  /* ⚠ THE LOAD-BEARING ABSENCE. Not "no excluded list" — NO `region` KEY AT
   * ALL, because excludedTerritories() reads `c.region?.excluded` off every
   * row and throws when two of them disagree. An empty region object here
   * would be a second, contradictory answer to a question these licences do
   * not ask. */
  ok(`...and ${name} carries NO region field whatsoever`,
    !("region" in (row || {})), JSON.stringify(row?.region));
}
{
  let threw = null, list = null;
  try { list = excludedTerritories(); } catch (e) { threw = e; }
  ok("excludedTerritories() still answers rather than throwing",
    threw === null && Array.isArray(list), threw?.message);
  ok("...and still names exactly the four H3 territories", list?.length === 4, JSON.stringify(list));
}

console.log("\nthe bridge from an engine name to a rights record");
ok(`"${MESH_MODEL}" bridges to ${MESH_CAP}`, MODEL_TO_CAPABILITY[MESH_MODEL] === MESH_CAP);
ok(`"${RIG_MODEL}" bridges to ${RIG_CAP}`, MODEL_TO_CAPABILITY[RIG_MODEL] === RIG_CAP);
ok("...so a mesh is stamped unrestricted rather than unknown",
  outputRightsFor(MESH_MODEL).class === "unrestricted",
  JSON.stringify(rightsStampFor(MESH_MODEL)));
ok("...and the stamp names the capability it came from",
  rightsStampFor(RIG_MODEL).capability === RIG_CAP, JSON.stringify(rightsStampFor(RIG_MODEL)));

console.log("\nthe identifying file — BOTH directions");
{
  /* The whole point of `identifies` being a path TAIL rather than a flag. These
   * weights keep the diffusers layout their loaders require, so their basenames
   * are the ones every diffusers repository uses. A basename match would hand
   * TripoSG's licence to any graph that loaded any diffusers checkpoint. */
  const idFiles = [...(mesh?.files || []), ...(rig?.files || [])].filter((f) => f.identifies);
  ok("exactly one file per row declares itself the identifying one",
    idFiles.length === 2, String(idFiles.length));
  ok("...and each declares a TAIL, not a boolean",
    idFiles.every((f) => typeof f.identifies === "string" && f.identifies.includes("/")),
    JSON.stringify(idFiles.map((f) => f.identifies)));
  ok("...whose tail really is the end of that file's own dest",
    idFiles.every((f) => String(f.dest).split("\\").join("/").toLowerCase()
      .endsWith(f.identifies.toLowerCase())),
    JSON.stringify(idFiles.map((f) => ({ dest: f.dest, tail: f.identifies }))));

  for (const [f, key] of [[idFiles[0], MESH_MODEL], [idFiles[1], RIG_MODEL]]) {
    ok(`a graph naming the whole tail claims ${key}`,
      modelKeyFromFiles([{ file: f.identifies }]) === key,
      String(modelKeyFromFiles([{ file: f.identifies }])));
    ok(`...and the BARE basename claims nothing`,
      modelKeyFromFiles([{ file: path.basename(f.dest) }]) === null,
      `${path.basename(f.dest)} -> ${modelKeyFromFiles([{ file: path.basename(f.dest) }])}`);
  }
  ok("a Windows-shaped path with backslashes still matches",
    modelKeyFromFiles([{ file: `D:\\AI\\mesh-models\\${idFiles[0].identifies.split("/").join("\\")}` }]) === MESH_MODEL);

  /* AND THE RULE THAT WAS ALREADY THERE IS UNBROKEN. The Qwen3-4B encoder is
   * byte-identical across three catalogue rows; it must still claim nothing,
   * and a real diffusion weight must still claim its own row. */
  ok("the shared text encoder still claims no render",
    modelKeyFromFiles([{ file: "qwen_3_4b.safetensors" }]) === null);
  ok("...and a diffusion weight still claims its own",
    modelKeyFromFiles([{ file: "flux-2-klein-4b-fp8.safetensors" }]) === "flux2");
}

console.log("\nthe downloader and the runner look in the same place");
{
  const dests = [...(mesh?.files || []), ...(rig?.files || [])].map((f) => path.resolve(f.dest));
  ok("every mesh weight's dest is under config.mesh.weights",
    dests.length > 0 && dests.every((d) => d.toLowerCase().startsWith(path.resolve(config.mesh.weights).toLowerCase())),
    `weights=${config.mesh.weights}\n          dests=${dests.join("\n                ")}`);
  ok("...and none of them is inside the engine's models tree",
    dests.every((d) => !d.toLowerCase().includes(path.join("comfyui", "models").toLowerCase())),
    "a loader that enumerates that tree would offer a 3D transformer as a checkpoint");
}

console.log("\nthe machine requirement the runner refuses against");
for (const [name, row] of [["meshFromImage", mesh], ["meshRig", rig]]) {
  const r = row?.requires || {};
  ok(`${name} states a VRAM minimum`, Number(r.vramMinGb) > 0, String(r.vramMinGb));
  ok(`...and a recommendation at least as large`, Number(r.vramRecGb) >= Number(r.vramMinGb));
  ok(`...and RAM figures beside them`, Number(r.ramMinGb) > 0 && Number(r.ramRecGb) >= Number(r.ramMinGb));
  /* ⚠ AN UNMEASURED NUMBER MUST SAY SO. This catalogue's rule is that sizes and
   * timings are measured; these two were written before the venv existed, so
   * the honest form is a stated figure with a note admitting where it came
   * from. When somebody measures them, the note changes with the number. */
  ok(`...and the note admits whether the figure was measured here`,
    /NOT MEASURED|measured/i.test(r.note || ""), r.note);
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE PLACEHOLDER GATE — RED ON PURPOSE UNTIL THE INSTALL STRAND REPORTS.
 *
 * Read the header. Nothing below is a bug in this file: it is the file doing
 * the one job it was written for. Fill in `bytes` and `sha256` on each mesh
 * file in server/models.js, delete each row's `awaiting`, and every line here
 * turns green without being touched.
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\nthe file facts — REAL, or this suite is red");
for (const [name, row] of [["meshFromImage", mesh], ["meshRig", rig]]) {
  ok(`${name} lists at least one file`, (row?.files || []).length >= 1);
  ok(`...and ${name} no longer carries an \`awaiting\` placeholder`,
    !row?.awaiting,
    `awaiting: ${row?.awaiting}\n          `
    + `→ the install strand's report fills bytes and sha256 in server/models.js; delete this field with them.`);
  for (const f of row?.files || []) {
    const n = path.basename(f.dest);
    ok(`...${name}/${n} has a real byte count`, Number(f.bytes) > 0,
      `bytes: ${f.bytes} — AWAITING_MEASUREMENT until the install strand reports`);
    ok(`...${name}/${n} has a published sha256`,
      typeof f.sha256 === "string" && /^[0-9a-f]{64}$/.test(f.sha256),
      `sha256: ${JSON.stringify(f.sha256)} — the licence claim is about THESE bytes, so the hash `
      + `is what makes it checkable`);
  }
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  if (mesh?.awaiting || rig?.awaiting) {
    console.log("\n  ⚠ EXPECTED WHILE THE CATALOGUE ROWS ARE PLACEHOLDERS. This suite is the");
    console.log("    guard that stops two invented byte counts from shipping. Fill bytes and");
    console.log("    sha256 for each mesh file in server/models.js and delete each row's");
    console.log("    `awaiting` field; nothing in this test needs to change.");
  }
  process.exit(1);
}
