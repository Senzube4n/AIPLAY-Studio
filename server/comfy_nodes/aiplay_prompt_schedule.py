"""
AIPLAY prompt schedule — one conditioning per frame, from a few keyframes.

WHY THIS EXISTS. AnimateDiff renders a batch of frames as one latent batch,
and ComfyUI applies a conditioning whose batch matches the latent batch
frame by frame. That is how Yvann's workflow changes the look on every drum
hit: the reference pictures' weights are a per-frame schedule. This node is
the text half of that idea with no third-party pack: a handful of prompts at
frame numbers, encoded once each, and linearly interpolated between the
keyframes so a look travels from one prompt to the next across a bar rather
than snapping — or snaps, when the keyframes sit one frame apart.

The idea is FizzNodes' BatchPromptSchedule (MIT); this is a re-statement of
its shape in forty lines rather than a dependency: FizzNodes pulls pandas and
numexpr into the engine's venv for a schedule that is a JSON object here.

Inputs
  clip      the checkpoint's CLIP
  frames    how many frames the batch has
  schedule  JSON: {"0": "first look", "24": "second look", ...} — frame → prompt.
            A frame before the first key uses the first prompt; after the last,
            the last. Between two keys the embeddings are interpolated.
  hold      true = step between keys (a cut on the frame); false = interpolate.

Output: CONDITIONING with a batch of `frames` embeddings and pooled outputs.
"""
import json
import torch


class AiplayPromptSchedule:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "frames": ("INT", {"default": 16, "min": 1, "max": 4096}),
                "schedule": ("STRING", {"multiline": True, "default": '{"0": "a look", "16": "another look"}'}),
                "hold": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("CONDITIONING",)
    RETURN_NAMES = ("conditioning",)
    FUNCTION = "build"
    CATEGORY = "AIPLAY/conditioning"

    def build(self, clip, frames, schedule, hold):
        try:
            raw = json.loads(schedule) if schedule.strip() else {}
        except json.JSONDecodeError as exc:
            raise ValueError(f"schedule is not JSON: {exc}") from exc
        keys = sorted(((int(k), str(v)) for k, v in raw.items()), key=lambda kv: kv[0])
        if not keys:
            raise ValueError("schedule needs at least one frame: prompt pair")

        encoded = {}
        for _, text in keys:
            if text in encoded:
                continue
            tokens = clip.tokenize(text)
            cond, pooled = clip.encode_from_tokens(tokens, return_pooled=True)
            encoded[text] = (cond, pooled)

        conds, pools = [], []
        for f in range(int(frames)):
            # the keyframe at or before f, and the one after it
            before = None
            after = None
            for k, text in keys:
                if k <= f:
                    before = (k, text)
                elif after is None:
                    after = (k, text)
            if before is None:
                c, p = encoded[after[1]]
            elif after is None or hold or before[1] == after[1]:
                c, p = encoded[before[1]]
            else:
                t = (f - before[0]) / float(after[0] - before[0])
                c0, p0 = encoded[before[1]]
                c1, p1 = encoded[after[1]]
                c = c0 * (1.0 - t) + c1 * t
                p = p0 * (1.0 - t) + p1 * t if (p0 is not None and p1 is not None) else p0
            conds.append(c)
            pools.append(p)

        cond = torch.cat(conds, dim=0)
        out = {}
        if all(p is not None for p in pools):
            out["pooled_output"] = torch.cat(pools, dim=0)
        return ([[cond, out]],)


NODE_CLASS_MAPPINGS = {"AiplayPromptSchedule": AiplayPromptSchedule}
NODE_DISPLAY_NAME_MAPPINGS = {"AiplayPromptSchedule": "AIPLAY prompt schedule (per frame)"}
