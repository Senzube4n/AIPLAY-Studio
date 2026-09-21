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
