"""A PYTHON THAT STAYS, BECAUSE SPAWNING ONE IS 60% OF EVERY EDIT.

Measured on this machine, at 1024x1024, through the live route:

    one brush stroke, end to end            653 ms
    the same call with ops={} - NO WORK     596 ms
    bare interpreter start                  ~160 ms
    + numpy, cv2, PIL imported              ~390 ms
    the stroke rasterisation itself          11 ms

An edit that does nothing costs 91% of an edit that does something, because
server/index.js spawns a FRESH interpreter for every request and pays the import
cost each time. The pixels were never the problem.

This module is the same engine behind a process that does not exit. One request
per line of stdin, one reply per line of stdout:

    -> {"id": 7, "mode": "edit", "job": {...}}
    <- {"id": 7, "ok": true, "out": "...", "width": 1024, "height": 768}

⚠ apply_edit PRINTS ITS RESULT, so the protocol has to take stdout away from
it. imagetools is a CLI first: apply_edit ends by printing a JSON line, which
is exactly what this file uses stdout for. Left alone, the engine's own report
would interleave with the protocol and every reply would be unparseable. So each
call runs inside redirect_stdout and the captured line becomes the reply's body
- the engine keeps its contract, and the pipe stays clean.

⚠ AND A CRASH MUST ANSWER, NOT DIE. A worker that exits on a bad job takes
every queued request with it and the node side waits forever. Every exception
becomes a reply with the traceback's last line, and the loop continues; only a
closed stdin ends it.
"""
import contextlib
import io
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import imagetools  # noqa: E402


def _call(mode, job):
    """Run one job with stdout borrowed, and give back what it printed."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        if mode == "edit":
            imagetools.apply_edit(job)
        elif mode == "blank":
            imagetools.blank(job)
        elif mode == "describe":
            imagetools.describe_selection(job)
        elif mode == "composite":
            imagetools.composite(job)
        else:
            raise ValueError(f"unknown mode {mode!r}")
    said = buf.getvalue().strip()
    if not said:
        return {}
    # The engine's own report is the LAST line; anything before it is a note it
    # printed on the way (imgstroke and imgselect both warn on stdout).
    try:
        return json.loads(said.splitlines()[-1])
    except Exception:                                   # noqa: BLE001
        return {"said": said[-400:]}


def main():
    # The handshake, so node can wait for the imports rather than guessing.
    sys.stdout.write(json.dumps({"ready": True, "pid": os.getpid()}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            body = _call(req.get("mode") or "edit", req.get("job") or {})
            reply = {"id": rid, "ok": True, **body}
        except Exception as exc:                        # noqa: BLE001
            # A worker that dies on a bad job strands every queued request.
            tb = traceback.format_exc().strip().splitlines()
            reply = {"id": rid, "ok": False,
                     "error": f"{type(exc).__name__}: {exc}",
                     "where": tb[-3] if len(tb) >= 3 else ""}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
