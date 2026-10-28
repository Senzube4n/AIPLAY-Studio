/** One local H3 source-clip choice, shared by preflight and Render. */
export function isControlVideo(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 255
    && !/[\\/\x00-\x1f]/.test(name) && !name.includes("..")
    && /\.(mp4|webm|mov|mkv|m4v)$/i.test(name);
}

export function videoControlSpec({ sourceVideo = "", controlMode = "depth", controlStrength = 1,
  controlStart = 0, controlEnd = 1 } = {}) {
  if (!sourceVideo) return {};
  if (!isControlVideo(sourceVideo)) throw new Error("Choose a video from this Studio's library.");
  if (!["depth", "pose"].includes(controlMode)) throw new Error("Choose Depth or Pose control.");
  for (const [name, value, max] of [["strength", controlStrength, 2], ["start", controlStart, 1], ["end", controlEnd, 1]]) {
    if (!Number.isFinite(value) || value < 0 || value > max) throw new Error(`Control ${name} is outside its range.`);
  }
  if (controlStart >= controlEnd) throw new Error("Control start must be before its end.");
  return { sourceVideo, controlMode, controlStrength, controlStart, controlEnd };
}

export function controlRouteIssue({ sourceVideo, engine, remote = false, custom = false, recipe = false } = {}) {
  if (!sourceVideo) return "";
  if (remote) return "Source clips need the local H3 engine; remote video inputs are not supported.";
  if (engine !== "h3") return "Choose MiniMax H3 to use this source clip.";
  if (custom) return "Unassign the custom Video workflow to use this source clip.";
  if (recipe) return "Clear friend recipe mode before using a source clip.";
  return "";
}

export function mountH3VideoControl(host, { getEngine = () => "h3", getRemote = () => false,
  getCustom = () => false, getRecipe = () => false, getClips = () => [], loadClips = async () => {},
  onChange = () => {}, offerModel = () => {}, request = (...args) => fetch(...args) } = {}) {
  if (!host) return { spec: () => ({}), paint() {}, clear() {}, assertAllowed() {}, readiness() {} };
  const find = id => host.querySelector(`#${id}`);
  const source = find("vidControlSource"), mode = find("vidControlMode");
  const strength = find("vidControlStrength"), start = find("vidControlStart"), end = find("vidControlEnd");
  const menu = find("vidControlMenu"), input = find("vidControlFile"), preview = find("vidControlPreview");
  const status = find("vidControlStatus"), note = find("vidControlNote"), fix = find("vidControlGet");
  let selected = null, busy = false, revision = 0, failure = null, checked = false;

  function spec() {
    const number = el => String(el.value).trim() ? Number(el.value) : NaN;
    return videoControlSpec({ sourceVideo: selected?.name || "", controlMode: mode.value,
      controlStrength: number(strength), controlStart: number(start), controlEnd: number(end) });
  }
  const issue = () => controlRouteIssue({ sourceVideo: selected?.name, engine: getEngine(),
    remote: getRemote(), custom: getCustom(), recipe: getRecipe() });
  function paint() {
    host.hidden = getEngine() !== "h3" && !selected;
    const blocked = issue();
    find("vidControlCard").hidden = !selected;
    find("vidControlName").textContent = selected?.label || "";
    find("vidControlOptions").hidden = !selected;
    find("vidControlLibrary").disabled = busy;
    find("vidControlUpload").disabled = busy;
    for (const el of [mode, strength, start, end]) el.disabled = busy || !!blocked;
    const error = blocked || failure?.error || "";
    status.textContent = busy ? "Importing" : blocked ? "Route unavailable" : failure?.needsModel ? "Model missing"
      : failure ? "Source unavailable" : checked && selected ? "Source ready" : selected ? "Check source" : "Optional";
    status.className = `chip${busy ? " busy" : error ? " warn" : checked && selected ? " ok" : ""}`;
    note.hidden = !error;
    note.textContent = error;
    fix.hidden = !!blocked || !failure?.needsModel;
    fix.disabled = busy;
  }
  function changed() {
    failure = null; checked = false; paint();
    source.dispatchEvent(new Event("change", { bubbles: true }));
    onChange();
  }
  function choose(row) {
    if (!isControlVideo(row?.name)) throw new Error("Choose a video clip, not a picture or song.");
    revision++;
    selected = { name: row.name, label: row.title || row.name };
    source.value = selected.name;
    preview.pause?.();
    preview.src = `/api/clip/${encodeURIComponent(selected.name)}`;
    menu.hidden = true;
    changed();
  }
  function clear() {
    revision++; selected = null; source.value = "";
    preview.pause?.(); preview.removeAttribute("src");
    menu.hidden = true;
    changed();
  }
  async function upload(file) {
    if (busy) return;
    if (!file || !isControlVideo(file.name)) throw new Error("Choose an MP4, WebM, MOV, MKV or M4V video.");
    if (!file.size || file.size > 2_000_000_000) throw new Error("Choose a nonempty video below 2 GB.");
    const mine = ++revision;
    busy = true; paint();
    try {
      const response = await request("/api/studio/import", { method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream", "x-name": encodeURIComponent(file.name) }, body: file });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || "The source clip could not be imported.");
      if (result.kind !== "video" || !isControlVideo(result.name)) throw new Error("That import did not return a video clip.");
      if (mine !== revision) return;
      choose({ name: result.name, title: file.name });
      await loadClips();
    } finally { busy = false; paint(); }
  }
  function showError(error) {
    failure = { error: String(error?.message || error) }; checked = false; paint();
  }
  async function showLibrary() {
    if (busy) return;
    if (!menu.hidden) { menu.hidden = true; return; }
    busy = true; paint();
    try {
      await loadClips();
      menu.replaceChildren();
      const rows = getClips().filter(row => isControlVideo(row.name) && (!row.meta?.kind || row.meta.kind === "video"));
      for (const row of rows) {
        const button = document.createElement("button");
        button.type = "button"; button.className = "edtool"; button.textContent = row.title || row.name;
        button.title = row.name;
        button.addEventListener("click", () => { try { choose(row); } catch (error) { showError(error); } });
        menu.appendChild(button);
      }
      if (!rows.length) {
        const empty = document.createElement("p"); empty.className = "hint";
        empty.textContent = "No video clips yet. Upload one to start."; menu.appendChild(empty);
      }
      menu.hidden = false;
    } catch (error) { showError(error); }
    finally { busy = false; paint(); }
  }
  function assertAllowed() {
    if (busy) throw new Error("Wait for the source picker to finish.");
    const blocked = issue();
    if (blocked) { paint(); throw new Error(blocked); }
    return spec();
  }
  function readiness(result, requested = {}) {
    if (!selected || requested.sourceVideo !== selected.name) return;
    let current;
    try { current = spec(); } catch { return; }
    for (const key of Object.keys(current)) if (requested[key] !== current[key]) return;
    failure = result?.refusal || (result?.error ? result : null);
    checked = !failure && result?.ok === true;
    paint();
  }
  for (const el of [mode, strength, start, end]) el.addEventListener("input", changed);
  find("vidControlLibrary").addEventListener("click", showLibrary);
  find("vidControlUpload").addEventListener("click", () => input.click());
  find("vidControlRemove").addEventListener("click", clear);
  fix.addEventListener("click", () => { if (failure?.needsModel) offerModel(failure); });
  input.addEventListener("change", async () => {
    const file = input.files?.[0]; input.value = "";
    if (file) try { await upload(file); } catch (error) { showError(error); }
  });
  const zone = find("vidControlDrop");
  zone.addEventListener("dragover", event => {
    if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
    event.preventDefault(); event.stopPropagation(); zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", async event => {
    event.preventDefault(); event.stopPropagation(); zone.classList.remove("over");
    const file = event.dataTransfer?.files?.[0];
    if (file) try { await upload(file); } catch (error) { showError(error); }
  });
  host.addEventListener("keydown", event => { if (event.key === "Escape") menu.hidden = true; });
  document.addEventListener("click", event => { if (!host.contains(event.target)) menu.hidden = true; });
  paint();
  return { spec, paint, clear, assertAllowed, readiness, choose, upload };
}
