/**
 * THE VIDEO SCREEN FOLLOWS THE CARD (the H3 lab of 2026-09-24, changes #1, #2,
 * #4, #5, #6 and #7; UI_PLAN C3).
 *
 *   §1 the numbers   h3tier.js: what a size needs against what the card has,
 *                    the size chips and the start size per card.
 *   §2 the settings  config.js: the tier sizes in H3's list, sol-attn on the
 *                    Fast setting, FastH3 Advanced-only with Kitchen attention,
 *                    the Graphics memory select's scope sentence.
 *   §3 the graph     the Fast setting carries the lab's sol-attn node (A3),
 *                    Standard, Best and references stay dense, FastH3 keeps its
 *                    own VSA, and one graph never has two node 81s.
 *   §4 the engine    art.js asks the running engine for BlockSparseAttention's
 *                    sol-attn before sending it, and a failure is a sentence
 *                    with the engine's text behind Details.
 *   §5 the plan      video-plain.js videoPlan: the card's size when none is
 *                    named, the reference build's step count, sparse, the RAM
 *                    line; each change said.
 *   §6 the page      web/vidfit.js holds no opinion of its own, and run against
 *                    a stub DOM on three machines it shows the server's chips,
 *                    start size, sentences and fit line.
 *   §7 one control   the Video Lab mirrors the form's steps, audio and sparse
 *                    controls instead of drawing second ones (C3).
 *
 * No server, no engine, no GPU: the engine's answers are stubbed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const { config } = await import("./config.js");
const tier = await import("./h3tier.js");
const plain = await import("./video-plain.js");
const { videoGraph, h3SparseFor, h3MatchedSteps } = await import("./workflow.js");

const MiB = 1024;
const status = (vramGb, ramGb, vendor = "nvidia") => {
  const h = tier.h3Status({ gpu: vramGb ? { totalMb: vramGb * MiB, vendor, name: `a ${vramGb} GB card` } : null,
    ram: ramGb ? { totalMb: ramGb * MiB } : null });
  return { ...h, start: tier.h3StartSize(h), notOffered: plain.h3NotOfferedLine(h) };
};

/* ── §1 ─────────────────────────────────────────────────────────────────── */
test("§1 what a size needs, against what the card has, on the grids H3 works on", () => {
  const full = tier.h3SizeFit({ width: 1344, height: 768, seconds: 8 }, { vramMb: 16376 });
  assert.equal(full.frames, 192, "8 s is 192 frames on the 17k+5 grid");
  assert.equal(full.tokens, 57456, "the lab's own token count for 1344x768, 192 frames");
  assert.equal(full.needMiB, 9084, "2,764 + 0.110 per token");
  assert.equal(full.withMarginMiB, 9084 + 512);
  assert.equal(full.needGb, 9.4);
  assert.equal(full.haveGb, 16);
  assert.equal(full.over, false);
  assert.match(full.sentence, /^This size needs about 9\.4 GB free on the graphics card; you have 16 GB, and the desktop uses some of it\.$/);
  assert.match(full.scope, /7 capped runs of the Fast setting, each within 161 MiB/);
  const eight = tier.h3SizeFit({ width: 1344, height: 768, seconds: 8 }, { vramMb: 8192 });
  assert.equal(eight.over, true, "the lab: 1344x768 for 8 s did not fit under an 8 GB cap");
  assert.match(eight.sentence, /It will not fit here: pick a smaller size or a shorter clip\./);
  const small = tier.h3SizeFit({ width: 960, height: 544, seconds: 5 }, { vramMb: 8192 });
  assert.equal(small.over, false, "and 960x544 for 5 s did");
  const odd = tier.h3SizeFit({ width: 1280, height: 720, seconds: 5 }, { vramMb: 16376 });
  assert.deepEqual([odd.width, odd.height, odd.snapped], [1280, 736, true], "a side off the grid counts up to it");
  assert.match(odd.sentence, /Counted as 1280x736, on H3's 32-pixel grid\./);
  const huge = tier.h3SizeFit({ width: 1920, height: 1088, seconds: 10 }, { vramMb: 16376 });
  assert.equal(huge.inFittedRange, false);
  assert.match(huge.sentence, /outside the sizes the fit was measured on, so the figure is a guess/);
  const unread = tier.h3SizeFit({ width: 960, height: 544, seconds: 5 }, {});
  assert.equal(unread.haveGb, null);
  assert.equal(unread.over, false, "no card reading, no judgement against it");
  assert.match(unread.sentence, /the card could not be read/);
  assert.equal(tier.h3SizeFit({ width: 0, height: 544, seconds: 5 }), null);
});

test("§1 the size chips and the start size, per card", () => {
  const ids = (s) => s.choices.map((c) => c.id);
  assert.deepEqual(ids(status(16, 32)), ["full", "small", "preview"], "a full card: its tier and every smaller one");
  assert.deepEqual(ids(status(8, 32)), ["small", "preview"]);
  assert.deepEqual(ids(status(6, 32)), ["preview"]);
  assert.deepEqual(ids(status(4, 32)), [], "under 6 GB: not offered, no chips");
  assert.deepEqual(ids(status(0, 32)), ["full", "small", "preview"], "an unread card: every tier, none chosen");
  assert.deepEqual(status(16, 32).choices.map((c) => c.chip),
    ["Full · 1344x768", "Smaller card · 960x544, 5 s", "Preview · 832x480, experimental"], "the owner's plain words");
  assert.deepEqual(status(8, 32).start, { tier: "small", width: 960, height: 544, maxSeconds: 5, chip: "Smaller card · 960x544, 5 s",
    measured: true, lengthSaid: "The length went down to 5 s, the longest measured to fit at 960x544 on an 8 GB card; a longer clip is untested there, not forbidden." });
  assert.equal(status(6, 32).start.measured, false, "the preview was never seen to fit");
  assert.match(status(6, 32).start.lengthSaid, /experimental 832x480 preview is offered at; it has not been seen to fit yet\.$/);
  assert.equal(status(16, 32).start, null, "a full card: the engine's own size stands, and the page is sent nothing to apply");
  assert.equal(status(12, 32).start, null);
  assert.equal(status(0, 32).start, null, "an unread card chooses no size");
  assert.equal(status(4, 32).start, null);
  assert.equal(status(8, 8).start, null, "under the RAM floor H3 is not offered either");
  assert.equal(status(16, 32).grid, 32);
  /* Each chip names its length in its tooltip, and says so when it shortens one. */
  const full = status(16, 32).choices[0];
  assert.equal(full.title, "Full quality: 1344x768, measured up to 8 s");
  assert.match(full.lengthSaid, /^The length went down to 8 s, the longest measured to fit at 1344x768 on a 12 GB card/);
});

test("§1 where H3 is not offered: one sentence, a friend first, your own key second", () => {
  const four = status(4, 32).notOffered;
  assert.match(four, /^H3 video is not offered here: this card has 4 GB of graphics memory, and nothing under 6 GB was tested\./);
  assert.ok(four.indexOf("Ask a friend") < four.indexOf("your own key"), "the friend comes first");
  assert.match(four, /Settings → No strong graphics card\?/, "the own-key card, by its name on screen");
  assert.match(status(8, 8).notOffered, /this PC has 8 GB of RAM, under the 16 GB it needs/);
  assert.equal(status(16, 32).notOffered, null);
  assert.equal(status(0, 0).notOffered, null, "an unread card is not told H3 is off");
  assert.match(four, /Ask a friend with a strong card first \(built, not yet tried between two PCs\)/, "lending is said to be untried");
  /* NO CARD AT ALL (release critic): the engine runs on the CPU, so H3 is not
   * offered, no H3 size is shown, and the friend-first line appears; an AMD or
   * Intel card whose memory was not read keeps "cannot tell". */
  const h = tier.h3Status({ gpu: null, ram: { totalMb: 16310 }, cpuOnly: true });
  const cpu = plain.h3NotOfferedLine(h);
  assert.deepEqual(h.choices, [], "no H3 sizes on a PC with no card");
  assert.equal(tier.h3StartSize(h), null);
  assert.match(cpu, /^H3 video is not offered here: this PC has no graphics card for it to render on/);
  assert.ok(cpu.indexOf("Ask a friend") < cpu.indexOf("your own key"), "the friend comes first there too");
});

/* ── §2 ─────────────────────────────────────────────────────────────────── */
test("§2 the settings: tier sizes in H3's list, sol-attn on Fast, FastH3 Advanced-only on Kitchen", () => {
  const h3 = config.video.engines.h3, fast = config.video.engines.fasth3;
  for (const t of tier.H3_TIERS.filter((x) => x.width)) {
    assert.ok(h3.sizes.some((z) => z.w === t.width && z.h === t.height), `${t.width}x${t.height} is a size the list has`);
  }
  assert.match(h3.sizes.find((z) => z.w === 960 && z.h === 544).label, /smaller size for 8 GB cards/);
  assert.match(h3.sizes.find((z) => z.w === 832 && z.h === 480).label, /preview for 6 GB cards, experimental/);
  assert.equal(h3.sizes.filter((z) => z.w === 1344 && z.h === 768).length, 1, "a listed size is not repeated");
  /* The lab's arm A3, lab/graphs/A3.json node 81. */
  assert.equal(h3.sparse, "sol-attn");
  assert.equal(h3.solAttn, tier.H3_SOL_ATTN, "config's recipe is h3tier.js's, one copy");
  const { method, tau, startPercent, endPercent, minTokens, extraTokens, sinkConditioning } = h3.solAttn;
  assert.deepEqual({ method, tau, startPercent, endPercent, minTokens, extraTokens, sinkConditioning }, { method: "sol-attn",
    tau: 1.3, startPercent: 0.2, endPercent: 1, minTokens: 12288, extraTokens: 256, sinkConditioning: "exact_kv_and_rows" });
  assert.equal(h3.solAttn.note, "Sol-attn sparse attention on the Fast setting: about 1.15x faster per clip, slightly softer "
    + "picture; measured on a 16 GB card at 1344x768 for 8 s, not yet tried at other sizes or with the 0.18 GB TaoMate file. "
    + "Standard, Best, references, continuations and video-to-video always run dense attention.");
  assert.match(h3.solAttn.recipe, /tau 1\.3, dense for the first 20% of the schedule, only above 12,288 video tokens/,
    "the recipe's words are built from its numbers");
  assert.equal(fast.attention, "kitchen");
  assert.equal(fast.sparse, null, "FastH3 runs its own VSA, never H3's switch");
  /* Named as the model it is since 2026-09-25 (it was a "More motion" switch). */
  assert.equal(fast.advanced.label, "FastH3 (experimental)");
  assert.equal(fast.advanced.note, "A distilled H3 model, 8 steps. About 1.4x the wait of Fast. Can change the subject's colour or add a white blob; check the take.");
  assert.equal(fast.advanced.label, tier.H3_MORE_MOTION.label, "one copy, h3tier.js");
  /* The Fast chip's note follows the saved sparse attention: never "as sharp" while sol-attn runs. */
  assert.match(plain.fastNote(h3), /with sparse attention on: about 1\.15x faster per clip, slightly softer picture/);
  assert.doesNotMatch(plain.fastNote(h3), /as sharp/);
  assert.equal(plain.fastNote({ ...h3, sparse: "off" }), "3 steps on the TaoMate build: as sharp as the 8-step build, a third less time.");
  assert.match(plain.fastNote({ ...h3, stepDefaults: { fast: 4, standard: 8, best: 20 } }), /^Install the Fast setting for H3/);
  assert.equal(plain.fastNote(fast), null, "FastH3 has no quality chips");
  assert.equal(plain.fastNote(config.video.engines.ltx), null);
  assert.equal(config.video.engines.ltx.advanced, undefined);
  assert.match(config.vramTierScope, /restarts the engine for every model it runs, pictures and video \(H3\) included/);
  assert.match(config.vramTierScope, /does not choose a video size/);
});

/* ── §3 ─────────────────────────────────────────────────────────────────── */
test("§3 the Fast setting carries the lab's sol-attn node; Standard, Best and references stay dense", () => {
  const h3 = { ...config.video, ...config.video.engines.h3 };
  const fast = videoGraph({ engine: "h3", prompt: "p", seed: 1, seconds: 8, width: 1344, height: 768, steps: 3, attention: "ck" });
  assert.deepEqual(fast[81], { class_type: "BlockSparseAttention", inputs: { model: ["6", 0], selection: "sol-attn",
    "selection.tau": 1.3, start_percent: 0.2, end_percent: 1, dense_blocks: "", min_tokens: 12288, extra_tokens: 256,
    sink_conditioning: "exact_kv_and_rows", verbose: false } }, "A3's node 81, verbose off");
  assert.deepEqual(fast[7].inputs.model, ["81", 0], "the guider samples the patched model");
  assert.deepEqual(fast[8].inputs.model, ["81", 0], "and so does the scheduler");
  assert.deepEqual(fast[6].inputs.model, ["85", 0], "CK attention (node 85) stays before the shift");
  assert.equal(fast[85].class_type, "ModelAttentionBackend", "85 and 81 in one graph, no collision");
  assert.equal(fast[18].inputs.lora_name, h3.turboLora3, "the TaoMate 3-step file");
  const off = videoGraph({ engine: "h3", prompt: "p", seed: 1, seconds: 8, steps: 3, sparse: "off" });
  assert.equal(off[81], undefined, "the switch off: dense");
  assert.deepEqual(off[7].inputs.model, ["6", 0]);
  for (const steps of [4, 8, 20]) {
    assert.equal(videoGraph({ engine: "h3", prompt: "p", seed: 1, seconds: 8, steps, sparse: "sol-attn" })[81], undefined,
      `${steps} steps stays dense, even asked`);
  }
  assert.equal(videoGraph({ engine: "h3", prompt: "p", seed: 1, seconds: 5, steps: 3, refImages: ["a.png"] })[81], undefined,
    "the reference path stays dense");
  /* Paths the lab never ran sol-attn on stay dense: a continuation and video-to-video. */
  const cont = videoGraph({ engine: "h3", prompt: "p", seed: 1, seconds: 5, steps: 3, sparse: "sol-attn",
    continueFrom: { file: "prev.mp4", overlapFrames: 17 } });
  assert.equal(cont[81], undefined, "a continuation stays dense");
  const v2v = videoGraph({ engine: "h3", prompt: "p", seed: 1, seconds: 5, steps: 3, sparse: "sol-attn",
    controlVideo: "drive.mp4", controlPatch: "patch.safetensors" });
  assert.equal(v2v[81], undefined, "video-to-video stays dense");
  assert.equal(h3SparseFor(h3, { steps: 3, continuation: true }), null);
  assert.equal(h3SparseFor(h3, { steps: 3, control: true }), null);
  assert.equal(videoGraph({ engine: "h3", prompt: "p", seed: 1, seconds: 5, width: 960, height: 544, steps: 3 })[81]?.inputs.selection,
    "sol-attn", "a smaller size on the Fast setting takes it (the plan says the size is untried)");
  assert.equal(h3SparseFor(h3, { steps: 3 }), h3.solAttn);
  assert.equal(h3SparseFor(h3, { steps: 3, sparse: "off" }), null);
  const fh = videoGraph({ engine: "fasth3", prompt: "p", seed: 1, seconds: 2, sparse: "sol-attn" });
  assert.equal(fh[81].inputs.selection, "vsa", "FastH3 keeps its own VSA whatever H3's switch says");
  assert.equal(fh[81].inputs["selection.keep_percent"], 10);
  assert.equal(fh[81].inputs["selection.tau"], undefined);
  assert.equal(Object.keys(fh).filter((k) => fh[k]?.class_type === "BlockSparseAttention").length, 1);
});

test("§3 Fast with references runs the reference build's own step count", () => {
  const h3 = { ...config.video, ...config.video.engines.h3 };
  const m = h3MatchedSteps(h3, { steps: 3, refs: true });
  assert.equal(m.raised, true);
  assert.equal(m.asked, 3);
  assert.equal(m.steps, m.made, "the loaded file's own count");
  assert.equal(m.made, 4, "the 4-step reference build");
  assert.equal(h3MatchedSteps(h3, { steps: 3, refs: false }).raised, false, "the text path keeps its 3");
  assert.equal(h3MatchedSteps(h3, { steps: 8, refs: true }).raised, false, "a count at or above the file's is left alone");
  for (const n of [6, 7]) {
    const r = h3MatchedSteps(h3, { steps: n, refs: true });
    assert.deepEqual([r.raised, r.steps], [false, n], `${n} steps with references is left alone (outside the Fast band; the page's own ⚠)`);
  }
  assert.equal(h3MatchedSteps(h3, { steps: 20, refs: true }).raised, false, "Best loads no LoRA");
});

/* ── §4 ─────────────────────────────────────────────────────────────────── */
test("§4 art.js asks the engine for sol-attn before sending it, and a failure is a sentence", async () => {
  const { ArtRunner, sparseMethods } = await import("./art.js");
  const { engine } = await import("./engine/client.js");
  const dyn = (keys) => ({ BlockSparseAttention: { input: { required: { selection: ["COMFY_DYNAMICCOMBO_V3", { options: keys.map((key) => ({ key, inputs: {} })) }] } } } });
  assert.deepEqual(sparseMethods(dyn(["sol-attn", "sla", "vsa"])), ["sol-attn", "sla", "vsa"], "ComfyUI 0.36's DynamicCombo");
  assert.deepEqual(sparseMethods({ BlockSparseAttention: { input: { required: { selection: [["vsa"], {}] } } } }), ["vsa"]);
  assert.equal(sparseMethods({}), null, "no node");
  const keep = engine.objectInfo;
  let asks = 0;
  try {
    engine.objectInfo = async () => { asks++; return dyn(["sol-attn", "sla", "vsa"]); };
    const art = new ArtRunner(null, null);
    assert.equal(await art.videoSparse({ engine: "h3", steps: 3 }), "sol-attn", "the saved choice on the Fast setting, on an engine that has it");
    assert.equal(await art.videoSparse({ engine: "h3", steps: 3, sparse: "off" }), "off", "a render's own choice wins");
    assert.equal(await art.videoSparse({ engine: "fasth3" }), undefined, "FastH3's VSA is the graph's");
    assert.equal(await art.videoSparse({ engine: "ltx" }), undefined);
    /* A render whose graph would never carry it neither asks the engine nor gets a note. */
    engine.objectInfo = async () => { asks++; return {}; };
    asks = 0;
    for (const job of [{ engine: "h3", steps: 8 }, { engine: "h3", steps: 20 }, { engine: "h3", steps: 3, refImages: ["a.png"] },
      { engine: "h3", steps: 3, continueFrom: { file: "prev.mp4" } }, { engine: "h3", steps: 3, controlVideo: "d.mp4", controlPatch: "p.safetensors" }]) {
      const fresh = new ArtRunner(null, null);
      assert.equal(await fresh.videoSparse(job), "off", JSON.stringify(job));
      assert.equal(job.sparseNote, undefined, `no note where sol-attn never applied: ${JSON.stringify(job)}`);
    }
    assert.equal(asks, 0, "and the engine was never asked for them");
    const old = new ArtRunner(null, null);
    const job = { engine: "h3", steps: 3 };
    assert.equal(await old.videoSparse(job), "off", "no node: no node 81, never a prompt the engine refuses");
    assert.match(job.sparseNote, /^This clip ran dense attention: the Fast setting's sparse attention \(sol-attn\) needs/);
    assert.doesNotMatch(job.sparseNote, /asked for/, "an inherited default is not called a request");
    engine.objectInfo = async () => dyn(["vsa"]);
    assert.equal(await new ArtRunner(null, null).videoSparse({ engine: "h3", steps: 3 }), "off", "a node without the mode: off");
  } finally { engine.objectInfo = keep; }
  const src = read("./art.js");
  const call = src.slice(src.indexOf("if (!graph) graph = videoGraph({"), src.indexOf("const key = graphHash(graph);"));
  assert.match(call, /^\s+sparse: await this\.videoSparse\(job\),$/m, "the graph call names it");
  /* Both ways a render fails become the sentence: a run that ended badly, and
   * a submission the engine refused (client.js throws); server/video-fail_test.js
   * runs both through the real runner. */
  assert.match(src, /const failed = \(raw, runId\) => \{\n\s+const said = plainVideoFailure\(raw\);/);
  /* ...except the engine door's minors refusal, which travels unchanged: its
   * `safety` flag is what blanks the job's words and answers 422
   * (server/safety/doors_test.js, video-fail_test.js). */
  assert.match(src, /\}\)\.catch\(\(err\) => \{[\s\S]{0,300}?if \(err\?\.safety\) throw err;\s*throw failed\(String\(err\?\.message \|\| err\), err\?\.runId\);\s*\}\);/);
  assert.match(src, /throw failed\(done\.error \|\| `the engine did not finish \(\$\{done\.status\}\)`\);/);
  assert.match(src, /job\.errorDetail = said\.detail \|\| null;/);
  assert.match(src, /return new Error\(said\.sentence\);/);
  assert.match(src, /detail: String\(j\.errorDetail\)\.slice\(0, 4000\)/, "the newest rows carry the engine's text");
  assert.match(src, /fullError: `\$\{String\(j\.error\)\} Details: \$\{String\(j\.errorDetail\)\}`/, "and a waiter gets both");
});

test("§4 ComfyUI's failures in words", () => {
  const oom = plain.plainVideoFailure(JSON.stringify([["execution_error", { exception_type: "torch.OutOfMemoryError",
    exception_message: "Allocation on device 0 would exceed allowed memory." }]]));
  assert.equal(oom.sentence, "The card ran out of memory at this size; pick the smaller size or close GPU-heavy apps.");
  assert.equal(oom.reason, "out-of-memory");
  assert.match(oom.detail, /OutOfMemoryError/, "the raw text is kept for Details");
  assert.equal(plain.plainVideoFailure("ComfyUI stopped answering after 312 s").reason, "engine-gone");
  assert.equal(plain.plainVideoFailure("no terminal status 40 min after this job STARTED on the engine").reason, "timeout");
  assert.equal(plain.plainVideoFailure("cancelled from the app: this run's prompt was withdrawn").reason, "cancelled");
  assert.equal(plain.plainVideoFailure('{"node_errors":{"81":"value not in list"}}').reason, "refused");
  assert.equal(plain.plainVideoFailure('ComfyUI rejected the job: {"error":{"type":"prompt_outputs_failed_validation"}}').reason, "refused",
    "a submission the engine refused before it ran");
  assert.equal(plain.plainVideoFailure("POST /prompt failed: fetch failed").reason, "unreachable");
  /* The PC's own memory is not the card's: a smaller size does not help it. */
  const ram = plain.plainVideoFailure("DefaultCPUAllocator: not enough memory: you tried to allocate 1073741824 bytes.");
  assert.equal(ram.reason, "ram-out-of-memory");
  assert.match(ram.sentence, /^This PC ran out of memory \(RAM, not the graphics card\) during the render: close memory-heavy apps and set a large pagefile\./);
  assert.doesNotMatch(ram.sentence, /pick the smaller size/);
  assert.equal(plain.plainVideoFailure("The paging file is too small for this operation to complete. (os error 1455)").reason, "ram-out-of-memory");
  assert.equal(plain.plainVideoFailure("CUDA out of memory. Tried to allocate 2.00 GiB").reason, "out-of-memory");
  assert.equal(plain.plainVideoFailure("something else").sentence, "The video engine stopped with an error; Details say what it reported.");
  assert.equal(plain.plainVideoFailure("").sentence, "The video engine stopped without saying why.");
});

/* ── §5 ─────────────────────────────────────────────────────────────────── */
test("§5 the plan: the card's size when none is named, each change said", () => {
  const eng = config.video.engines.h3;
  const eight = plain.videoPlan({ prompt: "a lamp" }, { engineKey: "h3", eng, h3: status(8, 32) });
  assert.deepEqual([eight.width, eight.height, eight.seconds], [960, 544, 5]);
  assert.match(eight.warnings.find((w) => w.id === "size").text,
    /^No size was named, so this renders at 960x544(?: for 5 s)?, the size this card was measured to fit \(Smaller card · 960x544, 5 s\)\./);
  /* The 6 GB preview was never seen to fit: the words say so, not "measured to fit". */
  const six = plain.videoPlan({ prompt: "a lamp" }, { engineKey: "h3", eng, h3: status(6, 32) });
  assert.deepEqual([six.width, six.height], [832, 480]);
  assert.match(six.warnings.find((w) => w.id === "size").text, /this card's experimental preview size, not yet seen to fit \(Preview · 832x480, experimental\)/);
  assert.doesNotMatch(six.warnings.find((w) => w.id === "size").text, /measured to fit/);
  /* A card H3 is not offered on: said in the reply (the page asks before sending). */
  const four = plain.videoPlan({ prompt: "a lamp" }, { engineKey: "h3", eng, h3: status(4, 32) });
  assert.equal(four.refusal, null, "never refused behind the person's back");
  assert.equal(four.warnings.find((w) => w.id === "not-offered")?.text, status(4, 32).notOffered);
  const long = plain.videoPlan({ prompt: "a lamp", seconds: 8 }, { engineKey: "h3", eng, h3: status(8, 32) });
  assert.equal(long.seconds, 8, "a length that was asked for is kept; the fit line says what it needs");
  const named = plain.videoPlan({ prompt: "a lamp", width: 1344, height: 768, seconds: 8 }, { engineKey: "h3", eng, h3: status(8, 32) });
  assert.deepEqual([named.width, named.height], [1344, 768], "a named size is never replaced");
  assert.equal(named.warnings.find((w) => w.id === "size"), undefined);
  assert.equal(named.fit.over, true, "and the plan says 1344x768 for 8 s will not fit (the lab: it did not)");
  assert.equal(plain.videoPlan({ prompt: "a lamp", width: 1344, height: 768, seconds: 5 }, { engineKey: "h3", eng, h3: status(8, 32) }).fit.over,
    false, "where 5 s fits (the lab predicted 6,874 MiB)");
  assert.ok(named.warnings.some((w) => w.id === "fit"));
  const full = plain.videoPlan({ prompt: "a lamp" }, { engineKey: "h3", eng, h3: status(16, 32) });
  assert.deepEqual([full.width, full.height], [eng.width, eng.height], "a full card keeps the engine's own default (the Lab sets it)");
  assert.equal(full.warnings.length, 0);
  const ltx = plain.videoPlan({ prompt: "a lamp" }, { engineKey: "ltx", eng: config.video.engines.ltx, h3: status(8, 32) });
  assert.deepEqual([ltx.width, ltx.height], [config.video.engines.ltx.width, config.video.engines.ltx.height], "LTX has no H3 tiers");
  assert.equal(ltx.fit, null);
  const lowRam = plain.videoPlan({ prompt: "a lamp", width: 960, height: 544 }, { engineKey: "h3", eng, h3: status(16, 16) });
  assert.equal(lowRam.warnings.find((w) => w.id === "ram")?.text, tier.H3_RAM_WARNING, "under 32 GB of RAM, at render time");
});

test("§5 the plan: steps and sparse attention", () => {
  /* A disk with the Fast setting's file: without it 3 steps is refused
   * (taomate_test.js), and this section is about what Fast does. */
  const eng = { ...config.video.engines.h3, turboBuilds: { ...config.video.engines.h3.turboBuilds, three: true } };
  const refs = plain.videoPlan({ prompt: "<Picture 1> walks", steps: 3, refImages: ["a.png"] }, { engineKey: "h3", eng, h3: null });
  assert.equal(refs.steps, 4);
  assert.equal(refs.warnings.find((w) => w.id === "steps").text,
    "With references this runs 4 steps, not 3: the reference build that loads is a 4-step file, and it runs at its own step count.");
  assert.equal(refs.sparse, "off", "references stay dense");
  assert.equal(refs.warnings.find((w) => w.id === "sparse"), undefined, "the saved sol-attn is not a request: nothing to say");
  for (const n of [6, 7]) {
    const p = plain.videoPlan({ prompt: "<Picture 1> walks", steps: n, refImages: ["a.png"] }, { engineKey: "h3", eng, h3: null });
    assert.deepEqual([p.steps, p.warnings.length], [n, 0], `${n} steps with a reference runs ${n}, unsaid because unchanged`);
  }
  /* THE PAGE'S OWN DEFAULT RENDER: Standard, the card's size, nothing else
   * touched. The switch sits on the saved value, so no `sparse` is sent, and
   * the plan says nothing (it used to say "Sparse attention runs on the Fast
   * setting only" on every one). */
  for (const steps of [eng.stepDefaults?.standard ?? 8, 20]) {
    const page = plain.videoPlan({ prompt: "a lamp", width: 1344, height: 768, seconds: 5, steps },
      { engineKey: "h3", eng, h3: status(16, 32) });
    assert.deepEqual(page.warnings, [], `the page's default body at ${steps} steps carries no warning`);
    /* Only the "runs" line, the numbers behind the render (2026-09-24). */
    assert.deepEqual(page.notes.map((n) => n.id), ["runs"]);
  }
  /* Sol-attn at a size the lab never tried it at: a caveat on the Advanced line, not a warning. */
  const small = plain.videoPlan({ prompt: "a lamp", width: 960, height: 544, seconds: 5, steps: 3 }, { engineKey: "h3", eng, h3: status(8, 32) });
  assert.equal(small.sparse, "sol-attn");
  assert.equal(small.warnings.length, 0);
  assert.equal(small.notes.find((n) => n.id === "sparse-untried")?.text,
    "Sparse attention runs on this clip; it was measured at 1344x768 only, so its speed and look at 960x544 are not yet tried.");
  assert.deepEqual(plain.videoPlan({ prompt: "a lamp", width: 1344, height: 768, seconds: 8, steps: 3 }, { engineKey: "h3", eng, h3: status(16, 32) }).notes
    .filter((n) => n.id !== "runs"), [], "at the measured size: nothing to add but the runs line");
  assert.equal(plain.videoPlan({ prompt: "a lamp", steps: 3, sparse: "sol-attn" }, { engineKey: "h3", eng, h3: null, control: true }).sparse,
    "off", "video-to-video stays dense");
  const fast = plain.videoPlan({ prompt: "a lamp", steps: 3 }, { engineKey: "h3", eng, h3: null });
  assert.equal(fast.sparse, "sol-attn", "the Fast setting, the saved sol-attn");
  assert.equal(plain.videoPlan({ prompt: "a lamp", steps: 3, sparse: "off" }, { engineKey: "h3", eng, h3: null }).sparse, "off");
  /* An older page sent the saved value with every render: repeating it is not a request. */
  for (const steps of [8, 20]) {
    const echo = plain.videoPlan({ prompt: "a lamp", steps, sparse: eng.sparse }, { engineKey: "h3", eng, h3: null });
    assert.deepEqual([echo.sparse, echo.warnings], ["off", []], `the saved "${eng.sparse}" echoed at ${steps} steps: dense, unsaid`);
  }
  const std = plain.videoPlan({ prompt: "a lamp", steps: 8, sparse: "sol-attn" }, { engineKey: "h3", eng: { ...eng, sparse: "off" }, h3: null });
  assert.equal(std.sparse, "off");
  assert.match(std.warnings.find((w) => w.id === "sparse").text, /runs on the Fast setting \(the 3-step build, no references, no video-to-video\) only/,
    "sol-attn asked BY NAME on Standard: said, not silently dropped");
  const fh = plain.videoPlan({ prompt: "a lamp", steps: 3 }, { engineKey: "fasth3", eng: config.video.engines.fasth3, h3: null });
  assert.equal(fh.steps, 8, "FastH3 records its fixed 8");
  assert.equal(fh.sparse, null);
  assert.equal(fh.warnings.length, 0, "text to video, the path the lab ran: nothing to say");
  /* FastH3 was only tried on text to video: a frame is accepted, and said. */
  const fhFrame = plain.videoPlan({ prompt: "a lamp" }, { engineKey: "fasth3", eng: config.video.engines.fasth3, h3: null, framed: true });
  assert.equal(fhFrame.refusal, null);
  assert.equal(fhFrame.warnings.find((w) => w.id === "frames-untried")?.text, tier.H3_MORE_MOTION.framesUntried);
  assert.equal(plain.videoPlan({ prompt: "a lamp" }, { engineKey: "ltx", eng: config.video.engines.ltx, h3: null, framed: true })
    .warnings.length, 0, "LTX takes frames as it always has");
});

test("§5 the door renders the plan and says it; make_clip carries sparse and check_only", async () => {
  const index = read("./index.js");
  assert.match(index, /if \(b\.action === "check"\) \{[\s\S]{0,400}const plan = videoPlan\(b, \{ engineKey: gate\.engine, eng: videoEngine\(gate\.engine\),/);
  assert.match(index, /prompt: plan\.prompt,/);
  assert.match(index, /seconds: plan\.seconds,/);
  assert.match(index, /width: plan\.width,\n\s+height: plan\.height,/);
  assert.match(index, /steps: videoEngine\(eng\)\.fixedSteps \|\| plan\.steps,/);
  assert.match(index, /sparse: b\.sparse === "sol-attn" \|\| b\.sparse === "off" \? b\.sparse : undefined,/);
  assert.match(index, /return json\(res, 200, \{ ok: true, id, job: job && \{ id: job\.id \}, warnings: plan\.warnings, \.\.\.art\.status\(\),\s+character: plan\.character \?\? null, sampler: plan\.sampler \?\? null \}\);/);
  assert.match(index, /sparse: e\.solAttn \? \{ value: e\.sparse \?\? "off", options: \["sol-attn", "off"\], note: e\.solAttn\.note \} : null,/);
  assert.match(index, /advanced: e\.advanced \?\? null,/);
  assert.match(index, /h3Tiers: isH3Family\(k\),/, "which engines the tiers are about is the server's call");
  assert.match(index, /fastNote: fastNote\(e\),/);
  assert.match(index, /framed: !!\(firstFrame \|\| lastFrame\),\n\s+control: !!control\.video \}\);/, "the create plan knows the frames and a control video");
  assert.match(index, /control: !!\(b\.sourceVideo \|\| b\.source_video\) \}\);/, "and so does the check");
  assert.match(index, /return \{ \.\.\.h, start: h3StartSize\(h\), notOffered: h3NotOfferedLine\(h\) \};/);
  assert.match(index, /tierScope: config\.vramTierScope,/);
  const { TOOLS } = await import("./mcp.js");
  const t = TOOLS.find((x) => x.name === "make_clip");
  assert.deepEqual(t.inputSchema.properties.sparse.enum, ["sol-attn", "off"]);
  assert.match(t.inputSchema.properties.sparse.description, /about 1\.15x faster per clip, slightly softer picture; measured on a 16 GB card/);
  assert.equal(t.inputSchema.properties.check_only.type, "boolean");
  assert.match(t.inputSchema.properties.attention.description, /Default: kitchen/);
  const { videoLoraInput } = await import("./video-lora-validation.js");
  const { emptyResultNote } = await import("./art-wait.js");
  const run = (api) => new Function("api", "safeName", "waitForArt", "videoLoraInput", "emptyResultNote",
    `return (${String(t.run).replace(/^async run\(/, "async function(")});`)(api, (v) => v, async () => {}, videoLoraInput, emptyResultNote);
  const posts = [];
  const api = async (method, p, body) => {
    if (method === "POST") posts.push(body);
    if (p === "/api/status") return { config: { video: { enabled: false, ready: true, engine: "h3", engines: { h3: { label: "MiniMax H3" } } } } };
    if (p === "/api/clips") return { clips: [] };
    if (body?.action === "check") return { ok: true, engine: "h3", width: 960, height: 544, seconds: 5, steps: 3, sparse: "sol-attn",
      fit: { needGb: 5.2, haveGb: 8, over: false, sentence: "This size needs about 5.2 GB free", scope: "the lab" },
      warnings: [{ id: "ram", text: "the RAM line" }] };
    return { job: { id: "v1" }, warnings: [{ id: "size", text: "the size line" }] };
  };
  const c = await run(api)({ prompt: "a lamp", check_only: true, sparse: "sol-attn" });
  assert.equal(posts.at(-1).action, "check", "a check posts the check, with video switched off too");
  assert.equal(posts.at(-1).sparse, "sol-attn");
  assert.deepEqual(c.vram, { needs_about_gb: 5.2, card_gb: 8, fits: true, says: "This size needs about 5.2 GB free", measured: "the lab" });
  assert.deepEqual(c.warnings, ["the RAM line"]);
  assert.equal(c.would_render, true);
  await assert.rejects(run(api)({ prompt: "a lamp", check_only: true, engine: "ltx" }), /check_only reads the selected engine \(h3\) and switches nothing/);
});

/* ── §6 ─────────────────────────────────────────────────────────────────── */
test("§6 the page holds no opinion: no threshold, no size, no prose in web/vidfit.js", () => {
  /* Comments out, trailing ones too, and the escaping helper, whose regex holds
   * quote characters a literal scan would read as strings. */
  const code = strip(read("../web/vidfit.js")).replace(/\s\/\/ [^\n]*$/gm, "").replace(/^const esc = [^\n]*$/m, "");
  assert.deepEqual([...code.matchAll(/\b\d{1,3}\s*(?:GB|gb|MiB)\b/g)].map((m) => m[0]), [], "no memory figure typed in the page");
  assert.deepEqual([...code.matchAll(/\b(1344|960|832|768|544|480)\b/g)].map((m) => m[0]), [], "no tier size typed in the page");
  /* Every literal, consumed whole left to right, so a closing quote is never read as an opening one. */
  const strings = [...code.matchAll(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)]
    .map((m) => m[0].slice(1, -1)).filter((t) => t.length >= 50 && !t.includes("${"));
  assert.deepEqual(strings.filter((s) => /[a-z] [a-z]+ [a-z]+ [a-z]+ [a-z]/.test(s)), [], "every sentence comes off the wire");
  for (const f of ["h3.notOffered", "h3.choices", "h3.start", "h3?.ramWarning", "refsIgnored", "r.fit?.sentence", "sp.note",
    "?.h3Tiers", "c?.lengthSaid", "st.lengthSaid", "r.notes", "r.character"]) {
    assert.ok(code.includes(f), `reads ${f} from the server`);
  }
  assert.doesNotMatch(code, /MiniMax H3/, "which engines the tiers cover is not decided from a label in the page");
  assert.doesNotMatch(code, /"full"/, "nor is 'a full card keeps its size': the server sends no start for one");
  const html = read("../web/index.html"), app = read("../web/app.js"), css = read("../web/styles.css");
  for (const id of ["vidTierRow", "vidTierChips", "vidTierNote", "vidFitNote", "vidSparse", "vidSparseL", "vidSparseW",
    "vidMoreMotionRow", "vidMoreMotion", "vidMoreMotionL", "vidRefIgnored", "vidRamNote", "vidFail"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /<script type="module" src="vidfit\.js"><\/script>/);
  assert.match(css, /\.assist-on > [^{]*:not\(#vidTierRow\)[^{]* \{ display: none !important; \}/, "the size chips show in Simple");
  assert.match(app, /if \(typeof globalThis\.aiplayVidFit === "function"\) globalThis\.aiplayVidFit\(s\);/);
  /* FastH3 is in both engine lists by name since 2026-09-25 (it was hidden
   * behind a "More motion" switch). */
  assert.doesNotMatch(app, /o\.hidden = !!(?:s\.config\.video\.)?engines\??\.?\[o\.value\]\?\.advanced/, "no engine list hides FastH3");
  assert.match(app, /\$\("tierHint"\)\.textContent = t \? \[t\.note, state\.tierScope\]\.filter\(Boolean\)\.join\(" "\) : "";/,
    "the Graphics memory note says it restarts the engine for every model");
  /* Overnight's "clips made with" list: FastH3 by its label, as on the Video screen. */
  assert.match(app, /\$\("ovEngine"\)\.innerHTML = Object\.entries\(s\.config\.video\.engines\)\s+\.map\(\(\[k, e\]\) => '<option value="' \+ esc\(k\) \+ '">' \+ esc\(e\.advanced\?\.label \|\| e\.label\) \+ "<\/option>"\)\.join\(""\);/);
  /* The Fast chip's note is the server's, and never promises "as sharp" on its
   * own; while a character is kept it is the server's keepFast words instead. */
  assert.match(app, /\$\("vidQualityNote"\)\.textContent = keeping \? \(\(qs\.fast !== qs\.standard && eng\.keepFast\?\.note\) \|\| ""\) : \(eng\.fastNote \|\| ""\);/);
  assert.doesNotMatch(strip(app), /as sharp as the 8-step build/, "no second copy of the note in the page's code");
  /* Render: asks first where H3 is not offered, and names sparse only when it differs from the saved one. */
  assert.match(app, /if \(typeof globalThis\.aiplayVidAsk === "function" && !\(await globalThis\.aiplayVidAsk\(appConfirm\)\)\) return;\n[\s\S]{0,1600}?const \[width, height\] = vidWH\(\);\n\s+\$\("vidCreate"\)\.disabled = true;/,
    "asked before anything is sent");
  assert.match(app, /sparse: typeof globalThis\.aiplayVidSparse === "function" \? globalThis\.aiplayVidSparse\(\) : undefined,/);
  assert.doesNotMatch(app, /sparse: state\.video\?\.engine === "h3" && \$\("vidSparse"\)/, "the page's default is not sent as a request");
});

/* A stub DOM, only what vidfit.js touches. innerHTML is parsed for the two
 * shapes the file writes (<button> chips and <option>s). */
function stubDom() {
  const docOn = {};
  class El {
    constructor(id, tag = "div") {
      Object.assign(this, { id, tagName: tag.toUpperCase(), hidden: false, textContent: "", title: "", value: "", step: "16",
        checked: false, type: "", dataset: {}, options: [], _attrs: {}, _kids: [], _html: "", _on: {}, _pv: null });
      const cls = new Set();
      this.classList = { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) };
    }
    get innerHTML() { return this._html; }
    set innerHTML(h) {
      this._html = h; this._kids = [];
      for (const m of String(h).matchAll(/<(button|option)([^>]*)>([\s\S]*?)<\/\1>/g)) {
        const k = new El("", m[1]);
        k.textContent = m[3].replace(/&amp;/g, "&");
        for (const a of m[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
          const [, name, val = ""] = a;
          if (name.startsWith("data-")) k.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = val;
          else k._attrs[name] = val;
          if (name === "value") k.value = val;
        }
        this._kids.push(k);
      }
      if (this.tagName === "SELECT") { this.options = this._kids; this.value = this._kids[0]?.value ?? ""; }
    }
    get selectedOptions() { return this.options.filter((o) => o.value === this.value); }
    querySelectorAll(sel) { return /^button/.test(sel) ? this._kids.filter((k) => k.tagName === "BUTTON") : []; }
    setAttribute(k, v) { this._attrs[k] = String(v); }
    getAttribute(k) { return this._attrs[k] ?? null; }
    addEventListener(t, f) { (this._on[t] ||= []).push(f); }
    dispatchEvent(e) { e.target = this; for (const f of docOn[e.type] || []) f(e); for (const f of this._on[e.type] || []) f(e); return true; }
    closest(sel) { return sel === ".pv" ? this._pv : null; }
    focus() {}
  }
  const els = new Map();
  const add = (id, tag) => { const e = new El(id, tag); els.set(id, e); return e; };
  for (const id of ["vidEngine", "vidSize", "vidSparse", "vidAttn"]) add(id, "select");
  for (const id of ["vidSecs", "vidW", "vidH", "vidSteps", "vidPrompt", "vidMoreMotion"]) add(id, "input");
  for (const id of ["vidSparseL", "vidSparseW", "vidMoreMotionRow", "vidMoreMotionL", "vidTierRow", "vidTierChips", "vidTierNote",
    "vidFitNote", "vidRefIgnored", "vidRamNote", "vidFail", "vidPanel"]) add(id);
  els.get("vidSteps")._pv = new El("", "span");
  els.get("vidAttn").innerHTML = '<option value="pytorch">PyTorch</option><option value="kitchen">Kitchen INT8</option>';
  const refs = { img: [], aud: [] };
  const doc = {
    readyState: "complete",
    getElementById: (id) => els.get(id) || null,
    addEventListener: (t, f) => { (docOn[t] ||= []).push(f); },
    querySelectorAll: (sel) => [...(sel.includes("#vidRefImgPrev") ? refs.img : []), ...(sel.includes("#vidRefAudPrev") ? refs.aud : [])],
  };
  return { els, refs, doc, El };
}

test("§6 web/vidfit.js on three machines: chips, start size, the not-offered line, RAM, More motion, sparse, the fit line, a failure", async () => {
  const { els, refs, doc } = stubDom();
  const posted = [];
  let checkReply = {};
  Object.assign(globalThis, {
    document: doc,
    Event: class { constructor(type, o = {}) { this.type = type; this.bubbles = !!o.bubbles; this.isTrusted = false; } },
    MutationObserver: class { observe() {} },
    localStorage: { getItem: () => null },
    fetch: async (url, init) => { const body = JSON.parse(init.body); posted.push({ url, body }); return { json: async () => (url === "/api/video" ? checkReply : { ok: true }) }; },
  });
  await import("../web/vidfit.js");
  const paint = globalThis.aiplayVidFit;
  assert.equal(typeof paint, "function", "registered for app.js's status hook");
  const engines = Object.fromEntries(Object.entries(config.video.engines).map(([k, e]) => [k, {
    label: e.label, loraBase: e.loraBase ?? null, advanced: e.advanced ?? null,
    attention: e.sparseAttention ? (e.attention || "pytorch") : null,
    sparse: e.solAttn ? { value: e.sparse ?? "off", options: ["sol-attn", "off"], note: e.solAttn.note } : null,
    refsIgnored: plain.refsIgnored(k, e.label), h3Tiers: plain.isH3Family(k) }]));
  const sizes = (extra, k = "h3") => [...config.video.engines[k].sizes.map((z) => `<option value="${z.w}x${z.h}">${z.label}</option>`),
    `<option value="${extra}">custom…</option>`].join("");
  const vs = els.get("vidSize"), secs = els.get("vidSecs"), eng = els.get("vidEngine");
  eng.innerHTML = Object.entries(engines).map(([k, e]) => `<option value="${k}">${e.label}</option>`).join("");
  const st = (h3, over = {}) => ({ config: { video: { engine: eng.value, engines, h3, ...over } }, art: over.art || {} });
  /* What app.js does on an engine switch: the value, then the size list rebuilt for it, then the status. */
  const switchTo = (k, h3) => { eng.value = k; vs.innerHTML = sizes("custom", k); paint(st(h3)); };

  /* An 8 GB card, 32 GB of RAM, on H3. */
  eng.value = "h3"; vs.innerHTML = sizes("custom"); secs.value = "8";
  /* The first size is 1280x720 off NVIDIA (config.js prefers720p), else 1344x768. */
  const first = config.video.engines.h3.sizes[0];
  assert.equal(vs.value, `${first.w}x${first.h}`, "a new list sits on its own first size");
  paint(st(status(8, 32)));
  assert.equal(vs.value, "960x544", "the size list starts on the card's size");
  assert.equal(secs.value, "5", "and the length on its measured one");
  assert.match(els.get("vidTierNote").textContent, /^The length went down to 5 s, the longest measured to fit at 960x544/,
    "and says it shortened the clip");
  const chips = els.get("vidTierChips").querySelectorAll("button[data-tier]");
  assert.deepEqual(chips.map((b) => b.textContent), ["Smaller card · 960x544, 5 s", "Preview · 832x480, experimental"]);
  assert.deepEqual(chips.map((b) => b.getAttribute("aria-pressed")), ["true", "false"], "the chip on the size is lit");
  assert.equal(chips[0].getAttribute("title"), "Smaller size: 960x544, 5 s", "each chip's tooltip names its length");
  assert.equal(els.get("vidTierRow").hidden, false);
  assert.equal(els.get("vidRamNote").hidden, true, "32 GB of RAM: no RAM line");

  /* THE ROUND TRIP the review found: H3, LTX, back to H3 rebuilds the same
   * list, and it must start on the card's size again, not on 1344x768. */
  switchTo("ltx", status(8, 32));
  assert.equal(vs.value, "1280x704", "LTX keeps its own list");
  switchTo("h3", status(8, 32));
  assert.equal(vs.value, "960x544", "back on H3 the list follows the card again");
  switchTo("fasth3", status(8, 32));
  assert.equal(vs.value, "960x544", "and on FastH3");
  switchTo("h3", status(8, 32));
  /* A size the person picked is theirs: a repaint with the same list keeps it. */
  vs.value = "1344x768";
  paint(st(status(8, 32)));
  assert.equal(vs.value, "1344x768", "the person's own pick is never pulled back");
  /* THE UNREAD CARD: a first status before nvidia-smi answers chooses nothing,
   * and the reading, when it lands, still moves an untouched list. */
  eng.value = "h3"; vs.innerHTML = sizes("custom");
  paint(st(status(0, 32)));
  assert.equal(vs.value, `${first.w}x${first.h}`, "card not read yet: no size chosen");
  paint(st(status(8, 32)));
  assert.equal(vs.value, "960x544", "the card read: the untouched list moves to its size");

  /* A chip writes the real size list. */
  els.get("vidTierChips")._on.click[0]({ target: { closest: () => els.get("vidTierChips").querySelectorAll("button[data-tier]")[1] } });
  assert.equal(vs.value, "832x480", "the Preview chip set the size list");
  /* The old More motion switch is retired: FastH3 is in the engine list by name. */
  assert.equal(els.get("vidMoreMotionRow").hidden, true);
  /* Sparse: the saved value and the server's numbers; a render names nothing
   * while the switch says what is saved. */
  const sp = els.get("vidSparse");
  assert.deepEqual(sp.options.map((o) => o.value), ["sol-attn", "off"]);
  assert.equal(sp.value, "sol-attn");
  assert.match(sp.title, /about 1\.15x faster per clip, slightly softer picture; measured on a 16 GB card/);
  assert.equal(els.get("vidSparseW").hidden, false);
  assert.equal(globalThis.aiplayVidSparse(), undefined, "the saved default is not sent as a request");
  sp.value = "off";
  sp.dispatchEvent(Object.assign(new Event("change"), { isTrusted: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(posted.find((p) => p.url === "/api/videolab")?.body, { action: "set_knob", id: "sparse_attention", value: "off" },
    "the same saved value video_settings reads");
  assert.equal(globalThis.aiplayVidSparse(), "off", "until the save shows in the status, a render names the pick");
  /* FastH3's attention starts on the server's default. */
  assert.equal(els.get("vidAttn").value, "kitchen");
  /* The fit line: POST /api/video check, its sentence, warnings and notes; not the lines that have their own place. */
  checkReply = { ok: true, fit: { sentence: "NEEDS", scope: "SCOPE" },
    warnings: [{ id: "steps", text: "STEPS" }, { id: "ram", text: "RAM" }, { id: "not-offered", text: "NOPE" }],
    notes: [{ id: "sparse-untried", text: "UNTRIED" }] };
  secs.value = "5"; secs.dispatchEvent(new Event("input"));
  await new Promise((r) => setTimeout(r, 500));
  const asked = posted.filter((p) => p.url === "/api/video").at(-1)?.body;
  assert.equal(asked?.action, "check");
  assert.deepEqual([asked.width, asked.height, asked.seconds], [832, 480, 5], "the form's own values");
  assert.equal(asked.sparse, "off");
  assert.equal(els.get("vidFitNote").textContent, "NEEDS STEPS UNTRIED");
  assert.equal(els.get("vidFitNote").title, "SCOPE");
  assert.equal(els.get("vidFitNote").hidden, false);
  /* The save lands: the switch follows the saved value, and a render names nothing again. */
  engines.h3.sparse.value = "off";
  paint(st(status(8, 32)));
  assert.equal(sp.value, "off");
  assert.equal(globalThis.aiplayVidSparse(), undefined);
  /* An agent sets it back (video_settings): the switch follows; the page never overrides a saved change. */
  engines.h3.sparse.value = "sol-attn";
  paint(st(status(8, 32)));
  assert.equal(sp.value, "sol-attn", "the switch follows a saved change it did not make");
  assert.equal(globalThis.aiplayVidSparse(), undefined);

  /* A 16 GB card, 16 GB of RAM: full size stays, every chip, the RAM line. */
  vs.innerHTML = sizes("custom2"); vs.value = "1344x768"; secs.value = "8";
  paint(st(status(16, 16)));
  assert.equal(vs.value, "1344x768", "a full card keeps the native size");
  assert.equal(secs.value, "8");
  assert.equal(els.get("vidTierChips").querySelectorAll("button[data-tier]").length, 3);
  assert.equal(els.get("vidRamNote").hidden, false);
  assert.equal(els.get("vidRamNote").textContent, tier.H3_RAM_WARNING);
  let question = null;
  assert.equal(await globalThis.aiplayVidAsk(async (m) => { question = m; return false; }), true, "H3 is offered: Render asks nothing");
  assert.equal(question, null);

  /* A 4 GB card: the one sentence, no chips, and Render asks first. */
  paint(st(status(4, 32)));
  assert.equal(els.get("vidTierChips").hidden, true);
  assert.equal(els.get("vidTierNote").textContent, status(4, 32).notOffered);
  assert.equal(els.get("vidTierNote").hidden, false);
  assert.equal(await globalThis.aiplayVidAsk(async (m, o) => { question = [m, o]; return false; }), false, "declined: nothing is sent");
  assert.deepEqual(question, [status(4, 32).notOffered, { ok: "Render anyway", cancel: "Cancel" }], "the server's sentence, as a question");
  assert.equal(await globalThis.aiplayVidAsk(async () => true), true, "confirmed: it renders, never a silent stop");

  /* LTX: no H3 row, no sparse switch, no More motion, nothing asked. */
  eng.value = "ltx";
  paint(st(status(4, 32)));
  assert.equal(els.get("vidTierRow").hidden, true);
  assert.equal(els.get("vidSparseW").hidden, true);
  assert.equal(els.get("vidMoreMotionRow").hidden, true);
  assert.equal(await globalThis.aiplayVidAsk(async () => false), true, "LTX is not about H3's card");

  /* A failed render since the page opened: the sentence, the engine's text under Details. */
  eng.value = "h3";
  paint(st(status(16, 32), { art: { recent: [{ id: "j9", kind: "video", title: "a lamp", at: Date.now() + 5,
    error: "The card ran out of memory at this size; pick the smaller size or close GPU-heavy apps.", detail: '{"x":"<OOM>"}' }] } }));
  const fail = els.get("vidFail");
  assert.equal(fail.hidden, false);
  assert.match(fail.innerHTML, /a lamp: The card ran out of memory at this size/);
  assert.match(fail.innerHTML, /<details><summary>Details<\/summary><pre>\{&quot;x&quot;:&quot;&lt;OOM&gt;&quot;\}<\/pre><\/details>/);
  paint(st(status(16, 32), { art: { recent: [{ id: "old", kind: "video", at: 1, error: "x" }] } }));
  assert.equal(fail.hidden, true, "a failure older than the page is not news");
  refs.img.length = 0;
});

/* ── §7 ─────────────────────────────────────────────────────────────────── */
test("§7 one control per value: the Video Lab mirrors the form's steps, audio and sparse switch", async () => {
  const { KNOBS, knobRows } = await import("./videolab/catalog.js");
  const html = read("../web/index.html");
  const want = { steps: "vidSteps", drop_audio: "vidAudio", sparse_attention: "vidSparse" };
  for (const [id, control] of Object.entries(want)) {
    assert.equal(KNOBS.find((k) => k.id === id)?.formControl, control, `${id} names the form's ${control}`);
    assert.match(html, new RegExp(`id="${control}"`), `${control} is on the page`);
  }
  assert.equal(knobRows("h3").find((k) => k.id === "steps").formControl, "vidSteps", "the rows carry it to the page and the tool");
  const sp = KNOBS.find((k) => k.id === "sparse_attention");
  assert.deepEqual(sp.path, ["video", "engines", "h3", "sparse"]);
  assert.deepEqual(sp.options, ["sol-attn", "off"]);
  const lab = read("../web/videolab.js");
  assert.match(lab, /const mirror = k\.formControl \? \$\(k\.formControl\) : null;\n\s+if \(mirror\) \{/, "a mirrored row draws no control of its own");
  assert.match(lab, /\} else if \(k\.kind === "bool"\) \{/);
  /* Set the form's control, and the Lab's row follows: the two functions,
   * lifted and run with a stub page. */
  const src = ["mirrorText", "paintMirrors"].map((n) => new RegExp(`\\nfunction ${n}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(lab)?.[0] || "").join("\n");
  const page = {
    vidSteps: { type: "range", value: "3" },
    vidAudio: { tagName: "SELECT", value: "0", get selectedOptions() { return [{ textContent: this.value === "0" ? "Discard it" : "Keep it" }]; } },
  };
  const rows = ["vidSteps", "vidAudio"].map((id) => ({ textContent: "", parentElement: { dataset: { mirror: id } } }));
  const document = { querySelectorAll: () => rows };
  const { paintMirrors } = new Function("$", "document", `${src}\nreturn { paintMirrors };`)((id) => page[id], document);
  paintMirrors();
  assert.deepEqual(rows.map((r) => r.textContent), ["3", "Discard it"]);
  page.vidSteps.value = "8"; page.vidAudio.value = "1";
  paintMirrors();
  assert.deepEqual(rows.map((r) => r.textContent), ["8", "Keep it"], "the form moved, the Lab says so");
  assert.match(lab, /for \(const id of \["vidSteps", "vidAudio", "vidSparse"\]\) \{\n\s+\$\(id\)\?\.addEventListener\("input", paintMirrors\);/);
});
