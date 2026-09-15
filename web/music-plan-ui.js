// Music-page controls for supplied notation. No renders, writes or model loads.
export function mountMusicPlan({ document: doc = document, fetch: request = fetch } = {}) {
  const el = id => doc.getElementById(id);
  if (!el("yAbc") || el("yAbc").dataset.mounted) return;
  el("yAbc").dataset.mounted = "1";
  let proposal = null, ticket = 0;
  const message = text => { el("yPlanResult").textContent = text; };
  const invalidate = () => { ticket++; proposal = null; el("yPlanApply").disabled = true; };
  const seconds = n => `${Math.floor(Math.round(n) / 60)}:${String(Math.round(n) % 60).padStart(2, "0")}`;
  const invalidateEdit = () => { invalidate(); message("Changed — check again before applying a proposed tempo. No song has been generated."); };
  for (const id of ["yAbc", "yPlanBpm", "yPlanMeter"]) el(id).addEventListener("input", invalidateEdit);
  el("yPlanLength").addEventListener("input", () => {
    el("yPlanLengthValue").textContent = seconds(Number(el("yPlanLength").value)); invalidateEdit();
  });
  el("yAbcFile").addEventListener("change", async () => {
    invalidate(); const mine = ticket, file = el("yAbcFile").files?.[0];
    if (!file) return;
    if (file.size > 65536) return message("ABC file is too large (64 KiB maximum). Nothing was loaded.");
    try {
      const text = await file.text(); if (ticket !== mine) return;
      el("yAbc").value = text;
      message("Notation loaded into this draft only. Check it, then enable ‘Use this score’ to send it with Create.");
    } catch (error) { if (ticket === mine) message(`Could not read the score: ${error.message}`); }
  });
  async function plan(mode) {
    invalidate(); const mine = ticket, original = el("yAbc").value;
    const body = mode === "outline"
      ? { bpm: Number(el("yPlanBpm").value), meter: el("yPlanMeter").value, target_seconds: Number(el("yPlanLength").value) }
      : { abc: original, ...(mode === "length" ? { target_seconds: Number(el("yPlanLength").value) }
        : mode === "tempo" ? { bpm: Number(el("yPlanBpm").value) } : {}) };
    message("Checking notation — no model or GPU is used…");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await request("/api/music-plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      const result = await res.json(); if (ticket !== mine) return;
      if (!res.ok || result.error) throw new Error(result.error || "Planning failed.");
      if (!result.ok) {
        const problems = (result.problems || []).slice(0, 3).map(p => typeof p === "string" ? p : p.says || p.message || p.detail || JSON.stringify(p)).join("; ");
        return message(`Score needs attention: ${problems || "outside the supported two-voice ABC dialect"}. No changes applied.`);
      }
      message(`${result.bars} bars · ${result.bpm} quarter-note BPM · ${seconds(result.nominal_seconds)} notation time. ${result.mode === "outline" ? "Outline only — write/import a score to steer the model. " : ""}${result.changed ? "Proposed tempo only; review and apply below. " : ""}Actual audio can be shorter or longer; this is not audio extension.`);
      if (result.changed && result.abc) { proposal = { abc: result.abc, original }; el("yPlanApply").disabled = false; }
    } catch (error) { if (ticket === mine) message(error.name === "AbortError" ? "Planning timed out. No changes applied." : error.message); }
    finally { clearTimeout(timer); }
  }
  for (const [id, mode] of [["yPlanOutline", "outline"], ["yPlanCheck", "check"], ["yPlanFit", "length"], ["yPlanTempo", "tempo"]]) {
    el(id).addEventListener("click", () => plan(mode));
  }
  el("yPlanApply").addEventListener("click", () => {
    if (!proposal || proposal.original !== el("yAbc").value) return invalidateEdit();
    el("yAbc").value = proposal.abc; invalidate();
    message("Proposed tempo applied to this draft only. Match BPM in your style prompt. Enable ‘Use this score’ and press Create when ready; that generates a new take, not a continuation.");
  });
}
