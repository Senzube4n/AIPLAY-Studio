/**
 * THE HARDWARE ANSWER, ON THE HUMAN SURFACE.
 *
 * server/fit_test.js proves the arithmetic. This proves a PERSON is shown it —
 * and shown the same thing an agent is told, which is the part that rots
 * quietly. The two surfaces read one computation today; the way that stops
 * being true is not a rewrite, it is somebody shortening a badge, or adding a
 * field to the tool and not the page, and every screen still rendering.
 *
 * FIVE THINGS IT PINS, in the order they would break:
 *
 *   1. PARITY AT THE PARAMETER LEVEL. Every fact the page puts on screen must
 *      be a fact models_for_this_machine returns, and every fact the tool
 *      returns must be one the page shows. Not "both surfaces exist" — both
 *      surfaces carrying the same fields. The first run of this found the page
 *      rendering nothing at all for `packages`, which the tool returns.
 *
 *   2. NO SECOND OPINION. web/modelfit.js may not contain a fit threshold, a
 *      chip word, or a reason sentence. Those live in server/fit.js and travel
 *      over the wire. A "16" appearing in the page's source is the first
 *      symptom of the screen and the agent disagreeing about one card.
 *
 *   3. THE WIRING. A perfect module nobody imports renders nothing, and does it
 *      silently: app.js must import it, call it after the list, and stamp
 *      `data-cap` on the rows the badges attach to. index.html must link the
 *      sheet. /api/models must send `fitStates`.
 *
 *   4. THE RENDER ITSELF, run against a stub DOM, on three machines that are
 *      not this one. This is the half a source-reading gate cannot do: it
 *      asserts the SENTENCES an 8 GB card is shown. There is no jsdom in this
 *      repo and this is not worth adding one for — modelfit.js touches eight
 *      DOM methods and they are stubbed below.
 *
 *   5. THE PALETTE. modelfit.css spells no colour, the same rule welcome.css
 *      and daw.css hold to.
 *
 * Runs standalone (`node server/modelfit_test.js`) and in the pre-commit hook.
 * Reads web/ and server/, writes nothing, needs no server and no GPU.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMachine, fitFor, recommendFor, FIT_STATES } from "./fit.js";
import { CATALOG } from "./models.js";
import { modelTools } from "./mcp-models.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = (f) => readFileSync(path.join(HERE, "..", "web", f), "utf8");
const S = (f) => readFileSync(path.join(HERE, f), "utf8");

const UI = W("modelfit.js");
const CSS_SRC = W("modelfit.css");
const APP = W("app.js");
const HTML = W("index.html");
const INDEX = S("index.js");
const MCP = S("mcp-models.js");

/* ══════════════════════════════════════════════════════════════════════════
 * 1. PARITY — the same facts on both surfaces
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Both surfaces consume one document, so parity here is not an action census
 * (this surface adds no action — see modelfit.js's header on why the download
 * button deliberately stays the row's). It is a FIELD census: the page and the
 * tool are two readers of /api/models, and a reader that skips a field is a
 * reader whose user never learns something the other user's did.
 *
 * The fields are extracted from each source rather than listed here, so a new
 * one added to fit.js is caught by whichever surface forgets it. */
console.log("\n-- parity: the page and the agent read the same fields --");

/* What the recommendation actually carries, from the horse's mouth: build one
 * against a fabricated 8 GB machine so the field set is the real one. */
const smallMachine = readMachine(
  { name: "NVIDIA GeForce RTX 3060 Ti", totalMb: 8192, usedMb: 900 },
  { totalMb: 16384, usedMb: 6000 },
);
const bigMachine = readMachine(
  { name: "NVIDIA GeForce RTX 4090", totalMb: 24564, usedMb: 1200 },
  { totalMb: 65536, usedMb: 8000 },
);
const noCardMachine = readMachine(null, { totalMb: 32768, usedMb: 12000 });

function payloadFor(machine, { freeBytes = 900e9, ready = false } = {}) {
  const capabilities = CATALOG.map((c) => ({
    ...c,
    /* Fresh install: nothing on disk. That is the state the whole feature is
     * for, and the state this rig can never be in. */
    ready,
    haveBytes: ready ? c.files?.reduce((n, f) => n + (f.bytes || 0), 0) || c.totalBytes || 0 : 0,
    totalBytes: c.totalBytes ?? (c.files || []).reduce((n, f) => n + (f.bytes || 0), 0),
    files: (c.files || []).map((f) => ({ ...f, present: ready })),
    packageReady: c.needsPackage ? false : true,
    fit: fitFor(c.requires, machine),
  }));
  const disk = { freeBytes };
  return {
    disk,
    machine,
    capabilities,
    recommended: recommendFor({ capabilities, machine, disk }),
    fitStates: FIT_STATES,
    python: { path: "python", packages: {} },
  };
}

const sample = payloadFor(smallMachine);

/* Every key of a pick, of a note and of the top-level recommendation. */
const pickKeys = new Set(sample.recommended.picks.flatMap((p) => Object.keys(p)));
const recKeys = new Set(Object.keys(sample.recommended));

/* What the TOOL returns, parsed out of its own mapper rather than guessed. */
const toolPickFields = new Set([...MCP.matchAll(/^\s*slot: p\.slot.*$/gm)].length
  ? [...MCP.matchAll(/\b(slot|id|label|fit|ready|gigabytes|licence|outputRights|territoryExcluded|why):/g)].map((m) => m[1])
  : []);
ok("the tool's pick mapper was found (a regex matching nothing would pass everything)",
  toolPickFields.size >= 8, `found ${toolPickFields.size}`);

/* The page's reads. `rec.x`, `p.x`, `n.x`, `k.x`, `m.x` — every property this
 * module pulls off the payload. */
const pageReads = new Set([...UI.matchAll(/\b(?:rec|p|n|k|m|fit|d)\.([a-zA-Z]+)/g)].map((x) => x[1]));

/* THE FIELDS THAT CARRY THE ANSWER. Each is on this list because a page
 * missing it shows a materially different picture than the agent describes. */
const MUST_SHOW = ["headline", "picks", "notes", "packages", "missingBytes", "bytesNote", "machine"];
for (const f of MUST_SHOW) {
  ok(`the page renders recommended.${f}`, pageReads.has(f) && UI.includes(f),
    `models_for_this_machine returns it; the screen must too`);
  ok(`recommended.${f} is really a field fit.js produces`, recKeys.has(f) || f === "machine");
}

/* Per-pick: the four a person needs to act, and the two that are legal facts. */
for (const f of ["slot", "label", "why", "bytes", "ready", "region"]) {
  ok(`each pick shows .${f}`, pageReads.has(f), `pick keys: ${[...pickKeys].join(", ")}`);
  ok(`.${f} is a key picks actually carry`, pickKeys.has(f));
}

/* Both interfaces can request a download through the same guarded route.
 * Supporting MCP control must not infer the person's territory acknowledgement. */
const downloadCalls = [];
const downloadTools = modelTools(async (method, route, body) => {
  downloadCalls.push({ method, route, body }); return { started: body.id };
});
const hardwareTool = downloadTools.find((tool) => tool.name === "models_for_this_machine");
const downloadTool = downloadTools.find((tool) => tool.name === "download_model");
ok("the hardware tool names the download action and requires explicit territory acknowledgement",
  /download_model/.test(hardwareTool.description) && /explicit acknowledgement/.test(hardwareTool.description)
  && /ONLY when the person has told you/.test(downloadTool.description));
await downloadTool.run({ id: "videoH3" });
await downloadTool.run({ id: "videoH3", accept_region: false });
await downloadTool.run({ id: "videoH3", accept_region: true });
ok("MCP downloads use the Models route and never add an unacknowledged territory flag",
  downloadCalls.every((call) => call.method === "POST" && call.route === "/api/models" && call.body.action === "download")
  && !Object.hasOwn(downloadCalls[0].body, "acceptRegion") && !Object.hasOwn(downloadCalls[1].body, "acceptRegion")
  && downloadCalls[2].body.acceptRegion === true);
ok("the page's block adds NO action of its own (no POST in modelfit.js)",
  !/fetch\s*\(/.test(UI) && !/action:\s*"/.test(UI),
  "a download path here would bypass the row's territory acknowledgement");

/* ══════════════════════════════════════════════════════════════════════════
 * 2. NO SECOND OPINION
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n-- the page holds no opinion of its own --");

/* Strip the comment block — the header EXPLAINS the rule using the words the
 * rule forbids, which is correct prose and would be a false positive here. */
const code = UI.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

for (const [state, def] of Object.entries(FIT_STATES)) {
  ok(`the chip word for "${state}" is not typed in the page`,
    !code.includes(def.chip),
    `"${def.chip}" must arrive as fitStates.${state}.chip, or the screen and the agent can drift apart`);
}
ok("no fit state name is hard-coded as a displayed string",
  !/["'](Fits|Runs|Below|Cannot)/.test(code));

/* A VRAM number in the page's source is the real hazard: it looks harmless and
 * it silently overrides the catalogue. Allow the small integers that are
 * genuinely layout (0, 1, 2, 35, 999, 1e9 and friends) and catch the rest. */
const suspicious = [...code.matchAll(/\b(\d{1,3})\s*(?:GB|gb)\b/g)].map((m) => m[0]);
ok("no VRAM or RAM threshold is written into the page",
  suspicious.length === 0, `found: ${suspicious.join(", ")}`);

/* Every long sentence the user reads must have come off the wire. A hard-coded
 * paragraph in here is a second description of the machine. */
const strings = [...code.matchAll(/`([^`$]{60,})`|"([^"]{60,})"/g)].map((m) => m[1] || m[2]);
const prose = strings.filter((s) => /[a-z] [a-z]+ [a-z]+ [a-z]+ [a-z]+ [a-z]/.test(s));
ok("the page writes no long prose of its own",
  prose.length === 0, prose.map((p) => `"${p.slice(0, 70)}…"`).join("\n          "));

/* ══════════════════════════════════════════════════════════════════════════
 * 3. THE WIRING
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n-- wired to the screen a person actually opens --");

/* ⚠ COMMENTS STRIPPED FIRST, and this is not tidiness — it is the bug this
 * whole section exists to catch, which it did not catch.
 *
 * These four checks were written against the raw source of app.js. Commenting
 * the single call out —
 *
 *     -  paintFit(d);
 *     +  /* paintFit(d); *\/
 *
 * leaves `/paintFit\(d\)/` matching happily, and `indexOf` finding it at the
 * same place. The block then renders NOWHERE, on every machine, and this file
 * reported 66 passed / 0 failed. That is precisely the silent-nothing failure
 * the header above promises to prevent: the server stays right, every other
 * suite stays green, and the only symptom is a screen that went back to listing
 * seventeen models and recommending none.
 *
 * Found by commenting it out and watching the test pass. `code` does the same
 * for modelfit.js a few dozen lines up; the wiring had simply never been given
 * the same treatment. */
const app = APP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

ok("app.js imports the module", /import\s*\{[^}]*paintFit[^}]*\}\s*from\s*"\.\/modelfit\.js"/.test(app));
ok("app.js calls paintFit with the payload it already fetched (no second request)",
  /paintFit\(d\)/.test(app) && !/fetch\("\/api\/models"\)[\s\S]{0,200}paintFit/.test(UI));
ok("paintFit is called AFTER the list is written",
  app.indexOf("paintFit(d)") > app.indexOf('$("modelList").innerHTML'));
ok("initFit is called once at load", /initFit\(\)/.test(app));
/* THE CHECK ON THE CHECKS. The four above are only worth anything if they can
 * fail, and for a day they could not. So the disabling edit is performed here,
 * on a copy in memory, and the predicate is required to go false — the strip
 * cannot quietly stop working without this line saying so. Commenting out is
 * the edit that matters because it is how a line actually gets disabled; nobody
 * deletes code to test a theory. */
const disabled = app.replace("paintFit(d);", "/* paintFit(d); */")
  .replace(/\/\*[\s\S]*?\*\//g, "");
ok("commenting the call out makes those checks fail (they can detect it at all)",
  !/paintFit\(d\)/.test(disabled),
  "the wiring checks match commented-out code, so a screen that renders nothing passes");
ok("every row carries data-cap, which is what the badges attach to",
  /class="modelcard\$\{[^}]*\}"\s+data-cap="\$\{esc\(c\.id\)\}"/.test(APP),
  "without it the badge would have to guess by row order");
ok("index.html links modelfit.css", /href="modelfit\.css"/.test(HTML));
ok("/api/models sends the chip vocabulary", /fitStates:\s*FIT_STATES/.test(INDEX));
ok("index.js imports FIT_STATES to do it", /import\s*\{[^}]*FIT_STATES[^}]*\}\s*from\s*"\.\/fit\.js"/.test(INDEX));

/* ══════════════════════════════════════════════════════════════════════════
 * 4. THE RENDER — three machines, none of them this one
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A stub DOM, not a mock of the module. paintFit runs for real; only the eight
 * document methods it touches are supplied. Anything it calls that is not here
 * throws, which is the point — a stub that quietly absorbs unknown calls would
 * pass a module that had stopped rendering. */
console.log("\n-- the render, on machines this rig is not --");

function stubDom(capIds) {
  const made = [];
  const cards = new Map();
  const mk = (tag) => {
    const el = {
      tagName: tag, id: "", className: "", innerHTML: "", hidden: false,
      dataset: {}, children: [], parentNode: null, offsetWidth: 1,
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, has(c) { return this._s.has(c); } },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      insertBefore(c) { this.children.push(c); c.parentNode = this; return c; },
      querySelector(sel) {
        const m = /^\[data-cap="(.+)"\]$/.exec(sel);
        if (m) return cards.get(m[1]) || null;
        return this.children.find((c) => c.className?.split(" ").includes(sel.replace(/^\./, ""))) || null;
      },
      scrollIntoView() {},
    };
    made.push(el);
    return el;
  };
  const list = mk("div");
  list.id = "modelList";
  const parent = mk("div");
  parent.appendChild(list);
  list.parentNode = parent;
  for (const id of capIds) {
    const card = mk("div");
    card.className = "modelcard";
    const head = mk("div");
    head.className = "mhead";
    card.appendChild(head);
    cards.set(id, card);
  }
  return {
    getElementById: (id) => (id === "modelList" ? list : made.find((e) => e.id === id) || null),
    createElement: mk,
    querySelector: (sel) => { const m = /^\[data-cap="(.+)"\]$/.exec(sel); return m ? cards.get(m[1]) || null : null; },
    addEventListener() {},
    _cards: cards,
    _box: () => made.find((e) => e.id === "modelFit"),
  };
}

/* CSS.escape is a browser global the module uses to look rows up safely. */
globalThis.CSS = globalThis.CSS || { escape: (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };
const { paintFit } = await import(path.join(HERE, "..", "web", "modelfit.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));

function render(machine, opts) {
  const d = payloadFor(machine, opts);
  const dom = stubDom(d.capabilities.map((c) => c.id));
  paintFit(d, dom);
  const box = dom._box();
  const badges = new Map([...dom._cards].map(([id, card]) => {
    const slot = card.children.find((c) => c.className === "fitbadgeslot")
      || card.children[0]?.children?.find((c) => c.className === "fitbadgeslot");
    return [id, slot ? slot.innerHTML : ""];
  }));
  return { d, box, badges, html: box?.innerHTML || "" };
}

/* ── the 8 GB card, fresh disk ─────────────────────────────────────────── */
const small = render(smallMachine);
ok("8 GB: the block renders and is visible", !!small.box && small.box.hidden === false);
ok("8 GB: the machine's own numbers are quoted before any advice",
  small.html.includes("RTX 3060 Ti") && small.html.includes("8 GB VRAM") && small.html.includes("16 GB RAM"),
  small.html.slice(0, 300));
ok("8 GB: the headline is the server's, verbatim",
  small.html.includes(small.d.recommended.headline.slice(0, 60)));
ok("8 GB: a byte total is stated", /to download/.test(small.html));
ok("8 GB: the required music engine is picked whatever it scores",
  /class="fitslot">music</.test(small.html));

/* THE ONE THAT MATTERS. An 8 GB card used to be told "needs 16 GB of VRAM,
 * you have 8" for H3. The H3 lab (2026-09-24) measured 960x544 for 5 s
 * fitting an 8 GB cap, so the badge now names the SIZE it runs at, in the
 * server's words, and the RAM warning is a visible line, not a hover. */
const h3Badge = small.badges.get("video");
ok("8 GB: the video row's badge names the size it runs at",
  /960x544, 5 s/.test(h3Badge) && !/needs 16 GB/.test(h3Badge), h3Badge);
ok("8 GB: that badge uses the server's chip word",
  h3Badge.includes(FIT_STATES["smaller"].chip), h3Badge);
ok("8 GB: it is toned as a cost, not as a refusal",
  /fit-warn/.test(h3Badge) && !/fit-bad/.test(h3Badge), h3Badge);
ok("8 GB: the full reason is available on hover rather than lost",
  /title="[^"]{40,}"/.test(h3Badge));
ok("8 GB, 16 GB of RAM: the RAM warning is a visible line under the badge",
  /class="fitwarn">⚠ H3 was only measured with 32 GB of RAM/.test(h3Badge), h3Badge);
ok("8 GB: the TaoMate rows say the same as the model they load into",
  small.badges.get("videoH3Turbo3Small") === h3Badge && small.badges.get("videoH3Turbo3") === h3Badge);

/* A card under every H3 tier is still refused, in numbers it can check. */
const tiny = render(readMachine({ name: "NVIDIA GeForce GTX 1650", totalMb: 4096, usedMb: 300 }, { totalMb: 16384, usedMb: 6000 }));
const tinyBadge = tiny.badges.get("video");
ok("4 GB: the video row's badge names the printed minimum, the preview floor and the card",
  /needs 8 GB of VRAM \(6 for an experimental preview\), you have 4/.test(tinyBadge), tinyBadge);
ok("4 GB: that badge uses the server's chip word, toned as a refusal",
  tinyBadge.includes(FIT_STATES["wont-run"].chip) && /fit-bad/.test(tinyBadge), tinyBadge);

/* The unproven 6 GB preview: "Cannot tell", never a chip that says it runs. */
const six = render(readMachine({ name: "NVIDIA GeForce RTX 2060", totalMb: 6144, usedMb: 300 }, { totalMb: 32659, usedMb: 6000 }));
const sixBadge = six.badges.get("video");
ok("6 GB: the preview badge is 'Cannot tell' with the size and 'not proven', not 'Runs'",
  sixBadge.includes(FIT_STATES["unknown"].chip) && /832x480, 5 s · experimental preview, not proven/.test(sixBadge)
    && !sixBadge.includes(FIT_STATES["smaller"].chip), sixBadge);
ok("6 GB: and H3 is not in the picks at the top", !/class="fitslot">video</.test(six.html));

/* ── the 24 GB card ────────────────────────────────────────────────────── */
const big = render(bigMachine);
ok("experimental native badge never fabricates a null/zero VRAM minimum or absent GPU",
  !/null GB|undefined GB|asks for 0|no card reading/.test(big.badges.get("musicYue2Gguf"))
    && /minimum hardware floor has not been established/.test(big.badges.get("musicYue2Gguf")));
ok("24 GB: H3 fits outright", FIT_STATES["fits"].chip && big.badges.get("video").includes(FIT_STATES["fits"].chip),
  big.badges.get("video"));
ok("24 GB: a fitting row still shows its evidence",
  /24 GB card, 64 GB RAM/.test(big.badges.get("video")), big.badges.get("video"));
ok("24 GB: the Fast setting's pick shows a slot word a person reads, not the id 'video-fast'",
  /class="fitslot">fast video</.test(big.html) && !/class="fitslot">video-fast</.test(big.html));
ok("24 GB: the gated engine is reported and never recommended",
  /cannot download it for you/.test(big.html) && !/class="fitslot">video<\/span>\s*<b>[^<]*LTX/.test(big.html),
  "LTX 2.5 has no button; naming it as a pick is the dead end this feature exists to remove");

/* ── no NVIDIA card ────────────────────────────────────────────────────── */
const none = render(noCardMachine);
ok("no card: says so without calling it a failure",
  /No NVIDIA card could be read/.test(none.html));
ok("no card: still reports the one number it does know",
  /32 GB RAM/.test(none.html));
ok("no card: every badge is 'unknown', never 'wont-run'",
  [...none.badges.values()].every((b) => !b || b.includes(FIT_STATES["unknown"].chip) || b.includes(FIT_STATES["wont-run"].chip)));
ok("no card: the unknown badge is toned neutrally, not as an error",
  !/fit-bad/.test(none.badges.get("video") || ""), none.badges.get("video"));
ok("no card: the reason nvidia-smi found nothing is spelled out",
  /nvidia-smi/.test(none.html));

/* ── the disk check ────────────────────────────────────────────────────── */
const tight = render(bigMachine, { freeBytes: 1e9 });
ok("a total larger than the free disk is called out before the download starts",
  /only [\d.]+ GB free/.test(tight.html) && /fitbad/.test(tight.html), tight.html.slice(0, 400));

/* ── an old server ─────────────────────────────────────────────────────── */
const dom = stubDom(["engine"]);
paintFit({ capabilities: [] }, dom);
ok("a payload with no recommendation hides the block instead of breaking the screen",
  dom._box()?.hidden === true);

/* ══════════════════════════════════════════════════════════════════════════
 * 5. THE PALETTE
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n-- one palette --");
const cssCode = CSS_SRC.replace(/\/\*[\s\S]*?\*\//g, "");
const rawColour = [...cssCode.matchAll(/#[0-9a-fA-F]{3,8}\b|\bhsla?\(|\brgba?\(/g)].map((m) => m[0]);
ok("modelfit.css spells no colour of its own", rawColour.length === 0, rawColour.join(", "));
ok("it uses the app's tokens", /var\(--ok\)/.test(cssCode) && /var\(--warn\)/.test(cssCode) && /var\(--ghost\)/.test(cssCode));
ok("the 'unknown' tone is NOT the error colour",
  !/\.fit-unknown\s*\{[^}]*var\(--err\)/.test(cssCode),
  "an Apple or AMD machine has not been rejected and must not be coloured as if it had");

console.log(`\n  ${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
