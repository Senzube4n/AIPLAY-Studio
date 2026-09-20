/**
 * WHAT I SENT, AND WHAT CAME BACK — one file per order, on both sides.
 *
 * The owner keeps a row for every order they sent, because a return arriving in
 * a folder three days later has to be checked against the thing it claims to
 * answer: the seed that was asked for, the size the scene needs, and which
 * friend it went to. Without that a return is an unattributable clip with a
 * confident record attached to it, and the record is written by the same party
 * the check exists to check.
 *
 * The lender keeps a row for every order they LANDED, and that row is the
 * idempotency guard. Opening the same sealed file twice must not build a second
 * errand project and a second plan — a friend who forwards a bundle again
 * because the first one "did not seem to work" would otherwise spend the card
 * twice, and the second render is the one nobody is expecting.
 *
 * ⚠ ONE WRITER PER FILE, and the write is atomic. Copied deliberately from
 * roster.js: a half-written row here is an order whose state nobody can read,
 * and the recovery for that is worse than the cost of doing it properly. A read
 * that fails is a REFUSAL and never an empty list — the same rule the roster
 * learned the hard way, for the same reason: "there are no orders" and "I could
 * not read the orders" must not look alike to a caller that is about to decide
 * whether it already rendered something.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ID_RE = /^o_[0-9a-f]{12}$/;

/** Every state an order row can be in, on either side. */
export const ORDER_STATES = Object.freeze([
  "sent",       // owner: written and handed over; nothing has come back
  "returned",   // owner: a return arrived and passed its checks; in quarantine
  "adopted",    // owner: a human pressed Adopt and it is a take now
  "refused",    // owner: a return arrived and did not pass; kept for the reason
  "cancelled",  // owner: given up on
  "claimed",    // lender: the id is taken while the project is being built
  "landed",     // lender: read, validated, a proposed plan exists
  "rendered",   // lender: the plan finished and a return was written
  "declined",   // lender: a human said no, or the machine was not free
]);

function refuse(reason, message, status = 400) {
  const err = new Error(message);
  err.reason = reason;
  err.status = status;
  return err;
}

/* ⚠ `collabDir` IS ALREADY <output>/collab. The door set that convention when
 * `pack` and `open` were written, and a module that appends "collab" again
 * writes into <output>/collab/collab — which is where every one of these
 * files landed until the harness walked the branch. */
const bookDir = (collabDir, side) => path.join(collabDir, "orders", side === "in" ? "in" : "out");
const rowPath = (outDir, side, id) => path.join(bookDir(outDir, side), `${id}.json`);

/* Serialised the way roster.js serialises: one promise chain, so two callers
 * racing on the same order cannot interleave a read and a write. */
let tail = Promise.resolve();
function enqueue(fn) {
  const next = tail.then(fn, fn);
  tail = next.then(() => {}, () => {});
  return next;
}

async function writeAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await rename(tmp, file);
  } catch (err) {
    /* A half-written row is worse than no row. */
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function readRow(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    /* ⚠ NOT NULL. A row this machine cannot READ is not a row that does not
     * exist, and the difference decides whether an order gets rendered twice. */
    throw refuse("orderbook-unreadable", `The order at ${file} exists and could not be read: ${err.message}. Nothing was decided about it. Fix the permissions on that file rather than deleting it — it is the record of whether this order has already been rendered.`, 500);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw refuse("orderbook-unreadable", `The order at ${file} is not readable JSON. It was not overwritten. Move it aside if you are sure it is rubbish; while it is there, this machine cannot tell whether that order was already rendered.`, 500);
  }
}

/** The owner's side: remember an order as it goes out. */
export async function rememberOrder({ outDir, row } = {}) {
  const id = String(row?.id || "");
  if (!ID_RE.test(id)) throw refuse("bad-arguments", "An order row needs the order's own id.");
  return enqueue(async () => {
    const file = rowPath(outDir, "out", id);
    if (await readRow(file)) throw refuse("order-exists", `Order ${id} is already in the book. An id is made fresh for every order; two orders sharing one is a bug, not a resend.`, 409);
    const full = { ...row, state: "sent", sentAt: row.sentAt ?? row.at ?? 0, returns: [] };
    await writeAtomic(file, full);
    return full;
  });
}

/** The lender's side: remember that an order was landed here. */
export async function landOrderRow({ outDir, row } = {}) {
  const id = String(row?.id || "");
  if (!ID_RE.test(id)) throw refuse("bad-arguments", "A landed order needs the order's own id.");
  return enqueue(async () => {
    const file = rowPath(outDir, "in", id);
    const had = await readRow(file);
    if (had) {
      /* ⚠ THE GUARD THAT STOPS A DOUBLE SPEND. */
      throw refuse("already-landed", `Order ${id} was already accepted here on ${new Date(had.landedAt || 0).toLocaleString()} — it is project ${had.slug || "?"}, ${had.state || "landed"}. Opening the same bundle again does not render it again; if your friend wants it rendered a second time they can send a new order.`, 409);
    }
    const full = { ...row, state: row.state === "claimed" ? "claimed" : "landed", landedAt: row.landedAt ?? 0 };
    await writeAtomic(file, full);
    return full;
  });
}

/**
 * Let go of a claim that never became anything.
 *
 * ⚠ THE CLAIM IS TAKEN BEFORE THE WORK AND RELEASED IF THE WORK FAILS. Landing
 * used to be the LAST step, so a bundle sent twice built two projects, staged
 * two copies of every picture and proposed two plans before the guard was
 * consulted at all — and the second plan renders into a project nothing can
 * find, which is spent electricity whose take goes nowhere. Claiming first
 * inverts that; releasing on failure is what stops a crash halfway through from
 * blocking an honest retry for ever.
 */
export async function releaseOrder({ outDir, id, side = "in" } = {}) {
  return enqueue(async () => {
    const file = rowPath(outDir, side, String(id));
    const row = await readRow(file);
    if (!row || row.state !== "claimed") return null;
    await rm(file, { force: true });
    return row;
  });
}

/**
 * Fill in a claimed row once the work behind it exists.
 *
 * Separate from `landOrderRow` because that one REFUSES an id it has seen
 * before — which is the whole point of it — so the step that turns a claim into
 * a landing cannot go through the same door. An earlier version tried, caught
 * its own guard, and answered `already-landed` about an order it had claimed
 * four lines earlier.
 */
export async function fillOrderRow({ outDir, id, side = "in", patch } = {}) {
  return enqueue(async () => {
    const file = rowPath(outDir, side, String(id));
    const row = await readRow(file);
    if (!row) throw refuse("no-such-order", `Order ${id} is not in this machine's book.`, 404);
    const next = { ...row, ...patch, stateAt: Date.now() };
    await writeAtomic(file, next);
    return next;
  });
}

/** One row, or null. Refuses only when a row exists and cannot be read. */
export async function findOrder({ outDir, id, side = "out" } = {}) {
  if (!ID_RE.test(String(id || ""))) return null;
  return enqueue(() => readRow(rowPath(outDir, side, String(id))));
}

/** Every row on one side, newest first. */
export async function listOrders({ outDir, side = "out" } = {}) {
  return enqueue(async () => {
    const dir = bookDir(outDir, side);
    let names = [];
    try {
      names = (await readdir(dir)).filter((f) => /^o_[0-9a-f]{12}\.json$/.test(f));
    } catch (err) {
      if (err && err.code === "ENOENT") return [];
      throw refuse("orderbook-unreadable", `The order book at ${dir} could not be listed: ${err.message}.`, 500);
    }
    const rows = [];
    for (const f of names) rows.push(await readRow(path.join(dir, f)));
    return rows.filter(Boolean).sort((a, b) => (b.at || 0) - (a.at || 0));
  });
}

/** Move a row's state, refusing a state nobody wrote down. */
export async function setOrderState({ outDir, id, side = "out", state, note = null } = {}) {
  if (!ORDER_STATES.includes(String(state))) {
    throw refuse("bad-state", `${JSON.stringify(state)} is not one of ${ORDER_STATES.join(", ")}.`);
  }
  return enqueue(async () => {
    const file = rowPath(outDir, side, String(id));
    const row = await readRow(file);
    if (!row) throw refuse("no-such-order", `Order ${id} is not in this machine's book.`, 404);
    const next = { ...row, state: String(state), stateAt: Date.now() };
    if (note !== null) next.note = String(note).slice(0, 400);
    await writeAtomic(file, next);
    return next;
  });
}

/**
 * Note that something came back, whether or not it was accepted.
 *
 * ⚠ A REFUSED RETURN IS KEPT. It is the only record that a friend sent
 * something this machine would not take, and the reason is the only thing that
 * tells them what to fix. Dropping it turns a refusal into silence.
 */
export async function noteReturn({ outDir, id, entry } = {}) {
  return enqueue(async () => {
    const file = rowPath(outDir, "out", String(id));
    const row = await readRow(file);
    if (!row) throw refuse("no-such-order", `A return arrived for order ${id}, which is not one this machine sent. Nothing was written.`, 404);
    const next = { ...row, returns: [...(row.returns || []), { at: Date.now(), ...entry }] };
    await writeAtomic(file, next);
    return next;
  });
}
