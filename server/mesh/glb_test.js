/**
 * THE FORMAT CONTRACT, AS A TEST.
 *
 * The contract this subsystem promises its caller is not "a 3D file". It is a
 * GLB carrying glTF `skins[]` with `joints` AND `inverseBindMatrices`, used by a
 * mesh node — because that is what the downstream requires, and because a
 * rigged mesh and an unrigged one have the same extension, the same magic
 * number and nearly the same size. "The rig worked" is therefore a claim that
 * cannot be read off an exit code, and this file is the reason it never has to
 * be.
 *
 * The interesting half is the NEGATIVE half. Four ways a file can look rigged
 * and not be — no bind matrices, no joints, a skin nothing uses, a bind pose for
 * a different skeleton — and each is asserted separately, because a checker
 * that only proves the good case passes on every one of them.
 *
 * Runs standalone (`node server/mesh/glb_test.js`) and in the pre-commit hook.
 * No GPU, no python, no venv: this is a container reader, and that is the point
 * of it living on this side of the subprocess boundary.
 */
import { readGlb, readGlbFile, assertSkinned, boundsOf, plausiblyHumanoid, HUMANOID_MIN_RATIO,
         MAGIC, CHUNK_JSON, CHUNK_BIN } from "./glb.js";
import { packGlb, glbDoc, glb } from "./fixtures.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

console.log("\nGLB container");
{
  const r = readGlb(glb({ skinned: false }));
  ok("a built GLB parses", r.ok, r.why.join("; "));
  ok("...and its JSON chunk is the glTF document", r.json?.asset?.version === "2.0");
  ok("...and the binary chunk length is reported", r.bin > 0, String(r.bin));
}
{
  ok("a buffer that is not a GLB is refused, not thrown",
    readGlb(Buffer.from("this is a text file, honestly")).ok === false);
  ok("...and says so in words a person can act on",
    /not a GLB/.test(readGlb(Buffer.from("nope")).why.join(" ")));
  ok("an empty buffer is refused", readGlb(Buffer.alloc(0)).ok === false);
  ok("a non-buffer is refused rather than crashing", readGlb(null).ok === false);
}
{
  /* ⚠ A TRUNCATED FILE IS NOT "UNRIGGED", and this is the assertion that keeps
   * a killed subprocess from being read as a failed rig. A run that was cut off
   * mid-write leaves a container whose declared length does not match the bytes
   * on disk, and reporting "no skin" for that sends somebody to re-run a rig
   * that was never the problem. */
  const full = glb({ skinned: true });
  const cut = full.subarray(0, full.length - 8);
  const r = readGlb(cut);
  ok("a truncated GLB is refused as unreadable, NOT reported as unrigged", r.ok === false);
  ok("...and the reason names the length disagreement",
    /declares \d+ bytes and the file is \d+/.test(r.why.join(" ")), r.why.join("; "));
}
{
  // A header that lies about its chunk size must not be believed.
  const doc = Buffer.from(JSON.stringify(glbDoc({})), "utf8");
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + doc.length, 8);
  head.writeUInt32LE(0xffff_0000, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const r = readGlb(Buffer.concat([head, doc]));
  ok("a chunk claiming more bytes than the file holds is refused", r.ok === false, r.why.join("; "));
}

console.log("\nthe skin assertion");
{
  const g = readGlb(glb({ skinned: true }));
  const s = assertSkinned(g.json);
  ok("a rigged GLB asserts as skinned", s.ok, s.why.join("; "));
  ok("...and reports the joint count", s.joints === 3, String(s.joints));
}
{
  const s = assertSkinned(readGlb(glb({ skinned: false })).json);
  ok("an unrigged GLB does NOT assert as skinned", s.ok === false);
  ok("...and the reason says it is an unrigged mesh rather than a broken one",
    /no `skins`|unrigged/.test(s.why.join(" ")), s.why.join("; "));
}
/* THE FOUR NEAR-MISSES. Each of these is a file a caller would call rigged if
 * it only checked that `skins` existed, which is the check anybody writes
 * first. */
for (const [breaks, expect] of [
  ["ibm", /inverseBindMatrices/],
  ["joints", /no joints/],
  ["unused", /no node with a mesh uses/],
  ["count", /3 joints and 7 bind matrices/],
  ["type", /not MAT4/],
]) {
  const s = assertSkinned(readGlb(packGlb(glbDoc({ skinned: true, breaks }))).json);
  ok(`a skin missing "${breaks}" is refused`, s.ok === false);
  ok(`...and the reason names it`, expect.test(s.why.join(" ")), s.why.join("; "));
}
{
  ok("no document at all is a refusal, not a throw", assertSkinned(null).ok === false);
  ok("a document with an empty skins array is refused", assertSkinned({ skins: [] }).ok === false);
}
{
  /* TWO SKINS, ONE GOOD. A file can carry a broken skin beside a working one —
   * the working one is the answer, because the question is whether this mesh
   * can be posed, not whether every skin in the file is tidy. */
  const doc = glbDoc({ skinned: true });
  doc.skins.unshift({ joints: [] });         // a broken skin, first in the list
  doc.nodes[0].skin = 1;                     // the mesh uses the good one
  doc.skins[1].inverseBindMatrices = 1;
  const s = assertSkinned(readGlb(packGlb(doc)).json);
  ok("one usable skin beside a broken one still asserts", s.ok, s.why.join("; "));
}

console.log("\nbounds and the humanoid ratio");
{
  const b = boundsOf(glbDoc({ size: [0.5, 1.8, 0.3] }));
  ok("bounds come off the accessor min/max with no geometry decoded",
    b && Math.abs(b.size[1] - 1.8) < 1e-6, JSON.stringify(b));
  ok("a document with no POSITION bounds returns null, not zeros",
    boundsOf({ meshes: [{ primitives: [{ attributes: {} }] }], accessors: [] }) === null);
}
{
  const person = plausiblyHumanoid(glbDoc({ size: [0.5, 1.8, 0.3] }));
  ok("a standing figure is plausibly humanoid", person.plausible, person.why);
  ok(`...comfortably above the ${HUMANOID_MIN_RATIO} floor rather than scraping it`,
    person.ratio > 3, String(person.ratio));

  const crate = plausiblyHumanoid(glbDoc({ size: [1, 1, 1] }));
  ok("a cube is NOT", crate.plausible === false, crate.why);
  ok("...and the reason carries the measured extent",
    /1\.000 x 1\.000 x 1\.000/.test(crate.why), crate.why);

  const disc = plausiblyHumanoid(glbDoc({ size: [1, 0.05, 1] }));
  ok("a flat disc is NOT", disc.plausible === false, disc.why);
}
{
  /* ⚠ CANNOT TELL IS NOT A REFUSAL. A mesh whose exporter omitted the bounds
   * must still be allowed through — a gate that blocks on absent evidence
   * blocks on the first file that is merely unusual, and that is a worse
   * failure than the one it was built to stop. */
  const r = plausiblyHumanoid({ meshes: [], accessors: [] });
  ok("a mesh with no readable bounds is allowed through", r.plausible === true);
  ok("...with a null ratio and a sentence saying why", r.ratio === null && /not a reason to refuse/.test(r.why));
}
{
  const flat = plausiblyHumanoid(glbDoc({ size: [1, 0, 1] }));
  ok("a degenerate (zero-extent) mesh is refused rather than dividing by zero",
    flat.plausible === false && flat.ratio === null, flat.why);
}

console.log("\nreading a file off disk");
{
  const dir = path.join(os.tmpdir(), `aiplay-glb-${Date.now().toString(36)}`);
  await mkdir(dir, { recursive: true });
  const good = path.join(dir, "rigged.glb");
  await writeFile(good, glb({ skinned: true }));
  const r = await readGlbFile(good);
  ok("a .glb on disk reads back", r.ok && assertSkinned(r.json).ok, r.why.join("; "));

  const missing = await readGlbFile(path.join(dir, "nothing-here.glb"));
  ok("a missing file is a verdict, not a throw", missing.ok === false);
  ok("...and it names the file", /nothing-here\.glb/.test(missing.why.join(" ")), missing.why.join("; "));
  await rm(dir, { recursive: true, force: true });
}


/* ══════════════════════════════════════════════════════════════════════════
 * THE FOUR BYTES, PINNED AGAINST A LITERAL
 *
 * ⚠ THE MEASURED FAILURE THIS EXISTS FOR. glb.js typed the container magic as
 * `0x46546c47` — the bytes "GlTF", capital G — and fixtures.js held a copy of
 * the same wrong number, despite its own header saying it exists so that
 * glb.js is read by something that did not also write it. So every assertion
 * above passed while readGlb() rejected every real GLB in the world, and it
 * was found the only way it could be: TripoSG wrote one through the app's own
 * route, a minute of card time was spent, and the answer came back "the first
 * four bytes are not glTF".
 *
 * Both sides now derive the tags from ASCII, which is better and is still two
 * things agreeing with each other. So this block agrees with NEITHER: it
 * states the bytes the glTF specification prints, one integer at a time, and
 * drives the reader with a header typed out by hand.
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\nthe four bytes");
{
  ok("the container magic is \"glTF\" — 0x67 0x6c 0x54 0x46, lower-case g",
    MAGIC === 0x46546c67, "0x" + MAGIC.toString(16));
  ok("...which is NOT \"GlTF\", the capital-G value this module used to carry",
    MAGIC !== 0x46546c47);
  ok("the JSON chunk tag is \"JSON\"", CHUNK_JSON === 0x4e4f534a, "0x" + CHUNK_JSON.toString(16));
  ok("the BIN chunk tag is \"BIN\\0\"", CHUNK_BIN === 0x004e4942, "0x" + CHUNK_BIN.toString(16));

  /* AND THE READER DRIVEN BY BYTES NOBODY IN THIS TREE ENCODED — a container
   * assembled from the four ASCII characters, right here, by hand. */
  const hand = Buffer.concat([
    Buffer.from([0x67, 0x6c, 0x54, 0x46]),           // "glTF"
    Buffer.from([2, 0, 0, 0]),                        // version 2
    Buffer.from([28, 0, 0, 0]),                       // 12 header + 8 chunk header + 8 JSON
    Buffer.from([8, 0, 0, 0]),
    Buffer.from([0x4a, 0x53, 0x4f, 0x4e]),            // "JSON"
    Buffer.from("{}      ", "latin1"),                // 8 bytes, padded with spaces
  ]);
  const g = readGlb(hand);
  ok("a container typed out as raw ASCII bytes is accepted", g.ok === true, JSON.stringify(g.why));
  const wrong = Buffer.from(hand); wrong[0] = 0x47;   // "GlTF"
  ok("...and the same container with a capital G is refused", readGlb(wrong).ok === false);
}
console.log(`\n  ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
