# Linux installation

## Install from the desktop

1. Download the package for your computer:
   **[Intel/AMD 64-bit](https://github.com/Senzube4n/AIPLAY-Studio/releases/download/linux-setup-v1.0/AIPLAY-Studio-Linux-amd64.deb)**
   or **[ARM64](https://github.com/Senzube4n/AIPLAY-Studio/releases/download/linux-setup-v1.0/AIPLAY-Studio-Linux-arm64.deb)**.
2. Open the `.deb` in your software installer and press **Install**. Your
   distribution may ask for your account password to install the package.
3. Open **AIPLAY Studio** from the application menu. A setup page opens in your
   browser, downloads Studio and opens its launcher. Node.js, npm, Git and
   Python do not need to be installed by hand.
4. In the launcher, install the local engine for your graphics card, or connect
   an existing engine. Models are separate downloads, selected in Studio.

The packages target Ubuntu 22.04/24.04 on Intel/AMD x64 and Ubuntu 24.04 on
ARM64. Compatible Debian-based systems may work but require their own testing.
The native acceptance workflow tests the actual package, application launch
and data preservation. It does not certify GPU drivers or generated media.

**Native YuE2 GGUF's automatic runtime installer remains Windows x64 only.**
On Linux, use a compatible ComfyUI music workflow or supply a compatible native
CLI yourself. A successful Studio install does not mean every model fits or
runs on every graphics card. The model's licence still applies.

## Updates, repair and removal

Use **Update** in the launcher while Studio is stopped. Studio installs from
the repository's `main`, and the updater keeps your settings, models and custom
workflows. Installing a newer `.deb` updates the bootstrap and private Node
runtime; application updates remain in the launcher.

For a damaged app, close Studio and run `aiplay-studio --repair` in a terminal.
Repair downloads the current app again and preserves custom workflows. A
failed staged download or dependency check leaves the installed app in place.
One last-good app backup may remain beside the app for recovery.

Remove the package through your software installer to remove the application
menu entry and its private runtime. This deliberately keeps your user files.
If you later want those deleted too, review the folders below first.

| Contents | Default location |
|---|---|
| Bootstrap and private Node | `/usr/lib/aiplay-studio/` |
| App, npm packages and repair backup | `~/.local/share/aiplay-studio/` |
| Settings, logs and Studio-owned engine | `~/.aiplay-studio/` |
| Models and rendered media | Your configured engine/model/output folders |

`XDG_DATA_HOME` changes the user app's base folder. `AIPLAY_APPDATA` changes the
settings/engine profile. Neither setting moves an existing folder automatically.
The launcher uses its private Node only for Studio; it does not replace system
Node, Python or another application's engine.

## Other distributions

The release also provides a `.tar.gz` bundle for each architecture. Extract it
to a permanent folder and run its `aiplay-studio` entry point. Your file manager
may require **Run as a program**. The bundle includes the same private runtime
and bootstrap; it does not install a system package or application-menu entry.
It needs a supported glibc-based Linux system, `tar`, CA certificates and
`xdg-open` with a working default browser. Alpine/musl is not supported by these
Node binaries.

If your software installer does not open `.deb` files, the equivalent Ubuntu
terminal command is:

```sh
sudo apt install ./AIPLAY-Studio-Linux-amd64.deb
```

Use the `arm64` filename on an ARM64 computer. Do not run Studio itself with
`sudo`: the app and engine belong to your normal user account.

## Download verification and troubleshooting

Download `SHA256SUMS.txt` from the same release and check the package before
opening it with `sha256sum --ignore-missing --check SHA256SUMS.txt`. Checksums detect a changed
download; they are not a code-signing certificate or an antivirus verdict.
The build verifies official Node archives against SHA256 values pinned in
`installer/linux/runtime.json` and includes their licence notices.

The first run needs internet access to GitHub and the npm registry. It resolves
an immutable commit before downloading, stages only the runtime allowlist, runs
`npm ci --omit=dev --ignore-scripts` and checks startup imports before swapping
the app. It never installs a model merely because setup was opened.

If setup reports another install is active, wait for that install to finish.
Do not delete a lock while an install is running. Preserve an unknown lock or
failed recovery folder when asking for help. Include the setup error and log;
keep tokens and private project details out of public reports.

Developer builds can select an explicit repository and immutable commit:

```sh
aiplay-studio --install-only --repo Senzube4n/AIPLAY-Studio --ref FULL_40_CHARACTER_COMMIT
```

This installs executable application code from that repository. Ordinary users
should keep the default official build.
