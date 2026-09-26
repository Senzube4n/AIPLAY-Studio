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
 * Bytes are the catalogue's own (server/models.js, the published file lists), a file
 * two rows share is counted once (server/fit.js bytesFor, the Models screen's
 * rule), and each total is rounded to the whole GB and said as "about".
 *
 * MUSIC IS THE ENGINE A FRESH INSTALL IS POINTED AT: YuE2 3B through ComfyUI
 * (server/music-default.js, the int8 build the Models screen fetches). The
 * sentence said "About 12 GB for music alone (MiniMax Music 3)" while Studio
 * recommended the 3.96 GB YuE2; MiniMax is named beside it for whoever picks it.
 */
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "../server/models.js";
import { bytesFor } from "../server/fit.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function diskTotals(catalog = CATALOG) {
  /* Rows a python package fetches for itself (timed lyrics' whisper model)
   * carry `approxBytes` and no files; bytesFor counts them from totalBytes.
   * `defaultFiles` is the published list: on an AMD machine `files` swaps in
   * the builds ROCm can run (larger int8 in place of fp4), and INSTALL.md must
   * read the same on every machine, as the model tables do (models_table.mjs). */
  const rows = catalog.map((c) => ({ ...c, files: c.defaultFiles || c.files, totalBytes: c.approxBytes || 0 }));
  const gb = (ids) => bytesFor(ids ? rows.filter((c) => ids.includes(c.id)) : rows).totalBytes / 1e9;
  return {
    music: gb(["musicYue2Comfy"]),        // YuE2 3B through ComfyUI: what a fresh Full Studio install is pointed at
    musicMinimax: gb(["engine"]),         // MiniMax Music 3, for whoever picks it
    musicVideos: gb(["video", "videoRefs"]),   // MiniMax H3 and its reference build
    everything: gb(null),
  };
}

export function diskSentence(t = diskTotals()) {
  return `About ${Math.round(t.music)} GB for music alone (YuE2 3B through ComfyUI, the build Studio recommends; `
    + `MiniMax Music 3, if you pick it instead, is about ${Math.round(t.musicMinimax)} GB). `
    + `About ${Math.round(t.musicVideos)} GB more for music videos (MiniMax H3 and its reference build), `
    + `and about ${Math.round(t.everything)} GB if you downloaded every model in the catalogue `
    + "(a file two features share counted once).";
}

/** INSTALL.md's row, from "**Free disk space.** " to the cell's end. */
export const DISK_ROW = /(\| \*\*Free disk space\.\*\* )([^|]*?)( \|)/;

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]))) {
  const t = diskTotals();
  console.log(`music ${t.music.toFixed(2)} GB (MiniMax ${t.musicMinimax.toFixed(2)} GB) · music videos ${t.musicVideos.toFixed(2)} GB · every model ${t.everything.toFixed(2)} GB`);
  console.log(diskSentence(t));
  if (process.argv.includes("--write")) {
    const file = path.join(ROOT, "INSTALL.md");
    const text = readFileSync(file, "utf8");
    if (!DISK_ROW.test(text)) { console.error("INSTALL.md has no '**Free disk space.**' row."); process.exit(1); }
    writeFileSync(file, text.replace(DISK_ROW, (_, a, _b, c) => `${a}${diskSentence(t)}${c}`));
    console.log("INSTALL.md updated.");
  }
}
