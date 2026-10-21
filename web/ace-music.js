/** Music form readiness and explicit reference preset; no rendering backend. */
export function aceReadinessLabel(row) {
  return row?.ready ? row.inferenceValidated ? 'This worker tested' : 'Ready for a test'
    : !row?.workerConnected ? 'AI service offline' : !row.filesDownloaded ? 'Model files needed'
    : !row.filesVerified ? 'Check model hashes' : 'Workflow needs attention';
}
export function mountAceMusic({ getState, readSpec, applyPreset, openSetup, doc = document, fetchFn = fetch }) {
  const $ = id => doc.getElementById(id), root = $('aceMusicPanel');
  if (!root) return { paint() {} };
  const duration = $('maxDur'), label = doc.querySelector('label[for="maxDur"]'), value = duration?.closest('.pv');
  const anchor = doc.createComment('Music duration home'); label?.before(anchor);
  let timer, revision = 0, key = '', checkedAt = 0;
  const choice = () => (getState().musicModels || []).find(c => c.engine === 'ace-step15' && c.dit === getState().musicAceModel);
  function invalidate() { ++revision; checkedAt = 0; $('aceMusicChip').textContent = 'Check current setup'; $('aceMusicChip').className = 'chip'; $('aceMusicHistory').hidden = true; }
  async function check(verify = false) {
    if (getState().musicEngine !== 'ace-step15') return;
    const epoch = ++revision;
    $('aceMusicCheck').disabled = true;
    try {
      const spec = readSpec();
      const response = await fetchFn('/api/music/ace-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...spec, verify }) });
      const row = await response.json(); if (epoch !== revision) return;
      if (!response.ok) throw Error(row.error || 'Model setup could not be checked.');
      $('aceMusicChip').textContent = aceReadinessLabel(row); $('aceMusicChip').className = 'chip ' + (row.ready ? 'ok' : 'warn');
      $('aceMusicMessage').textContent = row.error || (row.ready ? '' : 'Check the AI connection, selected files and workflow.');
      const list = $('aceMusicReadiness'); list.replaceChildren();
      for (const [name, done] of [['AI connected', row.workerConnected], ['Files installed', row.filesDownloaded], ['Hashes verified', row.filesVerified], ['Workflow checked', row.workflowValidated], ['This worker inference', row.inferenceValidated]]) {
        const l = doc.createElement('label'), v = doc.createElement('span'); l.textContent = name; v.textContent = done ? 'Yes' : 'Not verified'; v.className = 'pv'; list.append(l,v);
      }
      $('aceMusicHistory').hidden = !row.historicalHardwareValidated;
      $('aceMusicHistory').textContent = 'Historical A100 workflow';
      $('aceMusicHistory').title = 'Past hardware acceptance only; files, connection and inference on this computer are checked separately.';
      checkedAt = Date.now();
    } catch (e) {
      if (epoch !== revision) return;
      $('aceMusicChip').textContent = 'Setup needs checking'; $('aceMusicChip').className = 'chip warn';
      $('aceMusicMessage').textContent = e.message; $('aceMusicHistory').hidden = true;
    } finally { if (epoch === revision) { checkedAt = Date.now(); $('aceMusicCheck').disabled = false; } }
  }
  function soon() { clearTimeout(timer); invalidate(); timer = setTimeout(() => { timer = null; check(false); }, 600); }
  function paint() {
    const state = getState(), active = state.musicEngine === 'ace-step15'; root.hidden = !active;
    if (active && label && value) { if (label.parentNode !== $('aceDuration')) $('aceDuration').append(label,value); }
    else if (anchor.parentNode && label && value && label.parentNode !== anchor.parentNode) { anchor.after(label,value); }
    if ($('aceLocalInputs')) $('aceLocalInputs').hidden = !!state.remoteOnly;
    const reference = choice()?.hardwareAcceptance; $('aceMusicPreset').hidden = !active || !reference;
    $('aceMusicPreset').disabled = !!reference && !choice()?.lms?.includes(reference.workload.lm);
    $('aceMusicPreset').title = $('aceMusicPreset').disabled ? 'Install the 4B planner to use this reference preset.' : 'Fill the accepted test settings without starting generation.';
    const next = JSON.stringify([state.remoteOnly, state.musicAceModel, choice()?.lm, choice()?.available]);
    if (next !== key) { key = next; soon(); }
    else if (active && Date.now() - checkedAt > 30000 && !timer) soon();
  }
  $('aceMusicPreset').addEventListener('click', () => { const reference = choice()?.hardwareAcceptance; if (reference) { applyPreset(reference); soon(); } });
  $('aceMusicSetup').addEventListener('click', () => openSetup?.());
  $('aceMusicCheck').addEventListener('click', () => { clearTimeout(timer); timer = null; check(true); });
  const ids = new Set(['caption','capMeta','capVocal','capArr','lyrics','maxDur','aLm','aSteps','aCfg','aBpm','aKey','aMeter','aLang','aCodes','aPlanTemp','aLora','aCoverSong','seed','modeSong','modeInstr']);
  for (const type of ['input','change','click']) doc.addEventListener(type, event => { if (getState().musicEngine === 'ace-step15' && ids.has(event.target.id)) soon(); });
  paint(); return { paint, check, invalidate, dispose() { clearTimeout(timer); ++revision; } };
}
