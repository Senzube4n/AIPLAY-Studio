"""
The 3D driver — the far side of the second door.

WHAT THIS IS
------------
`server/mesh/runner.js` spawns this file with the MESH VENV's python, never with
the engine's and never with the system one. It reads one picture, writes one
.glb, and optionally rigs it. It prints exactly one machine-readable line:

    MESH_RESULT_JSON:{...}

and nothing else on stdout that matters. The Node side brace-matches the object
after that marker rather than taking the rest of the line, because a library
that prints its own progress shares this pipe — see runPreviz() in
server/mv/blender.js for the measured failure that rule comes from.

Exit codes, deliberately the same vocabulary the previz toolkit uses so there is
one to learn:

    0   done, and the result line was printed
    2   REFUSED — a rule this file enforces. The reason is on stderr and is
        meant to be read.
    3   the run itself failed.

WHY IT IS A SEPARATE INTERPRETER
--------------------------------
Not a licence boundary. TripoSG and UniRig are MIT for code AND weights, which
is exactly why they were chosen, so this file is an ordinary member of an
Apache-2.0 repository and may import them freely.

It is a VERSION boundary. TripoSG is a diffusers pipeline that wants a modern
diffusers; the engine's interpreter is pinned at diffusers 0.7.0.dev0 because
the music model's fused kernels exist only there. Installing this stack into
that environment does not fail — it succeeds, and the owner's next song render
dies hours later somewhere that says nothing about a mesh. So: its own venv, and
nothing in the Node tree ever imports this file.

═══ WHAT THIS FILE LEARNED BY BEING RUN ═════════════════════════════════════

The first draft was written from the two projects' documentation while the venv
was still being built, and it says so at the bottom. Every one of the following
was wrong in a way a reading could not have caught, and each is now written the
way the machine actually needs it:

  1. THE PIPELINE'S RETURN VALUE. It was read as `result.meshes[0]` and exported
     with trimesh's writer. TripoSGPipeline returns `.samples`, and each sample
     is a bare `(vertices, faces)` pair, not a mesh object — so the documented
     line raised AttributeError before a single triangle existed.

  2. THE DECODER. `use_flash_decoder` defaults to TRUE and pulls in `diso`,
     which is source-only and needs MSVC. This box has nvcc 12.1 and no cl.exe
     at all, so the flash path cannot be built here. It is passed FALSE
     explicitly and the mesh comes out of the hierarchical marching-cubes
     decoder. That is a real difference from the paper's pipeline, and it is
     reported in the result line as `decoder` rather than hidden.

  3. THE ALPHA. `Image.open(x).convert("RGB")` throws away the one channel that
     decides which branch runs. TripoSG's own `prepare_image()` calls a
     background-removal network (briaai/RMBG-1.4 — a weight nobody approved
     downloading, fetched from the internet by an otherwise entirely local
     pipeline) UNLESS the input already carries a valid alpha. So a matte is
     keyed here and `rmbg_net=None` is passed: the download cannot happen,
     rather than being asked not to. See matte().

  4. THE RIG. `from unirig.inference import rig_glb` was invented. UniRig ships
     no `unirig` package and no `rig_glb`; it is driven by `run.py` against the
     YAML under `configs/`. More to the point it cannot run on this machine at
     with the current runtime. See rig_probe() for measured prerequisites;
     unirig_adapter.py contains the actual isolated upstream invocation.
"""

import argparse
import json
import os
import sys
import time

MARKER = "MESH_RESULT_JSON:"


class Refused(Exception):
    """A rule this file enforces. Exit 2, reason on stderr, nothing spent."""


def _say(obj):
    """The one line the Node side reads. Flushed, because stdout is shared."""
    sys.stdout.write(MARKER + json.dumps(obj) + "\n")
    sys.stdout.flush()


def _log(msg):
    """Progress goes to stderr, so it can never be mistaken for the result."""
    sys.stderr.write("[mesh] %s\n" % msg)
    sys.stderr.flush()


def _checkout(var):
    """
    One checkout's directory, from the environment.

    Handed in by the Node side rather than discovered here: one place decides
    where these live (server/config.js), and a second opinion in a python file
    is how the app and its driver end up looking in different folders.
    """
    d = os.environ.get(var)
    return d if d and os.path.isdir(d) else None


def _add_triposg():
    """
    TripoSG on sys.path — BOTH the repo and its scripts/ folder.

    scripts/ is not packaging noise: `image_process.prepare_image` lives there
    and is the only correct way to feed this pipeline.
    """
    d = _checkout("AIPLAY_TRIPOSG")
    if not d:
        raise Refused("The TripoSG checkout was not handed in (AIPLAY_TRIPOSG).")
    for p in (d, os.path.join(d, "scripts")):
        if p not in sys.path:
            sys.path.insert(0, p)
    # ⚠ APPENDED, NOT PREPENDED. shims/ holds one file — a `diso` whose DiffDMC
    # raises — and it exists because TripoSG imports that extension at module
    # scope while only ever instantiating it on the flash-decoder path this
    # machine cannot build. Appending means a machine that HAS the real
    # extension finds the real one first; the shim is a floor, not an override.
    # It ships beside this file rather than living in somebody's venv, so the
    # constraint is visible in the tree that depends on it.
    shims = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shims")
    if os.path.isdir(shims) and shims not in sys.path:
        sys.path.append(shims)
    return d


def _weights_dir():
    d = os.environ.get("AIPLAY_MESH_WEIGHTS")
    if not d or not os.path.isdir(d):
        raise Refused(
            "The mesh weights folder was not handed in or does not exist: %r. "
            "The Node side sets AIPLAY_MESH_WEIGHTS from config.mesh.weights." % (d,)
        )
    return d


def _triposg_weights():
    root = _weights_dir()
    for name in ("TripoSG", "triposg"):
        d = os.path.join(root, name)
        if os.path.isdir(d):
            return d
    raise Refused("No TripoSG weights under %s." % root)


# ───────────────────────────────────────────────────────────────── the matte

def matte(src, dst):
    """
    Give the picture an alpha channel, and SAY WHAT THE MATTE DID.

    ⚠ WHY THIS EXISTS. prepare_image() takes one of two branches: an input
    carrying a valid alpha (at least 1% fully transparent AND at least 1% fully
    opaque) is composited against the background colour; anything else goes to
    the background-removal network. Keying the matte here means that branch is
    never reached.

    ⚠ AND IT IS A HEURISTIC, NOT A SEGMENTER. Otsu on luminance, largest
    connected component, and a cut for the ground reflection —
    which works on a lit subject against a dark ground and will not work on a
    subject darker than what is behind it. Every number it used goes into the
    result line, so a bad matte is visible in the record rather than inferred
    later from a bad mesh. An input that already has a usable alpha skips it.

    Returns (stats, the path actually handed to the pipeline).
    """
    import cv2
    import numpy as np

    img = cv2.imread(src, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise Refused("The picture at %s could not be decoded." % src)
    stats = {"width": int(img.shape[1]), "height": int(img.shape[0]),
             "channels": int(img.shape[2]) if img.ndim == 3 else 1}

    if img.ndim == 3 and img.shape[2] == 4:
        a = img[:, :, 3]
        zero, full = float((a == 0).mean()), float((a == 255).mean())
        if zero >= 0.01 and full >= 0.01:
            stats.update({"source": "the picture's own alpha",
                          "alphaZeroPct": round(100 * zero, 2),
                          "alphaFullPct": round(100 * full, 2)})
            return stats, src
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
        stats["note"] = "the input had an alpha channel but not a usable matte, so one was keyed"

    h, w = img.shape[:2]
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    lum = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    thr, mask = cv2.threshold(lum, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    stats["otsu"] = float(thr)
    # Closing joined nearby feet; filling holes erased arm/torso openings.
    # Preserve the threshold's negative space. Cleanup belongs in an explicit
    # editable matte, not in the unseen input to image-to-3D.

    n, labels, cc, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if n <= 1:
        raise Refused("Nothing separated from the background in %s — no subject to build."
                      % os.path.basename(src))
    areas = cc[1:, cv2.CC_STAT_AREA]
    mask = (labels == 1 + int(np.argmax(areas))).astype(np.uint8) * 255
    stats["components"] = int(n - 1)
    stats["largestPx"] = int(areas.max())
    stats["largestPctOfFrame"] = round(100.0 * float(areas.max()) / (w * h), 2)

    stats["preservesThresholdGaps"] = True

    # ── the ground reflection ────────────────────────────────────────────
    # A reflective floor is the same brightness as the feet standing on it, so
    # it joins the subject as ONE component and no threshold separates them.
    # WIDTH does: a standing body is narrow and a puddle of light is not. The
    # cut row is reported, because it takes some of the soles with it.
    ys, _ = np.where(mask > 0)
    y0f, y1f = int(ys.min()), int(ys.max())
    widths = (mask > 0).sum(axis=1)
    body = widths[y0f:y0f + int(0.75 * (y1f - y0f))]
    med = float(np.median(body[body > 0])) if (body > 0).any() else 0.0
    limit = 3.0 * med
    cut = None
    for y in range(y0f + int(0.70 * (y1f - y0f)), y1f + 1):
        if med and widths[y] > limit:
            cut = int(y)
            break
    stats["bodyMedianWidthPx"] = round(med, 1)
    stats["reflectionCutRow"] = cut
    if cut is not None:
        mask[cut:, :] = 0
        n2, lab2, cc2, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        if n2 > 1:
            a2 = cc2[1:, cv2.CC_STAT_AREA]
            mask = (lab2 == 1 + int(np.argmax(a2))).astype(np.uint8) * 255

    ys, xs = np.where(mask > 0)
    if not len(ys):
        raise Refused("The matte removed everything in %s." % os.path.basename(src))
    pad = 24
    x0, y0 = max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad)
    x1, y1 = min(w - 1, int(xs.max()) + pad), min(h - 1, int(ys.max()) + pad)
    out = np.dstack([img[y0:y1 + 1, x0:x1 + 1], mask[y0:y1 + 1, x0:x1 + 1]])
    cv2.imwrite(dst, out)

    a = out[:, :, 3]
    stats.update({
        "source": "keyed here from luminance (Otsu, largest component, gaps preserved)",
        "cropWidth": int(out.shape[1]), "cropHeight": int(out.shape[0]),
        "alphaZeroPct": round(100 * float((a == 0).mean()), 2),
        "alphaFullPct": round(100 * float((a == 255).mean()), 2),
    })
    if stats["alphaZeroPct"] < 1.0 or stats["alphaFullPct"] < 1.0:
        raise Refused(
            "The keyed matte is not a valid alpha (%.2f%% transparent, %.2f%% opaque; both must "
            "exceed 1%%). Rather than let TripoSG fall through to downloading a background-removal "
            "model nobody approved, this stopped. Supply a cut-out PNG with a real alpha channel."
            % (stats["alphaZeroPct"], stats["alphaFullPct"]))
    return stats, dst


# ──────────────────────────────────────────────────────────────── the mesh

def mesh_from_image(image, out, seed, steps, guidance, offload):
    """
    One picture in, one .glb out.

    Imports are INSIDE the function on purpose: `--selftest` below must run
    under any python, so the argument surface can be proven on a machine where
    the venv does not exist yet.
    """
    _add_triposg()
    import numpy as np
    import torch
    import trimesh
    from triposg.pipelines.pipeline_triposg import TripoSGPipeline
    from image_process import prepare_image

    model_dir = _triposg_weights()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cpu":
        # Not a refusal: it will be slow and it will work, and refusing a
        # machine because it is slow is a decision for the person, not for this.
        _log("no CUDA device — running on the CPU, which is very slow.")

    t0 = time.time()
    pipe = TripoSGPipeline.from_pretrained(model_dir)
    if device == "cuda" and offload:
        # ⚠ THE OWNER'S ENGINE LIVES ON THIS CARD. Offload keeps one module
        # resident instead of three, which is the difference between needing the
        # whole card and needing a corner of it. TripoSGPipeline predates
        # diffusers' `model_cpu_offload_seq`, so the order is declared here: the
        # image encoder once, the transformer per step, the VAE at the end.
        pipe.to(dtype=torch.float16)
        pipe.model_cpu_offload_seq = "image_encoder_dinov2->transformer->vae"
        pipe.enable_model_cpu_offload()
    elif device == "cuda":
        pipe.to("cuda", torch.float16)
    t_load = time.time() - t0
    _log("weights loaded in %.1fs (offload=%s)" % (t_load, bool(offload and device == "cuda")))

    t1 = time.time()
    matte_stats, matted = matte(image, os.path.splitext(os.path.abspath(out))[0] + "_matte.png")
    img = prepare_image(matted, bg_color=np.array([1.0, 1.0, 1.0]), rmbg_net=None)
    t_prep = time.time() - t1
    _log("matte + prepare in %.1fs -> %s" % (t_prep, getattr(img, "size", "?")))

    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    t2 = time.time()
    with torch.no_grad():
        sample = pipe(
            image=img,
            generator=torch.Generator(device=device).manual_seed(int(seed)),
            num_inference_steps=int(steps),
            guidance_scale=float(guidance),
            # ⚠ FALSE ON PURPOSE — see item 2 in the header.
            use_flash_decoder=False,
        ).samples[0]
    t_sample = time.time() - t2
    peak = (torch.cuda.max_memory_allocated() / 2 ** 20) if device == "cuda" else None

    # `sample` is (vertices, faces) — bare arrays, not a mesh object.
    mesh = trimesh.Trimesh(sample[0].astype(np.float32), np.ascontiguousarray(sample[1]))
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    mesh.export(out)
    _log("wrote %s (%d verts, %d faces)" % (out, len(mesh.vertices), len(mesh.faces)))

    # Release before anything else runs in this process — one 16 GB card.
    del pipe
    if device == "cuda":
        torch.cuda.empty_cache()

    return {
        "loadSeconds": round(t_load, 3),
        "prepareSeconds": round(t_prep, 3),
        "sampleSeconds": round(t_sample, 3),
        "device": device,
        "offload": bool(offload and device == "cuda"),
        "steps": int(steps), "seed": int(seed), "guidance": float(guidance),
        "decoder": "hierarchical marching cubes (use_flash_decoder=False; diso needs MSVC)",
        "peakVramMiB": round(peak) if peak is not None else None,
        "vertices": int(len(mesh.vertices)), "faces": int(len(mesh.faces)),
        "watertight": bool(mesh.is_watertight),
        "matte": matte_stats,
    }


# ───────────────────────────────────────────────────────────────── the rig

def _unirig_call(arguments):
    """Use a separate configured interpreter; never install into the mesh venv."""
    import subprocess
    from unirig_adapter import MARKER, offline_env
    python = os.environ.get("AIPLAY_UNIRIG_PYTHON") or sys.executable
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "unirig_adapter.py")
    result = subprocess.run([python, "-u", script, *arguments], env=offline_env(),
                            capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.stderr:
        sys.stderr.write(result.stderr)
    if result.returncode:
        detail = (result.stderr or result.stdout)[-12000:]
        if result.returncode == 2:
            raise Refused(detail)
        raise RuntimeError("UniRig adapter exited %s: %s" % (result.returncode, detail))
    for line in reversed(result.stdout.splitlines()):
        if line.startswith(MARKER):
            return json.loads(line[len(MARKER):])
    raise RuntimeError("UniRig adapter finished without a result")


def rig_probe():
    """Measured imports/local prerequisites, explicitly not a GPU validation."""
    return _unirig_call(["--probe"])


def rig(glb_in, out, seed=42):
    """Run upstream extraction, skeleton, skinning and merge in private staging."""
    return _unirig_call(["--input", os.path.abspath(glb_in), "--output", os.path.abspath(out),
                         "--seed", str(seed)])


def main(argv=None):
    ap = argparse.ArgumentParser(description="AIPLAY Studio mesh driver (image to GLB, optional rig).")
    ap.add_argument("--image", help="one .png/.jpg/.webp — ONE panel of ONE subject")
    ap.add_argument("--out", required=False, help="where to write the .glb")
    ap.add_argument("--glb", help="an existing .glb, with --rig-only")
    ap.add_argument("--rig", action="store_true", help="rig the mesh after generating it")
    ap.add_argument("--rig-only", action="store_true", help="rig --glb and write --out; generate nothing")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--steps", type=int, default=50)
    ap.add_argument("--guidance", type=float, default=7.0)
    ap.add_argument("--offload", action="store_true",
                    help="page modules in one at a time — a corner of the card instead of the "
                         "whole of it, and the owner's engine is resident on this one")
    ap.add_argument("--rig-probe", action="store_true",
                    help="measure the configured UniRig runtime prerequisites without loading model weights")
    ap.add_argument("--selftest", action="store_true",
                    help="prove the argument surface and the result line without importing "
                         "torch — runs under any python, and is what the Node test drives")
    a = ap.parse_args(argv)

    if a.selftest:
        _say({"ok": True, "selftest": True, "timings": {"loadSeconds": 0, "sampleSeconds": 0},
              "note": "no model was loaded; this proves the marker and the exit code only"})
        return 0

    try:
        if a.rig_probe:
            _say({"ok": True, "probe": rig_probe()})
            return 0

        if a.rig_only:
            if not a.glb or not a.out:
                raise Refused("--rig-only needs --glb and --out.")
            timings = rig(a.glb, a.out, a.seed)
            _say({"ok": True, "out": a.out, "rigged": True, "timings": timings})
            return 0

        if not a.image or not a.out:
            raise Refused("Generating a mesh needs --image and --out.")
        timings = mesh_from_image(a.image, a.out, a.seed, a.steps, a.guidance, a.offload)
        rigged = False
        if a.rig:
            timings.update(rig(a.out, a.out, a.seed))
            rigged = True
        _say({"ok": True, "out": a.out, "rigged": rigged, "timings": timings})
        return 0
    except Refused as e:
        sys.stderr.write("REFUSED: %s\n" % e)
        return 2
    except Exception:                      # noqa: BLE001 — the traceback IS the answer
        import traceback
        traceback.print_exc()
        return 3


if __name__ == "__main__":
    sys.exit(main())
