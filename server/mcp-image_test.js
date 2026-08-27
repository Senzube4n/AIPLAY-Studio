/**
 * Every parameter an mcp.js tool ADVERTISES actually reaches its run().
 *
 * The same guard mcp-vfx_test.js runs over the VFX tools, extended to the
 * main tool list — because the same bug shipped here too: a schema property
 * added without its run() forwarding it validates, returns 200, and silently
 * does nothing. `additionalProperties: false` means a client trusts the
 * schema, so a schema that lies is a feature that appears to work.
 *
 * The check is a heuristic: it reads each tool's run source and asks whether
 * the parameter's name appears in it. That cannot prove the value is used
 * correctly, but it catches "declared and dropped", which is the class that
 * has actually happened. A tool that forwards its whole argument object is
 * listed in IGNORED, with the reason written down.
 *
 * Plus the structural checks for the routes the image panels lean on — the
 * same source-reading style vfx/routes_test.js uses, because these run on
 * every commit and must not need a server or a python.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TOOLS } from "./mcp.js";
import { ZIMAGE_PRESET } from "./workflow.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

/* Parameters a tool takes but does not name in run(), on purpose. */
const IGNORED = {
  // Spread wholesale into the request body, so no name appears individually.
  image_sheet: "*",
  // Destructures the handful it renames and REST-SPREADS everything else into
  // ops — the spread is the forwarding, so nothing declared can be dropped.
  image_adjust: "*",
};

/* The vfx_* tools are appended into TOOLS from mcp-vfx.js and carry their own
 * IGNORED table in mcp-vfx_test.js; checking them twice with a second table
 * is how the two tables drift. This file owns the rest. */
const OURS = TOOLS.filter((t) => !t.name.startsWith("vfx_"));

console.log("\n  -- the tool list is well formed --");

ok("every tool has a name, a description, a schema and a run",
  TOOLS.every((t) => t.name && t.description && t.inputSchema && typeof t.run === "function"));

const names = TOOLS.map((t) => t.name);
ok("no duplicate tool names", new Set(names).size === names.length,
  names.filter((n, i) => names.indexOf(n) !== i).join(", "));

ok("every required parameter is also declared",
  TOOLS.every((t) => (t.inputSchema.required || []).every((r) => t.inputSchema.properties?.[r])),
  TOOLS.filter((t) => (t.inputSchema.required || []).some((r) => !t.inputSchema.properties?.[r]))
    .map((t) => t.name).join(", "));

console.log("\n  -- nothing is advertised and then dropped --");

const dropped = [];
for (const t of OURS) {
  if (IGNORED[t.name] === "*") continue;
  const src = String(t.run);
  const ignored = new Set(IGNORED[t.name] || []);
  for (const p of Object.keys(t.inputSchema.properties || {})) {
    if (ignored.has(p)) continue;
    // snake_case in the schema becomes camelCase on the wire; either spelling
    // appearing in run() means the parameter was not forgotten.
    const camel = p.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (!src.includes(p) && !src.includes(camel)) dropped.push(`${t.name}.${p}`);
  }
}
ok("every declared parameter is named in its run()", dropped.length === 0,
  dropped.length
    ? `${dropped.join(", ")}\n          Either forward it, or add it to IGNORED with a reason.`
    : "");

console.log("\n  -- the panel routes the tools lean on --");

const byName = new Map(TOOLS.map((t) => [t.name, t]));
const idx = readFileSync(path.join(HERE, "index.js"), "utf8");

/* image_tools_catalog promises module=paths; the route's MODULES map is where
 * that promise is kept or broken. It WAS broken — the MCP description said
 * paths for as long as the pen existed while the route never served it. */
ok("the tools route serves the paths module",
  /MODULES = \{[\s\S]{0,400}paths: "imgpath"/.test(idx));

const catalogTool = byName.get("image_tools_catalog");
ok("image_tools_catalog names paths in its module list",
  /paths/.test(String(catalogTool?.inputSchema?.properties?.module?.description || "")));

/* image_swatches speaks to /api/images/swatches; both verbs must have a
 * handler, or the tool is a face on a 404. */
ok("the swatches route has a GET handler",
  idx.includes('p === "/api/images/swatches" && req.method === "GET"'));
ok("...and a POST handler",
  idx.includes('p === "/api/images/swatches" && req.method === "POST"'));
ok("image_swatches exists and calls that route",
  String(byName.get("image_swatches")?.run || "").includes("/api/images/swatches"));

console.log("\n  -- the parameters the panels added --");

const adjust = byName.get("image_adjust");
ok("image_adjust declares channel with the five planes",
  JSON.stringify(adjust?.inputSchema?.properties?.channel?.enum) ===
  JSON.stringify(["r", "g", "b", "a", "luminosity"]));
ok("...and its run() forwards it (via the ops spread)",
  String(adjust.run).includes("...ops"));
ok("image_adjust's selection doc names the channel and path kinds",
  /channel/.test(adjust.inputSchema.properties.selection.description)
  && /'path'/.test(adjust.inputSchema.properties.selection.description));
ok("image_adjust's strokes doc names stroke-a-path",
  /path/.test(adjust.inputSchema.properties.strokes.description));
ok("image_adjust's text doc names the _v2 spec",
  /_v2/.test(adjust.inputSchema.properties.text.description));

console.log("\n  -- clipping masks --");

/* `clipped` lives on the LAYER ITEMS, one level under the top-level `layers`
 * property, so the generic declared-and-dropped sweep above never sees it —
 * these are its guards. The run() forwards it in the ...l spread; the route
 * is where it could silently die, so the route is what gets read. */
const composite = byName.get("image_composite");
ok("image_composite's layer items declare clipped",
  composite?.inputSchema?.properties?.layers?.items?.properties?.clipped?.type === "boolean");
ok("...and its run() forwards layer objects wholesale, spread included",
  String(composite?.run || "").includes("...l"));
const compSrc = idx.slice(idx.indexOf('p === "/api/images/composite"'));
ok("the composite route reads the clipped flag",
  compSrc.includes("l.clipped"));
ok("...and renders a clipped composite through imgdoc.py — ONE implementation " +
   "of the semantics, before the flat imagetools path",
  compSrc.slice(0, compSrc.indexOf("imagetools.py")).includes("imgdoc.py"));
ok("...refusing flips loudly instead of landing them a half-pixel off",
  compSrc.includes("flipH/flipV cannot ride a clipped composite"));
ok("image_composite's description teaches the clipping mask",
  /clipping mask/i.test(composite?.description || ""));
ok("image_document teaches clipped: true in its description",
  /clipped: true/.test(byName.get("image_document")?.description || ""));
ok("...and the semantics live in imgdoc.py's own catalog, not a second copy",
  /"clipped": flag\(/.test(readFileSync(path.join(HERE, "imgdoc.py"), "utf8")));

console.log("\n  -- the document route stages every source the shape allows --");

/* The source walk collects library names for python to resolve. imgdoc.py's
 * shape puts `src` on image layers AND on any layer's mask (MASK_PARAMS is
 * common to every kind, groups included) — a doc with mask:{src} used to
 * render UNMASKED with a warning misdiagnosing the file as missing, because
 * the walk only ever staged l.src. */
const docSrc = idx.slice(idx.indexOf('p === "/api/images/document"'),
                         idx.indexOf('p === "/api/images/capabilities"'));
ok("the source walk stages l.src", /stage\(l\.src\)/.test(docSrc));
ok("...and l.mask.src, at any depth", /stage\(l\.mask\.src\)/.test(docSrc));
ok("...before recursing into children, so a group's own mask is not skipped",
  docSrc.indexOf("stage(l.mask.src)") < docSrc.indexOf("walk(l.layers)"));

console.log("\n  -- engine errors reach the HTTP caller --");

/* imgdoc.py and imgexport.py speak {ok:false, error} on STDOUT and then exit
 * 1. Rejecting on the exit code before reading stdout turned the CLI's full
 * diagnosis into `{"error":"exit 1"}` over HTTP — engineClose reads the JSON
 * error first and keeps stderr/exit-code as the fallback for a crash that
 * never printed one. */
ok("engineClose exists and reads stdout's JSON error before stderr",
  /function engineClose\(/.test(idx)
  && idx.indexOf("JSON.parse(tail)") > idx.indexOf("function engineClose(")
  && (() => { const f = idx.slice(idx.indexOf("function engineClose("));
              return f.indexOf("JSON.parse(tail)") < f.indexOf("`exit ${code}`"); })());
ok("the document route closes through engineClose", /engineClose\(/.test(docSrc));
const compRouteSrc = idx.slice(idx.indexOf('p === "/api/images/composite"'),
                               idx.indexOf('p === "/api/images/analyze"'));
ok("...and so does the clipped composite's imgdoc spawn", /engineClose\(/.test(compRouteSrc));
const exportSrc = idx.slice(idx.indexOf('p === "/api/images/export"'),
                            idx.indexOf('p === "/api/images/edit"'));
ok("...and the export route's imgexport spawn", /engineClose\(/.test(exportSrc));

console.log("\n  -- the honesty channels reach the caller --");

/* imagetools.apply_edit reports `notes` (a stage's compromises) and
 * `fxSkipped` (timeline effects that did nothing on a still). The edit route
 * returned only {ok, name} and image_adjust inherited the silence — the
 * server knowing and not saying is what IMAGE_SPEC is written against. */
const editSrc = idx.slice(idx.indexOf('p === "/api/images/edit"'),
                          idx.indexOf('p === "/api/images/flag"'));
ok("the edit route forwards notes", /notes: r\.notes/.test(editSrc));
ok("...and fxSkipped", /fxSkipped: r\.fxSkipped/.test(editSrc));
ok("image_adjust's reply carries both",
  /notes: r\.notes/.test(String(adjust.run)) && /fxSkipped: r\.fxSkipped/.test(String(adjust.run)));
ok("...and its description says so",
  /notes/.test(adjust.description) && /fxSkipped/.test(adjust.description));
ok("image_adjust's effects doc counts particleSystem among the timeline effects",
  /particleSystem/.test(adjust.inputSchema.properties.effects.description));
ok("image_batch forwards the per-image reports",
  /r\.notes/.test(String(byName.get("image_batch")?.run || "")));
ok("image_composite forwards the route's warnings — the only channel for "
   + "\"clipped, but no base\"",
  /warnings: r\.warnings/.test(String(composite.run)));

console.log("\n  -- the 2026-08-26 UI-sweep pins --");

/* The byte budget is a top-level job key for imgexport's "target" mode, never
 * an export option — resolve() refuses unknown keys by NAME, so a maxBytes
 * left inside `export:` failed every budgeted export with
 * "unknown option(s) ['maxBytes']". The route must pop both keys. */
ok("the export route strips maxBytes/allowMiss out of the export opts",
  /delete exportOpts\.maxBytes/.test(exportSrc)
  && /delete exportOpts\.allowMiss/.test(exportSrc)
  && /export: exportOpts/.test(exportSrc)
  && !exportSrc.includes("export: opts"));

/* The listing admits what the export dialog produces AND a browser's <img>
 * can render — jpg/webp/avif ride along with png/svg; tiff/ico/pdf stay
 * download-only rather than becoming broken tiles. */
const listSrc = idx.slice(idx.indexOf('p === "/api/images" && req.method !== "POST"'),
                          idx.indexOf('p === "/api/images/effects"'));
ok("the gallery listing admits png, svg, jpg, webp and avif",
  listSrc.includes("png|svg|jpe?g|webp|avif"));
ok("...and still hides thumbnails", listSrc.includes('_t.png'));

/* Trash takes every format the library dir can actually hold (the /api/image/
 * serving set) — a `.png$` guard answered vectorize's own SVG "bad name". */
const trashSrc = idx.slice(idx.indexOf('p === "/api/images" && req.method === "POST"'),
                           idx.indexOf('p.startsWith("/api/image/")'));
ok("the image-trash guard accepts the full servable set",
  trashSrc.includes("png|jpg|jpeg|webp|svg|avif|tif|tiff|ico|pdf"));
ok("...and derives the travelling thumbnail name from ANY extension",
  trashSrc.includes('replace(/\\.[^.]+$/, "_t.png")'));

console.log("\n  -- the ideogram noise-lock: a retry that can actually retry --");

/* THE BUG: `job.seed = ladder[attempt % ladder.length]`. On a machine that has
 * never harvested, the ladder is one entry, so the retry re-picked the SAME
 * seed. Renders are deterministic, so the second pass re-submitted a
 * byte-identical graph, ComfyUI answered from its node cache with filenames
 * the first pass had already renamed away, and the job died on a rename ENOENT
 * — which also skipped the cleanup, which is how a "blocked by safety filter"
 * card ended up in the owner's library. */
const artSrc = readFileSync(path.join(HERE, "art.js"), "utf8");
const ideoBlock = artSrc.slice(artSrc.indexOf('engine === "ideogram4" && result.thumbs.length'),
                               artSrc.indexOf("return result;"));

ok("the retry never re-picks by modulo over the ladder",
  !/ladder\[[^\]]*%[^\]]*\]/.test(artSrc),
  "`ladder[attempt % ladder.length]` is the bug: on a one-entry ladder it is the same seed.");
ok("it asks nextIdeogramSeed which seeds are still UNTRIED",
  ideoBlock.includes("nextIdeogramSeed("));
ok("...and the seeds this job burned are recorded when the graph is built",
  /_ideoTried/.test(artSrc) && artSrc.includes("tried.push(job.seed)"));
/* 777 is always the FIRST ladder entry, so "take the first untried" meant 777
 * painted every Ideogram image and cover ever rendered — harvesting more seeds
 * would have changed nothing visible. The requested seed picks the entry. */
ok("the requested seed chooses WHICH pass-seed paints, so a re-roll is a new picture",
  /nextIdeogramSeed\(tried, ladder, job\.seed\)/.test(artSrc));
ok("...while the RETRY asks with no preference, so 777 stays the backstop",
  /nextIdeogramSeed\(tried, ladder\)/.test(ideoBlock));
ok("a job that has burned every ladder entry stops instead of looping",
  /fresh !== undefined && tried\.length < IDEO_MAX_TRIES/.test(ideoBlock));

/* `count` renders ONE seed into a batched latent and each slot gets different
 * noise, so the refusal is per-slot. Reading thumbs[0] alone filed slot 2's
 * card in the library with no error anywhere — reproduced live before this
 * check existed. */
ok("EVERY picture in the batch is judged, not just the first",
  /result\.thumbs\.map\(async \(t\) =>/.test(ideoBlock) && !ideoBlock.includes("result.thumbs[0]"));
ok("...only the refused slots are deleted",
  /for \(const i of cards\)/.test(ideoBlock));
ok("...a partly-refused batch keeps the pictures that rendered",
  /cards\.length < result\.thumbs\.length/.test(ideoBlock)
  && /keeping the/.test(ideoBlock));
ok("...and only an ENTIRELY refused batch spends another seed",
  ideoBlock.indexOf("cards.length < result.thumbs.length") < ideoBlock.indexOf("nextIdeogramSeed("));

/* Order matters more than the unlink itself: the card has to be gone BEFORE
 * anything that can throw, or a failing retry leaves it in the library. */
ok("the refusal card is deleted BEFORE the retry recurses, not after it returns",
  ideoBlock.indexOf("unlink(") > 0
  && ideoBlock.indexOf("unlink(") < ideoBlock.indexOf("return await this.#render(job)"));
ok("the FLUX fallback for covers survives, with the burned-seed list reset",
  /engine: "flux2", _ideoTried: \[\]/.test(ideoBlock));
ok("the standalone failure speaks the honest message, ladder length included",
  /throw new Error\(ideogramRefusalMessage\(ladder\.length, tried\.length\)\)/.test(ideoBlock));

/* One implementation of "is this the card". The harvester used to carry a copy
 * that sampled every 8th pixel against the app's every 4th — so a seed could
 * be harvested as passing and then have its render deleted as a card. */
const harvestSrc = readFileSync(path.join(HERE, "..", "scripts", "harvest_ideogram_seeds.mjs"), "utf8");
ok("the harvester decides pass/card with the renderer's own reader",
  /import \{ pngLumaStats, refusalCard \} from "\.\.\/server\/art\.js"/.test(harvestSrc));
ok("...and no longer carries a second copy of it",
  !harvestSrc.includes("node:zlib") && !harvestSrc.includes("pngLumaVariance"));
ok("art.js exports that reader for it", /export function pngLumaStats/.test(artSrc));
ok("the harvester can be pointed at another prompt — the default one is at 0/99 here",
  /const PROMPT = arg\("--prompt"\)/.test(harvestSrc));
ok("...and an absent --seeds cannot parse as seed 0",
  harvestSrc.slice(harvestSrc.indexOf("const SEEDS"), harvestSrc.indexOf("const COUNT"))
    .includes(".filter(Boolean)"));

console.log("\n  -- multiple reference images reach the Images tab --");

/* Server-side this has worked since coverGraph learned FLUX in-context
 * editing; only the browser could not reach it. These are the checks that the
 * seam is actually joined, in both directions. */
const mk = byName.get("make_image");
ok("make_image still declares ref_images, capped at ten",
  mk?.inputSchema?.properties?.ref_images?.type === "array"
  && mk.inputSchema.properties.ref_images.maxItems === 10);
ok("...and its run() forwards them as refImages",
  /refImages:/.test(String(mk.run)) && /ref_images/.test(String(mk.run)));
ok("...naming the order the prompt depends on",
  /image 1/.test(mk.description) && /in this order/i.test(mk.inputSchema.properties.ref_images.description));
ok("...and the honest cost", /4 s per reference/.test(mk.inputSchema.properties.ref_images.description));
ok("the schema still refuses anything undeclared", mk.inputSchema.additionalProperties === false);

const imgRouteSrc = idx.slice(idx.indexOf('p === "/api/image" && req.method === "POST"'),
                              idx.indexOf('p === "/api/checkpoints"'));
ok("the image route stages references into ComfyUI's input dir, like the video route",
  /aiplay_frame_\$\{createHash\("sha1"\)/.test(imgRouteSrc) && imgRouteSrc.includes("config.inputDir"));
ok("...resolving a bare name in BOTH the cover and the image folder",
  imgRouteSrc.includes("COVER_DIR") && imgRouteSrc.includes("IMAGE_DIR"));
ok("...accepting an already-staged upload name unchanged",
  /aiplay_frame_\[0-9a-f\]\{12\}/.test(imgRouteSrc));
ok("...and handing them to the job as refImages", /\brefImages,/.test(imgRouteSrc));
ok("references on ideogram4 are REFUSED, never silently dropped",
  /Ideogram 4 has no reference input/.test(imgRouteSrc));
/* THREE engines now, not two — Z-Image joined them. Counted rather than named
 * so that adding a fourth non-reference engine and forgetting its refusal
 * fails here: this is the assertion that stops "quietly ignored the user's
 * pictures" coming back. */
ok("...and on a checkpoint, and on both Z-Image variants",
  imgRouteSrc.split("Reference images are FLUX's trick").length === 4);
/* Z-Image is the one engine where the reason is NOT "this model has no such
 * input" — ComfyUI ships TextEncodeZImageOmni and it takes three images. The
 * refusal has to say the weights are unreleased, or the next person wires a
 * picker to a node that cannot work. */
ok("...and Z-Image's refusal names the real reason (unreleased weights, not a missing node)",
  /TextEncodeZImageOmni/.test(imgRouteSrc) && /unreleased/.test(imgRouteSrc));
/* A negative prompt on Z-Image TURBO is refused for the same reason references
 * are: at cfg 1.0 ComfyUI never evaluates the uncond branch, so honouring it
 * is impossible and ignoring it is a lie. Base, which runs real CFG, must NOT
 * be refused — so both halves are pinned. */
ok("a negative on Z-Image Turbo is refused with the cfg-1.0 reason",
  /cfg 1\.0, where the negative prompt is never evaluated/.test(imgRouteSrc));
/* ...and the route ASKS THE GRAPH BUILDER which variant that is, rather than
 * hardcoding the engine name a second time. A third Z-Image build added to
 * ZIMAGE_PRESET is then handled here without anyone remembering to come back. */
ok("...and only where the sampler has no uncond branch, read from ZIMAGE_PRESET",
  /ZIMAGE_PRESET\[variant\]\.cfgs/.test(imgRouteSrc)
  && /import \{[^}]*ZIMAGE_PRESET[^}]*\} from "\.\/workflow\.js"/.test(idx));

console.log("\n  -- THE CENSUS: every field the route reads, an agent can send --");

/* ⚠ THE CHECK THAT WOULD HAVE CAUGHT `steps`, AND DID NOT EXIST.
 *
 * `/api/image` has always read a step count out of the request body and
 * clamped it, and web/app.js has always sent one. `make_image` neither
 * declared it nor forwarded it — so a human at the Images screen could set 28
 * steps for an SDXL checkpoint and an agent driving the SAME route could not,
 * getting config.art.steps (4, correct for distilled FLUX and about six times
 * too few for SDXL) with no error and nothing to look at. `ref_images` was the
 * same shape of bug, found the same way, months later.
 *
 * The two existing guards do not cover this. The declared-and-dropped guard
 * asks "does run() forward everything the SCHEMA declares" — it is blind to a
 * field that was never declared. The parity gate below asks the same question
 * of the DAW page. Neither starts from the ROUTE, which is the only place that
 * knows what the feature can actually do.
 *
 * So this census reads the route source and derives the list. A hardcoded list
 * would rot exactly like the NOTICE model list did. Every `b.<field>` the
 * handler touches must be declared by make_image (under its own name or the
 * snake_case an MCP schema prefers) and must be named inside run(). */
const ROUTE_ONLY = new Set([
  // The route's own verb. It is not a picture parameter and the tool supplies
  // it as a constant; exempted BY NAME so the exemption cannot quietly grow.
  "action",
]);
const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const routeFields = [...new Set([...imgRouteSrc.matchAll(/\bb\.([A-Za-z_$][\w$]*)/g)]
  .map((m) => m[1]))].filter((f) => !ROUTE_ONLY.has(f)).sort();
ok("the census found the route's fields at all (a regex that matches nothing passes everything)",
  routeFields.length >= 8, routeFields.join(", "));
const runSrc = String(mk.run);
const declared = Object.keys(mk.inputSchema.properties);
const undeclared = [], unforwarded = [];
for (const f of routeFields) {
  if (!declared.includes(f) && !declared.includes(snake(f))) undeclared.push(f);
  else if (!new RegExp(`\\b${f}\\b`).test(runSrc)) unforwarded.push(f);
}
ok("every field /api/image reads is DECLARED by make_image", undeclared.length === 0,
  `make_image cannot send: ${undeclared.join(", ")}`);
ok("...and every one of them is NAMED in run(), not just declared", unforwarded.length === 0,
  `declared but never sent: ${unforwarded.join(", ")}`);
console.log(`        census: ${routeFields.length} route fields — ${routeFields.join(", ")}`);

/* ── the negative-prompt rule, in three places, kept identical ─────────────
 *
 * Whether an engine can honour a negative prompt is ONE fact — does the
 * sampler evaluate an uncond branch — and it has to be told three times: the
 * graph builder wires a real CLIPTextEncode or a ConditioningZeroOut, the
 * route refuses or accepts the field, and the form shows or hides the box. The
 * route asks ZIMAGE_PRESET directly. The browser cannot import a server
 * module, so web/app.js keeps its own IMG_ENGINES flag — which is the copy
 * that can drift, and this is what notices. A form offering a box the server
 * will refuse is the exact "declared and dropped" shape, wearing a UI. */
const appSrc = readFileSync(path.join(HERE, "..", "web", "app.js"), "utf8");
const engStart = appSrc.indexOf("const IMG_ENGINES = {");
const engBlock = appSrc.slice(engStart, appSrc.indexOf("$(\"imgEngine\").onchange", engStart));
ok("web/app.js still declares IMG_ENGINES where this test reads it", engBlock.length > 100);
for (const [engine, variant] of [["zimage", "turbo"], ["zimage-base", "base"]]) {
  const entry = new RegExp(`["']?${engine}["']?:\\s*\\{[^}]*\\}`).exec(engBlock)?.[0] || "";
  const uiSaysNegative = /negative:\s*true/.test(entry);
  ok(`the form's negative flag for ${engine} matches the graph's`,
     uiSaysNegative === ZIMAGE_PRESET[variant].cfgs,
     `app.js says ${uiSaysNegative}, ZIMAGE_PRESET.${variant}.cfgs is ${ZIMAGE_PRESET[variant].cfgs}`);
  ok(`...and it declares the same step count the graph defaults to`,
     new RegExp(`steps:\\s*${ZIMAGE_PRESET[variant].steps}\\b`).test(entry), entry.slice(0, 80));
}
/* The step slider's ceiling is the ROUTE's ceiling, per engine. A flat maximum
 * is wrong in both directions the moment two engines disagree: it either
 * refuses a legal ask or offers one the server clamps without saying so. These
 * numbers are read straight out of the route's own clamp expression. */
const CLAMP = /engine === "checkpoint" \? 60 : zimage \? 50 : 30/.test(imgRouteSrc);
ok("the route still clamps steps per engine where this test reads it", CLAMP);
for (const [engine, max] of [["flux2", 30], ["zimage", 50], ["zimage-base", 50], ["checkpoint", 60]]) {
  const entry = new RegExp(`["']?${engine}["']?:\\s*\\{[^}]*\\}`).exec(engBlock)?.[0] || "";
  ok(`the form offers ${engine} the same step ceiling the route allows (${max})`,
     new RegExp(`maxSteps:\\s*${max}\\b`).test(entry), entry.slice(0, 80));
}
ok("...and the slider is actually re-capped on every engine change",
  /\$\("imgSteps"\)\.max = spec\?\.maxSteps/.test(appSrc));
ok("the form clears a leftover negative when the engine cannot use one",
  /if \(spec && !spec\.negative\) \$\("imgNeg"\)\.value = ""/.test(appSrc));
/* data-engineonly became a LIST when Z-Image base became the second CFG
 * engine. If the reader ever goes back to an exact-match comparison, the
 * negative box silently stops appearing for one of them. */
const htmlSrc = readFileSync(path.join(HERE, "..", "web", "index.html"), "utf8");
ok("the negative box is offered to every CFG engine, not just the checkpoint",
  /data-engineonly="checkpoint zimage-base"/.test(htmlSrc));
ok("...and the reader treats data-engineonly as a list",
  /dataset\.engineonly\.split\(\/\\s\+\/\)\.includes\(eng\)/.test(appSrc));

const html = readFileSync(path.join(HERE, "..", "web", "index.html"), "utf8");
const app = readFileSync(path.join(HERE, "..", "web", "app.js"), "utf8");
const refWrap = html.slice(html.indexOf('id="imgRefWrap"'), html.indexOf('id="imgGo"'));
for (const id of ["imgRefPick", "imgRefPrev", "imgRefClear", "imgRefCostNote",
                  "imgRefEngineNote", "imgRefTagNote", "imgRefLimit", "imgRefUpload", "imgRefFile"]) {
  ok(`the Images form has #${id}`, html.includes(`id="${id}"`));
}
/* THE ONE THAT MATTERS. The old markup hid the whole row on the other engines
 * (`data-engineonly="flux2"`), so a user who picked references and then
 * switched engine saw them vanish and had them dropped from the POST without a
 * word. Visible-and-explaining is the requirement. */
ok("the reference block is NOT hidden away on the other engines",
  refWrap.length > 0 && !refWrap.includes("data-engineonly"));
ok("...it explains why it cannot be used instead",
  app.slice(app.indexOf("function imgRefsPaint"), app.indexOf("function imgRefTagNote"))
    .includes("has no reference input"));
ok("the browser sends refImages whatever the engine is, so the server's refusal is heard",
  /\.\.\.\(imgRefs\.length \? \{ refImages: imgRefs\.map\(\(m\) => m\.name\) \} : \{\}\)/.test(app));
ok("...and no longer gates that on flux2 in the client",
  !app.includes('$("imgEngine").value === "flux2" && imgRefs.length'));
ok('the strip can reorder — the prompt says "image 1" by POSITION',
  app.includes("data-refup") && app.includes("data-refdown")
  && /imgRefs\.splice\(i - 1, 0, \.\.\.imgRefs\.splice\(i, 1\)\)/.test(app));
ok("...remove", app.includes("data-refx"));
ok("...and show the ordinal on each thumbnail", app.includes('class="refnum"'));
ok("the ordinal badge is styled",
  readFileSync(path.join(HERE, "..", "web", "styles.css"), "utf8").includes(".imgrefs .refnum"));
ok("the client cap matches the schema's and the route's ten", app.includes("const IMG_REF_MAX = 10"));
ok("the limit is on screen, not just enforced", app.includes('imgRefLimit").textContent'));
ok("the render cost is stated, from the same measurement the tool description quotes",
  app.includes("4 s per reference past the second"));
ok("switching engine repaints the block",
  app.slice(app.indexOf('$("imgEngine").onchange'), app.indexOf('$("imgGo").onclick'))
    .includes("imgRefsPaint();"));
ok("uploads go through /api/frame — the endpoint the Video tab's references use",
  /imgRefFile"\)\.onchange[\s\S]{0,700}\/api\/frame/.test(app));

/* -- WHICH MODEL PAINTED IT -----------------------------------------------
 * The engine was recorded from the first day and shown nowhere, which is the
 * cheaper half of the failure the census exists for: the data is there and no
 * surface reads it. These pin all four links in the chain, because breaking any
 * one of them returns the label to silence without failing anything else.
 *
 * The first check is the subtle one. #render() resolves the real engine (a
 * COVER carries none of its own and follows the Settings default), but the
 * event reported `job.engine || "flux2"` — so every cover Ideogram or a
 * checkpoint painted was filed as FLUX.2, and the ledger takes its `model`
 * from that same event. A confident wrong label is worse than none. */
const artSrcM = readFileSync(path.join(HERE, "art.js"), "utf8");
ok("the cover event reports the engine that ACTUALLY painted, not the job's wish",
  /engine: job\._paintedBy \|\| job\.engine/.test(artSrcM));
ok("...and the checkpoint filename beside it, since \"checkpoint\" names no model",
  /checkpoint: job\._paintedWith/.test(artSrcM));
ok("_paintedBy is stamped where the engine is actually decided",
  /job\._paintedBy = engine;/.test(artSrcM));

ok("the cover handler receives the checkpoint", /durationMs, engine, checkpoint \}/.test(idx));
ok("...stores it on the image", /checkpoint: checkpoint \?\? null \}\);/.test(idx));
ok("...and records it in the ledger BESIDE model, not instead of it",
  /model: engine \|\| "flux2"[\s\S]{0,400}checkpoint: checkpoint \?\? null,/.test(idx));

ok("the images route resolves the label server-side, from the one table",
  /model: meta \? modelLabel\(meta\) : null/.test(idx)
  && /modelUrl: meta \? modelPageUrl\(meta\) : null/.test(idx));
ok("...and imports them rather than keeping a second copy",
  /import \{[^}]*modelLabel[^}]*\} from "\.\/models\.js"/.test(idx));

ok("the back-fill reads ComfyUI's own graph out of the PNG", /async function pngComfyGraph/.test(idx));
ok("...and stops at IDAT rather than pulling the pixels into memory",
  /if \(type === "IDAT" \|\| type === "IEND"\) break;/.test(idx));
ok("...understands BOTH loaders: a user checkpoint and a shipped DiT",
  /ct\.startsWith\("CheckpointLoader"\)/.test(idx) && /ct === "UNETLoader"/.test(idx));
ok("...and identifies the DiT from the CATALOGUE, not a second hardcoded list",
  /export function engineFromModelFile/.test(readFileSync(path.join(HERE, "models.js"), "utf8")));
ok("an edit inherits what painted its original, with a bounded walk",
  /inheritedModel = true/.test(idx) && /hops\+\+ < 12/.test(idx));

const liM = byName.get("list_images");
ok("list_images hands the model to agents too — a human-only label is a parity break",
  /model: i\.model/.test(String(liM.run)) && /checkpoint: i\.checkpoint/.test(String(liM.run)));
ok("...including the engine id, so a picture can be reproduced through make_image",
  /engine: i\.modelId/.test(String(liM.run)));
ok("...and its description says so", /make_image/.test(liM.description || ""));

ok("the tile renders it", /class="immodel"/.test(app));
ok("...as a real link when the weights have a page", /data-modellink/.test(app));
ok("...and the link does not also open the editor behind it",
  /if \(e\.target\.closest\("a\[data-modellink\]"\)\) return;/.test(app));
ok("...a user's own checkpoint explains the missing link instead of dangling one",
  /it does not curate it/.test(app));
ok("the model line is styled",
  readFileSync(path.join(HERE, "..", "web", "styles.css"), "utf8").includes(".immodel"));

console.log(failures.length
  ? `\n  ${pass} ok, ${failures.length} FAILED\n`
  : `\n  all ${pass} checks pass\n`);
process.exit(failures.length ? 1 : 0);
