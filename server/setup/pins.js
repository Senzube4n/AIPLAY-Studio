/**
 * WHAT STUDIO'S OWN INSTALLERS FETCH, BY EXACT VERSION.
 *
 * One place for the two things a fresh machine downloads before any model:
 * ComfyUI (scripts/install-engine.mjs) and uv, the program that fetches a
 * Python and builds its environments (the engine, and server/setup/venv.js).
 * scripts/setup.mjs reads COMFY_TAG to say when a Studio-owned engine is not
 * the version this Studio was tested with.
 *
 * Plain constants and path helpers only, Node built-ins only: the launcher and
 * the engine installer run this before Studio's server exists.
 *
 * WHY PINNED. The engine installer used to fetch ComfyUI's `releases/latest`.
 * On 2026-09-24 that was v0.37.0 while every measurement here (the H3 lab,
 * the YuE2 nodes, the 1034-node census) was taken on v0.36.0, so a new
 * install would have been the first machine to run a version nobody here had
 * started. A new upstream release now changes nothing until this line does.
 *
 * WHAT IS NOT SHIPPED. The rig runs v0.36.0 plus four app patches (MiniMax
 * codes capture and resume). A fresh engine has none of them, so a MiniMax
 * take made there keeps no saved performance: the extend door sends it down
 * the "any other recording" path, which continues it through the YuE2
 * real-audio tokenizer, or refuses in one sentence naming that download
 * (server/index.js, `if (meta && !meta.codes)`). Every other feature runs on
 * the clean tag.
 */
import os from "node:os";
import path from "node:path";

/** The ComfyUI release a fresh engine gets. Tag ee71d5c, 2026-09-15. */
export const COMFY_TAG = "v0.36.0";
/** Comfy-Org is the repository's current home; comfyanonymous/ComfyUI redirects to it. */
export const COMFY_REPO = "Comfy-Org/ComfyUI";
export const comfyArchiveUrl = (tag = COMFY_TAG) =>
  `https://github.com/${COMFY_REPO}/archive/refs/tags/${tag}.tar.gz`;

/**
 * scripts/setup.mjs's warning for a Studio-owned engine on another ComfyUI:
 * one installed before the pin, when the installer took the latest release
 * (its marker records that tag, or null for the main branch). Null for an
 * engine on the pin, and for any ComfyUI Studio did not install, which is the
 * person's own and never judged here. `marker` is the .aiplay-engine.json.
 */
export function comfyPinNote(marker, tag = COMFY_TAG) {
  if (!marker || marker.complete !== true) return null;
  const have = marker.comfy || "the main branch";
  if (have === tag) return null;
  return `Studio's own ComfyUI is ${have}, but this version of Studio is tested with ${tag}. `
    + "It may well work; if the engine misbehaves, that difference is the first thing to suspect.";
}

/**
 * uv, pinned, and the SHA-256 its release publishes beside each archive
 * (`<asset>.sha256`). Read 2026-09-24 from the GitHub release API's asset
 * digests and cross-checked against the published .sha256 files for the two
 * x86_64 archives. A download that does not hash to this is deleted, never run.
 */
export const UV_VERSION = "0.12.17";
export const UV_SHA256 = {
  "uv-x86_64-pc-windows-msvc.zip": "a252121d5b59398fcb137c6ea448176459a44010f33f67e0072305a637119ca7",
  "uv-aarch64-pc-windows-msvc.zip": "3e1aa6849d77f0e00dc865e4afab5c5b32de053e21fe35bf5ad5cec3734ec976",
  "uv-x86_64-apple-darwin.tar.gz": "8dcf05a8c809bb3c471d2b614788ba27a6e41298fc8c31ac84b5f4339fd468e5",
  "uv-aarch64-apple-darwin.tar.gz": "85f00cbdc6dd3e97eba4c31b4d014375a9fdfe8f570023b84e5102fc3456896b",
  "uv-x86_64-unknown-linux-gnu.tar.gz": "fa82fd8dde8e8eefdecada6aa0889666556cfceb690d06e0c3bca49eb3070a63",
  "uv-aarch64-unknown-linux-gnu.tar.gz": "d636d1b678e9e7f367ecb22b46bd1cabbed234d6bc3b4d96365d2b507f72f86c",
};

/** The uv archive for this machine. */
export function uvAsset(platform = process.platform, arch = process.arch) {
  const a = arch === "arm64" ? "aarch64" : "x86_64";
  if (platform === "win32") return `uv-${a}-pc-windows-msvc.zip`;
  if (platform === "darwin") return `uv-${a}-apple-darwin.tar.gz`;
  return `uv-${a}-unknown-linux-gnu.tar.gz`;
}

/** Everything ensureUv needs to fetch and check one archive. */
export function uvPin(platform = process.platform, arch = process.arch) {
  const asset = uvAsset(platform, arch);
  return {
    version: UV_VERSION, asset, sha256: UV_SHA256[asset] || null,
    url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`,
  };
}

/**
 * `uv python install` does two things outside the folder it is pointed at, by
 * default since uv 0.8 (read in uv 0.12.17's own CLI source): it puts a
 * python3.12.exe in ~/.local/bin, and on Windows it registers the interpreter
 * in the registry (PEP 514), where `py` lists it. Studio's Pythons stay in
 * Studio's folders, so a failed build that deletes its folder leaves nothing
 * pointing at a deleted interpreter. Every `python install` Studio runs takes
 * these flags, and every uv command it runs takes this environment (which
 * covers a Python uv would fetch on its own, e.g. inside `uv venv`).
 */
export const UV_PYTHON_INSTALL_ARGS = ["--no-bin", "--no-registry"];
export const UV_PRIVATE_ENV = { UV_PYTHON_INSTALL_BIN: "0", UV_PYTHON_INSTALL_REGISTRY: "0", UV_NO_CONFIG: "1" };

/** Studio's data folder: AIPLAY_APPDATA (tests, isolated rehearsals) or ~/.aiplay-studio. */
export const appDataDir = (env = process.env) =>
  env.AIPLAY_APPDATA || path.join(os.homedir(), ".aiplay-studio");

/** Where the kept uv lives: <app data>\tools\uv\uv.exe. Outside every engine
 *  and cache folder, so neither a failed install nor a cleaned cache removes it. */
export const keptUvDir = (appData) => path.join(appData, "tools", "uv");
export const keptUvPath = (appData, platform = process.platform) =>
  path.join(keptUvDir(appData), platform === "win32" ? "uv.exe" : "uv");
