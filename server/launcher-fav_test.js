/**
 * THE LAUNCHER'S FAVOURITE (2026-09-25): a star on a mode card starts that mode
 * every time the launcher opens. One at a time, asked in the launcher's own
 * pop-up, removable any time. And the system check no longer writes back a
 * stale copy of settings.json over a preference saved while it ran.
 *
 *   node --test server/launcher-fav_test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the launcher saves one favourite mode and starts it when it opens", () => {
  const mjs = read("../launcher/launcher.mjs");
  assert.match(mjs, /const LAUNCH_MODES = \["full", "music", "cloud", "runpod"\];/);
  assert.match(mjs, /autoLaunch: LAUNCH_MODES\.includes\(saved\.launcherAutoLaunch\) \? saved\.launcherAutoLaunch : null,/);
  assert.match(mjs, /if \(b\.autoLaunch === null\) await saveSettings\(\{\}, \["launcherAutoLaunch"\]\);/, "unstar removes it");
  assert.match(mjs, /if \(!LAUNCH_MODES\.includes\(b\.autoLaunch\)\) return send\(res, 400, \{ error: "Unknown mode\." \}\);/);
  assert.match(mjs, /if \(!c\?\.modes\?\.\[mode\]\?\.available\) \{/, "a mode this PC cannot run is not started");
  assert.match(mjs, /showWindow\(\);\n  autoLaunch\(\);/, "started as the launcher opens");
});

test("the page: a star per card, one at a time, confirmed in the launcher's own pop-up", () => {
  const html = read("../launcher/index.html");
  for (const m of ["full", "music", "cloud", "runpod"]) assert.match(html, new RegExp(`data-fav="${m}"`));
  assert.match(html, /b\.disabled = !!fav && !on;/, "the other stars grey out while one is set");
  assert.match(html, /id="askModal" hidden role="dialog" aria-modal="true"/);
  assert.match(html, /if \(!\(await askInApp\(`Start \$\{name\} with the launcher\?`,/);
  assert.match(html, /You can undo this at any time, even while it runs: open the launcher, "\n    \+ "click the star again to remove it, then press Stop on the running app or restart\./);
  assert.doesNotMatch(html.slice(html.indexOf("async function setFav"), html.indexOf("/* The panel follows")), /confirm\(/, "not the browser's box");
});

test("the system check merges only what it changed into settings.json", () => {
  const setup = read("../scripts/setup.mjs");
  assert.match(setup, /const latest = await saved\(\);\n    const out = \{ \.\.\.latest \};/);
  assert.match(setup, /if \(JSON\.stringify\(cur\[k\]\) === JSON\.stringify\(next\[k\]\)\) continue;/);
  assert.match(setup, /await writeFile\(SETTINGS, JSON\.stringify\(out, null, 2\)\);/);
});
