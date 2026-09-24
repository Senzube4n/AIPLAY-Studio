/**
 * The one-click setups, for an agent: the same door as the [Set up timed
 * lyrics] button and the launcher's "Try again" beside Studio's own packages
 * (POST /api/setup, server/setup/routes.js).
 *
 * setup_feature DOWNLOADS and changes which program Studio runs, so the
 * in-app chat may not call it (server/chat/router.js WITHHELD, beside
 * download_model); an external MCP client may, after the person agrees.
 * setup_status only reads.
 */
import { RECIPE_IDS, TORCH_CHOICES } from "./setup/venv.js";
import { ENGINE_SETUP_ID } from "./setup/engine-packages.js";

/** Every setup the door knows: the venv recipes, then Studio's own engine packages. */
export const SETUP_IDS = [...RECIPE_IDS, ENGINE_SETUP_ID];

export function setupTools(api) {
  return [
    {
      name: "setup_feature",
      description: "Set up something Studio needs, with no system Python and no command prompt. "
        + "`lyrics` (timed lyrics): builds a private Python 3.12 environment in Studio's data folder with the kept, "
        + "checksum-checked uv, installs PyTorch (CUDA 12.6 on an NVIDIA card, 12.8 on an RTX 50, the CPU build otherwise; "
        + "`torch` overrides) and faster-whisper plus stable-ts, checks both import, and only then makes it the timed lyrics "
        + "python (the same setting as timed_lyrics_python). `stems` (stem separation, and the audio-reference encoder that "
        + "shares its python): the same private Python 3.12 with demucs, numpy, av and safetensors; `auto` builds PyTorch for "
        + "CUDA 12.8 (RTX 50 included; 12.6 on a card older than sm_70) on an NVIDIA card when the drive has room for it and "
        + "the CPU build otherwise, and setup_status says which, why and how big. Every CUDA build is proven with a real "
        + "tensor op on the card; when the card fails it, the python is still chosen and separation runs on the processor. "
        + "demucs writes FLAC with ffmpeg, which no setup installs (setup_status ffmpegFound). `studio-packages`: installs "
        + "Studio's own OpenCV, librosa and soundfile again into an engine Studio installed, pinned to its torch and numpy "
        + "(refused for any other ComfyUI). "
        + "Read setup_status first: it gives this machine's download and disk size and the exact sentence the button shows; "
        + "tell the person and get their agreement before calling this. Returns at once with the job's state; poll "
        + "setup_status for progress. Already working, it installs nothing and says so, unless its PyTorch fails on the "
        + "card, is the CPU build where auto offers a CUDA one (setup_status onProcessor), or `torch` names another build: "
        + "then it builds Studio's own. When it would change nothing (AIPLAY_WHISPER_PYTHON or AIPLAY_SYS_PYTHON is set, "
        + "or the engine is not Studio's) it refuses with the reason.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", enum: SETUP_IDS, description: "Which setup: lyrics, stems, or studio-packages." },
          torch: { type: "string", enum: TORCH_CHOICES, description: "Optional, lyrics and stems only. auto (default) follows the graphics card (and, for stems, the free space on the drive); cu126, cu128 (CUDA 12.8, for an RTX 50) or cpu chooses the PyTorch build, and a python already there with another build is replaced." },
        },
        required: ["id"],
        additionalProperties: false,
      },
      async run(a) {
        const r = await api("POST", "/api/setup", { action: "run", id: String(a.id || ""), ...(a.torch ? { torch: String(a.torch) } : {}) });
        if (r?.error) throw new Error(r.error);
        return r.job;
      },
    },
    {
      name: "setup_status",
      description: "What each one-click setup would do (folder, Python, PyTorch build and the sentence for each choice, "
        + "packages, download and disk sizes; for stems also freeGb and needGb, the drive's free space and what each "
        + "build needs, and ffmpegFound), whether the feature already works on this machine (ready) and whether it works "
        + "only on the processor while a GPU build is on offer (onProcessor), why a setup would be "
        + "refused, and the state of its job: step, the last lines of output and the final sentence. Reads only.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", enum: SETUP_IDS, description: "Optional: one setup; all when omitted." } },
        additionalProperties: false,
      },
      async run(a = {}) {
        const r = await api("POST", "/api/setup", { action: "status", ...(a.id ? { id: String(a.id) } : {}) });
        if (r?.error) throw new Error(r.error);
        return r;
      },
    },
  ];
}
