#!/usr/bin/env python3
"""Hold Windows awake for the duration of an overnight batch.

An overnight run is worthless if the machine sleeps forty minutes in. The flag is
per-process and only lasts while the process lives, so this deliberately blocks
forever and is killed by the server when the batch ends -- if the server dies,
the flag dies with it, which is the behaviour we want.

ES_DISPLAY_REQUIRED is deliberately NOT set: the screen should still go dark.
"""
import ctypes
import sys
import time

ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001


def main() -> int:
    if not sys.platform.startswith("win"):
        print("keepawake: not windows, nothing to do", flush=True)
        return 0
    try:
        rv = ctypes.windll.kernel32.SetThreadExecutionState(
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED
        )
    except Exception as exc:  # pragma: no cover - defensive
        print(f"keepawake: unavailable ({exc})", flush=True)
        return 1
    if rv == 0:
        print("keepawake: refused by the OS", flush=True)
        return 1

    print("keepawake: holding", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)
    return 0


if __name__ == "__main__":
    sys.exit(main())
