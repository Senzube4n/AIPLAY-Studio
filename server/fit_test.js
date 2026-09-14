/**
 * DOES THIS MACHINE RUN IT — the gate on the answer.
 *
 * Every claim this suite makes is about a machine that is not the one running
 * it. That is the point. The rig this app is developed on is a 16 GB RTX 4070
 * Ti SUPER with 32 GB of RAM and every model already downloaded — which is
 * precisely the machine on which a hardware recommendation cannot be wrong in
 * any way you would notice. The people it can be wrong for are on an 8 GB card,
 * or on a MacBook, or on a fresh disk, and none of them are here.
 *
 * So `fitFor` and `recommendFor` take a machine-shaped OBJECT rather than
 * calling gpuStatus() themselves, and this suite hands them three:
 *
 *   1. THIS RIG            16 GB card, 32 GB RAM — everything runs, one thing streams.
 *   2. AN 8 GB CARD        16 GB RAM — no video at all, and it has to say so.
 *   3. NO NVIDIA CARD      nvidia-smi returns nothing. "Cannot tell", never "no".
 *
 * The capabilities are built from the real CATALOG with every file marked
 * ABSENT, because the interesting reader is the one who has just installed and
 * downloaded nothing. Nothing here touches the disk, the GPU or the network.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE ONE THAT MATTERS MOST is `never recommends a model Studio cannot
 * download`. The shipped default video engine was LTX 2.5 for months, and LTX
 * 2.5 is access-gated — so a fresh install's first click on the Video page hit
 * "not downloaded yet, open the Models screen", where there is no button for
 * it. Every check in the GATED section exists so that cannot be reintroduced by
 * an edit that looks entirely reasonable.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Runs standalone (`node server/fit_test.js`) and in the pre-commit hook.
 */
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { readMachine, fitFor, recommendFor, bytesFor, FIT_STATES } from "./fit.js";
import { CATALOG, MODEL_TO_CAPABILITY, isPictureModel, modelLabel, modelPageUrl, engineFromModelFile } from "./models.js";
import { config } from "./config.js";
import { resolveVideoEngine } from "./workflow.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

/* ── the fresh install ─────────────────────────────────────────────────────
 * The catalogue as ModelManager.status() would report it on a machine that has
 * downloaded nothing and pip-installed nothing. Built from CATALOG rather than
 * typed, so a capability added tomorrow is judged by every rule below without
 * anybody remembering to add it here. */
function freshInstall() {
  return CATALOG.map((c) => ({
    id: c.id,
    /* Carried because ModelManager.status() carries it — the whole value of
     * `makes` is that one predicate answers the same way about a catalogue row
     * and about the live row derived from it. */
    makes: c.makes || null,
    label: c.label,
    licence: c.licence,
    outputRights: c.outputRights || null,
    region: c.region || null,
    gated: c.gated || null,
    requires: c.requires || null,
    needsPackage: c.needsPackage || null,
    packageInstall: c.packageInstall || null,
    packageReady: !c.needsPackage,
    required: !!c.required,
    files: (c.files || []).map((f) => ({ name: path.basename(f.dest), bytes: f.bytes, present: false })),
    totalBytes: (c.files || []).reduce((n, f) => n + f.bytes, 0) || c.approxBytes || 0,
    haveBytes: 0,
    ready: false,
  }));
}

const MACHINES = {
  /* nvidia-smi's REAL numbers for these cards, not the marketing ones: a 16 GB
   * card reports 16376 MiB. Using 16384 here would have hidden the rounding bug
   * that this suite's `rounding` section exists to pin. */
  rig: readMachine(
    { name: "NVIDIA GeForce RTX 4070 Ti SUPER", totalMb: 16376, usedMb: 2100, note: "driver" },
    { totalMb: 32659, usedMb: 14000 }),
  small: readMachine(
    { name: "NVIDIA GeForce RTX 3060 Ti", totalMb: 8188, usedMb: 700, note: "driver" },
    { totalMb: 16310, usedMb: 9000 }),
  noCard: readMachine(null, { totalMb: 32659, usedMb: 12000 }),
};

const rec = {};
for (const [name, machine] of Object.entries(MACHINES)) {
  const capabilities = freshInstall().map((c) => ({ ...c, fit: fitFor(c.requires, machine) }));
  rec[name] = { machine, capabilities, out: recommendFor({ capabilities, machine, disk: { freeBytes: 900e9 } }) };
}
const fitOf = (m, id) => rec[m].capabilities.find((c) => c.id === id).fit.state;
const pickOf = (m, slot) => rec[m].out.picks.find((p) => p.slot === slot) || null;

console.log("\n── the machine reading ──────────────────────────────────────────");

ok("a 16 GB card reports as 16 GB, not 15.99",
  MACHINES.rig.gpu.vramGb === 16,
  `got ${MACHINES.rig.gpu.vramGb} from 16376 MiB`);
ok("...and an 8 GB one as 8", MACHINES.small.gpu.vramGb === 8);
ok("no nvidia-smi reading is a null card, not a zero-GB one",
  MACHINES.noCard.gpu === null && MACHINES.noCard.reading === "none");
ok("...and it says what was looked for, by name",
  /nvidia-smi/.test(MACHINES.noCard.readingNote) && /NVIDIA/.test(MACHINES.noCard.readingNote),
  MACHINES.noCard.readingNote);

/* THE ROUNDING BUG, pinned on its own because it is invisible in every output.
 * H3's minimum is 16 GB and a 16 GB card reports 16376 MiB = 15.99 GB. A raw
 * comparison files it as below-minimum — a plausible-looking answer that is
 * wrong for every card ever manufactured. */
console.log("\n── the rounding that decides every 16 GB card ───────────────────");
ok("a real 16 GB card clears a 16 GB minimum",
  fitFor({ vramMinGb: 16, vramRecGb: 24, ramMinGb: 32, ramRecGb: 64 }, MACHINES.rig).state !== "wont-run",
  "16376 MiB must not read as under 16 GB");
ok("...and a 12 GB card still does not",
  fitFor({ vramMinGb: 16, vramRecGb: 16, ramMinGb: 8, ramRecGb: 8 },
    readMachine({ name: "RTX 4070", totalMb: 12282, usedMb: 0 }, { totalMb: 32659, usedMb: 0 })).state === "wont-run");

console.log("\n── 1. this rig: 16 GB card, 32 GB RAM ──────────────────────────");

ok("the music engine fits", fitOf("rig", "engine") === "fits");
ok("H3 runs but streams — 16 GB is its minimum, 24 GB its recommendation",
  fitOf("rig", "video") === "streams", fitOf("rig", "video"));
ok("Z-Image fits", fitOf("rig", "imageZImage") === "fits");
ok("a video engine IS recommended", !!pickOf("rig", "video"));
ok("...and it is the one Studio can download, not the gated one",
  pickOf("rig", "video").id === "video", pickOf("rig", "video")?.id);
ok("...and its reason carries the territory condition rather than burying it",
  /European Union/.test(pickOf("rig", "video").why) && /United States of America/.test(pickOf("rig", "video").why));
ok("an image engine is recommended, on an unrestricted licence",
  pickOf("rig", "image")?.outputRights?.class === "unrestricted",
  pickOf("rig", "image")?.outputRights?.class);
ok("the selected music engine is recommended, without requiring a second music model",
  !!pickOf("rig", "music") && pickOf("rig", "music").id === (MODEL_TO_CAPABILITY[config.music.engine] || "engine")
    && rec.rig.out.picks.filter(p => p.slot === "music").length === 1);
ok("the headline names the card and the download size",
  /4070 Ti SUPER/.test(rec.rig.out.headline) && /GB to download/.test(rec.rig.out.headline),
  rec.rig.out.headline);

console.log("\n── 2. an 8 GB card, 16 GB RAM ──────────────────────────────────");

ok("H3 will not run — 8 GB against a 16 GB minimum",
  fitOf("small", "video") === "wont-run", fitOf("small", "video"));
ok("LTX will not run either", fitOf("small", "videoLtx") === "wont-run");
ok("NO video engine is recommended", pickOf("small", "video") === null);
ok("...and that refusal is explained rather than left as a gap",
  rec.small.out.notes.some((n) => n.slot === "video" && /No video engine/.test(n.headline)));
ok("music still runs, by streaming from RAM", fitOf("small", "engine") === "streams");
ok("...and is still recommended, because the app does not work without it",
  !!pickOf("small", "music"));
ok("an image engine is still recommended", !!pickOf("small", "image"));
ok("the 8 GB machine is quoted a SMALLER download than the 16 GB one",
  rec.small.out.missingBytes < rec.rig.out.missingBytes,
  `${(rec.small.out.missingBytes / 1e9).toFixed(1)} GB vs ${(rec.rig.out.missingBytes / 1e9).toFixed(1)} GB`);
ok("...which is the whole point: the three machines get three different answers",
  new Set([rec.rig.out.headline, rec.small.out.headline, rec.noCard.out.headline]).size === 3);

console.log("\n── 3. no NVIDIA card ───────────────────────────────────────────");

ok("every VRAM verdict is 'cannot tell', never 'no'",
  rec.noCard.capabilities.every((c) => c.fit.state === "unknown"),
  rec.noCard.capabilities.filter((c) => c.fit.state !== "unknown").map((c) => `${c.id}=${c.fit.state}`).join(", "));
ok("...and each established model says the card could not be read; experimental models remain unverified",
  rec.noCard.capabilities.every((c) => c.requires?.experimental
    ? /minimum hardware floor has not been established/.test(c.fit.why)
    : /could not be read/.test(c.fit.why)));
ok("the headline refuses to recommend rather than guessing",
  /could not read/.test(rec.noCard.out.headline) && /nvidia-smi/.test(rec.noCard.out.headline),
  rec.noCard.out.headline);
ok("...while still reporting the one number it does know",
  /32 GB of system RAM/.test(rec.noCard.out.headline));

/* A machine with no card but genuinely too little RAM is still answerable, and
 * answering it is not a guess: the RAM floor is missed whatever the card is. */
const thinRam = readMachine(null, { totalMb: 8192, usedMb: 4000 });
ok("a no-card machine that misses the RAM floor is still told so",
  fitFor({ vramMinGb: 16, vramRecGb: 24, ramMinGb: 32, ramRecGb: 64 }, thinRam).state === "wont-run",
  "8 GB of RAM against a 32 GB minimum is decided without knowing the card");

console.log("\n── the gated model must never be recommended ────────────────────");

/* Six machines, including two absurd ones, because this is the rule that broke.
 * A recommendation is a button somebody presses; there is no button for a gated
 * repo, and there deliberately never will be. */
const ALL = [
  ...Object.values(MACHINES),
  readMachine({ name: "RTX 5090", totalMb: 32760, usedMb: 0 }, { totalMb: 131072, usedMb: 0 }),
  readMachine({ name: "GTX 1050", totalMb: 2048, usedMb: 0 }, { totalMb: 8192, usedMb: 0 }),
  readMachine({ name: "A100", totalMb: 81920, usedMb: 0 }, { totalMb: 524288, usedMb: 0 }),
];
const gatedIds = CATALOG.filter((c) => c.gated).map((c) => c.id);
ok(`the catalogue still has a gated capability to guard against (${gatedIds.join(", ")})`,
  gatedIds.length > 0);

let leaked = [];
for (const machine of ALL) {
  const capabilities = freshInstall().map((c) => ({ ...c, fit: fitFor(c.requires, machine) }));
  const out = recommendFor({ capabilities, machine, disk: { freeBytes: 900e9 } });
  for (const p of out.picks) if (gatedIds.includes(p.id)) leaked.push(`${machine.gpu?.name || "no card"} -> ${p.id}`);
}
ok("no machine, however large, is ever recommended a gated model",
  leaked.length === 0, leaked.join("; "));

ok("the gated one is still MENTIONED, with the publisher's own hand-fetch steps",
  rec.rig.out.notes.some((n) => n.slot === "video-gated" && /hf auth login/.test(n.detail)),
  "a model somebody could get by hand should not vanish from the page");

/* ── and the default that started it ──────────────────────────────────────
 *
 * ⚠ READ FROM THE SOURCE TEXT, not from `config.video.engine`, and the first
 * version of this check did the latter and was therefore worthless. A saved
 * `video.engine` in settings.json overrides the shipped default at import — so
 * on any machine whose owner has ever touched the dropdown (which is every
 * development machine, and none of the fresh installs this rule protects) the
 * runtime value is the developer's own choice. Reintroducing `engine: "ltx"`
 * into config.js passed this suite 46/46 until it was changed to parse the
 * literal, which is exactly the failure mode the check exists to prevent.
 *
 * provenance_test.js reads PREF_PATHS out of the same file the same way, for
 * the same reason: what SHIPS is a fact about the source, not about this disk. */
const CONFIG_SRC = readFileSync(new URL("./config.js", import.meta.url), "utf8");
/* ⚠ ANCHORED TO THE VIDEO BLOCK, because `engine: "...", engines: { ... }` is no
 * longer a shape only the video config has. A second music engine gave
 * config.music the same two keys, and config.music sits ABOVE config.video in
 * the file — so the unanchored pattern matched the MUSIC default and this suite
 * then cheerfully asserted that "minimax-music3" is a video engine Studio can
 * download. It is, as it happens, which is why only the canary below caught it:
 * the check it guards was passing on the wrong value, which is the exact
 * vacuous pass it was written to make impossible. Anchor first, then match. */
const VIDEO_AT = CONFIG_SRC.indexOf("\n  video: {");
const shippedEngine = VIDEO_AT < 0 ? undefined
  : CONFIG_SRC.slice(VIDEO_AT).match(/\s*engine:\s*"([a-z0-9-]+)",\s*engines:\s*\{/)?.[1];
ok("the shipped video default can be read out of config.js at all",
  !!shippedEngine && shippedEngine in config.video.engines,
  `parsed ${JSON.stringify(shippedEngine)} — if this breaks, the check below is passing on nothing`);
const defaultCap = CATALOG.find((c) => c.id === MODEL_TO_CAPABILITY[shippedEngine]);
ok(`the SHIPPED default video engine (${shippedEngine}) is one Studio can download`,
  !!defaultCap && !defaultCap.gated,
  "This is the defect itself: a default naming a gated model sends every fresh "
  + "install to a Models screen with no button on it.");

ok("every engine in config.video.engines maps to a real capability",
  Object.keys(config.video.engines).every((k) => CATALOG.some((c) => c.id === MODEL_TO_CAPABILITY[k])),
  Object.keys(config.video.engines).filter((k) => !CATALOG.some((c) => c.id === MODEL_TO_CAPABILITY[k])).join(", "));

console.log("\n── resolveVideoEngine, on a machine holding nothing ─────────────");

/* Point the rig at an empty folder so videoReady() finds no weights — the exact
 * state of a fresh install, reproduced without deleting anything. `config` is a
 * plain mutable object; restored below. */
const realRig = config.rig;
config.rig = path.join(os.tmpdir(), "aiplay-fit-test-no-models");
try {
  const r = resolveVideoEngine();
  ok("with no weights anywhere, it does not claim to be ready", r.ready === false);
  ok("...it leaves the user's saved choice alone",
    r.key === config.video.engine && r.substituted === false,
    `key=${r.key} configured=${r.configured}`);
  ok("...and it names an engine to GET that Studio can actually fetch",
    !!r.get && !CATALOG.find((c) => c.id === r.get.capabilityId)?.gated,
    JSON.stringify(r.get));
  ok("...with the licence condition that download will demand",
    !!r.get?.region?.excluded?.length,
    "H3 needs a territory acknowledgement; suggesting it without one bounces at the downloader");
  ok("...and the gated engine appears as an aside, not as the instruction",
    Array.isArray(r.alsoGated) && r.alsoGated.some((g) => g.how),
    JSON.stringify(r.alsoGated));
  ok("the sentence it hands the UI is a whole sentence",
    typeof r.why === "string" && r.why.length > 40 && /Models screen/.test(r.why), r.why);
} finally {
  config.rig = realRig;
}

console.log("\n── what counts as a picture model ──────────────────────────────");

/* ⚠ THE SUITE THAT STAYED GREEN. On 2026-09-03 this file passed 47/0 while
 * recommendFor() was telling a 16 GB machine that WAN 2.1 VACE — a video
 * ControlNet — was its picture model, because IMAGE_IDS was a SUBTRACTION:
 * every value in MODEL_TO_CAPABILITY, minus the video engines, minus the
 * required music one. A subtraction has an answer for kinds nobody has written
 * yet, and the answer is always "picture". Nothing here could see it, since
 * welcome/catalogue.js derived the identical wrong set and agreed.
 *
 * fit.js asks models.js's isPictureModel() now, and these are the checks that
 * would notice it going back. The planted row is the point: a capability of a
 * kind this repo has no concept of, made as attractive to the ranker as a row
 * can be — already downloaded, fits, unrestricted, costs nothing — so that if
 * the picture set were still open by default it would win the slot outright. */
const planted = {
  id: "__notARealCapability__",
  label: "Something — a capability kind nobody has thought of yet",
  makes: "cromulence",
  licence: "Apache-2.0",
  outputRights: { class: "unrestricted", sellable: true, quote: "", clause: "", url: "" },
  requires: { vramMinGb: 1, vramRecGb: 1, ramMinGb: 1, ramRecGb: 1 },
  files: [], needsPackage: null, packageInstall: null, packageReady: true,
  required: false, region: null, gated: null,
  totalBytes: 0, haveBytes: 0, ready: true,
};
ok("a capability of an unrecognised kind is not a picture model",
  !isPictureModel(planted) && !isPictureModel({ id: "silent" }) && !isPictureModel({}));
ok("...and the five that are, say so on the row",
  CATALOG.filter(isPictureModel).map((c) => c.id).join(",")
    === "coverArt,imageIdeogram,imageZImage,imageZImageBase,imageAnima",
  CATALOG.filter(isPictureModel).map((c) => c.id).join(", "));

{
  const capabilities = [...freshInstall(), planted]
    .map((c) => ({ ...c, fit: fitFor(c.requires, MACHINES.rig) }));
  const out = recommendFor({ capabilities, machine: MACHINES.rig, disk: { freeBytes: 900e9 } });
  ok("...so a planted one is never picked, on the machine it would win on",
    !out.picks.some((p) => p.id === planted.id),
    out.picks.map((p) => `${p.slot}=${p.id}`).join(", "));
  ok("...and the recommendation is byte-identical to the one without it",
    JSON.stringify(out) === JSON.stringify(rec.rig.out),
    "a row of an unknown kind changed the answer for a 16 GB machine");
}

/* The control pair is the real instance of that planted row, and it is now in
 * MODEL_TO_CAPABILITY — which is what used to break this. Named explicitly
 * because these two are the models the defect was measured on. */
ok("neither control model is a picture model",
  !isPictureModel(CATALOG.find((c) => c.id === "videoControl"))
  && !isPictureModel(CATALOG.find((c) => c.id === "posePreprocess")));
ok("...and no machine is recommended one for any slot",
  Object.values(rec).every((r) => !r.out.picks.some((p) => ["videoControl", "posePreprocess"].includes(p.id))),
  Object.entries(rec).map(([m, r]) => `${m}: ${r.out.picks.map((p) => `${p.slot}=${p.id}`).join("/")}`).join(" | "));

console.log("\n── the arithmetic ──────────────────────────────────────────────");

/* The 8 GB error. qwen_3_4b.safetensors belongs to three capabilities; adding
 * their totals quotes a newcomer a download that does not exist. */
const shared = ["coverArt", "imageZImage"].map((id) => freshInstall().find((c) => c.id === id));
const naive = shared.reduce((n, c) => n + c.totalBytes, 0);
const deduped = bytesFor(shared);
ok("a file two models share is counted once",
  deduped.totalBytes < naive && deduped.sharedBytes > 7e9,
  `naive ${(naive / 1e9).toFixed(1)} GB, deduped ${(deduped.totalBytes / 1e9).toFixed(1)} GB, `
  + `shared ${(deduped.sharedBytes / 1e9).toFixed(1)} GB`);
ok("one model on its own shares nothing", bytesFor([shared[0]]).sharedBytes === 0);
ok("...and the note explaining the discrepancy appears if and only if there is one",
  (rec.rig.out.sharedBytes > 0) === (rec.rig.out.bytesNote !== null),
  `sharedBytes=${rec.rig.out.sharedBytes} bytesNote=${rec.rig.out.bytesNote === null ? "null" : "present"}`);

ok("every pick names a capability that really exists",
  Object.values(rec).every((r) => r.out.picks.every((p) => CATALOG.some((c) => c.id === p.id))));
ok("every fit state is one of the four declared ones",
  Object.values(rec).every((r) => r.capabilities.every((c) => c.fit.state in FIT_STATES)));
ok("the pip-package capabilities carry the line a person types",
  rec.rig.out.packages.filter((k) => k.needsPackage).every((k) => typeof k.install === "string" && /pip install/.test(k.install)),
  rec.rig.out.packages.map((k) => `${k.id}=${k.install}`).join(", "));

// Every engine name the image route accepts must resolve a label and a page link.
// The engine table is derived from the capability map now; this is the check that
// would have caught anima, which was accepted, recorded and shown unlabelled. Where
// the catalogue ships the engine's diffusion weight, the file resolver must name it too.
{
  const pictureEngines = Object.entries(MODEL_TO_CAPABILITY)
    .filter(([, id]) => isPictureModel(CATALOG.find((c) => c.id === id))).map(([k, id]) => [k, CATALOG.find((c) => c.id === id)]);
  ok("anima is a picture engine in the map", pictureEngines.some(([k]) => k === "anima"));
  ok(`five or more picture engines (${pictureEngines.map(([k]) => k).join(", ")})`, pictureEngines.length >= 5);
  for (const [engine, cap] of pictureEngines) {
    const label = modelLabel({ engine });
    ok(`${engine} resolves a catalogue label, not its own name (${label})`, !!label && label !== engine);
    ok(`${engine} resolves a model page (${modelPageUrl({ engine })})`, /^https:\/\/huggingface\.co\/[^/]+\/[^/]+$/.test(modelPageUrl({ engine }) || ""));
    const weight = (cap.files || []).map((f) => String(f.dest || "").split("\\").join("/")).find((d) => /\/(diffusion_models|unet)\//i.test(d));
    if (weight) ok(`${engine}'s shipped weight ${weight.split("/").pop()} resolves back to ${engine}`, engineFromModelFile(weight) === engine);
  }
}
const previousMusicOnly = config.musicOnly, previousMusicEngine = config.music.engine;
config.musicOnly = true; config.music.engine = "yue2-gguf";
try {
  const native = recommendFor({capabilities:rec.small.capabilities,machine:MACHINES.small,disk:{freeBytes:900e9}});
  ok("native music-only recommends exactly its own kit, without Python/image/video packages",
    native.picks.length === 1 && native.picks[0].id === "musicYue2Gguf" && native.packages.length === 0);
  ok("an 8 GB native recommendation remains experimental, not a fit guarantee",
    native.picks[0].fit.state === "unknown" && native.picks[0].fit.needVramGb === null);
} finally {config.musicOnly = previousMusicOnly; config.music.engine = previousMusicEngine;}
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
