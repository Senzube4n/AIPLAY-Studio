/**
 * THE CONTROL PAIR'S CATALOGUE ROWS — the licence claim, and the rule that lets
 * them be mapped without becoming somebody's recommended picture model.
 *
 * WHY THIS SUITE EXISTS. WAN 2.1 VACE and the DWPose pair passed two gates on
 * this rig — a camera gate at CMA 0.924 and a pose gate at 33.7 px against a
 * 119.9 px null — while being catalogued nowhere at all. server/control/vace.js
 * shipped a licence line calling itself "a pointer, not a settled grant", and
 * NOTICE, which is GENERATED from server/models.js, listed neither model, nor
 * the umt5 encoder, nor the VAE. `gen_notice.mjs --check` could never have
 * caught that: it proves NOTICE matches the catalogue, not that the catalogue
 * is complete. So the gap was invisible to every gate in the tree, and this is
 * the suite that would notice it coming back.
 *
 * It pins four things, and the second is a live defect rather than a rule:
 *
 *  1  THE LICENCE CLAIM IS SHAPED LIKE THIS REPOSITORY'S OTHER ONES. A verified
 *     row carries a verbatim quote, the clause it sits in and a URL; an unread
 *     one carries `unknown`, `sellable: null`, an empty quote and a URL all the
 *     same. provenance_test.js enforces that asymmetry across the whole
 *     catalogue; this checks the two rows where somebody would most want to
 *     skip it, because one model card says `apache-2.0` and has no document
 *     behind it.
 *
 *  2  THE CONTROL CAPABILITIES ARE BRIDGED, AND ARE NOT PICTURE MODELS. This
 *     check said the opposite until 2026-09-03, when the reason for it was
 *     fixed rather than guarded: mapping these two used to make fit.js
 *     recommend WAN 2.1 VACE to a 16 GB machine as its PICTURE model, because
 *     two files defined "picture" by subtracting the kinds they knew about.
 *     They ask models.js's isPictureModel() now. The block over that check has
 *     the measurement, and the section plants a row of a kind nobody has
 *     thought of to prove omission can never make one again.
 *
 *  3  THE BYTES ARE THE BYTES. Sizes against the real files when the rig is on
 *     this disk, and — under AIPLAY_LICENCE_HASHES=1, because it reads 11.6 GB
 *     and takes about 15 seconds — the sha256 of every file against the
 *     publisher's own published LFS record. That hash is what makes the licence
 *     claim a claim about THESE bytes rather than about a repository name.
 *
 *  4  NOTICE STILL CARRIES THE NODE PACK. That line is hand-written in the
 *     runtime-dependency section, which no generator touches, so nothing else
 *     in the tree would notice if it were deleted.
 *
 * Runs standalone (`node server/models_control_test.js`) and in the hook. It
 * needs no engine, no GPU and no network; the on-disk sections skip loudly.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOG, MODEL_TO_CAPABILITY, isPictureModel, outputRightsFor, rightsStampFor,
} from "./models.js";
/* fit.js is imported for ONE section: proving that a planted capability of an
 * unknown kind cannot become a picture model on the screen a newcomer reads.
 * The predicate check alone would pass with the recommendation still wrong —
 * which is precisely the failure this suite was written about. */
import { readMachine, fitFor, recommendFor } from "./fit.js";
import { VACE_WEIGHTS, VACE_LICENCE_VERIFIED } from "./control/vace.js";
import { DWPOSE_MODELS } from "./control/pose.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

console.log("\nThe control pair's catalogue rows\n");

const vace = CATALOG.find((c) => c.id === "videoControl");
const pose = CATALOG.find((c) => c.id === "posePreprocess");

/* ── both rows exist, and carry the files their builders load ────────────── */
{
  ok("WAN 2.1 VACE is catalogued", !!vace);
  ok("the DWPose pair is catalogued", !!pose);

  /* The builders name ComfyUI-relative FILENAMES; the catalogue names absolute
   * destinations. The join between them is the basename, and it is the join
   * that breaks silently: a catalogue row that fetched a different build would
   * report ready while the graph loaded something else, or nothing. */
  const base = (f) => f.dest.split(/[\\/]/).pop();
  const vaceNames = (vace?.files || []).map(base);
  for (const [slot, name] of Object.entries(VACE_WEIGHTS)) {
    ok(`videoControl carries the ${slot} the graph loads (${name})`,
      vaceNames.includes(name), vaceNames.join(", "));
  }
  const poseNames = (pose?.files || []).map(base);
  for (const [slot, name] of Object.entries(DWPOSE_MODELS)) {
    ok(`posePreprocess carries the ${slot} the graph loads (${name})`,
      poseNames.includes(name), poseNames.join(", "));
  }

  /* A `dest` and its `url` disagreeing about the filename is a real class of
   * typo and produces a file that is downloaded, verified against the right
   * size, and then invisible to the engine under the wrong name. */
  const mismatched = [...(vace?.files || []), ...(pose?.files || [])]
    .filter((f) => base(f) !== f.url.split("/").pop());
  ok("every download lands under the name it was published as", mismatched.length === 0,
    mismatched.map((f) => `${f.url.split("/").pop()} -> ${base(f)}`).join(", "));
}

/* ── the licence claim, in this catalogue's own grammar ──────────────────── */
{
  const r = vace?.outputRights || {};
  ok("WAN's rights are a verdict", r.class === "unrestricted" && r.sellable === true,
    `${r.class} / ${JSON.stringify(r.sellable)}`);
  ok("...quoting Apache-2.0 §2 verbatim, with the clause named",
    /Apache-2\.0 §2/.test(String(r.clause)) && String(r.quote).length > 80,
    `${r.clause} | ${String(r.quote).slice(0, 60)}`);

  /* THE QUOTE IS THE SHARED CONSTANT, not a retyped copy. models.js holds
   * APACHE_GRANT precisely so two entries quoting one sentence cannot drift
   * apart — "a quote that has drifted is worse than no quote, because it is
   * believed". This checks the new row went through that constant. */
  const klein = CATALOG.find((c) => c.id === "coverArt");
  ok("...and it is byte-identical to the Apache-2.0 grant the other rows quote",
    r.quote === klein?.outputRights?.quote, "the two Apache rows have drifted apart");

  /* The URL is pinned to the revision that was diffed. `main` moving under a
   * licence claim is the whole reason these two rows pin at all. */
  ok("...and its URL names the 40-hex revision the text was read at",
    /\/blob\/[0-9a-f]{40}\/LICENSE\.txt$/.test(String(r.url)), String(r.url));
  ok("...and every WAN download URL is pinned to a revision, not to main",
    (vace?.files || []).every((f) => /\/resolve\/[0-9a-f]{40}\//.test(f.url)),
    (vace?.files || []).map((f) => f.url.split("/resolve/")[1]?.split("/")[0]).join(", "));

  /* THE ADMISSION MUST SURVIVE. The bytes came from Comfy-Org's repackage,
   * which ships no LICENSE file; the quoted document is Wan-AI's. A note that
   * lost that would be claiming a document it did not get its bytes from,
   * which is the same failure as trusting the frontmatter tag. */
  ok("...and the note admits the bytes came from a repackage, as an inference",
    /Comfy-Org/.test(String(r.note)) && /inference/i.test(String(r.note)), String(r.note).slice(0, 120));

  ok("server/control/vace.js agrees that the WAN licence is verified",
    VACE_LICENCE_VERIFIED === true);
}

{
  const r = pose?.outputRights || {};
  ok("DWPose refuses to claim rights", r.class === "unknown", String(r.class));
  ok("...with sellable null and an empty quote — an admission, not a verdict",
    r.sellable === null && r.quote === "" && r.clause === "",
    `${JSON.stringify(r.sellable)} / ${JSON.stringify(r.quote)}`);
  ok("...and a URL regardless, so somebody can read the chain and decide",
    /^https:\/\//.test(String(r.url)), String(r.url));
  ok("...and a note saying WHICH half is unread", /28 bytes/.test(String(r.note)),
    String(r.note).slice(0, 120));

  /* Ideogram 4 is the row that set this precedent. If this suite ever finds
   * DWPose upgraded to a real class, the upgrade has to bring a quote — which
   * provenance_test.js also enforces — and this line says so where the
   * temptation is, next to a model card that reads `license: apache-2.0`. */
  ok("...and it is the same shape as the catalogue's other unread row",
    ["class", "sellable", "quote", "clause"].every((k) =>
      JSON.stringify(r[k]) === JSON.stringify(CATALOG.find((c) => c.id === "imageIdeogram")?.outputRights?.[k])),
    "posePreprocess and imageIdeogram disagree about what `unknown` looks like");
}

/* ── no new territory-limited row ────────────────────────────────────────── */
{
  /* Apache-2.0 has no territorial clause — the diff found none in any of the
   * documents behind these two rows. H3 must stay the only region-locked
   * entry, which is also what server/territory_test.js depends on. */
  const locked = CATALOG.filter((c) => c.region).map((c) => c.id);
  ok("the control rows added no region lock", !locked.includes("videoControl") && !locked.includes("posePreprocess"),
    locked.join(", "));
  /* 2026-09-17: H3 DERIVATIVES carry the lock too — the TaoMate distillations
   * and the conditioning bridges are trained on H3 and say so on their cards,
   * so the same territory clause applies to a clip made with them. */
  /* 2026-09-20: the Fun ControlNet union patch joins them. It is a patch ON
   * H3's weights rather than a model of its own, so a clip driven by it is an
   * H3 output and carries the same territory clause — its row says so in the
   * same words as the rows above it. */
  /* 2026-09-23: FastH3, FastVideo's 8-step distillation of H3; its repo names
   * H3's licence as its own. */
  const H3_AND_DERIVATIVES = ["video", "videoRefs", "videoH3Turbo3", "videoH3Turbo3Small",
                              "videoH3Turbo4", "videoH3Turbo8",
                              "videoH3FunControl", "bridgeBunny", "bridgeSemantic", "videoFastH3"];
  ok("...and H3 and its derivatives are the only things that carry one",
    locked.every((id) => H3_AND_DERIVATIVES.includes(id)), locked.join(", "));
}

/* ── in the map for rights, and NOT a picture model ──────────────────────── */
{
  /* ⚠ THIS SECTION USED TO ASSERT THE OPPOSITE, and the flip is the fix
   * landing rather than a rule being relaxed. What it said, and why:
   *
   * MEASURED on 2026-09-03 by adding `"vace": "videoControl"` and
   * `"dwpose": "posePreprocess"` to MODEL_TO_CAPABILITY and running the tree:
   *
   *   · server/fit.js recommendFor() on a 16 GB / 32 GB machine returned
   *     `image -> videoControl`. A newcomer is told WAN 2.1 VACE is their
   *     picture model.
   *   · The welcome window's Images screen listed both rows under "any one
   *     picture model will do — this is the whole choice".
   *   · AND EVERY SUITE STAYED GREEN — fit_test 47/0, welcome/catalogue_test
   *     75/0 — because fit.js and welcome/catalogue.js computed the picture
   *     models by the SAME subtraction ("every value in this map, minus the
   *     video engines, minus the required one"). Two surfaces deriving one
   *     wrong set agree with each other perfectly. The census compares them to
   *     each other, so it could not see it.
   *
   * So the guard was "keep these two lines out of the map", which protected the
   * symptom and left the cause. The cause is fixed: both files now ask
   * models.js's isPictureModel(), which reads `makes: "picture"` off the row, so
   * a capability kind nobody has thought of yet is NOT a picture model — it is
   * nothing, until a row says otherwise. The lines are in the map, and the
   * checks below are the ones worth keeping: that the bridge exists, that
   * neither row can be mistaken for a picture model, and that neither file has
   * gone back to subtracting. */
  const mapped = Object.values(MODEL_TO_CAPABILITY);
  ok("both control capabilities are bridged from an engine name",
    mapped.includes("videoControl") && mapped.includes("posePreprocess"),
    "without the bridge, engine/record.js cannot name a VACE render from the "
    + "diffusion weights it loaded, and every one of them stamps `unknown`");
  ok("...and the WAN bridge resolves to WAN's own verified rights, not to unknown",
    outputRightsFor("vace").class === "unrestricted"
    && outputRightsFor("vace").url === vace?.outputRights?.url,
    JSON.stringify(rightsStampFor("vace")));
  ok("...and DWPose's resolves to the admission rather than to a guess",
    outputRightsFor("dwpose").class === "unknown"
    && rightsStampFor("dwpose").capability === "posePreprocess",
    JSON.stringify(rightsStampFor("dwpose")));

  ok("neither control row declares it makes pictures",
    !isPictureModel(vace) && !isPictureModel(pose),
    `videoControl.makes=${JSON.stringify(vace?.makes)} posePreprocess.makes=${JSON.stringify(pose?.makes)}`);

  /* THE RULE ITSELF, on a row that does not exist. This is what a subtraction
   * could never pass: a capability of a kind nobody has written code for yet —
   * a depth estimator, an audio upscaler, the next control model — arrives with
   * no `makes` at all, and the answer has to be "not a picture", not "picture
   * by default". The row is planted rather than borrowed precisely so it names
   * a kind the catalogue has no opinion about. */
  const planted = {
    id: "__notARealCapability__",
    label: "Something — a capability kind nobody has thought of yet",
    makes: "cromulence",
    requires: { vramMinGb: 1, vramRecGb: 1, ramMinGb: 1, ramRecGb: 1 },
    outputRights: { class: "unrestricted", sellable: true, quote: "", clause: "", url: "" },
    files: [],
  };
  ok("a planted row with an unknown kind is NOT a picture model", !isPictureModel(planted));
  ok("...nor is one that declares no kind at all",
    !isPictureModel({ id: "__silent__" }) && !isPictureModel({}) && !isPictureModel(null));
  ok("...and `makes: \"picture\"` is what the seven real ones say",
    CATALOG.filter(isPictureModel).map((c) => c.id).join(",")
      === "coverArt,imageIdeogram,imageZImage,qwen-image-2.1,imageKrea2,imageZImageBase,imageAnima",
    CATALOG.filter(isPictureModel).map((c) => c.id).join(", "));

  /* END TO END, through the code a newcomer actually meets. The planted row is
   * handed to recommendFor() on the rig's own machine shape with a fit good
   * enough to win every tie-break the ranker has — ready, fits, unrestricted,
   * zero bytes — so if the picture set were still open by default it would be
   * picked. It must not be, and the real recommendation must not move. */
  const machine = readMachine(
    { name: "NVIDIA GeForce RTX 4070 Ti SUPER", totalMb: 16376, usedMb: 2100, note: "driver" },
    { totalMb: 32659, usedMb: 14000 });
  const asCapability = (c) => ({
    id: c.id, label: c.label, licence: c.licence, makes: c.makes || null,
    outputRights: c.outputRights || null, region: c.region || null, gated: c.gated || null,
    requires: c.requires || null, needsPackage: c.needsPackage || null,
    packageInstall: c.packageInstall || null, packageReady: !c.needsPackage,
    required: !!c.required,
    files: (c.files || []).map((f) => ({ name: path.basename(f.dest), bytes: f.bytes, present: false })),
    totalBytes: (c.files || []).reduce((n, f) => n + f.bytes, 0) || c.approxBytes || 0,
    haveBytes: 0, ready: false,
  });
  const withPlanted = [...CATALOG, planted].map(asCapability)
    .map((c) => ({ ...c, fit: fitFor(c.requires, machine), ready: c.id === planted.id ? true : c.ready }));
  const out = recommendFor({ capabilities: withPlanted, machine, disk: { freeBytes: 900e9 } });
  const imagePick = out.picks.find((p) => p.slot === "image");
  ok("...and recommendFor never picks it, however well it would score",
    !out.picks.some((p) => p.id === planted.id),
    out.picks.map((p) => `${p.slot}=${p.id}`).join(", "));
  ok("...while the picture recommendation for a 16 GB machine is unchanged",
    imagePick?.id === "coverArt", `image -> ${imagePick?.id}`);
  ok("...and neither control model is recommended for anything",
    !out.picks.some((p) => p.id === "videoControl" || p.id === "posePreprocess"),
    out.picks.map((p) => `${p.slot}=${p.id}`).join(", "));

  /* NEITHER FILE MAY GO BACK TO SUBTRACTING. The previous version of this suite
   * read the same two files to check the subtraction was STILL there, because
   * the guard above it was only meaningful while it was. Same two files, same
   * reason, opposite sense: the one rule both surfaces ask has to stay one
   * rule, or the census goes blind again in exactly the way it did before. */
  const derivations = [
    ["server/fit.js", /const IMAGE_IDS = CATALOG\.filter\(isPictureModel\)/],
    ["server/welcome/catalogue.js", /const IMAGE_CAP_IDS = CATALOG\.filter\(isPictureModel\)/],
  ];
  for (const [file, re] of derivations) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    ok(`${file} asks isPictureModel() rather than subtracting`, re.test(src),
      "a subtraction here answers \"picture\" for every capability kind that does "
      + "not exist yet, and both surfaces agreeing about a wrong set is why no "
      + "suite caught it the first time");
    ok(`...and ${file} no longer filters MODEL_TO_CAPABILITY's values by exclusion`,
      !/Object\.values\(MODEL_TO_CAPABILITY\)\)[\s\S]{0,200}?!VIDEO_(CAP_)?IDS\.includes/.test(src));
  }
}

/* ── the bytes are the bytes ─────────────────────────────────────────────── */
{
  /* The catalogue's own definition of "present" is the exact size, so a size
   * that disagrees with the file on this disk means a download that will never
   * report ready. The published sizes were also checked against the
   * publishers' HTTP content-length when these rows were written. */
  const all = [...(vace?.files || []), ...(pose?.files || [])];
  const here = all.filter((f) => fs.existsSync(f.dest));
  if (!here.length) {
    console.log("  --    none of these weights are on this machine, so the size and hash");
    console.log("        sections did not run. Everything above still ran.");
  } else {
    const wrong = here.filter((f) => fs.statSync(f.dest).size !== f.bytes)
      .map((f) => `${f.dest.split(/[\\/]/).pop()}: catalogue ${f.bytes}, disk ${fs.statSync(f.dest).size}`);
    ok(`the ${here.length} weight file(s) on this disk are the size the catalogue states`,
      wrong.length === 0, wrong.join("; "));
  }

  /* THE PROVENANCE PROOF ITSELF. Each of these is the publisher's own LFS oid,
   * fetched from the HuggingFace paths-info API at the pinned revision and
   * matched against the file on this rig on 2026-09-03. It is what makes the
   * licence a claim about THESE bytes: the WAN files are Comfy-Org's repackage
   * and not Wan-AI's own upload, and this is how that was established rather
   * than assumed from a filename.
   *
   * Opt-in because it reads 11.6 GB and takes about 15 seconds — too much for
   * every commit, and the size check above already catches a truncated file. */
  const OID = {
    "wan2.1_vace_1.3B_fp16.safetensors": "640ccc0577e6a5d4bb15cd91b11b699ef914fc55f126c5a1c544e152130784f2",
    "umt5_xxl_fp8_e4m3fn_scaled.safetensors": "c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68",
    "wan_2.1_vae.safetensors": "2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b",
    "yolox_l.torchscript.pt": "80bc14b13c260c24b3014cd42c02994bf52296ab8fa2d80a60b6afe08c93ef42",
    "dw-ll_ucoco_384_bs5.torchscript.pt": "d86a0b2b59fddc0901a7076e9f59c9f8602602133ed72511c693fd11eea23d91",
  };
  ok("every catalogued control file has a published sha256 recorded here",
    all.every((f) => OID[f.dest.split(/[\\/]/).pop()]),
    all.map((f) => f.dest.split(/[\\/]/).pop()).filter((n) => !OID[n]).join(", "));

  if (!process.env.AIPLAY_LICENCE_HASHES) {
    console.log("  --    AIPLAY_LICENCE_HASHES is not set, so the sha256 of each file was not");
    console.log("        recomputed (11.6 GB, ~15 s). Set it to 1 to prove the bytes on this");
    console.log("        disk are the bytes the licence claim was made about.");
  } else {
    for (const f of here) {
      const name = f.dest.split(/[\\/]/).pop();
      /* ⚠ STREAMED, not readFileSync. The text encoder is 6.74 GB and Node
       * refuses to allocate a Buffer that large (ERR_FS_FILE_TOO_LARGE, the
       * limit is ~2 GB) — so the obvious one-liner throws on the biggest file
       * in the set and would have hidden the check behind a crash. */
      const h = crypto.createHash("sha256");
      await new Promise((res, rej) => fs.createReadStream(f.dest)
        .on("data", (d) => h.update(d)).on("end", res).on("error", rej));
      const got = h.digest("hex");
      ok(`${name} is the publisher's own bytes (sha256)`, got === OID[name], `${got} != ${OID[name]}`);
    }
  }
}

/* ── NOTICE carries the node pack, which no generator protects ───────────── */
{
  /* scripts/gen_notice.mjs regenerates only the model-weights section, so the
   * runtime-dependency entry for comfyui_controlnet_aux is hand-written and
   * `gen_notice.mjs --check` would happily pass with it deleted. It has to be
   * there: it is a code dependency the pose capability cannot run without, and
   * NOTICE is the file a fork reads and nothing else. */
  const notice = fs.readFileSync(path.join(ROOT, "NOTICE"), "utf8");
  ok("NOTICE names comfyui_controlnet_aux as a runtime dependency",
    /comfyui_controlnet_aux/.test(notice));
  ok("...with its licence and the commit its LICENSE.txt was diffed at",
    /59b1fc411ede8623b2997855b8018f0b3\s*\n?\s*b6cf49f/.test(notice) || /59b1fc411ede/.test(notice),
    "the pinned commit is gone from the NOTICE entry");
  /* And the generated half really did pick both models up. */
  ok("...and the generated model list names both control models",
    /WAN 2\.1 VACE 1\.3B/.test(notice) && /DWPose \(TorchScript\)/.test(notice));
  ok("...and states DWPose's rights as unverified rather than as apache-2.0",
    /DWPose \(TorchScript\)[\s\S]{0,200}UNVERIFIED/.test(notice));
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
