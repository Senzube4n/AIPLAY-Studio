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

/** Copy every studio node whose bytes differ. Returns { copied, kept, dir }. */
export function deployStudioNodes(customNodesDir, sourceDir = STUDIO_NODES_DIR) {
  const copied = [], kept = [];
  if (!existsSync(sourceDir)) return { copied, kept, dir: customNodesDir };
  mkdirSync(customNodesDir, { recursive: true });
  for (const name of readdirSync(sourceDir)) {
    if (!/^aiplay_[a-z0-9_]+\.py$/.test(name)) continue;
    const src = readFileSync(path.join(sourceDir, name));
    const dst = path.join(customNodesDir, name);
    if (existsSync(dst) && readFileSync(dst).equals(src)) { kept.push(name); continue; }
    writeFileSync(dst, src);
    copied.push(name);
  }
  return { copied, kept, dir: customNodesDir };
}
