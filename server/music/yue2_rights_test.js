/**
 * The authors' stated intent beside the licence label, 2026-09-17.
 *
 * On the YuE2-3B model page's discussion "Commercial use of generated audio
 * outputs", a member of the Multimodal Art Projection org wrote that
 * individuals may use the model and its outputs as they like, money included,
 * and that only companies should pay for a commercial licence. That is a
 * comment, not the licence file, which still reads CC BY-NC 4.0, and the
 * thread's next replies ask whether it is official. Pinned here: every YuE2
 * rights record carries it verbatim, sourced and dated, with the caveat; the
 * Models card and the Thanks page show it; NOTICE prints it.
 *
 * ⚠ SINCE 2026-09-24 THE LABEL FOLLOWS IT (owner's decision): "Sellable by
 * individuals (YuE2 authors' statement, 15 Sep 2026) · companies need a
 * commercial licence", with the licence file (CC BY-NC 4.0) named beside it on
 * every row. What does NOT follow it: the Mothersuperior add-ons (another
 * author's weights, about which m-a-p said nothing) and SheetSage2 keep the
 * licence file's not-for-sale reading.
 */
import fs from "node:fs";
import { CATALOG, songRights, songRightsStamp, rightsRank, rightsStampFor, outputRightsFor } from "../models.js";
import { finishReplacement } from "./auditions.js";
import { rightsForRecord } from "./yue-gguf.js";

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
  const or = row.outputRights;
  ok(`${id}: the label follows the authors' statement`,
    or.class === "yours-with-conditions" && or.sellable === true && or.basis === "authors-statement");
  ok(`${id}: the chip says it in the owner's words`,
    or.chip === "Sellable by individuals (YuE2 authors' statement, 15 Sep 2026) · companies need a commercial licence", or.chip);
  ok(`${id}: the quote is the authors' sentence and the url is the discussion`,
    or.quote === p.said && or.url === p.where);
  ok(`${id}: the licence file is named beside it`,
    or.licenceFile?.name === "CC BY-NC 4.0" && /NonCommercial purposes only/.test(or.licenceFile?.quote || "")
    && or.licenceFile?.url === "https://huggingface.co/m-a-p/YuE2-3B/blob/main/LICENSE");
  ok(`${id}: attribution names the model, the statement and the file`,
    /m-a-p\/YuE2-3B/.test(or.attribution || "") && /Sellable by individuals/.test(or.attribution || "") && /CC BY-NC 4\.0/.test(or.attribution || ""));
  ok(`${id}: the change is dated and explained`,
    or.changed?.from === "not-for-sale" && or.changed?.on === "2026-09-24" && /authors' statement/.test(or.changed?.why || ""));
}

console.log("\n§1b the add-ons and the transcriber keep the licence file's label");
for (const id of ["musicYue2InstrumentalLora", "musicYue2RealAudioNarLora", "musicYue2Tokenizer", "coverSheetSage2"]) {
  const or = CATALOG.find((c) => c.id === id)?.outputRights;
  ok(`${id} stays not for sale`, or?.class === "not-for-sale" && or?.sellable === false, or?.class);
  ok(`${id} carries no statement m-a-p made about YuE2`, !or?.publisher && or?.basis !== "authors-statement");
}
{
  const a = CATALOG.find((c) => c.id === "musicYue2InstrumentalLora")?.outputRights;
  ok("the add-on rows are detached from musicYue2's getter (a frozen copy)", Object.isFrozen(a)
    && Object.getOwnPropertyDescriptor(CATALOG.find((c) => c.id === "musicYue2InstrumentalLora"), "outputRights")?.get === undefined);
  const comfy = Object.getOwnPropertyDescriptor(CATALOG.find((c) => c.id === "musicYue2Comfy"), "outputRights");
  ok("musicYue2Comfy still reads musicYue2's rights through its getter", typeof comfy?.get === "function"
    && CATALOG.find((c) => c.id === "musicYue2Comfy").outputRights === CATALOG.find((c) => c.id === "musicYue2").outputRights);
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
  const flat = notice.replace(/\s+/g, " ");
  ok("...and prints YuE2 3B's label in the owner's words, with the licence file",
    /YuE2 3B CC BY-NC 4\.0 \(weights\) Output rights: SELLABLE BY INDIVIDUALS \(YuE2 authors' statement, 15 Sep 2026\); companies need a commercial licence; licence file CC BY-NC 4\.0/.test(flat));
  ok("...while the add-ons still print NOT FOR SALE",
    /YuE2 instrumental planner LoRA \(ComfyUI\) CC BY-NC 4\.0 \(weights, derived from YuE2-3B\) Output rights: NOT FOR SALE/.test(flat));
}

console.log("\n§3  a song's add-ons reach its row, its sidecar and its ledger");
{
  const tok = { frames: 750, seconds: 15 };
  const continued = songRights({ engine: "yue2", extendedFrom: "rec.flac", tokenized: tok });
  ok("a continued recording (tokenizer, no coverOf) reads not for sale, and names the tokenizer",
    continued.class === "not-for-sale" && continued.addOns.join() === "musicYue2Tokenizer", JSON.stringify(continued));
  ok("...while the same engine with no add-on reads the authors' statement", songRights({ engine: "yue2" }).class === "yours-with-conditions");
  const stamp = songRightsStamp({ engine: "yue2", tokenized: tok });
  ok("the ledger stamp follows the add-on", stamp?.class === "not-for-sale" && stamp.addOns.join() === "musicYue2Tokenizer", JSON.stringify(stamp));
  ok("...and is left to provenance.js when no add-on raised it", songRightsStamp({ engine: "yue2" }) === null);
  ok("the instrumental planner LoRA on yue2-comfy stamps not for sale",
    songRightsStamp({ engine: "yue2-comfy", loraClip: "ar_lora_inst_v3abc_comfyui.safetensors" })?.class === "not-for-sale");
  ok("an unknown class ranks as unknown, never as unrestricted", rightsRank("not-a-class") === rightsRank("unknown") && rightsRank("unrestricted") === 0);
  const fit = src("../fit.js");
  ok("fit.js ranks by the same list (no second table)", !/const RIGHTS_RANK/.test(fit) && /rightsRank\(a\.cap\.outputRights\?\.class\)/.test(fit));
  const imported = songRights({ imported: true, importedFrom: "C:/Music/me.wav" });
  ok("an imported file is unknown by basis \"imported\", not \"Rights unverified\"",
    imported.class === "unknown" && imported.basis === "imported" && !/unverified/i.test(imported.label), JSON.stringify(imported));

  /* The sidecar writes. finishReplacement is driven for real; index.js's
   * update handler is read, since slicing it needs the whole server. */
  const kept = new Map(), events = [];
  const library = { remember: (file, data) => kept.set(file, data), save: async () => {},
    replaceSection: async () => ({ file: "rec_replaced.flac", seconds: 40, effectiveTo: 20, shortfallSeconds: 0 }) };
  const done = await finishReplacement({
    job: { id: "j1", engine: "yue2", fromSeconds: 10, replaceTo: 20, extendedFrom: "rec.flac", actor: "agent:test", runId: "r1", yue: { dir: "run" }, tokenized: tok },
    receipt: { file: "rec_raw.flac", seed: 1, title: "Rec · replaced", audioSeconds: 26 }, library,
    store: { result: async (_id, r) => r }, modelName: "yue2", append: async (e) => events.push(e), hashFile: async () => "sha256:x" });
  ok("a replaced stretch of a recording finishes", done.state === "ready", JSON.stringify(done));
  ok("...both files keep the tokenizer marker", kept.get("rec_raw.flac")?.tokenized === tok && kept.get("rec_replaced.flac")?.tokenized === tok);
  ok("...so their rows read not for sale", songRights(kept.get("rec_replaced.flac")).class === "not-for-sale" && songRights(kept.get("rec_raw.flac")).class === "not-for-sale");
  ok("...and their stored words say so too", !/Sellable/.test(kept.get("rec_raw.flac").rights) && !/Sellable/.test(kept.get("rec_replaced.flac").rights));
  ok("...and the raw render's ledger row is stamped not for sale", events[0]?.type === "generate" && events[0].data.outputRights?.class === "not-for-sale", JSON.stringify(events[0]?.data?.outputRights));

  const index = src("../index.js");
  ok("the take's sidecar keeps the marker for any tokenized job, not only a cover",
    /\.\.\.\(job\.tokenized && !job\.coverOf \? \{ tokenized: job\.tokenized \} : \{\}\),/.test(index));
  ok("...the joined file too, with words that know it",
    /rights: songRights\(\{ engine: "yue2", tokenized: job\.tokenized \|\| null \}\)\.label,\n\s+(?:\/\*[^]*?\*\/\n\s+)?\.\.\.\(job\.tokenized \? \{ tokenized: job\.tokenized \} : \{\}\),/.test(index));
  ok("...a take extended from a tokenized song carries it on", /\.\.\.\(meta\.tokenized \? \{ tokenized: meta\.tokenized \} : \{\}\),/.test(index));
  ok("...the take's generate row and the join's carry the song's own stamp",
    /\.\.\.songOutputRights\(\{ engine: job\.engine \|\| "minimax-music3", lora: job\.lora, loraClip: job\.loraClip, tokenized: job\.tokenized \}\),/.test(index)
    && /op: "extend-join"[^]*?\.\.\.songOutputRights\(\{ engine: job\.engine, tokenized: job\.tokenized \}\)/.test(index));
  ok("...and the join names the engine that rendered it, not always MiniMax",
    /data: \{ model: modelName, modelVersion: isYueExt \? "3B" : \(job\.model \|\| "int8"\),\n\s+op: "extend-join"/.test(index));

  const gguf = rightsForRecord(outputRightsFor("yue2-gguf"));
  ok("a GGUF record carries the claim, not the whole page (the ledger appends it twice a render)",
    gguf.class === "yours-with-conditions" && /Sellable by individuals/.test(gguf.chip) && gguf.licenceFile?.name === "CC BY-NC 4.0"
    && gguf.quote === undefined && JSON.stringify(gguf).length < 600, JSON.stringify(gguf));
  const ggufSrc = src("./yue-gguf.js");
  ok("...and its ledger stamp is the engine's own small one",
    /outputRights: rightsStampFor\(YUE_GGUF_MODEL\), rights: rightsForRecord\(ggufRights\(\)\),/.test(ggufSrc)
    && rightsStampFor("yue2-gguf").capability === "musicYue2Gguf");
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
