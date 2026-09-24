/**
 * The launcher's judgements, as pure functions.
 *
 * launcher.mjs starts a server the moment it is imported, so nothing in it can
 * be called from a test. What the system check SAYS — the RAM line, the ffmpeg
 * row, the advice for a weak or missing graphics card, the Music only note,
 * Studio's own packages — lives here instead, takes plain readings, and returns
 * the rows and sentences the page shows. server/installer_test.js calls each
 * one. The page decides nothing: it displays these.
 *
 * ONE SOURCE. The music-video thresholds are not typed here: they are the H3
 * row's `requires` in server/models.js, the same numbers the Models screen
 * judges with (server/fit.js). When the catalogue moves H3's floor, the
 * launcher and the Models screen move together.
 */
import { CATALOG } from "../server/models.js";
import { MODULE_WORDS, STUDIO_MODULES } from "../server/setup/studio-packages.js";

/** The catalogue row the Models screen calls "Video clips — MiniMax H3". */
export const H3_ROW = "video";

/** What the launcher judges H3 by, read from that row: { vramGb, ramGb }.
 *  vramGb is the row's VRAM minimum, the smallest card a measured tier covers
 *  (server/h3tier.js); under it the Models screen says "Below the minimum".
 *  ramGb is the RAM H3 was measured with, which the row prints as recommended
 *  (the owner's sentence names it); the row's RAM minimum is lower, and only
 *  stands in when no recommended figure is given. */
export function h3Needs(catalog = CATALOG) {
  const r = catalog.find((c) => c.id === H3_ROW)?.requires || {};
  return { vramGb: Number(r.vramMinGb) || 0, ramGb: Number(r.ramRecGb) || Number(r.ramMinGb) || 0 };
}

/* Rounded to the nearest whole GB, as server/fit.js does: a 16 GB card reads
 * 15.99 GB. The numbers people know are the ones on the box. */
const wholeGb = (bytes) => Math.round((Number(bytes) || 0) / 1024 ** 3);

/** os.totalmem() is USABLE memory: a 32 GB laptop or APU whose integrated
 *  graphics keeps 1 to 4 GB reads 28 to 31 GB. Rounding cannot absorb that,
 *  so the RAM line allows this much under the floor before it warns. */
export const RAM_RESERVED_GB = 4;

/** The RAM row. Under the RAM H3 was measured with (less what integrated
 *  graphics may keep) it warns, in the words the owner chose. */
export function ramItem(totalBytes, need = h3Needs()) {
  const exact = (Number(totalBytes) || 0) / 1024 ** 3;
  const low = need.ramGb > 0 && exact < need.ramGb - RAM_RESERVED_GB;
  const said = `Music videos (H3) were measured with ${need.ramGb} GB of RAM`;
  return {
    id: "ram", label: "System memory (RAM)", status: low ? "warn" : "ok",
    value: `${exact.toFixed(1)} GB`,
    detail: low ? `${said}; with less, expect slow renders` : said,
  };
}

/** The ffmpeg row: both programs, since exporting needs ffmpeg and reading a
 *  clip's length needs ffprobe. `found` is { ffmpeg, ffprobe }: a path or null. */
export function ffmpegItem({ ffmpeg = null, ffprobe = null } = {}) {
  const both = !!(ffmpeg && ffprobe);
  const value = both ? "ffmpeg and ffprobe found"
    : ffmpeg ? "ffmpeg found · ffprobe not found"
    : ffprobe ? "ffprobe found · ffmpeg not found"
    : "not found";
  return {
    id: "ffmpeg", label: "ffmpeg", status: both ? "ok" : ffmpeg || ffprobe ? "warn" : "off", value,
    detail: "ffmpeg: video export, clip joins, Reactive"
      + (both ? "" : ". Studio does not install it: put ffmpeg and ffprobe on PATH, or name them in AIPLAY_FFMPEG and AIPLAY_FFPROBE"),
  };
}

/**
 * The advice for a weak or missing graphics card, or null.
 * The friend comes FIRST: lending a card through Collab costs nothing and
 * sends a sealed file, no server; Comfy API is second, on the person's own key
 * and paid per run. Both are only suggested; nothing is switched.
 *
 *   gpu            the card as read ({ name, totalMb, vendor }) or null
 *   torchOnCard    ComfyUI's PyTorch runs on a card (cuda, rocm, xpu): a card
 *                  exists even when its name and memory were not read
 *   fullAvailable  Full Studio can launch (an engine is chosen). When it
 *                  cannot, the friend's way starts with the missing step:
 *   needsEngine    no ComfyUI at all, so the setup card ("What should Studio
 *                  run on?") is showing: install the CPU-only engine; else
 *                  ComfyUI installs were found and one must be chosen.
 *
 * Null — nothing claimed — when the card is at or above H3's floor (a CPU
 * PyTorch on a strong card is the PyTorch row's to say, not a reason to ask a
 * friend), or when a card was read but its memory was not (AMD and Intel
 * cards read from the registry sometimes have none): "cannot tell" is not "weak".
 */
export function cardAdvice({ gpu = null, torchOnCard = false, fullAvailable = true, needsEngine = true, need = h3Needs() } = {}) {
  const realCard = !!gpu && gpu.vendor !== "cpu";
  const gb = realCard && gpu.totalMb ? wholeGb(gpu.totalMb * 1024 * 1024) : null;
  if (realCard && gb === null) return null;
  if (realCard && gb >= need.vramGb) return null;
  if (!realCard && torchOnCard) return null;
  const why = realCard
    ? `This ${gpu.name || "graphics card"} has ${gb} GB of memory; music videos (MiniMax H3) need a card with at least ${need.vramGb} GB, as the Models screen says.`
    : "No graphics card that Studio can render on was read on this PC.";
  return {
    why,
    /* The page leads each with its bold first words ("Ask a friend with a
     * strong card to render for you." / "Or use Comfy API"); these are the rest. */
    friend: "Collab, in Full Studio, packs a scene into a sealed file only they can open; they render it on their "
      + "card and send the clip back. No account, no server, no cost. Both of you use Full Studio."
      + (fullAvailable ? ""
        : needsEngine
          ? " Full Studio needs an engine first, even to lend and borrow: choose CPU only under \"What should Studio run on?\" "
            + "(it only has to open Studio, not render), then launch Full Studio and open Collab."
          : " Full Studio needs its ComfyUI chosen first: press Change… beside \"ComfyUI install\" above, "
            + "then launch Full Studio and open Collab."),
    cloud: "Hosted models, below, on your own Comfy API key, paid per run in Comfy credits.",
  };
}

/** Music only's note, which says where lending lives. */
export function musicOnlyNote(startsComfy) {
  return `${startsComfy ? "Music screens only. Starts ComfyUI for YuE2." : "Music screens only. No ComfyUI."} `
    + "Lending or borrowing a graphics card (Collab) needs Full Studio.";
}

/**
 * The "Studio's own packages" row, for an engine Studio installed
 * (settings.engineInstall), or null for any other ComfyUI. `retry` is the
 * page's button: "Try again" after a failure, "Install" on an engine made
 * before this step existed (its record has no studioPackages).
 */
export function studioPackagesItem(engineInstall) {
  if (!engineInstall) return null;
  const sp = engineInstall.studioPackages;
  const words = (mods) => mods.map((m) => MODULE_WORDS[m] || m).join(", ");
  const uses = "Clip posters, the compositor, hum-to-score and the DAW bounce need them";
  if (!sp) {
    return { id: "studiopkgs", label: "Studio's own packages", status: "off", value: "not installed yet",
      detail: `${uses}. This engine was installed before Studio added them.`, retry: "studio-packages", retryLabel: "Install" };
  }
  if (sp.ok === true) {
    return { id: "studiopkgs", label: "Studio's own packages", status: "ok", value: words(STUDIO_MODULES),
      detail: `in the engine's python. ${uses}.` };
  }
  const missing = Array.isArray(sp.missing) && sp.missing.length ? sp.missing : STUDIO_MODULES;
  return { id: "studiopkgs", label: "Studio's own packages", status: "warn", value: `missing: ${words(missing)}`,
    detail: `${uses}; everything else runs.`, retry: "studio-packages", retryLabel: "Try again" };
}
