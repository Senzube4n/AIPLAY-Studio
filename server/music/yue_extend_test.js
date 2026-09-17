/**
 * Extending a YuE2 take, 2026-09-17.
 *
 * MiniMax extends by replaying a saved trajectory into the KV cache. YuE2's
 * sampler takes a flat token list as its prefix and never inspects it, so the
 * plan's prefix followed by the take's own semantic tokens, offset back into
 * the codec range, is the same replay with no package patch — and every run
 * folder already holds those tokens. What is pinned here is the wiring, not
 * the model: the driver's branch and its arguments, the door's source check
 * and argv, the job pump's explicit list, the route's engine branch and its
 * refusals, the tail-only join, the sidecar and its whitelist, the page's
 * gate, the MCP tool and its routing entry, and the API doc. The driver is
 * byte-compiled when the YuE2 python is on this machine. No GPU.
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { config } from "../config.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

console.log("\n§1  the driver: a replay branch, and what it replays");
{
  const py = src("./yue_driver.py");
  ok("TOKENS_PER_SECOND is 25, the measured ratio", /^TOKENS_PER_SECOND = 25$/m.test(py));
  ok("--extend-from and --from-seconds are arguments",
    /add_argument\("--extend-from", default=None,/.test(py) && /add_argument\("--from-seconds", type=float, default=0\.0,/.test(py));
  ok("the branch runs _extend instead of the pipeline call",
    /if args\.extend_from:\n\s+result, extended = _extend\(pipe, args, request, semantic_sampling, effective, vram\)/.test(py));
  ok("the replay is the plan's prefix followed by the kept tokens, offset into the codec range",
    /prefix = list\(plan\.prefix\) \+ \[t \+ CODEC_OFFSET for t in old\]/.test(py));
  ok("...and the kept count comes from seconds at that ratio",
    /int\(round\(args\.from_seconds \* TOKENS_PER_SECOND\)\)/.test(py));
  ok("the old plan is restored hash-checked, not re-read", /old_plan = SymbolicPlan\.load\(old_dir\)/.test(py));
  ok("the take's own score is reused unless a longer one arrives",
    /if fields\.get\("abc"\) is None and old_plan\.abc is not None and fields\.get\("cot"\) != "off":\n\s+fields\["abc"\] = old_plan\.abc/.test(py));
  ok("the sampler is given only the room the prefix leaves", /room = int\(CONTEXT\) - len\(prefix\) - 8/.test(py));
  ok("guidance above 1 extends the negative branch with the same tokens",
    /negative = list\(negative_prefix\(new_request, pipe\.tokenizer, plan\.abc_ids\)\) \+ \[t \+ CODEC_OFFSET for t in old\]/.test(py));
  ok("new tokens are appended to the kept ones before the NAR", /codec = old \+ \[int\(t\) - CODEC_OFFSET for t in ids\]/.test(py));
  ok("the receipt says where the take came from and how much was kept",
    /"extended": extended,/.test(py) && /"keptTokens": keep, "ofTokens": total, "newTokens": len\(ids\)/.test(py));
  ok("a missing artifact in the source folder is a refusal, by name",
    /raise Refused\("--extend-from %s has no %s;/.test(py));
  const python = config?.yue?.python || "D:\\AI\\aiplay-studio-bench\\venv-yue\\Scripts\\python.exe";
  if (fs.existsSync(python)) {
    const r = spawnSync(python, ["-m", "py_compile", new URL("./yue_driver.py", import.meta.url).pathname.slice(1)], { encoding: "utf8" });
    ok("the driver byte-compiles under the YuE2 python", r.status === 0, (r.stderr || r.stdout || "").trim().slice(0, 300));
  } else {
    console.log("  skip  the YuE2 python is not on this machine; the driver was not byte-compiled");
  }
}

console.log("\n§2  the door and the job pump name the source");
{
  const yue = src("./yue.js"), jobs = src("../jobs.js");
  ok("renderSong takes extendFrom and fromSeconds", /extendFrom = null, fromSeconds = 0,/.test(yue));
  ok("...checks the five artifacts before the ledger row and the python",
    /for \(const n of \["result\.json", "semantic\.npy", "plan\.json", "plan_manifest\.json", "prefix\.npy"\]\)/.test(yue)
    && /new YueRefusal\("extend-source",/.test(yue));
  ok("...hands both to the driver", /\["--extend-from", args\.extendFrom, "--from-seconds", String\(args\.fromSeconds\)\]/.test(yue));
  ok("...and returns the receipt's extension block", /extended: answer\?\.driver\?\.extended \?\? null,/.test(yue));
  ok("the job pump passes both — the explicit list the audio reference fell through",
    /extendFrom: job\.extendFrom \|\| null,\n\s+fromSeconds: job\.fromSeconds \|\| 0,/.test(jobs));
  ok("...and keeps the receipt on the job", /extended: r\.extended \?\? null \};/.test(jobs));
}

console.log("\n§3  the route, the join and the sidecar");
{
  const index = src("../index.js"), lib = src("../library.js");
  ok("the extend route finds a YuE2 take by its sidecar or its file name",
    /const yueDir = meta\?\.yueDir \|\| \(yueMatch \? path\.join\(config\.outputDir, "yue2", yueMatch\[1\]\) : null\);/.test(index));
  ok("...refuses a take whose run folder is gone, by reason", /reason: "run-missing"/.test(index));
  ok("...refuses bracketed section labels, by reason", /reason: "lyrics" \}\);/.test(index));
  ok("...enqueues a yue2 job carrying the run folder and the seam",
    /extendFrom: yueDir, fromSeconds: fromSec, extendedFrom: file,/.test(index));
  ok("...answers with the engine", /resumedFromSeconds: Math\.round\(fromSec\) \}\);/.test(index) && /engine: "yue2", resumedFromSeconds/.test(index));
  ok("the join takes only the new render's tail for YuE2",
    /const joined = await library\.joinExtension\(job\.extendedFrom, h\.file, at, \{ from: isYueExt \? at : 0 \}\);/.test(index));
  ok("...and does not try to splice a MiniMax trajectory for it", /const priorCodes = isYueExt \? null :/.test(index));
  ok("...and the joined file keeps its run folder", /engine: "yue2", yueDir: job\.yue\?\.dir \?\? null,/.test(index));
  ok("a YuE2 song's sidecar records its run folder", /yueDir: job\.yue\?\.dir \?\? null,\n/.test(index));
  ok("joinExtension takes `from` and only emits it when set",
    /async joinExtension\(originalFile, extensionFile, atSeconds, \{ from = 0 \} = \{\}\)/.test(lib) && /\.\.\.\(from > 0 \? \{ from \} : \{\}\),/.test(lib));
  ok("the library whitelist surfaces yueDir", /yueDir: m\.yueDir \|\| null,/.test(lib));
  const editor = src("../edit_audio.py");
  ok("edit_audio's join honours `from`", /frm = int\(max\(0\.0, float\(op\.get\("from", 0\.0\)\)\) \* sr\)/.test(editor));
}

console.log("\n§4  the page, the MCP tool and the doc");
{
  const app = src("../../web/app.js"), mcp = src("../mcp.js"), router = src("../chat/router.js"), api = src("../../API.md");
  ok("the page offers Extend on a YuE2 take", /\$\("spExtendSec"\)\.hidden = !\(\(t\?\.codes \|\| t\?\.yueDir\) && t\?\.durationSeconds\);/.test(app));
  ok("...and lets it start", /if \(!t\.codes && !t\.yueDir\) \{/.test(app));
  ok("...sending a longer score when Advanced Options holds one", /abc: \$\("yAbcUse"\)\?\.checked \? \(\$\("yAbc"\)\?\.value\.trim\(\) \|\| undefined\) : undefined,/.test(app));
  ok("extend_song exists, requires file, and forwards every declared parameter",
    /name: "extend_song",/.test(mcp) && /required: \["file"\],/.test(mcp)
    && /fromSeconds: Number\.isFinite\(a\.from_seconds\)/.test(mcp) && /abc: typeof a\.abc === "string"/.test(mcp));
  ok("...and says what the caller gets back", /extend_<ms>\.flac appears in/.test(mcp));
  ok("the chat router knows it holds the card", /extend_song: "gpu",/.test(router));
  ok("the API doc describes the YuE2 path", /\*\*YuE2 takes\*\* \(`aiplay_yue2_<id>\.flac`\) extend too\./.test(api));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
