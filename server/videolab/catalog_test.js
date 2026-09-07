/**
 * Video lab — the maths and the guard rails.
 *
 * THE ONE CLAIM WORTH TESTING is the commit point. Every sentence this surface
 * says about the turbo path rests on it: that 4 steps at shift 12 hands you the
 * model's guess at sigma 0.800, that shift 3 moves it to 0.500, that the
 * quality path sits at 0.387. Those are not this file's numbers — they are
 * docs/H3_REFERENCE_BLEED.md's, read out of ComfyUI's own scheduler — so the
 * test is: does the formula the panel uses reproduce the document it cites?
 *
 * If it ever stops, the panel is confidently telling people something false
 * about a setting they are about to spend an hour of GPU on, and NOTHING else
 * in the repo would notice: the render would still work, the clip would still
 * appear, and only the explanation would be wrong. That is exactly the class of
 * bug this codebase keeps finding late.
 *
 * The rest of the file is the boring half: a knob may not be settable outside
 * its own declared range (the surface promises a refusal rather than a clamp,
 * and an agent that is quietly clamped believes something that did not happen),
 * and the size guidance must mark native/above/below from the engine's own
 * numbers rather than from a hand-maintained flag.
 *
 * Runs standalone (`node server/videolab/catalog_test.js`) and in the hook.
 */
import { config } from "../config.js";
import {
  commitSigma, commitNote, sizesFor, setKnob, knobById, knobValue,
  KNOBS, COMPARE_CONFIGS, expandConfig, resolveHybrid, SIZE_RULES,
} from "./catalog.js";
import { labState } from "./routes.js";
/* The licence facts this surface must agree with rather than paraphrase. */
import { CATALOG, MODEL_TO_CAPABILITY } from "../models.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const near = (a, b, eps = 0.0005) => Math.abs(a - b) < eps;

/* ── the commit point, against the table it is quoted from ───────────────── */
/**
 * docs/H3_REFERENCE_BLEED.md, "Four steps is qualitatively different":
 *
 *   | steps | final eval sigma |
 *   |   4   |      0.800       |
 *   |   8   |      0.632       |
 *   |  20   |      0.387       |
 *   |  25   |      0.333       |
 *
 * all at the model's default shift of 12.
 */
for (const [steps, want] of [[4, 0.800], [8, 0.632], [20, 0.387], [25, 0.333]]) {
  const got = commitSigma(steps, 12);
  ok(`shift 12 at ${steps} steps commits at ${want}`, near(got, want, 0.0006), `got ${got}`);
}

/* The same document's Fix 1, which is the entire reason the turbo-shift knob
 * exists: "4 steps commits from 0.500 instead of 0.800; 8 steps from 0.300". */
ok("shift 3 moves 4 steps to 0.500", near(commitSigma(4, 3), 0.500), `got ${commitSigma(4, 3)}`);
ok("shift 3 moves 8 steps to 0.300", near(commitSigma(8, 3), 0.300), `got ${commitSigma(8, 3)}`);

/* And its "intermediate options if 3.0 overshoots: 6 -> 0.667, 5 -> 0.625,
 * 4 -> 0.571", all at four steps. */
for (const [shift, want] of [[6, 0.667], [5, 0.625], [4, 0.571]]) {
  ok(`shift ${shift} at 4 steps commits at ${want}`,
    near(commitSigma(4, shift), want, 0.0006), `got ${commitSigma(4, shift)}`);
}

/* A nonsense shift must produce no claim rather than a wrong one. A panel that
 * says "commits at sigma NaN" has at least told the truth about knowing
 * nothing; one that says 0.000 has not. */
ok("an unset shift makes no claim", commitSigma(4, 0) === null && commitSigma(4, null) === null);
ok("...and the sentence is then empty", commitNote(4, 0) === "");

/* The sentence has to CHANGE across the range, or it is decoration. */
ok("the wording tracks the number",
  commitNote(4, 12) !== commitNote(4, 3) && commitNote(4, 3) !== commitNote(20, 12));
ok("the bleeding band names the symptom", /opening frames/.test(commitNote(4, 12)));

/* ── sizes ───────────────────────────────────────────────────────────────── */
const h3 = sizesFor("h3");
/* NATIVE IS A PIXEL BUDGET. The first version of this test asserted exactly ONE
 * native row and failed on the portrait entry — which turned out to be the test
 * being wrong rather than the data: 768x1344 is the same MAX_PIXELS budget
 * stood on its end, and is native. The fix was to say so in the row (and in the
 * badge) rather than to loosen the check, so this now pins BOTH halves: every
 * native row really is at the budget, and exactly one of them is landscape. */
const nativeRows = h3.filter((z) => z.native);
const nativePx = config.video.engines.h3.width * config.video.engines.h3.height;
ok("every row marked native is at the engine's pixel budget",
  nativeRows.length > 0 && nativeRows.every((z) => z.w * z.h === nativePx),
  nativeRows.map((z) => z.id).join(", "));
ok("exactly one of them is the landscape native",
  nativeRows.filter((z) => !z.portrait).length === 1,
  nativeRows.filter((z) => !z.portrait).map((z) => z.id).join(", "));
ok("...and a rotated native says so rather than looking like a second one",
  nativeRows.filter((z) => z.portrait).every((z) => /rotated/i.test(z.territory)));

/* The knee is the whole reason the size list is not just config.js's array. */
const knee = h3.find((z) => z.id === "1792x1008");
ok("the measured knee is offered", !!knee);
ok("...and is honestly flagged as an addition", knee?.added === true,
  "it is not in config.js's own list; hiding that would misrepresent where it came from");
ok("...and is marked above native", knee?.aboveNative === true);
ok("...and carries its measurement", /84 px/.test(knee?.note || ""));

/* The row this repo has been bitten by twice: a picker promising a size the
 * pipeline cannot make. H3 floors each axis to a multiple of 16 inside the
 * node, so any offered size that is not must SAY so. */
const unaligned = h3.filter((z) => z.w % 16 || z.h % 16);
ok("every H3 size off the /16 grid carries the warning",
  unaligned.every((z) => !!z.gridWarning),
  unaligned.filter((z) => !z.gridWarning).map((z) => z.id).join(", "));

/* LTX halves, floors to the 32px latent grid and doubles back — so the real
 * output is floor(n/64)*64, and the row has to report what will really land. */
const ltx = sizesFor("ltx");
ok("LTX rows report a delivered size on the 64px grid",
  ltx.every((z) => z.deliveredW % 64 === 0 && z.deliveredH % 64 === 0),
  ltx.filter((z) => z.deliveredW % 64 || z.deliveredH % 64).map((z) => z.id).join(", "));

/* The three rules are the part a person actually needs, so they are pinned. */
ok("the framing rule is stated", SIZE_RULES.some((r) => /Framing is the lever/i.test(r.headline)));
ok("the upscale trade is stated in one line",
  SIZE_RULES.some((r) => /invents detail/i.test(r.headline) && /does not recover/i.test(r.headline)));
ok("the length-is-not-the-cost finding is stated",
  SIZE_RULES.some((r) => /length/i.test(r.headline)));
ok("every rule cites a document", SIZE_RULES.every((r) => /\.md$|\.js$/.test(r.cite)));

/* ── knobs: refused, not clamped ─────────────────────────────────────────── */
const before = knobValue(knobById("shift_video"));
let threw = false;
try { setKnob("shift_video", 400); } catch { threw = true; }
ok("an out-of-range number is refused", threw);
ok("...and nothing was written", knobValue(knobById("shift_video")) === before);

threw = false;
try { setKnob("ref_image_size", "enormous"); } catch { threw = true; }
ok("an unknown enum value is refused", threw);

threw = false;
try { setKnob("no_such_knob", 1); } catch { threw = true; }
ok("an unknown setting is refused by name", threw);

/* The LTX pair that must move together, because letting them differ doubles
 * every step's cost silently. */
setKnob("ltx_cfg", 2.5);
ok("the paired CFG scales move together",
  config.video.engines.ltx.videoCfg === 2.5 && config.video.engines.ltx.audioCfg === 2.5);
setKnob("ltx_cfg", 1.0);

/* ── THE TURBO SWITCH AND THE TURBO THRESHOLD, which share one field ───────
 *
 * The bug this pins: both rows used to WRITE video.engines.h3.turboMaxSteps,
 * and the switch's "on" was a hard-typed 12. So a person who lowered the
 * threshold to 6 and toggled the LoRA off and on was silently put back on 12 —
 * a distillation running four steps past where they had ruled it out, with the
 * panel showing the number they chose. One row owns the value now; the other
 * parks it and puts it back.
 */
const shippedTurbo = 12;    // what config.js ships, asserted rather than assumed
ok(`config.js still ships turboMaxSteps ${shippedTurbo}`,
  config.video.engines.h3.turboMaxSteps === shippedTurbo,
  "if this changed, the row prose and the restore default follow it automatically — "
    + "this line is here so the rest of this block reads honestly");

setKnob("turbo_max_steps", 6);
setKnob("turbo_lora", false);
ok("turning the turbo LoRA off puts the threshold below every step count",
  config.video.engines.h3.turboMaxSteps === 0 && knobValue(knobById("turbo_lora")) === false);
ok("...and parks the threshold that was there rather than dropping it",
  config.video.engines.h3.turboMaxStepsWhenOn === 6);
setKnob("turbo_lora", true);
ok("...and turning it back on restores YOUR threshold, not a typed 12",
  config.video.engines.h3.turboMaxSteps === 6,
  `got ${config.video.engines.h3.turboMaxSteps} — a hard-coded onValue is back`);

/* Idempotence in both directions: a repainting page toggles a checkbox to the
 * state it is already in, and that must not park a value on top of itself. */
setKnob("turbo_lora", true);
ok("switching it on when it is already on changes nothing",
  config.video.engines.h3.turboMaxSteps === 6);
setKnob("turbo_lora", false);
setKnob("turbo_lora", false);
ok("switching it off twice does not park the off value",
  config.video.engines.h3.turboMaxSteps === 0
    && config.video.engines.h3.turboMaxStepsWhenOn === 6);
setKnob("turbo_lora", true);

/* With nothing ever parked, "on" falls back to what config.js shipped — read
 * from config at import, never typed into the row. */
delete config.video.engines.h3.turboMaxStepsWhenOn;
setKnob("turbo_max_steps", 0);
setKnob("turbo_lora", true);
ok("with nothing parked, on restores the shipped default rather than a literal",
  config.video.engines.h3.turboMaxSteps === shippedTurbo);

ok("only one row claims to own the live threshold",
  KNOBS.filter((k) => k.path.join(".") === "video.engines.h3.turboMaxSteps"
    && k.kind === "number").length === 1,
  "two number rows on one field is the shape of the bug this block is about");

ok("every knob declares an effect sentence and a citation",
  KNOBS.every((k) => k.effect && k.effect.length > 60 && k.cite),
  KNOBS.filter((k) => !k.effect || k.effect.length <= 60 || !k.cite).map((k) => k.id).join(", "));
ok("every knob names a path that resolves in config",
  KNOBS.every((k) => {
    let node = config;
    for (const seg of k.path.slice(0, -1)) node = node?.[seg];
    return node && typeof node === "object";
  }),
  "a knob whose parent object does not exist would write into nothing");

/* ── comparison arms ─────────────────────────────────────────────────────── */
ok("every arm explains what it is for",
  COMPARE_CONFIGS.every((c) => c.why && c.why.length > 80 && c.cite));

const armH3 = expandConfig(COMPARE_CONFIGS.find((c) => c.id === "h3_quality"), {});
ok("the quality arm runs 20 steps on h3", armH3.engine === "h3" && armH3.steps === 20);
ok("...and reports where it commits", armH3.commitSigma > 0.3 && armH3.commitSigma < 0.45);

const armLtx = expandConfig(COMPARE_CONFIGS.find((c) => c.id === "ltx"), {});
ok("the LTX arm claims no step count", armLtx.steps === null);
ok("...and labels its schedule as fixed", /no step count/.test(armLtx.sizeLabel));

/* Each arm at ITS engine's native size unless one is pinned — asking LTX for
 * H3's 1344x768 silently gets you 1280x704 after the halve-then-floor, which
 * would make the comparison compare two things and report one. */
ok("arms default to their own engine's native size",
  armH3.width === config.video.engines.h3.width
  && armLtx.width === config.video.engines.ltx.width);

/* Hybrid resolves BEFORE the render, with the reason, which is the whole
 * lesson of the evening it cost when nothing reported the choice until after. */
ok("hybrid with references routes to h3", resolveHybrid({ refImages: ["a.png"] }).engine === "h3");
ok("hybrid without references routes to ltx", resolveHybrid({}).engine === "ltx");
ok("...and both answers carry a reason",
  !!resolveHybrid({ refImages: ["a.png"] }).reason && !!resolveHybrid({}).reason);
const armHy = expandConfig(COMPARE_CONFIGS.find((c) => c.id === "hybrid"), { refImages: ["a.png"] });
ok("an expanded hybrid arm records what it became", armHy.engine === "h3" && !!armHy.routing);
ok("...and remembers that it was declared hybrid", armHy.declaredEngine === "hybrid");

/* ── the shape the page reads ────────────────────────────────────────────── */
/**
 * THE CONTRACT BETWEEN THE TWO FILES, written down.
 *
 * web/videolab.js renders whatever /api/videolab hands it, which is the point —
 * but it renders it by NAME, so a field renamed on this side goes blank on that
 * one and nothing anywhere throws. A blank badge is invisible in a way a
 * missing control is not, and this surface's whole job is explaining things, so
 * an explanation that quietly stops being rendered is the worst failure it has.
 *
 * Each name below is followed by the function that reads it. If you rename one,
 * this fails and tells you where to look.
 */
const st = labState("h3", { refImages: ["x.png"] });
const has = (obj, keys, who) => {
  const missing = keys.filter((k) => obj === undefined || obj === null || !(k in obj));
  ok(`${who} gets every field it renders`, missing.length === 0, "missing: " + missing.join(", "));
};
has(st, ["engine", "quality", "commit", "knobs", "allKnobs", "configs", "groups", "docs"], "the page");
has(st.quality, ["width", "height", "steps", "sizes", "rules"], "paintQuality");
has(st.quality.sizes[0], ["id", "w", "h", "label", "native", "portrait", "aboveNative",
  "belowNative", "ofNative", "deliveredW", "deliveredH", "added", "note", "territory",
  "gridWarning", "cite"], "paintQuality's size rows");
has(st.quality.rules[0], ["id", "headline", "body", "cite"], "paintQuality's rules");
has(st.commit, ["steps", "shift", "turbo", "sigma", "note", "cite"], "paintCommit");
has(st.knobs[0], ["id", "label", "kind", "value", "effect", "cite", "path", "unsetAt"], "paintKnobs");
has(st.configs[0], ["id", "label", "engine", "declaredEngine", "routing", "sizeLabel",
  "commitSigma", "why", "licence", "cite"], "paintConfigs");
has(st.docs, ["faces", "bleed"], "the citation lines");

/* And the fix that made the refs travel with the state read: a hybrid arm asked
 * about WITH references must say h3, not ltx. */
const hy = st.configs.find((c) => c.declaredEngine === "hybrid");
ok("a hybrid arm read with references reports h3", hy?.engine === "h3", `got ${hy?.engine}`);
ok("...and the plain read reports ltx",
  labState("h3").configs.find((c) => c.declaredEngine === "hybrid")?.engine === "ltx");
ok("every arm carries a licence line", st.configs.every((c) => !!c.licence));

/* ⚠ THIS CHECK USED TO PIN THE PROSE — /EU, the UK or South Korea/ — and so it
 * passed while the line was WRONG. MiniMax H3's Applicable Territory excludes
 * four places; that string names three, and the missing one is the United
 * States of America. A test asserting that the copy still says what the copy
 * says is not a gate, it is a signature. What makes the claim true or false is
 * server/models.js — the same list the downloader refuses on and the same list
 * the welcome window prints — so that is what it is checked against now,
 * territory by territory. Rewording the sentence is free; dropping a territory
 * out of it is not. */
const h3cap = CATALOG.find((c) => c.id === MODEL_TO_CAPABILITY.h3);
const h3arms = st.configs.filter((c) => c.engine === "h3");
ok("...and the H3 one names EVERY excluded territory models.js declares",
  h3arms.length > 0 && h3arms.every((c) => h3cap.region.excluded.every((t) => c.licence.includes(t))),
  "missing: " + [...new Set(h3arms.flatMap((c) =>
    h3cap.region.excluded.filter((t) => !c.licence.includes(t))))].join(", "));
ok("...and no arm re-summarises a territory list by hand",
  !/EU, the UK or South Korea/.test(JSON.stringify(st.configs)),
  "a hand-typed territory summary is back — build it from CATALOG.region.excluded instead");

/* The money clause the same way. models.js states the boundary explicitly —
 * "at least USD 10,000,000 … Exactly $10M is above the line" — and the retyped
 * version said "above $10M", which moves the boundary by exactly the case that
 * sentence exists to settle. */
const ltxcap = CATALOG.find((c) => c.id === MODEL_TO_CAPABILITY.ltx);
const ltxarms = st.configs.filter((c) => c.engine === "ltx");
ok("the LTX arms carry models.js's own conditions, verbatim",
  ltxarms.length > 0 && ltxarms.every((c) =>
    (ltxcap.outputRights?.conditions ?? []).every((k) => c.licence.includes(k))),
  "a condition has been paraphrased or dropped from the arm card");

/* ── a row may not claim a measurement it does not have ──────────────────── */
/**
 * THE DEFECT THIS EXISTS FOR, stated plainly because it is the easiest kind to
 * ship and the hardest to notice.
 *
 * The 864x480 row read "measured 2.7x worse on detail when paired with a short
 * clip", and cited docs/RESOLUTION_FOR_FACES.md. Every part of that is checkable
 * and every part was wrong: 2.7x is that document's COST span across the size
 * ladder in GPU-hours, not a detail metric; 864x480 was never rendered, in that
 * sweep or any other; and the same sentence was pasted onto the `territory`
 * line of every below-native row, so a card could say "Not in the sweep" and
 * "measured 2.7x worse" one line apart. Grepping for the number would not have
 * caught it — 2.7 IS in the document. What was invented was the QUANTITY it
 * described and the SIZE it was attached to.
 *
 * So the rule is about provenance rather than arithmetic, and it is the one
 * SIZE_NOTES already promises in its own comment ("absent from this table means
 * absent from the sweep: the row then says nothing rather than inventing a
 * consequence"): a row that was not rendered may carry commentary, but it must
 * say so, and it may never carry a per-size figure. `measured` now comes from
 * the list of sizes a GPU actually ran, not from whether somebody wrote a
 * sentence — which is what let commentary be read as evidence.
 */
for (const engine of ["h3", "ltx"]) {
  for (const z of sizesFor(engine)) {
    if (!z.note) continue;
    if (z.measured) {
      ok(`${engine} ${z.id}: a measured row carries its figures`,
        /\d/.test(z.note), "a swept size with a note that quotes no number is suspicious");
      continue;
    }
    /* An unmeasured row may still be useful — "buys nothing over the knee" is
     * worth saying — but it has to attribute, either by naming the size that
     * WAS measured or by admitting it was not in the sweep. */
    ok(`${engine} ${z.id}: an unmeasured row does not pass itself off as measured`,
      /not in the (face )?sweep|measured at \d|there is no measured/i.test(z.note),
      `"${z.note.slice(0, 90)}…" — this size was never rendered, so the row must either name the `
        + "size that was, or say it was not in the sweep");
  }
}
/* And the retired sentence itself, by name, because the tempting fix when this
 * fails is to paste it back somewhere quieter. */
ok("the cost span is never described as a detail measurement",
  !/2\.7x worse on detail/.test(JSON.stringify(sizesFor("h3")) + JSON.stringify(sizesFor("ltx"))),
  "2.7x is docs/RESOLUTION_FOR_FACES.md's GPU-hour span across the size ladder, not a detail score");

/* ── native must not follow the selection ───────────────────────────────── */
/**
 * `set_quality` writes the engine's own width/height, because that is the
 * default every render falls back to — so the SELECTION and the TRAINED SIZE
 * live in the same two fields for the rest of the process. Read native live
 * and the list rewrites its own meaning to agree with whatever you last
 * clicked: pick the knee and 1792x1008 becomes "native" while the real native
 * becomes "below native". Pinned here because the symptom is a label, not a
 * crash, and nothing else in the repo looks at labels.
 */
const wasW = config.video.engines.h3.width, wasH = config.video.engines.h3.height;
config.video.engines.h3.width = 1792; config.video.engines.h3.height = 1008;
const after = sizesFor("h3");
ok("choosing a size does not make it native",
  after.find((z) => z.id === "1792x1008")?.aboveNative === true,
  "the knee relabelled itself the moment it was selected");
ok("...and the real native keeps its badge",
  after.find((z) => z.id === `${wasW}x${wasH}`)?.native === true);
config.video.engines.h3.width = wasW; config.video.engines.h3.height = wasH;

/* ── two arms that resolve to the same render are one render ─────────────── */
/**
 * The finding from the first real comparison this surface ran. `hybrid` with no
 * references resolves to LTX, which made it identical to the LTX arm — same
 * prompt, seed, size and fixed schedule. ComfyUI served the second one from
 * cache and returned the output entry for a file the first arm had already
 * moved, so the arm died on ENOENT after costing nothing and proving nothing.
 *
 * The route now recognises the twin BEFORE rendering, which is checkable here
 * without a GPU: the two expansions have to agree on every field the check
 * compares, or the runner will keep paying for the duplicate.
 */
const ltxArm = expandConfig(COMPARE_CONFIGS.find((c) => c.id === "ltx"), {});
const hybridNoRefs = expandConfig(COMPARE_CONFIGS.find((c) => c.id === "hybrid"), {});
ok("hybrid with no references is the same render as the LTX arm",
  hybridNoRefs.engine === ltxArm.engine && hybridNoRefs.steps === ltxArm.steps
  && hybridNoRefs.width === ltxArm.width && hybridNoRefs.height === ltxArm.height,
  "if these ever differ, the twin check stops firing and the duplicate render comes back");
const hybridRefs = expandConfig(COMPARE_CONFIGS.find((c) => c.id === "hybrid"), { refImages: ["a.png"] });
ok("...and hybrid WITH references is a genuinely different arm",
  hybridRefs.engine !== ltxArm.engine,
  "with cast attached it must route to H3, or the comparison has no hybrid arm at all");

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
