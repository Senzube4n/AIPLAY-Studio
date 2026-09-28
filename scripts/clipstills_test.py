"""clipstills.py over a REAL pipe, with a clip library under a non-ASCII folder.

stills.js spawns clipstills.py and writes the job as UTF-8 JSON on its stdin.
On Windows a python whose stdin is a pipe decodes it with the ANSI code page
(cp1252), so a library under C:/Users/José/ reached the script as "JosÃ©": every
arm came back "none of these clips could be opened" and no still was written.

A StringIO test cannot see this, because StringIO is already text. So this is a
child process fed the raw bytes JSON.stringify writes (ensure_ascii=False; \\u
escapes would sail through any code page), started with PYTHONIOENCODING=cp1252
so it starts the way Windows starts it on every OS this runs on. The stills must
land in the accented folder the job named.

Needs the rig's cv2 (the gate runs it under $PY). Labels stay ASCII: this file's
own stdout is a cp1252 pipe under the gate.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "clipstills.py")
UNI = "Jos\u00e9 caf\u00e9"

passed, failed = 0, []


def ok(label, cond, detail=""):
    global passed
    if cond:
        passed += 1
        print(f"  ok    {label}")
    else:
        failed.append(label)
        print(f"  FAIL  {label}" + (f"\n          {detail}" if detail else ""))


tmp = tempfile.mkdtemp(prefix="aiplay-clipstills-")
try:
    lib = os.path.join(tmp, UNI)
    os.makedirs(lib)

    print("\nthe fixture - a ten-frame clip inside the accented folder")
    ok("the garbled folder name differs from the real one, so the check below can tell them apart",
       UNI.encode("utf-8").decode("cp1252") != UNI)
    # cv2 writes to an ASCII path; Python moves the file, so the clip on disk is
    # exactly what a library under an accented user folder holds.
    staged = os.path.join(tmp, "staged.mp4")
    w = cv2.VideoWriter(staged, cv2.VideoWriter_fourcc(*"mp4v"), 24, (64, 48))
    for i in range(10):
        w.write(np.full((48, 64, 3), i * 20, np.uint8))
    w.release()
    clip = os.path.join(lib, "clip.mp4")
    if os.path.exists(staged):
        os.replace(staged, clip)
    ok("the clip was built", os.path.exists(clip))

    print("\nthe job over a real pipe, the child started as Windows starts it")
    dest = os.path.join(lib, ".stills")
    job = {"destDir": dest, "frames": [0, 5], "quality": 88,
           "clips": [{"key": "a", "src": clip, "prefix": "p"}]}
    env = {k: v for k, v in os.environ.items() if k != "PYTHONUTF8"}
    env["PYTHONIOENCODING"] = "cp1252"
    child = subprocess.run([sys.executable, SCRIPT],
                           input=json.dumps(job, ensure_ascii=False).encode("utf-8"),
                           capture_output=True, env=env, timeout=120)
    try:
        reply = json.loads(child.stdout.decode("utf-8"))
    except ValueError:
        reply = {}
    ok("the child exits 0 and replies ok",
       child.returncode == 0 and reply.get("ok") is True,
       ascii(child.stdout.decode("utf-8", "replace")[-300:]
             + child.stderr.decode("utf-8", "replace")[-300:]))
    rows = (reply.get("clips") or [{}])[0].get("stills") or []
    ok("the reply lists frames 0 and 5 of the clip",
       [r.get("frame") for r in rows] == [0, 5], ascii(reply))
    landed = [n for n in ("p.0.jpg", "p.5.jpg") if os.path.exists(os.path.join(dest, n))]
    ok("both stills land in the accented folder the job named, not a cp1252 mojibake of it",
       len(landed) == 2, "found %d of 2; folders: %s" % (len(landed), ascii(os.listdir(tmp))))
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{passed} passed, {len(failed)} failed")
if failed:
    print("  failed:\n    " + "\n    ".join(failed))
    sys.exit(1)
