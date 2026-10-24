# macOS installation

## Install from Finder

This is a **developer preview** for macOS 13.5 or newer. Choose the download
that matches **Apple menu → About This Mac**:

- **Apple silicon** (an Apple M-series chip):
  [Download ARM64](https://github.com/Senzube4n/AIPLAY-Studio/releases/download/macos-setup-v1.0/AIPLAY-Studio-macOS-arm64.dmg).
- **Intel**:
  [Download x64](https://github.com/Senzube4n/AIPLAY-Studio/releases/download/macos-setup-v1.0/AIPLAY-Studio-macOS-x64.dmg).

1. Open the `.dmg` and drag **AIPLAY Studio** into **Applications**.
2. Eject the disk image, then open the copied **AIPLAY Studio.app** in Finder.
3. A setup page opens in your browser, downloads Studio and opens its launcher.
   Node.js, npm, Git and Python do not need to be installed by hand for Studio
   itself. The first setup needs internet access to GitHub and the npm registry.
4. Choose your mode in the launcher. Local engines and models are separate
   installations; opening setup does not download a model.

**This preview has ad-hoc signing, not an Apple Developer ID signature, and is
not notarized.** Ad-hoc signing does not identify a trusted publisher. macOS may
refuse to open a downloaded copy. If it does, stop and report the exact message;
keep your security protections enabled. Native CI installation checks do not
prove that a quarantined internet download will pass Gatekeeper.
[Apple explains these checks here](https://support.apple.com/en-us/102445).

## What works on a Mac

The package supplies its own Node.js and npm for the Studio application,
launcher and DAW. The native acceptance workflow covers Apple silicon on
macOS 14/26 and Intel on macOS 15. The runtime's declared minimum is macOS 13.5;
that minimum is not a separate full Studio acceptance result.

Opening the running app again in Finder reopens its browser page through the
same native host instead of starting another setup or launcher. Native
acceptance checks two ordinary Finder reopen requests against that same child.

The installer does **not** certify every image, video or music engine on
macOS. Each engine, its dependencies, available memory and model licence still
matter. A compatible existing ComfyUI engine, remote engine or optional hosted
provider may be used through the corresponding Studio mode.

**Native YuE2 GGUF's automatic runtime installer remains Windows x64 only.**
Do not expect the Windows CUDA/Vulkan runtime downloads to run on a Mac.
The Mac package does not promise local YuE2, H3 or MOSS generation merely
because Studio and the DAW open successfully.

## Updates, repair and removal

Use **Update** in the launcher while Studio is stopped. The app installs from
the repository's `main`; it does not require a new `.dmg` for every app update.
A new `.dmg` updates the bootstrap and private runtime. Close Studio before
replacing the application bundle.

For a damaged application installation, close Studio and run this in Terminal:

```sh
"/Applications/AIPLAY Studio.app/Contents/MacOS/AIPLAY Studio" --repair
```

Adjust the first path if you copied the bundle elsewhere. Repair stages and
validates the current app before replacing it, preserving custom workflows
and the settings profile. A failed staged download or dependency check keeps
the previous app. One last-good app backup may remain for recovery.

Moving **AIPLAY Studio.app** to the Trash removes the bootstrap and private
Node runtime. It deliberately keeps your user files:

| Contents | Default location |
|---|---|
| Writable app, npm packages and repair backup | `~/Library/Application Support/AIPLAY Studio/` |
| First-launch setup log | `~/Library/Application Support/AIPLAY Studio/setup.log` |
| Settings, logs and Studio-owned engine | `~/.aiplay-studio/` |
| Models and rendered media | Your configured engine/model/output folders |

Review these folders before deleting anything else. `AIPLAY_APPDATA` changes
the settings/engine profile; it does not move the bootstrap's application
folder or an existing installation. The private Node runtime does not replace
system Node or another application's Python/engine.

## Download verification and troubleshooting

Download `SHA256SUMS.txt` from the same release and compare your `.dmg` with its
matching row using `shasum -a 256 path/to/download.dmg`. Checksums detect a
changed download; they are not an Apple signature or notarization result.

The build verifies the official Node.js archive against the SHA256 pins in
`installer/macos/runtime.json` before packaging it, and includes the original
licence notices. Setup resolves an immutable GitHub commit, stages the runtime
allowlist, runs `npm ci --omit=dev --ignore-scripts` with its private runtime
and checks startup imports before replacing the app.

If setup says another install is active, wait for it to finish. Do not remove
a live lock or an unfamiliar recovery folder. Preserve the error and setup
log at `~/Library/Application Support/AIPLAY Studio/setup.log` when asking for
help, and keep credentials and private project details out
of public reports.

Developers can select an exact source repository and commit:

```sh
"/Applications/AIPLAY Studio.app/Contents/MacOS/AIPLAY Studio" \
  --install-only --repo Senzube4n/AIPLAY-Studio --ref FULL_40_CHARACTER_COMMIT
```

This installs executable code from the named repository. Ordinary installs
should keep the official default.
