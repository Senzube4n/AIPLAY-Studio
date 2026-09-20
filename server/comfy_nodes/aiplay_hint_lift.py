"""
AIPLAY hint lift — open the bottom of the range for the preprocessors ONLY.

⚠ WHY THIS NODE EXISTS, AND WHAT IT IS NOT FOR.

The Motion look sends the source clip down two branches: one to the sampler,
which paints it, and one to the depth and line-art preprocessors, which are
supposed to tell the sampler where the figure is. On a dark clip the second
branch is handed almost nothing. Measured on a real Hex Appeal dance frame
(512x293, the clip `aiplay_zoom_s1_24.mp4`, frame 24):

    83.5% of the frame sits below luminance 0.05
    93.6% below 0.10
    the FIGURE's own column averages 0.068, 95th percentile 0.195

so the dancer lives inside the bottom five per cent of an eight-bit range, where
the gradients a depth estimator keys on have already been quantised away. The
owner's report was that "the shape of the dancer is more visible" in the
reference video and that ours needed "a better depth mapping perhaps", and that
reading is right: the estimator is not weak, it is blind.

⚠ A GLOBAL STRETCH DOES NOT FIX THIS AND I MEASURED THAT FIRST. Autocontrast is
the obvious reach and it does nearly nothing here, because the frame's maximum is
already 0.949 — there is no headroom to take, the darkness is not a scaling
problem. What the figure needs is the bottom of the curve opened, which is a
gamma. Edge energy inside the figure column, the quantity the estimator reads:

    gamma   1.0    1.4    1.8    2.2    2.6    3.0
    dark    9.32  13.13  16.74  20.10  23.16  25.91
    lit    17.92  21.22  22.90  23.66  23.98  24.04

The number keeps climbing, and the number is not the whole story: above about
2.4 the h.264 blocking in the background comes up out of the black with it, and
a line-art preprocessor traces a compression block as happily as it traces an
arm. 2.2 is where the figure is readable and the codec is still buried, so 2.2
is the default and the ceiling is 4 for someone rendering from a clean source.

⚠ IT MUST NOT BE PUT ON THE SAMPLER'S BRANCH. The lift is a lie told to the
preprocessors on purpose; the frames that get painted keep their own blacks. Wire
this between the source and the depth/line-art nodes and nowhere else. A graph
that lifts what the sampler sees will come back washed out, and the fault will
look like the model's.

Gamma 1.0 returns the input untouched, which is what every piece rendered before
2026-09-20 had, so a graph at 1.0 is byte-identical to the old one.
"""

import torch


class AiplayHintLift:
    """Raise a batch of images by 1/gamma, for a preprocessor's eyes only."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "gamma": ("FLOAT", {
                    "default": 2.2, "min": 1.0, "max": 4.0, "step": 0.05,
                    "tooltip": "1.0 is off and returns the frames untouched. 2.2 is the measured default: "
                               "on a near-black dance clip it multiplies the edge energy inside the figure "
                               "by 2.2 without bringing the compression blocking up with it.",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "lift"
    CATEGORY = "AIPLAY"
    DESCRIPTION = ("Opens the bottom of the range so a depth or line-art preprocessor can see a figure in a "
                   "dark clip. Feed the preprocessors from this, never the sampler.")

    def lift(self, image, gamma):
        g = float(gamma)
        if not (g > 0):
            raise ValueError(f"AiplayHintLift: gamma must be positive — got {gamma}.")
        if abs(g - 1.0) < 1e-6:
            return (image,)
        # clamp first: a batch that arrives with values a hair outside [0,1]
        # (an upstream resize can do it) would otherwise produce NaN under a
        # fractional power, and a NaN hint silently becomes a blank control.
        x = torch.clamp(image, 0.0, 1.0)
        return (torch.pow(x, 1.0 / g),)


NODE_CLASS_MAPPINGS = {"AiplayHintLift": AiplayHintLift}
NODE_DISPLAY_NAME_MAPPINGS = {"AiplayHintLift": "AIPLAY hint lift (for depth and line art)"}
