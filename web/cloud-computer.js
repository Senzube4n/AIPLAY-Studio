import { appConfirm } from './dialog.js';
import { mountSetupPlanner, getSetupPlan } from './setup-plan.js';
const $ = id => document.getElementById(id);
const money = value => Number.isFinite(value) ? `$${value.toFixed(2)}` : 'Unavailable';
const bytes = value => Number.isFinite(value) ? `${(value / 1e9).toFixed(2)} GB` : 'Not checked';
let current = null, working = false, activeAction = '';
let accountConfigured = false, setupOverride = null;
let automaticInstall = null, installationPolling = false;
let cloudGoal = 'all', flowPage = null, flowModels = null, modelsPolling = false, modelsCheckedAt = 0;
let accountBalance = null;
let acceptanceKeySaved = false;
let planningTarget = 'runpod';
let flowEpoch = 0;
let actionError = null;
document.addEventListener('aiplay:runpod-balance', event => { accountBalance = event.detail; paintSetup(current); });
document.addEventListener('aiplay:model-plan', event => {
  const plan = event.detail; if (plan?.target !== 'runpod') return;
  ++flowEpoch;
  cloudGoal = plan.selection; flowModels = null; modelsCheckedAt = 0;
  paintSelectedReadiness([]); paintSetup(current); refreshFlowModels().catch(() => {});
});
async function refreshAutomaticInstall() {
  if (installationPolling) return;
  installationPolling = true;
  try {
    const response = await fetch('/api/runpod/install');
    if (response.ok) {
      const info = await response.json();
      if (info.podId && !current?.podId && !current?.removedPodIds?.includes(info.podId) && info.phase !== 'removed' && !working) await perform('/select', { id: info.podId });
      paintAutomaticInstall(info);
      $('cloudSetupProvision').disabled = ['creating', 'uncertain', 'waiting', 'connecting', 'failed'].includes(info.phase);
    }
  } finally { installationPolling = false; }
}
function paintAutomaticInstall(info) {
  const connectedBefore = automaticInstall?.podId === info.podId && automaticInstall?.workerConnected;
  automaticInstall = info;
  const managed = !['none','removed'].includes(info.phase) && !current?.removedPodIds?.includes(info.podId) && (!current?.podId || current.podId === info.podId);
  $('cloudAutomaticInstall').hidden = !managed;
  if (!managed) return;
  const stopped = current?.podId === info.podId && current?.pod?.status === 'EXITED';
  const online = !stopped && !current?.providerUncertain && info.workerConnected && current?.worker?.connectionReady;
  const names = { source: 'Downloading AIPLAY', runtime: 'Installing runtime', engine: 'Installing AI engine', dependencies: 'Installing dependencies', starting: 'Starting AI service', complete: 'AI service connected', failed: 'Installation needs attention' };
  chip('cloudAutomaticStatus', stopped ? 'Computer stopped' : info.workerConnected && !online ? 'Checking AI connection' : names[info.stage] || (info.phase === 'uncertain' ? 'Checking creation result' : info.phase === 'stopped' ? 'Computer stopped' : 'Preparing AI installation'), online ? 'ok' : info.error ? 'warn' : stopped ? '' : 'busy');
  $('cloudAutomaticHint').textContent = stopped ? 'Start your computer to check its saved AI installation.' : info.error || (online ? 'Choose the models you need below and review their licences.' : 'Installation continues on the cloud computer while it is running.');
  if (!info.workerConnected && ['waiting', 'connecting', 'uncertain', 'creating', 'failed'].includes(info.phase)) $('cloudSetupWorkerFields').hidden = true;
  const done = info.workerConnected ? 3 : info.stage ? 1 : 0;
  [...$('cloudAutomaticSteps').children].forEach((row, index) => { row.style.color = index < done ? 'var(--ok)' : ''; });
  if (info.workerConnected) {
    $('cloudSetupWorkerFields').hidden = true;
    if (!connectedBefore) document.dispatchEvent(new Event('aiplay:cloud-worker-connected'));
  }
}
export function cloudSetupStage(s, account, completed = false) {
  if (!account || ['credentials_missing', 'credentials_invalid'].includes(s?.issue?.code)) return 1;
  if (!s?.podId) return 2;
  if (completed && (s.pod?.status === 'EXITED' || s.operation?.type === 'stop')) return 5;
  if (s.providerUncertain || s.pod?.status !== 'RUNNING' || s.operation || !s.worker?.connectionReady || !s.worker?.generationReady) return 3;
  return s.idleMinutes === 0 || s.worker?.authorized && s.worker?.available ? 5 : 4;
}
function setupSaved(id) {
  try { return localStorage.getItem(`aiplay:cloud-setup:${id}`) === 'complete'; } catch { return false; }
}
export function cloudGoalReady(s, goal, bundles = [], readiness = []) {
  if (!s?.podId || s?.providerUncertain || s?.pod?.status !== 'RUNNING' || !s.worker?.connectionReady || !s.worker?.generationReady
    || s.operation || s.worker?.pending || s.worker?.frozen) return false;
  const needed = goalBundles(goal);
  return !!needed && needed.every(id => bundles.some(b => b.id === id && b.state === 'ready'))
    && (typeof goal !== 'object' || needed.length > 0 && needed.every(id => readiness.some(r => r.id === id && r.workflowValidated)));
}
function goalBundles(goal) { if (goal && typeof goal === 'object') return Object.values(goal); return { music: ['yue2-comfy'], pictures: ['sdxl-turbo'], video: ['ltx25'], all: ['yue2-comfy', 'sdxl-turbo', 'ltx25'] }[goal]; }
export function cloudInstallationProgress(s, goal, bundles = [], installation, readiness = []) {
  const running = s?.pod?.status === 'RUNNING' && !s.providerUncertain && !s.operation;
  const connected = running && !!s.worker?.connectionReady;
  const models = connected && !!goalBundles(goal)?.every(id => bundles.some(b => b.id === id && b.state === 'ready'));
  const protectedStop = s?.idleMinutes === 0 || s?.worker?.authorized && s?.worker?.available;
  const workflow = typeof goal === 'object' ? goalBundles(goal).length > 0 && goalBundles(goal).every(id => readiness.some(r => r.id === id && r.workflowValidated)) : !!s?.worker?.generationReady;
  const complete = [running, connected, models, models && workflow, models && workflow && !!protectedStop];
  const first = complete.findIndex(done => !done);
  const failed = running && installation?.podId === s?.podId && installation?.stage === 'failed' && !connected ? 1
    : connected && bundles.some(b => goalBundles(goal)?.includes(b.id) && b.state === 'failed') ? 2 : -1;
  return { complete: complete.every(Boolean), done: complete.filter(Boolean).length,
    steps: complete.map((done, i) => done ? 'done' : i === failed ? 'failed' : i === first ? 'current' : 'waiting') };
}
function paintInstallation(s, bundles) {
  const state = cloudInstallationProgress(s, cloudGoal, bundles, automaticInstall, flowModels?.podId && flowModels.podId === s?.podId ? flowModels.readiness : []), running = s?.pod?.status === 'RUNNING' && !s.providerUncertain;
  const failed = state.steps.includes('failed');
  const changing = !!s?.operation;
  $('cloudInstallTitle').textContent = changing ? 'Checking computer change' : s?.providerUncertain ? 'Check computer status' : failed ? 'Setup needs attention' : state.complete ? 'Ready for a generation test' : running ? 'Setting up your AI' : 'Start to continue setup';
  $('cloudInstallHint').textContent = running && (bundles.some(b => b.state === 'downloading') || !s.worker?.connectionReady && automaticInstall?.podId === s?.podId)
    ? 'You can leave this screen; setup continues on your cloud computer.' : 'Choose your models and review their licences below.';
  if (failed) $('cloudInstallHint').textContent = state.steps[1] === 'failed' ? 'AI installation failed; open Installation details to review it.' : 'A model download failed; review its access and try again.';
  chip('cloudInstallComputer', running ? 'Computer: Running' : s?.providerUncertain ? 'Computer: Unavailable' : 'Computer: Stopped', running ? 'ok' : '');
  const aiReady = cloudGoalReady(s, cloudGoal, bundles, flowModels?.podId && flowModels.podId === s?.podId ? flowModels.readiness : []), downloading = bundles.some(b => b.state === 'downloading');
  chip('cloudInstallAI', changing ? 'AI: Waiting' : aiReady ? 'AI: Workflow checked' : downloading && running ? 'AI: Downloading' : running ? s.worker?.connectionReady ? 'AI: Models needed' : 'AI: Installing' : 'AI: Offline', aiReady ? 'ok' : running ? 'busy' : '');
  $('cloudInstallProgress').value = state.done; $('cloudInstallProgress').setAttribute('aria-valuetext', `${state.done} of 5 setup checks complete`);
  [...$('cloudInstallChecklist').children].forEach((row, i) => { row.dataset.state = state.steps[i]; if (state.steps[i] === 'current') row.setAttribute('aria-current','step'); else row.removeAttribute('aria-current'); });
  $('cloudInstallStop').disabled = working || !running || !s.worker?.connectionReady || !!s.operation;
  $('cloudInstallStopHint').textContent = running && !s.worker?.connectionReady ? 'Rental is running; safe shutdown becomes available when the AI service connects.' : 'Rental runs while the computer is running.';
}
export function cloudFlowPage(s, account, ready, override) {
  if (override === 'where') return 'where';
  if (!account) return 'goal';
  if (override === 'goal' || override === 'costs' || ['install', 'ready'].includes(override) && s?.podId) return override;
  if (!s?.podId) return override ? 'costs' : 'goal';
  if (s.pod?.status === 'EXITED' || ready) return 'ready';
  return 'install';
}
/** Presentation only. Provider confirmation and existing guarded routes remain authoritative. */
export function cloudManagementState(s, { ready = false, bundles = [], installation } = {}) {
  const pending = !!s?.operation || !!s?.worker?.pending || !!s?.worker?.frozen, certain = !s?.providerUncertain;
  const running = !!s?.podId && certain && s?.pod?.status === 'RUNNING';
  const connected = running && !!s?.worker?.connectionReady;
  const busy = connected && s.worker.workload?.known === true && s.worker.workload.busy === true;
  let state = !s?.podId ? 'empty' : 'offline';
  if (s?.providerUncertain || s?.operation?.stage === 'uncertain') state = 'uncertain';
  else if (s?.operation?.type === 'stop' || s?.worker?.pending || ['waiting_to_stop','stopping'].includes(s?.phase)) state = 'stopping';
  else if (s?.operation?.type === 'start' || ['PROVISIONING','STARTING'].includes(s?.pod?.status)) state = 'starting';
  else if (s?.pod?.status === 'EXITED') state = 'stopped';
  else if (s?.issue || s?.pod?.status === 'ERROR' || connected && s.worker.workload?.known === false || bundles.some(b => b.state === 'failed') || !connected && installation?.stage === 'failed') state = 'failed';
  else if (running && (bundles.some(b => ['downloading','verifying','installing'].includes(b.state)) || s.worker?.workload?.installing || !connected && ['waiting','connecting','creating'].includes(installation?.phase))) state = 'installing';
  else if (busy) state = 'generating';
  else if (connected && ready && s.worker.workload?.known !== true) state = 'activity_unknown';
  else if (connected && ready) state = 'ready';
  else if (connected) state = 'models_needed';
  const label = {empty:'No computer yet',offline:'AI connection needed',models_needed:'Models need setup',activity_unknown:'AI activity not checked',uncertain:'Check provider status',stopping:'Stopping computer',starting:'Starting computer',stopped:'Computer stopped',failed:'Action needs attention',installing:'Installing models',generating:'Work in progress',ready:'Ready to generate'}[state];
  const recovery = state === 'uncertain' ? 'Shutdown is not confirmed; check status again or check RunPod if the connection stays unavailable.'
    : state === 'stopped' ? 'GPU rental has stopped; saved storage continues billing.'
    : state === 'failed' ? s?.issue?.message || (connected && s.worker.workload?.known === false ? 'AI activity could not be checked; rental is still running. Check the AI connection.' : 'Review installation details, then check status before retrying.')
    : state === 'offline' ? 'Connect or update the AI service to continue; rental may still be running.'
    : state === 'activity_unknown' ? 'Update the AI service in Advanced setup to see current work.' : '';
  return {state,label,recovery,busy,canStart:!!s?.podId && certain && !pending && ['EXITED','ERROR'].includes(s?.pod?.status),canStop:connected && !pending && s.worker.workload?.known !== false,canGenerate:connected && ready && !pending && !s?.issue && s.worker.workload?.known !== false};
}
export function currentFlowReply(s, podId, selection, data) {
  return s?.podId === podId && s?.pod?.status === 'RUNNING' && !s.providerUncertain && !s.operation
    && !!s.worker?.connectionReady && !s.worker.pending && !s.worker.frozen
    && data?.podId === podId && JSON.stringify(data.selection) === JSON.stringify(selection);
}
export function cloudReplyContext(s) {
  return JSON.stringify([s?.podId,s?.pod?.status,s?.pod?.startedAt,s?.phase,s?.providerUncertain,s?.operation,
    s?.worker?.connectionReady,s?.worker?.pending,s?.worker?.frozen]);
}
function chooseFlow(page) {
  flowPage = page; setupOverride = null;
  if ($('cloudFlowDetails')) $('cloudFlowDetails').open = false;
  paintSetup(current);
}
function paintFlow(s) {
  const account = accountConfigured && !['credentials_invalid', 'credentials_missing'].includes(s?.issue?.code);
  const ready = account && cloudGoalReady(s, cloudGoal, flowModels && flowModels.podId === s?.podId ? flowModels.bundles : [], flowModels?.podId && flowModels.podId === s?.podId ? flowModels.readiness : []);
  const protectedStop = s?.idleMinutes === 0 || s?.worker?.authorized && s?.worker?.available;
  const local = planningTarget === 'local', plan = getSetupPlan(planningTarget);
  const page = cloudFlowPage(s, account || local, ready && protectedStop, flowPage);
  const names = { goal: 'Your models', where: 'Location', costs: 'Review setup', install: 'Install AI' };
  const overridePage = { 1: 'where', 2: 'costs', 3: s?.podId ? 'install' : 'costs', 4: s?.podId ? 'install' : 'costs' }[setupOverride];
  const selectedPage = overridePage || page, visible = selectedPage === 'ready' ? 'install' : selectedPage;
  for (const [key, id] of [['goal', 'Goal'], ['where','Where'], ['costs', 'Costs'], ['install', 'Install']]) {
    $('cloudFlow' + id).hidden = key !== visible;
    const button = $('cloudFlow' + id + 'Tab');
    button.disabled = key === 'costs' && !account && !local || key === 'install' && (local || !account || !s?.podId);
    button.classList.toggle('active', key === visible); button.setAttribute('aria-selected', String(key === visible)); button.tabIndex = key === visible ? 0 : -1;
  }
  $('cloudSetupAccount').hidden = visible !== 'where' || local;
  $('cloudFlowAccountDetails').hidden = local;
  $('cloudWhereLocal').setAttribute('aria-pressed',String(local)); $('cloudWhereRunpod').setAttribute('aria-pressed',String(!local));
  $('cloudFlowWhereNext').disabled = !local && !account;
  $('cloudRunpodReview').hidden = local; $('cloudLocalReview').hidden = !local;
  $('cloudSetupComputer').hidden = visible !== 'costs';
  $('cloudSetupAI').hidden = visible !== 'install';
  const protectionSlot = visible === 'costs' ? $('cloudReviewProtection') : $('cloudFlowInstall');
  if ($('cloudSetupProtection').parentElement !== protectionSlot) protectionSlot.append($('cloudSetupProtection'));
  $('cloudSetupProtection').hidden = local || !['install','costs'].includes(visible) || !s?.podId;
  $('cloudIdleRecommendation').hidden = !!s?.podId;
  $('cloudSetupModelFields').hidden = !s?.worker?.connectionReady;
  $('cloudFlowDetails').hidden = !s?.podId;
  chip('cloudFlowAccount', account ? Number.isFinite(accountBalance?.balance) ? `${money(accountBalance.balance)} credits${accountBalance.stale ? ' · Last checked' : ''}` : 'Credits unavailable' : 'Connect account', account && !accountBalance?.stale ? 'ok' : 'warn');
  $('cloudFlowAccount').title = accountBalance?.checkedAt ? `RunPod account balance checked ${new Date(accountBalance.checkedAt).toLocaleTimeString()}` : 'Connect your RunPod account to see its balance.';
  chip('cloudSetupStatus', names[visible], visible === 'ready' && ready && protectedStop ? 'ok' : '');
  $('cloudSetupHint').textContent = visible === 'goal' ? 'Choose one or more categories and their models.'
    : visible === 'costs' ? 'Choose a computer and review its price before starting rental.'
    : visible === 'install' ? 'Install your models and choose automatic shutdown.' : '';
  $('cloudSetupHint').hidden = visible !== 'goal';
  const goalNames = { music: 'music', pictures: 'pictures', video: 'video', all: 'music, pictures and video' };
  $('cloudFlowReadyGoal').textContent = `One connection for ${typeof cloudGoal === 'object' ? Object.keys(cloudGoal).map(c => goalNames[c]).join(', ') : goalNames[cloudGoal]}.`;
  $('cloudFlowGoalNote').textContent = 'Planning keeps your saved generation preferences.';
  for (const radio of document.querySelectorAll('[name="cloud-goal"]')) radio.checked = radio.value === cloudGoal;
  $('cloudFlowGoalNext').disabled = !plan;
  $('cloudFlowCostsNext').disabled = !s?.podId;
  $('cloudFlowInstallNext').disabled = !(ready && protectedStop);
  const stopped = s?.pod?.status === 'EXITED' && !s.providerUncertain, pending = working || !!s?.operation || !!s?.providerUncertain;
  const rate = s?.providerUncertain ? `${money(s?.pod?.cost)}/hour (last confirmed)` : stopped ? `${money(s?.pod?.cost)}/hour when running` : `${money(s?.pod?.cost)}/hour`;
  $('cloudFlowCostRate').textContent = s?.podId ? rate : 'Choose a computer below';
  $('cloudFlowCostStorage').textContent = s?.storage ? `${money(s.storage.monthlyRunning)}/month running; ${money(s.storage.monthlyStopped)}/month stopped` : 'Shown before approval';
  $('cloudFlowCostSession').textContent = money(s?.spending?.sessionEstimate);
  $('cloudFlowReadyRate').textContent = stopped ? 'GPU rental stopped' : rate;
  $('cloudFlowReadyStorage').textContent = `${money(s?.storage?.monthlyCurrent)}/month estimated`;
  $('cloudReadyStorageAfter').textContent = `${money(s?.storage?.monthlyStopped)}/month estimated`;
  $('cloudFlowReadyFiles').textContent = s?.providerUncertain ? 'Storage needs checking' : s?.inventory?.persistence?.verified ? 'Verified saved storage' : s?.storage?.allocatedGB ? `${s.storage.allocatedGB} GB saved storage` : 'Needs checking';
  $('cloudFlowReadyStop').textContent = s?.idleMinutes === 0 ? 'Disabled' : `${s?.idleMinutes || 30} minutes · ${protectedStop ? 'Protected' : 'Needs setup'}`;
  const bundles = flowModels && flowModels.podId === s?.podId ? flowModels.bundles || [] : [];
  const install = automaticInstall?.podId === s?.podId ? automaticInstall : null;
  const view = cloudManagementState(s,{ready:ready && protectedStop,bundles:bundles.filter(b=>goalBundles(cloudGoal)?.includes(b.id)),installation:install});
  $('cloudFlowReady').hidden = !s?.podId;
  $('cloudFlowReadyTitle').textContent = view.label;
  $('cloudReadyRecovery').textContent = view.recovery;
  $('cloudReadyGpu').textContent = s?.pod?.gpu?.id || 'Not checked';
  $('cloudReadyModels').textContent = bundles.filter(b=>b.state==='ready').map(b=>b.label || b.id).join(', ') || (stopped ? 'Check after starting' : 'None verified on this computer');
  $('cloudReadyQuote').textContent = s?.providerCheckedAt ? new Date(s.providerCheckedAt).toLocaleTimeString() + (s.providerUncertain ? ' (last confirmed)' : '') : 'Not checked';
  $('cloudReadySession').textContent = money(s?.spending?.sessionEstimate) + ' estimated (compute only)';
  $('cloudReadyStorageRates').textContent = `${money(s?.storage?.monthlyRunning)}/month while running; ${money(s?.storage?.monthlyStopped)}/month after stopping (storage estimates).`;
  const acceptance = install?.acceptance;
  $('cloudReadyAllowance').textContent = 'Not verified for this session';
  $('cloudReadyDeadline').textContent = acceptance ? `Recorded test allowance: ${money(acceptance.budgetUSD)}; deadline: ${new Date(acceptance.stopBy).toLocaleString()}. A new session needs fresh approval and supervisor verification.` : 'No hard deadline verified for this session; automatic stop follows the policy above.';
  $('cloudReadyBilling').textContent = s?.spending?.provider ? `${money(s.spending.provider.amount)} provider-reported (${new Date(s.spending.provider.from).toLocaleDateString(undefined,{month:'short',year:'numeric',timeZone:'UTC'})})` : 'Not loaded; session values are estimates';
  $('cloudReadyBilling').title = s?.spending?.provider ? `${s.spending.provider.scope}. Checked ${new Date(s.spending.provider.checkedAt).toLocaleString()}.` : '';
  const review = $('cloudPlanReview'); review.replaceChildren();
  for (const [label,value] of [['models',plan?.profiles?.map(p=>p.label).join(', ') || 'Choose models first'],['downloads (up to)',plan ? bytes(plan.storage.modelBytes) : 'Not checked'],['saved space',plan ? `${plan.storage.minimumGB} GB including working space` : 'Not checked'],['compatibility',plan?.hardware?.unknown ? 'Requirements unverified; A100 history is model-specific' : local ? 'Review this computer’s model requirements' : 'GPU estimates; host RAM and runtime need checking']]) {
    const l=document.createElement('label'),v=document.createElement('span');l.textContent=label;v.textContent=value;v.className='pv';review.append(l,v);
  }
  chip('cloudFlowProvider', s?.providerUncertain ? 'Status unavailable' : stopped ? 'Computer stopped' : s?.pod?.status === 'RUNNING' ? 'Computer running' : 'Checking computer', s?.pod?.status === 'RUNNING' ? 'ok' : '');
  chip('cloudFlowAI', ready ? 'Workflow checked' : stopped ? 'AI offline' : s?.worker?.connectionReady ? 'Models need setup' : 'AI not ready', ready ? 'ok' : 'warn');
  $('cloudFlowIssue').hidden = !s?.issue && !s?.providerUncertain && !actionError;
  $('cloudFlowIssue').textContent = s?.issue?.message || actionError || (s?.providerUncertain ? 'Check the computer status before making changes.' : '');
  for (const id of ['cloudFlowCostStart', 'cloudFlowReadyStart']) { $(id).hidden = !view.canStart; $(id).disabled = pending; }
  $('cloudFlowCostStart').hidden = true; $('cloudSetupStart').hidden = true;
  $('cloudFlowReadyStopButton').hidden = !view.canStop || view.busy; $('cloudFlowReadyStopButton').disabled = pending;
  for (const id of ['cloudReadyFinish','cloudReadyNow']) { $(id).hidden = !view.canStop || !view.busy; $(id).disabled = pending; }
  $('cloudReadyFinish').disabled ||= !s?.worker?.available;
  $('cloudReadyFinish').title = s?.worker?.available ? '' : 'Enable automatic stop first so shutdown can finish after AIPLAY closes.';
  $('cloudReadyCheck').disabled = working;
  $('cloudFlowSample').disabled = !(ready && protectedStop) || pending;
  $('cloudFlowSampleHint').hidden = !(ready && protectedStop);
  $('cloudFlowRepair').hidden = stopped || ready && protectedStop;
  paintInstallation(s, flowModels && flowModels.podId === s?.podId ? flowModels.bundles : []);
  if (ready && protectedStop) { try { localStorage.setItem(`aiplay:cloud-setup:${s.podId}`, 'complete'); } catch {} }
}
function paintSelectedReadiness(rows) {
  const root = $('cloudSelectedReadiness'); if (!root) return; root.replaceChildren();
  for (const r of rows) {
    const details = document.createElement('details'); details.className = 'more';
    const title = document.createElement('summary'); title.textContent = r.label + ': ' + (r.workflowValidated ? 'Workflow checked' : r.filesDownloaded ? 'Runtime needs checking' : 'Model files needed');
    details.append(title);
    for (const [label, done] of [['Worker connected', r.workerConnected], ['Files downloaded', r.filesDownloaded], ['Files checksum verified', r.filesVerified], ['Dependencies available', r.dependenciesAvailable], ['Workflow validated', r.workflowValidated], ['This runtime inference', r.inferenceValidated]]) {
      const row = document.createElement('p'); row.className = 'hint'; row.textContent = label + ': ' + (done ? 'Yes' : 'Not verified'); details.append(row);
    }
    if (r.historicalHardwareValidated) {
      const history = document.createElement('p'); history.className = 'hint';
      history.textContent = 'Hardware history: A100 SXM workflow tested.';
      history.title = 'Historical hardware evidence does not install files or validate inference on this computer.'; details.append(history);
    }
    if (r.error) { const error = document.createElement('p'); error.className = 'hint warnhint'; error.textContent = r.error; details.append(error); }
    root.append(details);
  }
}
async function refreshFlowModels() {
  if (modelsPolling || !current?.worker?.connectionReady || Date.now() - modelsCheckedAt < 10000) return;
  const podId = current.podId, epoch = flowEpoch; modelsPolling = true; modelsCheckedAt = Date.now();
  try {
    const response = await fetch('/api/runpod/setup');
    if (response.ok && current?.podId === podId) { const data = await response.json(); if (epoch !== flowEpoch || !currentFlowReply(current,podId,cloudGoal,data)) return; flowModels = { ...data, podId }; paintSetup(current); paintSelectedReadiness(data.readiness || []); }
    else if (current?.podId === podId) { flowModels = null; paintSelectedReadiness([]); paintSetup(current); }
  } finally { modelsPolling = false; }
}
function paintSetup(s) {
  if (!$('cloudSetup') || $('cloudSetup').hidden) return;
  if (!s?.worker?.connectionReady || s?.pod?.status !== 'RUNNING' || flowModels?.podId !== s?.podId) paintSelectedReadiness([]);
  const inferred = cloudSetupStage(s, accountConfigured, setupSaved(s?.podId));
  const step = setupOverride || inferred;
  for (const [n, id] of [[1, 'Account'], [2, 'Computer'], [3, 'AI'], [4, 'Protection']]) $('cloudSetup' + id).hidden = step !== n;
  for (const item of document.querySelectorAll('[data-cloud-step]')) {
    const n = Number(item.dataset.cloudStep);
    item.classList.toggle('active', n === step); item.classList.toggle('done', n < step);
    if (n === step) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
  }
  const labels = ['Checking setup', 'Step 1: Connect account', 'Step 2: Choose computer', 'Step 3: Set up AI', 'Step 4: Automatic stop', 'Setup saved'];
  chip('cloudSetupStatus', labels[step], step === 5 ? 'ok' : '');
  const hints = {
    1: 'Open RunPod, create an account key and paste it below.',
    2: s?.providerUncertain ? 'Computer discovery failed; check your connection and try again.' : s?.computers?.length
      ? 'Choose a saved computer, or create one below.' : 'Create your first computer, then connect its AI service.',
    3: s?.providerUncertain ? 'Check the computer status before continuing.' : s?.pod?.status === 'EXITED'
      ? 'Review the start price to connect AI; rental begins only after your approval.'
      : s?.operation ? 'The current computer change is being checked.'
      : s?.worker?.connectionReady ? 'Choose a model below; downloads use this computer’s rental time.'
      : 'Paste the connection code supplied by the AIPLAY service on this computer.',
    4: `Use a separate stop key for ${s?.idleMinutes || 30}-minute idle shutdown, or choose to keep the computer running.`,
    5: s?.pod?.status === 'EXITED' ? 'Your setup is saved; start the computer when you want to generate.' : 'Use Music, Pictures or Video; computer controls and costs are below.',
  };
  $('cloudSetupHint').textContent = hints[step];
  $('cloudSetupEditAccount').hidden = step === 1;
  $('cloudSetupEdit').hidden = step === 1 && !setupOverride;
  $('runpodAccountDisconnect').hidden = !accountConfigured;
  $('cloudSetupChoose').hidden = inferred < 3 || step === 2;
  $('cloudSetupReturn').hidden = !setupOverride;
  $('cloudSetupEditAI').hidden = !s?.podId || step === 3;
  $('cloudSetupEditProtection').hidden = s?.pod?.status !== 'RUNNING' || !s?.worker?.connectionReady || step === 4 || !!s?.operation;
  $('cloudSetupNoComputer').hidden = !!s?.computers?.length || !s || !!s.providerUncertain;
  $('cloudSetupProvision').hidden = !s || !!s.providerUncertain;
  $('cloudSetupStart').hidden = !['EXITED', 'ERROR'].includes(s?.pod?.status);
  $('cloudSetupStart').disabled = working || !!s?.operation || !!s?.providerUncertain;
  $('cloudSetupWorkerFields').hidden = s?.pod?.status !== 'RUNNING' || !!s?.worker?.connectionReady && setupOverride !== 3;
  $('cloudSetupModelFields').hidden = !s?.worker?.connectionReady || !!s?.worker?.generationReady && setupOverride !== 3;
  $('cloudSetupProtectionFields').hidden = s?.pod?.status !== 'RUNNING';
  $('cloudComputer').hidden = !s?.podId;
  const keyForm = $('cloudComputerKeyForm'), keySlot = $('cloudAcceptanceKey');
  if (keySlot) {
    const target = s?.podId ? $('cloudSetupProtectionFields') : $('cloudAcceptanceKeyFields');
    if (keyForm.parentElement !== target) target.append(keyForm);
    keySlot.hidden = !!s?.podId;
    keyForm.querySelector('button[type="submit"]').textContent = s?.podId ? 'Enable automatic stop' : 'Save test stop key';
    $('cloudAcceptanceKeyNote').textContent = acceptanceKeySaved ? 'Test stop key saved on this PC. Creation still needs approval.' : 'Saved on this PC until a bounded hardware test is approved.';
  }
  $('cloudComputerRemoveKey').hidden = !s?.podId;
  if (automaticInstall && !['none','removed'].includes(automaticInstall.phase) && !s?.removedPodIds?.includes(automaticInstall.podId) && (!s?.podId || s.podId === automaticInstall.podId)) {
    if (step === 3 && !automaticInstall.workerConnected) $('cloudSetupHint').textContent = 'AIPLAY is installing and connecting the AI service automatically.';
    if (!automaticInstall.workerConnected && ['waiting', 'connecting', 'uncertain', 'creating', 'failed'].includes(automaticInstall.phase)) $('cloudSetupWorkerFields').hidden = true;
    $('cloudAutomaticInstall').hidden = false;
  }
  if (s?.pod?.workerUrl && document.activeElement !== $('runpodWorkerUrl')) $('runpodWorkerUrl').value = s.pod.workerUrl;
  paintFlow(s);
}
async function checkSetupAccount() {
  try {
    const response = await fetch('/api/runpod/account');
    accountConfigured = response.ok && (await response.json()).configured === true;
  } catch { accountConfigured = false; }
  if (current) paintSetup(current);
}
function scrollSetupTo(element) {
  const nav = element.closest('.page')?.querySelector('.pnav');
  const header = element !== $('cloudSetup') && element.closest('#cloudSetup') ? $('cloudSetup').querySelector('.cloud-flow-head')?.getBoundingClientRect?.().height || 0 : 0;
  element.style.scrollMarginTop = `${(nav?.getBoundingClientRect().height || 0) + header + 12}px`;
  element.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function openAdvancedSetup() {
  const advanced = $('cloudComputerConnection');
  advanced.open = true;
  $('runpodAccount').open = true;
  $('cloudSetupAdvanced').setAttribute('aria-expanded', 'true');
  scrollSetupTo(advanced);
  advanced.querySelector('summary').focus({ preventScroll: true });
}
function returnToGuidedSetup() {
  $('cloudComputerConnection').open = false;
  $('cloudSetupAdvanced').setAttribute('aria-expanded', 'false');
  scrollSetupTo($('cloudSetup'));
  $('cloudSetupAdvanced').focus({ preventScroll: true });
}
function mountSetup() {
  $('cloudSetup').hidden = false;
  $('set-runpod').open = true;
  const nav = $('settings').querySelector('.pnav');
  if (nav && typeof ResizeObserver !== 'undefined') new ResizeObserver(() => $('cloudSetup').style.setProperty('--cloud-nav-height', `${nav.getBoundingClientRect().height + 8}px`)).observe(nav);
  $('cloudInstallStop').addEventListener('click', async () => {
    if (!await appConfirm('Pause model downloads and stop this computer? Completed files and resumable downloads are kept.', { title: 'Stop setup', ok: 'Pause and stop' })) return;
    try {
      const response = await fetch('/api/runpod/setup/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw Error('Downloads could not be paused; check the AI connection.');
      for (let i = 0; i < 15; i++) { const setup = await (await fetch('/api/runpod/setup')).json(); if (!setup.active) { await perform('/stop', { mode: 'idle', requestId: crypto.randomUUID() }); return; } await new Promise(resolve => setTimeout(resolve,200)); }
      throw Error('The download is still pausing. Try stopping again shortly.');
    } catch (e) { $('cloudInstallStopHint').textContent = e.message; }
  });
  for (const button of document.querySelectorAll('[data-cloud-page]')) button.addEventListener('click', () => chooseFlow(button.dataset.cloudPage));
  $('cloudSetup').querySelector('[role="tablist"]').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...document.querySelectorAll('[data-cloud-page]')].filter(button => !button.disabled);
    const at = buttons.indexOf(event.target); if (at < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].click(); buttons[next].focus();
  });
  $('cloudFlowGoalNext').addEventListener('click', () => chooseFlow('where'));
  $('cloudFlowWhereNext').addEventListener('click', () => chooseFlow('costs'));
  $('cloudOpenLocal').addEventListener('click',async()=>{ document.querySelector('.rail [data-view="models"]')?.click(); const root=$('localModelPlan'); root.closest('details').open=true; await mountSetupPlanner(root,{chooseTarget:true}); root.dispatchEvent(new CustomEvent('aiplay:plan-target',{detail:{target:'local',carry:false}})); });
  for (const [id,target] of [['cloudWhereLocal','local'],['cloudWhereRunpod','runpod']]) $(id).addEventListener('click',()=>{ $('cloudModelPlan').dispatchEvent(new CustomEvent('aiplay:plan-target',{detail:target})); });
  $('cloudFlowCostsNext').addEventListener('click', () => chooseFlow('install'));
  $('cloudFlowInstallNext').addEventListener('click', () => $('cloudFlowReady').scrollIntoView({behavior:'smooth',block:'start'}));
  $('cloudFlowRepair').addEventListener('click', () => chooseFlow('install'));
  for (const id of ['cloudFlowCostStart', 'cloudFlowReadyStart']) $(id).addEventListener('click', () => $('cloudComputerStart').click());
  $('cloudFlowReadyStopButton').addEventListener('click', () => $('cloudComputerStop').click());
  $('cloudReadyFinish').addEventListener('click', () => $('cloudComputerFinish').click());
  $('cloudReadyNow').addEventListener('click', () => $('cloudComputerNow').click());
  $('cloudReadyCheck').addEventListener('click', () => perform('/discover'));
  $('cloudFlowSample').addEventListener('click', () => { if (!$('cloudFlowSample').disabled) document.dispatchEvent(new CustomEvent('aiplay:cloud-sample', { detail: { goal: typeof cloudGoal === 'object' ? Object.keys(cloudGoal)[0] : cloudGoal, selection: cloudGoal } })); });
  for (const radio of document.querySelectorAll('[name="cloud-goal"]')) radio.addEventListener('change', async () => {
    const previous = cloudGoal; cloudGoal = radio.value; paintSetup(current);
    for (const input of document.querySelectorAll('[name="cloud-goal"]')) input.disabled = true;
    try {
      const response = await fetch('/api/runpod/goal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal: cloudGoal }) });
      if (!response.ok) throw new Error('Your goal could not be saved. Try again.');
    } catch (e) { cloudGoal = previous; paintSetup(current); $('cloudFlowGoalNote').textContent = e.message; }
    finally { for (const input of document.querySelectorAll('[name="cloud-goal"]')) input.disabled = false; }
  });
  $('cloudSetupAdvanced').addEventListener('click', openAdvancedSetup);
  $('cloudSetupBack').addEventListener('click', returnToGuidedSetup);
  $('cloudComputerConnection').addEventListener('toggle', () => {
    $('cloudSetupAdvanced').setAttribute('aria-expanded', String($('cloudComputerConnection').open));
  });
  for (const [target, ids] of [
    ['cloudSetupAccountFields', ['runpodAccountForm', 'runpodAccountState']],
    ['cloudSetupComputerFields', ['cloudComputerChoice']],
    ['cloudSetupCreateFields', ['runpodCreateForm']],
    ['cloudSetupWorkerFields', ['runpodConnectionForm']],
    ['cloudSetupModelFields', ['runpodModels']],
    ['cloudSetupProtectionFields', ['cloudComputerKeyForm']],
  ]) for (const id of ids) $(target).append($(id));
  $('cloudSetup').append($('cloudFlowDetails'), $('cloudComputerConnection'));
  const browse = document.createElement('button'); browse.className='edtool'; browse.type='button'; browse.textContent='Open Model Library';
  browse.addEventListener('click',()=>document.querySelector('.rail [data-view="models"]')?.click()); $('cloudComputerConnection').append(browse);
  const keySlot = document.createElement('details'); keySlot.id = 'cloudAcceptanceKey'; keySlot.className = 'more';
  keySlot.innerHTML = '<summary>Hardware test stop key</summary><p class="hint">Use a separate RunPod management key for the two-hour test deadline.</p><div id="cloudAcceptanceKeyFields"></div><p class="hint" role="status" id="cloudAcceptanceKeyNote"></p>';
  $('cloudComputerConnection').append(keySlot);
  const idle = $('cloudComputerIdle');
  $('cloudFlowIdleFields').append(document.querySelector('label[for="cloudComputerIdle"]'), idle.closest('.pv'));
  $('runpodModels').open = true;
  $('runpodApiKey').previousElementSibling.textContent = 'account key';
  $('runpodWorkerUrl').previousElementSibling.textContent = 'computer address';
  $('runpodWorkerToken').previousElementSibling.textContent = 'connection code';
  $('runpodAccountConnect').textContent = 'Connect account';
  $('runpodConnect').textContent = 'Connect AI';
  $('runpodModels').querySelector('summary').textContent = 'AI models';
  $('runpodConnectionForm').querySelector('.hint').textContent = 'The connection code is saved securely and is separate from your account key.';
  $('runpodConnectionForm').querySelector('a[href="/runpod.html"]').hidden = true;
  const reveal = (id, focus) => {
    $('cloudComputerConnection').open = true;
    for (const details of document.querySelectorAll(`#${id}, #${id} details`)) if (details.tagName === 'DETAILS') details.open = true;
    $(focus || id).scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  $('cloudSetupEditAccount').addEventListener('click', () => { setupOverride = 1; paintSetup(current); });
  $('cloudSetupChoose').addEventListener('click', () => { setupOverride = 2; paintSetup(current); });
  $('cloudSetupReturn').addEventListener('click', () => { setupOverride = null; paintSetup(current); });
  $('cloudSetupEditAI').addEventListener('click', () => { setupOverride = 3; paintSetup(current); });
  $('cloudSetupEditProtection').addEventListener('click', () => { setupOverride = 4; paintSetup(current); });
  $('cloudSetupProvision').addEventListener('click', () => {
    const fields = $('cloudSetupCreateFields');
    fields.hidden = !fields.hidden;
    $('cloudSetupProvision').setAttribute('aria-expanded', String(!fields.hidden));
    if (!fields.hidden) {
      document.dispatchEvent(new Event('aiplay:cloud-create-open'));
      scrollSetupTo(fields);
    }
  });
  document.addEventListener('aiplay:cloud-computer-created', async event => {
    setupOverride = null; flowPage = null;
    $('cloudSetupCreateFields').hidden = true;
    $('cloudSetupProvision').setAttribute('aria-expanded', 'false');
    await perform('/select', { id: event.detail.id });
    await refreshAutomaticInstall();
  });
  document.addEventListener('aiplay:cloud-install-progress', event => {
    paintAutomaticInstall(event.detail);
    if (!event.detail.podId) {
      $('runpodCreateState').textContent = event.detail.error || 'Checking whether your computer was created.';
      $('cloudSetupProvision').disabled = true;
    }
  });
  $('cloudAutomaticCheck').addEventListener('click', async () => {
    const response = await fetch('/api/runpod/install/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (response.ok) paintAutomaticInstall(await response.json());
    await perform('/discover');
  });
  $('cloudSetupInstallHelp').addEventListener('click', () => reveal('runpodAccount', 'runpodBootstrapState'));
  $('cloudSetupStart').addEventListener('click', () => $('cloudComputerStart').click());
  $('cloudSetupCheck').addEventListener('click', () => perform('/refresh'));
  $('cloudSetupSkipProtection').addEventListener('click', async () => {
    if (await appConfirm('Keep GPU rental running after AIPLAY closes? You will need to stop the computer yourself.', { title: 'Disable Automatic Stop', ok: 'Keep running' }))
      await perform('/policy', { minutes: 0 });
  });
  document.addEventListener('aiplay:cloud-computer-refresh', () => { setupOverride = null; checkSetupAccount(); });
  document.addEventListener('aiplay:cloud-setup-open', () => {
    setupOverride = null; flowPage = null; $('set-runpod').open = true; paintSetup(current);
    $('cloudSetup').scrollIntoView({ behavior: 'smooth', block: 'start' });
    const step = cloudSetupStage(current, accountConfigured, setupSaved(current?.podId));
    $(step === 1 ? 'runpodApiKey' : step === 2 ? 'cloudComputerSelect' : 'cloudSetupCheck').focus({ preventScroll: true });
  });
  paintSetup(current);
}
const actionLabels = { '/review': 'Checking availability and price', '/start': 'Starting and checking AI', '/stop': 'Preparing safe shutdown',
  '/storage': 'Checking storage', '/backup': 'Recovering saved outputs', '/billing': 'Checking provider billing' };
async function api(action = '', body) {
  const response = await fetch(`/api/runpod/computer${action}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'This change could not be completed.');
  return data;
}
function chip(id, text, tone = '') { $(id).textContent = text; $(id).className = `chip ${tone}`; }
function paint(s) {
  if (cloudReplyContext(current) !== cloudReplyContext(s)) { ++flowEpoch; flowModels = null; modelsCheckedAt = 0; }
  current = s;
  const pod = s.pod, pending = !!s.operation;
  const status = { RUNNING: 'Computer running', EXITED: 'Compute stopped', PROVISIONING: 'Preparing computer', STARTING: 'Starting computer', ERROR: 'Computer needs attention', TERMINATED: 'Computer missing' };
  chip('cloudComputerStatus', s.providerUncertain ? 'Status unavailable' : status[pod?.status] || 'Choose a computer', s.providerUncertain ? 'warn' : pod?.status === 'RUNNING' ? 'ok' : '');
  const ready = pod?.status === 'RUNNING' && !s.providerUncertain && s.worker?.connectionReady && s.worker?.generationReady && !pending && !s.worker?.pending && !s.worker?.frozen;
  chip('cloudComputerReady', ready ? 'Workflow checked' : pending ? 'Preparing computer change' : s.worker?.connectionReady ? 'Models need setup' : 'Worker not ready', ready ? 'ok' : 'warn');
  $('cloudComputerRate').textContent = s.providerUncertain ? `${money(pod?.cost)}/hour (last confirmed)`
    : pod?.status === 'EXITED' ? 'GPU rental stopped' : pod ? `${money(pod.cost)}/hour (provider rate)` : 'Unavailable';
  $('cloudComputerStorageCost').textContent = `${money(s.storage?.monthlyCurrent)}/month estimated`;
  $('cloudComputerSession').textContent = money(s.spending?.sessionEstimate);
  $('cloudComputerMonth').textContent = money(s.spending?.monthlyComputeEstimate);
  $('cloudComputerBilled').textContent = s.spending?.provider ? `${money(s.spending.provider.amount)} (${new Date(s.spending.provider.from).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' })})` : 'Not checked';
  $('cloudComputerIssue').hidden = !s.issue;
  $('cloudComputerIssue').textContent = s.issue?.message || '';
  $('cloudComputerAlternatives').hidden = !s.issue?.alternatives?.length;
  $('cloudComputerAlternatives').textContent = s.issue?.alternatives?.join(' ') || '';
  const select = $('cloudComputerSelect');
  const choices = new Map((s.computers || []).map(p => [p.id, p.name]));
  if (pod && !s.removedPodIds?.includes(pod.id) && pod.status !== 'TERMINATED') choices.set(pod.id, pod.name);
  const signature = JSON.stringify([...choices]);
  if (select.dataset.signature !== signature) {
    select.replaceChildren(new Option(choices.size ? 'Choose your computer' : 'No existing computer found', ''));
    for (const [id, name] of choices) select.add(new Option(name, id));
    select.dataset.signature = signature;
  }
  select.value = s.podId || ''; select.disabled = pending || working;
  for (const id of ['cloudComputerStart', 'cloudComputerStop', 'cloudComputerFinish', 'cloudComputerNow', 'cloudComputerCapacityReview', 'cloudComputerCleanup']) $(id).disabled = working || pending || !s.podId;
  $('cloudComputerStart').disabled ||= !['EXITED', 'ERROR'].includes(pod?.status) || s.providerUncertain;
  for (const id of ['cloudComputerStop', 'cloudComputerFinish', 'cloudComputerNow']) $(id).disabled ||= pod?.status !== 'RUNNING' || s.providerUncertain;
  chip('cloudComputerWatchdog', s.worker?.error ? 'Shutdown needs attention' : s.policyPending ? 'Applies next start'
    : pod?.status === 'EXITED' && s.workerPolicy?.authorized && s.workerPolicy?.available ? 'Ready next start'
    : s.worker?.authorized && s.worker?.available ? 'Protected after closing' : 'Automatic stop disabled',
    !s.worker?.error && !s.policyPending && s.worker?.authorized && s.worker?.available ? 'ok' : 'warn');
  if (document.activeElement !== $('cloudComputerIdle')) $('cloudComputerIdle').value = String(s.idleMinutes ?? 30);
  $('cloudComputerIdleSave').disabled = working || pending || !s.podId || s.providerUncertain || !['RUNNING','EXITED'].includes(pod?.status);
  if (document.activeElement !== $('cloudComputerAlert')) $('cloudComputerAlert').value = s.alertUSD ?? '';
  $('cloudComputerAlertNote').hidden = !s.spending?.alert;
  $('cloudComputerAllocated').textContent = Number.isFinite(s.storage?.allocatedGB) ? `${s.storage.allocatedGB} GB (${s.storage.kind})` : s.storage?.kind || 'Not checked';
  const inv = s.inventory;
  $('cloudComputerUsed').textContent = `${bytes(inv?.usedBytes)}${inv?.checkedAt ? ` (reviewed ${new Date(inv.checkedAt).toLocaleTimeString()})` : ''}`;
  for (const [id, field] of [['Models', 'models'], ['Generated', 'generated'], ['Temporary', 'temporary'], ['Other', 'other']]) $('cloudComputer' + id).textContent = `${inv?.partial ? '≥ ' : ''}${bytes(inv?.categories?.[field])}`;
  $('cloudComputerCleanup').disabled ||= !inv?.cleanup?.files?.length;
  $('cloudComputerCleanupReview').hidden = !inv?.cleanup?.files?.length;
  $('cloudComputerCleanupFiles').replaceChildren(...(inv?.cleanup?.files || []).map(file => {
    const row = document.createElement('li'); row.textContent = `${file.name} (${bytes(file.bytes)})`; return row;
  }));
  $('cloudComputerStorageNote').textContent = inv?.partial ? 'Storage scan limit reached; category totals are partial.'
    : inv && !inv.persistence?.verified ? 'Persistent storage could not be verified. Normal shutdown is blocked.' : inv ? 'Cleanup reviews abandoned upload files; your assets and model weights are kept.' : '';
  const progress = { starting: 'Starting and checking AI', checking_start: 'Checking start result', waiting_to_stop: 'Waiting for safe shutdown', stopping: 'Confirming compute stopped' };
  if (pending && !s.issue) { $('cloudComputerIssue').hidden = false; $('cloudComputerIssue').textContent = progress[s.phase] || 'Checking the current change'; }
  else if (working && !s.issue && actionLabels[activeAction]) { $('cloudComputerIssue').hidden = false; $('cloudComputerIssue').textContent = actionLabels[activeAction]; }
  else if (!s.issue && s.worker?.error) { $('cloudComputerIssue').hidden = false; $('cloudComputerIssue').textContent = s.worker.errorCode === 'workload_unknown'
    ? 'Automatic shutdown cannot verify current work. Check the worker.' : 'Automatic shutdown needs attention. Check the stop key or saved storage.'; }
  $('cloudComputerIssue').className = s.issue || s.worker?.error ? 'hint warnhint' : 'hint';
  if (actionError && !s.issue) { $('cloudComputerIssue').hidden = false; $('cloudComputerIssue').textContent = actionError; }
  $('cloudComputerDiagnostics').textContent = JSON.stringify({ computer: s.podId, phase: s.phase, providerCheckedAt: s.providerCheckedAt,
    operation: s.operation, issueCode: s.issue?.code, worker: s.worker }, null, 2);
  paintSetup(s);
}
async function perform(action, body = {}) {
  if (working) return;
  working = true; activeAction = action; actionError = null; if (current) paint(current);
  try { const result = await api(action, body); if (result.version === 1) paint(result); return result; }
  catch (e) { actionError = e.message; for (const id of ['cloudComputerIssue','cloudFlowIssue']) { $(id).hidden = false; $(id).textContent = e.message; } }
  finally { working = false; activeAction = ''; if (current) { const result = await api().catch(() => null); if (result) paint(result); } }
}
async function init() {
  let config;
  try { config = (await (await fetch('/api/status')).json()).config; } catch { return; }
  if (!config?.remoteOnly) { $('cloudLocalPlan').hidden = false; await mountSetupPlanner($('cloudLocalPlan'),{chooseTarget:true}); return; }
  try { const r = await fetch('/api/runpod/install/acceptance'); if (r.ok) acceptanceKeySaved = (await r.json()).stopKeySaved === true; } catch { /* Existing workers and older backends keep their current setup. */ }
  try { const response = await fetch('/api/runpod/goal'); if (response.ok) cloudGoal = (await response.json()).goal; } catch {}
  $('cloudComputer').hidden = false;
  mountSetup();
  await mountSetupPlanner($('cloudModelPlan'), { target: 'runpod', selectionOnly:true, onPlan:plan=>{ planningTarget=plan.target; paintSetup(current); } });
  await checkSetupAccount();
  $('cloudComputerCheck').addEventListener('click', () => perform('/discover'));
  $('cloudComputerSelect').addEventListener('change', event => { if (event.target.value) { setupOverride = null; perform('/select', { id: event.target.value }); } });
  $('cloudComputerStart').addEventListener('click', async () => {
    const review = await perform('/review'); if (!review) return;
    if (!await appConfirm(`Start at about ${money(review.quote.rate)}/hour? Storage is about ${money(review.storage.monthlyRunning)}/month while running and ${money(review.storage.monthlyStopped)}/month after stopping.`, { title: 'Start Cloud Computer', ok: 'Start rental' })) return;
    await perform('/start', { reviewId: review.id, requestId: crypto.randomUUID(), confirm: 'START CLOUD COMPUTER' });
  });
  const stop = mode => perform('/stop', { mode, requestId: crypto.randomUUID(), ...(mode === 'now' ? { confirm: 'CANCEL WORK AND STOP' } : {}) });
  $('cloudComputerStop').addEventListener('click', () => stop('idle'));
  $('cloudComputerFinish').addEventListener('click', () => stop('after-job'));
  $('cloudComputerNow').addEventListener('click', async () => {
    if (await appConfirm('Cancel active work and stop this computer? Unfinished work may be lost; saved files are kept.', { title: 'Stop Now', ok: 'Cancel work and stop', tone: 'danger' })) await stop('now');
  });
  $('cloudComputerIdleSave').addEventListener('click', () => perform('/policy', { minutes: Number($('cloudComputerIdle').value) }));
  $('cloudComputerAlertSave').addEventListener('click', () => perform('/alerts', { alertUSD: $('cloudComputerAlert').value }));
  $('cloudComputerBilling').addEventListener('click', () => perform('/billing'));
  $('cloudComputerReviewStorage').addEventListener('click', () => perform('/storage'));
  $('cloudComputerCleanup').addEventListener('click', async () => {
    const review = current?.inventory?.cleanup; if (!review?.files?.length) return;
    if (await appConfirm(`Delete the ${review.files.length} reviewed abandoned upload files (${bytes(review.bytes)})?`, { title: 'Safe Cleanup', ok: 'Clean reviewed files', tone: 'danger' })) {
      await perform('/cleanup', { reviewId: review.reviewId, confirm: 'CLEAN TEMPORARY FILES' }); await perform('/storage');
    }
  });
  $('cloudComputerBackup').addEventListener('click', async () => {
    const result = await perform('/backup'); if (result) $('cloudComputerStorageNote').textContent = result.completed ? `${result.files} tracked output files saved on this PC.` : 'Output recovery is still running. Keep AIPLAY open.';
  });
  $('cloudComputerCapacityReview').addEventListener('click', async () => {
    const size = Number($('cloudComputerCapacity').value), result = await perform('/capacity', { size }); if (!result?.review) return;
    if (await appConfirm(`Increase saved storage to ${size} GB? Estimated storage rental after stopping: ${money(result.review.monthlyEstimate)}/month.`, { title: 'Increase Storage', ok: 'Increase storage' }))
      await perform('/capacity', { size, requestId: crypto.randomUUID(), expectedMonthly: result.review.monthlyEstimate, confirm: 'INCREASE STORAGE' });
  });
  $('cloudComputerKeyForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!current?.podId) {
      if (!await appConfirm('Save this separate key in AIPLAY’s vault for the bounded hardware test? It will reach the test computer only after creation approval.', { title: 'Prepare Test Stop Key', ok: 'Save on this PC' })) return;
      try {
        const r = await fetch('/api/runpod/install/acceptance-key', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: $('cloudComputerStopKey').value, confirm: 'SAVE ACCEPTANCE STOP KEY' }) });
        const b = await r.json(); if (!r.ok) throw Error(b.error || 'The stop key could not be saved.');
        acceptanceKeySaved = true; paintSetup(current);
      } catch (e) { $('cloudAcceptanceKeyNote').textContent = e.message; }
      finally { $('cloudComputerStopKey').value = ''; }
      return;
    }
    if (!await appConfirm('Save this separate key on the selected cloud computer for automatic shutdown? Its RunPod permissions remain available to that computer.', { title: 'Enable Automatic Stop', ok: 'Save stop key' })) return;
    try { await perform('/policy', { minutes: Number($('cloudComputerIdle').value), apiKey: $('cloudComputerStopKey').value, confirm: 'SAVE REMOTE STOP KEY' }); }
    finally { $('cloudComputerStopKey').value = ''; }
  });
  $('cloudComputerRemoveKey').addEventListener('click', async () => {
    if (await appConfirm('Remove the automatic-stop key from this cloud computer and disable idle shutdown?', { title: 'Remove Stop Key', ok: 'Remove key', tone: 'danger' }))
      await perform('/policy', { minutes: 0, removeKey: true, confirm: 'REMOVE REMOTE STOP KEY' });
  });
  document.addEventListener('aiplay:cloud-computer-refresh', () => perform('/discover'));
  await perform('/discover');
  await refreshAutomaticInstall();
  await refreshFlowModels();
  setInterval(async () => {
    if (document.hidden || $('settings').hidden) return;
    const result = await api().catch(() => null); if (result) paint(result);
    refreshAutomaticInstall().catch(() => {});
    refreshFlowModels().catch(() => {});
  }, 3000);
}
init();
