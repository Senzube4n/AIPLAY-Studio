/**
 * THE REFERENCE GATE, tested without Blender — because that is when it matters.
 *
 * blender.js decides whether a picture may be handed to an image or video model
 * as a reference. Three checks, and each one exists because the others can be
 * walked around:
 *
 *   NAME    a file called *.contact.png is a human contact sheet.
 *   SIDECAR <path>.previz.json says what the render was FOR.
 *   PIXELS  the magenta border props.py paints around a grid.
 *
 * The pixel check was added after this exact sequence was measured through MCP
 * against the real route: render a contact sheet, rename it to look like a
 * character sheet, delete its sidecar, and mv_import_asset installed a
 * six-panel grid as the face a whole music video would be rendered from. The
 * failure it causes is expensive and slow to diagnose — DIRECTING.md records
 * twice that a model handed a grid draws a grid — and every earlier check had
 * been satisfied by a `mv` and a `del`.
 *
 * EVERY FIXTURE HERE IS SYNTHESISED IN THIS FILE. Not for speed: the gate has
 * to hold on a machine with no Blender and no toolkit, judging a file somebody
 * emailed, so a suite that needed a render to prove it would be testing the
 * wrong thing. The PNGs are written by hand — including one Paeth-filtered
 * image, because a decoder that only ever meets filter 0 is not a decoder.
 *
 * THE ASYMMETRY IS THE POINT, and half these cases are here to defend it:
 * `safe` means NOT PROVEN UNSAFE. A jpeg off the Images tab, a palette PNG, a
 * 16-bit render, a truncated file — none can be judged, and none may be
 * refused. A gate that refuses what it cannot read is a wall, and somebody
 * deletes a wall.
 *
 * Runs standalone (`node server/mv/blender_test.js`), writes only into a temp
 * directory it removes, and needs nothing installed.
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { referenceSafe, BUILTINS, SETS, SETS_FALLBACK, toolkitSets,
         blenderStatus, ANGLES, DEFAULT_ANGLES } from "./blender.js";

/** blender.js's own text, for the two claims that are about its SHAPE. */
const SRC = readFileSync(fileURLToPath(new URL("./blender.js", import.meta.url)), "utf8");

let pass = 0, skips = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const DIR = mkdtempSync(path.join(tmpdir(), "mvgate-"));
const at = (name) => path.join(DIR, name);

/* ── a PNG writer, just enough to make a border ───────────────────────────── */

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = ~0;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return ~c >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/**
 * Write a PNG. `pixel(x, y) -> [r, g, b(, a)]`.
 * `filter` 0 (none) or 4 (Paeth) — the two the reader has to get right.
 */
function writePng(file, w, h, pixel, { color = 2, depth = 8, filter = 0, interlace = 0 } = {}) {
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[color] ?? 3;
  const bytes = ch * (depth === 16 ? 2 : 1);
  const stride = w * bytes;
  const flat = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = pixel(x, y);
      for (let c = 0; c < ch; c++) {
        if (depth === 16) flat.writeUInt16BE((v[c] ?? 255) * 257, y * stride + (x * ch + c) * 2);
        else flat[y * stride + x * ch + c] = v[c] ?? 255;
      }
    }
  }
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const cur = flat[y * stride + i];
      if (filter === 0) { raw[y * (stride + 1) + 1 + i] = cur; continue; }
      const a = i >= bytes ? flat[y * stride + i - bytes] : 0;
      const b = y ? flat[(y - 1) * stride + i] : 0;
      const c = (y && i >= bytes) ? flat[(y - 1) * stride + i - bytes] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      raw[y * (stride + 1) + 1 + i] = (cur - pred) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth; ihdr[9] = color; ihdr[12] = interlace;
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
  return file;
}

/** props.py's CONTACT_MARK as it lands in an 8-bit file. Measured, not derived. */
const MARK = [230, 5, 140];
const GREY = [120, 120, 120];
/** A grid: magenta border and gutter, grey tiles. The shape props.py writes. */
const grid = (w, h, border = 13, gutter = 8, cols = 3, rows = 2) => (x, y) => {
  const tw = (w - 2 * border - (cols - 1) * gutter) / cols;
  const th = (h - 2 * border - (rows - 1) * gutter) / rows;
  const ix = x - border, iy = y - border;
  if (ix < 0 || iy < 0) return MARK;
  const inTileX = (ix % (tw + gutter)) < tw && ix < cols * tw + (cols - 1) * gutter;
  const inTileY = (iy % (th + gutter)) < th && iy < rows * th + (rows - 1) * gutter;
  return inTileX && inTileY ? GREY : MARK;
};
/** A reference: a neutral card with a blob in the middle. No border at all. */
const card = (w, h) => (x, y) => {
  const d = Math.hypot(x - w / 2, y - h / 2);
  return d < Math.min(w, h) / 4 ? [235, 235, 235] : GREY;
};
const sidecar = (file, body) => writeFileSync(`${file}.previz.json`, JSON.stringify(body));

/* ── what a real render looks like ────────────────────────────────────────── */

const ref = writePng(at("prop_x.png"), 256, 256, card(256, 256));
sidecar(ref, { panels: 1, use: "model-reference", angle: "front" });
let r = await referenceSafe(ref);
ok("a single-panel render with a model-reference sidecar is safe AND proven",
  r.safe && r.proven, r.why.join(" | "));

const bare = writePng(at("someones_photo.png"), 200, 200, card(200, 200));
r = await referenceSafe(bare);
ok("a picture with NO sidecar is safe but not proven",
  r.safe && !r.proven, r.why.join(" | "));
ok("...which is the rule import_asset leans on — a jpeg off the Images tab has "
  + "never had a sidecar and must still import", r.safe);

/* ── the three ways a grid gets in ────────────────────────────────────────── */

const named = writePng(at("hero.contact.png"), 300, 200, grid(300, 200));
sidecar(named, { panels: 6, use: "human-review" });
r = await referenceSafe(named);
ok("a contact sheet under its own name is refused", !r.safe);
ok("...by the NAME, the SIDECAR and the PIXELS independently", r.why.length === 4,
  `${r.why.length} reasons: ${r.why.join(" | ")}`);

const renamed = writePng(at("wren_sheet.png"), 300, 200, grid(300, 200));
sidecar(renamed, { panels: 6, use: "human-review" });
r = await referenceSafe(renamed);
ok("...renaming it off .contact.png does not get it in", !r.safe);
ok("...and the sidecar is what catches it", r.why.some((w) => /human-review/.test(w))
  && r.why.some((w) => /6 panels/.test(w)));

/* THE CASE THAT WAS OPEN. Measured through MCP against the real route: this
 * imported, silently, as a character sheet. */
const stripped = writePng(at("wren_face.png"), 300, 200, grid(300, 200));
r = await referenceSafe(stripped);
ok("...and neither does renaming it AND deleting its sidecar", !r.safe,
  "this is the case that shipped: mv + del walked a six-panel grid straight in");
ok("...because the mark is in the PIXELS, which a rename cannot touch",
  r.why.length === 1 && /marker colour/.test(r.why[0]), r.why.join(" | "));

/* ── the decoder, where it is allowed to fail ─────────────────────────────── */

const paeth = writePng(at("paeth_grid.png"), 300, 200, grid(300, 200), { filter: 4 });
ok("a Paeth-filtered grid is still read as a grid",
  !(await referenceSafe(paeth)).safe,
  "filter 0 is what a naive encoder emits; a real one picks per scanline");
const rgba = writePng(at("rgba_grid.png"), 300, 200, grid(300, 200), { color: 6 });
ok("an RGBA grid is still read as a grid", !(await referenceSafe(rgba)).safe);
const paethCard = writePng(at("paeth_card.png"), 256, 256, card(256, 256), { filter: 4 });
ok("...and a Paeth-filtered CARD is still safe — the unfilter is not just "
  + "detecting entropy", (await referenceSafe(paethCard)).safe);

const deep = writePng(at("deep.png"), 64, 64, grid(64, 64, 4, 2), { depth: 16 });
ok("a 16-bit PNG gets NO verdict rather than a refusal", (await referenceSafe(deep)).safe,
  "could-not-read must never refuse, or the gate becomes a wall");
writeFileSync(at("notapng.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
ok("...so does a jpeg", (await referenceSafe(at("notapng.jpg"))).safe);
writeFileSync(at("truncated.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
ok("...so does a truncated PNG", (await referenceSafe(at("truncated.png"))).safe);
ok("...and so does a file that is not there at all",
  (await referenceSafe(at("nothing_here.png"))).safe);
writeFileSync(at("badcar.png.previz.json"), "{not json");
writePng(at("badcar.png"), 64, 64, card(64, 64));
r = await referenceSafe(at("badcar.png"));
ok("but a sidecar that EXISTS and will not parse IS a fault", !r.safe, r.why.join(" | "));

/* ── the border test's own edges ──────────────────────────────────────────── */

/* One magenta pixel is a rendering accident; a border is a decision. The
 * toolkit's threshold is a tenth of the border band, and this proves the number
 * is doing work in both directions rather than being decorative. */
const speck = writePng(at("speck.png"), 256, 256, (x, y) =>
  (x < 3 && y < 3) ? MARK : card(256, 256)(x, y));
ok("a few magenta pixels in a corner do not condemn a picture",
  (await referenceSafe(speck)).safe,
  "9 pixels of a 1024-pixel band is under a tenth — a speck is not a border");
const magentaSubject = writePng(at("magenta_prop.png"), 256, 256, (x, y) =>
  Math.hypot(x - 128, y - 128) < 60 ? MARK : GREY);
ok("...nor does a magenta SUBJECT on a grey card — the check reads the BORDER",
  (await referenceSafe(magentaSubject)).safe,
  "a prop may legitimately be this colour; its frame edge may not");

/* ── the vocabulary, and where it comes from ──────────────────────────────── */

/* ⚠ THIS USED TO ASSERT "the builtin table is the seven gray-box sets", and
 * the seven was never a fact about this app: it was a fact about a checkout
 * across a licence boundary, transcribed here. The toolkit grew an eighth and
 * the test went on passing while the Studio refused to render it. What is
 * actually true of this side is the SHAPE — one live table, keyed by set names
 * this app did not invent — so that is what is checked, and the contents are
 * checked against the real toolkit below. */
ok(`the builtin table is keyed by set names, every one of them non-empty (${
     Object.keys(BUILTINS).length})`,
  Object.keys(BUILTINS).length > 0
  && Object.keys(BUILTINS).every((k) => SETS.includes(k))
  && Object.values(BUILTINS).every((m) => Array.isArray(m) && m.length > 0),
  `keyed by something that is not a set: ${
    Object.keys(BUILTINS).filter((k) => !SETS.includes(k)).join(", ") || "none"}`);

ok("...and SETS and BUILTINS are LIVE bindings the derive mutates, never re-assigned",
  /^\s*export const SETS = \[\.\.\.SETS_FALLBACK\];/m.test(SRC)
  && /^\s*export const BUILTINS = \{ \.\.\.BUILTINS_FALLBACK \};/m.test(SRC)
  && /SETS\.length = 0;/.test(SRC),
  "an importer that captured the binding must see the toolkit's answer without "
  + "being re-imported — routes.js serves BUILTINS straight out of this module");

/* THE PROBE, which is the part that needs Blender. It is the whole reason a
 * set the toolkit adds arrives here WITH its meshes: cli.py has no
 * --list-objects and none was added to it (separate repo, GPL, another agent
 * editing it), so this asks through the door the toolkit already has — a
 * reference render for an object name nothing can match, which raises before a
 * pixel is drawn and puts the true inventory in the message. */
const bst = await blenderStatus();
if (!bst.installed) {
  skips++;
  console.log(`  skip  the derived set list — Blender is not installed (${bst.why.join(" ")})`);
} else {
  const t0 = Date.now();
  const cat = await toolkitSets();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  ok(`the toolkit's own set list is what this module ends up holding (${
       cat.sets.length} sets, ${cat.source}, ${secs}s)`,
    (cat.source === "toolkit" || cat.source === "cache") && !cat.stale
    && SETS.join(",") === cat.sets.join(","),
    `source=${cat.source} stale=${cat.stale} why=${(cat.why || []).join(" ")}`);

  const probed = Object.entries(cat.meshesFrom || {}).filter(([, v]) => v === "toolkit:probe");
  ok(`...and a set this file never transcribed still has its meshes, asked for (${
       probed.map(([k]) => `${k}:${(cat.meshes[k] || []).length}`).join(" ") || "none needed"})`,
    probed.every(([k]) => (cat.meshes[k] || []).length > 0),
    "the probe reads props.py's own \"scene has: …\" inventory out of a refusal; "
    + "an empty answer means that sentence changed shape");

  ok(`...and the fallback list matches the toolkit exactly (${SETS_FALLBACK.length} names)`,
    SETS_FALLBACK.every((x) => cat.sets.includes(x))
    && cat.sets.every((x) => SETS_FALLBACK.includes(x)),
    `typed here and not built: ${SETS_FALLBACK.filter((x) => !cat.sets.includes(x)).join(", ") || "none"}`
    + ` | built and not typed here: ${cat.sets.filter((x) => !SETS_FALLBACK.includes(x)).join(", ") || "none"}`);
}
ok("...and every default angle is an angle the toolkit accepts",
  DEFAULT_ANGLES.every((a) => ANGLES.includes(a)), DEFAULT_ANGLES.join(", "));
ok("...three of them, because a grid is never the answer",
  DEFAULT_ANGLES.length === 3);

rmSync(DIR, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${failures.length} failed`
  + (skips ? `, ${skips} skipped` : "") + "\n");
process.exit(failures.length ? 1 : 0);
