"""Bundled, offline H3 control preprocessors. Importing this package loads no model."""
from .nodes import AiplayH3DepthGuide, AiplayH3PoseGuide
from .full_control_patch import AiplayH3FullControlPatchLoader

NODE_CLASS_MAPPINGS = {
    "AiplayH3DepthGuide": AiplayH3DepthGuide,
    "AiplayH3PoseGuide": AiplayH3PoseGuide,
    "AiplayH3FullControlPatchLoader": AiplayH3FullControlPatchLoader,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AiplayH3DepthGuide": "AIPLAY H3 Depth Guide (Small)",
    "AiplayH3PoseGuide": "AIPLAY H3 Pose Guide (TorchScript)",
    "AiplayH3FullControlPatchLoader": "AIPLAY H3 Full-Width Control Patch",
}
