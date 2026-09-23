/**
 * THE MODELS SCREEN'S "WHAT YOU ALREADY HAVE" HALF.
 *
 *   - Models folder: where Studio checks, downloads into and loads from, with a
 *     native folder picker and a preview of what a folder holds before it is
 *     adopted.
 *   - Stand-ins: on a card with a missing file, pick a file already in the
 *     same model folder to use instead (an fp16 DiT where the catalogue names
 *     int8, say). The server renames it in every graph at the engine door.
 *   - On disk, not in the catalogue: every weight file in the folders the
 *     engine loads from, labelled by its own safetensors header.
 *
 * Reads the `local` block of /api/models; every change is a POST to the same
 * route, then a repaint through the callback web/app.js hands to initLocal().
 */

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/* Base 1000, like web/app.js and web/modelfit.js on the same screen. */
const gb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.round(n / 1e6)} MB`);
/* File names are shown without the extension; values keep it. */
const bare = (n) => String(n ?? "").replace(/\.(safetensors|sft|gguf|ckpt|pt|pth|bin)$/i, "");
const same = (a, b) => String(a || "").replace(/[\\/]+$/, "").toLowerCase() === String(b || "").replace(/[\\/]+$/, "").toLowerCase();

async function post(body) {
  const r = await fetch("/api/models", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { ok: r.ok, ...(await r.json().catch(() => ({}))) };
}

/* Longest shared leading run of characters — ranks `minimax_music3_dit_fp16`
 * above an unrelated DiT when `minimax_music3_dit_int8_convrot` is missing. */
function affinity(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  return i;
}

function ensure(root, id, tag, cls, place) {
  let el = root.getElementById(id);
  if (!el) {
    el = root.createElement(tag);
    el.id = id;
    el.className = cls;
    place(el);
  }
  return el;
}

/** Called by web/app.js right after the catalogue and the fit block paint. */
export function paintLocal(d, root = document) {
  const list = root.getElementById("modelList");
  const loc = d?.local;
  if (!list) return;

  const box = ensure(root, "modelFolder", "div", "mfolder",
    (el) => list.parentNode.insertBefore(el, root.getElementById("modelFit") || list));
  const extra = ensure(root, "modelExtra", "details", "mextra", (el) => list.after(el));
  if (!loc) { box.hidden = true; extra.hidden = true; return; }

  /* ── the folder ────────────────────────────────────────────────────── */
  const inFolder = loc.files.filter((f) => same(f.base, loc.modelsDir));
  const others = loc.bases.filter((b) => !same(b, loc.modelsDir));
  const typed = root.getElementById("mfPath");
  /* Keep a half-typed path across the repaints a download triggers. */
  const draft = typed && typed.value !== typed.defaultValue ? typed.value : null;
  box.hidden = false;
  box.innerHTML = `
    <div class="mfhead">
      <h3>Models folder</h3>
      <span class="mfcount">${inFolder.length} file${inFolder.length === 1 ? "" : "s"} · ${gb(inFolder.reduce((s, f) => s + f.bytes, 0))}</span>
    </div>
    <div class="mfrow">
      <input class="line" id="mfPath" spellcheck="false" value="${esc(loc.modelsDir)}"
        aria-label="Models folder path">
      <button class="btn sm ghost" type="button" data-mf="browse">Browse…</button>
      <button class="btn sm ghost" type="button" data-mf="check">Check</button>
      <button class="btn sm ghost" type="button" data-mf="also" disabled>Add as extra</button>
      <button class="btn sm" type="button" data-mf="use" disabled>Use this folder</button>
    </div>
    <p class="hint" id="mfNote">Studio checks for, downloads into and loads from this folder. Use this folder
      moves new downloads to another one; Add as extra also checks a second folder of models.${
      others.length ? ` The engine also loads from ${others.map(esc).join(" · ")}.` : ""}</p>
    ${(loc.also || []).length ? `<div class="mfalso">${(loc.also || []).map((d) => `
      <span>Also loading the models in <code>${esc(d)}</code></span>
      <button class="btn sm ghost" type="button" data-mf-drop="${esc(d)}">Stop using</button>`).join("")}</div>` : ""}`;
  if (draft !== null) root.getElementById("mfPath").value = draft;

  /* ── stand-ins, on each card that has a missing or swapped file ────── */
  const byShelf = {};
  for (const f of inFolder) (byShelf[f.shelf] ||= []).push(f);
  for (const c of d.capabilities || []) {
    const card = list.querySelector(`[data-cap="${CSS.escape(c.id)}"]`);
    if (!card) continue;
    card.querySelector(".mlocal")?.remove();
    if (c.nativeSetup || c.managedByPackage) continue;
    let swapped = false, likely = false, offered = 0;
    const rows = (c.files || []).map((f) => {
      if (f.override) {
        swapped = true;
        return `<div class="mlrow"><span>Using <code>${esc(bare(f.override))}</code> in place of <code>${esc(bare(f.name))}</code></span>
          <button class="btn sm ghost" type="button" data-mo-undo="${esc(f.name)}">Undo</button></div>`;
      }
      if (f.present || !f.shelf) return "";
      /* Never a file the catalogue already uses for something else — the DAV
       * decoder shares a prefix with the DAV encoder and is not one. */
      const cands = (byShelf[f.shelf] || [])
        .filter((x) => x.name !== f.name && !x.known)
        .sort((a, b) => affinity(b.name, f.name) - affinity(a.name, f.name) || a.name.localeCompare(b.name));
      if (!cands.length) return "";
      offered++;
      /* A long shared name prefix ("minimax_music3_dit_…") is a probable other
       * build of the same model — worth opening the panel for. */
      if (affinity(cands[0].name, f.name) >= 12) likely = true;
      return `<div class="mlrow">
        <span>Missing <code>${esc(bare(f.name))}</code> — use a file you already have:</span>
        <select data-mo-sel="${esc(f.name)}" aria-label="Stand-in for ${esc(f.name)}">
          <option value="">choose from ${esc(f.shelf)}…</option>
          ${cands.map((x) => `<option value="${esc(x.name)}">${esc(bare(x.name))} · ${gb(x.bytes)}${x.family ? ` · ${esc(x.family)}` : ""}</option>`).join("")}
        </select>
        <button class="btn sm ghost" type="button" data-mo-use="${esc(f.name)}" disabled>Use</button>
      </div>`;
    }).filter(Boolean);
    if (!rows.length) continue;
    /* Closed unless a file is already swapped or a probable match exists:
     * otherwise every card missing a DiT would list every DiT on the disk. */
    const el = root.createElement("details");
    el.className = "mlocal";
    el.open = swapped || likely;
    el.innerHTML = `<summary>${swapped ? "Using a file you already have"
      : `Use a file you already have${offered > 1 ? ` (${offered} missing files)` : ""}`}</summary>`
      + rows.join("")
      + `<p class="hint">A stand-in must be the same kind of model. Studio renders with it as it is, and the render record names the file actually used.</p>`;
    card.insertBefore(el, card.querySelector(".mfoot"));
  }

  /* ── everything else on disk ───────────────────────────────────────── */
  const unknown = loc.files.filter((f) => !f.known && !f.standsInFor);
  extra.hidden = !unknown.length;
  const wasOpen = extra.open;
  const groups = {};
  for (const f of unknown) (groups[f.folder] ||= []).push(f);
  extra.innerHTML = `
    <summary>On disk, not in the catalogue <span class="mfcount">${unknown.length} files · ${gb(unknown.reduce((s, f) => s + f.bytes, 0))}</span></summary>
    <p class="hint">Found in the folders the engine loads from. Checkpoints and DiTs are usable on the Images
      screen; any file here can stand in for a missing catalogue file on its card above.</p>
    <table>
      ${Object.entries(groups).map(([folder, fs]) => `
        <tr><th colspan="3">${esc(folder)}</th></tr>
        ${fs.sort((a, b) => a.name.localeCompare(b.name)).map((f) => `
          <tr title="${esc(f.base)}">
            <td>${esc(bare(f.name))}</td>
            <td class="fam">${esc([f.family, f.variant].filter(Boolean).join(" · ") || "—")}</td>
            <td class="n">${gb(f.bytes)}</td>
          </tr>`).join("")}`).join("")}
    </table>`;
  extra.open = wasOpen;
}

/** Delegated once, so every repaint keeps working. */
export function initLocal(refresh, root = document) {
  const note = (text, bad = false) => {
    const n = root.getElementById("mfNote");
    if (!n) return;
    n.textContent = text;
    n.classList.toggle("fitbad", bad);
  };
  const useBtn = () => root.querySelector('[data-mf="use"]');
  const alsoBtn = () => root.querySelector('[data-mf="also"]');

  /* An empty or not-yet-made folder is a legitimate choice: it is where NEW
   * downloads go. The folder being left is remembered by the server and still
   * loaded from, so nothing already downloaded is lost or fetched again. */
  let fresh = false;
  async function check(dir) {
    note("Looking…");
    fresh = false;
    const current = root.getElementById("mfPath")?.defaultValue;
    const r = await post({ action: "scanFolder", dir });
    const b = useBtn();
    if (!r.ok) {
      if (/^Not a folder/.test(r.error || "")) {
        fresh = true;
        note(`${dir} does not exist yet. Use this folder creates it and sends new downloads there; `
          + "the models you already have keep working from where they are.");
        if (b) b.disabled = false;
        if (alsoBtn()) alsoBtn().disabled = true;
        return;
      }
      note(r.error || "Could not read that folder.", true);
      if (b) b.disabled = true;
      if (alsoBtn()) alsoBtn().disabled = true;
      return;
    }
    const parts = Object.entries(r.folders || {}).map(([k, v]) => `${k} ${v.files}`);
    if (!r.files) fresh = true;
    note(r.files
      ? `${r.files} model files, ${gb(r.bytes)}: ${parts.join(" · ")}.${same(r.dir, current) ? " This is the current folder." : ""}`
      : `${r.dir} has no models yet. Use this folder sends new downloads there; the models you already have keep working from where they are.`);
    if (b) b.disabled = same(r.dir, current);
    if (alsoBtn()) alsoBtn().disabled = !r.files || same(r.dir, current);
  }

  root.addEventListener("input", (e) => {
    if (e.target.id !== "mfPath") return;
    if (useBtn()) useBtn().disabled = true;
    if (alsoBtn()) alsoBtn().disabled = true;
  });
  root.addEventListener("change", (e) => {
    const sel = e.target.closest?.("[data-mo-sel]");
    if (!sel) return;
    const btn = sel.parentElement.querySelector("[data-mo-use]");
    if (btn) btn.disabled = !sel.value;
  });
  root.addEventListener("click", async (e) => {
    const mf = e.target.closest?.("[data-mf]");
    const drop = e.target.closest?.("[data-mf-drop]");
    if (drop) {
      drop.disabled = true;
      const r = await post({ action: "dropAlso", dir: drop.dataset.mfDrop });
      note(r.ok ? r.note : (r.error || "Not saved."), !r.ok);
      return;
    }
    const use = e.target.closest?.("[data-mo-use]");
    const undo = e.target.closest?.("[data-mo-undo]");
    if (!mf && !use && !undo) return;
    const btn = mf || use || undo;
    btn.disabled = true;
    try {
      if (mf?.dataset.mf === "browse") {
        note("Waiting for the folder dialog — it may open behind this window.");
        const r = await post({ action: "pickFolder" });
        if (!r.ok) { note(r.error || "The folder dialog failed.", true); return; }
        if (!r.path) { note("No folder chosen."); return; }
        root.getElementById("mfPath").value = r.path;
        await check(r.path);
      } else if (mf?.dataset.mf === "check") {
        await check(root.getElementById("mfPath").value);
      } else if (mf?.dataset.mf === "also") {
        const r = await post({ action: "addAlso", dir: root.getElementById("mfPath").value });
        note(r.ok ? r.note : (r.error || "Not saved."), !r.ok);
        return;   // stays disabled: nothing changes until restart
      } else if (mf?.dataset.mf === "use") {
        const r = await post({ action: "setModelsDir", dir: root.getElementById("mfPath").value, force: fresh, create: fresh });
        note(r.ok ? r.note : (r.error || "Not saved."), !r.ok);
        return;   // stays disabled: nothing changes until restart
      } else if (use) {
        const sel = use.parentElement.querySelector("[data-mo-sel]");
        const r = await post({ action: "override", file: use.dataset.moUse, use: sel?.value });
        if (!r.ok) { alert(r.error || "Could not use that file."); return; }
        refresh();
      } else if (undo) {
        const r = await post({ action: "override", file: undo.dataset.moUndo, use: null });
        if (!r.ok) { alert(r.error || "Could not undo."); return; }
        refresh();
      }
    } finally {
      /* "Use this folder" stays disabled once saved — nothing changes until a
       * restart, and check() re-enables it for a different folder. */
      if (mf?.dataset.mf !== "use" && mf?.dataset.mf !== "also") btn.disabled = false;
    }
  });
}
