/** Studio's ComfyUI launch fix — PyTorch attention and CUDA graphs off — is a
 *  switch: auto (the card decides: on for AMD and Intel, off for NVIDIA), on,
 *  off. Laid over the saved values where it applies, never where it does not,
 *  and only when this ComfyUI defines the flag. */
import test from "node:test";
import assert from "node:assert/strict";
import { buildLaunchArgs, effectiveValues, hasAmdMusicFix, fixApplies, vendorOf, OPTIONS_REV, autoVramFlags } from "./comfyargs.js";

const CLI = `attn_group.add_argument("--use-pytorch-cross-attention", action="store_true")
attn_group.add_argument("--use-ck-attention", action="store_true")
parser.add_argument("--disable-cuda-graphs", action="store_true")`;
const INSTALL = ["--use-ck-attention", "--extra-model-paths-config", "C:\\x.yaml"];
const launch = (saved, rev, ctx = {}, cli = CLI) =>
  buildLaunchArgs({ tierFlags: ["--lowvram"], installFlags: INSTALL, values: effectiveValues(saved, rev, cli, ctx) });

test("auto: the card decides — AMD and Intel get the fix, NVIDIA and an unread card do not", () => {
  assert.ok(hasAmdMusicFix(launch(undefined, undefined, { vendor: "amd" })));
  assert.ok(hasAmdMusicFix(launch(undefined, undefined, { vendor: "intel" })));
  const nv = launch(undefined, undefined, { vendor: "nvidia" });
  assert.ok(!hasAmdMusicFix(nv), nv.join(" "));
  assert.ok(nv.includes("--use-ck-attention"), "the install's own attention flag stays when the fix does not apply");
  assert.ok(!hasAmdMusicFix(launch(undefined, undefined, { vendor: null })));
  assert.deepEqual([fixApplies("auto", "amd"), fixApplies("auto", "nvidia"), fixApplies("on", "nvidia"), fixApplies("off", "amd"), fixApplies("garbage", "amd")], [true, false, true, false, true]);
  assert.deepEqual([vendorOf({ vendor: "nvidia" }, "rocm"), vendorOf(null, "rocm"), vendorOf(null, "cuda"), vendorOf(undefined, undefined)], ["nvidia", "amd", null, null], "a ROCm backend with no card reading is AMD");
});

test("on the fix replaces the install's CK attention, once, on any card; off removes it even on AMD", () => {
  const args = launch(undefined, undefined, { fix: "on", vendor: "nvidia" });
  assert.ok(hasAmdMusicFix(args), args.join(" "));
  assert.ok(!args.includes("--use-ck-attention"), "two attention flags stop ComfyUI starting");
  assert.equal(args.filter((a) => a === "--use-pytorch-cross-attention").length, 1);
  assert.ok(!hasAmdMusicFix(launch(undefined, undefined, { fix: "off", vendor: "amd" })));
});

test("a CK choice saved before the defaults existed is replaced where the fix applies, kept where it does not", () => {
  assert.ok(hasAmdMusicFix(launch({ attention: "--use-ck-attention" }, 1, { vendor: "amd" })));
  assert.ok(launch({ attention: "--use-ck-attention" }, 1, { vendor: "nvidia" }).includes("--use-ck-attention"));
});

test("settings stamped by the rev-2 launcher with exactly the two defaults are read as defaults, not as a choice", () => {
  const nv = launch({ attention: "--use-pytorch-cross-attention", noCudaGraphs: true }, 2, { vendor: "nvidia" });
  assert.ok(!nv.includes("--disable-cuda-graphs") && !nv.includes("--use-pytorch-cross-attention"), nv.join(" "));
  const ck = launch({ attention: "--use-ck-attention" }, 2, { vendor: "nvidia" });
  assert.ok(ck.includes("--use-ck-attention"), "a real choice at rev 2 stays");
  const onlyGraphs = launch({ noCudaGraphs: true }, 2, { vendor: "nvidia" });
  assert.ok(onlyGraphs.includes("--disable-cuda-graphs"), "one box ticked alone is a choice");
});

test("settings saved from the new launcher are taken as they are, under the switch", () => {
  const ck = launch({ attention: "--use-ck-attention" }, OPTIONS_REV, { vendor: "nvidia" });
  assert.ok(ck.includes("--use-ck-attention") && !ck.includes("--use-pytorch-cross-attention"));
  const pt = launch({ attention: "--use-pytorch-cross-attention" }, OPTIONS_REV, { vendor: "nvidia" });
  assert.ok(pt.includes("--use-pytorch-cross-attention") && !pt.includes("--disable-cuda-graphs"), "an unticked box stays unticked");
  assert.ok(hasAmdMusicFix(launch({ attention: "--use-ck-attention" }, OPTIONS_REV, { fix: "on", vendor: "nvidia" })), "On wins over a saved choice");
});

test("a ComfyUI without a flag never gets it", () => {
  const old = launch(undefined, undefined, { vendor: "amd" }, `attn_group.add_argument("--use-pytorch-cross-attention", action="store_true")`);
  assert.ok(!old.includes("--disable-cuda-graphs"), "an unknown flag stops ComfyUI starting");
  assert.ok(old.includes("--use-pytorch-cross-attention"));
  assert.deepEqual(effectiveValues({}, 1, null, { vendor: "amd" }), {}, "no cli_args.py read: no defaults");
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

test("Auto picks the VRAM mode from the card: <12 GB low, 12 GB and up normal", () => {
  assert.ok(autoVramFlags(8192).includes("--lowvram"));
  assert.ok(!autoVramFlags(12282).some((f) => /vram/.test(f)), "a 12 GB card reads just under 12");
  assert.ok(!autoVramFlags(16304).some((f) => /vram/.test(f)), "a 16 GB card reads just under 16");
  /* No size gets --highvram: nothing could ever leave the card, and a 24 GB
   * card filled and spilled into system memory (see autoVramFlags). */
  for (const mb of [24576, 49152, 81920]) assert.ok(!autoVramFlags(mb).includes("--highvram"), `${mb} MB`);
  assert.ok(autoVramFlags(null).includes("--lowvram"), "unknown memory stays cautious");
});
