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
        + "checksum-checked uv, installs PyTorch (CUDA 12.6 on an NVIDIA card, the CPU build otherwise; `torch` overrides) "
        + "and faster-whisper plus stable-ts, checks both import, and only then makes it the timed lyrics python (the same "
        + "setting as timed_lyrics_python). `studio-packages`: installs Studio's own OpenCV, librosa and soundfile again "
        + "into an engine Studio installed, pinned to its torch and numpy (refused for any other ComfyUI). "
        + "Read setup_status first: it gives this machine's download and disk size and the exact sentence the button shows; "
        + "tell the person and get their agreement before calling this. Returns at once with the job's state; poll "
        + "setup_status for progress. Already working, it installs nothing and says so; when it would change nothing "
        + "(AIPLAY_WHISPER_PYTHON is set, or the engine is not Studio's) it refuses with the reason.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", enum: SETUP_IDS, description: "Which setup: lyrics, or studio-packages." },
          torch: { type: "string", enum: TORCH_CHOICES, description: "Optional, lyrics only. auto (default) follows the graphics card; cu126 or cpu chooses the PyTorch build." },
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
        + "packages, download and disk sizes), whether the feature already works on this machine, why a setup would be "
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
