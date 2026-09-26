/** API mode: fal's real endpoint, the saved switch surviving a restart, and
 *  hosted MiniMax Music 3 as a choice in the Music model picker. No server, no
 *  key and no network: fetch is stubbed and settings live in a temp folder. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(os.tmpdir(), "aiplay-apimode-"));
process.env.AIPLAY_APPDATA = tmp;
writeFileSync(path.join(tmp, "settings.json"),
  JSON.stringify({ api: { enabled: true, provider: "fal", monthlyCapUsd: 7, timeoutMs: 1 } }));
const { config } = await import("./config.js");
const { PROVIDERS } = await import("./apiEngine.js");
test.after(() => rmSync(tmp, { recursive: true, force: true }));

// LF, so the patterns hold on a Windows checkout (core.autocrlf writes CRLF).
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the saved switch, provider and cap are read back at start", () => {
  assert.equal(config.api.enabled, true, "API mode used to switch itself off on every restart");
  assert.equal(config.api.provider, "fal");
  assert.equal(config.api.monthlyCapUsd, 7, "a changed cap used to revert to $20");
});

test("fal is called at minimax/music-3 with the asked-for length", async () => {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ status_url: "s", response_url: "r" }) };
  };
  try {
    await PROVIDERS.fal.submit("k", { caption: "synthwave", lyrics: "[verse]\nhi", seed: 5, seconds: 200 });
  } finally { globalThis.fetch = real; }
  assert.match(seen[0].url, /\/minimax\/music-3$/);
  assert.doesNotMatch(seen[0].url, /fal-ai\/minimax\/music-3/, "that path is a 404 on fal");
  assert.deepEqual(seen[0].body, { prompt: "synthwave", lyrics: "[verse]\nhi", duration: 200, seed: 5 },
    "without duration fal stops at its 60 s default");
});

test("fal gets lyrics even for an instrumental, and a length inside 1..300", async () => {
  const { falMusic3Body } = await import("./apiEngine.js");
  const empty = falMusic3Body({ caption: " jazz ", lyrics: "  ", seed: 1, seconds: 400 });
  assert.equal(empty.prompt, "jazz");
  assert.match(empty.lyrics, /^\[Intro\]\n[\s\S]*\[Outro\]$/, "fal requires lyrics; empty ones became a 422");
  assert.equal(empty.duration, 300, "fal's schema caps duration at 300");
});

test("a 422 names the field fal refused", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 422,
    json: async () => ({ detail: [{ loc: ["body", "lyrics"], msg: "Field required", type: "missing" }] }) });
  try {
    await assert.rejects(PROVIDERS.fal.submit("k", { caption: "x", lyrics: "y" }),
      /refused the request \(422\)\. lyrics: Field required/);
  } finally { globalThis.fetch = real; }
});

test("the Music picker offers hosted Music 3, and choosing it sets API mode", () => {
  const index = src("./index.js"), app = src("../web/app.js");
  assert.match(index, /value: `minimax-music3:api:\$\{name\}`/);
  /* No key saved: the paid row says so, and names the place by its real label
   * (there is no "API mode" section in Settings). */
  assert.ok(index.includes("`needs your own key · ${HOSTED_KEY_PLACE}`"));
  assert.match(src("./cloud-switch.js"), /export const HOSTED_KEY_PLACE = `\$\{CLOUD_CARD_PLACE\} → Hosted engine`;/);
  assert.match(src("./cloud-switch.js"), /export const CLOUD_CARD_PLACE = "Settings → No strong graphics card\?";/);
  assert.doesNotMatch(index, /Settings → API mode/);
  /* Choosing the hosted row switches API mode on through the switch's one
   * writer, which saves it (applyApiConfig → saveApiSettings). */
  assert.match(index, /await applyApiConfig\(\{ enabled: want, \.\.\.\(want \? \{ provider: choice\.api \} : \{\}\) \}\);/);
  assert.match(index, /async function applyApiConfig\(b\) \{[\s\S]{0,600}Object\.assign\(config\.api, patch\);\n\s+await saveApiSettings\(\);/);
  assert.match(app, /if \(e === "minimax-music3" && state\.apiMode\?\.enabled\) return `\$\{e\}:api:/,
    "the picker shows the hosted row as current while API mode is on");
  assert.match(app, /state\.apiMode \? "MiniMax · API"|state\.apiMode\?\.enabled \? "MiniMax · API"/);
});

test("an API song is named so the Library lists it, and filed as the API model", () => {
  const api = src("./apiEngine.js"), lib = src("./library.js"), index = src("./index.js");
  const prefixes = JSON.parse(lib.match(/const PREFIXES = (\[[^\]]*\])/)[1]);
  const stem = api.match(/const stem = `([a-z_]+)\$\{/)[1];
  assert.ok(prefixes.some((p) => stem.startsWith(p)), `${stem}… would be written and never shown`);
  assert.ok(prefixes.some((p) => "api_mu765vxe.wav".startsWith(p)), "songs saved under the old api_ name still show");
  assert.match(index, /job\.viaApi \? "MiniMax Music 3 \(API\)"/);
  assert.match(index, /"\.wav": "audio\/wav"/);
});
