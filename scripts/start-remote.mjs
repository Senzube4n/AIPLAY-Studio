/** The launcher's "RunPod GPU" mode: the full local interface, Images and Video rendered on your own RunPod Pod
 *  (server/engine/remote-*.js), no local ComfyUI. Opt-in per process, like start-cloud.mjs. */
process.env.AIPLAY_REMOTE_ONLY = "1";
process.env.AIPLAY_MUSIC_ONLY = "0";
process.env.AIPLAY_CLOUD_ONLY = "0";
await import("../server/index.js");
