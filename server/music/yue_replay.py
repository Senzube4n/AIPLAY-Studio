"""Pinned artifact replay. Validation is CPU-only; execution uses the owned driver."""
import dataclasses
import hashlib
import importlib.metadata
import json
from pathlib import Path
import time

VERSION = "0.1.6"
RUNTIME_SHA256 = "17963197ec6c7a87f7519cda132ad70c9843acecf65eeb0d58e41506a744b3ed"
STAGES = {"plan": ["semantic", "synthesis", "decode"], "semantic": ["synthesis", "decode"], "latent": ["decode"]}
REQUIRED = {"result.json", "audio.flac", "request.json", "config.json", "plan.json", "plan_manifest.json",
            "abc_tokens.npy", "prefix.npy", "semantic.npy", "latent.npy"}


def file_hash(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_manifest(manifest_path, expected_hash, source_dir, stage, check_runtime=True):
    """Run before torch/model loading; verify every prepared byte again at execution."""
    file = Path(manifest_path)
    if file.is_symlink() or file_hash(file) != expected_hash:
        raise ValueError("Prepared artifact replay manifest changed")
    manifest = json.loads(file.read_text(encoding="utf-8"))
    source = Path(source_dir)
    if source.is_symlink() or source.resolve() != Path(manifest["sourceDir"]).resolve():
        raise ValueError("Prepared artifact replay source changed")
    if manifest.get("v") != 1 or stage not in STAGES or manifest["stage"] != stage:
        raise ValueError("Unsupported artifact replay stage")
    saved = manifest["source"]
    if saved["runtime"] != {"package": "yue2-infer", "version": VERSION, "sha256": RUNTIME_SHA256}:
        raise ValueError("Artifact replay runtime is not the reviewed version")
    if check_runtime:
        if importlib.metadata.version("yue2-infer") != VERSION:
            raise ValueError("Artifact replay requires yue2-infer 0.1.6")
        package = Path(importlib.metadata.distribution("yue2-infer").locate_file("yue2"))
        hashes = {p.name: file_hash(p) for p in sorted(package.glob("*.py"))}
        actual = hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        if actual != RUNTIME_SHA256:
            raise ValueError("Installed YuE2 source differs from the reviewed runtime")
    if not REQUIRED <= saved["files"].keys():
        raise ValueError("Incomplete prepared artifact set")
    for name, expected in saved["files"].items():
        artifact = source / name
        if Path(name).name != name or name in {".", ".."} or artifact.is_symlink():
            raise ValueError("Invalid prepared artifact path")
        if not artifact.is_file() or artifact.stat().st_size != expected["bytes"] or file_hash(artifact) != expected["sha256"]:
            raise ValueError("Saved artifact changed before execution: " + name)
    receipt = json.loads((source / "result.json").read_text(encoding="utf-8"))
    if receipt.get("status") != "complete" or receipt["identity"] != saved["identity"] or receipt["weights"] != saved["weights"]:
        raise ValueError("Source result identity changed")
    if saved["config"]["runtime_sha256"] != RUNTIME_SHA256:
        raise ValueError("Source runtime is incompatible")
    # np.load never unpickles code. Shape, type and finite-value checks happen
    # before constructing the pipeline, rather than after loading model weights.
    import numpy as np
    tokens = np.load(source / "semantic.npy", allow_pickle=False)
    latents = np.load(source / "latent.npy", allow_pickle=False)
    if tokens.ndim != 1 or tokens.dtype.kind not in "iu" or len(tokens) == 0 or len(tokens) > 90000 or (tokens < 0).any() or (tokens >= 32768).any():
        raise ValueError("Invalid saved semantic tokens")
    if latents.ndim != 2 or latents.shape != (len(tokens), 64) or latents.dtype.kind != "f" or not np.isfinite(latents).all():
        raise ValueError("Invalid saved acoustic latents; expected finite [semantic frames,64]")
    return {**manifest, "manifestSha256": expected_hash}, tokens, latents


def replay(pipe, prepared, request, *, cancelled=None):
    """Return a native SongResult without invoking skipped stages."""
    from yue2.pipeline import SymbolicPlan, SemanticResult, SongResult
    from yue2.protocol import GenerationConfig
    from yue2.storage import identity
    manifest, tokens, saved_latents = prepared
    source = manifest["source"]
    stage = manifest["stage"]
    options = manifest["options"]
    if pipe.runtime_sha256 != RUNTIME_SHA256 or pipe.weights != source["weights"]:
        raise ValueError("Verified runtime/model/VAE identities do not match the replay source")
    for key in ("style", "lyrics", "cot", "abc", "cfg_scale"):
        if request.get(key) != source["request"].get(key):
            raise ValueError("Artifact replay cannot change the frozen " + key)
    if request.get("seed", source["request"]["seed"]) != options["seed"]:
        raise ValueError("The replay seed differs from the prepared seed")
    if stage == "latent" and options["seed"] != source["request"]["seed"]:
        raise ValueError("Latent decoding cannot change the seed")
    def check_cancel():
        if cancelled is not None and cancelled():
            raise InterruptedError("Artifact replay cancelled before the next stage")
    check_cancel()
    plan = SymbolicPlan.load(manifest["sourceDir"])
    plan = dataclasses.replace(plan, request=dataclasses.replace(plan.request, seed=options["seed"], id=request.get("id", plan.request.id)),
                               timing={"seconds": 0.0, "reused": True})
    pipe.generation_config = dataclasses.replace(GenerationConfig.from_dict(source["config"]["generation"]), ode_steps=options["narSteps"])
    pipe.vae_core_frames = options["vaeCoreFrames"]
    config = pipe.effective_config(plan.request)
    ran = []
    reuse = {"stage": stage, "sourceIdentity": source["identity"], "manifestSha256": manifest["manifestSha256"],
             "sourceFiles": source["files"], "stagesRun": ran, "runtime": source["runtime"]}
    config["artifact_replay"] = reuse
    start = time.perf_counter()
    if stage == "plan":
        semantic = pipe.generate_semantic(plan, cancelled=cancelled)
        ran.append("semantic")
    else:
        semantic = SemanticResult(plan, tokens.tolist(), {"seconds": 0.0, "reused": True}, bool(source["truncated"].get("semantic")))
    check_cancel()
    nar_start = time.perf_counter()
    latents = saved_latents if stage == "latent" else pipe.synthesize(semantic, cancelled=cancelled)
    if stage != "latent":
        ran.append("synthesis")
    nar_seconds = 0.0 if stage == "latent" else time.perf_counter() - nar_start
    check_cancel()
    vae_start = time.perf_counter()
    audio = pipe.decode(latents)
    ran.append("decode")
    reuse["loadedAfterDecode"] = {"mot": getattr(pipe, "_model", None) is not None,
                                 "vae": getattr(pipe, "_vae", None) is not None}
    check_cancel()
    timing = {"abc": plan.timing, "semantic": semantic.timing, "nar_seconds": nar_seconds,
              "vae_seconds": time.perf_counter() - vae_start, "load": dict(pipe.load_timing),
              "e2e_seconds": time.perf_counter() - start, "stages_run": ran}
    request_identity = identity({"request": plan.request.to_dict(), "config": config, "weights": pipe.weights, "artifact_replay": reuse})
    return SongResult(audio, 48000, semantic, latents, config, pipe.weights, timing, request_identity), reuse
