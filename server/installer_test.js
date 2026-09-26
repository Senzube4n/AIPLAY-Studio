/**
 * THE ONE-TIME INSTALLER, AND WHAT IT RELIES ON IN THIS REPOSITORY.
 *
 * installer/Setup.cs is built rarely and never for an app change, so the
 * repository has to keep the promises it reads: install.json names folders that
 * exist, and both launchers find the private Node.js it may put in .\node.
 * No network, no build: these read files.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileLineage } from "../scripts/stamp-lineage.mjs";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const root = (rel) => new URL(`../${rel}`, import.meta.url);

test("install.json names only things that exist, and everything the app needs to start", () => {
  const m = JSON.parse(src("../install.json"));
  for (const entry of m.include) assert.ok(existsSync(root(entry)), `install.json lists "${entry}", which is not in the repository`);
  for (const need of ["server", "web", "launcher", "package.json", "package-lock.json", "AIPLAY Studio.exe"])
    assert.ok(m.include.includes(need), `an install without "${need}" cannot start`);
  assert.ok(m.exclude.includes("*.md"), "notes and docs stay in the repository");
  assert.ok(m.keep.some((k) => /^LICENSE/.test(k)), "a vendored library's LICENSE.md still ships");
});

test("both launchers look in .\\node before the system's Node.js", () => {
  const cs = src("../launcher/exe/AiplayLauncher.cs");
  assert.match(cs, /string privateNode = Path\.Combine\(root, "node"\);/);
  assert.ok(cs.indexOf("privateNode") < cs.indexOf('FindOnPath("node.exe", path)'), "checked before the PATH search");
  const cmd = src("../AIPLAY Studio.cmd");
  assert.ok(cmd.indexOf('if exist "%~dp0node\\node.exe"') < cmd.indexOf("where node"), "the .cmd too, before `where node`");
  /* The installer detects an older launcher by this very word. */
  assert.match(src("../installer/Setup.cs"), /Contains\("privateNode"\)/);
});

test("the installer: the original first, a stamped build, checked Node.js, nothing half-installed", () => {
  const s = src("../installer/Setup.cs");
  assert.match(s, /new Source\("senzu", "Senzu", "S", "Senzube4n\/AIPLAY-Studio"\),\n\s+new Source\("bucky"/, "Senzu's build is first and the default");
  assert.match(s, /public string Dir, Repo = "senzu"/);
  assert.match(s, /codeload\.github\.com\/" \+ src\.Repo \+ "\/zip\/" \+ src\.Sha/, "downloads the exact commit it showed");
  assert.match(s, /server\\version\.gen\.json/, "a zip has no .git; the build line must still name its commit");
  assert.match(s, /SHASUMS256\.txt/, "Node.js is checked against nodejs.org's own list");
  assert.match(s, /Directory\.Move\(stage, dir\)/, "one move into place");
  assert.match(s, /That folder is a git clone/, "never replaces a developer's clone");
  assert.doesNotMatch(s, /pip install|winget|msiexec|runas/i, "no machine-wide installs, no admin prompt, nothing for the engine");
  assert.match(src("../.gitignore"), /^\/node\/$/m, "a private Node.js in a clone is never committed");
});

test("the release rules ship in a tracked file, since CLAUDE.md is git-ignored here", () => {
  const r = src("../RELEASING.md");
  assert.match(r, /node scripts\/build-installer\.mjs/);
  assert.match(r, /gh release create setup-v/);
  assert.match(r, /node scripts\/stamp-lineage\.mjs/, "the merge rule reaches every clone");
  const v = /SetupVersion = "([\d.]+)"/.exec(src("../installer/Setup.cs"))[1];
  const cs = src("../installer/Setup.cs");
  assert.ok(cs.includes(`AssemblyVersion("${v}.0.0")`) && cs.includes(`AssemblyFileVersion("${v}.0.0")`), "SetupVersion and the file version agree");
  /* The block a merge from the original removes comes back on the fork. */
  assert.match(src("../scripts/stamp-lineage.mjs"), /const FORKS = \[/);
});

/* ── S1 / H1: the first thing a newcomer clicks is the installer ─────────────
 * The asset URL was read from the live release on 2026-09-24 (`gh api
 * repos/Senzube4n/AIPLAY-Studio/releases/latest`: tag setup-v1.2, asset
 * AIPLAY.Studio.Setup.exe, 327,168 bytes) and follows it with a 302. */
const SETUP_URL = "https://github.com/Senzube4n/AIPLAY-Studio/releases/latest/download/AIPLAY.Studio.Setup.exe";
const ZIP_URL = "https://github.com/Senzube4n/AIPLAY-Studio/archive/refs/heads/main.zip";

test("the README's first Download button is Setup.exe, and the zip is Source code for developers", () => {
  const readme = src("../README.md");
  const first = /<a href="([^"]+)"><b>Download[^<]*<\/b><\/a>/.exec(readme);
  assert.ok(first, "the README has a Download button");
  assert.equal(first[1], SETUP_URL, "the first Download href targets the releases asset");
  assert.doesNotMatch(first[1], /archive\//, "not the source zip, which needs Node.js installed by hand");
  assert.ok(readme.indexOf(first[0]) < readme.indexOf(ZIP_URL), "the zip comes after the button");
  assert.ok(readme.includes(`<a href="${ZIP_URL}">Source code (for developers)</a>`), "the zip is labelled for developers");
  assert.ok(readme.includes("Windows may say “Windows protected your PC” because the installer is not signed yet: "
    + "click <b>More info</b>, then <b>Run anyway</b>."), "one plain line about SmartScreen, under the button");
  const quick = readme.slice(readme.indexOf("## YuE2 music-only quickstart"));
  assert.ok(quick.indexOf(SETUP_URL) > 0 && quick.indexOf(SETUP_URL) < quick.indexOf(ZIP_URL), "the quickstart's step 1 is Setup.exe too");
  /* The name GitHub serves: RELEASING.md's upload keeps the file name, and says why. */
  assert.match(src("../RELEASING.md"), /releases\/latest\/download\/AIPLAY\.Studio\.Setup\.exe/);
  assert.match(src("../scripts/build-installer.mjs"), /"AIPLAY Studio Setup\.exe"/);
});

test("INSTALL.md puts Setup.exe first, and its disk sizes come from the catalogue", async () => {
  const install = src("../INSTALL.md");
  const firstLink = /\]\((https:\/\/github\.com\/[^)]+)\)/.exec(install.slice(install.indexOf("## Start with YuE2 music only")));
  assert.equal(firstLink?.[1], SETUP_URL, "the first download link in the guide is the installer");
  assert.ok(install.includes(ZIP_URL), "the source zip is still offered, for developers");
  const { diskSentence, diskTotals } = await import("../scripts/disk_totals.mjs");
  const t = diskTotals();
  assert.ok(Math.round(t.musicVideos) >= 60, `H3 and its reference build are about ${t.musicVideos.toFixed(1)} GB`);
  assert.ok(install.includes(`| **Free disk space.** ${diskSentence(t)} |`),
    "INSTALL.md's disk row is the catalogue's numbers; run: node scripts/disk_totals.mjs --write");
  assert.doesNotMatch(install, /About 62 GB/);
  /* The row reads the same on every machine: an AMD machine's `files` swap in
   * larger int8 builds, so the totals count the published `defaultFiles`. */
  const amdRow = { id: "video", files: [{ name: "te_int8.safetensors", bytes: 30e9 }] };
  Object.defineProperty(amdRow, "defaultFiles", { value: [{ name: "te_fp4.safetensors", bytes: 20e9 }], enumerable: false });
  assert.equal(Math.round(diskTotals([amdRow]).musicVideos), 20, "the totals count defaultFiles, not this machine's files");
  assert.match(install, /install \*\*Studio\*\* \(Setup\.exe brings\s+Node\.js 20\+ when this PC has none\)/, "Node.js comes with Setup.exe");
  /* The timed-lyrics size INSTALL.md quotes is the recipe's, and says it is an estimate. */
  const { lyricsRecipe } = await import("./setup/venv.js");
  const gb = lyricsRecipe({ vendor: "nvidia" }).sizes.downloadGb;
  assert.ok(install.includes(`roughly ${gb} GB on NVIDIA, an\n  estimate`), `INSTALL.md quotes the recipe's ${gb} GB as an estimate`);
  /* The landing page's install section starts with Setup.exe too. */
  const page = src("../docs/index.html");
  const at = page.indexOf('<section id="install">');
  assert.ok(at > 0 && page.indexOf(SETUP_URL, at) > at && page.indexOf(SETUP_URL, at) < page.indexOf(ZIP_URL, at), "landing page: Setup.exe before the zip");
  assert.match(page, /download and extract the source ZIP<\/a>\s+\(for developers/);
});

/* ── S6 and the launcher: it says what it does, and no more ─────────────── */
test("the launcher's setup card and ffmpeg row say what they check and install", async () => {
  const html = src("../launcher/index.html");
  assert.match(html, /installs the engine \(ComfyUI and PyTorch\); models come next/, "the setup card");
  assert.doesNotMatch(html, /installs everything it needs/, "no promise of more than the engine");
  const launcher = src("../launcher/launcher.mjs");
  assert.match(launcher, /ffmpegItem\(\{ ffmpeg, ffprobe \}\)/, "the row checks both programs");
  assert.match(launcher, /findTool\(ffmpegPath\(\)\), findTool\(ffprobePath\(\)\)/, "found the way Studio finds them");
  const { ffmpegItem } = await import("../launcher/checks.mjs");
  assert.equal(ffmpegItem({ ffmpeg: "C:\\ff\\ffmpeg.exe", ffprobe: "C:\\ff\\ffprobe.exe" }).detail, "ffmpeg: video export, clip joins, Reactive");
  assert.equal(ffmpegItem({ ffmpeg: "x", ffprobe: "y" }).status, "ok");
  assert.equal(ffmpegItem({ ffmpeg: "x" }).status, "warn", "ffmpeg without ffprobe is half there");
  assert.equal(ffmpegItem({}).status, "off");
  assert.match(ffmpegItem({}).detail, /^ffmpeg: video export, clip joins, Reactive\. Studio does not install it/);
  assert.match(launcher, /of: 10,/, "the progress bar counts the installer's ten steps");
});

test("a failed engine install says what S4 now does: the half-built engine goes, the download stays", () => {
  const html = src("../launcher/index.html");
  assert.match(html, /s === "failed" \? "The half-built engine was removed; what it downloaded is kept, so the next try is quicker\. The exact error:"/);
  assert.doesNotMatch(html, /Everything it downloaded was removed/, "the old promise is gone");
  assert.doesNotMatch(src("../launcher/launcher.mjs"), /The script cleans up after itself/);
  const deep = src("../docs/DEEP_DIVE.md");
  assert.doesNotMatch(deep, /the latest ComfyUI release/);
  assert.doesNotMatch(deep, /the partial install and its download cache are deleted/);
  assert.match(deep, /ComfyUI \*\*v0\.36\.0\*\*/);
  assert.match(deep, /half-built engine folder is deleted and its download\s+cache is kept/);
});

test("the launcher's RAM line warns under 32 GB, in the owner's words, with the catalogue's number", async () => {
  const { ramItem, h3Needs, RAM_RESERVED_GB } = await import("../launcher/checks.mjs");
  const { CATALOG } = await import("./models.js");
  const h3 = CATALOG.find((c) => c.id === "video").requires;
  assert.deepEqual(h3Needs(), { vramGb: h3.vramMinGb, ramGb: h3.ramRecGb },
    "the VRAM floor is the H3 row's minimum, the Models screen's own; the RAM line quotes the RAM the row says H3 was measured with");
  assert.equal(h3Needs().ramGb, 32);
  assert.ok(h3.ramMinGb < 32, "the row's RAM minimum is lower than what H3 was measured with, and the owner's sentence names the measured figure");
  assert.equal(h3Needs([{ id: "video", requires: { vramMinGb: 8, ramMinGb: 24 } }]).ramGb, 24, "with no recommended figure, the minimum stands in");
  const GiB = 1024 ** 3;
  const owner = ramItem(31.9 * GiB);   // a "32 GB" PC, as os.totalmem() reads it
  assert.equal(owner.status, "ok");
  assert.equal(owner.value, "31.9 GB");
  /* A 32 GB laptop or APU whose integrated graphics keeps some memory reads under 32. */
  for (const usable of [31.4, 30.5, 29.9, 28.2]) assert.equal(ramItem(usable * GiB).status, "ok", `${usable} GB usable is a 32 GB machine`);
  assert.equal(RAM_RESERVED_GB, 4);
  /* ONE READER (release critic): the launcher's allowance is h3tier.js's, so
   * Home, Models, Video and the music video judge the same machine the same way. */
  const h3tier = await import("./h3tier.js");
  assert.equal(RAM_RESERVED_GB, h3tier.RAM_RESERVED_GB, "the launcher re-exports h3tier's allowance, not a copy");
  for (const usable of [31.4, 28.2, 27.9, 15.4, 11.9]) {
    assert.equal(ramItem(usable * GiB).status === "ok", h3tier.ramBoxGb(usable * 1024) >= 32, `${usable} GB is judged as h3tier judges it`);
  }
  assert.match(ramItem(11.9 * GiB).detail, /under 16 GB they are not offered/, "under H3's floor the launcher says it is not offered");
  assert.equal(ramItem(27.9 * GiB).status, "warn");
  assert.equal(ramItem(23.9 * GiB).status, "warn", "a 24 GB machine");
  const small = ramItem(15.9 * GiB);
  assert.equal(small.status, "warn");
  assert.equal(small.detail, "Music videos (H3) were measured with 32 GB of RAM; with less, expect slow renders");
  assert.match(src("../launcher/launcher.mjs"), /ramItem\(totalmem\(\)\)/, "the row is in the system check");
  const checks = src("../launcher/checks.mjs");
  assert.match(checks, /import \{ CATALOG \} from "\.\.\/server\/models\.js";/);
  assert.doesNotMatch(checks, /STRONG_CARD_GB|H3_MEASURED_RAM_GB/, "no hand-kept copy of the thresholds");
  assert.doesNotMatch(checks, /export const RAM_RESERVED_GB = /, "no hand-kept copy of the RAM allowance either");
});

test("a weak or missing card is pointed at a friend first and paid Comfy API second; every mode stays", async () => {
  const { cardAdvice, musicOnlyNote, h3Needs } = await import("../launcher/checks.mjs");
  const floor = h3Needs().vramGb;
  const { H3_VRAM_MIN_GB } = await import("./h3tier.js");
  assert.equal(floor, H3_VRAM_MIN_GB, "the catalogue's H3 floor, the smallest card a measured tier covers");
  assert.equal(floor, 8);
  assert.equal(cardAdvice({ gpu: { name: "RTX 4070 Ti SUPER", totalMb: 16376, vendor: "nvidia" } }), null, "a 16 GB card needs no advice (the owner's)");
  assert.equal(cardAdvice({ gpu: { name: "RTX 3060", totalMb: 12288, vendor: "nvidia" } }), null, "12 GB gets full size on the Models screen");
  assert.equal(cardAdvice({ gpu: { name: "RTX 3060 Ti", totalMb: 8192, vendor: "nvidia" } }), null, "8 GB gets the smaller size on the Models screen");
  const raised = cardAdvice({ gpu: { name: "RTX 3060", totalMb: 12288, vendor: "nvidia" }, need: { vramGb: 16, ramGb: 32 } });
  assert.equal(raised?.why, "This RTX 3060 has 12 GB of memory; music videos (MiniMax H3) need a card with at least 16 GB, as the Models screen says.",
    "when the catalogue raises the floor, the launcher follows, with the catalogue's number (not the preview's floor)");
  /* THE SAME ANSWER AS THE VIDEO SCREEN (release critic): h3tier.js offers a
   * 6 or 7 GB card the experimental 832x480 preview, so the launcher says
   * that, not "needs 8 GB". Under 6 GB it is not offered at all. */
  const six = cardAdvice({ gpu: { name: "RTX 2060", totalMb: 6144, vendor: "nvidia" } });
  assert.match(six?.why || "", /has 6 GB of memory: music videos \(MiniMax H3\) are offered on it only as an experimental 832x480 preview, not yet seen to fit; the measured sizes need an 8 GB card or more/,
    "6 GB gets the preview tier's own words, as Home and the Video screen say");
  assert.doesNotMatch(six.why, /a 8 GB/);
  const four = cardAdvice({ gpu: { name: "GTX 1650", totalMb: 4096, vendor: "nvidia" } });
  assert.match(four?.why || "", /has 4 GB of memory, under the 6 GB music videos \(MiniMax H3\) need even for an experimental preview/);
  assert.match(six.friend, /^Collab, in Full Studio, packs a scene into a sealed file/);
  assert.match(six.friend, /send the clip back \(built, not yet tried between two PCs\)\. No account, no server, no cost\./, "lending is said to be untried, as every surface says");
  assert.match(six.cloud, /your own Comfy API key, paid per run/);
  for (const none of [{ gpu: null }, { gpu: { vendor: "cpu", name: "CPU only", totalMb: 0 } }]) {
    assert.match(cardAdvice(none)?.why || "", /No graphics card that Studio can render on/);
  }
  assert.equal(cardAdvice({ gpu: { name: "Radeon", vendor: "amd" } }), null, "a card whose memory was not read: cannot tell is not weak");
  assert.equal(cardAdvice({ gpu: { name: "RTX 4090", totalMb: 24564, vendor: "nvidia" }, torchOnCard: false }), null,
    "a strong card with a CPU PyTorch is the PyTorch row's to say, not a reason to ask a friend");
  assert.equal(cardAdvice({ gpu: null, torchOnCard: true }), null, "no card read, but ComfyUI runs on one: nothing claimed");
  assert.doesNotMatch(cardAdvice({ gpu: null }).friend, /CPU only/, "with an engine, no install step");
  assert.match(cardAdvice({ gpu: null, fullAvailable: false }).friend,
    /Full Studio needs an engine first, even to lend and borrow: choose CPU only under "What should Studio run on\?" \(it only has to open Studio, not render\), then launch Full Studio and open Collab\./,
    "with no engine, the friend's way starts by installing one");
  assert.match(cardAdvice({ gpu: null, fullAvailable: false, needsEngine: false }).friend,
    /Full Studio needs its ComfyUI chosen first: press Change… beside "ComfyUI install" above/,
    "with installs found but none chosen, the step is choosing one");
  const html = src("../launcher/index.html");
  const at = (id) => html.indexOf(`id="${id}"`);
  assert.ok(at("friendCard") > 0 && at("friendCard") < at("mode-cloud"), "the friend comes before the paid mode");
  assert.match(html, /<li><b>Ask a friend with a strong card to render for you\.<\/b>[\s\S]*?<li><b>Or use Comfy API<\/b> \(your own key, paid\)/);
  for (const mode of ["full", "music", "cloud"]) assert.ok(at(`mode-${mode}`) > 0, `the ${mode} mode is kept`);
  assert.match(html, /Use Comfy API <span class="tagcredit">your own key, paid<\/span>/);
  assert.match(src("../launcher/launcher.mjs"), /cardAdvice: cardAdvice\(\{ gpu, torchOnCard: !!torchBackend && torchBackend !== "cpu",\s+fullAvailable: comfyOk && nodeMajor >= 20, needsEngine: !comfyOk && !report\?\.hits\?\.length \}\)/);
  assert.match(musicOnlyNote(false), /Lending or borrowing a graphics card \(Collab\) needs Full Studio\./);
  assert.match(musicOnlyNote(true), /^Music screens only\. Starts ComfyUI for YuE2\./);
});

test("Studio's own packages have a row, and Try again runs the installer's --studio-packages from the launcher", async () => {
  const { studioPackagesItem } = await import("../launcher/checks.mjs");
  assert.equal(studioPackagesItem(null), null, "a ComfyUI Studio did not install gets no row");
  const good = studioPackagesItem({ backend: "nvidia", studioPackages: { ok: true, missing: [] } });
  assert.equal(good.status, "ok");
  assert.equal(good.retry, undefined);
  const bad = studioPackagesItem({ backend: "nvidia", studioPackages: { ok: false, missing: ["librosa"] } });
  assert.equal(bad.status, "warn");
  assert.equal(bad.value, "missing: librosa");
  assert.equal(bad.retry, "studio-packages");
  assert.equal(bad.retryLabel, "Try again");
  const old = studioPackagesItem({ backend: "cpu" });
  assert.equal(old.retry, "studio-packages", "an engine from before the step can get them too");
  assert.equal(old.retryLabel, "Install");
  /* R4d: SciPy is one of them (librosa imports lazily, so it is checked by
   * name), every feature that needs them is named, and the size is the
   * measured one, not "not measured". */
  /* An "ok" vouches only for what the installer checked: a record from
   * before SciPy joined the list names the three and says SciPy was not
   * checked, while a record that lists what it checked names all four. */
  assert.equal(good.value, "OpenCV (cv2), librosa, soundfile");
  assert.match(good.detail, /SciPy: not checked yet \(added to the list after this engine was installed\); Studio checks it when a feature needs it\.$/);
  const checked = studioPackagesItem({ backend: "nvidia", studioPackages: { ok: true, missing: [], checked: ["cv2", "librosa", "soundfile", "scipy"] } });
  assert.equal(checked.value, "OpenCV (cv2), librosa, soundfile, SciPy");
  assert.doesNotMatch(checked.detail, /not checked/);
  assert.equal(checked.retry, undefined);
  assert.match(old.detail, /^Clip posters, the compositor, hum-to-score, the real-audio tokenizer and the DAW need them\. This engine was installed before Studio added them\. About 0\.3 GB on disk\.$/);
  assert.doesNotMatch(old.detail, /not been measured/);
  assert.match(src("../launcher/index.html"), /Install Studio's own packages \(OpenCV, librosa, soundfile and SciPy, only the ones that do not import\)/);
  /* The confirm no longer promises "Nothing is removed": the launcher's run
   * (Studio stopped) may put a broken package back at its own version. */
  assert.match(src("../launcher/index.html"), /One that is installed but does not import is put back at the version it already has\./);
  assert.doesNotMatch(src("../launcher/index.html"), /Nothing is removed/);
  assert.match(src("../launcher/launcher.mjs"), /import \{ STUDIO_MODULES, moduleWords \} from "\.\.\/server\/setup\/studio-packages\.js";/);
  assert.doesNotMatch(src("../launcher/launcher.mjs"), /["`][^"`\n]*OpenCV, librosa/, "the launcher's log lines take the names from the one list");
  assert.match(src("../launcher/launcher.mjs"), /addLog\(`Installing Studio's own packages \(\$\{moduleWords\(STUDIO_MODULES\)\}: only the ones that do not import\) into its engine\.`, "sys"\);/);
  const launcher = src("../launcher/launcher.mjs");
  assert.match(launcher, /studioPackagesItem\(engineInstall\),\n  \]\.filter\(Boolean\);/);
  assert.match(launcher, /if \(b\.retry === "studio-packages"\) \{ await startStudioPackages\(\); return send\(res, 200, pkgRetry\); \}/);
  assert.match(launcher, /runStudioPackages\(\{ rig: settings\.rig, appData: APPDATA, script: path\.join\(ROOT, "scripts", "install-engine\.mjs"\)/,
    "the launcher's own node runs it: no node on PATH is needed");
  assert.match(launcher, /if \(child \|\| studio\.state === "starting"\) throw new Error\("Stop Studio first: its engine is using that python\."\);/);
  const html = src("../launcher/index.html");
  assert.match(html, /data-retry="\$\{esc\(i\.retry\)\}"/);
  assert.match(html, /api\("\/api\/install", \{ retry: b\.dataset\.retry \}\)/);
  assert.match(html, /ev\.addEventListener\("pkgretry"/);
  assert.match(html, /\$\("setupOk"\)\.classList\.toggle\("warn", s === "done" && !!install\.warning\);/, "a partial install is not painted green");
  const { studioWarning } = await import("./setup/studio-packages.js");
  assert.match(studioWarning(["cv2"]), /press Try again beside "Studio's own packages" in the launcher's system check/,
    "the sentence sends a Setup.exe user to the button, not to a node command they cannot run");
});

test("canonical origin removes inherited Bucky identity, while a selected fork or ZIP keeps its source", () => {
  const fork = { aiplay: { other: true, lineage: { letter: "B", repo: "bani4kaskashka/AIPLAY-Studio-Bucky-Fork" } } };
  assert.match(reconcileLineage(fork, "https://github.com/Senzube4n/AIPLAY-Studio.git"), /Removed/);
  assert.deepEqual(fork.aiplay, { other: true });
  const chosen = {};
  assert.match(reconcileLineage(chosen, "git@github.com:bani4kaskashka/AIPLAY-Studio-Bucky-Fork.git"), /restored B/);
  assert.equal(chosen.aiplay.lineage.repo, "bani4kaskashka/AIPLAY-Studio-Bucky-Fork");
  const saved = structuredClone(chosen);
  reconcileLineage(chosen, "");
  assert.deepEqual(chosen, saved, "a ZIP has no origin; do not rewrite the fork chosen at install time");
  assert.equal(reconcileLineage({}, "https://example.test/Senzube4n/AIPLAY-Studio.git"), "", "match GitHub repository identity, not a substring");
});

test("the compiled installer refuses a Git worktree and restores the old app when preserving files fails", async (t) => {
  const fw = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319");
  const compiler = path.join(fw, "csc.exe");
  if (process.platform !== "win32" || !existsSync(compiler)) return t.skip("requires the Windows .NET Framework compiler");
  const base = await mkdtemp(path.join(tmpdir(), "aiplay-installer-fixture-"));
  try {
    const harness = path.join(base, "Fixture.cs"), exe = path.join(base, "Fixture.exe");
    await writeFile(harness, `using System; using System.IO; using System.Reflection;
static class Fixture {
  static int Main(string[] args) {
    string root = args[0], app = Path.Combine(root, "app"), stage = Path.Combine(root, "stage");
    Directory.CreateDirectory(Path.Combine(app, "launcher"));
    File.WriteAllText(Path.Combine(app, "launcher", "launcher.mjs"), "old app");
    File.WriteAllText(Path.Combine(app, ".git"), "gitdir: elsewhere");
    var installer = new Installer(new Source("senzu", "Senzu", "S", "Senzube4n/AIPLAY-Studio"), app, false, false, false);
    bool refused = false;
    try { installer.Run(); } catch (InstallException e) { refused = e.Message.Contains("git clone"); }
    if (!refused) throw new Exception("A worktree must be refused before any network or install work");
    File.Delete(Path.Combine(app, ".git"));
    Directory.CreateDirectory(Path.Combine(app, "workflows", "custom"));
    File.WriteAllText(Path.Combine(app, "workflows", "custom", "mine.json"), "my workflow");
    Directory.CreateDirectory(Path.Combine(stage, "workflows"));
    File.WriteAllText(Path.Combine(stage, "workflows", "custom"), "blocks copying the user's folder");
    bool failed = false;
    try { typeof(Installer).GetMethod("Swap", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(installer, new object[] { stage }); }
    catch (TargetInvocationException) { failed = true; }
    if (!failed || File.ReadAllText(Path.Combine(app, "launcher", "launcher.mjs")) != "old app"
      || File.ReadAllText(Path.Combine(app, "workflows", "custom", "mine.json")) != "my workflow")
      throw new Exception("A failed preservation copy must restore the whole old install");
    Console.WriteLine("worktree refused; failed preservation restored old install"); return 0;
  }
}`);
    execFileSync(compiler, ["/nologo", "/target:exe", "/main:Fixture", `/out:${exe}`,
      "/r:System.dll", "/r:System.Core.dll", "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll",
      ...["System.IO.Compression.dll", "System.IO.Compression.FileSystem.dll", "System.Web.Extensions.dll"].map(d => `/r:${path.join(fw, d)}`),
      fileURLToPath(root("installer/Setup.cs")), harness], { windowsHide: true, stdio: "pipe" });
    const output = execFileSync(exe, [base], { windowsHide: true, encoding: "utf8" });
    assert.match(output, /worktree refused; failed preservation restored old install/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
