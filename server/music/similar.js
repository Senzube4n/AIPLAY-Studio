/**
 * WHICH OF MY SONGS SOUND LIKE THIS ONE — over YuE2's own tokens.
 *
 * Every YuE2 take keeps the semantic codes it was written from, and since the
 * real-audio tokenizer shipped, any RECORDING that has been read keeps them
 * too. Those codes are the model's own vocabulary for sound: 32,768 of them,
 * twenty-five a second. Two pieces of music that use the same codes in the
 * same proportions are made of the same material, and that is a search nobody
 * has to tag anything for.
 *
 * ⚠ WHAT THIS MEASURES, AND WHAT IT DOES NOT. The signature is how often each
 * code is used, with the order thrown away — so it answers "is this the same
 * kind of sound" (instrumentation, texture, register, production) and NOT "is
 * this the same tune". A cover in another arrangement will not score highly;
 * two different songs from one session will. Saying that plainly is cheaper
 * than a user discovering it.
 *
 * Nothing here touches the card: it reads files the renders already wrote.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

const VOCAB = 32768;

/**
 * A 1-D integer .npy, as a plain array. The format is fixed enough to parse in
 * thirty lines: a magic, a version, a header length, an ASCII dict naming the
 * dtype and the shape, then the raw buffer. Anything that is not the shape our
 * own writers produce is refused by name rather than half-read.
 */
export function readCodesNpy(buf) {
  if (buf.length < 12 || buf.toString("latin1", 0, 6) !== "\x93NUMPY") {
    throw new Error("not a .npy file");
  }
  const major = buf[6];
  const headerLen = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
  const start = (major === 1 ? 10 : 12) + headerLen;
  const header = buf.toString("latin1", major === 1 ? 10 : 12, start);
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order':\s*(True|False)/.exec(header)?.[1];
  const shape = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? "";
  const dims = shape.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  if (fortran !== "False") throw new Error("a Fortran-ordered array is not what our writers produce");
  if (dims.length !== 1) throw new Error(`expected a 1-D array of codes, got shape (${shape})`);
  const n = dims[0];
  const out = new Int32Array(n);
  if (descr === "<i4" || descr === "=i4" || descr === "|i4") {
    for (let i = 0; i < n; i++) out[i] = buf.readInt32LE(start + i * 4);
  } else if (descr === "<i8" || descr === "=i8") {
    for (let i = 0; i < n; i++) out[i] = Number(buf.readBigInt64LE(start + i * 8));
  } else {
    throw new Error(`unsupported dtype ${descr}; our writers emit int32`);
  }
  return out;
}

/**
 * The signature: how often each code is used, L2-normalised, kept sparse
 * because a three-minute song touches a few thousand of the 32,768.
 * Sub-linear weighting (1 + log count) so one droning code cannot dominate the
 * way raw counts let it — the same reason text search does not use raw counts.
 */
export function signature(codes) {
  const counts = new Map();
  for (const c of codes) {
    if (c < 0 || c >= VOCAB) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  let norm = 0;
  for (const [code, n] of counts) {
    const w = 1 + Math.log(n);
    counts.set(code, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [code, w] of counts) counts.set(code, w / norm);
  return counts;
}

/** Cosine between two sparse signatures: walk the smaller one. */
export function cosine(a, b) {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [code, w] of small) {
    const o = big.get(code);
    if (o !== undefined) dot += w * o;
  }
  return dot;
}

/**
 * Every set of codes on this machine, with what it came from.
 *
 * Two kinds live side by side under output/yue2: a RUN folder, written by a
 * render, whose codes are the model's own and whose library file is
 * aiplay_yue2_<id>.flac; and a tok_ folder, written by the tokenizer, whose
 * codes are its reading of a recording named in source.json.
 */
export async function catalogueOfCodes({ outputDir = config.outputDir } = {}) {
  const root = path.join(outputDir, "yue2");
  let names = [];
  try { names = await readdir(root); } catch { return []; }
  const rows = [];
  for (const name of names) {
    const dir = path.join(root, name);
    const codesFile = path.join(dir, "semantic.npy");
    const s = await stat(codesFile).catch(() => null);
    if (!s || !s.isFile()) continue;
    let file = null, from = null, title = null;
    if (name.startsWith("tok_")) {
      from = "recording";
      try { file = JSON.parse(await readFile(path.join(dir, "source.json"), "utf8")).source ?? null; } catch { /* a receipt is a courtesy */ }
    } else {
      from = "take";
      file = `aiplay_yue2_${name}.flac`;
      try { title = JSON.parse(await readFile(path.join(dir, "request.json"), "utf8")).style?.slice(0, 120) ?? null; } catch { /* likewise */ }
    }
    rows.push({ dir, name, codesFile, file, from, title, bytes: s.size });
  }
  return rows;
}

/**
 * Rank everything on this machine against one set of codes.
 * `queryDir` is a folder holding semantic.npy — the tokenizer's, or a run's.
 */
export async function soundsLike(queryDir, { limit = 10, outputDir = config.outputDir } = {}) {
  const qBuf = await readFile(path.join(queryDir, "semantic.npy"));
  const qCodes = readCodesNpy(qBuf);
  const q = signature(qCodes);
  const rows = await catalogueOfCodes({ outputDir });
  const scored = [];
  for (const r of rows) {
    if (path.resolve(r.dir) === path.resolve(queryDir)) continue;   // never itself
    let codes;
    try { codes = readCodesNpy(await readFile(r.codesFile)); }
    catch { continue; }                                            // a half-written file is skipped, not fatal
    scored.push({
      file: r.file, from: r.from, title: r.title,
      seconds: Math.round(codes.length / 25),
      similarity: Number(cosine(q, signature(codes)).toFixed(4)),
    });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return {
    compared: scored.length,
    querySeconds: Math.round(qCodes.length / 25),
    matches: scored.slice(0, Math.max(1, Math.min(50, limit))),
  };
}
