/**
 * Steering, 2026-09-17: the simple way on the page, and the last MCP gaps.
 *
 * §1 the Video screen's quality chips are the step slider in three words —
 * Fast reads the server's turbo3Ready (3 there, 8 elsewhere), the row hides
 * with the slider on LTX, and the status actually carries the flag. §2
 * make_song declares and forwards every dial the door range-checks. §3
 * set_image_engine and download_model exist, post the right doors, send the
 * territory acknowledgement only when it is true, and are withheld from the
 * in-app chat by sentence. No card.
 */
import fs from "node:fs";
import { TOOLS } from "./mcp.js";
import { ROUTABLE, WITHHELD } from "./chat/router.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tool = (name) => TOOLS.find((t) => t.name === name);

console.log("\n§1  the simple way on the Video screen");
{
  const html = src("../web/index.html"), app = src("../web/app.js"), index = src("./index.js");
  ok("three chips above More controls", /id="vidQualityRow"[\s\S]*?data-vq="fast"[\s\S]*?data-vq="standard"[\s\S]*?data-vq="best"[\s\S]*?id="vidAdv"/.test(html));
  ok("Fast is 3 where the TaoMate build is on disk, 8 elsewhere", /const fastSteps = eng\.turbo3Ready \? 3 : 8;/.test(app) && /b\.dataset\.vq === "fast" \? \(eng\.turbo3Ready \? 3 : 8\) : b\.dataset\.vq === "standard" \? 8 : 20/.test(app));
  ok("...a click sets the slider and repaints", /\$\("vidSteps"\)\.value = String\(steps\);\n\s+vidPaint\(\);/.test(app));
  ok("...the chips light up on the slider's value", /aria-pressed", stNow === want \? "true" : "false"/.test(app));
  ok("...and the row hides with the slider on LTX", /qRow\.hidden = cur === "ltx";/.test(app));
  ok("the status carries turbo3Ready per engine", /turbo3Ready: \/taomate\/i\.test\(String\(e\.turboLora3 \|\| ""\)\),/.test(index));
}

console.log("\n§2  make_song forwards every dial the door takes");
{
  const t = tool("make_song");
  const props = Object.keys(t?.inputSchema?.properties || {});
  for (const p of ["key", "bpm", "meter", "temperature", "top_p", "top_k", "repetition_penalty", "plan_temperature", "plan_top_p", "lora", "lora_strength", "abc", "abc_open"]) {
    ok(`make_song declares ${p}`, props.includes(p));
  }
  const run = String(t?.run || "");
  ok("...and forwards the three that were missing under the door's names",
    /topK: Number\.isFinite\(a\.top_k\) \? a\.top_k : undefined,/.test(run) && /repetitionPenalty: Number\.isFinite\(a\.repetition_penalty\) \? a\.repetition_penalty : undefined,/.test(run) && /planTopP: Number\.isFinite\(a\.plan_top_p\) \? a\.plan_top_p : undefined,/.test(run));
  const index = src("./index.js");
  ok("...which the door range-checks", /top_k: dial\(body\.topK, 1, 32768, true\), repetition_penalty: dial\(body\.repetitionPenalty, 0\.01, 10\)/.test(index) && /top_p: dial\(body\.planTopP, 0\.01, 1\)/.test(index));
}

console.log("\n§3  the two tools that were missing");
{
  const sie = tool("set_image_engine"), dm = tool("download_model");
  ok("set_image_engine exists and offers every image engine, krea2 included",
    JSON.stringify(sie?.inputSchema?.properties?.engine?.enum) === JSON.stringify(["qwen-image-2.1", "flux2", "zimage", "zimage-base", "anima", "ideogram4", "krea2", "checkpoint"]));
  ok("...posting the Images page's own door", /api\("POST", "\/api\/artconfig", \{ engine: a\.engine/.test(String(sie?.run || "")));
  ok("...and naming the licences that matter", /NON-COMMERCIAL/.test(sie?.description || "") && /USD 1M/.test(sie?.description || ""));
  ok("download_model exists and posts the catalogue door", /api\("POST", "\/api\/models", \{\s+action: "download", id: String\(a\.id \|\| ""\),/.test(String(dm?.run || "")));
  ok("...sending the territory acknowledgement only when it is true", /\.\.\.\(a\.accept_region === true \? \{ acceptRegion: true \} : \{\}\),/.test(String(dm?.run || "")));
  ok("...and saying never to assume it", /never assume it/i.test(dm?.description || "") && /Never assumed/.test(dm?.inputSchema?.properties?.accept_region?.description || ""));
  ok("both are withheld from the in-app chat by sentence, like set_video_engine",
    typeof WITHHELD?.set_image_engine === "string" && /Images page/.test(WITHHELD.set_image_engine)
    && typeof WITHHELD?.download_model === "string" && /Models page/.test(WITHHELD.download_model)
    && !(("set_image_engine" in (ROUTABLE || {})) || ("download_model" in (ROUTABLE || {}))));
  const api = src("../API.md");
  ok("the API doc has the steering section", /### Steering the defaults from an agent/.test(api) && /download_model/.test(api) && /Fast \/ Standard \/ Best/.test(api));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
