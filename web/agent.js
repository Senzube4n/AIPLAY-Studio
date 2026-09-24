/**
 * THE AGENT PAGE — cloud model keys, which model answers where, and the MCP
 * details for an assistant outside the app.
 *
 * Everything here reads the running server rather than a list typed into the
 * page: the providers and their connection state from GET /api/llm, each
 * provider's models from GET /api/llm/models (oldest first, as the provider
 * dates them), the two "who answers" menus from the same routes the Chat
 * header and the Simple panel use, and the tool list from GET /api/mcp.
 *
 * A key typed here goes to POST /api/llm once, is checked against the provider
 * there, and is never sent back — the page only ever sees `…abcd`.
 *
 * app.js owns the view switch and says "aiplay:agent-open" when this view
 * opens; this file says "aiplay:llm-changed" whenever a key or a model changes,
 * so the Chat and Simple menus refresh without a reload.
 */
import { fillModelMenu } from "./chat.js";
import { appConfirm, appPrompt } from "./dialog.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = {
  providers: [],
  open: null,                 // the provider row that is expanded
  models: new Map(),          // provider id -> [{id, label, created}] | {error}
  busy: new Set(),            // provider ids with a request in flight
  notes: new Map(),           // provider id -> {kind: "ok"|"err"|"info", text}
  mcpLoaded: false,
};

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let d = null;
  try { d = await r.json(); } catch { /* not JSON */ }
  if (!r.ok || d?.error) throw new Error(d?.error || `request failed (${r.status})`);
  return d;
}

const changed = () => document.dispatchEvent(new CustomEvent("aiplay:llm-changed"));

/* ── formatting ──────────────────────────────────────────────────────────── */

const initials = (name) => {
  const w = String(name).replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/);
  return (w.length > 1 ? w[0][0] + w[1][0] : w[0].slice(0, 2)).toUpperCase();
};

const monthYear = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "");

function tokens(n) {
  if (!n) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function modelLabel(p) {
  const list = state.models.get(p.id);
  const hit = Array.isArray(list) ? list.find((m) => m.id === p.model) : null;
  return hit?.label || p.model || "";
}

/* ── the provider list ───────────────────────────────────────────────────── */

function renderProviders() {
  const box = $("agProviders");
  if (!box) return;
  const rows = [...state.providers].sort((a, b) => (b.connected - a.connected));
  const n = state.providers.filter((p) => p.connected).length;
  $("agConnected").textContent = n ? `${n} connected` : "";
  $("agConnected").hidden = !n;
  box.innerHTML = rows.map(providerRow).join("");
}

function providerRow(p) {
  const open = state.open === p.id;
  const busy = state.busy.has(p.id);
  const pill = p.connected
    ? `<span class="ag-state on"><i></i>${esc(p.model ? modelLabel(p) : "Connected")}</span>`
    : '<span class="ag-state">Not connected</span>';
  return `
  <div class="ag-prov${open ? " open" : ""}${p.connected ? " connected" : ""}" data-prov="${esc(p.id)}">
    <button class="ag-provhead" type="button" data-act="toggle" aria-expanded="${open}">
      <span class="ag-mono" aria-hidden="true">${esc(initials(p.name))}</span>
      <span class="ag-name"><b>${esc(p.name)}</b><i>${esc(p.company)}</i></span>
      ${pill}
      <span class="ag-chev" aria-hidden="true"></span>
    </button>
    <div class="ag-provbody"${open ? "" : " hidden"}>
      ${open ? (p.connected && !p.replacing ? connectedBody(p, busy) : connectBody(p, busy)) : ""}
      ${open ? noteHtml(p.id) : ""}
    </div>
  </div>`;
}

function noteHtml(id) {
  const n = state.notes.get(id);
  return n ? `<p class="ag-note ${n.kind}" role="status">${esc(n.text)}</p>` : "";
}

function connectBody(p, busy) {
  return `
    <form class="ag-connect" data-act="connect">
      ${p.custom ? `
      <label class="ag-field"><span>Server address</span>
        <input class="ag-input" name="base" type="url" required placeholder="http://127.0.0.1:1234/v1"
          value="${esc(p.base || "")}" autocomplete="off" spellcheck="false"></label>` : ""}
      <label class="ag-field"><span>API key${p.keyOptional ? " <i>(optional)</i>" : ""}</span>
        <input class="ag-input" name="key" type="password" ${p.keyOptional ? "" : "required"}
          placeholder="${esc(p.keyHint || "Paste your key")}" autocomplete="off" spellcheck="false"></label>
      <div class="ag-actions">
        <button class="ag-btn primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Checking…" : "Connect"}</button>
        ${p.replacing ? '<button class="ag-btn ghost" type="button" data-act="cancel">Cancel</button>' : ""}
        ${p.keyUrl ? `<a class="ag-link" href="${esc(p.keyUrl)}" target="_blank" rel="noopener">Get a ${esc(p.name)} key ↗</a>` : ""}
      </div>
    </form>`;
}

function connectedBody(p, busy) {
  const list = state.models.get(p.id);
  let select;
  if (!list) {
    select = '<select class="sel2 ag-modelsel" disabled><option>Loading models…</option></select>';
  } else if (list.error) {
    select = `<select class="sel2 ag-modelsel" disabled><option>${esc(p.model || "unavailable")}</option></select>`;
  } else {
    const newest = list.length - 1;
    select = `<select class="sel2 ag-modelsel" data-act="model" ${busy ? "disabled" : ""}>${list.map((m, i) =>
      `<option value="${esc(m.id)}" ${m.id === p.model ? "selected" : ""}>${esc(m.label)}${m.label !== m.id ? ` — ${esc(m.id)}` : ""}${
        m.created ? ` · ${esc(monthYear(m.created))}` : ""}${i === newest && m.created ? " · newest" : ""}</option>`).join("")}</select>`;
  }
  const u = p.usage;
  const usage = u ? `${u.calls} request${u.calls === 1 ? "" : "s"} · ${tokens(u.input)} tokens in · ${tokens(u.output)} out` : "No requests yet";
  /* "Using the key …abcd saved on 21 Sep 2026 by another copy of Studio": the
   * server's sentence (server/secrets.js), so a key saved by another copy on
   * this Windows account is shown as that. Replace key / Disconnect beside it. */
  const keyWords = (p.said || `Key ${p.hint}`).replace(/\.$/, "");
  const where = p.custom ? p.base : p.hint ? `${keyWords}${p.protection === "dpapi" ? " · encrypted with Windows DPAPI" : p.protection ? " · not encrypted: plain text in your Studio profile" : ""}` : "";
  return `
    <div class="ag-grid">
      <label class="ag-field wide"><span>Model <i>oldest → newest${list && !list.error ? ` · ${list.length}` : ""}</i></span>${select}</label>
      <div class="ag-meta">
        <div><span>Connection</span><b>${esc(where)}</b></div>
        <div><span>This month</span><b>${esc(usage)}</b></div>
      </div>
    </div>
    ${list?.error ? `<p class="ag-note err">${esc(list.error)}</p>` : ""}
    <div class="ag-actions">
      <button class="ag-btn primary" type="button" data-act="test" ${busy || !p.model ? "disabled" : ""}>${busy ? "Working…" : "Send a test message"}</button>
      <button class="ag-btn ghost" type="button" data-act="refresh" ${busy ? "disabled" : ""}>Refresh models</button>
      <span class="ag-spacer"></span>
      <button class="ag-btn ghost" type="button" data-act="replace" ${busy ? "disabled" : ""}>${p.custom ? "Change server" : "Replace key"}</button>
      <button class="ag-btn danger" type="button" data-act="disconnect" ${busy ? "disabled" : ""}>Disconnect</button>
    </div>`;
}

async function loadModelsFor(id, fresh = false) {
  try {
    const d = await api(`/api/llm/models?provider=${encodeURIComponent(id)}${fresh ? "&fresh=1" : ""}`);
    state.models.set(id, d.models);
  } catch (e) {
    state.models.set(id, { error: e.message });
  }
  renderProviders();
  renderUsing();
}

async function loadProviders() {
  try {
    const d = await api("/api/llm");
    state.providers = d.providers || [];
  } catch (e) {
    $("agProviders").innerHTML = `<p class="ag-note err">Could not read the providers: ${esc(e.message)}</p>`;
    return;
  }
  renderProviders();
  renderUsing();
  for (const p of state.providers) if (p.connected && !state.models.has(p.id)) loadModelsFor(p.id);
}

/* ── one row's actions ───────────────────────────────────────────────────── */

async function act(id, fn) {
  state.busy.add(id);
  state.notes.delete(id);
  renderProviders();
  try { await fn(); }
  catch (e) { state.notes.set(id, { kind: "err", text: e.message }); }
  state.busy.delete(id);
  renderProviders();
}

async function onProviders(e) {
  const row = e.target.closest("[data-prov]");
  if (!row) return;
  const id = row.dataset.prov;
  const p = state.providers.find((x) => x.id === id);
  const el = e.target.closest("[data-act]");
  if (!p || !el) return;

  if (e.type === "submit") e.preventDefault();
  const what = el.dataset.act;

  if (what === "toggle" && e.type === "click") {
    state.open = state.open === id ? null : id;
    renderProviders();
    const input = $("agProviders").querySelector(`[data-prov="${CSS.escape(id)}"] input`);
    if (state.open === id && input) input.focus();
    return;
  }
  if (what === "connect" && e.type === "submit") {
    const f = new FormData(el);
    act(id, async () => {
      const r = await api("/api/llm", { action: "connect", provider: id, key: f.get("key") || "", base: f.get("base") });
      state.providers = r.status.providers;
      state.models.delete(id);
      state.notes.set(id, r.checked
        ? { kind: "ok", text: `Connected. ${r.count} model${r.count === 1 ? "" : "s"} available${r.model ? `; using ${r.model}` : ""}.` }
        : { kind: "info", text: "Saved, but the provider could not be reached to check the key. Try “Send a test message”." });
      loadModelsFor(id);
      changed();
    });
    return;
  }
  if (what === "model" ? e.type !== "change" : e.type !== "click") return;

  if (what === "model") {
    act(id, async () => {
      const r = await api("/api/llm", { action: "model", provider: id, model: el.value });
      state.providers = r.status.providers;
      changed();
      renderUsing();
    });
  } else if (what === "test") {
    act(id, async () => {
      const r = await api("/api/llm", { action: "test", provider: id });
      state.notes.set(id, { kind: "ok", text: `${r.model} answered in ${(r.ms / 1000).toFixed(1)} s: ${r.reply.replace(/\s+/g, " ").trim()}` });
      const st = await api("/api/llm");
      state.providers = st.providers;
    });
  } else if (what === "refresh") {
    act(id, () => loadModelsFor(id, true));
  } else if (what === "replace") {
    p.replacing = true;           // show the form; the saved key stays until a new one is accepted
    renderProviders();
  } else if (what === "cancel") {
    p.replacing = false;
    renderProviders();
  } else if (what === "disconnect") {
    if (!(await appConfirm(`Disconnect ${p.name}? The saved key is deleted from this machine.`))) return;
    act(id, async () => {
      const r = await api("/api/llm", { action: "disconnect", provider: id });
      state.providers = r.status.providers;
      state.models.delete(id);
      state.notes.set(id, { kind: "info", text: "Disconnected. The key was deleted." });
      changed();
    });
  }
}

/* ── who answers where ───────────────────────────────────────────────────── */

const USES = [
  { sel: "agChatModel", route: "/api/chat/models" },
  { sel: "agSimpleModel", route: "/api/chat/music/models" },
];

async function renderUsing() {
  const summary = [];
  for (const u of USES) {
    const sel = $(u.sel);
    if (!sel) continue;
    let d = null;
    try { d = await (await fetch(u.route)).json(); } catch { /* offline */ }
    const cur = fillModelMenu(sel, d, "No local chat model found — connect an API above");
    summary.push({ where: u.sel === "agChatModel" ? "Chat" : "Simple", cur });
  }
  const box = $("agUsing");
  if (box) {
    box.innerHTML = summary.map((s) => `<div><span>${esc(s.where)}</span><b class="${s.cur?.api ? "cloud" : ""}">${
      esc(s.cur ? (s.cur.api ? s.cur.label.replace(" API · ", " · ") : s.cur.label) : "—")}</b></div>`).join("");
  }
}

async function chooseUse(e) {
  const u = USES.find((x) => x.sel === e.target.id);
  if (!u) return;
  e.target.disabled = true;
  try { await api(u.route, { model: e.target.value }); }
  catch (err) { alert(err.message); }
  changed();
  renderUsing();
}

/* ── MCP ─────────────────────────────────────────────────────────────────── */

async function loadMcpInfo() {
  if (state.mcpLoaded) return;
  let d = null;
  try { d = await (await fetch("/api/mcp")).json(); } catch { /* offline */ }
  const box = $("mcpTools");
  if (!d?.tools?.length) {
    box.textContent = "Could not read the tool list — see server/mcp.js.";
    $("mcpToolCount").textContent = "?";
    return;
  }
  state.mcpLoaded = true;
  $("mcpConfig").textContent = JSON.stringify({
    mcpServers: { "aiplay-studio": { command: d.command, args: d.args, env: { AIPLAY_URL: d.url } } },
  }, null, 2);
  $("mcpToolCount").textContent = String(d.tools.length);
  box.innerHTML = d.tools.map((t) => `
    <div class="ag-tool" data-search="${esc(`${t.name} ${t.summary}`.toLowerCase())}">
      <code>${esc(t.name)}</code>
      <span>${esc(t.summary)}</span>
      <i>${t.required?.length ? `needs ${t.required.map(esc).join(", ")}` : "no arguments"}</i>
    </div>`).join("");
}

function filterTools() {
  const q = $("mcpToolFilter").value.trim().toLowerCase();
  let shown = 0;
  for (const row of $("mcpTools").querySelectorAll(".ag-tool")) {
    const hit = !q || row.dataset.search.includes(q);
    row.hidden = !hit;
    if (hit) shown++;
  }
  const total = $("mcpTools").querySelectorAll(".ag-tool").length;
  $("mcpToolCount").textContent = q ? `${shown} of ${total}` : String(total);
}

async function copyConfig() {
  const btn = $("mcpCopy");
  try {
    await navigator.clipboard.writeText($("mcpConfig").textContent);
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Select and copy";
  }
  setTimeout(() => { btn.textContent = "Copy"; }, 1600);
}

/* ── boot ────────────────────────────────────────────────────────────────── */

function open() {
  loadProviders();
  loadMcpInfo();
}

function init() {
  if (!$("agProviders")) return;
  const box = $("agProviders");
  box.addEventListener("click", onProviders);
  box.addEventListener("submit", onProviders);
  box.addEventListener("change", onProviders);
  for (const u of USES) $(u.sel)?.addEventListener("change", chooseUse);
  $("mcpCopy")?.addEventListener("click", copyConfig);
  $("mcpToolFilter")?.addEventListener("input", filterTools);
  document.addEventListener("aiplay:agent-open", open);
  if (!$("mcp").hidden) open();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}
