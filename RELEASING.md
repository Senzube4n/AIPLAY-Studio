# Releasing

**If you are an assistant working in this repository, this file is written for
you.** `CLAUDE.md` is git-ignored here on purpose, so the rules that must reach
every clone live in tracked files like this one. Follow them without being asked.

## What a release is

**Studio itself is never released.** Everybody installs or updates from `main`:
`AIPLAY Studio Setup.exe` downloads the newest commit of the chosen repository
straight from GitHub, and unpacks what `install.json` in that commit lists. An
app change needs a push and nothing else.

**Releases carry installers**, not frozen editions of Studio. The Windows
installer, Linux bootstrap and macOS bootstrap install application code from `main`. A GitHub
Release is where people download those installers.

The Windows rules below still apply only to `installer/Setup.cs`. Linux and
macOS have their own bootstrap versions and packaging lanes, described below.

## When to publish a new Windows installer

**Only when `installer/Setup.cs` changed.** When a commit you are making touches
that file, publishing the new installer is part of finishing the work:

1. **Bump its version** in `installer/Setup.cs`, in three places that must agree:
   `SetupVersion` and both `AssemblyVersion` / `AssemblyFileVersion`
   (`1.2` ↔ `1.2.0.0`).
2. **Build:**

   ```bash
   node scripts/build-installer.mjs
   ```

   This writes `dist/AIPLAY Studio Setup.exe`. `dist/` is git-ignored, so the exe
   is never committed; the release carries it.
3. **Sign, if this machine has the certificate.** Either set `AIPLAY_SIGN_SHA1`
   (certificate thumbprint) before step 2, or run the `signtool` command step 2
   prints. Never commit a certificate, a `.pfx` or a password. Requested signing
   must complete and verify successfully; a failure stops the build. With no
   signing credentials, the build is explicitly unsigned and may be blocked by
   Windows or antivirus. Signing does not establish an antivirus false-positive verdict.
4. **Commit and push** the source change as usual. The normal gate includes
   `server/installer_test.js` (the compiled C# unpacker and its Node validator)
   and `server/install-payload_test.js` (the staged startup import graph). Keep
   these registered: a source checkout containing a file does not prove that
   the installer ships it.
5. **Publish the release** to this clone's own repository (`origin`):

   ```bash
   gh release create setup-v1.2 "dist/AIPLAY Studio Setup.exe" --title "AIPLAY Studio Setup 1.2" --notes "What changed in the installer, in a sentence or two. Studio itself installs from main, so this does not need a release to update."
   ```

   The tag is `setup-v<SetupVersion>`. `gh` publishes to the repository of the
   current clone; add `--repo owner/name` to be explicit.

   **The README's Download button depends on this.** It links
   `releases/latest/download/AIPLAY.Studio.Setup.exe`: GitHub stores the asset
   with its spaces turned into dots, and `latest` means the newest release that
   is not a pre-release. So keep the file name, and publish anything else (the
   YuE2 runtime packages) as a **pre-release**, or the button stops working.

Each repository publishes its own copy. Both copies install either build: the
installer shows Senzu's build (the original) and Bucky's, with how far apart they
are, and the person picks.

The **Windows installer build** GitHub Actions workflow builds Setup and the
launcher from the checked-out public C# sources, runs installer/payload fixtures,
and uploads unsigned build artifacts with SHA256 checksums and source/build
metadata. It never publishes a release automatically and does not claim trusted
signing. Verify the actual workflow result and downloaded artifact hashes before
using those artifacts for a release. A signing provider must be approved and
integrated separately; build provenance is not a replacement for Authenticode.

`install.json` ships inside the app. Its `required` paths must survive filtering;
`scripts/verify-install.mjs` additionally parses the launcher's, server's and
worker's relative static imports without evaluating them. Setup, ZIP packaging
and ZIP updates check the staged payload before replacing an existing install.
The checker needs Node's `--experimental-vm-modules` flag, supplied by each
caller. It does not check optional dynamic imports, installed models or engine
readiness.

**Don't publish a Windows installer release** for a change to anything else, including `install.json`: the
installer reads that from the zip it downloads, so a push is enough.

## Linux installer

`installer/linux/` and `scripts/build-linux-installer.mjs` produce architecture-
specific `.deb` packages and portable `.tar.gz` bundles, including a private Node
runtime with pinned SHA256 checksums. No maintainer scripts run during package
installation. The application-menu entry opens the user-level bootstrap, which
stages and validates the current app before replacing an existing app.

Build on native Linux with `node scripts/build-linux-installer.mjs --arch=x64`
or `--arch=arm64`. Keep the runtime pin and its official archive checksums
together. Build artifacts include licence notices, checksums and source/build
metadata. Never commit the Node runtime or generated packages.

The **Linux installer build and acceptance** workflow builds on Ubuntu 22.04 x64,
Ubuntu 24.04 x64 and Ubuntu 24.04 ARM64. It installs the actual `.deb`, uses the
bundled Node/npm to install an immutable app commit in an isolated home with
spaces, repairs it while preserving a custom workflow and settings, starts the
real launcher and Studio/DAW without generation, then removes the package and
checks user files remain. It also runs offline failure/rollback/payload tests.
This is installer/core acceptance, not GPU/model compatibility certification.

Before publishing, require every native acceptance job to pass and download
and hash-check the actual artifacts. Publish the Linux assets as a **pre-release**
under `linux-setup-v1.0` (or the next bootstrap version), without replacing the
Windows stable `latest` release. The README's Windows download depends on that
stable release. Include both architectures, their portable bundles, combined
checksums and source metadata. Never label unsigned checksums as signing.

An app-only change does not require rebuilding the Linux bootstrap: the
launcher's Update button tracks app code. A bootstrap/runtime/packaging change
needs a new package version, native acceptance and updated download links.

## macOS installer

`installer/macos/` and `scripts/build-macos-installer.mjs` produce separate
Apple silicon (`arm64`) and Intel (`x64`) disk images. Each carries **AIPLAY
Studio.app**, a private official Node/npm runtime verified against pinned
SHA256 checksums, the bootstrap, licence notices and source/build metadata.
The bootstrap installs writable application code outside the bundle into
`~/Library/Application Support/AIPLAY Studio/`.

Build on native macOS with `node scripts/build-macos-installer.mjs --arch=arm64`
or `--arch=x64`. Generated images, runtimes and signing credentials must never
be committed. The current preview uses ad-hoc signing, not Developer ID signing,
and is not notarized. Report that status explicitly; checksums and an ad-hoc
signature do not establish a trusted Apple publisher. Do not tell users to
disable Gatekeeper or remove quarantine attributes.

The native workflow mounts the actual disk image, copies and unmounts the app,
checks its private runtime, and exercises installation of the tested full
source SHA in an isolated home with spaces. It covers repair with custom
workflow/settings preservation, the real launcher and Studio/DAW CPU startup,
two ordinary Finder reopen requests through the same native host and child,
and keeping user files after removal of the copied app. Native runners cover
macOS 14/26 on Apple silicon and macOS 15 on Intel. These checks do not certify
quarantined-download approval, GPU engines or model output quality.

CI acceptance supplies its temporary, contents-read GitHub token only for the
bootstrap's metadata API requests. It is never written to disk or sent to
codeload, and is stripped before npm, the validator and Studio launcher run.
Ordinary public installation does not require a token or GitHub login.

Require every native job to pass and verify the downloaded artifact hashes
and metadata before publishing. Publish both `.dmg` files, their build metadata
and combined checksums as the **pre-release** `macos-setup-v1.0` (or the next
bootstrap version). Keep the asset names `AIPLAY-Studio-macOS-arm64.dmg` and
`AIPLAY-Studio-macOS-x64.dmg`. Do not replace the Windows stable `latest` release.
[The Mac install guide](docs/macOS-install.md) describes the security status
and platform limitations.

App-only updates continue through the launcher and do not require another
disk image. Bootstrap/runtime/packaging changes need a new installer version,
native acceptance and matching download links. A future Developer ID/notarized
release needs an explicitly configured and verified signing/notarization lane;
it must never silently fall back to this ad-hoc preview status.

## After every merge between the two repositories

```bash
node scripts/stamp-lineage.mjs
```

A merge isn't finished until this has run.

- **On a fork**, it writes which of the original's commits the fork now contains.
  If the merge removed the fork's `aiplay.lineage` block, it puts the block back.
  The original deletes that block whenever it merges a fork, as it must.
- **On the original**, it removes an accidentally inherited fork identity after
  a merge, or prints one line and changes nothing if the identity is already correct.

`VERSIONING.md` explains the build line and the protocol number.
