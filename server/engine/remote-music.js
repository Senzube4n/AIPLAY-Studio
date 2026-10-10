/** Wait for one paid remote music render without losing a rejected Stop request. */
export async function awaitRemoteMusicJob({ client, sent, isCancelled, onState, wait = () => new Promise(resolve => setTimeout(resolve, 2500)) }) {
  const final = new Set(["completed", "cancelled", "failed", "uncertain"]);
  let stopAccepted = false;
  for (;;) {
    await wait();
    const row = client.status().jobs.find(job => job.id === sent.id);
    if (!row) continue;
    if (isCancelled() && !stopAccepted && !final.has(row.state)) {
      try {
        await client.cancel(sent.id);
        stopAccepted = true;
        onState("Stop accepted; waiting for Pod");
      } catch (error) {
        // A worker reconciling a prompt has no prompt ID to cancel yet. A
        // network failure is equally inconclusive; retry on the next poll.
        onState(`Stop not confirmed; retrying (${String(error.message || error).slice(0, 120)})`);
      }
    } else onState(row.state);
    if (!final.has(row.state)) continue;
    if (row.state !== "completed") {
      const message = row.state === "uncertain"
        ? `The Pod could not confirm whether this render ran: ${row.error || "status unavailable"} Check the Pod before starting another paid render.`
        : row.error || `The RunPod job ended ${row.state}.`;
      const error = new Error(message);
      error.remoteState = row.state;
      throw error;
    }
    const audio = (row.outputs || []).find(output => /\.(wav|flac|mp3|ogg|opus)$/i.test(output.localFile || output.file || ""));
    if (!audio?.localFile) throw new Error("The Pod finished but returned no audio file.");
    return { file: audio.localFile, runId: row.runId || sent.runId || null };
  }
}
