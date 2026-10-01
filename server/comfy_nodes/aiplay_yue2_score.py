"""Expose the exact YuE2 notation used by this prompt in ComfyUI history.

This output branch does no sampling and edits no text. The graph's music node
and this node receive the same planner output (or supplied ABC). A per-job key
binds the history record to the Studio job, including planner cache hits.
"""
import math


class AiplayYuE2Score:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "abc": ("STRING", {"multiline": True, "forceInput": True}),
            "seconds": ("FLOAT", {"forceInput": True}),
            "capture_key": ("STRING", {"default": ""}),
        }}

    RETURN_TYPES = ()
    FUNCTION = "capture"
    OUTPUT_NODE = True
    CATEGORY = "AIPLAY/music"

    def capture(self, abc, seconds, capture_key):
        # Missing/malformed model notation must never cost the finished audio.
        if not isinstance(abc, str) or not abc.strip() or len(abc.encode("utf-8")) > 65536:
            return {"ui": {"aiplay_yue2_score": []}, "result": ()}
        try:
            duration = float(seconds)
        except (TypeError, ValueError, OverflowError):
            duration = float("nan")
        return {"ui": {"aiplay_yue2_score": [{
            "abc": abc,
            "capture_key": capture_key,
            "audio_seconds": duration if math.isfinite(duration) and duration > 0 else None,
        }]}, "result": ()}


NODE_CLASS_MAPPINGS = {"AiplayYuE2Score": AiplayYuE2Score}
NODE_DISPLAY_NAME_MAPPINGS = {"AiplayYuE2Score": "AIPLAY YuE2 score capture"}
