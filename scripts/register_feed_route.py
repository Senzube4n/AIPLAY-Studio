#!/usr/bin/env python3
"""Register the desktop feed route in AIPLAY production's route table.

    python scripts/register_feed_route.py --check
    python scripts/register_feed_route.py --apply

WHY A SECOND STEP. Copying the endpoint file is not enough: routing is an
EXPLICIT TABLE in `routes.ts`, not a filesystem scan. Prod restarted cleanly
with the endpoint present and still answered 404, because nothing referenced it.

WHAT IT CHANGES. Exactly one line, inserted next to the blog route so it lands in
the same block. The file is fetched, edited HERE where the change is reviewable,
and written back — no remote scripting. A timestamped backup is left beside it.

Dev's table carries three routes prod lacks. This adds ONLY the feed; the other
two are the Bunny Stream upload pair, which is a separate pending decision and
not ours to make here.
"""
import argparse
import io
import os
import sys
import tempfile

sys.path.insert(0, r"C:\temp\AIPLAYMIGRATION")
import aiplay_creds as creds  # noqa: E402

ROUTES = "/home/chester/aiplay/app-prod/routes.ts"
LINE = '  { method: "get", path: "_api/desktop/feed", file: "./endpoints/desktop/feed_GET.js" },\n'
ANCHOR = '{ method: "get", path: "_api/blog/articles"'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    ssh = creds.connect()
    try:
        sftp = ssh.open_sftp()
        tmp = os.path.join(tempfile.gettempdir(), "aiplay_prod_routes.ts")
        sftp.get(ROUTES, tmp)
        s = io.open(tmp, encoding="utf-8").read()
        print(f"  fetched routes.ts: {len(s)} chars, {s.count(chr(10))} lines")

        if "desktop/feed" in s:
            print("  already registered — nothing to do")
            return 0
        if s.count(ANCHOR) != 1:
            print(f"REFUSED: the anchor appears {s.count(ANCHOR)} times, expected exactly 1")
            return 1

        i = s.index(ANCHOR)
        start = s.rfind("\n", 0, i) + 1
        out = s[:start] + LINE + s[start:]

        print("\n  the one line being added:")
        print("    " + LINE.strip())
        print("  inserted before:")
        print("    " + s[start:s.index("\n", start)].strip())

        if not args.apply:
            print("\n--check only. Nothing was written. Re-run with --apply.")
            return 0

        sftp.put(tmp, ROUTES + ".bak-feed")          # the untouched original
        io.open(tmp, "w", encoding="utf-8", newline="").write(out)
        sftp.put(tmp, ROUTES)
        sftp.close()

        _in, o, _e = ssh.exec_command(f"grep -n 'desktop/feed' {ROUTES}", timeout=60)
        print("\n  written:\n    " + o.read().decode("utf-8", "replace").strip())
        print(f"  backup:  {ROUTES}.bak-feed")
        return 0
    finally:
        ssh.close()


if __name__ == "__main__":
    sys.exit(main())
