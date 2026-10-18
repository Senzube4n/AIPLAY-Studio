import { appConfirm } from './dialog.js';
const $ = id => document.getElementById(id);
let busy = false, latest = null;
async function api(action = '', body) {
  const r = await fetch('/api/runpod/update' + action, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body) });
  const data = await r.json(); if (!r.ok) throw Error(data.error || 'The AI update could not be checked.'); return data;
}
function paint(data) {
  latest = data;
  const stopped = data.providerState === 'EXITED', uncertain = ['applying','uncertain'].includes(data.phase);
  $('cloudUpdateStatus').textContent = data.verified ? 'Update verified' : uncertain ? 'Checking saved update' : data.phase === 'staged' ? 'Ready next start' : stopped ? 'Computer stopped' : 'Stop before updating';
  $('cloudUpdateStatus').className = `chip ${data.verified ? 'ok' : uncertain ? 'warn' : ''}`;
  $('cloudUpdateTarget').textContent = data.target ? data.target.slice(0,7) : 'Unavailable';
  $('cloudUpdateCurrent').textContent = data.current ? data.current.slice(0,7) : 'Not verified';
  $('cloudUpdateManual').hidden = data.managed;
  $('cloudUpdateControls').hidden = !data.managed;
  $('cloudUpdateStop').disabled = busy || data.providerState !== 'RUNNING' || uncertain;
  $('cloudUpdateSave').disabled = busy || !data.available || data.verified || data.phase === 'staged' && data.stagedTarget === data.target;
  $('cloudUpdateStart').disabled = busy || !stopped || uncertain;
  $('cloudUpdateCheck').disabled = busy;
  $('cloudUpdateNote').textContent = data.error || (data.verified ? 'The connected AI service matches this AIPLAY build.'
    : data.phase === 'staged' ? 'Review the rental price before starting to install the saved update.' : 'Models, outputs and the connection key stay in the same saved storage.');
  if (/^[a-f0-9]{40}$/.test(data.target || '')) $('cloudUpdateGuide').href = `https://github.com/nemesisone-dev/AIPLAY-Studio/blob/${data.target}/docs/CLOUD_COMPUTER.md#updating-existing-computers`;
}
async function check() {
  try { paint(await api()); } catch(e) { $('cloudUpdateNote').textContent = e.message; }
}
async function init() {
  if (!$('cloudWorkerUpdate')) return;
  $('cloudWorkerUpdate').addEventListener('toggle', () => { if ($('cloudWorkerUpdate').open) check(); });
  $('cloudUpdateCheck').addEventListener('click', check);
  $('cloudUpdateStop').addEventListener('click', () => $('cloudComputerStop').click());
  $('cloudUpdateStart').addEventListener('click', () => $('cloudComputerStart').click());
  $('cloudUpdateSave').addEventListener('click', async () => {
    if (busy) return; busy = true; if (latest) paint(latest); let problem = null;
    try {
      const plan = await api('/review', {});
      if (await appConfirm(`Save AI build ${plan.target.slice(0,7)} for this computer's next start? Models, outputs and connection keys are kept. Starting rental is a separate step.`, { title:'Update AI service', ok:'Save update' }))
        await api('/apply', { reviewId:plan.id, requestId:crypto.randomUUID(), confirm:'UPDATE AI SERVICE' });
      busy = false; await check();
    } catch(e) { problem = e.message; }
    finally { busy = false; if (latest) paint(latest); if (problem) $('cloudUpdateNote').textContent = problem; }
  });
  document.addEventListener('aiplay:cloud-computer-refresh', () => { if ($('cloudWorkerUpdate').open) check(); });
  // Poll only while this guide is visible; checks never stage updates or start rental.
  setInterval(() => { if (!busy && !document.hidden && !$('settings').hidden && $('cloudWorkerUpdate').open) check(); }, 5000);
}
init();
