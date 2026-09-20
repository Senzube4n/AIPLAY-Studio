"""THE TRAINING LOSS AS NUMBERS, BECAUSE A PICTURE CANNOT BE ASSERTED ON.

ComfyUI ships `LossGraphNode`, which draws the loss curve as a PNG and saves it.
That is the right thing for a person watching a training run and useless to a
harness asking the only question that matters early on — *is it learning?* —
because answering that from a rendered line graph means reading pixels.

`loss["loss"]` is already a plain list of floats. This writes it out as JSON
beside the run, so a probe can say "the loss fell from X to Y" and a lane can
fail when it does not.
"""

import json
import os

import folder_paths


class AiplaySaveLossJson:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "loss": ("LOSS_MAP", {"tooltip": "The loss map from TrainLoraNode."}),
                "filename_prefix": ("STRING", {"default": "loss"}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "AIPLAY"
    DESCRIPTION = ("Writes a training run's loss values to JSON so a harness can read them. "
                   "Use beside LossGraphNode, which draws the same numbers for a person.")

    def save(self, loss, filename_prefix):
        values = [float(v) for v in (loss or {}).get("loss", [])]
        out_dir = folder_paths.get_output_directory()
        os.makedirs(out_dir, exist_ok=True)

        # A fresh name per run: a probe that silently read the PREVIOUS run's
        # numbers would report yesterday's verdict with today's confidence.
        n = 0
        while True:
            name = f"{filename_prefix}_{n:05d}.json"
            path = os.path.join(out_dir, name)
            if not os.path.exists(path):
                break
            n += 1

        first = values[0] if values else None
        last = values[-1] if values else None
        payload = {
            "steps": len(values),
            "first": first,
            "last": last,
            # Stated rather than left to the reader: the whole point of the file.
            "fell": (first is not None and last is not None and last < first),
            "loss": values,
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        return {"ui": {"text": [name]}}


NODE_CLASS_MAPPINGS = {"AiplaySaveLossJson": AiplaySaveLossJson}
NODE_DISPLAY_NAME_MAPPINGS = {"AiplaySaveLossJson": "AIPLAY save loss as JSON"}
