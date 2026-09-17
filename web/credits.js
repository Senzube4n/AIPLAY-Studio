/**
 * THE PEOPLE, at the top of the Thanks page.
 *
 * The rest of that page thanks the work this app stands on — models with
 * licences, software with boundaries — and all of it is read live from the
 * catalogue, because a licence table that has drifted is worse than none.
 * This half is the other kind of thanks, and it cannot be read from anywhere:
 * nothing in the running program knows who wrote it. Git does, but a person
 * who downloaded a ZIP has no git, so the list is typed here — in ONE table,
 * so adding a name is editing a table and not hunting through markup.
 *
 * ORDER IS THE CLAIM. The first entry is marked `lead` and is the person who
 * wrote the program; everybody under it added to somebody else's work, and the
 * words should say so. Flattening that into equal cards would not be modest, it
 * would be wrong — and this page sits directly above a licence table whose
 * every number is checked, so an inflated credit above it costs the table its
 * credibility too.
 *
 * Fork etiquette, since this file is the one a fork edits first: ADD yourself
 * at the bottom, do not replace anybody and do not move the lead. Keep `did` to
 * ONE sentence — the list is built to stay short as it grows, and four lines
 * per person is the budget. `areas` are the screens the work shows up on.
 */

/** @type {{name:string,handle?:string,url?:string,role:string,did:string,
 *          areas?:string[],lead?:boolean}[]} */
export const PEOPLE = [
  {
    name: "Senzu",
    handle: "@Senzube4n",
    url: "https://github.com/Senzube4n",
    role: "Project founder",
    lead: true,
    did: "Wrote AIPLAY Studio, and nearly all of it: the music engines and their "
      + "graphs, images and video, the DAW, VFX, the 3D side, the provenance ledger, "
      + "the MCP door every tool comes through, the documents and the site. "
      + "Everything below is a contribution to his program.",
    areas: ["Music", "Images", "Video", "DAW", "VFX", "3D", "MCP", "Docs", "The site"],
  },
  {
    name: "Bucky",
    handle: "@bani4kaskashka",
    url: "https://github.com/bani4kaskashka",
    role: "Compatibility and interface",
    did: "Made it run on cards it was not written on — AMD, Intel Arc and plain CPU "
      + "— and wrote the launcher that installs its own ComfyUI on a PC that has none.",
    areas: ["AMD / Intel / CPU", "Launcher", "Music screen", "Agent & APIs", "Model picker"],
  },
  {
    name: "Everyone who broke it first",
    role: "Testing and reports",
    url: "https://github.com/Senzube4n/AIPLAY-Studio/issues",
    did: "Ran it on rigs nobody here owns, found the failure and wrote it down "
      + "instead of closing the window.",
    areas: ["Issues", "Rigs we do not have"],
  },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** The initial in the disc — one letter, so a long name cannot break the grid. */
const mark = (p) => esc([...p.name][0] || "?").toUpperCase();

/** Pure, so the test can read it without a browser and the page cannot drift from it. */
export function creditsHtml(people = PEOPLE) {
  return people.map((p) => {
    const nm = p.url
      ? `<a class="nm" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>`
      : `<b class="nm">${esc(p.name)}</b>`;
    return `<div class="person${p.lead ? " lead" : ""}">
      <span class="mark" aria-hidden="true">${mark(p)}</span>
      <span class="who">${nm}${p.handle ? `<span class="hnd">${esc(p.handle)}</span>` : ""}
        <span class="role">${esc(p.role)}</span></span>
      <p class="did">${esc(p.did)}</p>
      ${p.areas?.length
        ? `<div class="areas">${p.areas.map((a) => `<span>${esc(a)}</span>`).join("")}</div>` : ""}
    </div>`;
  }).join("");
}

/* Written once, when the Thanks page is first opened — the same moment its
 * model table is built. Static markup, so there is nothing to refresh. */
function fill() {
  const box = typeof document !== "undefined" && document.getElementById("thanksPeople");
  if (!box || box.dataset.loaded) return;
  box.dataset.loaded = "1";
  box.innerHTML = creditsHtml();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fill);
  else fill();
}
