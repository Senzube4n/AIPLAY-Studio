/**
 * WHY EVERY PICTURE SILENTLY FAILED, pinned so it cannot come back.
 *
 * THE BUG, as reported: "every image generation silently fails… it just says
 * queued… I tested all my models, different VAEs, clips, nothing." Measured on
 * the reporter's machine: `prefs.art.enabled: false` in settings.json — the
 * *Cover art* dropdown in Settings — and, across four sessions of trying, not
 * one `got prompt` line in ComfyUI's own log. Nothing was ever sent. Two
 * separate faults, both of them silent:
 *
 *   1  A picture a person asks for on the Images screen is queued as kind
 *      "cover" — the same kind a finished song queues by itself — and
 *      request() refused every "cover" while that setting was off. It answered
 *      `null`, /api/image answered `ok: true` anyway, and the screen said
 *      "Queued." for a render that did not exist.
 *
 *   2  The runner's own guard read the same setting: `if (this.current ||
 *      this.paused || !this.enabled) return`. It clears its timer before that
 *      test and only reschedules on the music branch below it, so with the
 *      setting off the whole lane stopped — clips, stems, timed lyrics,
 *      everything — and nothing ever restarted it.
 *
 * WHAT IS ASSERTED. With the cover setting OFF: a render somebody asked for is
 * queued and starts; an automatic cover is still refused, and says why in
 * words; and the lane drains rather than sitting still. No GPU and no engine —
 * the door refuses to dispatch without a reserved port and a live child of this
 * process, so the render fails immediately, which is all this file needs: that
 * the job STARTED is the whole proof.
 *
 *   node server/artgate_test.js
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";

/* Decided before config.js is first imported — static imports hoist, so every
 * import below is dynamic. Nothing here may touch the real ~/.aiplay-studio. */
const TMP = path.join(os.tmpdir(), `artgate-test-${process.pid}-${Date.now().toString(36)}`);
process.env.AIPLAY_OUTPUT = path.join(TMP, "output");
process.env.AIPLAY_APPDATA = path.join(TMP, "appdata");

const { ArtRunner } = await import("./art.js");

let failed = 0;
const ok = (what, cond, extra = "") => {
  if (cond) console.log(`  ok    ${what}`);
  else { failed++; console.log(`  FAIL  ${what}${extra ? ` — ${extra}` : ""}`); }
};

/* Music always idle, engine "ready" — the runner's own preconditions, so the
 * only thing left that can stop a job is the guard under test. */
const runner = new ArtRunner({ ready: true }, { current: null, queue: [] });
runner.enabled = false;               // "Cover art: off", the reported setting

/* ── 1. the Images screen ─────────────────────────────────────────────────── */

const asked = runner.request({
  file: "image:i1", title: "a paper boat", kind: "cover", force: true, asked: true,
  video: { prompt: "a paper boat on wet tarmac", engine: "flux2", count: 1 },
});
ok("a picture somebody asked for is queued with cover art switched off", !!asked,
  `request() returned null: ${runner.lastRefusal}`);
ok("and it is marked as asked for, not as automatic art", asked?.asked === true);

/* ── 2. the setting still does its actual job ─────────────────────────────── */

const auto = runner.request({ file: "song.flac", title: "song", kind: "cover" });
ok("an AUTOMATIC cover is still refused while the setting is off", auto === null);
ok("and the refusal says why, in words a route can pass on",
  /cover art is switched off/i.test(runner.lastRefusal || ""),
  JSON.stringify(runner.lastRefusal));

/* A duplicate is refused too, and must not be confused with the setting. */
runner.request({
  file: "image:i9", kind: "cover", asked: true,
  video: { prompt: "x", engine: "flux2", count: 1 },
});
const dup = runner.request({ file: "image:i9", kind: "cover", asked: true });
ok("a duplicate is refused with its own reason", dup === null
  && /already in the queue/i.test(runner.lastRefusal || ""), JSON.stringify(runner.lastRefusal));

/* ── 3. the lane drains ───────────────────────────────────────────────────── */

/* The runner starts a job on a 1.2s timer. All this waits for is `current`
 * becoming non-null — the job then fails against a door that will not dispatch,
 * which is expected and not what is being measured. */
const started = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 8000);
  const seen = () => {
    if (!runner.current) return;
    clearTimeout(t); runner.off("update", seen); resolve(true);
  };
  runner.on("update", seen);
  seen();
});
ok("the queue drains with cover art switched off, instead of sitting forever", started,
  "nothing ever started — the runner's guard is reading the cover-art setting again");

/* ── 4. and the guard's source says so ────────────────────────────────────── */

const src = await (await import("node:fs/promises")).readFile(new URL("./art.js", import.meta.url), "utf8");
const guard = /async #drain\(\) \{[\s\S]*?\n    if \(([^)]*)\) return;/.exec(src);
ok("the drain guard tests only what is RUNNING, never which kinds are allowed",
  !!guard && !/enabled/.test(guard[1]), guard ? guard[1] : "guard not found");

/* ── 5. and the screen can finally say what is happening ──────────────────
 *
 * The other half of the report: "there's not even a cancel button or an X if
 * it's stuck". A render passes through four states the Images screen never
 * showed, and said "Queued." for all of them. */

const { readFile } = await import("node:fs/promises");
const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
const appjs = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../web/styles.css", import.meta.url), "utf8");

ok("the Images screen has a render strip to paint into",
  /<div class="renderbar" id="imgProg"/.test(html) && /id="imgProgBar"/.test(html));
ok("with a stop control, which is the half that was missing entirely",
  /id="imgProgStop"/.test(html) && /\$\("imgProgStop"\)\.onclick/.test(appjs));
ok("the ✕ interrupts a running render and drops a waiting one",
  /action: "stop_current"/.test(appjs) && /action: "drop", file/.test(appjs));
for (const state of ["Waiting for the engine", "Loading the model", "Paused"]) {
  ok(`the strip can say "${state}"`, appjs.includes(state));
}
ok("a render with no measurable progress sweeps rather than inventing a number",
  /classList\.toggle\("sweep"/.test(appjs) && /\.rbtrack>i\.sweep\{/.test(css));
ok("the live socket carries the art lane, so the bar moves between polls",
  /paintImgProgress\(\{ \.\.\.snap/.test(appjs));
ok("one picture per press is the default again",
  /<option value="1" selected>1<\/option>/.test(html.slice(html.indexOf('id="imgCount"'))));

/* ── 6. the picture appears on the screen it was made on ─────────────────
 *
 * Reported next: "it doesn't show up in the images tab right away, first have
 * to click on the jobs done button, then click on the image you just generated
 * and it leads you to the same page you were just on with the image already
 * there." The create loop used to stop the moment the lane said the job had
 * finished — and the lane says that when the JOB ends, a tick or two before the
 * file is on disk — so the grid's last read happened before there was anything
 * to read. Two fixes, both pinned here: the loop keeps reading for a few ticks
 * after the job leaves the queue, and any finished render announced on the live
 * socket repaints the grid while the Images tab is open (which also covers a
 * picture an agent made over MCP). */

ok("the grid is re-read after the lane reports the job finished, not before",
  /imgGraceTicks/.test(appjs) && /if \(!imgWaiting && \+\+imgGraceTicks > \d\) break;/.test(appjs));
ok("a render that finishes anywhere repaints the open Images tab",
  /function imgSeeFinished/.test(appjs)
  && /state\.view === "images"\) loadImages\(\)/.test(appjs));
ok("and it ignores the first frame after a reload, which is history not news",
  /const first = imgLastDone === null;/.test(appjs));

/* ── 7. and the screen is not a wall of text ──────────────────────────────
 *
 * "WAY TOO MUCH TEXT AGAIN." The Images panel explained itself in paragraphs
 * above the form, including the selected engine's own description — 400
 * characters of it on Krea 2. Same answer the Music panel got: the prose moved
 * behind "!" tips, and the engine's description is read LIVE from the element
 * app.js writes it into, so a new engine needs no new tip. */

const tips = await readFile(new URL("../web/tips.js", import.meta.url), "utf8");

for (const gone of ["One subject, one mood, one light", "Show the model pictures from the library",
  "A few seconds each once the model is loaded"]) {
  ok(`the paragraph "${gone.slice(0, 28)}…" is off the screen`, !html.includes(gone));
}
ok('the prompt and the references explain themselves behind a "!" instead',
  /imgPrompt: \{ at: 'label\[for="imgPrompt"\]'/.test(tips)
  && /imgRefs: \{ at: "#imgRefWrap > \.flabel"/.test(tips));
ok("the engine's own description is the engine row's tip, read live",
  /imgEngine: \{ at: 'label\[for="imgEngine"\]', text: "", from: "imgModelNote" \}/.test(tips)
  && /class="hint tipsrc" id="imgModelNote"/.test(html));
ok("a tip with no text of its own is not rendered as a leading space",
  /return `\$\{t\.text\} \$\{extra\}`\.trim\(\);/.test(tips));
ok("tips are kept alive on the Images panel, which repaints when the engine changes",
  /#imgPanel \.vidform/.test(tips));
ok("its fields are flat: one soft surface, no border until focus",
  /* The Video panel shares these rules since 2026-09-19, through :is(). */
  /:is\(#imgPanel \.vidform, #vidPanel\) \{[^}]*--mfield:/.test(css)
  && /:is\(#imgPanel \.vidform, #vidPanel\) \.tipsrc \{ display: none !important; \}/.test(css));

/* Nothing of ours may outlive the test: stopAll clears the queue, and the
 * interrupt it sends goes to a door that refuses without a reserved port. */
await runner.stopAll().catch(() => {});
await rm(TMP, { recursive: true, force: true }).catch(() => {});

console.log(failed ? `\nFAIL(${failed})` : "\nok");
process.exit(failed ? 1 : 0);
