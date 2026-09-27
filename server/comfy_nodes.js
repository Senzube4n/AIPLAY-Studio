/**
 * The Studio's own ComfyUI nodes, deployed into the engine at boot, 2026-09-17.
 *
 * server/comfy_nodes/*.py are single-file custom nodes (ComfyUI loads any .py
 * in custom_nodes/ that exports NODE_CLASS_MAPPINGS). They are copied into the
 * rig's custom_nodes folder before the engine starts, and only when the bytes
 * differ — so an edit here reaches the engine on the next boot and an unchanged
 * file is never rewritten. Nothing else in custom_nodes is touched.
 *
 * Why copy rather than point ComfyUI at this folder: the engine has no flag for
 * a second custom_nodes directory, and a symlink needs privileges on Windows.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STUDIO_NODES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "comfy_nodes");

/**
 * Third-party nodes Studio ships, pinned, with their licence (server/comfy_nodes/<dir>/):
 *   comfyui-minimax-h3-blockcache-T8  T8mars, Apache-2.0, commit 36336dc (v1.0.4,
 *     2026-09-08): MiniMaxH3BlockCacheT8, H3's opt-in block cache (h3tier.js
 *     H3_BLOCK_CACHE, video_settings block_cache). Pure Python, no packages.
 */
export const VENDORED_NODES = Object.freeze(["comfyui-minimax-h3-blockcache-T8"]);

/** Copy Studio-owned nodes; never alter an existing third-party node folder. */
export function deployStudioNodes(customNodesDir, sourceDir = STUDIO_NODES_DIR) {
  const copied = [], kept = [], warnings = [];
  if (!existsSync(sourceDir)) return { copied, kept, warnings, dir: customNodesDir };
  mkdirSync(customNodesDir, { recursive: true });
  for (const name of readdirSync(sourceDir)) {
    if (!/^aiplay_[a-z0-9_]+\.py$/.test(name)) continue;
    const src = readFileSync(path.join(sourceDir, name));
    const dst = path.join(customNodesDir, name);
    if (existsSync(dst) && readFileSync(dst).equals(src)) { kept.push(name); continue; }
    writeFileSync(dst, src);
    copied.push(name);
  }
  /* Bundled third-party nodes use the upstream folder name to avoid a second
   * registration. An existing folder may belong to ComfyUI Manager or the user:
   * leave it entirely untouched if a bundled file differs or is absent. */
  for (const dir of VENDORED_NODES) {
    const from = path.join(sourceDir, dir);
    if (!existsSync(from)) continue;
    const to = path.join(customNodesDir, dir);
    const names = readdirSync(from).filter(name => /\.py$|^LICENSE$/.test(name));
    if (existsSync(to)) {
      const identical = names.every(name => {
        const dst = path.join(to, name);
        return existsSync(dst) && readFileSync(dst).equals(readFileSync(path.join(from, name)));
      });
      if (identical) kept.push(...names.map(name => dir + "/" + name));
      else warnings.push("Preserved existing custom_nodes/" + dir + "; its files differ from Studio's bundled copy. To use the bundled H3 node, move that folder aside and restart Studio.");
      continue;
    }
    mkdirSync(to, { recursive: true });
    for (const name of names) {
      const src = readFileSync(path.join(from, name));
      const dst = path.join(to, name);
      const rel = dir + "/" + name;
      writeFileSync(dst, src);
      copied.push(rel);
    }
  }
  return { copied, kept, warnings, dir: customNodesDir };
}
