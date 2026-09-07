#!/usr/bin/env python3
"""Score the H3 shift RE-sweep, and produce frames to look at.

The first sweep's numbers were not wrong so much as measured on the wrong
program — a graph that never loaded the turbo LoRA. This scores the re-run.

FOUR NUMBERS, and one contact sheet.

  loop_db   PSNR between the FIRST and LAST frame. The metric nobody uses and
            the one that decides whether a clip loops. Scored on its own terms,
            not against a reference.

  flicker   Mean absolute frame-to-frame delta. A clip can be sharp per frame and
            still boil; this is what catches that.

  detail    Variance of the Laplacian. ⚠ TREAT WITH SUSPICION. This metric once
            ranked a BROKEN render top — a 30-step no-LoRA run whose face was a
            smear scored 70.2 while the good one scored 88.8, and an even worse
            one scored higher still. High-frequency energy cannot tell texture
            from artefact. It is here to narrow down what to look at, never to
            decide.

  drift     Divergence between frame 0 and the middle frame. Distinguishes "it
            animates" from "it sat still", which loop_db alone cannot: a clip
            that never moves has a perfect loop score.

THE NOISE FLOOR COMES FIRST. Two seeds per shift bound how much difference means
nothing. A gap between shifts that is smaller than the gap between seeds at the
same shift is not a finding, and this prints them side by side so that cannot be
glossed over.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

# Windows consoles default to cp1252 and this script prints arrows and dashes.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

OUT = Path("D:/AI/aiplay-studio-bench/ComfyUI/output")
SWEEP = OUT / "_sweep"
FFMPEG = "C:/ffmpeg/bin/ffmpeg.exe"
W, H = 336, 192          # decode small: every metric here is scale-free enough


def frames(path: Path, w: int = W, h: int = H) -> np.ndarray:
    """Decode to greyscale via ffmpeg. No image library, no extra dependency."""
    cmd = [FFMPEG, "-v", "error", "-i", str(path),
           "-vf", f"scale={w}:{h}", "-pix_fmt", "gray", "-f", "rawvideo", "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    n = len(raw) // (w * h)
    if n == 0:
        raise RuntimeError(f"no frames decoded from {path.name}")
    return np.frombuffer(raw[: n * w * h], dtype=np.uint8).reshape(n, h, w).astype(np.float32)


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a - b) ** 2))
    return float("inf") if mse == 0 else 10 * np.log10(255.0**2 / mse)


def laplacian_var(f: np.ndarray) -> float:
    k = np.array([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=np.float32)
    p = np.pad(f, 1, mode="edge")
    out = sum(k[i, j] * p[i:i + f.shape[0], j:j + f.shape[1]]
              for i in range(3) for j in range(3) if k[i, j])
    return float(np.var(out))


def contact_sheet(path: Path, dst: Path, cols: int = 6) -> None:
    """Six frames across the clip, side by side. THE POINT OF THE WHOLE SCRIPT.

    Every metric above can be satisfied by something that looks wrong. The frames
    cannot. If the numbers and the sheet disagree, the sheet wins."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [FFMPEG, "-y", "-v", "error", "-i", str(path),
         "-vf", f"select='not(mod(n\\,{max(1, 124 // cols)}))',scale=320:-1,tile={cols}x1",
         "-frames:v", "1", str(dst)],
        capture_output=True)


def score(path: Path) -> dict:
    f = frames(path)
    n = len(f)
    return {
        "frames": n,
        "loop_db": round(psnr(f[0], f[-1]), 2),
        "flicker": round(float(np.mean(np.abs(np.diff(f, axis=0)))), 3),
        "detail": round(float(np.mean([laplacian_var(x) for x in f[:: max(1, n // 8)]])), 1),
        "drift": round(float(np.mean(np.abs(f[n // 2] - f[0]))), 2),
    }


def main() -> int:
    runs = json.loads((SWEEP / "resweep.json").read_text())
    rows = []
    for r in runs:
        if r.get("error") or not r.get("files"):
            print(f"  {r.get('shift')}/{r.get('seed')}: {r.get('error', 'no output')}")
            continue
        src = OUT / r["files"][0]
        if not src.exists():
            src = next(OUT.glob(f"**/{r['files'][0]}"), None)
        if not src or not src.exists():
            print(f"  missing on disk: {r['files'][0]}")
            continue
        s = score(src)
        s.update(shift=r["shift"], seed=r["seed"], secs=round(r["seconds"]))
        contact_sheet(src, SWEEP / "sheets" / f"{r['tag']}.png")
        rows.append(s)

    if not rows:
        print("nothing to score yet")
        return 1

    print(f"\n{'shift':>6} {'seed':>7} {'loop_db':>8} {'flicker':>8} {'detail':>8} {'drift':>7} {'secs':>6}")
    for r in sorted(rows, key=lambda x: (x["shift"], x["seed"])):
        print(f"{r['shift']:>6} {r['seed']:>7} {r['loop_db']:>8} {r['flicker']:>8} "
              f"{r['detail']:>8} {r['drift']:>7} {r['secs']:>6}")

    # The noise floor, stated before any conclusion.
    print("\nNOISE FLOOR — spread between the two seeds AT THE SAME SHIFT.")
    print("Any between-shift gap smaller than this is not a finding.")
    floors = {}
    for shift in sorted({r["shift"] for r in rows}):
        g = [r for r in rows if r["shift"] == shift]
        if len(g) < 2:
            continue
        floors[shift] = {m: abs(g[0][m] - g[1][m]) for m in ("loop_db", "flicker", "detail", "drift")}
        print(f"  shift {shift:<5} " + "  ".join(f"{m} ±{v:.2f}" for m, v in floors[shift].items()))

    if floors:
        worst = {m: max(f[m] for f in floors.values()) for m in ("loop_db", "flicker", "detail", "drift")}
        print("\nMEANS, and whether the spread between shifts clears that floor:")
        means = {}
        for shift in sorted({r["shift"] for r in rows}):
            g = [r for r in rows if r["shift"] == shift]
            means[shift] = {m: float(np.mean([x[m] for x in g])) for m in worst}
        for m in worst:
            vals = {s: means[s][m] for s in means}
            spread = max(vals.values()) - min(vals.values())
            best = max(vals, key=vals.get) if m in ("loop_db", "detail") else min(vals, key=vals.get)
            verdict = "REAL" if spread > worst[m] else "inside the noise — no finding"
            pretty = "  ".join(f"{s}:{v:.2f}" for s, v in vals.items())
            print(f"  {m:<8} {pretty}   spread {spread:.2f} vs floor {worst[m]:.2f}  ->  {verdict}"
                  + (f" (best {best})" if verdict == "REAL" else ""))

    print(f"\nNOW LOOK AT THE FRAMES: {SWEEP / 'sheets'}")
    print("If the sheets disagree with the table, the sheets win. That is not a")
    print("figure of speech — `detail` has ranked a broken render top before.")
    (SWEEP / "scores.json").write_text(json.dumps(rows, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
