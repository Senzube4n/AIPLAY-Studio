import { appConfirm } from './dialog.js';
import { revealSetting } from './settings-sections.js';
const plans = new Map();
export const getSetupPlan = target => plans.get(target);
const labels = { music: 'Music / Audio', pictures: 'Pictures', video: 'Video' };
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; };
const gb = n => `${(n / 1e9).toFixed(1)} GB`;
async function request(target, selection, verify = false) {
  const response = await fetch(`/api/setup-plan?target=${target}`, selection || verify ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, selection, ...(verify ? { verify: true } : {}) }) } : {});
  const data = await response.json(); if (!response.ok) throw Error(data.error || 'Setup could not be checked.'); return data;
}
export async function mountSetupPlanner(root, { target = 'local', chooseTarget = false, onPlan } = {}) {
  if (!root) return;
  if (root.dataset.mounted) { root.dispatchEvent(new Event('aiplay:plan-refresh')); return; }
  root.dataset.mounted = 'true';
  const status = el('p', 'Checking model plan…', 'hint'), rows = el('div'), summary = el('div', null, 'params');
  const where = el('select', null, 'sel2'); where.setAttribute('aria-label', 'Plan execution location');
  where.add(new Option('Local (this PC)', 'local')); where.add(new Option('RunPod (cloud computer)', 'runpod')); where.value = target;
  if (chooseTarget) { const row = el('div', null, 'params'); row.append(el('label', 'plan for'), where); root.append(row); }
  root.append(rows, summary, status);
  let data, busy = false, revision = 0;
  function publish() {
    plans.set(target, data); onPlan?.(data);
    document.dispatchEvent(new CustomEvent('aiplay:model-plan', { detail: data }));
  }
  function paint() {
    rows.replaceChildren(); summary.replaceChildren();
    for (const [category, label] of Object.entries(labels)) {
      const row = el('div', null, 'params'), toggle = el('label'), check = el('input'); check.type = 'checkbox'; check.checked = !!data.selection[category];
      check.setAttribute('aria-label', `Include ${label}`); toggle.append(check, ` ${label}`);
      const select = el('select', null, 'sel2'); select.setAttribute('aria-label', `${label} model`);
      for (const p of data.choices.filter(p => p.category === category)) select.add(new Option(p.label, p.id));
      select.value = data.selection[category] || select.options[0].value;
      select.disabled = !check.checked || busy; check.disabled = busy;
      row.append(toggle, select); rows.append(row);
      const selected = data.profiles.find(p => p.category === category);
      if (selected) {
        const details = el('details', null, 'more'); details.append(el('summary', 'Requirements and terms'));
        const fit = selected.fit?.state || (selected.hardwareAcceptance ? 'Minimums unverified' : selected.experimental ? 'Hardware unverified' : 'Hardware estimate');
        details.append(el('p', `${gb(selected.totalBytes)} · ${fit} · ${selected.workload}`, 'hint'));
        const note = selected.fit?.why || selected.requires.note;
        if (note && note !== selected.evidence) details.append(el('p', note, 'hint'));
        details.append(el('p', selected.evidence, 'hint'));
        const accepted = selected.hardwareAcceptance;
        if (accepted) {
          const chip = el('span', 'A100 SXM workflow tested', 'chip ok');
          chip.title = 'Historical RunPod test; installation and inference on this computer need separate checks.';
          details.append(chip);
          const measured = el('div', null, 'params');
          for (const [label, value] of [
            ['observed GPU peak', `${(accepted.observed.gpuUsedBytes / 2 ** 30).toFixed(2)} GiB`],
            ['observed process RAM', `${(accepted.observed.comfyProcessRssBytes / 2 ** 30).toFixed(2)} GiB`],
            ['generation time', `${accepted.observed.generationSeconds.toFixed(2)} s`],
            ['tested allocation', `${accepted.tested.vramGiB} GiB GPU · ${accepted.tested.allocatedRamGB} GB RAM · ${accepted.tested.vcpus} vCPUs`],
            ['minimum requirements', 'Not established'],
          ]) measured.append(el('label', label), el('span', value, 'pv'));
          details.append(measured);
        }

        const link = el('a', selected.licence || 'Review model terms', 'edtool sm'); link.href = selected.licenseUrl; link.target = '_blank'; link.rel = 'noreferrer'; details.append(link); rows.append(details);
      }
      const change = () => {
        const selection = { ...data.selection }; if (check.checked) selection[category] = select.value; else delete selection[category];
        if (!Object.keys(selection).length) { check.checked = true; status.textContent = 'Select at least one category.'; return; }
        save(selection);
      };
      check.addEventListener('change', change); select.addEventListener('change', change);
    }
    const hw = data.hardware, unknownMemory = data.profiles.some(p => p.hardwareAcceptance) ? 'Minimum not established' : 'Unverified for selected models';
    summary.append(el('label', 'model storage'), el('span', gb(data.storage.modelBytes), 'pv'),
      el('label', 'space to plan'), el('span', `${data.storage.minimumGB} GB including working space`, 'pv'),
      el('label', 'graphics memory'), el('span', hw.unknown ? unknownMemory : `${hw.vramMinGb} GB minimum · ${hw.vramRecGb} GB recommended`, 'pv'),
      el('label', 'system memory'), el('span', hw.unknown ? unknownMemory : `${hw.ramMinGb} GB minimum · ${hw.ramRecGb} GB recommended`, 'pv'));
    const more = el('details', null, 'more'); more.append(el('summary', 'Plan details'), el('p', data.storage.note, 'hint'), el('p', hw.note, 'hint')); summary.append(more);
    const modeMatches = data.activeMode === target;
    status.textContent = !modeMatches ? `Open ${data.modeRequired} in the launcher to use this plan.`
      : target === 'runpod' ? 'Review the computer price next; model installation needs licence approval.' : 'Use Models to install; current generation preferences are kept.';
    if (target === 'local') {
      const button = el('button', 'Open Models', 'edtool'); button.type = 'button'; button.addEventListener('click', () => document.querySelector('.rail [data-view="models"]')?.click()); rows.append(button);
      for (const p of data.profiles.filter(p => !p.localFilesPresent)) {
        // Existing gated/native paths stay in Models, where their own setup is authoritative.
        const button = el('button', p.id === 'ltx25' ? 'LTX access setup in Models' : `Install ${p.label}`, 'edtool sm'); button.type = 'button'; button.disabled = !modeMatches || p.id === 'ltx25';
        if (p.id !== 'ltx25') button.addEventListener('click', async () => {
          if (!await appConfirm(`Install ${p.label} on this PC (${gb(p.totalBytes)})? Review its model terms first.`, { title: 'Install local model', ok: 'Accept terms and install' })) return;
          button.disabled = true;
          try {
            const r = await fetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'download', id: p.capability, exact: true }) });
            const result = await r.json(); if (!r.ok) throw Error(result.error); status.textContent = 'Download started; follow progress in Models.';
          } catch (e) { status.textContent = e.message; button.disabled = false; }
        }); rows.append(button);
      }
      for (const r of data.readiness || []) rows.append(el('p', `${r.label}: ${r.inferenceValidated ? 'Local inference verified' : r.filesVerified ? 'Checksums verified; inference unverified' : r.workflowValidated ? 'Workflow checked; inference unverified' : r.filesDownloaded ? 'Files present; runtime needs checking' : 'Files needed'}`, 'hint'));
      const proof = el('details', null, 'more'); proof.append(el('summary', 'Verify a local sample'), el('p', 'Enable model hashes in Engine, create a sample, then press Check setup.', 'hint')); rows.append(proof);
      for (const profile of data.profiles) {
        const use = el('button', `Use in ${labels[profile.category]}`, 'edtool sm'); use.type = 'button';
        use.disabled = !modeMatches || !profile.localFilesPresent;
        use.addEventListener('click', () => document.dispatchEvent(new CustomEvent('aiplay:setup-model', { detail: { target, profile } })));
        rows.append(use);
      }
    } else if (chooseTarget) {
      const button = el('button', 'Open Cloud Setup', 'edtool'); button.type = 'button'; button.disabled = !modeMatches;
      button.addEventListener('click', () => { document.querySelector('.rail [data-view="settings"]')?.click(); revealSetting(document.getElementById('set-runpod')); }); rows.append(button);
    }
  }
  async function save(selection) {
    if (busy) return; ++revision; busy = true; where.disabled = true; paint(); status.textContent = 'Saving model plan…';
    try { data = await request(target, selection); publish(); }
    catch (e) { busy = false; where.disabled = false; paint(); status.textContent = e.message; return; }
    busy = false; where.disabled = false; paint();
  }
  async function load(verify = false) {
    if (busy) return;
    const requested = target, current = ++revision;
    if (verify === true && target === 'local') status.textContent = 'Checking model checksums and local test receipts…';
    try { const result = await request(requested, undefined, verify === true && target === 'local'); if (current !== revision || requested !== target) return; data = result; paint(); publish(); }
    catch (e) { status.textContent = e.message; }
  }
  where.addEventListener('change', async () => { target = where.value; rows.replaceChildren(); summary.replaceChildren(); status.textContent = 'Checking model plan…'; await load(); });
  root.addEventListener('aiplay:plan-refresh', load);
  document.addEventListener('aiplay:model-plan', event => {
    if (event.detail?.target !== target || event.detail === data || busy) return;
    ++revision; data = event.detail; paint();
  });
  const refresh = el('button', 'Check setup', 'edtool sm'); refresh.type = 'button'; refresh.addEventListener('click', () => load(true)); root.append(refresh);
  await load();
}
const local = typeof document === 'undefined' ? null : document.getElementById('localModelPlan');
local?.closest('details')?.addEventListener('toggle', event => { if (event.target.open) mountSetupPlanner(local, { chooseTarget: true }); });
