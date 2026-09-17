/**
 * The H3 conditioning bridge, 2026-09-17.
 *
 * §1 the node's math under the engine's python, on random weights: alpha 0 is
 * a bypass, per-token matching keeps every token's RMS, "none" is the bare
 * MLP of the RMS-normalised input, and the blend is exactly
 * h + alpha·(p − h). §2 the graph: off by default, on via the panel or a
 * per-render override, between the words and every guide on both paths.
 * §3 the deploy copies changed files only. §4 the defaults, the knobs, the
 * doors, the tools, the rows, the doc. No card.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { config } from "./config.js";
import { videoGraphH3 } from "./workflow.js";
import { deployStudioNodes, STUDIO_NODES_DIR } from "./comfy_nodes.js";
import { KNOBS } from "./videolab/catalog.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const HARNESS = String.raw`
import sys, os, json, importlib.util, tempfile
comfy, nodefile = sys.argv[1], sys.argv[2]
sys.path.insert(0, comfy)
import torch
from safetensors.torch import save_file
import folder_paths
tmp = tempfile.mkdtemp()
folder_paths.models_dir = tmp
spec = importlib.util.spec_from_file_location("aiplay_h3_bridge", nodefile)
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
os.makedirs(os.path.join(tmp, "conditioning_bridges"), exist_ok=True)
torch.manual_seed(0)
D, H = 16, 8
w = {"fc1.weight": torch.randn(H, D), "fc1.bias": torch.randn(H), "fc2.weight": torch.randn(H, H), "fc2.bias": torch.randn(H),
     "fc3.weight": torch.randn(D, H), "fc3.bias": torch.randn(D)}
save_file(w, os.path.join(tmp, "conditioning_bridges", "t.safetensors"))
folder_paths.folder_names_and_paths[mod.FOLDER] = ([os.path.join(tmp, "conditioning_bridges")], {".safetensors"})
node = mod.AiplayH3ConditioningBridge()
h = torch.randn(1, 7, D) * 3.0
cond = [[h, {"k": 1}]]
res = {}
out0 = node.apply(cond, "t.safetensors", 0.0, "per_token")[0]
res["alpha0_bypass"] = out0 is cond
def ref_mlp(x):
    a = torch.nn.functional.silu(x @ w["fc1.weight"].T + w["fc1.bias"])
    a = torch.nn.functional.silu(a @ w["fc2.weight"].T + w["fc2.bias"])
    return a @ w["fc3.weight"].T + w["fc3.bias"]
xn = h / torch.sqrt(h.pow(2).mean(-1, keepdim=True) + 1e-6)
p_ref = ref_mlp(xn)
out_none = node.apply(cond, "t.safetensors", 1.0, "none")[0][0][0].float()
res["none_is_bare_mlp"] = float((out_none - p_ref).abs().max() / p_ref.abs().max()) < 5e-3
out_pt = node.apply(cond, "t.safetensors", 1.0, "per_token")[0][0][0].float()
rms_h = torch.sqrt(h.pow(2).mean(-1))
rms_o = torch.sqrt(out_pt.pow(2).mean(-1))
res["per_token_keeps_rms"] = float((rms_o - rms_h).abs().max() / rms_h.max()) < 2e-2
out_a = node.apply(cond, "t.safetensors", 0.25, "per_token")[0]
blend = h + 0.25 * (out_pt - h)
res["blend_exact"] = float((out_a[0][0].float() - blend).abs().max() / h.abs().max()) < 2e-2
res["meta_kept_and_stamped"] = out_a[0][1]["k"] == 1 and out_a[0][1]["aiplay_bridge"]["alpha"] == 0.25
res["dtype_device_kept"] = out_a[0][0].dtype == h.dtype and out_a[0][0].device == h.device
try:
    node.apply([[torch.randn(1, 3, 5), {}]], "t.safetensors", 0.1, "per_token"); res["wrong_width_refused"] = False
except RuntimeError as e:
    res["wrong_width_refused"] = "expected H3 conditioning" in str(e)
print(json.dumps(res))
`;

console.log("\n§1  the node's math, under the engine's python");
{
  const python = config?.python || "";
  const nodefile = path.join(STUDIO_NODES_DIR, "aiplay_h3_bridge.py");
  if (python && fs.existsSync(python) && fs.existsSync(path.join(config.comfyDir || "", "folder_paths.py"))) {
    const r = spawnSync(python, ["-c", HARNESS, config.comfyDir, nodefile], { encoding: "utf8", timeout: 180_000, cwd: config.comfyDir });
    let res = null;
    try { res = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch { /* below */ }
    ok("the harness ran", r.status === 0 && !!res, (r.stderr || r.stdout || "").trim().slice(-800));
    if (res) {
      ok("alpha 0 is a bypass: the very same conditioning object", res.alpha0_bypass === true);
      ok("magnitude 'none' is the bare MLP of the RMS-normalised words", res.none_is_bare_mlp === true);
      ok("per-token matching keeps every token's RMS", res.per_token_keeps_rms === true);
      ok("the blend is h + alpha·(p − h), exactly", res.blend_exact === true);
      ok("the metadata is kept and stamped", res.meta_kept_and_stamped === true);
      ok("dtype and device go back as they came", res.dtype_device_kept === true);
      ok("a tensor of the wrong width is refused by sentence", res.wrong_width_refused === true);
    }
  } else {
    console.log("  skip  the engine's python or ComfyUI is not on this machine; the node was not run");
  }
}

console.log("\n§2  the graph");
{
  const h3 = config.video.engines.h3;
  const saved = { bridge: h3.bridge, bridgeAlpha: h3.bridgeAlpha };
  const build = (o) => videoGraphH3({ prompt: "t", seed: 1, seconds: 2, width: 1344, height: 768, steps: 4, prefix: "p", ...o });
  try {
    h3.bridge = "off"; h3.bridgeAlpha = 0.1;
    const off = build({});
    ok("off by default: no bridge node, the guider reads the words", !off[77] && off[7].inputs.conditioning[0] === "5");
    h3.bridge = "BUNNY_H3_ActionLogic_Bridge_V1.safetensors"; h3.bridgeAlpha = 0.12;
    const on = build({});
    eq("the panel turns it on: node 77 rewrites node 5's conditioning", [on[77]?.class_type, on[77]?.inputs?.conditioning, on[77]?.inputs?.adapter, on[77]?.inputs?.alpha, on[77]?.inputs?.magnitude_match],
      ["AiplayH3ConditioningBridge", ["5", 0], "BUNNY_H3_ActionLogic_Bridge_V1.safetensors", 0.12, "per_token"]);
    eq("...and the guider reads the rewritten words", on[7].inputs.conditioning, ["77", 0]);
    const snd = build({ audioTrack: { name: "s.flac", start: 0 } });
    eq("with a soundtrack the anchor hangs off the bridge", snd[23].inputs.positive, ["77", 0]);
    const cont = build({ continueFrom: { file: "c.mp4", frames: 56, fps: 24, hasAudio: false, overlapFrames: 22, extensionFrames: 34 } });
    eq("with a continuation the tail guide hangs off the bridge", cont[74].inputs.positive, ["77", 0]);
    const refs = build({ refImages: ["r.png"], steps: 8 });
    eq("on the reference path too: 77 first, then the guider", [refs[77]?.inputs?.conditioning, refs[7].inputs.conditioning], [["5", 0], ["77", 0]]);
    const zero = build({ bridgeAlpha: 0 });
    ok("a per-render alpha 0 leaves the node out", !zero[77] && zero[7].inputs.conditioning[0] === "5");
    const other = build({ bridge: "MiniMaxH3_SemanticBridge_v1.safetensors", bridgeAlpha: 0.15 });
    eq("a per-render adapter and strength win over the panel", [other[77].inputs.adapter, other[77].inputs.alpha], ["MiniMaxH3_SemanticBridge_v1.safetensors", 0.15]);
    h3.bridge = "off";
    const forced = build({ bridge: "MiniMaxH3_SemanticBridge_v1.safetensors", bridgeAlpha: 0.1 });
    ok("...even when the panel says off", !!forced[77]);
    const clamped = build({ bridge: "x.safetensors", bridgeAlpha: 7 });
    eq("alpha is clamped to 1", clamped[77].inputs.alpha, 1);
  } finally { Object.assign(h3, saved); }
}

console.log("\n§3  the deploy");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiplay-nodes-"));
  try {
    const first = deployStudioNodes(dir);
    ok("the bridge node is copied into an empty custom_nodes", first.copied.includes("aiplay_h3_bridge.py"));
    const second = deployStudioNodes(dir);
    ok("a second boot copies nothing", second.copied.length === 0 && second.kept.includes("aiplay_h3_bridge.py"));
    fs.writeFileSync(path.join(dir, "aiplay_h3_bridge.py"), "# stale");
    const third = deployStudioNodes(dir);
    ok("a changed file is written again", third.copied.includes("aiplay_h3_bridge.py")
      && fs.readFileSync(path.join(dir, "aiplay_h3_bridge.py"), "utf8").includes("NODE_CLASS_MAPPINGS"));
    fs.writeFileSync(path.join(dir, "someone_elses.py"), "# theirs");
    deployStudioNodes(dir);
    ok("other people's nodes are never touched", fs.readFileSync(path.join(dir, "someone_elses.py"), "utf8") === "# theirs");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log("\n§4  the defaults, the knobs, the doors, the tools, the rows, the doc");
{
  const cfg = src("./config.js"), comfy = src("./comfy.js"), index = src("./index.js"), mcp = src("./mcp.js"),
    models = src("./models.js"), api = src("../API.md");
  ok("the defaults are off, alpha 0.10", /bridge: "off",\n\s+bridgeAlpha: 0\.10,/.test(cfg));
  const adapter = KNOBS.find((k) => k.id === "bridge_adapter"), alpha = KNOBS.find((k) => k.id === "bridge_alpha");
  eq("the adapter knob offers off and both adapters", adapter?.options, ["off", "BUNNY_H3_ActionLogic_Bridge_V1.safetensors", "MiniMaxH3_SemanticBridge_v1.safetensors"]);
  eq("...on the H3 engine's bridge field", adapter?.path, ["video", "engines", "h3", "bridge"]);
  eq("the strength knob is 0–1", [alpha?.kind, alpha?.min, alpha?.max, alpha?.path], ["number", 0, 1, ["video", "engines", "h3", "bridgeAlpha"]]);
  ok("...and both carry the authors' own figures and the reference-path warning", /6 in 10 renders better/.test(adapter?.effect || "") && /REFERENCE path worse/.test(adapter?.effect || ""));
  ok("the engine deploys the studio nodes before it starts", /deployStudioNodes\(path\.join\(config\.comfyDir, "custom_nodes"\)\)/.test(comfy));
  ok("create and extend take bridge and bridgeAlpha", (index.match(/bridge: typeof b\.bridge === "string" && b\.bridge \? path\.basename\(b\.bridge\) : undefined,/g) || []).length === 2);
  ok("make_clip and extend_clip declare bridge and bridge_alpha and forward them",
    (mcp.match(/bridge_alpha: \{ type: "number", minimum: 0, maximum: 1/g) || []).length === 2
    && (mcp.match(/bridgeAlpha: Number\.isFinite\(a\.bridge_alpha\) \? a\.bridge_alpha : undefined,/g) || []).length === 2);
  ok("the catalogue has both rows with their bytes and hashes",
    /id: "bridgeBunny"/.test(models) && /bytes: 22_045_536,/.test(models) && /983380be6bf790544dbfa9be1bbe42e60ea841c7b6f7c5aac668de9380ab277a/.test(models)
    && /id: "bridgeSemantic"/.test(models) && /bytes: 11_023_032,/.test(models) && /ac0dc8ac05f545ebdee12e2fcebe4515b049f9cfd9558eb4887a9bf3fd6d562e/.test(models));
  ok("...repeating H3's territory clause on both", (models.match(/a clip made with this adapter is an H3 output and carries the same limit/g) || []).length === 2);
  ok("the API doc names the fields", /### The conditioning bridge on `POST \/api\/video`/.test(api) && /bridgeAlpha/.test(api));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
