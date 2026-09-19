/**
 * HOW LYRICS SHOULD SOUND — one set of rules for every model that writes them:
 * the Simple assistant (chat/music-tools.js), the Chat tab (chat/loop.js),
 * ✨ Enhance (prompt-tools.js) and agents over MCP (mcp.js make_song).
 *
 * The owner's brief (2026-09-19): less like an AI, more human, less poetry,
 * more common words, and none of the stock images AI lyrics lean on (rooms,
 * doors, floors, ceilings, seams, dreams, skies…). The shape of the rules
 * follows common songwriting guidance for steering a model away from generic
 * output: name concrete people, places, objects and events instead of
 * feelings; talk the way people talk; don't force rhymes; give the chorus a
 * plain hook; and list the clichés to avoid by name, because "avoid clichés"
 * alone changes nothing.
 */

/* Words and images that mark lyrics as machine-written. Whole words, plurals
 * included, matched case-insensitively by lyricTells(). */
export const LYRIC_AVOID = [
  "room", "door", "floor", "ceiling", "seam", "dream", "sky", "skies", "neon", "echo", "echoes", "whisper",
  "shadow", "ember", "ashes", "tapestry", "symphony", "silhouette", "horizon", "stardust", "abyss", "void",
  "eternity", "infinite", "ignite", "unbreakable", "heartbeat", "soul", "journey", "cascade", "labyrinth",
  "mirror", "static", "gravity", "orbit", "constellation", "velvet", "crimson", "golden hour", "fading light",
  "broken heart", "heart of stone", "lost in the night", "chasing dreams", "tears like rain", "rise above",
  "the edge of", "through the storm", "set me free", "we will rise", "fire inside",
];

export const LYRIC_RULES = [
  "HOW TO WRITE LYRICS. Write like a person, not like an AI and not like a poem:",
  "- Everyday words and short plain sentences, the way people talk. Contractions are fine. No fancy or poetic words.",
  "- Tell it with specifics: a name, a street, a job, an object, a time of day, something that actually happened.",
  "  Show the situation instead of naming the feeling (not \"I'm so lonely\" but what they did alone last night).",
  "- Don't force rhymes. Near rhymes are fine; a line can end without one. Lines can be different lengths.",
  "- The chorus is a simple hook you could sing after one listen, and it repeats.",
  "- No motivational slogans, no stacked abstract nouns (\"hope and time and fate\"), no \"we will rise\".",
  `- Never use these words or images: ${LYRIC_AVOID.join(", ")}. Also avoid fire/desire, night/light and heart/apart rhymes.`,
];

/** Banned words that made it into a set of lyrics anyway (whole words, plurals too). */
export function lyricTells(text) {
  const t = String(text || "").toLowerCase();
  return LYRIC_AVOID.filter((w) => {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${esc}(s|es)?\\b`).test(t);
  });
}
