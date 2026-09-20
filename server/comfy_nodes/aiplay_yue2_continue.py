"""
CONTINUE A RECORDING ON YuE2 THROUGH ComfyUI.

The Python kit can already do this: `yue_driver.py --extend-codes` replays a
list of semantic codes as the sampler's prefix and carries on. ComfyUI's own
YuE2 nodes cannot, and not by oversight — token generation is sealed inside the
text encoder. `YuE2TEModel.encode_token_weights` generates the codes, hands
them straight to `_acoustic_conditioning`, and returns only their COUNT to the
graph (comfy/text_encoders/yue2.py). No node downstream can see a token, and no
node upstream can supply one. The stock `YuE2GenerateMusic` has eleven inputs
and none of them is a prefix.

So this node reaches past the graph rather than through it: it builds the same
`tokens` dict the stock node builds, swaps `encode_token_weights` on the model
instance for one call, and lets ComfyUI do all the loading, device placement
and offloading exactly as it would have. The swapped function is the stock one
with four lines changed, and they are the same four the kit's driver changes:

  1. the codes, offset into the vocabulary, become a replay list;
  2. the replay is appended to the positive prefix;
  3. and to the negative branch, so classifier-free guidance compares like
     with like;
  4. the replay is prepended to the generated codes before the acoustic pass,
     so the NAR solves the whole sequence.

⚠ WHY THE CODES ARE OFFSET HERE AND NOT IN THE KIT. ComfyUI's sampler masks
its logits to `CODEC_OFFSET : CODEC_OFFSET + CODEC_SIZE` and appends the raw
vocabulary id, so its own token list is already offset; the kit's is in codec
space and subtracts on the way out. `semantic.npy` — written by a run or by our
own `yue_tokenize.py` — is codec space in both worlds, so this node adds the
offset and the kit's driver adds it too.

⚠ WHAT IT COSTS. A continuation has no score to plan under, so `mode` is `off`,
and ComfyUI's tokenizer defaults cfg_scale to 1.01 rather than 1.0 when the
chain of thought is off — which turns classifier-free guidance ON and doubles
the KV cache. The kit's path does not. This is the more expensive of the two
doors, and it is the one that runs on an AMD card.

⚠ AND WHAT IT IS NOT. The acoustic model re-solves every frame from noise, the
replayed ones included, so the kept part comes back as a different waveform.
Whoever joins the result to the original must splice at the seam, exactly as
the Studio does for the Python kit.
"""
import os

import numpy as np
import torch

import comfy.model_management
import comfy.text_encoders.yue2 as _yue2

CODEC_OFFSET = 151853
CODEC_SIZE = 32768
FRAMES_PER_SECOND = 25


def _load_codes(codes_dir, seconds):
    """The first `seconds` of a semantic.npy, as a list of codec-space ints."""
    path = codes_dir.strip().strip('"')
    if os.path.isdir(path):
        path = os.path.join(path, "semantic.npy")
    if not os.path.isfile(path):
        raise ValueError(f"No semantic.npy at {path}. The Studio's tokenizer writes one per recording; "
                         "point this at that folder.")
    codes = np.load(path, allow_pickle=False)
    if codes.ndim != 1 or codes.dtype.kind not in "iu":
        raise ValueError(f"{path} is not a 1-D integer array of semantic codes.")
    if codes.size and (int(codes.min()) < 0 or int(codes.max()) >= CODEC_SIZE):
        raise ValueError(f"{path} holds values outside the codec range 0..{CODEC_SIZE - 1}.")
    keep = codes.shape[0] if seconds <= 0 else min(codes.shape[0], max(1, int(round(seconds * FRAMES_PER_SECOND))))
    return [int(t) for t in codes[:keep].tolist()]


def _encode_with_replay(model, tokens, replay):
    """comfy.text_encoders.yue2.YuE2TEModel.encode_token_weights, with the replay in it.

    Kept line-for-line alongside the original so a ComfyUI update that changes
    it is visible as a difference rather than as a silent divergence."""
    device = model.execution_device
    dtype = torch.bfloat16 if comfy.model_management.should_use_bf16(device) else torch.float32
    prefix = tokens["prefix"]
    abc_ids = tokens["abc_ids"]
    cot = tokens["cot"]
    if cot == "off":
        abc_ids = []
    prefix = prefix + abc_ids + [_yue2.ABC_END, _yue2.MUSIC_START]
    negative = tokens["negative"] + ([_yue2.MUSIC_START] if cot == "off"
                                     else [_yue2.ABC_START] + abc_ids + [_yue2.ABC_END, _yue2.MUSIC_START])
    # (1) and (2) and (3): the replay rides both branches, after the music mark.
    # `text_prefix` is kept apart because the acoustic pass chunks on the TEXT
    # prefix's length while the replay is part of its token stream.
    text_prefix = prefix
    offset_replay = [t + CODEC_OFFSET for t in replay]
    prefix = text_prefix + offset_replay
    negative = negative + offset_replay
    context = model.config.max_position_embeddings
    max_tokens = min(tokens["max_tokens"], context - max(len(prefix), len(negative)))
    if max_tokens < 1 or len(prefix) + 5 > context:
        raise ValueError(
            f"The replay ({len(replay)} frames, {len(replay) / FRAMES_PER_SECOND:.0f}s) and the prompt leave no "
            f"room for new music in {context} positions. Start from fewer seconds of the recording, or shorten "
            "the style and lyrics.")
    semantic, semantic_truncated = model._generate(
        prefix, tokens["seed"], max_tokens, "semantic", dtype,
        negative=negative, cfg_scale=tokens["cfg_scale"], legacy_off=cot == "off",
        temperature=tokens["temperature"], top_p=tokens["top_p"], top_k=tokens["top_k"],
        repetition_penalty=tokens["repetition_penalty"], penalty_window=50,
        min_tokens=min(200, max_tokens),
    )
    # (4): the acoustic model solves the replay and the new material as one piece.
    whole = offset_replay + semantic
    conditioning, chunks = model._acoustic_conditioning(text_prefix, whole, dtype)
    return conditioning, None, {
        "yue2_chunks": chunks, "yue2_abc_ids": abc_ids, "yue2_frames": len(whole),
        "yue2_truncated": semantic_truncated,
        "aiplay_replay_frames": len(offset_replay),
    }


class AiplayYuE2Continue:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "style": ("STRING", {"multiline": True}),
                "lyrics": ("STRING", {"multiline": True}),
                "codes_dir": ("STRING", {"default": "", "tooltip":
                    "The folder the Studio's real-audio tokenizer wrote for this recording "
                    "(output/yue2/tok_<id>), or a semantic.npy directly."}),
                "prime_seconds": ("FLOAT", {"default": 8.0, "min": 0.0, "max": 120.0, "step": 0.5, "tooltip":
                    "How many seconds of the recording's own performance the model hears first. "
                    "0 replays all of it. Longer is not automatically better: read codes are flatter than "
                    "the model's own, so a long replay walks the sampler off its distribution."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "new_duration": ("FLOAT", {"default": 60.0, "min": 0.04, "max": 900.0, "step": 0.04, "tooltip":
                    "How much NEW music to ask for, in seconds. The replay is extra."}),
            },
            "optional": {
                "abc": ("STRING", {"default": "", "multiline": True, "tooltip":
                    "A score to perform under, if there is one. Empty means the recording alone decides."}),
                "mode": (["off", "melody", "full"], {"default": "off"}),
                "temperature": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.05}),
                "top_p": ("FLOAT", {"default": 0.95, "min": 0.01, "max": 1.0, "step": 0.01}),
                "top_k": ("INT", {"default": 100, "min": 1, "max": 32768}),
                "repetition_penalty": ("FLOAT", {"default": 1.2, "min": 0.01, "max": 10.0, "step": 0.01}),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "FLOAT")
    RETURN_NAMES = ("conditioning", "seconds")
    FUNCTION = "generate"
    CATEGORY = "AIPLAY/yue2"

    def generate(self, clip, style, lyrics, codes_dir, prime_seconds, seed, new_duration,
                 abc="", mode="off", temperature=1.0, top_p=0.95, top_k=100, repetition_penalty=1.2):
        replay = _load_codes(codes_dir, prime_seconds)
        if not abc.strip():
            mode = "off"
        tokens = clip.tokenize(style, lyrics=lyrics, cot=mode, seed=seed, abc=abc,
                               max_tokens=max(1, round(new_duration * FRAMES_PER_SECOND)),
                               temperature=temperature, top_p=top_p, top_k=top_k,
                               repetition_penalty=repetition_penalty)
        model = clip.cond_stage_model
        original = model.encode_token_weights
        model.encode_token_weights = lambda t: _encode_with_replay(model, t, replay)
        try:
            conditioning = clip.encode_from_tokens_scheduled(tokens)
        finally:
            model.encode_token_weights = original
        return (conditioning, conditioning[0][1]["yue2_frames"] / FRAMES_PER_SECOND)


NODE_CLASS_MAPPINGS = {"AiplayYuE2Continue": AiplayYuE2Continue}
NODE_DISPLAY_NAME_MAPPINGS = {"AiplayYuE2Continue": "AIPLAY YuE2 continue from codes"}
