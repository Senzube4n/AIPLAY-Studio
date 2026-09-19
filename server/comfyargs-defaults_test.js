/** Studio's ComfyUI launch defaults: PyTorch attention and CUDA graphs off,
 *  laid once over settings saved before them, never over settings saved after,
 *  and only when this ComfyUI defines the flag. */
import test from "node:test";
import assert from "node:assert/strict";
import { buildLaunchArgs, effectiveValues, hasAmdMusicFix, OPTIONS_REV, autoVramFlags } from "./comfyargs.js";

const CLI = `attn_group.add_argument("--use-pytorch-cross-attention", action="store_true")
attn_group.add_argument("--use-ck-attention", action="store_true")
parser.add_argument("--disable-cuda-graphs", action="store_true")`;
const INSTALL = ["--use-ck-attention", "--extra-model-paths-config", "C:\\x.yaml"];
const launch = (saved, rev, cli = CLI) =>
  buildLaunchArgs({ tierFlags: ["--lowvram"], installFlags: INSTALL, values: effectiveValues(saved, rev, cli) });

test("nothing saved: PyTorch attention and CUDA graphs off, the install's CK attention removed", () => {
  const args = launch(undefined, undefined);
  assert.ok(hasAmdMusicFix(args), args.join(" "));
  assert.ok(!args.includes("--use-ck-attention"), "two attention flags stop ComfyUI starting");
  assert.equal(args.filter((a) => a === "--use-pytorch-cross-attention").length, 1);
});

test("a CK choice saved before the defaults existed is replaced once", () => {
  assert.ok(hasAmdMusicFix(launch({ attention: "--use-ck-attention" }, 1)));
});

test("settings saved from the new launcher are taken as they are", () => {
  const ck = launch({ attention: "--use-ck-attention" }, OPTIONS_REV);
  assert.ok(ck.includes("--use-ck-attention") && !ck.includes("--use-pytorch-cross-attention"));
  const noGraphsOff = launch({ attention: "--use-pytorch-cross-attention" }, OPTIONS_REV);
  assert.ok(!noGraphsOff.includes("--disable-cuda-graphs"), "an unticked box stays unticked");
});

test("a ComfyUI without a flag never gets it", () => {
  const old = launch(undefined, undefined, `attn_group.add_argument("--use-pytorch-cross-attention", action="store_true")`);
  assert.ok(!old.includes("--disable-cuda-graphs"), "an unknown flag stops ComfyUI starting");
  assert.ok(old.includes("--use-pytorch-cross-attention"));
  assert.deepEqual(effectiveValues({}, 1, null), {}, "no cli_args.py read: no defaults");
});

test("the tier owns the VRAM mode: an install's own is dropped, so ComfyUI gets one", () => {
  const args = buildLaunchArgs({ tierFlags: ["--lowvram", "--async-offload", "4"],
    installFlags: ["--use-ck-attention", "--highvram", "--extra-model-paths-config", "C:/x.yaml"], values: {} });
  assert.ok(args.includes("--lowvram") && !args.includes("--highvram"), args.join(" "));
  assert.ok(args.includes("--extra-model-paths-config"), "the install's other flags stay");
  const normal = buildLaunchArgs({ tierFlags: autoVramFlags(16304), installFlags: ["--highvram"], values: {} });
  assert.ok(!normal.some((f) => /vram|gpu-only/.test(f)), `a 16 GB card runs normal: ${normal.join(" ")}`);
  const chosen = buildLaunchArgs({ tierFlags: ["--lowvram"], installFlags: ["--highvram"], values: { vramMode: "--novram" } });
  assert.deepEqual(chosen.filter((f) => /vram|gpu-only/.test(f)), ["--novram"], "a launcher choice replaces both");
});

test("Auto picks the VRAM mode from the card: <12 GB low, 12-16 normal, >16 high", () => {
  assert.ok(autoVramFlags(8192).includes("--lowvram"));
  assert.ok(!autoVramFlags(12282).some((f) => /vram/.test(f)), "a 12 GB card reads just under 12");
  assert.ok(!autoVramFlags(16304).some((f) => /vram/.test(f)), "a 16 GB card reads just under 16");
  assert.ok(autoVramFlags(24576).includes("--highvram"));
  assert.ok(autoVramFlags(null).includes("--lowvram"), "unknown memory stays cautious");
});
