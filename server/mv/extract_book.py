"""Book text extraction - epub (stdlib only) and pdf (pypdf when present).

Usage: python extract_book.py <book path> <out json path>

Writes { ok, title, author, chapters: [ { title, words, text } ] } and prints a
one-line JSON summary to stdout. Chapter TEXT is cleaned for a NARRATOR:
headers kept as announceable titles, html stripped, whitespace collapsed,
scene breaks normalised to a marker the TTS planner turns into a pause.

EPUB: a zip of xhtml with an OPF manifest; the spine IS the chapter order, so
chaptering comes free. No third-party libraries.

PDF: webnovel conversions carry a text layer; pypdf (BSD) extracts it. Their
"chapters" are headings inside a continuous stream, so chapters are recovered
by heading heuristics (the classic "Chapter 123" / "Chapter 123: Title" lines
these conversions all carry).
"""
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


SCENE_BREAK = "\n<<<PAUSE>>>\n"


def clean_text(t):
    t = t.replace("\r", "")
    t = re.sub(r"[­​‌‍﻿]", "", t)          # soft hyphens, zero-widths
    # PDF text layers lose cp1252 apostrophes to U+FFFD; between letters it can
    # only have been an apostrophe ("Assassin�s"), elsewhere it is just noise
    t = re.sub(r"(?<=\w)�(?=\w)", "'", t).replace("�", "")
    t = re.sub(r"[ \t]+", " ", t)
    # scene-break glyph rows become explicit pauses
    t = re.sub(r"\n\s*(?:[*#~\-_=•◆●★✻]\s*){3,}\n", SCENE_BREAK, t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def strip_html(xhtml):
    # kill scripts/styles, turn block ends into newlines, drop all tags
    x = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", xhtml)
    x = re.sub(r"(?i)</(p|div|h[1-6]|li|blockquote|tr)>", "\n\n", x)
    x = re.sub(r"(?i)<(br|hr)\s*/?>", "\n", x)
    x = re.sub(r"(?s)<[^>]+>", "", x)
    x = (x.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
          .replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'")
          .replace("&mdash;", "—").replace("&hellip;", "…"))
    x = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), x)
    return x


def read_epub(path):
    ns = {
        "c": "urn:oasis:names:tc:opendocument:xmlns:container",
        "opf": "http://www.idpf.org/2007/opf",
        "dc": "http://purl.org/dc/elements/1.1/",
    }
    with zipfile.ZipFile(path) as z:
        container = ET.fromstring(z.read("META-INF/container.xml"))
        opf_path = container.find(".//c:rootfile", ns).attrib["full-path"]
        opf = ET.fromstring(z.read(opf_path))
        base = str(Path(opf_path).parent)

        title = (opf.findtext(".//dc:title", default="", namespaces=ns) or Path(path).stem).strip()
        author = (opf.findtext(".//dc:creator", default="", namespaces=ns) or "").strip()

        items = {i.attrib["id"]: i.attrib["href"]
                 for i in opf.findall(".//opf:manifest/opf:item", ns)}
        spine = [items[r.attrib["idref"]] for r in opf.findall(".//opf:spine/opf:itemref", ns)
                 if r.attrib["idref"] in items]

        chapters = []
        for href in spine:
            full = href if base in ("", ".") else f"{base}/{href}"
            try:
                raw = z.read(full).decode("utf-8", "replace")
            except KeyError:
                continue
            # the chapter's own heading, if it has one
            m = re.search(r"(?is)<h[1-3][^>]*>(.*?)</h[1-3]>", raw)
            heading = clean_text(strip_html(m.group(1))) if m else ""
            text = clean_text(strip_html(raw))
            words = len(text.split())
            if words < 30:                     # covers, tocs, colophons
                continue
            chapters.append({"title": heading or f"Part {len(chapters) + 1}",
                             "words": words, "text": text})
    return {"ok": True, "title": title, "author": author, "chapters": chapters}


# A heading is a SHORT line of its own: "Chapter 12", "Chapter 12 – Title".
# [ \t]* (never \s*) so the anchor cannot eat newlines and match wrapped prose;
# a title is only allowed after an explicit separator and must open uppercase —
# "Chapter 115.] Back then, they didn't..." is prose, not a heading.
CHAPTER_RE = re.compile(
    r"(?m)^[ \t]*((?:chapter|part|book)\s+\d{1,4}"
    r"(?:\s*[:.\-–—]\s*[A-Z0-9\"'“‘(][^\n]{0,58})?)[ \t]*[.!]?[ \t]*$",
    re.IGNORECASE)

TOC_LINE = re.compile(r"^\s*(?:\d{1,4}\.\s+\S|(?:chapter|part)\s+\d{1,4}\b)", re.IGNORECASE)


def looks_like_toc(text):
    """Contents pages read as long runs of numbered title lines."""
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    if len(lines) < 20:
        return False
    hits = sum(1 for l in lines if TOC_LINE.match(l))
    return hits / len(lines) > 0.4


def pack_units(units, sep, max_words):
    """Pack text units into ≤max_words parts, preferring to cut where the last
    unit ends a sentence (up to 15% overflow while waiting for one)."""
    parts, cur, cur_w = [], [], 0
    hard = max_words * 1.15
    for u in units:
        cur.append(u)
        cur_w += len(u.split())
        if cur_w >= max_words and (u.rstrip().endswith((".", "!", "?", "…", '"', "”", "'")) or cur_w >= hard):
            parts.append(sep.join(cur)); cur, cur_w = [], 0
    if cur:
        parts.append(sep.join(cur))
    return parts


def split_oversized(chapters, max_words):
    """No chapter may exceed one bundle: cut giants into "(part n/k)" chapters
    so the planner's 5-15 min invariant holds for any book. Falls back from
    paragraph edges to line edges — PDF text layers often have no blank lines."""
    out = []
    for c in chapters:
        if c["words"] <= max_words or c.get("toc"):
            out.append(c)
            continue
        paras = [p for p in re.split(r"\n\n+", c["text"]) if p.strip()]
        if len(paras) > c["words"] / (max_words * 2):
            bodies = pack_units(paras, "\n\n", max_words)
        else:
            bodies = pack_units([l for l in c["text"].split("\n") if l.strip()], "\n", max_words)
        k = len(bodies)
        for n, body in enumerate(bodies, 1):
            title = f"Part {n} of {k}" if c["title"] == "__stream__" else f"{c['title']} (part {n}/{k})"
            out.append({"title": title, "words": len(body.split()), "text": body})
    return out


def dedupe_layout(text):
    """Print-layout debris in PDF text layers: bare page-number lines, running
    headers repeated on every page (all but the first occurrence dropped — the
    first is usually the real chapter opener), and drop-caps split off their
    word ("H / aving killed...")."""
    from collections import Counter
    lines = text.split("\n")
    freq = Counter(l.strip() for l in lines if l.strip() and len(l.strip()) < 60)
    running = {l for l, n in freq.items() if n >= 20}
    kept, seen = [], set()
    for l in lines:
        s = l.strip()
        if re.fullmatch(r"\d{1,4}", s):
            continue
        if s in running:
            if s in seen:
                continue
            seen.add(s)
        kept.append(l)
    out, i = [], 0
    while i < len(kept):
        s = kept[i].strip()
        if len(s) == 1 and s.isalpha() and s.isupper() and i + 1 < len(kept) and kept[i + 1][:1].islower():
            out.append(s + kept[i + 1])
            i += 2
            continue
        out.append(kept[i])
        i += 1
    return "\n".join(out)


def read_pdf(path):
    try:
        from pypdf import PdfReader
    except ImportError:
        return {"ok": False, "error": "pypdf is not installed in this venv (pip install pypdf - BSD licence)"}
    reader = PdfReader(path)
    pages = []
    for p in reader.pages:
        try:
            pages.append(p.extract_text() or "")
        except Exception:
            pages.append("")
    text = clean_text("\n".join(pages))
    if len(text.split()) < 200:
        return {"ok": False, "error": "no usable text layer - this PDF looks scanned"}
    text = dedupe_layout(text)

    # Split on "Chapter N" heading lines; whatever precedes the first heading
    # becomes a front-matter chapter only if it is substantial.
    parts = CHAPTER_RE.split(text)
    chapters = []
    if parts and len(parts[0].split()) > 150:
        first = parts[0].strip()
        toc = looks_like_toc(first)
        chapters.append({"title": "Table of contents" if toc else "Front matter",
                         "words": len(first.split()), "text": first, "toc": toc})
    for i in range(1, len(parts), 2):
        head = re.sub(r"\s+", " ", parts[i]).strip()
        body = parts[i + 1].strip() if i + 1 < len(parts) else ""
        # a repeated heading is a running page header, not a new chapter —
        # fold its body back into the chapter it belongs to
        if chapters and head.lower() == chapters[-1]["title"].lower():
            if body:
                chapters[-1]["text"] += "\n\n" + body
                chapters[-1]["words"] = len(chapters[-1]["text"].split())
            continue
        words = len(body.split())
        if words < 30:
            continue
        chapters.append({"title": head, "words": words, "text": body,
                         "toc": looks_like_toc(body)})
    if not chapters:
        chapters = [{"title": Path(path).stem, "words": len(text.split()), "text": text}]
    return {"ok": True, "title": Path(path).stem.replace("_", " "), "author": "", "chapters": chapters}


def main():
    src, out = sys.argv[1], sys.argv[2]
    max_words = int(sys.argv[3]) if len(sys.argv) > 3 else 2500
    if src.lower().endswith(".epub"):
        data = read_epub(src)
    elif src.lower().endswith(".pdf"):
        data = read_pdf(src)
    else:
        data = {"ok": False, "error": "epub or pdf only"}
    if data.get("ok"):
        # Heading detection that yields a handful of monster "chapters" out of a
        # huge stream found footnotes, not headings — junk them and split the
        # stream honestly by size ("Part n of k").
        body = [c for c in data["chapters"] if not c.get("toc")]
        if body and len(body) < 8 and max(c["words"] for c in body) > 10 * max_words:
            keep = [c for c in data["chapters"] if c.get("toc")]
            stream = "\n\n".join(c["text"] for c in body)
            data["chapters"] = keep + [{"title": "__stream__",
                                        "words": len(stream.split()), "text": stream}]
        data["chapters"] = split_oversized(data["chapters"], max_words)
    Path(out).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    summary = {"ok": data.get("ok", False)}
    if data.get("ok"):
        summary.update(title=data["title"], chapters=len(data["chapters"]),
                       words=sum(c["words"] for c in data["chapters"]))
    else:
        summary["error"] = data.get("error")
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
