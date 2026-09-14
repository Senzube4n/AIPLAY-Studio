import assert from "node:assert/strict";
import { test, after } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const base = path.resolve(tmpdir()), temporary = mkdtempSync(path.join(base, "aiplay-native-config-test-"));
after(() => {
  assert.equal(path.dirname(path.resolve(temporary)), base);
  assert.ok(path.basename(temporary).startsWith("aiplay-native-config-test-"));
  rmSync(temporary, { recursive: true, force: true });
});
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AIPLAY_")));
function load(extra = {}, appdata = path.join(temporary, "empty")) {
  const script = `import {config} from ${JSON.stringify(new URL("./config.js", import.meta.url).href)};
    console.log(JSON.stringify({musicOnly:config.musicOnly,comfyAutoStart:config.comfyAutoStart,
    native:config.yueGguf,entry:config.music.engines['yue2-gguf'],selected:config.music.engine,
    rig:config.rig,dataDir:config.dataDir,output:config.outputDir}));`;
  const child = spawnSync(process.execPath, ["--preserve-symlinks", "--input-type=module", "-e", script], {
    env: { ...cleanEnv, AIPLAY_APPDATA: appdata,
      ...(extra.AIPLAY_MUSIC_ONLY === "1" ? {} : { AIPLAY_RIG: path.join(temporary, "rig") }),
      ...extra }, encoding: "utf8", windowsHide: true, timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
}
test("optional native engine is discoverable before install and defaults under appdata", () => {
  const config = load(); assert.ok(config.entry); assert.equal(config.native.enabled, true);
  assert.equal(config.native.cli, path.join(config.dataDir, "yue2-gguf", "runtime", "audiocpp_cli.exe"));
  assert.equal(config.native.modelDir, path.join(config.dataDir, "yue2-gguf", "models"));
  assert.equal(config.musicOnly, false); assert.equal(config.comfyAutoStart, true);
});
test("music-only uses native, never defaults to a benchmark rig or Comfy output", () => {
  const config = load({ AIPLAY_MUSIC_ONLY: "1" });
  assert.equal(config.musicOnly, true); assert.equal(config.comfyAutoStart, false);
  assert.equal(config.selected, "yue2-gguf");
  assert.equal(config.rig, path.join(config.dataDir, "rig"));
  assert.equal(config.output, path.join(config.dataDir, "output"));
});
test("explicit native disable keeps the discoverable entry and saved mode remains overridable", () => {
  const appdata = path.join(temporary, "saved"); mkdirSync(appdata);
  writeFileSync(path.join(appdata, "settings.json"), JSON.stringify({ musicOnly: true }));
  assert.equal(load({}, appdata).musicOnly, true);
  const config = load({ AIPLAY_MUSIC_ONLY: "0", AIPLAY_YUE_GGUF_ENABLED: "0" }, appdata);
  assert.equal(config.musicOnly, false); assert.equal(config.native.enabled, false); assert.ok(config.entry);
});
