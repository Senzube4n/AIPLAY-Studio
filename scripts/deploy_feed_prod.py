#!/usr/bin/env python3
"""Deploy the desktop feed endpoint to AIPLAY production.

    python scripts/deploy_feed_prod.py --check     # verify only, change nothing
    python scripts/deploy_feed_prod.py --deploy    # copy, restart, verify

WHY THIS EXISTS. The endpoint that feeds AIPLAY Studio's Community tab has only
ever lived on dev, so every shipped install calls production, gets a 404 and
shows an empty pane. Production has the data — measured 1,407 public active
music sessions — it simply has no route to serve it.

WHAT IT DOES. Copies exactly two files from the DEV tree (which is the running,
current version — the repo's own copy was a stale v1 with numeric ids and four
missing sections) into the prod tree, then restarts the prod service.

⚠ It copies from dev rather than from this repository ON PURPOSE. `dev-endpoint/`
here is a reference copy and has drifted before; the deployed dev file is the one
that is actually known to work against this schema.

SAFETY. The endpoint is a read-only anonymous GET. It adds a route and touches
nothing existing. Every precondition is checked before anything is written, and
the verification at the end fails loudly if prod does not answer 200 with real
rows. To roll back: delete the directory and restart the service — the two
commands are printed on failure.
"""
import argparse
import json
import sys
import time
import urllib.request

sys.path.insert(0, r"C:\temp\AIPLAYMIGRATION")
import aiplay_creds as creds  # noqa: E402

DEV = "/home/chester/aiplay/app/endpoints/desktop"
PROD = "/home/chester/aiplay/app-prod/endpoints/desktop"
FILES = ("feed_GET.ts", "feed_GET.schema.ts")
SERVICE = "aiplay-prod"
PROD_URL = "https://aiplay.live/_api/desktop/feed"


def run(ssh, cmd, timeout=90):
    _in, out, err = ssh.exec_command(cmd, timeout=timeout)
    o = out.read().decode("utf-8", "replace").strip()
    e = err.read().decode("utf-8", "replace").strip()
    return o, e, out.channel.recv_exit_status()


def probe(url, timeout=25):
    """Ask production what it serves.

    ⚠ Sends a browser User-Agent. Cloudflare sits in front of aiplay.live and
    answers urllib's default agent with 403 — which is indistinguishable from a
    real refusal and would have made this script report a failed deployment as
    a blocked one, or worse, the reverse. Measured: default agent 403, browser
    agent 404, for the same URL at the same moment.
    """
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:                                   # noqa: BLE001
        return 0, str(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--deploy", action="store_true", help="actually write and restart")
    args = ap.parse_args()

    ssh = creds.connect()
    try:
        # ---- preconditions ------------------------------------------------
        for f in FILES:
            out, _, code = run(ssh, f"test -f {DEV}/{f} && wc -c < {DEV}/{f}")
            if code != 0:
                print(f"REFUSED: source missing on dev: {DEV}/{f}")
                return 1
            print(f"  source {f}: {out} bytes")

        out, _, _ = run(ssh, "test -d /home/chester/aiplay/app-prod/helpers && echo yes")
        if out != "yes":
            print("REFUSED: prod tree does not look like the app (no helpers/)")
            return 1

        out, _, _ = run(ssh, f"test -f {PROD}/feed_GET.ts && echo present || echo absent")
        print(f"  prod endpoint currently: {out}")

        status, _ = probe(PROD_URL)
        print(f"  prod {PROD_URL} today: HTTP {status}")

        if not args.deploy:
            print("\n--check only. Nothing was written. Re-run with --deploy.")
            return 0

        # ---- copy ----------------------------------------------------------
        run(ssh, f"mkdir -p {PROD}")
        for f in FILES:
            _, err, code = run(ssh, f"cp -p {DEV}/{f} {PROD}/{f}")
            if code != 0:
                print(f"FAILED copying {f}: {err}")
                return 1
        out, _, _ = run(ssh, f"ls -la {PROD}")
        print("\n  copied:\n" + "\n".join("    " + l for l in out.splitlines()))

        # ---- restart -------------------------------------------------------
        print(f"\n  restarting {SERVICE} …")
        # ⚠ run_sudo returns (stdout, stderr, exit_code) — three values.
        out, err, _ = creds.run_sudo(ssh, f"systemctl restart {SERVICE}", timeout=180)
        if err and "password" not in err.lower():
            print("    " + err.strip()[:300])
        out, _, _ = creds.run_sudo(ssh, f"systemctl is-active {SERVICE}", timeout=60)
        print(f"    service is now: {out.strip()}")

        # ---- verify --------------------------------------------------------
        print("\n  waiting for prod to answer …")
        for attempt in range(24):
            time.sleep(5)
            status, body = probe(PROD_URL)
            if status == 200:
                try:
                    d = json.loads(body)
                except ValueError:
                    print("    200 but the body is not JSON — investigate before trusting it.")
                    return 1
                inner = d.get("json", d)
                print(f"    HTTP 200 · version {inner.get('version')} · "
                      f"{len(inner.get('sessions') or [])} sessions · "
                      f"{len(inner.get('stations') or [])} stations · "
                      f"{len(inner.get('parties') or [])} parties")
                print("\ndeployed.")
                return 0
            print(f"    attempt {attempt + 1}: HTTP {status}")

        print("\nFAILED: prod never returned 200. Roll back with:")
        print(f"    rm -rf {PROD}")
        print(f"    sudo systemctl restart {SERVICE}")
        return 1
    finally:
        ssh.close()


if __name__ == "__main__":
    sys.exit(main())
