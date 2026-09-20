/**
 * THE INBOX IS A FOLDER, AND THAT IS THE WHOLE FEATURE.
 *
 * Phase one opens no socket. A friend sends a sealed file however they already
 * send files, it lands in `<outputDir>/collab/in/`, and this lists what is
 * sitting there. Pointing a sync folder at that directory is the entirety of
 * "automatic peer-to-peer delivery", with no networking code in this repo.
 *
 * ⚠ THIS DOES NOT OPEN ANYTHING. It reads names, sizes, times and the first
 * eleven bytes — and it really is eleven now: the first version said so and
 * then read every byte of every file in the folder to look at them, which on a
 * folder holding a thirty-megabyte bundle is thirty megabytes read to compare a
 * word. Naming the sender means
 * parsing an envelope, and seal.js is the one parser for that; a listing that
 * grew its own would be the second copy of a read that file's header spends a
 * paragraph warning about. The cost is that a listing cannot say who a bundle is
 * from until somebody opens it, which is the correct cost.
 */

import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

/** What seal.js writes at the top of every bundle. Kept as the literal rather
 *  than imported so that this module opens nothing and imports nothing that
 *  holds a key. If seal.js's magic ever changes, the pin in the lane catches
 *  the drift. */
const MAGIC = "AIPLAYSEAL1";

function refuse(reason, message, status = 400) {
  const err = new Error(message);
  err.reason = reason;
  err.status = status;
  return err;
}

/* The directory handed in IS <output>/collab — see orderbook.js. */
export const inboxDir = (collabDir) => path.join(collabDir, "in");

/**
 * What is sitting in the inbox.
 *
 * Every file is listed, including the ones that are not bundles, because a
 * folder that silently hides what it does not understand is a folder where a
 * friend's file goes missing and nobody can say where.
 */
export async function scanInbox({ outDir, limit = 200 } = {}) {
  const dir = inboxDir(outDir);
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return { dir, items: [], note: `Nothing has arrived yet. Drop a friend's .aiplay file into ${dir}, or point your sync folder at it.` };
    throw refuse("inbox-unreadable", `The inbox at ${dir} could not be read: ${err.message}.`, 500);
  }
  /* ⚠ SORT BEFORE THE CAP, NOT AFTER. The first version sliced the raw
   * directory order and then sorted what survived, so in a folder holding more
   * than the limit the bundle that just arrived was simply not listed — the one
   * file the person is looking for. Times come from a stat, so the sort needs
   * one per file; the cap then bounds the READS, which is what it is for. */
  const dated = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const info = await stat(file);
      if (info.isFile()) dated.push({ name, file, size: info.size, at: Math.round(info.mtimeMs) });
    } catch { /* gone between the listing and the stat */ }
  }
  dated.sort((a, b) => b.at - a.at);
  const items = [];
  for (const { name, file, size, at } of dated.slice(0, Math.max(1, Math.min(2000, limit)))) {

    let sealed = false;
    let unreadable = null;
    try {
      const fh = await open(file, "r");
      try {
        const head = Buffer.alloc(MAGIC.length);
        const { bytesRead } = await fh.read(head, 0, MAGIC.length, 0);
        sealed = bytesRead === MAGIC.length && head.toString("ascii") === MAGIC;
      } finally { await fh.close(); }
    } catch (err) {
      /* ⚠ "COULD NOT READ IT" IS NOT "IT IS NOT A BUNDLE". The first version
       * reported a locked or permission-denied file as an ordinary screenshot,
       * which is the sentence most likely to make somebody delete it. */
      unreadable = err.code || err.message;
    }
    items.push({
      name, file, bytes: size, at,
      sealed, unreadable,
      note: unreadable
        ? `This file could not be read (${unreadable}), so there is no telling what it is. It is listed rather than hidden.`
        : sealed
          ? "A sealed AIPLAY bundle. Open it to see who it is from and what is in it — opening checks the signature and changes nothing."
          : "Not an AIPLAY bundle. It is listed so that a file dropped here by mistake does not simply vanish.",
    });
  }
  return {
    dir,
    items,
    note: items.length
      ? `${items.filter((x) => x.sealed).length} sealed bundle${items.filter((x) => x.sealed).length === 1 ? "" : "s"} waiting. Nothing here has been opened, and nothing opens itself.`
      : `Nothing has arrived yet. Drop a friend's .aiplay file into ${dir}, or point your sync folder at it.`,
  };
}
