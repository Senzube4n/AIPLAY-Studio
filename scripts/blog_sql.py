#!/usr/bin/env python3
"""Rebuild the blog UPDATE statement from the markdown body.

The body and the SQL had to be kept in step by hand, which is exactly the kind of
thing that silently ships a stale post. This generates one from the other.

    python scripts/blog_sql.py            # writes docs/_wf/blog_update_dev.sql

⚠ The body is dollar-quoted as $aiplaybody$...$aiplaybody$, so the tag must not
appear inside the text. Checked rather than assumed: a collision would end the
string early and hand the rest of the post to the SQL parser.
"""
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WF = os.path.join(HERE, "..", "docs", "_wf")
TAG = "aiplaybody"


def main():
    body = io.open(os.path.join(WF, "blog_aiplay_body.md"), encoding="utf-8").read()
    cols = json.load(io.open(os.path.join(WF, "blog_aiplay_cols.json"), encoding="utf-8"))

    if "$%s$" % TAG in body:
        print("REFUSED: the body contains the dollar-quote tag $%s$" % TAG)
        return 1

    slug = cols["slug"]
    if "'" in slug:
        print("REFUSED: slug contains a quote")
        return 1
    excerpt = cols["excerpt"].replace("'", "''")

    sql = (
        "\\set ON_ERROR_STOP on\n"
        "BEGIN;\n"
        "UPDATE blog_articles SET\n"
        "  content    = ${tag}${body}${tag}$,\n"
        "  excerpt    = '{excerpt}',\n"
        "  updated_at = NOW()\n"
        "WHERE slug = '{slug}';\n"
        "SELECT id, length(content) AS chars, left(excerpt,60) AS excerpt\n"
        "  FROM blog_articles WHERE slug = '{slug}';\n"
        "COMMIT;\n"
    ).format(tag=TAG, body=body, excerpt=excerpt, slug=slug)

    out = os.path.join(WF, "blog_update_dev.sql")
    io.open(out, "w", encoding="utf-8", newline="\n").write(sql)
    print("wrote %s (%d chars of body)" % (os.path.relpath(out), len(body)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
