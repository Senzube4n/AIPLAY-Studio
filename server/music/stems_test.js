/**
 * The vocal stem as a transcription source, 2026-09-17.
 *
 * §1 the path; §2 ensureVocalStem against a fake queue: an existing stem is
 * returned without a job, a missing one is requested and the queue's own
 * "stems" event releases the wait (another file's event does not), an empty
 * separation refuses by sentence, a refusal to queue refuses, a timeout
 * refuses. §3 the door, the tool, the page and the doc name the option. No card.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { vocalStemPath, ensureVocalStem } from "./stems.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
/* The stems python is not what §2 is about: every fake queue is paired with a
 * preflight that says yes (stems_stop_test.js covers the real one). */
const OK = async () => ({ ok: true });
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

console.log("\n§1  the path");
{
  eq("stems/<model>/<name>/vocals.flac", vocalStemPath("aiplay_00095.flac", { outputDir: "/o", model: "htdemucs_ft" }).split(path.sep).slice(-4), ["stems", "htdemucs_ft", "aiplay_00095", "vocals.flac"]);
  eq("the extension is dropped whatever it is", path.basename(path.dirname(vocalStemPath("song.mp3", { outputDir: "/o" }))), "song");
}

console.log("\n§2  the wait, against a fake queue");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiplay-stems-"));
  const fake = () => Object.assign(new EventEmitter(), { requests: [], request(j) { this.requests.push(j); return { id: "j1" }; } });
  try {
    // existing stem: no job
    const have = fake();
    const p = vocalStemPath("have.flac", { outputDir: dir });
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "x");
    const r0 = await ensureVocalStem("have.flac", { art: have, outputDir: dir, preflight: OK });
    ok("an existing stem comes back at once, without a job", r0.made === false && r0.path === p && have.requests.length === 0);
    // missing stem: request, then the event releases
    const q = fake();
    const p2 = vocalStemPath("make.flac", { outputDir: dir });
    const pending = ensureVocalStem("make.flac", { art: q, outputDir: dir, timeoutMs: 5000, preflight: OK });
    await new Promise((r) => setTimeout(r, 10));
    eq("a missing stem queues a stems job for that file", [q.requests.length, q.requests[0]?.file, q.requests[0]?.kind], [1, "make.flac", "stems"]);
    q.emit("stems", { file: "other.flac", stems: ["x"] });
    fs.mkdirSync(path.dirname(p2), { recursive: true }); fs.writeFileSync(p2, "v");
    q.emit("stems", { file: "make.flac", stems: ["htdemucs_ft/make/vocals.flac"] });
    const r1 = await pending;
    ok("...and the queue's own event for THAT file releases the wait", r1.made === true && r1.path === p2);
    ok("...leaving no listener behind", q.listenerCount("stems") === 0);
    // empty separation
    const e = fake();
    const pe = ensureVocalStem("empty.flac", { art: e, outputDir: dir, timeoutMs: 5000, preflight: OK });
    await new Promise((r) => setTimeout(r, 10));
    e.emit("stems", { file: "empty.flac", stems: [] });
    ok("an empty separation refuses by sentence", await pe.then(() => false, (err) => /produced no stems/.test(err.message)));
    // refused queue
    const n = Object.assign(new EventEmitter(), { request: () => null });
    ok("a queue that refuses is a refusal", await ensureVocalStem("no.flac", { art: n, outputDir: dir, preflight: OK }).then(() => false, (err) => /refused to separate/.test(err.message)));
    // timeout
    const t = fake();
    ok("a timeout refuses by sentence", await ensureVocalStem("slow.flac", { art: t, outputDir: dir, timeoutMs: 30, preflight: OK }).then(() => false, (err) => /did not finish within/.test(err.message)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log("\n§3  the door, the tool, the page and the doc");
{
  const index = src("../index.js"), mcp = src("../mcp.js"), app = src("../../web/app.js"), html = src("../../web/index.html"), api = src("../../API.md");
  ok("/api/song_to_score takes stem: vocals on a library file", /if \(b\.stem === "vocals"\)/.test(index) && /ensureVocalStem\(/.test(index));
  ok("...and refuses the option on anything but a library file", /a vocal stem needs a library file/.test(index));
  ok("song_to_score declares stem and forwards it", /stem: \{ type: "string", enum: \["mix", "vocals"\]/.test(mcp) && /stem: a\.stem === "vocals" \? "vocals" : undefined/.test(mcp));
  ok("the page has the switch, sent for a library song in song mode only", /id="humStem"/.test(html) && /stem: \$\("humStem"\)\?\.checked && source\.library_file \? "vocals" : undefined/.test(app));
  ok("...and a library-song picker with its own Transcribe button", /id="humSong"/.test(html) && /id="humGo"/.test(html) && /humSendSource\(\{ library_file: file \}\)/.test(app));
  ok("the API doc names it", /"stem": "vocals"/.test(api));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
