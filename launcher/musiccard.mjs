/**
 * THE LAUNCHER'S "MUSIC MODEL" LINES, from the same answer Studio gives.
 *
 * The launcher kept its own default (`prefs.music.engine || "minimax-music3"`).
 * Once a fresh install stopped writing the machine's pick into settings.json
 * (server/fit.js defaultFor, UI_PLAN A1), that copy named MiniMax Music 3 on
 * every fresh install, and on AMD warned about a MiniMax nobody had chosen,
 * while Studio ran YuE2. Both now ask server/music-default.js (import-free:
 * this process may not import config.js), fed from the disk scan the launcher
 * already does. Pure, so server/defaults_test.js runs it on imaginary disks.
 */
import { musicDefault, yue2BuildFor, modelName } from "../server/music-default.js";

const bare = (n) => String(n || "").replace(/\.(safetensors|sft)$/i, "");
const buildOf = (n) => bare(n).replace(/^yue2?_?3b_?/i, "") || bare(n);

/** Engine names as the launcher has always shown them. */
export const ENGINE_LABEL = {
  "minimax-music3": "MiniMax Music 3",
  "yue2-comfy": "YuE2 3B (ComfyUI)",
  "yue2": "YuE2 3B (Python kit)",
  "yue2-gguf": "YuE2 GGUF (native)",
  "ace-step15": "ACE-Step 1.5 (ComfyUI)",
};

/**
 * @param {object} o
 *   prefs          settings.json `prefs` (may be undefined)
 *   api            settings.json `api` (API mode: { enabled, provider })
 *   yue2           YuE2 checkpoint file names found in checkpoints folders
 *   comfyOk        a ComfyUI install and its Python were found
 *   ggufOk         native YuE2 GGUF installed, and the right build for this card
 *   ggufPrecisions which GGUF files are there: ["q4_0", "q8_0"]
 *   minimaxReady   MiniMax Music 3's three files are on disk
 *   vendor         "nvidia" | "amd" | "intel" | "cpu" | null. "cpu" is the
 *                  CPU-only install's stub (scripts/install-engine.mjs writes
 *                  settings.gpu { vendor: "cpu", totalMb: 0 }): no card.
 *   cardRead       false when a card was named but its memory was not read.
 *                  Studio's readMachine counts that as no card reading
 *                  (server/fit.js), so the default does too.
 *   amdMusicFixed  this launch starts ComfyUI with the AMD music fix
 *   comfyFits      false when this PC is under YuE2-for-ComfyUI's minimum,
 *   comfyShort     and which half fell short, "card" or "ram"
 *                  (checks.mjs yue2ComfyVerdict, the function Studio asks)
 * @returns {{ full: {engine, warn, why, value, chosenBy}, music: {via, engine} }}
 */
export function musicCards({ prefs = {}, api = null, yue2 = [], comfyOk = false, ggufOk = false,
  ggufPrecisions = [], minimaxReady = false, vendor = null, cardRead = true, amdMusicFixed = false, comfyFits, comfyShort = null } = {}) {
  const savedEngine = typeof prefs?.music?.engine === "string" ? prefs.music.engine : null;
  const savedCkpt = typeof prefs?.music?.yue2Checkpoint === "string" ? prefs.music.yue2Checkpoint : null;
  /* A file an older Studio wrote has no `keptFromBefore`: every value in it was
   * saved whether chosen or not (config.js says the same). */
  const kept = !!savedEngine && (!Array.isArray(prefs?.keptFromBefore) || prefs.keptFromBefore.includes("music.engine"));
  const choices = [
    ...yue2.map((n) => ({ engine: "yue2-comfy", checkpoint: n, label: `YuE2 3B · ${buildOf(n)}`, available: comfyOk })),
    ...(ggufOk ? (ggufPrecisions.length ? ggufPrecisions : ["q4_0"]).map((p) => ({
      engine: "yue2-gguf", precision: p, label: `YuE2 GGUF · ${p.replace(/_0$/, "").toUpperCase()}`, available: true })) : []),
    { engine: "minimax-music3", label: "MiniMax Music 3", available: minimaxReady && comfyOk },
    ...(api?.enabled ? [{ engine: "minimax-music3", api: api.provider || "fal", label: "MiniMax Music 3 · API", available: true }] : []),
  ];
  /* A card Studio would read: not the CPU-only stub, and with its memory. */
  const card = vendor && vendor !== "cpu" && cardRead !== false ? vendor : null;
  const machine = { gpu: card ? { vendor: card } : null, amdMusicFixed };
  /* comfy: Full Studio starts the ComfyUI found here; without one, a machine
   * with nothing installed is pointed at the native GGUF instead. */
  const d = musicDefault({
    saved: savedEngine ? { engine: savedEngine, checkpoint: savedCkpt, kept } : null,
    choices, machine, api: api?.enabled ? { enabled: true, provider: api.provider || null } : null, comfy: comfyOk, comfyFits, comfyShort,
  });

  const ckptShown = d.value === "yue2-comfy"
    ? (d.checkpoint && yue2.includes(d.checkpoint) ? d.checkpoint : yue2BuildFor(yue2, vendor)) : null;
  /* A saved native GGUF that is not installed runs through ComfyUI for that
   * session (index.js startup, config.js overrideForSession): said, not hidden. */
  const ggufSwap = savedEngine === "yue2-gguf" && !ggufOk;
  let engine = d.paid ? "MiniMax Music 3 (hosted, your API key)"
    : `${ENGINE_LABEL[d.value] || modelName(d.label) || d.value}${ckptShown ? ` · ${buildOf(ckptShown)}` : ""}`;
  if (ggufSwap && comfyOk && yue2.length) engine = `YuE2 3B (ComfyUI) · ${buildOf(yue2BuildFor(yue2, vendor))} for this session`;
  const warn = savedEngine === "minimax-music3" && !d.paid && vendor === "amd" && !amdMusicFixed
    ? "Your selected music model is MiniMax, which renders broken audio on AMD unless ComfyUI starts with PyTorch attention and CUDA graphs off. Set the AMD/Intel engine fix to On under Advanced, or pick YuE2."
    : ggufSwap
      ? (comfyOk && yue2.length
        ? "Native YuE2 GGUF is selected but not installed; this session runs YuE2 through ComfyUI, and your choice stays saved."
        : "Native YuE2 GGUF is selected but not installed. Install it from the Models screen after launch.")
      : null;

  /* MUSIC-ONLY, as index.js decides it at start: a saved YuE2-through-ComfyUI
   * runs through ComfyUI; otherwise native GGUF when it is installed (config.js
   * swaps any other saved engine for it, for that session only), else YuE2
   * through ComfyUI when a checkpoint and ComfyUI are there. */
  const comfyReady = comfyOk && yue2.length > 0;
  const via = savedEngine === "yue2-comfy" && comfyReady ? "yue2-comfy"
    : ggufOk ? "yue2-gguf" : comfyReady ? "yue2-comfy" : null;
  const onlyCkpt = via === "yue2-comfy"
    ? (savedCkpt && yue2.includes(savedCkpt) ? savedCkpt : yue2BuildFor(yue2, vendor)) : null;
  return {
    full: { engine, warn, why: d.why, value: d.value, chosenBy: d.chosenBy },
    music: {
      via,
      engine: via === "yue2-comfy" ? `YuE2 3B through ComfyUI (${bare(onlyCkpt)})`
        : via === "yue2-gguf" ? "YuE2 GGUF (native)" : "setup needed",
    },
  };
}
