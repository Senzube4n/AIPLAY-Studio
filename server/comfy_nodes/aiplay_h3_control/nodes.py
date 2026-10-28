"""Offline depth/pose guides; no third-party annotator installation is required.

The architecture and TorchScript inference subset is attributed in NOTICE and
SOURCES.json. No model is downloaded, imported or loaded during node discovery.
"""
import colorsys
from pathlib import Path

import cv2
import numpy as np
import torch

DEPTH_NAME = "depth_anything_v2_vits.pth"
DETECTOR_NAME = "yolox_l.torchscript.pt"
POSE_NAME = "dw-ll_ucoco_384_bs5.torchscript.pt"
WEIGHTS = {
    DEPTH_NAME: ("depth-anything/Depth-Anything-V2-Small", 99218434),
    DETECTOR_NAME: ("hr16/yolox-onnx", 217697649),
    POSE_NAME: ("hr16/DWPose-TorchScript-BatchSize5", 135059124),
}


def model_path(name):
    """Resolve only the three catalogue filenames, never an arbitrary API path."""
    if name not in WEIGHTS:
        raise ValueError("Choose a supported H3 guide model from Models.")
    import folder_paths
    relative, expected_bytes = WEIGHTS[name]
    # The catalogue installs fresh weights in this model subfolder. Older
    # installations retain the exact controlnet_aux ckpt layout.
    roots = [Path(p) / "aiplay_preprocessors"
             for p in folder_paths.get_folder_paths("controlnet")]
    roots.append(Path(folder_paths.base_path) / "custom_nodes/comfyui_controlnet_aux/ckpts")
    for root in roots:
        candidate = root / relative / name
        if candidate.is_file() and candidate.stat().st_size == expected_bytes:
            return candidate
    raise FileNotFoundError(f"H3 guide model {name} is missing or incomplete. Install it from Studio Models; this node never downloads files.")


def model_fingerprint(names):
    return tuple((str(p), p.stat().st_size, p.stat().st_mtime_ns)
                 for p in (model_path(name) for name in names))


def canvas(images, resolution):
    if not isinstance(images, torch.Tensor) or images.ndim != 4 or images.shape[-1] not in (3, 4):
        raise ValueError("H3 guide images must be an RGB/RGBA image batch.")
    n, height, width, _ = images.shape
    if not (1 <= n <= 1024 and 1 <= height <= 8192 and 1 <= width <= 8192):
        raise ValueError("H3 guide image batch is empty or outside the supported size.")
    if not isinstance(resolution, int) or not 64 <= resolution <= 2048:
        raise ValueError("H3 guide resolution must be between 64 and 2048.")
    scale = resolution / min(height, width)
    w, h = max(2, round(width * scale / 2) * 2), max(2, round(height * scale / 2) * 2)
    if w * h > 4096 * 4096:
        raise ValueError("H3 guide aspect ratio is too wide for this resolution.")
    return n, w, h


def rgb_frame(image, width, height):
    frame = image[..., :3].detach().to(device="cpu", dtype=torch.float32).numpy()
    if not np.isfinite(frame).all():
        raise ValueError("H3 guide input contains non-finite pixels.")
    frame = (np.clip(frame, 0, 1) * 255).round().astype(np.uint8)
    return cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)


def normalize_depth(depth):
    depth = np.asarray(depth, dtype=np.float32)
    if depth.ndim != 2 or not np.isfinite(depth).all():
        raise ValueError("Depth estimator returned invalid pixels.")
    low, high = float(depth.min()), float(depth.max())
    if high - low <= np.finfo(np.float32).eps:
        return np.zeros_like(depth, dtype=np.uint8)
    return np.clip((depth - low) * (255.0 / (high - low)), 0, 255).astype(np.uint8)


def _depth_model(path, device):
    from .depth_dpt import DepthAnythingV2
    model = DepthAnythingV2(encoder="vits", features=64, out_channels=[48, 96, 192, 384])
    model.load_state_dict(torch.load(str(path), map_location="cpu", weights_only=True), strict=True)
    return model.eval().to(device=device, dtype=torch.float32)


def _pose_models(detector, pose, device):
    # Explicit TorchScript only. No ONNX provider or dependency is imported.
    return (torch.jit.load(str(detector), map_location="cpu").eval().to(device),
            torch.jit.load(str(pose), map_location="cpu").eval().to(device))


def _runtime():
    import comfy.model_management as mm
    import comfy.utils
    return mm, comfy.utils


def _release(models, mm):
    for model in models:
        if model is not None:
            model.to("cpu")
    mm.soft_empty_cache()


class AiplayH3DepthGuide:
    CATEGORY = "AIPLAY/video control"
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "execute"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "model_name": ([DEPTH_NAME],),
                "resolution": ("INT", {"default": 512, "min": 64, "max": 2048, "step": 64})}}

    @classmethod
    def IS_CHANGED(cls, model_name=DEPTH_NAME, **_kwargs):
        return model_fingerprint([model_name])

    def execute(self, images, model_name=DEPTH_NAME, resolution=512):
        n, width, height = canvas(images, resolution)
        path = model_path(model_name)
        mm, utils = _runtime()
        model = None
        output = torch.empty((n, height, width, 3), dtype=torch.float32, device="cpu")
        try:
            model = _depth_model(path, mm.get_torch_device())
            progress = utils.ProgressBar(n)
            with torch.inference_mode():
                for index in range(n):
                    mm.throw_exception_if_processing_interrupted()
                    frame = rgb_frame(images[index], width, height)
                    depth = model.infer_image(cv2.cvtColor(frame, cv2.COLOR_RGB2BGR), input_size=518, max_depth=1)
                    guide = normalize_depth(depth)
                    guide = cv2.resize(guide, (width, height), interpolation=cv2.INTER_CUBIC)
                    output[index] = torch.from_numpy(np.repeat(guide[..., None], 3, axis=-1).astype(np.float32) / 255)
                    progress.update(1)
            return (output,)
        finally:
            _release([model], mm)


# COCO-WholeBody indices and standard pose-guide topology. This renderer is
# newly written with OpenCV; it does not import the CMU/OpenPose drawing code.
BODY_LIMBS = ((1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7),
              (1, 8), (8, 9), (9, 10), (1, 11), (11, 12), (12, 13),
              (1, 0), (0, 14), (14, 16), (0, 15), (15, 17))
BODY_COCO = (0, None, 6, 8, 10, 5, 7, 9, 12, 14, 16, 11, 13, 15, 2, 1, 4, 3)
HAND_LIMBS = tuple((0 if j == 0 else 1 + finger * 4 + j - 1, 1 + finger * 4 + j)
                   for finger in range(5) for j in range(4))


def _color(index, count):
    return tuple(round(x * 255) for x in colorsys.hsv_to_rgb(index / count, 1, 1))


def draw_pose(keypoints, scores, width, height, threshold=0.3):
    points, confidence = np.asarray(keypoints), np.asarray(scores)
    if points.ndim != 3 or points.shape[1:] != (133, 2) or confidence.shape != points.shape[:2]:
        raise ValueError("TorchScript pose output does not match COCO-WholeBody133.")
    if not np.isfinite(points).all() or not np.isfinite(confidence).all():
        raise ValueError("TorchScript pose output contains non-finite values.")
    image = np.zeros((height, width, 3), dtype=np.uint8)
    radius = max(1, round(min(width, height) / 192))
    def dot(point, color):
        cv2.circle(image, tuple(np.rint(point).astype(int)), radius, color, -1, cv2.LINE_AA)
    def line(a, b, color):
        cv2.line(image, tuple(np.rint(a).astype(int)), tuple(np.rint(b).astype(int)), color, max(1, radius), cv2.LINE_AA)
    for person, score in zip(points, confidence):
        body = np.zeros((18, 2), dtype=np.float32)
        body_score = np.zeros(18, dtype=np.float32)
        for index, coco in enumerate(BODY_COCO):
            if coco is not None:
                body[index], body_score[index] = person[coco], score[coco]
        body[1] = (person[5] + person[6]) / 2
        body_score[1] = min(score[5], score[6])
        for index, (a, b) in enumerate(BODY_LIMBS):
            if body_score[a] >= threshold and body_score[b] >= threshold:
                line(body[a], body[b], _color(index, 18))
        for index in range(18):
            if body_score[index] >= threshold:
                dot(body[index], _color(index, 18))
        for start in (91, 112):
            for index, (a, b) in enumerate(HAND_LIMBS):
                if score[start + a] >= threshold and score[start + b] >= threshold:
                    line(person[start + a], person[start + b], _color(index, 20))
            for index in range(start, start + 21):
                if score[index] >= threshold:
                    dot(person[index], (0, 0, 255))
        for index in range(23, 91):
            if score[index] >= threshold:
                dot(person[index], (255, 255, 255))
    return image


class AiplayH3PoseGuide:
    CATEGORY = "AIPLAY/video control"
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "execute"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "detector_name": ([DETECTOR_NAME],),
                "pose_name": ([POSE_NAME],), "resolution": ("INT", {"default": 512, "min": 64, "max": 2048, "step": 64})}}

    @classmethod
    def IS_CHANGED(cls, detector_name=DETECTOR_NAME, pose_name=POSE_NAME, **_kwargs):
        return model_fingerprint([detector_name, pose_name])

    def execute(self, images, detector_name=DETECTOR_NAME, pose_name=POSE_NAME, resolution=512):
        n, width, height = canvas(images, resolution)
        detector_path, pose_path = model_path(detector_name), model_path(pose_name)
        mm, utils = _runtime()
        detector = pose = None
        output = torch.zeros((n, height, width, 3), dtype=torch.float32, device="cpu")
        visible_frames = 0
        try:
            from .pose_jit_det import inference_detector
            from .pose_jit_pose import inference_pose
            detector, pose = _pose_models(detector_path, pose_path, mm.get_torch_device())
            progress = utils.ProgressBar(n)
            with torch.inference_mode():
                for index in range(n):
                    mm.throw_exception_if_processing_interrupted()
                    frame = rgb_frame(images[index], width, height)
                    bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
                    boxes = inference_detector(detector, bgr, detect_classes=[0])
                    if boxes is not None and len(boxes):
                        # At most five people per inference chunk, matching the
                        # existing fixed-batch TorchScript conversion.
                        all_points, all_scores = [], []
                        for start in range(0, len(boxes), 5):
                            points, scores = inference_pose(pose, boxes[start:start + 5], bgr, model_input_size=(288, 384))
                            all_points.extend(points)
                            all_scores.extend(scores)
                        guide = draw_pose(np.asarray(all_points), np.asarray(all_scores), width, height)
                        if guide.any():
                            visible_frames += 1
                        output[index] = torch.from_numpy(guide.astype(np.float32) / 255)
                    progress.update(1)
            if visible_frames == 0:
                raise ValueError("Pose guide found no visible person. Choose Depth for this clip or use a clearer view of the person.")
            if visible_frames != n:
                print(f"AIPLAY H3 pose guide: {n - visible_frames} of {n} frames have no visible skeleton.")
            return (output,)
        finally:
            _release([detector, pose], mm)
