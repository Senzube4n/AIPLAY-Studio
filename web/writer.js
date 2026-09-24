/**
 * IS THERE A WRITING MODEL? One answer for the three Simple boxes (Music in
 * web/chat.js, Pictures and Video in web/assist.js), read again at every press
 * of their Make button until it is yes, because the answer changes while
 * Studio runs: the engine finishes starting, a download lands a text encoder,
 * an API key is connected.
 *
 * From the list GET /api/chat/music/models answers (server/chat/models.js
 * status()):
 *
 *   true   something can answer: a local text encoder, or a connected API;
 *   false  the engine answered, and it has none;
 *   null   NOT KNOWN: the engine did not answer (`offline`, which is also what
 *          a normal start looks like for its first minute), or Studio itself
 *          did not answer. Never taken for "none": that would make the Make
 *          button skip the assistant for the whole visit.
 *
 * When it is null, whyNoWriter() asks /api/status whether the engine is on its
 * way (say so and send nothing) or is not part of this mode at all (Music only
 * with the native engine: no local writing model can ever answer there, so it
 * is the same as none).
 */
export function writerFrom(d) {
  if (Array.isArray(d?.models) && d.models.length > 0) return true;
  if (!d || d.offline) return null;
  return false;
}

/** {kind: "starting" | "noengine" | "nostudio", musicOnly} */
export async function whyNoWriter() {
  let s = null;
  try { s = await (await fetch("/api/status")).json(); } catch { return { kind: "nostudio", musicOnly: false }; }
  const c = s?.config || {};
  return { kind: c.engineExpected ? "starting" : "noengine", musicOnly: !!c.musicOnly };
}

/** The line for a Make press that cannot reach a writing model yet. */
export function notYetLine(kind, make) {
  return kind === "nostudio"
    ? `Studio did not answer. Press ${make} again in a moment.`
    : `The engine is still starting, so the writing model cannot answer yet. Press ${make} again in a moment.`;
}
