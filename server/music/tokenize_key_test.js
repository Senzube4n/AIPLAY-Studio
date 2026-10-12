/**
 * THE TOKENIZER'S CACHE KEY CARRIES THE READER, 2026-09-25.
 *
 * Until this date the real-audio tokenizer read garbage: under transformers 5
 * MERT's rotary table was never initialised (see yue_tokenize.py and
 * yue_tokenize_test.py). The cache was keyed on the decoded audio alone, so
 * after the fix every recording already read would have kept serving its old
 * codes from output/yue2/tok_<sha12>. The key now carries MERT_READER:
 * tok_r<reader>_<sha12>. Pinned here, with no python, no weights and no card:
 * the JS and python constants agree; an old folder is never hit, by
 * codesDirFor, by tokenizeTrack or by sounds_like; a reading that names another
 * reader is refused and its codes are not kept; the cache still hits for the
 * current reader. The output folder is a temp directory (AIPLAY_OUTPUT).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aiplay-tokkey-"));
process.env.AIPLAY_OUTPUT = path.join(scratch, "output");
fs.mkdirSync(process.env.AIPLAY_OUTPUT, { recursive: true });

const { config } = await import("../config.js");
const tok = await import("./tokenize.js");
const { catalogueOfCodes, soundsLike } = await import("./similar.js");
const { MERT_READER, codesFolderName, isCurrentReading, codesDirFor, tokenizeTrack, audioFingerprint } = tok;

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** A 1-D int32 .npy the way numpy writes one, so similar.js can read it back. */
function npy(codes) {
  let header = `{'descr': '<i4', 'fortran_order': False, 'shape': (${codes.length},), }`;
  while ((10 + header.length + 1) % 64) header += " ";
  header += "\n";
  const head = Buffer.alloc(10);
  head.write("\x93NUMPY", 0, "latin1"); head[6] = 1; head[7] = 0; head.writeUInt16LE(header.length, 8);
  const body = Buffer.alloc(codes.length * 4);
  codes.forEach((c, i) => body.writeInt32LE(c, i * 4));
  return Buffer.concat([head, Buffer.from(header, "latin1"), body]);
}
function writeCodes(dir, codes, receipt = null) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "semantic.npy"), npy(codes));
  if (receipt) fs.writeFileSync(path.join(dir, "source.json"), JSON.stringify(receipt));
}
const ramp = (n, from = 0) => Array.from({ length: n }, (_, i) => (from + i) % 32768);

/** Stands in for the python: writes codes where --out says and prints the script's JSON line. */
function fakeRunner({ reader = MERT_READER, omitReader = false, codes = ramp(100) } = {}) {
  const calls = [];
  const runner = async (cmd, argv) => {
    calls.push({ cmd, argv });
    const out = argv[argv.indexOf("--out") + 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, npy(codes));
    const line = { ok: true, out, frames: codes.length, seconds: codes.length / 25, framesPerSecond: 25, device: "cpu",
      distinctCodes: new Set(codes).size, timing: { total: 0.01 }, ...(omitReader ? {} : { reader }) };
    return { code: 0, out: `${JSON.stringify(line)}\n`, err: "" };
  };
  runner.calls = calls;
  return runner;
}
const ready = async () => ({ ready: true, missing: [], head: path.join(scratch, "tokenizer_head_joint_v4.safetensors"), mert: path.join(scratch, "MERT-v2-FullSong") });

try {
  console.log("\n§1  one number, declared on both sides");
  {
    const py = src("./yue_tokenize.py"), js = src("./tokenize.js");
    const pyReader = Number(/^MERT_READER = (\d+)$/m.exec(py)?.[1]);
    ok("yue_tokenize.py and tokenize.js declare the same MERT_READER", pyReader === MERT_READER, `python ${pyReader}, js ${MERT_READER}`);
    ok("...and it is past 1, the reader that left the rotary table uninitialised", MERT_READER >= 2);
    ok("the script prints the reader with every reading", /"reader": MERT_READER,/.test(py));
    ok("the script rebuilds the rotary table straight after loading MERT, before any audio goes through it",
      /model = AutoModel\.from_pretrained\(mert_dir, trust_remote_code=True\)\.to\(device\)\.eval\(\)\n\s+restore_rotary_inv_freq\(model\)/.test(py));
    ok("the key is built in one place: no other tok_ template in tokenize.js",
      (js.match(/`tok_/g) || []).length === 1 && /return `tok_r\$\{MERT_READER\}_\$\{String\(fingerprint\)\.slice\(0, 12\)\}`;/.test(js));
    ok("both lookups use it", (js.match(/codesFolderName\((fp|sha)\)/g) || []).length === 2);
  }

  console.log("\n§2  the folder name");
  {
    const fp = "0123456789abcdef".repeat(4);
    const name = codesFolderName(fp);
    ok("tok_r<reader>_<first 12 hex>", name === `tok_r${MERT_READER}_0123456789ab`, name);
    ok("...which is never the old reader's name for the same audio", name !== "tok_0123456789ab");
    ok("the current reader's folder is current", isCurrentReading(name));
    ok("an old reader's folder is not: tok_<sha12>", !isCurrentReading("tok_0123456789ab"));
    ok("...nor tok_r1_, nor a later reader's", !isCurrentReading("tok_r1_0123456789ab") && !isCurrentReading(`tok_r${MERT_READER + 1}_0123456789ab`));
    ok("...nor a YuE2 run folder, nor junk", !isCurrentReading("0a1b2c3d") && !isCurrentReading(`tok_r${MERT_READER}_xyz`) && !isCurrentReading(null));
  }

  const yue2 = path.join(config.outputDir, "yue2");
  ok("the output folder is the scratch one", path.resolve(config.outputDir) === path.resolve(process.env.AIPLAY_OUTPUT), config.outputDir);

  console.log("\n§3  codesDirFor: an old reading is not found");
  {
    const file = "aiplay_recording_a.wav";
    fs.writeFileSync(path.join(config.outputDir, file), Buffer.from("not really audio, a fixed payload A".repeat(20)));
    const ffmpeg = "aiplay-no-such-ffmpeg";   // absent: the fingerprint falls back to the file's bytes
    const fp = await audioFingerprint(path.join(config.outputDir, file), { ffmpeg });
    ok("the fingerprint without ffmpeg is the file's sha256",
      fp === createHash("sha256").update(fs.readFileSync(path.join(config.outputDir, file))).digest("hex"));
    writeCodes(path.join(yue2, `tok_${fp.slice(0, 12)}`), ramp(100));
    ok("a recording read only by the old reader is 'not read yet'", (await codesDirFor(file, { ffmpeg })) === null);
    /* Codes in the current reader's folder with no receipt of that reader
     * (a run killed while saving, or a mismatched script before the refusal)
     * are not a reading either (review of the port, 2026-10-08). */
    writeCodes(path.join(yue2, codesFolderName(fp)), ramp(100, 7));
    ok("codes in the current folder without this reader's receipt are 'not read yet'", (await codesDirFor(file, { ffmpeg })) === null);
    writeCodes(path.join(yue2, codesFolderName(fp)), ramp(100, 7), { source: file, reader: 1 });
    ok("...nor with a receipt that names another reader", (await codesDirFor(file, { ffmpeg })) === null);
    writeCodes(path.join(yue2, codesFolderName(fp)), ramp(100, 7), { source: file, reader: MERT_READER });
    const found = await codesDirFor(file, { ffmpeg });
    ok("...and once the current reader has read it, that folder is the one found",
      found?.kind === "recording" && path.basename(found.dir) === codesFolderName(fp), JSON.stringify(found));
  }

  console.log("\n§4  tokenizeTrack: reads past an old folder, keeps a current one, refuses another reader");
  {
    const source = path.join(scratch, "rec_b.wav");
    fs.writeFileSync(source, Buffer.from("a second fixed payload, B".repeat(30)));
    const fp = await audioFingerprint(source);
    const legacy = path.join(yue2, `tok_${fp.slice(0, 12)}`);
    writeCodes(legacy, ramp(100, 3), { source: "rec_b.wav", frames: 100 });
    const legacyBytes = fs.readFileSync(path.join(legacy, "semantic.npy"));

    const r1 = fakeRunner();
    const a = await tokenizeTrack({ source, device: "cpu", runner: r1, status: ready });
    ok("an old folder for the same audio is not a cache hit: the script runs", r1.calls.length === 1 && a.cached === false);
    ok("...into the current reader's folder", path.basename(a.dir) === codesFolderName(fp), a.dir);
    ok("...with the script, the audio, the out file, MERT and the head on its argv",
      /yue_tokenize\.py$/.test(r1.calls[0].argv[0]) && r1.calls[0].argv.includes(source)
      && r1.calls[0].argv[r1.calls[0].argv.indexOf("--out") + 1] === path.join(a.dir, "semantic.npy")
      && r1.calls[0].argv.includes("--mert") && r1.calls[0].argv.includes("--head"));
    const receipt = JSON.parse(fs.readFileSync(path.join(a.dir, "source.json"), "utf8"));
    ok("the receipt names the reader", receipt.reader === MERT_READER && a.reader === MERT_READER, JSON.stringify(receipt));
    ok("the old folder is left as it was, on disk", fs.readFileSync(path.join(legacy, "semantic.npy")).equals(legacyBytes));

    const r2 = fakeRunner();
    const b = await tokenizeTrack({ source, runner: r2, status: ready });
    ok("the second call is a cache hit on the current folder, and nothing runs", b.cached === true && r2.calls.length === 0 && b.dir === a.dir);
    const r3 = fakeRunner();
    await tokenizeTrack({ source, runner: r3, status: ready, force: true });
    ok("force reads it again", r3.calls.length === 1);
    /* The receipt is what makes it a hit: without it (cut short, or another
     * reader's codes left there) the recording is read again. */
    fs.rmSync(path.join(a.dir, "source.json"));
    const r5 = fakeRunner();
    const again = await tokenizeTrack({ source, runner: r5, status: ready });
    ok("codes in the folder without this reader's receipt are read again, not served", r5.calls.length === 1 && again.cached === false);
    fs.writeFileSync(path.join(a.dir, "source.json"), JSON.stringify({ source: "rec_b.wav", reader: 1 }));
    const r6 = fakeRunner();
    await tokenizeTrack({ source, runner: r6, status: ready });
    ok("...and so with a receipt that names another reader", r6.calls.length === 1);

    const other = path.join(scratch, "rec_c.wav");
    fs.writeFileSync(other, Buffer.from("a third fixed payload, C".repeat(30)));
    const fpc = await audioFingerprint(other);
    for (const [label, opts] of [["an unversioned reading (the old script)", { omitReader: true }], ["a reading that names reader 1", { reader: 1 }]]) {
      let err = null;
      try { await tokenizeTrack({ source: other, runner: fakeRunner(opts), status: ready }); } catch (e) { err = e; }
      ok(`${label} is refused by reason`, err?.reason === "tokenizer-version" && err?.status === 500, err?.message);
      ok("...and its codes are not left in the current reader's folder",
        !fs.existsSync(path.join(yue2, codesFolderName(fpc), "semantic.npy")));
    }
    const r4 = fakeRunner();
    const c = await tokenizeTrack({ source: other, runner: r4, status: ready });
    ok("...so the next call reads it properly instead of hitting a bad cache", r4.calls.length === 1 && c.cached === false);

    let missing = null;
    try { await tokenizeTrack({ source, runner: fakeRunner(), status: async () => ({ ready: false, missing: ["x"] }) }); } catch (e) { missing = e; }
    ok("the tokenizer-missing refusal still comes first", missing?.reason === "tokenizer-missing" && missing?.status === 400);
  }

  console.log("\n§5  sounds_like leaves an old reader's folders out");
  {
    const out = path.join(scratch, "sim");
    const root = path.join(out, "yue2");
    writeCodes(path.join(root, `tok_r${MERT_READER}_aaaaaaaaaaaa`), ramp(200), { source: "query.wav" });
    writeCodes(path.join(root, `tok_r${MERT_READER}_bbbbbbbbbbbb`), ramp(200, 50), { source: "fresh.wav" });
    writeCodes(path.join(root, "tok_cccccccccccc"), ramp(200), { source: "stale.wav" });
    writeCodes(path.join(root, "tok_r1_dddddddddddd"), ramp(200), { source: "stale_r1.wav" });
    writeCodes(path.join(root, "0a1b2c3d"), ramp(200, 10));
    const rows = await catalogueOfCodes({ outputDir: out });
    const names = rows.map((r) => r.name).sort();
    ok("the catalogue holds the current reader's recordings and the takes, not the old readings",
      JSON.stringify(names) === JSON.stringify(["0a1b2c3d", `tok_r${MERT_READER}_aaaaaaaaaaaa`, `tok_r${MERT_READER}_bbbbbbbbbbbb`]), names.join(", "));
    const r = await soundsLike(path.join(root, `tok_r${MERT_READER}_aaaaaaaaaaaa`), { outputDir: out });
    ok("...so an identical old reading cannot rank first", r.compared === 2 && !r.matches.some((m) => /stale/.test(m.file || "")),
      JSON.stringify(r.matches));
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
