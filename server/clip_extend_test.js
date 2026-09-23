/**
 * Continue a clip, 2026-09-17.
 *
 * §1 the arithmetic: overlap snaps DOWN to 17k+5 and never past the clip,
 * extension snaps UP to 17m; the window is a valid 17k+5 length. §2 the graph:
 * the tail is a native guide at frame 0 (image batch + audio), the guider reads
 * it, the decode drops the overlap, both branches. §3 the join on synthetic
 * clips through the real ffmpeg (skipped, not failed, where ffmpeg is absent —
 * this app ships without it by promise). §4 the door, the queue, the tool, the
 * router, the page and the doc. No card.
 */
import fs from "node:fs";
import { videoGraphH3 } from "./workflow.js";
import { overlapFor, extensionFrames, joinClips, probeClip, makeTestClips } from "./clipjoin.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

console.log("\n§1  the arithmetic");
{
  eq("22 frames wished on a 56-frame clip: 22", overlapFor(56, 22), 22);
  eq("40 wished: snaps down to 39", overlapFor(56, 40), 39);
  eq("more than the clip: snaps to the clip's own grid", overlapFor(22, 60), 22);
  eq("under 5 frames: nothing to anchor", overlapFor(4, 22), null);
  eq("3 s at 24 fps: 72 -> 85", extensionFrames(3, 24), 85);
  eq("1 s: 24 -> 34", extensionFrames(1, 24), 34);
  eq("a sliver: at least 17", extensionFrames(0.1, 24), 17);
  const win = overlapFor(56, 22) + extensionFrames(3, 24);
  ok("overlap + extension is a valid clip length (17k+5)", win % 17 === 5, `window ${win}`);
}

console.log("\n§2  the graph");
{
  const cont = { file: "aiplay_cont_abc.mp4", frames: 56, fps: 24, hasAudio: true, overlapFrames: 22, extensionFrames: 85 };
  const build = (o) => videoGraphH3({ prompt: "t", seed: 1, seconds: 4, width: 1344, height: 768, steps: 4, prefix: "p", ...o });
  const g = build({ continueFrom: cont, keepAudio: true });
  eq("the window is overlap + extension frames", g[5].inputs.length, 107);
  eq("the source is loaded from the engine's input folder", g[70]?.inputs?.file, "aiplay_cont_abc.mp4");
  eq("...split into frames and sound", g[71]?.class_type, "GetVideoComponents");
  eq("the tail: the last 22 frames", [g[72].inputs.batch_index, g[72].inputs.length], [34, 22]);
  eq("...and the same stretch of sound", [g[73].inputs.start_index, g[73].inputs.duration], [34 / 24, 22 / 24]);
  eq("anchored at frame 0 as a native guide with its audio", [g[74].class_type, g[74].inputs.frame_idx, g[74].inputs.image, g[74].inputs.audio, g[74].inputs.positive], ["MiniMaxH3AddGuide", 0, ["72", 0], ["73", 0], ["5", 0]]);
  eq("the guider reads the anchored conditioning", g[7].inputs.conditioning, ["74", 0]);
  eq("after the decode the overlap is dropped: frames", [g[75].inputs.batch_index, g[75].inputs.length], [22, 85]);
  eq("...and sound", [g[76].inputs.start_index, g[76].inputs.duration], [22 / 24, 85 / 24]);
  eq("the file is the new frames only", [g[14].inputs.images, g[14].inputs.audio], [["75", 0], ["76", 0]]);
  const silent = build({ continueFrom: { ...cont, hasAudio: false }, keepAudio: false });
  ok("a silent source anchors frames only", !silent[73] && !silent[74].inputs.audio && !silent[76] && !silent[14].inputs.audio);
  const refs = build({ continueFrom: cont, refImages: ["ref.png"], steps: 8 });
  eq("with references: the anchor follows the reference conditioning", refs[74].inputs.positive, ["5", 0]);
  eq("...the guider reads it", refs[7].inputs.conditioning, ["74", 0]);
  eq("...and the tail is dropped there too", refs[14].inputs.images, ["75", 0]);
  const plain = build({});
  ok("without a continuation the graph is untouched", !plain[70] && !plain[74] && !plain[75] && JSON.stringify(plain[14].inputs.images) === JSON.stringify(["12", 0]) && plain[7].inputs.conditioning[0] === "5");
}

console.log("\n§3  the join, through ffmpeg");
{
  let t = null;
  try { t = await makeTestClips({ frames: 24, fps: 24 }); }
  catch (e) { if (e.missing) console.log("  skip  ffmpeg is not on this machine; the join was not run"); else ok("synthetic clips could be made", false, e.message); }
  if (t) {
    try {
      const a = await probeClip(t.a);
      eq("probe: 24 frames at 24 fps with audio", [a.frames, Math.round(a.fps), a.hasAudio, a.width], [24, 24, true, 64]);
      const r = await joinClips(t.a, t.b, t.out);
      ok("the join succeeds and keeps the audio", r.ok === true && r.audio === true, r.error || "");
      const j = await probeClip(t.out);
      eq("...and the result is exactly the sum of the two", [j.frames, j.hasAudio], [48, true]);
      const s = await makeTestClips({ frames: 17, audio: false });
      const r2 = await joinClips(t.a, s.a, s.out);
      ok("a silent partner: joined without audio, nothing thrown", r2.ok === true && r2.audio === false);
      eq("...41 frames", (await probeClip(s.out)).frames, 41);
      await s.cleanup();
    } finally { await t.cleanup(); }
  }
}

console.log("\n§4  the door, the queue, the tool, the router, the page and the doc");
{
  const index = src("./index.js"), art = src("./art.js"), mcp = src("./mcp.js"), router = src("./chat/router.js"),
    html = src("../web/index.html"), app = src("../web/app.js"), api = src("../API.md");
  ok("the door takes action extend and needs H3", /if \(b\.action === "extend"\) \{/.test(index) && /const vr = videoReady\("h3"\);/.test(index));
  ok("...measures the clip and refuses by reason", /reason: "probe"/.test(index) && /reason: "too-short"/.test(index));
  ok("...stages the source under a content name", /aiplay_cont_\$\{createHash\("sha1"\)/.test(index));
  ok("...and queues a video job that continues it", /continueFrom: \{\n\s+file: staged, frames: probe\.frames/.test(index) && /extendedFrom: name,/.test(index));
  ok("the record names the source", /derivedFrom: meta\?\.extendedFrom \? `clips\/\$\{meta\.extendedFrom\}` : null,/.test(index));
  ok("the queue hands the continuation to the graph", /continueFrom: job\.continueFrom \|\| null,/.test(art));
  ok("...joins the result and keeps the new frames beside it", /async function joinContinuation\(job, clip\)/.test(art) && /clip\.replace\(\/\\\.mp4\$\/i, "_new\.mp4"\)/.test(art));
  ok("...never throwing the render away when ffmpeg is absent", /await rename\(kept, fresh\)\.catch\(\(\) => \{\}\);/.test(art));
  ok("...and says so in the clip's record", /extendedFrom: job\.extendedFrom \|\| null,\n\s+continuation: job\.continuation \|\| null,/.test(art));
  ok("extend_clip exists and posts the action", /name: "extend_clip"/.test(mcp) && /action: "extend", clip: safeName\(a\.clip, "clip"\),/.test(mcp));
  // On ITS OWN job id: the queue-wide wait read a stranger's lastError as this render's verdict.
  ok("...waiting like the other clip tools, on its own job", /await waitForArt\(\(Number\(a\.timeout_seconds\) \|\| 900\) \* 1000, "video", r\.job\?\.id\);/.test(mcp));
  ok("the router routes it to the gpu", /extend_clip: "gpu",/.test(router));
  ok("the clip card offers it on video files only", /data-cext="\$\{esc\(c\.name\)\}"/.test(app) && /\/\\\.\(mp4\|webm\)\$\/i\.test\(c\.name\) \? `<button data-cext/.test(app));
  ok("...opening a sheet that carries the clip's own prompt", /\$\("cextPrompt"\)\.value = cextClip\.meta\?\.prompt \|\| "";/.test(app) && /id="cext"/.test(html));
  ok("...and posting the action", /action: "extend", clip: cextClip\.name,/.test(app));
  ok("the API doc describes it", /### `POST \/api\/video` · `\{ "action": "extend" \}`/.test(api) && /extend_clip/.test(api));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
