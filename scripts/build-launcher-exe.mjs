/**
 * Builds "AIPLAY Studio.exe" (the windowless launcher with a tray icon) and
 * launcher/aiplay.ico from the AI PLAY mark in web/assets.
 *
 *   node scripts/build-launcher-exe.mjs
 *
 * Windows only. Uses what every Windows 10/11 already has: PowerShell with
 * System.Drawing for the icon, and the C# compiler of .NET Framework 4 for the
 * exe. Nothing is downloaded or installed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXE_DIR = path.join(ROOT, "launcher", "exe");
const ICON = path.join(ROOT, "launcher", "aiplay.ico");
const OUT = path.join(ROOT, "AIPLAY Studio.exe");

if (process.platform !== "win32") {
  console.error("The launcher exe is Windows-only. Elsewhere run: node launcher/launcher.mjs");
  process.exit(1);
}

const svg = path.join(ROOT, "web", "assets", "aiplay-logo.svg");
const png = path.join(ROOT, "web", "assets", "aiplay-logo.png");
const source = existsSync(svg) ? svg : png;
execFileSync("powershell.exe", [
  "-NoProfile", "-ExecutionPolicy", "Bypass",
  "-File", path.join(EXE_DIR, "make-icon.ps1"), "-Source", source, "-Out", ICON,
], { stdio: "inherit" });

const windir = process.env.WINDIR || "C:\\Windows";
const csc = ["Framework64", "Framework"]
  .map((f) => path.join(windir, "Microsoft.NET", f, "v4.0.30319", "csc.exe"))
  .find((p) => existsSync(p));
if (!csc) {
  console.error("No .NET Framework 4 C# compiler found (csc.exe under %WINDIR%\\Microsoft.NET).");
  process.exit(1);
}

execFileSync(csc, [
  "/nologo", "/target:winexe", "/optimize+", "/platform:anycpu",
  `/win32icon:${ICON}`,
  "/r:System.dll", "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll",
  `/out:${OUT}`,
  path.join(EXE_DIR, "AiplayLauncher.cs"),
], { stdio: "inherit" });

console.log(`exe:  ${OUT} (${Math.round(statSync(OUT).size / 1024)} KB)`);

/* ── signing, when somebody has a certificate ────────────────────────────
 *
 * Optional on purpose. An unsigned exe runs perfectly well once SmartScreen is
 * told to, and a SELF-SIGNED certificate does nothing for anyone else: it is
 * trusted only where its root has been installed, so signing with one buys a
 * warning you cannot dismiss for anybody but yourself. What this step is for is
 * a real code-signing certificate, named through the environment rather than
 * written here:
 *
 *   AIPLAY_SIGN_SHA1       thumbprint of a certificate in your Windows store
 *                          (preferred: no password crosses a command line)
 *   AIPLAY_SIGN_PFX        …or a .pfx file, with AIPLAY_SIGN_PASSWORD
 *   AIPLAY_SIGN_TIMESTAMP  RFC 3161 server (default: DigiCert's)
 *
 * TIMESTAMPING IS NOT OPTIONAL when signing: without it every signature stops
 * validating the day the certificate expires, including on copies already
 * downloaded.
 */
const SHA1 = process.env.AIPLAY_SIGN_SHA1;
const PFX = process.env.AIPLAY_SIGN_PFX;
if (!SHA1 && !PFX) {
  console.log("sign: skipped — unsigned (set AIPLAY_SIGN_SHA1, or AIPLAY_SIGN_PFX + AIPLAY_SIGN_PASSWORD, to sign).");
} else {
  const kits = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  const signtool = (existsSync(kits) ? readdirSync(kits).filter((d) => /^10\./.test(d)).sort().reverse() : [])
    .map((v) => path.join(kits, v, "x64", "signtool.exe"))
    .find((p) => existsSync(p));
  if (!signtool) {
    console.error("sign: signtool.exe not found — install the Windows SDK's 'Windows SDK Signing Tools'.");
    process.exit(1);
  }
  const ts = process.env.AIPLAY_SIGN_TIMESTAMP || "http://timestamp.digicert.com";
  const who = SHA1 ? ["/sha1", SHA1] : ["/f", PFX, ...(process.env.AIPLAY_SIGN_PASSWORD ? ["/p", process.env.AIPLAY_SIGN_PASSWORD] : [])];
  execFileSync(signtool, ["sign", "/fd", "SHA256", ...who, "/tr", ts, "/td", "SHA256", OUT], { stdio: "inherit" });
  /* /pa = the Authenticode policy an ordinary user's machine applies. A
   * self-signed certificate fails here, and that failure is the honest answer:
   * it is what everyone but you will see. */
  try {
    execFileSync(signtool, ["verify", "/pa", OUT], { stdio: "inherit" });
    console.log("sign: signed and verified against the default Authenticode policy.");
  } catch {
    console.log("sign: SIGNED, but it does not verify against the default policy — a self-signed or "
      + "untrusted certificate. Other machines will still see SmartScreen.");
  }
}
