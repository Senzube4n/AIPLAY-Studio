/**
 * The authors' stated intent beside the licence label, 2026-09-17.
 *
 * On the YuE2-3B model page's discussion "Commercial use of generated audio
 * outputs", a member of the Multimodal Art Projection org wrote that
 * individuals may use the model and its outputs as they like, money included,
 * and that only companies should pay for a commercial licence. That is a
 * comment, not the licence file, which still reads CC BY-NC 4.0, and the
 * thread's next replies ask whether it is official. Pinned here: both YuE2
 * rights records carry it verbatim, sourced and dated, with the caveat; the
 * Models card and the Thanks page show it; NOTICE prints it; and the
 * conservative label is unchanged.
 */
import fs from "node:fs";
import { CATALOG } from "../models.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

console.log("\n§1  both YuE2 rights records carry the statement, verbatim and sourced");
for (const id of ["musicYue2", "musicYue2Gguf", "musicYue2Comfy"]) {
  const row = CATALOG.find((c) => c.id === id);
  const p = row?.outputRights?.publisher;
  ok(`${id} has a publisher statement`, !!p);
  if (!p) continue;
  ok(`${id}: the sentence is the one that was written`, /^If you are individual content creators, musicians, researchers, you can use the model and outputs whatever you want\. Even making money from the outputs\.\n\nOnly companies should pay for the commercial license\.$/.test(p.said), JSON.stringify(p.said));
  ok(`${id}: says who`, /a43992899 \(Multimodal Art Projection org\)/.test(p.by));
  ok(`${id}: says where`, p.where === "https://huggingface.co/m-a-p/YuE2-3B/discussions/5");
  ok(`${id}: says when`, p.on === "2026-09-15");
  ok(`${id}: says what it is not`, /not the licence file/.test(p.caveat) && /CC BY-NC 4\.0/.test(p.caveat));
  ok(`${id}: the support link is the one in the comment`, p.support === "https://buymeacoffee.com/ruibin");
  ok(`${id}: the conservative label stays`, row.outputRights.class === "not-for-sale" && row.outputRights.sellable === false);
}

console.log("\n§2  it is shown, and printed, beside the licence — never in place of it");
{
  const app = src("../../web/app.js"), notice = src("../../NOTICE"), gen = src("../../scripts/gen_notice.mjs");
  ok("the Models card renders the statement with its source link and caveat",
    /What the authors said<\/b>/.test(app) && /or\.publisher\.where/.test(app) && /or\.publisher\.caveat/.test(app));
  ok("...and offers the support link", /Support the authors\./.test(app));
  ok("the Thanks page links the support page beside the licence name", /support the authors<\/a>/.test(app) && /c\.outputRights\?\.publisher\?\.support/.test(app));
  ok("gen_notice prints the statement as a discussion comment, not the licence", /Publisher's stated intent \(/.test(gen) && /a discussion comment, not the licence/.test(gen));
  ok("NOTICE carries it", /Publisher's stated intent/.test(notice) && /discussions\/5/.test(notice));
  ok("...and still says NOT FOR SALE for YuE2 3B", /YuE2 3B\s+CC BY-NC 4\.0 \(weights\)\s+Output rights: NOT FOR SALE/.test(notice));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
