/**
 * THE DOCUMENTS A STRANGER READS BEFORE THEY TRUST ANYTHING.
 *
 * README.md, INSTALL.md and the landing page (docs/index.html) are what
 * somebody reads before deciding whether to spend forty gigabytes and an
 * evening on this — the page usually first. Every claim
 * in them about sizes, licences and hardware was typed by hand against a
 * seventeen-entry catalogue, and by 2026-09-02 both had drifted — one listed
 * thirteen models, the other seven, and where they overlapped they disagreed
 * with `server/models.js` and with each other about three download sizes. None
 * of it was visible: a wrong number in a markdown table looks exactly like a
 * right one.
 *
 * So this suite is the alarm. It does not check prose. It checks the claims that
 * have a single source of truth somewhere else in the tree, and it fails when a
 * document and that source stop agreeing:
 *
 *   1  THE MODEL TABLES are the catalogue's own rendering, byte for byte — in
 *      all three documents, markdown and HTML alike.
 *   2  THE CLONE URL in INSTALL.md is package.json's. A public release and a
 *      development fork must each install the repository they document.
 *   3  NO DOCUMENT CALLS A MODEL THE DEFAULT UNLESS config.js DOES. Read from
 *      the literal in the source, not from `config.video.engine`, because a
 *      saved pref in settings.json masks the shipped value on every developer's
 *      machine — the same trap fit_test.js documents.
 *   4  EVERY pip COMMAND QUOTED is one the catalogue actually states, and the
 *      interpreter each is aimed at is the one the server really spawns.
 *   5  examples/ MATCHES ITS OWN MANIFEST — every file present at its recorded
 *      size and hash, inside the size budget, with the licence attribution the
 *      one licence that asks for it asks for.
 *   6  EVERY EXAMPLE REQUEST IS ONE THE TOOL WOULD ACCEPT, checked against the
 *      live MCP schemas. An example is copied; a request.json with a field the
 *      tool does not have is a refusal in somebody's terminal with this
 *      repository's name on it. The first draft had one.
 *   7  EVERY npm DEPENDENCY IS NAMED IN NOTICE AND INSTALL.md, and no document
 *      still calls the list one package long. `three` and `gltf-validator` were
 *      added to package.json and both files went on saying `ws` was "the only
 *      runtime dependency Studio installs" — while a static import of the
 *      validator sits at the top of a module server/index.js loads, so the
 *      documented dependency list could not start the program it documents.
 *      A licence file that omits a dependency is the half that matters: it is
 *      the only attribution a fork ever reads.
 *
 * Runs on a clone that has never rendered anything: the examples GATE reads the
 * committed directory, while the BUILDER (scripts/examples.mjs) is the half that
 * needs a rig.
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "./models.js";
import {
  rebuild, TARGETS, BEGIN, END,
  rebuildHtml, HTML_TARGET, HTML_BLOCKS, htmlBegin, htmlEnd, targetCommands,
} from "../scripts/models_table.mjs";
import { TOOLS } from "./mcp.js";
import { ggufFilesFor } from "./music/yue-gguf.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const sha = (b) => "sha256:" + createHash("sha256").update(b).digest("hex");

let pass = 0, fail = 0;
/**
 * `why` is printed ONLY on failure. That is not tidiness: the first draft
 * printed it either way, so a passing check reported "ok — no `spawn(...)` in
 * server/art.js" and read exactly like a failure that had been miscounted.
 * `note` is the half that is worth seeing when things are fine.
 */
const ok = (name, cond, why = "", note = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}${note ? `  — ${note}` : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${why ? `\n          ${why}` : ""}`); }
};

/* ═══ 1. the tables are the catalogue's ══════════════════════════════════ */
console.log("\n  the model tables are generated, not typed");
for (const name of TARGETS) {
  const current = read(name);
  ok(`${name} has the marker block`, current.includes(BEGIN) && current.includes(END));
  let next = null;
  try { next = rebuild(current, name); } catch (e) { ok(`${name} block is well formed`, false, e.message); }
  if (next !== null) {
    ok(`${name} table matches server/models.js`, current === next,
      "run: node scripts/models_table.mjs");
  }
}
/* The point of generating is that both documents say the SAME thing. Two
 * generated tables that differ would just be a slower way of drifting. */
{
  const grab = (name) => {
    const s = read(name);
    return s.slice(s.indexOf(BEGIN), s.indexOf(END) + END.length).replace(/\r\n/g, "\n");
  };
  ok("README and INSTALL carry an identical block", grab("README.md") === grab("INSTALL.md"));
}
/**
 * AND THE LANDING PAGE, which is the document most strangers actually read
 * first — the two markdown files are what you find AFTER deciding to look.
 *
 * It kept a third hand-typed table: six of the seventeen capabilities, with
 * H3's excluded territories spelled out by hand for the fourth time in this
 * repository. Its numbers were corrected by the easy-setup gate on 2026-09-02,
 * which is the whole argument — a table somebody has to correct is a table that
 * will need correcting again, and this one had no generator to correct it from.
 *
 * It is HTML, so it gets its own renderer and its own marker names, but the
 * bargain is identical: the block between the markers is the catalogue's
 * rendering, and --check fails the moment it and `server/models.js` disagree.
 */
{
  const current = read(HTML_TARGET);
  for (const b of HTML_BLOCKS) {
    ok(`${HTML_TARGET} has the ${b.name || "table"} marker block`,
      current.includes(htmlBegin(b.name)) && current.includes(htmlEnd(b.name)),
      `expected ${htmlBegin(b.name)} … ${htmlEnd(b.name)}`);
  }
  let next = null;
  try { next = rebuildHtml(current, HTML_TARGET); }
  catch (e) { ok(`${HTML_TARGET} blocks are well formed`, false, e.message); }
  if (next !== null) {
    ok(`${HTML_TARGET} tables match server/models.js`, current === next,
      "run: node scripts/models_table.mjs");
  }
  /* The territory names are the reason this block exists, so prove the
   * rendering still carries them rather than only that it matches itself: an
   * empty generator would satisfy every check above. */
  const region = CATALOG.find((c) => c.region?.excluded?.length);
  ok(`${HTML_TARGET} states the excluded territories from the catalogue`,
    !region || region.region.excluded.every((t) => current.includes(t)),
    "the generated table no longer names every territory server/models.js excludes");
}

/* ═══ 2. the clone URL is the repository this actually is ════════════════ */
console.log("\n  the install guide points at THIS repository");
{
  const pkg = JSON.parse(read("package.json"));
  const url = String(pkg.repository?.url || "").replace(/\.git$/, "");
  const slug = url.split("github.com/")[1];
  ok("package.json names a github repo", !!slug, url, url);
  const install = read("INSTALL.md");
  ok("INSTALL.md's clone line is that repo", install.includes(`git clone ${url}.git`),
    `expected "git clone ${url}.git"`);
  ok("INSTALL.md's download link is that repo", install.includes(`(${url})`),
    `expected a link to ${url}`);
  /* Do not hardcode the private fork as the only valid release. Keep the
   * regression guard in both directions, using this checkout's metadata. */
  for (const doc of [...TARGETS, HTML_TARGET, "docs/YUE2_GGUF.md", "package.json"]) {
    const links = [...read(doc).matchAll(/https:\/\/github\.com\/([^/\s"'<>]+\/AIPLAY-Studio(?:-MV)?)(?=[./)\s"'#<>]|$)/g)];
    const bad = links.filter((match) => `https://github.com/${match[1]}` !== url);
    ok(`${doc} Studio repository links match package.json`, bad.length === 0,
      bad.length ? `${bad.length} link(s) name a different Studio repository` : "");
  }
}

/* ═══ 2b. the npm dependencies, named where a stranger reads them ════════ */
console.log("\n  every npm dependency is documented");
{
  const pkg = JSON.parse(read("package.json"));
  const deps = Object.keys(pkg.dependencies || {});
  const lock = JSON.parse(read("package-lock.json"));
  const packages = lock.packages || {};
  const packageKeys = Object.keys(packages).filter((k) => k.startsWith("node_modules/"));
  const installed = packageKeys.map((k) => k.split("node_modules/").at(-1));
  /* The lock is the truth about what `npm install` actually puts on the disk.
   * A transitive dependency nobody declared is still a licence this file owes
   * the reader. Compare root declarations separately from the resolved graph. */
  const sortedEntries = (value) => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
  ok("package-lock root dependencies match package.json",
    sortedEntries(packages[""]?.dependencies) === sortedEntries(pkg.dependencies),
    "the lock root names or version ranges differ from package.json");
  const graphErrors = [], reached = new Set(), pending = [""];
  const resolveDependency = (from, name) => {
    for (let owner = from;;) {
      const key = `${owner ? owner + "/" : ""}node_modules/${name}`;
      if (packages[key]) return key;
      if (!owner) return null;
      const parent = owner.lastIndexOf("/node_modules/");
      owner = parent < 0 ? "" : owner.slice(0, parent);
    }
  };
  while (pending.length) {
    const key = pending.pop(), entry = packages[key] || {};
    if (reached.has(key)) continue;
    reached.add(key);
    const edges = { ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies };
    for (const name of Object.keys(edges)) {
      const target = resolveDependency(key, name);
      const optional = name in (entry.optionalDependencies || {}) || entry.peerDependenciesMeta?.[name]?.optional;
      if (target) pending.push(target);
      else if (!optional) graphErrors.push(`${key || "root"} cannot resolve ${name}`);
    }
  }
  for (const key of packageKeys) {
    if (!reached.has(key)) graphErrors.push(`${key} is not reachable from a declared dependency`);
    try {
      const actual = JSON.parse(read(`${key}/package.json`));
      if (actual.name !== key.split("node_modules/").at(-1) || actual.version !== packages[key].version)
        graphErrors.push(`${key} installed name/version differs from the lock`);
    } catch { graphErrors.push(`${key} is not installed`); }
  }
  ok("every locked package is reachable and installed at its locked version", !graphErrors.length, graphErrors.join("; "));
  const notice = read("NOTICE");
  const install = read("INSTALL.md");
  for (const dep of new Set([...deps, ...installed])) {
    ok(`NOTICE names ${dep}`, notice.includes(dep),
      "a runtime dependency with no entry in the one file a fork reads for licences");
    ok(`INSTALL.md names ${dep}`, install.includes(dep),
      "the install guide does not say this package is fetched");
  }
  /* The launcher is the thing that actually fetches them, and its own guard
   * tested only `node_modules\ws` — so an existing install that already had ws
   * skipped npm entirely and the server died on an import nobody had fetched. */
  const launcher = read("AIPLAY Studio.cmd");
  for (const dep of deps) {
    ok(`the launcher checks for ${dep} before skipping npm install`,
      launcher.includes(`node_modules\\${dep.replaceAll("/", "\\")}`),
      "an existing node_modules missing this package would not trigger an install");
  }
  const nativeLauncher = read("launcher/exe/AiplayLauncher.cs");
  const nativeGuard = nativeLauncher.match(/static bool DepsPresent\(string root\)\s*\{([\s\S]*?)return true;/)?.[1] || "";
  for (const dep of deps) {
    ok(`the native launcher checks for ${dep} before skipping npm install`, nativeGuard.includes(JSON.stringify(dep)),
      "the windowless launcher dependency guard differs from package.json");
  }
  /* ⚠ THE EXACT SENTENCE THAT WENT FALSE. Both documents said one package, and
   * kept saying it through two additions. Pin the shape of the claim, not the
   * wording, so the next addition cannot quietly leave it behind. */
  for (const doc of ["NOTICE", "INSTALL.md", "README.md", "docs/index.html"]) {
    const text = read(doc);
    const singular = /\b(only|one|single)\b[^.\n]{0,40}\b(runtime )?(npm )?(dependenc(y|ies)|packages?)\b/i;
    ok(`${doc} does not call the dependency list one package long`,
      deps.length === 1 || !singular.test(text),
      `${doc} still describes a single dependency while package.json declares ${deps.length}`);
  }
  /* AND THAT "REQUIRED FOR BOOT" IS TRUE OF THE ONE THAT IS EASIEST TO DOUBT.
   * gltf-validator looks optional — it validates uploads — but the import is
   * static and at the top of a module server/index.js imports, so the process
   * cannot start without it. Read from the source, not from the claim. */
  const avatar = read("server/mesh/avatar.js");
  ok("server/mesh/avatar.js imports gltf-validator statically",
    /^import .*from ['"]gltf-validator['"];?$/m.test(avatar),
    "the boot-critical claim in NOTICE/INSTALL.md is no longer true of this file");
  ok("server/index.js imports that module statically",
    /^import .*from "\.\/mesh\/avatar\.js";?$/m.test(read("server/index.js")),
    "avatar.js is no longer on the boot path — restate the dependency's status");
}

/* ═══ 3. nothing is called the default but the default ═══════════════════ */
console.log("\n  the default video engine, read from the source literal");
{
  /* ⚠ Deliberately NOT config.video.engine. settings.json overrides it on every
   * machine that has ever touched the Video panel, so reading the live value
   * would make this check pass against a defect. */
  const src = read("server/config.js");
  const m = src.match(/^\s*engine:\s*"([a-z0-9]+)",/m);
  ok("config.js states a video engine literal", !!m, m ? "" : "no `engine: \"...\"` found");
  const shipped = m?.[1];
  const label = (id) => {
    const key = { h3: "video", ltx: "videoLtx" }[id];
    return CATALOG.find((c) => c.id === key)?.label || id;
  };
  ok("the shipped default is a model Studio can download",
    !CATALOG.find((c) => c.id === { h3: "video", ltx: "videoLtx" }[shipped])?.gated,
    `${label(shipped)} is gated — a gated repo has no button, so a default pointing at it is a dead end`,
    label(shipped));

  const others = { h3: "LTX 2.5", ltx: "MiniMax H3" }[shipped];
  for (const doc of [...TARGETS, "docs/demo/manifest.json", "scripts/demos.mjs"]) {
    const text = read(doc);
    /* "<other engine> ... is the default" in any order within a short span. */
    const claim = new RegExp(`${others.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^.\\n]{0,60}\\bis the default\\b`, "i");
    const claim2 = new RegExp(`\\bdefault\\b[^.\\n]{0,30}${others.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    ok(`${doc} does not call ${others} the default`, !claim.test(text) && !claim2.test(text));
  }
}

/* ═══ 4. the pip commands, and the interpreter each is aimed at ══════════ */
console.log("\n  the pip half");
{
  const install = read("INSTALL.md");
  const readme = read("README.md");
  const withCmd = CATALOG.filter((c) => c.packageInstall);
  ok("the catalogue states a command for every package capability",
    withCmd.length >= 3, "fewer than three entries carry packageInstall",
    `${withCmd.length} entries`);
  for (const cap of withCmd) {
    ok(`INSTALL.md quotes ${cap.id}'s exact command`, install.includes(cap.packageInstall),
      `missing: ${cap.packageInstall}`, cap.packageInstall);
  }
  /* No document may invent a pip line the catalogue does not state. This is the
   * check that would have caught INSTALL.md telling people to install into
   * ComfyUI's own python, which is the 4.9x defect. */
  /* Plus the lines models_table.mjs prints under a row to say WHICH python
   * (timed lyrics' own venv): built from the catalogue's line by server/lrc.js,
   * the builder the app's messages use, and aimed at that venv on purpose. */
  const known = new Set([...withCmd.map((c) => c.packageInstall), ...targetCommands()]);
  for (const [doc, text] of [["README.md", readme], ["INSTALL.md", install]]) {
    /* ⚠ A backticked `pip install` with nothing after it is a MENTION, not a
     * command — §5 carries one ("Never `pip install` anything into ComfyUI's
     * environment"), and the first draft of this check failed on it. Require a
     * package name to follow. */
    for (const [, line] of text.matchAll(/`([^`\n]*\bpip install\s+[-\w][^`\n]*)`/g)) {
      ok(`${doc}: "${line}" is a catalogue command`, known.has(line.trim()),
        "no catalogue entry states this line — a pip command a document invents on its "
        + "own is exactly how somebody installs into the wrong python");
    }
  }
  /* THE PAIRING THAT MATTERS. extras_setup.mjs tells people which interpreter
   * to install into; if the server later spawns a different one, the advice
   * becomes confidently wrong and everything still "works". So the script's
   * claim is checked against the file it names. */
  const script = read("scripts/extras_setup.mjs");
  const pairs = [...script.matchAll(/spawnedBy:\s*\["([^"]+)",\s*"([^"]+)"\]/g)];
  ok("extras_setup names its spawn sites", pairs.length >= 3,
    "fewer than three spawnedBy pairs", `${pairs.length} pairs`);
  for (const [, file, expr] of pairs) {
    ok(`${file} really spawns ${expr}`, read(file).includes(`spawn(${expr}`),
      `no \`spawn(${expr}\` in ${file}`);
  }
  ok("INSTALL.md points at the script", install.includes("node scripts/extras_setup.mjs"));
}

/* ═══ 5. examples/ is what its manifest says it is ═══════════════════════ */
console.log("\n  examples/");
{
  const mfPath = path.join(ROOT, "examples", "manifest.json");
  ok("examples/manifest.json exists", existsSync(mfPath));
  if (existsSync(mfPath)) {
    const mf = JSON.parse(readFileSync(mfPath, "utf8"));
    let total = 0, missing = 0, wrong = 0;
    for (const ex of mf.examples) {
      for (const f of ex.files) {
        const p = path.join(ROOT, "examples", ex.dir, f.name);
        if (!existsSync(p)) { missing++; continue; }
        const buf = readFileSync(p);
        total += buf.length;
        if (buf.length !== f.bytes || sha(buf) !== f.sha256) wrong++;
      }
      /* An example is a PAIR. One with no input is a screenshot, and one with
       * no output is a promise. */
      ok(`${ex.dir} pairs input with output`, ex.input?.length > 0 && ex.output?.length > 0);
      /* Every named input and output is a file the manifest also lists, so a
       * renamed file cannot leave the README pointing at nothing. */
      const named = new Set(ex.files.map((f) => f.name));
      const dangling = [...ex.input, ...ex.output].filter((n) => !named.has(n));
      ok(`${ex.dir} names only files it ships`, dangling.length === 0, dangling.join(", "));
    }
    /* ⚠ AND GIT MUST NOT REWRITE WHAT THE MANIFEST HASHED. `core.autocrlf` is
     * true on Windows, so without a .gitattributes rule a fresh clone gets the
     * .json and .txt files with CRLF endings and every hash below fails on a
     * checkout nobody has touched. Checked here rather than discovered by the
     * first person to clone. */
    ok("examples/ is pinned in .gitattributes",
      existsSync(path.join(ROOT, ".gitattributes"))
      && /^examples\/\*\*\s+text=auto\s+eol=lf\s*$/m.test(read(".gitattributes")),
      "add `examples/** text=auto eol=lf` — otherwise autocrlf rewrites the text files "
      + "on clone and every hash below fails on a clean tree");

    ok("every example file is present", missing === 0, `${missing} missing`);
    ok("every example file matches its recorded size and hash", wrong === 0, `${wrong} differ`);
    ok("examples/ is inside its size budget", total <= mf.budgetBytes,
      `${(total / 1e6).toFixed(1)} MB over a ${(mf.budgetBytes / 1e6).toFixed(0)} MB budget`,
      `${(total / 1e6).toFixed(1)} MB of ${(mf.budgetBytes / 1e6).toFixed(0)} MB`);

    /* THE LICENCE CONDITION THAT REACHES THIS DIRECTORY. MiniMax-Music3 §3.1
     * asks for the name shown prominently by a commercial product using it.
     * These are that model's outputs, published here — so the name is stated
     * where a person looking at them will see it, the same way the app states
     * it. Checked against the catalogue's own condition text, so it cannot
     * drift from what the Models screen says. */
    const engine = CATALOG.find((c) => c.required);
    const clause = engine.outputRights.conditions.find((c) => c.startsWith("§3.1"));
    ok("the catalogue still carries the §3.1 attribution condition", !!clause);
    const exReadme = read("examples/README.md");
    ok("examples/README.md shows the model name prominently",
      exReadme.slice(0, 2000).includes("MiniMax-Music3"),
      "§3.1 asks for the name in the interface, not on a credits page");
    if (clause) {
      ok("examples/README.md carries the condition verbatim",
        exReadme.includes(clause.replace(/^§3\.1 — /, "")));
    }
    const audio = mf.examples.filter((e) => e.output.some((f) => f.endsWith(".mp3")));
    ok("every audio example names its model and licence in the manifest",
      audio.length > 0 && audio.every((e) => e.attribution?.model && e.attribution?.licence),
      "an audio example with no attribution", `${audio.length} audio examples`);
    for (const e of audio) {
      const cap = CATALOG.find((c) => c.label.endsWith(e.attribution.model));
      ok(`${e.dir}'s attribution is a real catalogue entry`, !!cap,
        `no catalogue label ends with "${e.attribution.model}"`, e.attribution.model);
      if (cap) ok(`${e.dir}'s licence line matches the catalogue`, cap.licence === e.attribution.licence);
    }
    /* ⚠ EVERY EXAMPLE REQUEST HAS TO BE ONE THE TOOL WOULD ACCEPT.
     *
     * This is the check the directory exists for. An example is copied — that is
     * its whole purpose — so a request.json carrying a field the tool does not
     * have is not a documentation slip, it is a refusal in somebody's terminal
     * with this repository's name on it. Every MCP schema here is
     * `additionalProperties: false`, so one extra key fails the whole call. The
     * first draft of 03-video-clip carried `frames`, `fps` and `seeds`, read
     * honestly out of the executed graph and not accepted by make_clip.
     *
     * Keys beginning with `_` are notes for the reader and are skipped. */
    for (const ex of mf.examples) {
      const reqFile = ex.files.find((f) => f.name === "request.json");
      if (!reqFile) continue;
      const req = JSON.parse(readFileSync(path.join(ROOT, "examples", ex.dir, "request.json"), "utf8"));
      const toolName = req._tool;
      if (toolName === null) {
        /* A stated absence is checked too, or "there is no tool for this" quietly
         * becomes false the day somebody adds one and nobody updates the note. */
        ok(`${ex.dir} is right that no MCP tool covers it`,
          !TOOLS.some((t) => t.name === "make_audio_reference"),
          "a tool for this now exists — the example still says there is none");
        continue;
      }
      const tool = TOOLS.find((t) => t.name === toolName);
      ok(`${ex.dir} names a live tool (${toolName})`, !!tool, `no tool called ${toolName}`);
      if (!tool) continue;
      const props = new Set(Object.keys(tool.inputSchema.properties || {}));
      const extra = Object.keys(req).filter((k) => !k.startsWith("_") && !props.has(k));
      ok(`${ex.dir}'s request is one ${toolName} would accept`, extra.length === 0,
        `${toolName} has no ${extra.join(", ")} — and its schema is additionalProperties:false, `
        + "so copying this example would be refused outright");
      for (const r of tool.inputSchema.required || []) {
        ok(`${ex.dir} supplies ${toolName}'s required \`${r}\``, r in req);
      }
    }

    /* "input not recorded" is a permitted answer and an INVENTED one is not, so
     * the phrase has to survive. If a future rebuild silently fills those in
     * from somewhere, this is the check that notices. */
    let notRecorded = (JSON.stringify(mf).match(/input not recorded/g) || []).length;
    for (const ex of mf.examples) {
      for (const f of ex.files.filter((x) => /\.(json|txt)$/.test(x.name))) {
        const p = path.join(ROOT, "examples", ex.dir, f.name);
        if (existsSync(p)) notRecorded += (readFileSync(p, "utf8").match(/input not recorded/g) || []).length;
      }
    }
    ok("unrecoverable inputs are still admitted rather than invented", notRecorded > 0,
      "nothing says \"input not recorded\" any more. Either every input really was "
      + "recovered — in which case say so here — or a rebuild has started filling the "
      + "gaps in, and that is the one failure this whole directory exists to be safe from.",
      `${notRecorded} occurrences`);
  }
  ok("README links the examples", read("README.md").includes("(examples/"));

  /* A guard used to live here that read a script this repository no longer
   * carries, and crashed the whole suite on its absence. The examples/
   * prompt-text check it performed went with it. */
}

/* ═══ the docs point at files that exist ═════════════════════════════════ */
console.log("\n  every relative link resolves");
{
  let broken = 0;
  for (const doc of [...TARGETS, "examples/README.md"]) {
    const base = path.dirname(path.join(ROOT, doc));
    for (const [, target] of read(doc).matchAll(/\]\((?!https?:|#|mailto:)([^)#]+)/g)) {
      const p = path.join(base, decodeURI(target));
      if (!existsSync(p)) { broken++; console.log(`        ${doc} → ${target}`); }
      else if (target.endsWith("/") && !statSync(p).isDirectory()) { broken++; }
    }
  }
  ok("no relative link in the docs is dead", broken === 0,
    `${broken} broken — each is listed above`, `${broken} broken`);
}

{
  const guide = read("docs/YUE2_GGUF.md");
  const capability = CATALOG.find((c) => c.id === "musicYue2Gguf");
  for (const precision of ["q4_0", "q8_0"]) {
    const files = ggufFilesFor(precision), bytes = files.reduce((n, f) => n + f.declaredBytes, 0);
    const entry = capability.variants.find((v) => v.label.startsWith(precision.toUpperCase()));
    ok(`${precision} catalogue bytes match pinned download manifest`, entry?.bytes === bytes);
    ok(`${precision} guide gives exact bundle bytes`, guide.includes(bytes.toLocaleString("en-US")));
  }
  const make = TOOLS.find((t) => t.name === "make_song");
  const setup = TOOLS.find((t) => t.name === "yue2_gguf_setup");
  ok("both public MCP doors declare optional Q8", [make, setup].every((t) => t.inputSchema.properties.precision.enum.includes("q8_0")));
  ok("public install docs distinguish optional Q8 from the default", [...TARGETS, HTML_TARGET].every((p) => /Q8/.test(read(p))));
}

{
  const readme = read("README.md"), pkg = JSON.parse(read("package.json"));
  const quick = readme.indexOf("## YuE2 music-only quickstart");
  ok("music-only quickstart precedes the full-suite overview", quick > 0 && quick < readme.indexOf("## Why this rather than a cloud tool"));
  ok("README explains music-only is not a separate repository", readme.includes("not a separate GitHub repository"));
  /* Both modes are one launcher now (AIPLAY Studio.exe / .cmd → launcher.mjs);
   * the two Start*.cmd files they replaced are gone, so the claim to pin is
   * that the README still names both modes and that the launcher still reaches
   * the dedicated music-only entry point rather than the full server. */
  ok("README names both launch modes", readme.includes("Music only") && readme.includes("Full Studio"));
  ok("README names the launcher people double-click", readme.includes("AIPLAY Studio.exe") || readme.includes("AIPLAY Studio.cmd"));
  ok("documented music-only command reaches the dedicated entry point", pkg.scripts["start:music"] === "node scripts/start-music.mjs"
    && read("scripts/start-music.mjs").includes("process.env.AIPLAY_MUSIC_ONLY='1'"));
  ok("the launcher's music mode calls the same entry point", read("launcher/launcher.mjs").includes("start-music.mjs"));
  ok("...and its full mode calls the server directly", read("launcher/launcher.mjs").includes(`path.join("server", "index.js")`));
  const zip = `${pkg.repository.url.replace(/\.git$/, "")}/archive/refs/heads/main.zip`;
  ok("each native quickstart offers the same public ZIP", ["README.md", "INSTALL.md", "docs/YUE2_GGUF.md", HTML_TARGET].every((p) => read(p).includes(zip)));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
