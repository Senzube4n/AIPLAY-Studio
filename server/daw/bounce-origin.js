/** Authorship and sample licensing are separate facts. Retain both on export. */
export function bounceOrigin(doc, credits = []) {
  const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
  const notes = tracks.flatMap((t) => (t.clips || []).flatMap((c) => c.notes || []));
  if (notes.some((n) => n.by === "agent")) return "composite-synthetic";
  // Importing a file does not establish who composed or performed its contents.
  if (tracks.some((t) => (t.audioClips || []).length)) return "composite";
  if (credits.some((c) => c.attribution)) return "third-party-licensed";
  return notes.length ? "human-authored" : "composite";
}
