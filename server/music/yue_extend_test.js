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
import { fileURLToPath } from "node:url";
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
    /if args\.extend_from or getattr\(args, "extend_codes", None\):\n\s+result, extended = _extend\(pipe, args, request, semantic_sampling, effective, vram\)/.test(py));
  ok("the replay is the plan's prefix followed by the kept tokens, offset into the codec range",
    /prefix = list\(plan\.prefix\) \+ \[t \+ CODEC_OFFSET for t in old\]/.test(py));
  ok("...and the kept count comes from seconds at that ratio",
    /int\(round\(args\.from_seconds \* TOKENS_PER_SECOND\)\)/.test(py));
  ok("the old plan is restored hash-checked, not re-read", /old_plan = SymbolicPlan\.load\(old_dir\)/.test(py));
  ok("the take's own score is reused unless a longer one arrives",
    /if old_plan and fields\.get\("abc"\) is None and old_plan\.abc is not None and fields\.get\("cot"\) != "off":\n\s+fields\["abc"\] = old_plan\.abc/.test(py));
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
    const r = spawnSync(python, ["-m", "py_compile", fileURLToPath(new URL("./yue_driver.py", import.meta.url))], { encoding: "utf8" });
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
    /extendFrom: job\.extendFrom \|\| null,\n\s+extendCodes: job\.extendCodes \|\| null,\n\s+fromSeconds: job\.fromSeconds \|\| 0,/.test(jobs));
  ok("...and keeps the receipt on the job", /extended: r\.extended \?\? null\s*[,}]/.test(jobs));
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
  ok("the page offers Extend on a YuE2 take", /\$\("spExtendSec"\)\.hidden = !\(\(t\?\.codes \|\| t\?\.yueDir \|\| state\.tokenizerReady\) && t\?\.durationSeconds\);/.test(app));
  ok("...and lets it start", /if \(!t\.codes && !t\.yueDir && !state\.tokenizerReady\) \{/.test(app));
  ok("...sending a longer score when Melody & score holds one", /abc: \$\("yAbcUse"\)\?\.checked \? \(\$\("yAbc"\)\?\.value\.trim\(\) \|\| undefined\) : undefined,/.test(app));
  ok("extend_song exists, requires file, and forwards every declared parameter",
    /name: "extend_song",/.test(mcp) && /required: \["file"\],/.test(mcp)
    && /fromSeconds: Number\.isFinite\(a\.from_seconds\)/.test(mcp) && /abc: typeof a\.abc === "string"/.test(mcp));
  ok("...and says what the caller gets back", /extend_<ms>\.flac appears in/.test(mcp));
  ok("the chat router knows it holds the card", /extend_song: "gpu",/.test(router));
  ok("the API doc describes the YuE2 path", /\*\*YuE2 takes\*\* \(`aiplay_yue2_<id>\.flac`\) extend too\./.test(api));
}

console.log("\n§  a recording, through the real-audio tokenizer (2026-09-20)");
{
  /* Any track with no trajectory and no run folder: read into YuE2's own
   * codes by the catalogued tokenizer (head over MERT-v2-FullSong), then
   * replayed by the same branch with no plan and no receipt. Pinned: the
   * driver's codes-only path, the door's second source and its argv, the pump,
   * the route's branch and its refusals, the status field, the tool's words,
   * the page's gate and the tokenizer module's contract. No GPU, no weights. */
  const py = src("./yue_driver.py"), door = src("./yue.js"), jobs = src("../jobs.js"), index = src("../index.js");
  const mcp = src("../mcp.js"), app = src("../../web/app.js"), tok = src("./tokenize.js"), script = src("./yue_tokenize.py");
  ok("--extend-codes is an argument, replayed like a take with no plan and no receipt",
    /ap\.add_argument\("--extend-codes", default=None,/.test(py)
    && /codes_only = bool\(getattr\(args, "extend_codes", None\)\)/.test(py)
    && /needed = \("semantic\.npy",\) if codes_only else \("result\.json", "semantic\.npy", "plan\.json", "plan_manifest\.json", "prefix\.npy"\)/.test(py)
    && /old_receipt, old_plan = \{\}, None/.test(py));
  ok("...with cot off unless a score is handed in, and the receipt saying so",
    /if codes_only and fields\.get\("abc"\) is None:\n\s+fields\["cot"\] = "off"/.test(py) && /"codesOnly": codes_only/.test(py));
  ok("the door takes extendCodes, refuses two sources and a folder without codes, and passes --extend-codes",
    /extendCodes = null,/.test(door)
    && /extendFrom and extendCodes are two sources; name one\./.test(door)
    && /has no semantic\.npy, so no recording was tokenized there/.test(door)
    && /\["--extend-codes", args\.extendCodes, "--from-seconds", String\(args\.fromSeconds\)\]/.test(door));
  ok("the pump names it", /extendCodes: job\.extendCodes \|\| null,/.test(jobs));
  ok("the route's branch: tokenizer on disk, the YuE2 Python engine chosen, a style given, brackets refused",
    /if \(meta && !meta\.codes\) \{/.test(index)
    && /reason: "tokenizer-missing", missing: tok\.missing,/.test(index)
    && /Continuing a recording needs the YuE2 Python engine/.test(index)
    && /reason: "caption"/.test(index));
  ok("...tokenizes on the CPU while the card has a render in flight, then enqueues with extendCodes and the seam",
    /device: busy \? "cpu" : null/.test(index)
    && /extendCodes: tok2\.dir, fromSeconds: fromSec, extendedFrom: file,/.test(index)
    && /cot: abc \? \(\["full", "melody"\]\.includes\(b\.cot\) \? b\.cot : "melody"\) : "off",/.test(index));
  ok("the status reports the tokenizer, and the page reads it", /tokenizer: await tokenizerStatus\(\),/.test(index)
    && /state\.tokenizerReady = !!s\.config\?\.tokenizer\?\.ready;/.test(app));
  ok("the page offers Extend on any track once the tokenizer is here, and says what a recording gets",
    /\(t\.codes \|\| t\.yueDir \|\| state\.tokenizerReady\) && t\.durationSeconds/.test(app)
    && /A recording: it is read into YuE2's own codes first/.test(app));
  ok("extend_song says so, and what is required", /ANY OTHER RECORDING/.test(mcp) && /`caption` is REQUIRED there/.test(mcp));
  ok("the tokenizer stands on its own: POST /api/tokenize, tokenize_track, and studio_status's music.tokenizer",
    /if \(p === "\/api\/tokenize" && req\.method === "POST"\) \{/.test(index)
    && /const device = b\.device === "cpu" \? "cpu" : \(busy \? "cpu" : null\);/.test(index)
    && /name: "tokenize_track",/.test(mcp) && /api\("POST", "\/api\/tokenize", \{/.test(mcp)
    && /tokenizer: st\.config\?\.tokenizer/.test(mcp)
    && /### `POST \/api\/tokenize`/.test(src("../../API.md")));
  ok("the page says a recording is being read before the job exists",
    /Reading the recording into YuE2's codes/.test(app));
  ok("tokenize.js reads the catalogue row for what must be on disk, keys the codes by the file's bytes, and runs the script",
    /export const TOKENIZER_ID = "musicYue2Tokenizer";/.test(tok)
    && /tok_\$\{sha\.slice\(0, 12\)\}/.test(tok)
    && /"--audio", source, "--out", codesFile, "--mert", st\.mert, "--head", st\.head,/.test(tok));
  ok("the script is the published recipe: MERT-v2-FullSong layer 20 at 25 Hz, instance-normalised, the 8-layer head, half-stride windows",
    /MERT_LAYER = 20/.test(script) && /FRAMES_PER_SECOND = 25/.test(script) && /norm_first=True, activation="gelu"/.test(script)
    && /WIN \/\/ 2/.test(script) && /int32/.test(script));
}

console.log("\n§  covering a real song: a Create, never a splice (2026-09-20)");
{
  /* The score says what the song is; the first seconds of its tokenized
   * performance say how it sounded; the caption says how it should sound now.
   * The one thing that must never happen is the continuation's finish: it
   * keeps the source's own samples up to the seam, which for a cover would
   * ship the original recording inside the result. That is why the lineage
   * rides in `coverOf` and never in `extendedFrom`. */
  const index = src("../index.js"), mcp = src("../mcp.js"), app = src("../../web/app.js");
  const html = src("../../web/index.html"), api = src("../../API.md"), lib = src("../library.js");
  ok("the cover lives on /api/generate's yue2 branch, not on the extend door",
    /if \(body\.coverOf && typeof body\.coverOf === "object"\) \{/.test(index));
  ok("...and carries its lineage in coverOf, which nothing splices on",
    /coverOf: coverFile,/.test(index)
    && /\.\.\.\(job\.coverOf \? \{ coverOf: job\.coverOf, coverSeconds: job\.fromSeconds \|\| null, tokenized: job\.tokenized \|\| null \} : \{\}\)/.test(index));
  ok("...the splice still fires on extendedFrom alone, so a cover cannot reach it",
    /if \(job\.extendedFrom\) \{/.test(index) && !/extendedFrom: coverFile/.test(index));
  ok("every refusal that costs nothing is named",
    ["cover-source", "cover-score", "cover-open-score", "cover-words", "cover-seconds", "tokenizer-missing"]
      .every((r) => new RegExp(`reason: "${r}"`).test(index)));
  ok("...including the one that would render an instrumental by accident",
    /if \(!body\.instrumental && !\(body\.lyrics \|\| ""\)\.trim\(\)\) \{/.test(index));
  ok("the prime defaults to eight seconds and is capped at thirty or the track",
    /const askedSecs = body\.coverOf\.seconds === undefined \? 8 : Number\(body\.coverOf\.seconds\);/.test(index)
    && /const ceiling = Math\.min\(30, Math\.max\(1, Math\.floor\(dur \? dur - 1 : 30\)\)\);/.test(index));
  ok("...and the reason it is short is written where the number is, with the measurement",
    /0\.43[\u2013-]0\.53/.test(index) && /0\.68[\u2013-]0\.73/.test(index) && /to 8 frames/.test(index));
  ok("the render is sized on prime plus new, not on new alone",
    /wantSeconds: \(want \|\| 180\) \+ coverSeconds,/.test(index)
    && /maxTokens: maxTokensFor\(\(want \|\| 180\) \+ coverSeconds\),/.test(index)
    && /coverFit = fit\(\(want \|\| 180\) \+ coverSeconds, \{ capability \}\)/.test(index));
  ok("the whole track is read while the card is busy, on the processor",
    /device: busy \? "cpu" : null/.test(index));
  ok("the answer says what was read", /cover: \{ file: coverFile, seconds: coverSeconds, tokenized: coverTokenized \}/.test(index));
  ok("the library row carries what a take is a cover of", /coverOf: m\.coverOf \|\| null,/.test(lib));
  ok("make_song takes cover_of and cover_seconds and forwards them as one object",
    /cover_of: \{ type: "string", description: "COVER A REAL SONG/.test(mcp)
    && /coverOf: \{ file: safeName\(a\.cover_of, "song"\),\n\s+\.\.\.\(Number\.isFinite\(a\.cover_seconds\) \? \{ seconds: a\.cover_seconds \} : \{\}\),\n\s+\.\.\.\(typeof a\.cover_stem === "string" \? \{ stem: a\.cover_stem \} : \{\}\) \}/.test(mcp));
  ok("the page has the one new control, where the cover flow already lived",
    /<input id="covPrime" type="range" min="0" max="30" step="1" value="8">/.test(html)
    && /out\.coverOf = \{ file: covFile, seconds: covSecs, \.\.\.\(covStem \? \{ stem: covStem \} : \{\}\) \}/.test(app));
  ok("...it says off rather than vanishing when the tokenizer is not installed",
    /prime\.disabled = !state\.tokenizerReady;/.test(app));
  ok("the API doc names the door, the default, and whose rights they are",
    /### Covering a real song/.test(api) && /"coverOf": \{ "file": "<library file>", "seconds": 8 \}/.test(api)
    && /rights in the song you cover are yours to clear/.test(api));
}

console.log("\n§  one layer, any recording, and what sounds like what (2026-09-20)");
{
  const index = src("../index.js"), mcp = src("../mcp.js"), app = src("../../web/app.js");
  const html = src("../../web/index.html"), api = src("../../API.md"), sim = src("./similar.js"), tok = src("./tokenize.js");

  /* ONE LAYER. Reading the drums alone gives a groove; reading the voice alone
   * gives a phrasing. The cache is keyed on the DECODED audio, so a stem lands
   * in its own entry without anything being told about stems. */
  ok("a stem may be read instead of the mix, on all three doors",
    /if \(b\.stem\) \{/.test(index) && /if \(body\.coverOf\.stem\) \{/.test(index)
    && (index.match(/ensureStem\(/g) || []).length >= 3);
  ok("...refused by name when it is not one demucs writes",
    /reason: "stem" \}/.test(index) && /reason: "stem-failed" \}/.test(index));
  ok("...and declared on every tool that takes a recording",
    /stem: \{ type: "string", enum: \["vocals", "drums", "bass", "other"\]/.test(mcp)
    && /cover_stem: \{ type: "string", enum: \["vocals", "drums", "bass", "other"\]/.test(mcp));
  ok("...with a page control on both surfaces",
    /<select id="covStem" class="sel2">/.test(html) && /<select id="spStem" class="sel2">/.test(html)
    && /stem: \$\("spStem"\)\?\.value \|\| undefined,/.test(app));

  /* ANY RECORDING may have a stretch replaced, not only a take: the branch that
   * used to exclude a replace now carries replaceTo through to the job, and the
   * length asked for is the gap rather than a continuation's default. */
  ok("replace reaches the tokenizer branch",
    /if \(meta && !meta\.codes\) \{/.test(index)
    && /\.\.\.\(Number\.isFinite\(replaceTo\) \? \{ replaceTo \} : \{\}\),/.test(index));
  ok("...and asks for the gap, not for forty-five seconds",
    /const extra = Number\.isFinite\(replaceTo\)\n\s+\? Math\.min\(Math\.max\(Math\.round\(replaceTo - fromSec\) \+ 8, 8\), 300\)/.test(index));
  ok("...the take says which it was", /\$\{Number\.isFinite\(replaceTo\) \? "replaced" : "continued"\}/.test(index));
  ok("...and replace_section says a recording qualifies", /ANY RECORDING too, not only a/.test(mcp));

  /* SOUNDS LIKE. Plain code over files the renders already wrote. */
  ok("the signature is a weighted, normalised histogram compared by cosine",
    /const w = 1 \+ Math\.log\(n\)/.test(sim) && /export function cosine/.test(sim));
  ok("...it reads our own writers' .npy and refuses anything else by name",
    /export function readCodesNpy/.test(sim) && /expected a 1-D array of codes/.test(sim)
    && /unsupported dtype \$\{descr\}/.test(sim));
  ok("...it never scores a track against itself", /never itself/.test(sim));
  ok("...and it says out loud what it does not measure",
    /NOT "is\n \* this the same tune"|the same kind of sound/.test(sim));
  ok("a track's codes are found without rendering anything, take or recording",
    /export async function codesDirFor/.test(tok) && /kind: "take"/.test(tok) && /kind: "recording"/.test(tok));
  ok("the route reads them, or reads the recording first unless told not to",
    /if \(p === "\/api\/sounds_like" && req\.method === "POST"\) \{/.test(index)
    && /reason: "not-read"/.test(index));
  ok("the tool and the page both reach it",
    /name: "sounds_like",/.test(mcp) && /api\("POST", "\/api\/sounds_like", \{/.test(mcp)
    && /id="spSounds"/.test(html) && /soundsLikeCurrent/.test(app));
  ok("the API doc names it and its caveat",
    /### `POST \/api\/sounds_like`/.test(api) && /not "the same tune/.test(api));
}

console.log("\n§  an imported clip leaves a record (2026-09-20)");
{
  /* A generated take leaves a `generate` naming the model. An imported one left
   * `runs` — a capped activity list inside the document — and nothing in the
   * ledger, so a scene could carry footage the compliance layer had never heard
   * of. Found while designing peer-to-peer rendering, where that hole would
   * have laundered a lender's model and its licence off the file. */
  const mv = src("../mv/routes.js");
  ok("import_clip writes an `import` event beside its note",
    /noteRun\(doc, \{ tool: "import_clip"/.test(mv)
    && /await planEvent\(slug, \{\n\s+actor: actorOf\(req\),\n\s+type: "import",/.test(mv));
  ok("...naming the clip and the scene it became a take on",
    /clip: name, segmentId: b\.segmentId, picked: pick,/.test(mv));
  ok("...and claiming no model, out loud rather than by omission",
    /model: null, note: "a clip that already existed became a take; no model is claimed"/.test(mv));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
