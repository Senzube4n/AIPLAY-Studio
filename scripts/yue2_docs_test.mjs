/** Public documentation checks; no renderer, network or owner settings. */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "aiplay-yue2-docs-"));
process.env.AIPLAY_APPDATA = path.join(temp, "appdata");
process.env.AIPLAY_RIG = path.join(temp, "rig");
process.env.AIPLAY_OUTPUT = path.join(temp, "output");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const guide = read("docs/YUE2_GGUF.md"), page = read("docs/index.html"), api = read("API.md");
const { hardwareCell, rebuild, rebuildHtml } = await import("./models_table.mjs");
after(() => {
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith("aiplay-yue2-docs-"));
  rmSync(temp, { recursive: true, force: true });
});

test("all public entry points describe the standalone launcher and explicit Models setup", () => {
  for (const file of ["README.md", "INSTALL.md", "docs/index.html", "docs/YUE2_GGUF.md"]) {
    const text = read(file);
    // The Start YuE2 Music.cmd launcher was retired: one launcher, with a Music only mode.
    assert.match(text, /AIPLAY Studio\.exe/, file);
    assert.match(text, /Music only/, file);
    assert.match(text, /npm run start:music/, file);
    assert.match(text, /Node\.js (?:20|20\+)/, file);
    assert.match(text, /2\.93\s*GB/, file);
    assert.match(text, /explicit/i, file);
  }
  assert.match(guide, /No ComfyUI, Python, PyTorch or unrelated model/);
  assert.match(guide, /Microsoft Visual C\+\+ v14 x64 Redistributable/);
  assert.match(guide, /CUDA 13\.3/);
  assert.match(page, /https:\/\/github\.com\/Senzube4n\/AIPLAY-Studio\/blob\/main\/docs\/YUE2_GGUF\.md/);
});
test("model byte total is the six pinned members, not runtime or VRAM", () => {
  const bytes = [2665632320, 265218656, 959, 466, 2561218, 1378];
  const sum = bytes.reduce((a, b) => a + b, 0);
  assert.ok(guide.includes(sum.toLocaleString("en-US")));
  for (const n of bytes) assert.ok(guide.includes(n.toLocaleString("en-US")));
  assert.match(guide, /additional to the weights/);
  const manifest = JSON.parse(read("server/music/yue-runtime-manifest.json"));
  const total = manifest.archives.reduce((n, item) => n + item.bytes, 0);
  assert.ok(guide.includes(total.toLocaleString("en-US")));
  for (const archive of manifest.archives) {
    assert.ok(guide.includes(archive.name));
    assert.ok(guide.includes(archive.bytes.toLocaleString("en-US")));
  }
  assert.match(guide, /AIPlay packages of unchanged, pinned upstream binaries/);
});
test("benchmark is bounded to one run and whole-GPU sampled memory", () => {
  for (const text of [guide, page]) {
    for (const value of ["49.4", "22.0", "6,589", "3,129"]) assert.ok(text.includes(value), value);
    assert.match(text, /whole-GPU/);
    assert.match(text, /not a process-memory/i);
    assert.match(text, /certification for 6 GB/);
  }
});
test("native unsupported features and experimental tuning are not borrowed from Python", async () => {
  assert.match(guide, /no guaranteed duration/i);
  assert.match(guide, /native instrumental mode/);
  assert.match(guide, /audio reference\/continuation/);
  assert.match(guide, /reusable mix cache/);
  assert.match(guide, /native score-export/);
  assert.match(guide, /\*\*16\*\* is an experimental/);
  assert.match(page, /These are not native GGUF/);
  assert.match(api, /seconds` for measured audio/);
  assert.match(api, /render_seconds` for elapsed rendering/);
  assert.match(api, /"action":"install","acceptLicense":true/);
  assert.match(api, /Do not auto-accept terms/);
  const nativeSection = api.split("### Native YuE2 GGUF")[1];
  const request = JSON.parse(nativeSection.match(/```json\s*\n([\s\S]*?)\n```/)[1]);
  const { prepareGgufJob } = await import("../server/music-gguf-input.js");
  const normalized = prepareGgufJob(request, "docs-test");
  assert.equal(normalized.engine, "yue2-gguf");
  assert.equal(normalized.narSteps, 32);
  assert.equal(normalized.quantization, "q4_0");
});
test("licence wording is cautious and new guide contains no private machine evidence", () => {
  assert.match(guide, /CC BY-NC 4\.0 to the weights/);
  assert.match(guide, /Whether particular generated/);
  assert.match(guide, /neither/);
  assert.doesNotMatch(guide, /chesy|aiplay-studio-bench|7a281473|106604|C:\\|D:\\|Actions artifacts/i);
  assert.match(read("NOTICE"), /ShugoAI LLC/);
});
test("unknown hardware never renders as zero/null GB or a tested small-card minimum", () => {
  assert.equal(hardwareCell(null, null, { experimental: true, gpu: true }), "Unknown (experimental)");
  assert.equal(hardwareCell(undefined, undefined), "Unknown");
  assert.equal(hardwareCell(0, 8, { gpu: true }), "none (8 rec)");
  assert.equal(hardwareCell(16, 24), "16 GB (24 rec)");
});
test("generated sections stay synchronized and choose one engine instead of requiring MiniMax", () => {
  for (const file of ["README.md", "INSTALL.md"]) {
    const text = read(file);
    assert.ok(text === rebuild(text, file), `${file}: regenerate model table`);
    assert.match(text, /\*\*Choose one music engine\*\*/);
    assert.doesNotMatch(text, /Only MiniMax Music 3 is required|The licence reaches the output itself/);
  }
  assert.ok(page === rebuildHtml(page, "docs/index.html"), "docs/index.html: regenerate model table");
  assert.doesNotMatch(page, /Music still works on CPU|Music engine — MiniMax Music 3 <b>\(required\)/);
});
