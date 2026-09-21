import { mountMusicAuditions } from "./music-auditions.js";
import { mountMusicKits } from "./music-kits.js";
import { mountMusicReferences } from "./music-references.js";
import { mountMusicArtifacts } from "./music-artifacts.js";
import { mountMusicListeningLab } from "./music-listening-lab.js";

/** Lazy mounts keep ordinary Music startup independent of saved workflow data. */
export function mountMusicWorkflows({ onLoadRequest } = {}) {
  const dialog = document.getElementById("musicWorkflows");
  const opener = document.getElementById("musicWorkflowsOpen");
  if (!dialog || !opener) return;
  const mounted = new Set();
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  const loadRequest = async (request) => {
    await onLoadRequest(request);
    dialog.close();
  };
  async function select(tab) {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute("aria-controls")).hidden = !selected;
    }
    const panel = document.getElementById(tab.getAttribute("aria-controls"));
    if (mounted.has(panel.id)) return;
    mounted.add(panel.id);
    try {
      if (panel.id === "musicAuditions") await mountMusicAuditions(panel);
      if (panel.id === "musicKits") await mountMusicKits({ root: panel, fetch: window.fetch.bind(window), onLoadRequest: loadRequest });
      if (panel.id === "musicReferences") await mountMusicReferences({ root: panel, fetch: window.fetch.bind(window), onLoadRequest: loadRequest });
      if (panel.id === "musicArtifacts") await mountMusicArtifacts({ root: panel, fetch: window.fetch.bind(window) });
      if (panel.id === "musicListeningLab") await mountMusicListeningLab({ root: panel, fetch: window.fetch.bind(window) });
    } catch (error) {
      mounted.delete(panel.id);
      panel.textContent = `This workflow could not open: ${error.message}. Select its tab to retry.`;
    }
  }
  for (const tab of tabs) {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
        : (tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[index].focus(); select(tabs[index]);
    });
  }
  opener.addEventListener("click", () => {
    dialog.showModal();
    select(tabs.find(tab => tab.getAttribute("aria-selected") === "true") || tabs[0]);
  });
  dialog.querySelector('[data-action="close"]').addEventListener("click", () => dialog.close());
}
