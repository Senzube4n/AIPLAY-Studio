/* PRIVATE MODE — the words are not written, and the event still is.
 *
 * A render made in private mode must leave no trace of what somebody typed, in
 * any of the places this app writes: the ledger line, the content-addressed
 * graph store, the picture's own bytes, and the gallery sidecar. It must leave
 * everything ELSE — the event, the chain, the seed, the model, the disclosure —
 * because a privacy feature that also erases provenance is a laundering tool.
 *
 * ⚠ THE PIN THAT MATTERS MOST IS THE DESTRUCTURE, and it is first because it is
 * the one that actually broke. `ArtRunner.request()` takes a DESTRUCTURED
 * parameter list, so a field the caller sets and that list does not name is
 * dropped in silence. The route set `private`, the render ran, every redaction
 * below was correct — and the prompt went into the ledger verbatim, because the
 * flag never arrived. Nothing failed. Nothing warned. Measured on a real render
 * before this pin existed: the probe prompt appeared in `label`, `prompt` and
 * `texts`, and a graph file was filed.
 *
 * The same trap has bitten this function before (engine, checkpoint and seed had
 * to be moved inside `video`), which is why the check is on the SOURCE of the
 * parameter list rather than on behaviour: behaviour tests pass a whole job
 * object and cannot see a name quietly missing from a signature.
 */
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRecord } from "./engine/record.js";
import { REDACTED_KEYS } from "./provenance.js";
import * as prov from "./provenance.js";
import { stripPngText } from "./pngtext.js";

let pass = 0;
const failures = [];
const ok = (what, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${what}`); }
  else { failures.push(what); console.log(`  FAIL  ${what}${detail ? `\n          ${detail}` : ""}`); }
};
const head = (s) => console.log(`\n${s}`);
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/* Two-sided, the way this codebase insists: the positive AND a mutation that
 * must break it, so a pin cannot quietly stop watching. */
const both = (what, test, text, breakIt, how) => {
  ok(what, test(text));
  const broken = breakIt(text);
  ok(`  └ negative: fails when ${how}`, broken !== text && !test(broken),
    broken === text
      ? "THE MUTATION CHANGED NOTHING — the negative proves nothing"
      : "THE PIN PASSED ON A BROKEN TREE — it is not watching what it says");
};

head("§1  the flag survives the door it has to pass through");
{
  const art = src("./art.js");
  const sig = art.slice(art.indexOf("  request({"), art.indexOf("  request({") + 400);

  /* ⚠ THIS IS THE ONE THAT BROKE. A destructured parameter list is a contract:
   * a name missing from it is a field silently discarded. */
  both("ArtRunner.request() NAMES `private`, or the flag is dropped in silence",
    (t) => /request\(\{[^}]*\bprivate\s*:\s*isPrivate/.test(t),
    sig, (t) => t.replace(/,\s*private\s*:\s*isPrivate\s*=\s*false/, ""),
    "the name is taken out of the parameter list — exactly how this broke, with nothing failing");

  both("...and it reaches the job, so the render seams can read it",
    (t) => /private:\s*!!isPrivate/.test(t),
    art, (t) => t.replace("private: !!isPrivate,", ""),
    "the job stops carrying it and every seam below sees undefined");

  /* Every engine call site, not just the first: a private clip is as private as
   * a private picture, and a half-wired flag is worse than none because it is
   * the half nobody checks. */
  const calls = (art.match(/const done = await engineDoor\.run\(\{/g) || []).length;
  const wired = (art.match(/private: job\.private === true/g) || []).length;
  ok(`every engine call site passes it (${wired} of ${calls})`, calls > 0 && wired === calls,
    `${calls} call sites, ${wired} wired`);
}

head("§2  the engine record keeps its shape and loses the words");
{
  const graph = {
    1: { class_type: "CLIPTextEncode", inputs: { text: "a private prompt nobody should read" } },
    2: { class_type: "KSampler", inputs: { seed: 42, steps: 20, cfg: 7, positive: ["1", 0] } },
  };
  const ctx = { runId: "r1", via: "t", actor: "user", label: "a private prompt n" };
  const open = buildRecord(graph, ctx);
  const shut = buildRecord(graph, { ...ctx, private: true });

  ok("a normal record still carries the prompt", open.prompt === "a private prompt nobody should read");
  ok("a private record carries no prompt", shut.prompt === null);
  ok("...no negative, no text nodes", shut.negative === null && shut.texts.length === 0);

  /* ⚠ THE HASH GOES TOO. A prompt is low-entropy text, so sha256 of one is a
   * lookup key rather than an anonymisation: measured on a real ledger, 305 of
   * 419 promptHash values were confirmed just by hashing candidate prompts out
   * of the picture sidecar. Keeping it would keep the leak. */
  ok("...and no promptHash, because a prompt hash is a lookup key, not a redaction",
    shut.promptHash === null && shut.negativeHash === null);
  ok("...nor a `label`, which is the prompt's first 48 characters wearing a name",
    shut.label === null);
  ok("it says what it dropped, rather than leaving an unexplained gap",
    Array.isArray(shut.redacted) && shut.redacted.includes("prompt") && shut.redacted.includes("promptHash"));

  /* The shape is the point: a private render is still reproducible-adjacent —
   * same model, same seed, same node count — it simply has no words. */
  ok("the SHAPE survives: same graph hash, seed, steps, node count",
    shut.graphHash === open.graphHash && shut.seed === open.seed
    && shut.steps === open.steps && shut.graphNodes === open.graphNodes,
    JSON.stringify({ h: shut.graphHash === open.graphHash, seed: shut.seed, steps: shut.steps }));
}

head("§3  the graph is not filed, and the ledger line still is");
{
  const client = src("./engine/client.js");
  both("a private run files no graph — that store is plaintext and never pruned",
    (t) => /spec\.private === true\s*\n?\s*\?\s*\{ path: null/.test(t),
    client, (t) => t.replace(/spec\.private === true\s*\n?\s*\?\s*\{ path: null, existed: false \}\s*\n?\s*:\s*/, ""),
    "the guard is removed and every private prompt is filed under its hash");

  ok("...but the delegate APPEND is not conditional, because the chain must not gap",
    /await prov\.append\("library", \{\s*\n\s*actor, type: "delegate"/.test(client),
    "a hash-chained ledger cannot skip a line: an absent event breaks verification of every later one");
}

head("§4  the ledger redacts centrally, and keeps the chain");
{
  const dir = mkdtempSync(path.join(tmpdir(), "privpin-"));
  try {
    const scope = { dir };
    const data = {
      model: "flux2", seed: 42, runId: "r1",
      prompt: "a private prompt", negative: "blurry", texts: [{ value: "a private prompt" }],
      label: "a private pr", promptHash: "sha256:deadbeef",
    };
    const a = await prov.append(scope, { actor: "user", type: "delegate", asset: "engine/r1", data });
    const b = await prov.append(scope, { actor: "user", type: "delegate", asset: "engine/r2", private: true, data });

    ok("a normal event is untouched", a.data.prompt === "a private prompt" && a.data.promptHash === "sha256:deadbeef");
    ok("a private event keeps none of the words",
      b.data.prompt === undefined && b.data.negative === undefined
      && b.data.texts === undefined && b.data.label === undefined && b.data.promptHash === undefined,
      JSON.stringify(b.data));
    ok("...and keeps everything that is not words", b.data.model === "flux2" && b.data.seed === 42 && b.data.runId === "r1");
    ok("...and names what it dropped", Array.isArray(b.data.redacted) && b.data.redacted.length === 5);

    /* ⚠ THE EVENT HAPPENS. Skipping it would not hide a render; it would break
     * the hash chain, and an unverifiable ledger is worse than a private one. */
    ok("the event is WRITTEN, not skipped — the chain continues", b.prev === `sha256:${prov.sha256hex(JSON.stringify(a))}`
      || (typeof b.prev === "string" && b.prev.startsWith("sha256:") && b.prev !== prov.GENESIS),
      `prev=${b.prev}`);

    ok("REDACTED_KEYS names every field the redaction drops",
      REDACTED_KEYS.includes("prompt") && REDACTED_KEYS.includes("promptHash")
      && REDACTED_KEYS.includes("texts") && REDACTED_KEYS.includes("label")
      && REDACTED_KEYS.includes("caption") && REDACTED_KEYS.includes("lyrics"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

head("§5  the picture's own bytes");
{
  /* A 1x1 PNG with two text chunks: ComfyUI's graph, and the app's own XMP
   * disclosure. Built by hand so the pin owns its fixture. */
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const text = (kw, val) => chunk("tEXt", Buffer.concat([Buffer.from(kw, "latin1"), Buffer.alloc(1), Buffer.from(val, "latin1")]));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    text("prompt", '{"1":{"inputs":{"text":"a private prompt"}}}'),
    text("XML:com.adobe.xmp", "<x:xmpmeta>trainedAlgorithmicMedia</x:xmpmeta>"),
    chunk("IDAT", Buffer.from([0x78, 0x9c, 0x62, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const dir = mkdtempSync(path.join(tmpdir(), "privpng-"));
  try {
    const f = path.join(dir, "x.png");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(f, png);
    const r = await stripPngText(f);
    const after = readFileSync(f);

    ok("the engine's prompt chunk is removed", r.stripped.includes("prompt") && !after.includes("a private prompt"));

    /* ⚠ AND THE DISCLOSURE STAYS. Dropping the XMP would turn a privacy feature
     * into a disclosure-removal tool, which is the one thing it must not be:
     * privacy is about the words somebody typed, never about hiding what made
     * the picture. */
    ok("...and the AI disclosure is KEPT, or this would be a laundering tool",
      after.includes("trainedAlgorithmicMedia"));
    ok("the pixels are untouched — the chunk list is rewritten, not re-encoded",
      after.includes(Buffer.from([0x78, 0x9c, 0x62])));
    ok("a file that is not a PNG is skipped rather than mangled",
      (await (async () => {
        const g = path.join(dir, "y.txt");
        writeFileSync(g, "not a png");
        const s2 = await stripPngText(g);
        return s2.skipped === "not a PNG" && readFileSync(g, "utf8") === "not a png";
      })()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

head("§6  the gallery row survives");
{
  const index = src("./index.js");
  both("a private picture keeps its row and loses only the prompt",
    (t) => /isPrivate \? \{ promptRedacted: true \} : \{ prompt \}/.test(t),
    index, (t) => t.replace("isPrivate ? { promptRedacted: true } : { prompt }", "{ prompt }"),
    "the row keeps the prompt and the whole sidecar redaction is undone");

  both("...and the wildcard expansion goes with it, or the prompt rebuilds from its pieces",
    (t) => /isPrivate \? \{\} : \(wildOf \|\| \{\}\)/.test(t),
    index, (t) => t.replace("...(isPrivate ? {} : (wildOf || {}))", "...(wildOf || {})"),
    "template and promptChoices are kept, which is the prompt in two halves");
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
