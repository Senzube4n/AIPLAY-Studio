#!/usr/bin/env python3
"""Push the generated blog UPDATE to the DEV blog. DEV ONLY.

    python scripts/blog_sql.py && python scripts/blog_publish_dev.py

⚠ DEV, and only DEV. The container name and the database name below are the dev
pair (port 5433 / aiplay_dev); production is a different container on 5432 and is
deliberately not reachable from this script. Verified before running, so a
renamed or stopped container fails loudly instead of silently doing nothing.

The statement is an UPDATE matched on SLUG, wrapped in BEGIN/COMMIT with
ON_ERROR_STOP — so it either replaces the one article or changes nothing. It
reports the row it touched; zero rows updated means the slug has drifted and is
worth stopping for.

Credentials come from aiplay_creds, never from this file.
"""
import os
import sys

sys.path.insert(0, r"C:\temp\AIPLAYMIGRATION")
import aiplay_creds as creds  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL_SQL = os.path.join(HERE, "..", "docs", "_wf", "blog_update_dev.sql")
REMOTE_SQL = "/tmp/aiplay_blog_update.sql"

DEV_DB_CONTAINER = "aiplay-db-dev"
DEV_DB_NAME = "aiplay_dev"
DEV_DB_USER = "aiplay"


def run(ssh, cmd, timeout=120):
    _in, out, err = ssh.exec_command(cmd, timeout=timeout)
    o = out.read().decode("utf-8", errors="replace")
    e = err.read().decode("utf-8", errors="replace")
    return o, e, out.channel.recv_exit_status()


def main():
    if not os.path.exists(LOCAL_SQL):
        print("no SQL to publish — run scripts/blog_sql.py first")
        return 1
    size = os.path.getsize(LOCAL_SQL)
    print("publishing %s (%d bytes) to the DEV blog" % (os.path.basename(LOCAL_SQL), size))

    ssh = creds.connect()
    try:
        out, _, _ = run(ssh, "docker ps --filter name=%s --format '{{.Status}}'" % DEV_DB_CONTAINER)
        if "Up" not in out:
            print("REFUSED: %s is not running (%s)" % (DEV_DB_CONTAINER, out.strip() or "not found"))
            return 1
        print("  container: %s" % out.strip())

        sftp = ssh.open_sftp()
        sftp.put(LOCAL_SQL, REMOTE_SQL)
        sftp.close()

        _, err, code = run(ssh, "docker cp %s %s:/tmp/blog_update.sql" % (REMOTE_SQL, DEV_DB_CONTAINER))
        if code != 0:
            print("REFUSED: docker cp failed: %s" % err.strip())
            return 1

        out, err, code = run(
            ssh,
            "docker exec %s psql -U %s -d %s -f /tmp/blog_update.sql 2>&1"
            % (DEV_DB_CONTAINER, DEV_DB_USER, DEV_DB_NAME),
            timeout=180,
        )
        print(out.strip() or err.strip())
        if code != 0 or "ERROR" in out:
            print("\nFAILED — the transaction rolled back, the article is unchanged.")
            return 1
        if "UPDATE 0" in out:
            print("\nUPDATE 0 — no article has that slug. Nothing was published.")
            return 1

        # Tidy up: the file carries the whole post and has no business lingering.
        run(ssh, "rm -f %s" % REMOTE_SQL)
        run(ssh, "docker exec %s rm -f /tmp/blog_update.sql" % DEV_DB_CONTAINER)
        print("\npublished.")
        return 0
    finally:
        ssh.close()


if __name__ == "__main__":
    sys.exit(main())
