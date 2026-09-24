/**
 * Extend and Replace on the page, and the GGUF card, 2026-09-17.
 *
 * §1 the panel has a mode switch, a second handle and a right-hand KEEP; the
 * paint places both handles; a drag takes the nearer handle in Replace mode
 * and the two never cross; the Create button says which job; the fields are
 * "Extend from" / "Replace … – …". §2 the library row menu and the song panel
 * offer both, only on takes that kept their performance. §3 the GGUF card is a
 * <details> that folds once installed, the accept line reads as one sentence,
 * and the authors' statement sits beside the licence. No card.
 */
import fs from "node:fs";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const html = src("../web/index.html"), app = src("../web/app.js"), css = src("../web/styles.css");

console.log("\n§1  the panel");
{
  ok("a mode switch: Extend | Replace section", /id="xtModeExtend" aria-pressed="true">Extend<\/button>/.test(html) && /id="xtModeReplace" aria-pressed="false">Replace section<\/button>/.test(html));
  ok("a second handle and a right-hand KEEP", /id="xtKeep2" hidden><span class="lab">KEEP<\/span>/.test(html) && /id="xtHandle2" hidden/.test(html));
  ok("...styled as the mirror of the left one", /\.xtkeep\.right \{ left: auto; right: 0;/.test(css));
  ok("the fields read Extend from / Replace … – …", /id="xtFromLab">Extend from<\/span>/.test(html) && /id="xtToWrap" hidden/.test(html) && /\$\("xtFromLab"\)\.textContent = rep \? "Replace" : "Extend from";/.test(app));
  ok("setXtMode shows and hides the right things and names the button", /\$\("xtToWrap"\)\.hidden = !rep;/.test(app) && /\$\("xtAll"\)\.hidden = rep;/.test(app) && /\$\("xtKeep2"\)\.hidden = !rep;/.test(app) && /\$\("btnCreate"\)\.textContent = rep \? "Replace" : "Extend";/.test(app));
  ok("the paint places NEW between the handles and KEEP after the second", /nw\.style\.left = `\$\{pct\}%`; nw\.style\.right = "auto";/.test(app) && /\$\("xtHandle2"\)\.style\.left = `\$\{pctB\}%`;/.test(app));
  ok("a drag takes the nearer handle in Replace mode", /xt\.dragWhich = xt\.mode === "replace" && Math\.abs\(v - xt\.to\) < Math\.abs\(v - xt\.at\) \? "to" : "at";/.test(app));
  ok("...and the handles never cross", /xt\.to = Math\.min\(xt\.dur, Math\.max\(v, xt\.at \+ 0\.5\)\);/.test(app) && /else xt\.at = Math\.min\(v, xt\.to - 0\.5\);/.test(app));
  ok("the submit posts /api/replace in Replace mode with the second handle", /const replacing = xt\.mode === "replace";\n\s+const toSec = xt\.to;/.test(app) && /fetch\(replacing \? "\/api\/replace" : "\/api\/extend", \{/.test(app));
  ok("the note says what is kept in each mode", /Keeps everything before \$\{tf\(xt\.at\)\} and from \$\{tf\(xt\.to\)\} on exactly as it is/.test(app));
  ok("opening the panel sets the mode", /async function startExtend\(file, mode = "extend"\)/.test(app) && /setXtMode\(mode\);/.test(app));
}

console.log("\n§2  where the two are offered");
{
  ok("the library row menu offers Extend and Replace section on takes that kept their performance",
    /\(t\.codes \|\| t\.yueDir \|\| state\.tokenizerReady\) && t\.durationSeconds \? \[\n\s+\["data-extend", f, "Extend"/.test(app) && /\["data-replace", f, "Replace section"/.test(app));
  /* A RECORDING QUALIFIES TOO, since the real-audio tokenizer shipped: a track
   * with no trajectory and no run folder can be read into YuE2's codes and
   * continued. The gate grew a third term and this pin is what noticed — it is
   * written down so the next widening is deliberate rather than discovered by
   * somebody whose Extend button had quietly appeared or gone. */
  ok("...and a plain recording qualifies once the tokenizer is on this machine",
    /state\.tokenizerReady = !!s\.config\?\.tokenizer\?\.ready;/.test(app)
    && /\$\("spExtendSec"\)\.hidden = !\(\(t\?\.codes \|\| t\?\.yueDir \|\| state\.tokenizerReady\) && t\?\.durationSeconds\);/.test(app));
  ok("...and the clicks open the panel in that mode", /startExtend\(decodeURIComponent\(xe\.dataset\.extend\), "extend"\)/.test(app) && /startExtend\(decodeURIComponent\(xr\.dataset\.replace\), "replace"\)/.test(app));
  ok("the song panel has both buttons", /id="spExtend">Extend this track<\/button>/.test(html) && /id="spReplace"/.test(html) && /\$\("spReplace"\)\.onclick = \(\) => \{ if \(state\.songFile\) startExtend\(state\.songFile, "replace"\); \};/.test(app));
}

console.log("\n§3  the GGUF setup card");
{
  ok("the card is a details that folds", /<details class="infopanel ggufbox" id="ggufSetup" hidden/.test(html) && /<summary><b>Native YuE2 GGUF · optional setup<\/b> <span class="meta" id="ggufSetupSum"><\/span><\/summary>/.test(html));
  ok("...folded once installed, opened while there is something to do, set only when the answer changes",
    /const ready = !!selected\?\.ready && !busy;/.test(app) && /if \(ggufFoldReady !== ready\) \{/.test(app) && /if \("open" in panel\) panel\.open = !ready;/.test(app));
  /* Owner decision of 2026-09-24: YuE2's label follows its authors' statement
   * ("Sellable by individuals … · companies need a commercial licence"); the
   * words come from the catalogue row (outputRights.short / .chip), and the
   * page's own text is only what shows before the catalogue is read. */
  ok("...with a summary that says what is installed and the catalogue's rights words",
    /installed · terms accepted · \$\{or\?\.short \|\| "sellable by individuals"\} \(the authors' statement\)/.test(app)
    && /rightsCatalogCache\?\.musicYue2Gguf\?\.outputRights/.test(app));
  ok("the accept line is one sentence, about the weights' licence file", /I accept the YuE2 model terms \(<a [^>]*>licence file CC BY-NC 4\.0, attribution required<\/a>\)<span id="ggufCudaTerms" hidden> and the native runtime's <a [^>]*>NVIDIA CUDA licence<\/a><\/span>\./.test(html));
  ok("the owner's note shows Studio's label, links the authors' comment and says the licence file has not changed",
    /id="ggufOwnerNote">Studio's label: <b id="ggufOwnerChip">Sellable by individuals \(YuE2 authors' statement, 15 Sep 2026\) · companies need a commercial licence<\/b>\. The authors said so in a <a href="https:\/\/huggingface\.co\/m-a-p\/YuE2-3B\/discussions\/5"[^>]*>discussion comment<\/a> of 15 September 2026; the licence file shipped with the weights still reads CC BY-NC 4\.0\./.test(html)
    && !/keeps its not-for-sale label/.test(html));
  ok("...and the chip words in it are the catalogue's once read", /if \(chip && or\?\.chip && chip\.textContent !== or\.chip\) chip\.textContent = or\.chip;/.test(app));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
