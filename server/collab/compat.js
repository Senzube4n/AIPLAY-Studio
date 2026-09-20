/**
 * CAN THESE TWO STUDIOS WORK TOGETHER, AND WHOSE BUILD MADE THIS FILE.
 *
 * Two questions that look like one and must never be answered by one number:
 *
 *   THE DECISION   `speaks(v)` reads the packet's protocol number and NOTHING
 *                  else. Not the build, not the date, not who forked from whom,
 *                  and never the network. An older Studio must be able to
 *                  decide offline, from the bytes in front of it, and a restyled
 *                  screen must never make a friend's file stop opening.
 *   THE LABEL      `stamp()` writes the sender's build line onto an outgoing
 *                  packet so a person can SEE who made it and ask them to
 *                  update. It is a caption. Nothing reads it back to decide
 *                  anything, which is the property `version_test.js` pins.
 *
 * So this module imports the version for the caption, and `speaks()` is written
 * beside it to make the separation obvious rather than promised in a comment.
 */
import { PACKET_V } from "./packet.js";
import { appVersion } from "../version.js";

export { PACKET_V };

/**
 * THE ONE COMPATIBILITY DECISION IN COLLAB.
 *
 * @param {unknown} v the packet's own `v`
 * @returns {{ ok: boolean, reason: string, why: string, theirs: number|null }}
 */
export function speaks(v) {
  const theirs = Number.isFinite(Number(v)) ? Number(v) : null;
  if (theirs === null) {
    return { ok: false, theirs, reason: "no-protocol",
      why: "This file carries no Collab protocol number, so there is no way to tell what it is. Nothing was read from it." };
  }
  if (theirs > PACKET_V) {
    return { ok: false, theirs, reason: "protocol-newer",
      why: `This file was made by a newer Studio: it speaks Collab ${theirs} and this one speaks ${PACKET_V}. `
        + "Update this Studio and open it again. Nothing was read from it, and nothing about it is wrong — it is simply from the future." };
  }
  if (theirs < PACKET_V) {
    /* Older is readable: every change that would break reading moves the
     * number, and a build that moves it is required to say here what it does
     * with the version below (VERSIONING.md carries that table). */
    return { ok: true, theirs, reason: "protocol-older",
      why: `Made by an older Studio (Collab ${theirs}; this one speaks ${PACKET_V}). It opens here, but anything they send back may miss what was added since.` };
  }
  return { ok: true, theirs, reason: "", why: "" };
}

/**
 * The caption that rides along on everything sealed. Small on purpose: the
 * build line, the commit and the protocol, and not one fact about the machine.
 */
export function stamp() {
  const v = appVersion();
  return { app: v.line, commit: v.commit || null, protocol: PACKET_V };
}

/** "B 26.09.20 · 88b607e · collab 1", for a row or a card. */
export function describeStamp(by) {
  if (!by || typeof by !== "object") return "";
  return [by.app, by.commit, Number.isFinite(Number(by.protocol)) ? `collab ${Number(by.protocol)}` : ""]
    .filter(Boolean).join(" · ");
}

/**
 * What to say about a friend's build next to their name.
 *
 * `mine` is passed in rather than read, so a test can ask what a build three
 * protocols ahead would say without pretending to be one.
 */
export function friendNote(by, mine = PACKET_V) {
  if (!by) return { text: "", level: "" };
  const theirs = Number(by.protocol);
  if (!Number.isFinite(theirs)) return { text: describeStamp(by), level: "" };
  if (theirs === mine) return { text: describeStamp(by), level: "ok" };
  return {
    text: `${describeStamp(by)} — ${theirs > mine ? "newer than this Studio; update to open what they send" : "older than this Studio; they may not open what you send"}`,
    level: "warn",
  };
}
