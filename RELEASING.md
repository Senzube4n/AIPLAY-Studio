# Releasing

**If you are an assistant working in this repository, this file is written for
you.** `CLAUDE.md` is git-ignored here on purpose, so the rules that must reach
every clone live in tracked files like this one. Follow them without being asked.

## What a release is

**Studio itself is never released.** Everybody installs or updates from `main`:
`AIPLAY Studio Setup.exe` downloads the newest commit of the chosen repository
straight from GitHub, and unpacks what `install.json` in that commit lists. An
app change needs a push and nothing else.

**The only release is the installer**, `AIPLAY Studio Setup.exe`. It knows two
repository names and nothing else about Studio, so it changes rarely. A GitHub
Release is simply where people download it from.

## When to publish a new installer

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
   prints. Never commit a certificate, a `.pfx` or a password. An unsigned
   installer still works, but Windows SmartScreen warns about it.
4. **Commit and push** the source change as usual.
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

**Don't release** for a change to anything else, including `install.json`: the
installer reads that from the zip it downloads, so a push is enough.

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
