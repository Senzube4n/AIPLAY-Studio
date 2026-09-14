/** Opt-in per process. Does not rewrite a full Studio user's preferences. */
process.env.AIPLAY_MUSIC_ONLY='1';
await import('../server/index.js');
