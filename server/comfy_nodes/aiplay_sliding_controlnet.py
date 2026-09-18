"""
AIPLAY sliding ControlNet — a core ControlNet that follows AnimateDiff's window.

WHY THIS EXISTS. ComfyUI-AnimateDiff-Evolved samples a long clip through a
sliding context window (16 frames at a time). Before each window it calls
prepare_control_objects() on every ControlNet in the conditioning and REFUSES
one that has no `sub_idxs` attribute (animatediff/sampling.py), pointing at
ComfyUI-Advanced-ControlNet — which is GPL-3.0 and cannot ship inside an
Apache-2.0 app. For a ControlNet that HAS the attribute, the pack itself
writes the window's frame indices into `sub_idxs` and expects the control to
serve the hint for exactly those frames.

Core's ControlNet keeps one hint for the whole batch and broadcast_image_to()
truncates a longer hint to the first frames — so, unsliced, every window
would be steered by frames 0..15. This subclass keeps the whole-piece hint
aside and, when a window is announced, hands the base class only that
window's frames. Nothing else changes: the resize, the VAE path, the
timestep window and the strength are the base class's own.

Loader: AiplayControlNetLoaderSliding — the same file list as ControlNetLoader,
the same object, re-classed. Feed it to ControlNetApplyAdvanced as usual.
"""
import comfy.controlnet
import folder_paths


class SlidingControlNet(comfy.controlnet.ControlNet):
    # announced by AnimateDiff-Evolved per window; their presence is the contract
    sub_idxs = None
    full_latent_length = 0
    context_length = 0

    def set_cond_hint(self, cond_hint, *args, **kwargs):
        out = super().set_cond_hint(cond_hint, *args, **kwargs)
        self._full_hint = cond_hint
        self._window = None
        return out

    def get_control(self, x_noisy, t, cond, batched_number, transformer_options):
        idxs = self.sub_idxs
        full = getattr(self, "_full_hint", None)
        if idxs is not None and full is not None and full.shape[0] > 1:
            key = tuple(int(i) for i in idxs)
            if getattr(self, "_window", None) != key:
                keep = [i for i in key if i < full.shape[0]]
                self.cond_hint_original = full[keep] if keep else full[:1]
                if self.cond_hint is not None:
                    del self.cond_hint
                self.cond_hint = None          # the base class resizes the window's frames afresh
                self._window = key
        return super().get_control(x_noisy, t, cond, batched_number, transformer_options)

    def copy(self):
        c = super().copy()
        c.__class__ = SlidingControlNet
        full = getattr(self, "_full_hint", None)
        c._full_hint = full
        c._window = None
        if full is not None:
            c.cond_hint_original = full
        c.sub_idxs = None
        c.full_latent_length = 0
        c.context_length = 0
        return c

    def cleanup(self):
        super().cleanup()
        self._window = None
        full = getattr(self, "_full_hint", None)
        if full is not None:
            self.cond_hint_original = full


class AiplayControlNetLoaderSliding:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"control_net_name": (folder_paths.get_filename_list("controlnet"),)}}

    RETURN_TYPES = ("CONTROL_NET",)
    FUNCTION = "load"
    CATEGORY = "AIPLAY/controlnet"

    def load(self, control_net_name):
        path = folder_paths.get_full_path_or_raise("controlnet", control_net_name)
        cn = comfy.controlnet.load_controlnet(path)
        if cn is None:
            raise RuntimeError(f"{control_net_name} did not load as a ControlNet")
        if type(cn) is comfy.controlnet.ControlNet:
            cn.__class__ = SlidingControlNet
            cn._full_hint = None
            cn._window = None
        else:
            raise RuntimeError(f"{control_net_name} loads as {type(cn).__name__}; only a full ControlNet is made sliding here")
        return (cn,)


NODE_CLASS_MAPPINGS = {"AiplayControlNetLoaderSliding": AiplayControlNetLoaderSliding}
NODE_DISPLAY_NAME_MAPPINGS = {"AiplayControlNetLoaderSliding": "AIPLAY ControlNet loader (sliding window)"}
