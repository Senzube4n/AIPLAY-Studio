/** Wait for an image submitted through the normal Image API, including cache hits
 * which can land before its HTTP response. Never confuse another queued job's
 * success/failure with this editor request. */
export function requestImageAndWait({ art, submit, options, actor, timeoutMs = 3_600_000 }) {
  return new Promise((resolve, reject) => {
    let file = null, settled = false;
    const early = [];
    const cleanup = () => {
      clearTimeout(timer);
      art.off("cover", onCover);
      art.off("failed", onFailed);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error); else resolve(result);
    };
    const receive = (event, failed) => {
      if (settled) return;
      if (!file) { early.push({ event, failed }); return; }
      if (event.file !== file) return;
      if (failed) return finish(new Error(event.error || "The image generation failed."));
      const name = event.covers?.[0];
      if (!name) return finish(new Error("The image generation returned no image."));
      finish(null, { name, runId: event.runId || null, seed: event.seed ?? null });
    };
    const onCover = event => receive(event, false);
    const onFailed = event => receive(event, true);
    const timer = setTimeout(() => finish(new Error("The image generation timed out; inspect the job queue before retrying.")), timeoutMs);
    art.on("cover", onCover);
    art.on("failed", onFailed);
    Promise.resolve().then(() => submit({ ...options, action: "create", dedupe: false }, actor)).then(reply => {
      if (settled) return;
      if (!reply?.ok || !reply.id || !reply.job) throw new Error(reply?.error || "The image request was not queued.");
      file = `image:${reply.id}`;
      for (const item of early) receive(item.event, item.failed);
      early.length = 0;
    }).catch(error => finish(error));
  });
}
