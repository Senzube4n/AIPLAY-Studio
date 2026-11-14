#!/usr/bin/env node
/** Read-only GPU report for the exact Python selected by Studio. No installs,
 * settings writes, model downloads, provider calls or credentials in output. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { torchProbeCode, torchProbeFailure, parseNvidiaSmi, nvidiaRuntimePlan } from '../server/setup/torch-runtime.js';

const execute = promisify(execFile);
const BACKENDS = ['nvidia', 'amd', 'intel', 'cpu'];

export async function diagnoseEngine({ python, backend, gpuName = '' }, run = execute) {
  if (!python) throw new Error('No engine Python selected. Use --python with the Python executable that starts ComfyUI.');
  if (!BACKENDS.includes(backend)) throw new Error('Choose --backend nvidia, amd, intel or cpu.');
  const options = { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024, encoding: 'utf8' };
  const report = { schemaVersion: 1, ok: false, expectedBackend: backend, python, devices: [], probe: null };
  if (backend === 'nvidia') {
    try {
      const { stdout } = await run('nvidia-smi', ['--query-gpu=name,compute_cap,driver_version', '--format=csv,noheader'], options);
      report.devices = String(stdout).split(/\r?\n/).map(line => parseNvidiaSmi(line)).filter(Boolean);
    } catch (error) {
      report.deviceCheckError = String(error.stderr || error.message || error).trim();
    }
  }
  try {
    const { stdout, stderr } = await run(python, ['-s', '-c', torchProbeCode(backend)], options);
    const line = String(stdout).split(/\r?\n/).findLast(value => value.startsWith('@@probe '));
    if (!line) throw new Error(`The engine Python returned no runtime report. ${stderr || ''}`.trim());
    report.probe = JSON.parse(line.slice(8));
    if (stderr?.trim()) report.runtimeWarnings = stderr.trim();
  } catch (error) {
    report.failure = `Could not check the engine Python: ${String(error.stderr || error.message || error).trim()}`;
    return report;
  }
  const selected = parseNvidiaSmi(report.devices.map(device => `${device.name},${device.capability},${device.driverVersion}`).join('\n'), report.probe.name || gpuName);
  report.failure = torchProbeFailure(report.probe, backend, { python, driverVersion: selected?.driverVersion });
  report.ok = report.failure === null;
  if (backend === 'nvidia' && selected) report.freshInstallProfile = nvidiaRuntimePlan({ gpuName: selected.name, capability: selected.capability, driverVersion: selected.driverVersion });
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Read-only GPU diagnosis. Uses Studio\'s saved engine Python by default.\n'
      + 'node scripts/diagnose-engine.mjs [--python "path/to/python"] [--backend nvidia|amd|intel|cpu]\n'
      + 'To save a shareable report, redirect output to gpu-report.json. Review local paths before sharing.');
    return;
  }
  const parsed = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--python', '--backend'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use --python <executable> and/or --backend nvidia|amd|intel|cpu.');
    parsed[args[i].slice(2)] = args[i + 1];
  }
  const appData = process.env.AIPLAY_APPDATA || path.join(homedir(), '.aiplay-studio');
  let settings = {};
  try { if (!parsed.python || !parsed.backend) settings = JSON.parse(await readFile(path.join(appData, 'settings.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read Studio settings. Supply --python and --backend explicitly.', { cause: error }); }
  const report = await diagnoseEngine({ python: parsed.python || settings.python, backend: parsed.backend || settings.gpu?.vendor, gpuName: settings.gpu?.name });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.log(JSON.stringify({ ok: false, failure: error.message }, null, 2)); process.exitCode = 1; });
}
