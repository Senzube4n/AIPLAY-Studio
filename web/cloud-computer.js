import { appConfirm } from './dialog.js';
const $ = id => document.getElementById(id);
const money = value => Number.isFinite(value) ? `$${value.toFixed(2)}` : 'Unavailable';
const bytes = value => Number.isFinite(value) ? `${(value / 1e9).toFixed(2)} GB` : 'Not checked';
let current = null, working = false, activeAction = '';
let accountConfigured = false, setupOverride = null;
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
function paintSetup(s) {
  if (!$('cloudSetup') || $('cloudSetup').hidden) return;
  const inferred = cloudSetupStage(s, accountConfigured, setupSaved(s?.podId));
  if (inferred === 5) { try { localStorage.setItem(`aiplay:cloud-setup:${s.podId}`, 'complete'); } catch {} }
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
  if (s?.pod?.workerUrl && document.activeElement !== $('runpodWorkerUrl')) $('runpodWorkerUrl').value = s.pod.workerUrl;
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
  element.style.scrollMarginTop = `${(nav?.getBoundingClientRect().height || 0) + 12}px`;
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
    setupOverride = null;
    $('cloudSetupCreateFields').hidden = true;
    $('cloudSetupProvision').setAttribute('aria-expanded', 'false');
    await perform('/select', { id: event.detail.id });
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
    setupOverride = null; paintSetup(current);
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
  current = s;
  const pod = s.pod, pending = !!s.operation;
  const status = { RUNNING: 'Computer running', EXITED: 'Compute stopped', PROVISIONING: 'Preparing computer', STARTING: 'Starting computer', ERROR: 'Computer needs attention', TERMINATED: 'Computer missing' };
  chip('cloudComputerStatus', s.providerUncertain ? 'Status unavailable' : status[pod?.status] || 'Choose a computer', s.providerUncertain ? 'warn' : pod?.status === 'RUNNING' ? 'ok' : '');
  const ready = s.worker?.generationReady && !pending && !s.worker?.pending && !s.worker?.frozen;
  chip('cloudComputerReady', ready ? 'AI ready' : pending ? 'Preparing computer change' : s.worker?.connectionReady ? 'Models need setup' : 'Worker not ready', ready ? 'ok' : 'warn');
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
  if (pod) choices.set(pod.id, pod.name);
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
  $('cloudComputerDiagnostics').textContent = JSON.stringify({ computer: s.podId, phase: s.phase, providerCheckedAt: s.providerCheckedAt,
    operation: s.operation, issueCode: s.issue?.code, worker: s.worker }, null, 2);
  paintSetup(s);
}
async function perform(action, body = {}) {
  if (working) return;
  working = true; activeAction = action; if (current) paint(current);
  try { const result = await api(action, body); if (result.version === 1) paint(result); return result; }
  catch (e) { $('cloudComputerIssue').hidden = false; $('cloudComputerIssue').textContent = e.message; }
  finally { working = false; activeAction = ''; if (current) { const result = await api().catch(() => null); if (result) paint(result); } }
}
async function init() {
  let config;
  try { config = (await (await fetch('/api/status')).json()).config; } catch { return; }
  if (!config?.remoteOnly) return;
  $('cloudComputer').hidden = false;
  mountSetup(); await checkSetupAccount();
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
  setInterval(async () => {
    if (document.hidden || $('settings').hidden) return;
    const result = await api().catch(() => null); if (result) paint(result);
  }, 3000);
}
init();
