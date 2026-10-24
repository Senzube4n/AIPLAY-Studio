/** Music form readiness and explicit reference preset; no rendering backend. */
export function aceReadinessLabel(row) {
  return row?.stopped ? 'Computer stopped' : row?.ready ? row.inferenceValidated ? 'This worker tested' : 'Ready for a test'
    : !row?.workerConnected ? 'AI service offline' : !row.filesDownloaded ? 'Model files needed'
    : !row.filesVerified ? 'Check model hashes' : 'Workflow needs attention';
}
export function mountAceMusic({ getState, readSpec, applyPreset, openSetup, doc = document, fetchFn = fetch }) {
  const $ = id => doc.getElementById(id), root = $('aceMusicPanel');
  if (!root) return { paint() {} };
  const duration = $('maxDur'), label = doc.querySelector('label[for="maxDur"]'), value = duration?.closest('.pv');
  const anchor = doc.createComment('Music duration home'); label?.before(anchor);
  let timer, revision = 0, key = '', checkedAt = 0, history = null, previousModel;
  const choice = () => (getState().musicModels || []).find(c => c.engine === 'ace-step15' && c.dit === getState().musicAceModel);
  const contextKey = () => {
    const s = getState();
    return JSON.stringify([s.musicEngine, s.remoteOnly, s.musicAceModel, s.musicAceLm, choice()?.lm, choice()?.available,
      s.remoteOnly ? s.musicComputer : s.engineReady]);
  };
  function unavailable() {
    const s = getState(), c = s.musicComputer;
    if (!s.remoteOnly) return s.engineReady === false ? { error: 'Start the local AI service.' } : null;
    if (!Object.hasOwn(s, 'musicComputer')) return null; // Older status replies are checked by the backend.
    if (!c?.podId) return { error: 'Choose your cloud computer in Settings.' };
    if (c.status === 'EXITED') return { stopped: true, error: 'Start your cloud computer to generate music.' };
    if (c.status !== 'RUNNING' || c.providerUncertain || c.changing || !c.connectionReady)
      return { error: 'Check the selected computer and its AI connection in Settings.' };
    return null;
  }
  function paintHistory(row) {
    const earlier = row?.historicalInferenceEvidence || row?.inferenceEvidence;
    $('aceMusicHistory').hidden = !row?.historicalHardwareValidated && !earlier;
    $('aceMusicHistory').textContent = row?.historicalHardwareValidated ? 'Historical A100 workflow' : 'Previous worker test';
    $('aceMusicHistory').title = 'Historical evidence only; current connection, files and workflow are checked separately.'
      + (earlier ? ` Earlier inference: ${new Date(earlier.at).toLocaleString()}, worker ${earlier.workerId || 'local'}.` : '');
  }
  function render(row = {}, checking = false) {
    const connected = !!row.workerConnected && !row.stopped;
    row = { ...row, ready: connected && !!row.ready };
    $('aceMusicChip').textContent = checking ? 'Check current setup' : aceReadinessLabel(row);
    $('aceMusicChip').className = 'chip ' + (row.ready ? 'ok' : checking ? '' : 'warn');
    $('aceMusicMessage').textContent = row.error || (row.ready || checking ? '' : 'Check the AI connection, selected files and workflow.');
    const list = $('aceMusicReadiness'); list.replaceChildren();
    for (const [name, done] of [['AI connected', connected], ['Files installed', connected && row.filesDownloaded],
      ['Hashes verified', connected && row.filesVerified], ['Workflow checked', connected && row.workflowValidated],
      ['This worker inference', connected && row.inferenceValidated]]) {
      const l = doc.createElement('label'), v = doc.createElement('span'); l.textContent = name; v.textContent = done ? 'Yes' : 'Not verified'; v.className = 'pv'; list.append(l,v);
    }
    paintHistory(history);
  }
  function invalidate(keepHistory = false) {
    ++revision; checkedAt = 0; if (!keepHistory) history = null;
    $('aceMusicCheck').disabled = false; render(unavailable() || {}, !unavailable());
  }
  async function check(verify = false) {
    if (getState().musicEngine !== 'ace-step15') return;
    const epoch = ++revision, context = contextKey(), blocked = unavailable();
    if (blocked) { render(blocked); checkedAt = Date.now(); return; }
    $('aceMusicCheck').disabled = true;
    try {
      const spec = readSpec();
      const response = await fetchFn('/api/music/ace-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...spec, verify }) });
      const row = await response.json(); if (epoch !== revision || context !== contextKey()) return;
      if (!response.ok) throw Error(row.error || 'Model setup could not be checked.');
      if (row.ready && getState().remoteOnly && row.podId && row.podId !== getState().musicComputer?.podId)
        throw Error('The selected computer changed. Check again.');
      history = row; render(unavailable() || row);
      checkedAt = Date.now();
    } catch (e) {
      if (epoch !== revision || context !== contextKey()) return;
      render(unavailable() || { error: e.message });
    } finally { if (epoch === revision) { checkedAt = Date.now(); $('aceMusicCheck').disabled = false; } }
  }
  function soon(keepHistory = false) { clearTimeout(timer); invalidate(keepHistory); timer = setTimeout(() => { timer = null; check(false); }, 600); }
  function paint() {
    const state = getState(), active = state.musicEngine === 'ace-step15'; root.hidden = !active;
    if (active && label && value) { if (label.parentNode !== $('aceDuration')) $('aceDuration').append(label,value); }
    else if (anchor.parentNode && label && value && label.parentNode !== anchor.parentNode) { anchor.after(label,value); }
    if ($('aceLocalInputs')) $('aceLocalInputs').hidden = !!state.remoteOnly;
    const reference = choice()?.hardwareAcceptance; $('aceMusicPreset').hidden = !active || !reference;
    $('aceMusicPreset').disabled = !!reference && !choice()?.lms?.includes(reference.workload.lm);
    $('aceMusicPreset').title = $('aceMusicPreset').disabled ? 'Install the 4B planner to use this reference preset.' : 'Fill the accepted test settings without starting generation.';
    const next = contextKey();
    if (next !== key) { const keepHistory = previousModel === state.musicAceModel; previousModel = state.musicAceModel; key = next; soon(keepHistory); }
    else if (active && Date.now() - checkedAt > 30000 && !timer) soon(true);
  }
  $('aceMusicPreset').addEventListener('click', () => { const reference = choice()?.hardwareAcceptance; if (reference) { applyPreset(reference); soon(); } });
  $('aceMusicSetup').addEventListener('click', () => openSetup?.());
  $('aceMusicCheck').addEventListener('click', () => { clearTimeout(timer); timer = null; check(true); });
  const ids = new Set(['caption','capMeta','capVocal','capArr','lyrics','maxDur','aLm','aSteps','aCfg','aBpm','aKey','aMeter','aLang','aCodes','aPlanTemp','aLora','aCoverSong','seed','modeSong','modeInstr']);
  for (const type of ['input','change','click']) doc.addEventListener(type, event => { if (getState().musicEngine === 'ace-step15' && ids.has(event.target.id)) soon(); });
  paint(); return { paint, check, invalidate, dispose() { clearTimeout(timer); ++revision; } };
}
