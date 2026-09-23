/**
 * Replace a section, 2026-09-17.
 *
 * §1 runs edit_audio's `replace` op on synthetic 16-bit audio under the
 * engine's python and checks the arithmetic bit for bit: the result is as
 * long as the original, everything before the first fade and everything from
 * `to` on is the original untouched at the SAME positions, the middle is the
 * new material from its own `from` offset, both seams are blends, a short new
 * take makes the original return early by exactly the deficit (ending still
 * bit-exact) and says so, and a rate mismatch is refused. §2 pins the route
 * (the extend route with a second point), the finish (replaceSection, a mix
 * with no trajectory), the library gate, the tool and its place in the list,
 * the router, the tab and the doc. No card.
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
const serverDir = fileURLToPath(new URL("../", import.meta.url));

const HARNESS = String.raw`
import sys, json, os, subprocess, tempfile
import numpy as np, soundfile as sf
srv = sys.argv[1]; py = sys.executable
sys.path.insert(0, srv)
import edit_audio as ea
sr = 8000; n = int(0.08 * sr)
def take(seconds, seed):
    r = np.random.default_rng(seed)
    return r.integers(-20000, 20000, size=(2, int(seconds * sr))).astype(np.int16)
orig = take(5.0, 1); new = take(4.0, 2)
d = tempfile.mkdtemp()
def wav(name, x, rate=sr):
    p = os.path.join(d, name); sf.write(p, x.T, rate, subtype="PCM_16"); return p
po = wav("orig.wav", orig); pn = wav("new.wav", new); ps = wav("short.wav", new[:, :1 * sr]); p48 = wav("n48.wav", new, 48000)
out = os.path.join(d, "out.flac")
def run(ops):
    return subprocess.run([py, os.path.join(srv, "edit_audio.py"), po, out, json.dumps(ops)], capture_output=True, text=True)
def ints(x): return np.round(x * 32768).astype(np.int32)
O = orig.astype(np.int32); Nw = new.astype(np.int32)
at, to, frm = 2 * sr, int(3.5 * sr), 1 * sr; want = to - at
res = {}
r = run([{"op": "replace", "with": pn, "at": 2.0, "to": 3.5, "from": 1.0, "fade": 0.08}])
res["cli_exit"] = r.returncode; res["cli_err"] = r.stderr.strip()
res["report"] = json.loads(r.stdout)["reports"][0]
o, _ = ea.load(out); oi = ints(o)
res["len_equal"] = int(o.shape[1]) == int(orig.shape[1])
res["head_exact"] = bool(np.array_equal(oi[:, :at - n], O[:, :at - n]))
res["tail_exact_in_place"] = bool(np.array_equal(oi[:, to:], O[:, to:]))
res["middle_is_new_from_offset"] = bool(np.array_equal(oi[:, at:to - n], Nw[:, frm + n:frm + want]))
res["seams_blended"] = (not np.array_equal(oi[:, at - n:at], O[:, at - n:at])) and (not np.array_equal(oi[:, to - n:to], O[:, to - n:to]))
r2 = run([{"op": "replace", "with": ps, "at": 2.0, "to": 3.5, "fade": 0.08}])
o2, _ = ea.load(out); o2i = ints(o2)
deficit = want + n - 1 * sr
res["short_note"] = r2.stderr.strip()
res["short_report"] = json.loads(r2.stdout)["reports"][0]
res["short_deficit_s"] = round(deficit / sr, 2)
res["short_len"] = int(o2.shape[1]) == int(orig.shape[1]) - deficit
k = orig.shape[1] - to
res["short_tail_exact"] = bool(np.array_equal(o2i[:, -k:], O[:, to:]))
res["short_head_exact"] = bool(np.array_equal(o2i[:, :at - n], O[:, :at - n]))
r3 = run([{"op": "replace", "with": p48, "at": 2.0, "to": 3.5}])
res["rate_refused"] = r3.returncode != 0 and "sample-rate mismatch" in (r3.stderr + r3.stdout)
# A native 24-bit original must not become 16-bit because the new take is.
p24 = os.path.join(d, "original24.wav")
v24 = np.random.default_rng(9).integers(-4000000, 4000000, size=(5 * sr, 2), dtype=np.int32) * 256
sf.write(p24, v24, sr, subtype="PCM_24")
out24 = os.path.join(d, "out24.flac")
r24 = subprocess.run([py, os.path.join(srv, "edit_audio.py"), p24, out24, json.dumps([{"op":"replace", "with":pn, "at":2, "to":3.5}])], capture_output=True, text=True)
a24, _ = sf.read(out24, dtype="int32", always_2d=True)
res["keeps_24bit"] = r24.returncode == 0 and sf.info(out24).subtype == "PCM_24" and bool(np.array_equal(a24[:at-n], v24[:at-n])) and bool(np.array_equal(a24[to:], v24[to:]))
empty = os.path.join(d, "empty.flac")
re = subprocess.run([py, os.path.join(srv, "edit_audio.py"), po, empty, json.dumps([{"op":"replace", "with":ps, "at":2, "to":3.5, "from":2}])], capture_output=True, text=True)
res["empty_refused"] = re.returncode != 0 and not os.path.exists(empty)
print(json.dumps(res))
`;

console.log("\n§1  the op, bit for bit, under the engine's python");
{
  const python = config?.python || "";
  if (python && fs.existsSync(python)) {
    const r = spawnSync(python, ["-c", HARNESS, serverDir], { encoding: "utf8", timeout: 120_000 });
    let res = null;
    try { res = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch { /* reported below */ }
    ok("the harness ran", r.status === 0 && !!res, (r.stderr || r.stdout || "").trim().slice(-600));
    if (res) {
      ok("the CLI exits 0 with the full-length material and says nothing", res.cli_exit === 0 && res.cli_err === "", `exit ${res.cli_exit}: ${res.cli_err}`);
      ok("the result is exactly as long as the original", res.len_equal === true);
      ok("everything before the first fade is the original, bit-exact", res.head_exact === true);
      ok("everything from `to` on is the original, bit-exact, at the same positions", res.tail_exact_in_place === true);
      ok("the middle is the new material from its own `from` offset, bit-exact", res.middle_is_new_from_offset === true);
      ok("both seams are blends, not cuts", res.seams_blended === true);
      ok("a short take: the original returns early by exactly the deficit", res.short_len === true && res.short_deficit_s === 0.58, `deficit ${res.short_deficit_s}`);
      ok("...with the ending still bit-exact and the head untouched", res.short_tail_exact === true && res.short_head_exact === true);
      ok("...and stderr says by how much", /replace: the new material is 0\.58 s short of the gap; the original returns early/.test(res.short_note), res.short_note);
      ok("a sample-rate mismatch is refused", res.rate_refused === true);
      ok("the full candidate carries exact measured seam and duration metadata", res.report?.seconds === 5 && res.report?.effectiveTo === 3.5 && res.report?.shortfallSeconds === 0);
      ok("a short candidate reports the real earlier seam, not the requested time", res.short_report?.shortfallSeconds === 0.58 && res.short_report?.effectiveTo === 2.92 && res.short_report?.seconds === 4.42);
      ok("a 16-bit replacement preserves the untouched 24-bit original samples", res.keeps_24bit === true);
      ok("an empty continuation is refused without publishing a candidate", res.empty_refused === true);
    }
  } else {
    console.log("  skip  the engine's python is not on this machine; the op was not run");
  }
}

console.log("\n§2  the editor, the library, the route and the finish");
{
  const editor = src("../edit_audio.py"), lib = src("../library.js"), index = src("../index.js");
  ok("edit_audio has the replace op", /if kind == "replace":/.test(editor));
  ok("...takes the gap plus one fade from the new material's own offset", /seg = other\[:, min\(frm, other\.shape\[1\]\):min\(frm \+ want \+ n, other\.shape\[1\]\)\]/.test(editor));
  ok("...and fades the original back in before `to` so it keeps its place", /result = _xfade\(head, data\[:, max\(0, to - n\):\], n\)/.test(editor));
  ok("the library lists replace_* files", /const PREFIXES = \[[^\]]*"replace"[^\]]*\];/.test(lib));
  ok("...has replaceSection with a from offset and structured report", /async replaceSection\(originalFile, newFile, atSeconds, toSeconds, \{ from = 0, report = false \} = \{\}\)/.test(lib) && /const out = `replace_\$\{Date\.now\(\)\}_\$\{randomUUID\(\)\.slice\(0, 8\)\}\.flac`;/.test(lib));
  ok("...and whitelists replacedTo on the sidecar", /replacedTo: m\.replacedTo \?\? null,/.test(lib));
  ok("/api/replace is the extend route with a second point", /if \(\(p === "\/api\/extend" \|\| p === "\/api\/replace"\) && req\.method === "POST"\)/.test(index));
  ok("...refusing a bad range by reason", /reason: "replace-range"/.test(index));
  ok("...asking each engine for the gap plus a little", /Math\.round\(replaceTo - fromSec\) \+ 8, 8\), 300\)/.test(index) && /Math\.round\(replaceTo - fromSec\) \+ 3, 5\), 180\)/.test(index));
  ok("...and carrying replaceTo on both engines' jobs", (index.match(/^\s+replaceTo,\n/gm) || []).length === 2);
  const finish = index.slice(index.indexOf("if (Number.isFinite(job.replaceTo))"), index.indexOf("const joined = await library.joinExtension"));
  const auditions = src("./auditions.js"), composed = auditions.slice(auditions.indexOf("library.remember(composed.file"), auditions.indexOf("await append({ actor: job.actor, type: \"edit\""));
  ok("the finish calls the tested compositor with library, provenance and persistent results", /await finishReplacement\(\{ job, receipt: h, library, store: auditions, modelName,/.test(finish) && /hashFile: file => audioHash/.test(finish));
  ok("...remembers requested and effective seams, and files the mix without replay metadata",
    /replacedTo: job\.replaceTo/.test(composed) && /effectiveReplacedTo: composed\.effectiveTo/.test(composed) && !/\bcodes:/.test(composed) && !/\byueDir:/.test(composed) && /return;\n\s+\}\n\s*$/.test(finish));
  ok("...keeping the new render when the stitch fails", /replace failed; the new render is kept as/.test(finish));
}

console.log("\n§3  the tool, the router, the tab and the doc");
{
  const mcp = src("../mcp.js"), router = src("../chat/router.js"), html = src("../../web/index.html"), app = src("../../web/app.js"), api = src("../../API.md");
  const iTool = mcp.indexOf('name: "replace_section"'), iBeats = mcp.indexOf('name: "get_beats"'), iDoc = mcp.indexOf('name: "image_document"');
  ok("replace_section exists, after get_beats and before image_document (the slice-and-eval lanes)", iTool > iBeats && iBeats > 0 && iTool < iDoc);
  ok("...requires file, from_seconds and to_seconds", /required: \["file", "from_seconds", "to_seconds"\]/.test(mcp));
  ok("...posts to /api/replace with toSeconds", /await api\("POST", "\/api\/replace", \{/.test(mcp) && /fromSeconds: a\.from_seconds, toSeconds: a\.to_seconds,/.test(mcp));
  ok("...and says what actually comes back", /wait_for_song waits for composition and returns the actual candidate filename/.test(mcp) && /short take moves the ending earlier/.test(mcp));
  ok("the router routes it to the gpu", /replace_section: "gpu",/.test(router));
  ok("the extend panel has the \"Keep the ending from\" field", /id="xtTo"/.test(html) && /Keep the ending from/.test(html));
  ok("...set by the mode whenever the panel opens", /async function startExtend\(file, mode = "extend"\)/.test(app) && /setXtMode\(mode\);/.test(app));
  ok("...and a time there turns the extension into a replacement", /fetch\(replacing \? "\/api\/replace" : "\/api\/extend", \{/.test(app) && /\.\.\.\(replacing \? \{ toSeconds: toSec \} : \{\}\),/.test(app));
  ok("...refusing a time before the extend point on the page", /must be a time past the extend point/.test(app));
  ok("the API doc describes /api/replace", /### `POST \/api\/replace`/.test(api) && /replace-range/.test(api) && /replace_section/.test(api));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
