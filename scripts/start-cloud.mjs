/** The launcher's "Use Comfy API" mode: hosted models on your Comfy key, no ComfyUI. Opt-in per process. */
process.env.AIPLAY_CLOUD_ONLY='1';
process.env.AIPLAY_MUSIC_ONLY='0';
await import('../server/index.js');
