/** A RefMod writer keeps its queue slot and filename until its exact prompt is gone. */
export async function runRefMod(engine, spec, { onAwaiting = () => {}, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const done = await engine.run(spec);
  if (!done.promptId) return done; // preflight failures never entered the engine
  const target = { runId: done.runId, promptId: done.promptId };
  onAwaiting(done);
  // The door's watcher can end on timeout, polling failure or cancellation while
  // ComfyUI is still writing. A stopped acknowledgement is not proof of exit.
  if (done.status !== "completed") await engine.cancelRun(target).catch(() => {});
  for (;;) {
    let gone = false;
    try {
      const queue = await engine.queue();
      const lists = [queue?.queue_running, queue?.queue_pending];
      // A partial/malformed response is unknown, never evidence of an empty queue.
      const readable = lists.every((list) => Array.isArray(list)
        && list.every((row) => Array.isArray(row) && typeof row[1] === "string" && row[1].length > 0));
      gone = readable && lists.every((list) => list.every((row) => row[1] !== done.promptId));
    } catch { /* retain the lease until the engine answers again */ }
    if (gone) return done;
    await sleep(spec.pollMs || 1000);
  }
}
