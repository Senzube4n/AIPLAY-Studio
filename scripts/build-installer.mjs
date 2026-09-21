/**
 * Builds dist/AIPLAY Studio Setup.exe, the one-time installer.
 *
 *   node scripts/build-installer.mjs
 *
 * REBUILD IT RARELY. The installer knows two repository names and nothing else
 * about Studio: what it unpacks comes from install.json inside the zip it
 * downloads, so an app change never needs a new installer. Rebuild only when
 * installer/Setup.cs itself changes, and sign it each time you do. Publishing
 * it as a GitHub release: RELEASING.md.
 *
 * Windows only. Uses the C# compiler of .NET Framework 4, which every Windows
 * 10/11 already has, like scripts/build-launcher-exe.mjs. Nothing is downloaded.
 *
 * Signing uses the same environment as build-launcher-exe.mjs:
 *   AIPLAY_SIGN_SHA1       thumbprint of a certificate in your Windows store
 *   AIPLAY_SIGN_PFX        …or a .pfx file, with AIPLAY_SIGN_PASSWORD
 *   AIPLAY_SIGN_TIMESTAMP  RFC 3161 server (default: DigiCert's)
 * With none set, it builds unsigned and prints the signtool command to run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "installer", "Setup.cs");
const ICON = path.join(ROOT, "launcher", "aiplay.ico");
const DIST = path.join(ROOT, "dist");
const OUT = path.join(DIST, "AIPLAY Studio Setup.exe");

if (process.platform !== "win32") {
  console.error("The installer is a Windows program. Elsewhere, clone the repository and run: node launcher/launcher.mjs");
  process.exit(1);
}
if (!existsSync(ICON)) {
  console.error("launcher/aiplay.ico is missing; run node scripts/build-launcher-exe.mjs once to make it.");
  process.exit(1);
}

/* The window's logo: the 400 px PNG the SVG wraps, sharper than the 192 px one. */
mkdirSync(DIST, { recursive: true });
const logo = path.join(DIST, ".setup-logo.png");
const svg = readFileSync(path.join(ROOT, "web", "assets", "aiplay-logo.svg"), "utf8");
const b64 = /base64,([A-Za-z0-9+/=]+)/.exec(svg);
writeFileSync(logo, b64 ? Buffer.from(b64[1], "base64") : readFileSync(path.join(ROOT, "web", "assets", "aiplay-logo.png")));

const windir = process.env.WINDIR || "C:\\Windows";
const fw = ["Framework64", "Framework"].map((f) => path.join(windir, "Microsoft.NET", f, "v4.0.30319")).find((d) => existsSync(path.join(d, "csc.exe")));
if (!fw) {
  console.error("No .NET Framework 4 C# compiler found (csc.exe under %WINDIR%\\Microsoft.NET).");
  process.exit(1);
}
const ref = (dll) => `/r:${path.join(fw, dll)}`;

try {
  execFileSync(path.join(fw, "csc.exe"), [
    "/nologo", "/target:winexe", "/optimize+", "/platform:anycpu",
    `/win32icon:${ICON}`,
    `/resource:${logo},logo.png`,
    "/r:System.dll", "/r:System.Core.dll", "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll",
    ref("System.IO.Compression.dll"), ref("System.IO.Compression.FileSystem.dll"), ref("System.Web.Extensions.dll"),
    `/out:${OUT}`,
    SRC,
  ], { stdio: "inherit" });
} finally {
  rmSync(logo, { force: true });
}
console.log(`exe:  ${OUT} (${Math.round(statSync(OUT).size / 1024)} KB)`);

/* ── signing ───────────────────────────────────────────────────────────────
 * Timestamped, or every signature stops validating the day the certificate
 * expires, including on copies people already downloaded. */
const kits = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
const signtool = (existsSync(kits) ? readdirSync(kits).filter((d) => /^10\./.test(d)).sort().reverse() : [])
  .map((v) => path.join(kits, v, "x64", "signtool.exe"))
  .find((p) => existsSync(p));
const ts = process.env.AIPLAY_SIGN_TIMESTAMP || "http://timestamp.digicert.com";
const SHA1 = process.env.AIPLAY_SIGN_SHA1;
const PFX = process.env.AIPLAY_SIGN_PFX;

if (!SHA1 && !PFX) {
  console.log("sign: skipped (unsigned). To sign, either set AIPLAY_SIGN_SHA1 / AIPLAY_SIGN_PFX and rebuild, or run:");
  console.log(`  "${signtool || "signtool.exe"}" sign /fd SHA256 /sha1 <certificate thumbprint> /tr ${ts} /td SHA256 "${OUT}"`);
} else {
  if (!signtool) {
    console.error("sign: signtool.exe not found; install the Windows SDK's 'Windows SDK Signing Tools'.");
    process.exit(1);
  }
  const who = SHA1 ? ["/sha1", SHA1] : ["/f", PFX, ...(process.env.AIPLAY_SIGN_PASSWORD ? ["/p", process.env.AIPLAY_SIGN_PASSWORD] : [])];
  execFileSync(signtool, ["sign", "/fd", "SHA256", ...who, "/tr", ts, "/td", "SHA256", OUT], { stdio: "inherit" });
  try {
    execFileSync(signtool, ["verify", "/pa", OUT], { stdio: "inherit" });
    console.log("sign: signed and verified against the default Authenticode policy.");
  } catch {
    console.log("sign: SIGNED, but it does not verify against the default policy (a self-signed or untrusted "
      + "certificate). Other machines will still see SmartScreen.");
  }
}
