#!/usr/bin/env node
/**
 * HOW MUCH DISK THE MODELS TAKE, computed from the catalogue.
 *
 * INSTALL.md's "Free disk space" row said "About 62 GB if you eventually want
 * every feature", while MiniMax H3 and its reference build ALONE come to about
 * 66 GB. A hand-typed total goes stale the day a row changes, so the sentence
 * is built here and server/installer_test.js fails when INSTALL.md and this
 * disagree.
 *
 *   node scripts/disk_totals.mjs           print the totals and the sentence
 *   node scripts/disk_totals.mjs --write   put the sentence into INSTALL.md
 *
 * Bytes are the catalogue's own (server/models.js, NVIDIA file lists), a file
 * two rows share is counted once (server/fit.js bytesFor, the Models screen's
 * rule), and each total is rounded to the whole GB and said as "about".
 */
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "../server/models.js";
import { bytesFor } from "../server/fit.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function diskTotals(catalog = CATALOG) {
  /* Rows a python package fetches for itself (timed lyrics' whisper model)
   * carry `approxBytes` and no files; bytesFor counts them from totalBytes. */
  const rows = catalog.map((c) => ({ ...c, totalBytes: c.approxBytes || 0 }));
  const gb = (ids) => bytesFor(ids ? rows.filter((c) => ids.includes(c.id)) : rows).totalBytes / 1e9;
  return {
    music: gb(["engine"]),                // MiniMax Music 3: the full suite's music model
    musicVideos: gb(["video", "videoRefs"]),   // MiniMax H3 and its reference build
    everything: gb(null),
  };
}

export function diskSentence(t = diskTotals()) {
  return `About ${Math.round(t.music)} GB for music alone (MiniMax Music 3). `
    + `About ${Math.round(t.musicVideos)} GB more for music videos (MiniMax H3 and its reference build), `
    + `and about ${Math.round(t.everything)} GB if you downloaded every model in the catalogue `
    + "(a file two features share counted once).";
}

/** INSTALL.md's row, from "**Free disk space.** " to the cell's end. */
export const DISK_ROW = /(\| \*\*Free disk space\.\*\* )([^|]*?)( \|)/;

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]))) {
  const t = diskTotals();
  console.log(`music ${t.music.toFixed(2)} GB · music videos ${t.musicVideos.toFixed(2)} GB · every model ${t.everything.toFixed(2)} GB`);
  console.log(diskSentence(t));
  if (process.argv.includes("--write")) {
    const file = path.join(ROOT, "INSTALL.md");
    const text = readFileSync(file, "utf8");
    if (!DISK_ROW.test(text)) { console.error("INSTALL.md has no '**Free disk space.**' row."); process.exit(1); }
    writeFileSync(file, text.replace(DISK_ROW, (_, a, _b, c) => `${a}${diskSentence(t)}${c}`));
    console.log("INSTALL.md updated.");
  }
}
