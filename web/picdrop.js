/**
 * A PICTURE DROP BOX, built to look and behave like the Music screen's
 * "Drop a song here" box.
 *
 *   - While a picture is being dragged, a big dashed zone slides open ("Drop a
 *     picture here…") and lights up under the pointer. It is hidden otherwise,
 *     exactly as Music's is.
 *   - A dragged gallery picture travels as a small card (thumbnail, prompt,
 *     model), like a dragged song.
 *   - A single slot that holds a picture shows it as a card: thumbnail, name,
 *     one line, ▾ to choose another, ✕ to remove. Music's filled song card.
 *   - "Library ▾" (a thumbnail grid of the gallery and the song covers) and
 *     "Upload…" are always there as two small buttons.
 *
 * It does not know what a reference IS. The screen passes callbacks, and the
 * box calls them with a library picture (`onPick`) or with files (`onFiles`);
 * uploading, the preview strip and the limits stay in app.js. A picture that
 * is not in the library is fetched and handed over as a file.
 *
 *   mountPicDrop(host, {
 *     zone: "Drop a picture here to …",       // the dashed zone's words
 *     multiple,
 *     candidates: () => [{ name, url, label, group }],
 *     onPick: async (candidate) => {},
 *     onFiles: async (File[]) => {},
 *     current: () => ({ label, sub, url }) | null,   // single slots
 *     onClear: () => {},                             // single slots
 *     blocked: () => "reason" | "",
 *     beforeMenu: async () => {},
 *     bar: element,     // put Library / Upload in this existing toolbar row
 *     strip: element,   // the screen's own thumbnail strip, shown INSIDE the zone
 *     clear: element,   // its "Clear all", shown in the zone's corner
 *   })
 *
 * With a strip, the zone is where the pictures live: open whenever there are
 * any, a grid that fills across and then down, and it lights up when more
 * are dragged over it.
 */

/** The drag type a gallery tile carries: JSON `{ name, url }`. */
export const PIC_DRAG = "application/x-aiplay-pic";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** A picture the app serves, as a File, for the screens that only take files. */
export async function urlToFile(url, name = "picture.png") {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not read that picture (${r.status}).`);
  const blob = await r.blob();
  const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
  const base = String(name).split(/[\\/]/).pop().replace(/\.[^.]+$/, "") || "picture";
  return new File([blob], `${base}.${ext}`, { type: blob.type || "image/png" });
}

const boxes = new Set();

function carriesPicture(dt) {
  const types = [...(dt?.types || [])];
  return types.includes(PIC_DRAG) || types.includes("Files") || types.includes("text/uri-list");
}

/* THE ZONE ALWAYS CLOSES: on a drop anywhere, on dragend, and when drag
 * events stop arriving (the same three exits Music's song box uses). */
let dragTimer = null;
function dragEnd() {
  clearTimeout(dragTimer);
  for (const b of boxes) b.classList.remove("dragging", "over");
}
document.addEventListener("dragover", (e) => {
  if (!carriesPicture(e.dataTransfer)) return;
  for (const b of boxes) b.classList.add("dragging");
  clearTimeout(dragTimer);
  dragTimer = setTimeout(dragEnd, 400);
});
document.addEventListener("drop", dragEnd);
document.addEventListener("dragend", dragEnd);
document.addEventListener("mousemove", (e) => { if (e.buttons === 0 && [...boxes].some((b) => b.classList.contains("dragging"))) dragEnd(); });

/* A gallery tile being dragged says what it is, and travels as a small card
 * rather than a ghost of the whole tile. The thumbnail is drawn onto a canvas
 * from the tile's own (already loaded) picture, so the card is never blank. */
document.addEventListener("dragstart", (e) => {
  const tile = e.target.closest?.("[data-picdrag]");
  if (!tile || !e.dataTransfer) return;
  try {
    e.dataTransfer.setData(PIC_DRAG, tile.dataset.picdrag);
    e.dataTransfer.effectAllowed = "copy";
  } catch { /* some drags refuse custom types; the image URL still travels */ }
  const img = tile.querySelector("img");
  const g = document.createElement("div");
  g.className = "srghost";
  const cv = document.createElement("canvas");
  cv.className = "art";
  cv.width = cv.height = 80;
  try {
    if (img?.naturalWidth) {
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      cv.getContext("2d").drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, 80, 80);
    }
  } catch { /* a tainted picture: the card goes without its thumbnail */ }
  const meta = document.createElement("div");
  meta.className = "rmeta";
  const title = tile.querySelector("figcaption b")?.textContent || "Picture";
  const sub = tile.querySelector(".immodel")?.textContent || "From the gallery";
  meta.innerHTML = `<span class="rtitle">${esc(title.slice(0, 48))}</span><span class="rsub">${esc(sub)}</span>`;
  g.append(cv, meta);
  document.body.appendChild(g);
  try { e.dataTransfer.setDragImage(g, 20, 20); } catch { /* keep the default */ }
  setTimeout(() => g.remove());
  /* Like Music: bring the zone into view where it can be seen. */
  for (const b of boxes) {
    if (b.offsetParent) { b.scrollIntoView({ block: "nearest" }); break; }
  }
});

document.addEventListener("click", (e) => {
  for (const b of boxes) {
    if (!b.contains(e.target) && !b._pd.bar?.contains(e.target)) b._pd.menu.hidden = true;
  }
});

export function mountPicDrop(host, opts) {
  if (!host) return null;
  const o = { zone: "Drop a picture here", multiple: false, blocked: () => "", ...opts };
  const box = document.createElement("div");
  box.className = "picdrop";
  box.innerHTML = `
    <div class="pdslide"><div class="pdwrap">
      <div class="pdzone"><span class="pdicon" aria-hidden="true">⤓</span><span class="pdzonetext"></span></div>
    </div></div>
    <div class="pdfull" hidden>
      <div class="art pdart"></div>
      <div class="rmeta"><span class="rtitle pdtitle"></span><span class="rsub pdsub"></span></div>
      <button class="srbtn pdmore" type="button" aria-expanded="false" title="Choose another">▾</button>
      <button class="srbtn pdclear" type="button" title="Remove">✕</button>
    </div>
    <div class="pdrow">
      <button type="button" class="edtool pdchoose" aria-expanded="false">Library ▾</button>
      <button type="button" class="edtool pdupload">Upload…</button>
      <span class="pdwhy"></span>
    </div>
    <div class="pdmenu" hidden></div>
    <input type="file" accept="image/png,image/jpeg,image/webp" hidden ${o.multiple ? "multiple" : ""}>`;
  host.appendChild(box);
  boxes.add(box);
  const menu = box.querySelector(".pdmenu");
  if (o.bar) {
    o.bar.classList.add("pdbar");
    o.bar.append(box.querySelector(".pdrow"), menu);
  }
  if (o.strip) {
    const zone = box.querySelector(".pdzone");
    zone.prepend(o.strip);
    if (o.clear) { o.clear.classList.add("pdclearall"); zone.append(o.clear); }
  }
  box._pd = { menu, bar: o.bar || null };
  const $q = (sel) => box.querySelector(sel) || o.bar?.querySelector(sel);
  const $all = (sel) => [...box.querySelectorAll(sel), ...(o.bar ? o.bar.querySelectorAll(sel) : [])];
  const input = $q("input[type=file]");
  $q(".pdzonetext").textContent = o.zone;

  let busy = false;
  const run = async (fn) => {
    if (busy) return;
    if (o.blocked()) return;
    busy = true;
    box.classList.add("busy");
    try { await fn(); } catch (err) { window.alert?.(err.message || String(err)); }
    finally { busy = false; box.classList.remove("busy"); paint(); }
  };

  /* A library picture goes to onPick when the screen has one; anything else
   * (a picture from outside the app, or a screen that only takes files) is
   * fetched and handed over as a file. */
  const pick = (c, known = true) => run(async () => {
    if (known && o.onPick) await o.onPick(c);
    else await o.onFiles([await urlToFile(c.url, c.name)]);
  });
  const files = (list) => run(async () => {
    const imgs = [...list].filter((f) => /^image\//.test(f.type));
    if (!imgs.length) throw new Error("That is not a picture (PNG, JPEG or WebP).");
    await o.onFiles(o.multiple ? imgs : imgs.slice(0, 1));
  });

  function paint() {
    const why = o.blocked();
    box.classList.toggle("off", !!why);
    for (const b of $all(".pdchoose, .pdupload, .pdmore")) b.disabled = !!why || busy;
    box.classList.toggle("strip", !!o.strip && !o.strip.hidden && o.strip.children.length > 0);
    $q(".pdwhy").textContent = why || "";
    const cur = o.current?.() || null;
    box.classList.toggle("has", !!cur);
    $q(".pdfull").hidden = !cur;
    $q(".pdrow").hidden = !!cur;
    if (cur) {
      $q(".pdtitle").textContent = cur.label || "Picture";
      $q(".pdsub").textContent = cur.sub || "";
      $q(".pdart").style.background = cur.url
        ? `center / cover no-repeat url("${String(cur.url).replace(/"/g, "%22")}")`
        : "";
      $q(".pdclear").hidden = !o.onClear;
    }
  }

  async function openMenu(btn) {
    if (!menu.hidden) { closeMenu(); return; }
    for (const b of boxes) if (b !== box) b.querySelector(".pdmenu").hidden = true;
    menu.innerHTML = '<p class="pdempty">Loading…</p>';
    /* Open upward when the box sits low on the screen. */
    const r = (o.bar || box).getBoundingClientRect();
    menu.classList.toggle("up", r.bottom + 380 > window.innerHeight && r.top > 380);
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    try { await o.beforeMenu?.(); } catch { /* show what there is */ }
    const rows = o.candidates?.() || [];
    const groups = [...new Set(rows.map((x) => x.group || "Pictures"))];
    menu.innerHTML = `<button type="button" class="pdup">Upload from this computer…</button>` + (rows.length
      ? groups.map((g) => `<div class="pdgroup">${esc(g)}</div><div class="pdgrid">${rows.filter((x) => (x.group || "Pictures") === g).slice(0, 120)
        .map((x) => `<button type="button" class="pdtile" data-i="${rows.indexOf(x)}" title="${esc(x.label || x.name)}"><img src="${esc(x.url)}" alt="" loading="lazy"></button>`).join("")}</div>`).join("")
      : '<p class="pdempty">Nothing in the gallery yet. Make a picture on the Images screen, or upload one.</p>');
    menu.onclick = (e) => {
      e.stopPropagation();
      if (e.target.closest(".pdup")) { closeMenu(); input.click(); return; }
      const t = e.target.closest(".pdtile");
      if (!t) return;
      closeMenu();
      pick(rows[Number(t.dataset.i)]);
    };
  }
  function closeMenu() {
    menu.hidden = true;
    for (const b of $all(".pdchoose, .pdmore")) b.setAttribute("aria-expanded", "false");
  }

  $q(".pdchoose").onclick = (e) => { e.stopPropagation(); openMenu(e.currentTarget); };
  $q(".pdmore").onclick = (e) => { e.stopPropagation(); openMenu(e.currentTarget); };
  $q(".pdupload").onclick = () => input.click();
  $q(".pdclear").onclick = () => { o.onClear?.(); paint(); };
  input.onchange = () => { const l = [...(input.files || [])]; input.value = ""; if (l.length) files(l); };

  /* Take whatever was dropped: files from the desktop, a gallery tile, or any
   * image the browser can name by URL. A blocked box still takes the drop, so
   * the browser does not open the picture instead, and says why. */
  function take(dt) {
    dragEnd();
    const why = o.blocked();
    if (why) { window.alert?.(why); return; }
    if (dt.files?.length) return files(dt.files);
    let item = null;
    try { item = JSON.parse(dt.getData(PIC_DRAG) || "null"); } catch { /* not ours */ }
    const url = item?.url || (dt.getData("text/uri-list") || "").split(/\r?\n/).find((l) => l && !l.startsWith("#"));
    if (!url) return;
    const rows = o.candidates?.() || [];
    const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
    const known = rows.find((x) => (item?.name && x.name === item.name) || abs(x.url) === abs(url));
    if (known) pick(known);
    else pick({ name: item?.name || url.split("/").pop(), url }, false);
  }

  box.addEventListener("dragover", (e) => {
    if (!carriesPicture(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = o.blocked() ? "none" : "copy";
    box.classList.add("over");
  });
  box.addEventListener("dragleave", (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove("over"); });
  box.addEventListener("drop", (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.stopPropagation();
    take(e.dataTransfer);
  });

  paint();
  return { paint, take, el: box, blocked: () => o.blocked() };
}

/**
 * A whole panel as a drop target: a picture dropped anywhere on it that is not
 * on a box of its own goes to `target()` (a handle from mountPicDrop), the way
 * Music's Simple box takes a dropped song. While the pointer is over the panel
 * that box's zone lights up, so it is clear where the picture will land.
 */
export function dropAnywhere(panel, target) {
  if (!panel) return;
  panel.addEventListener("dragover", (e) => {
    if (!carriesPicture(e.dataTransfer) || e.target.closest?.(".picdrop")) return;
    const h = target();
    if (!h) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    h.el.classList.add("over");
  });
  panel.addEventListener("dragleave", (e) => {
    if (!panel.contains(e.relatedTarget)) target()?.el.classList.remove("over");
  });
  panel.addEventListener("drop", (e) => {
    if (!e.dataTransfer || e.target.closest?.(".picdrop")) return;
    const h = target();
    if (!h) return;
    e.preventDefault();
    h.take(e.dataTransfer);
  });
}
