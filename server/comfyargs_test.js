/**
 * THE ADVANCED SETTINGS, AS FLAGS — the gate on what ComfyUI is launched with.
 *
 * Two failures this pins, both of which stop ComfyUI starting rather than
 * degrading it: two flags from one mutually exclusive argparse group (the
 * install's `--use-ck-attention` beside a chosen `--use-pytorch-cross-attention`
 * is a startup error), and a flag an older or newer ComfyUI does not define.
 * And one that is quieter and worse: a choice that removes a flag but leaves
 * its VALUE behind, which argparse then reads as a stray positional.
 *
 * No ComfyUI, no GPU: cli_args.py is a fixture string.
 *
 * Runs standalone (`node server/comfyargs_test.js`) and in the pre-commit hook.
 */
import {
  COMFY_OPTIONS, STUDIO_OWNED, familyOf, availableOptions, cleanValues, stripFlags, buildLaunchArgs,
} from "./comfyargs.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const TIER = ["--lowvram", "--async-offload", "4"];
const INSTALL = ["--use-ck-attention", "--extra-model-paths-config", "C:\\Users\\x\\inst.yaml"];

console.log("\n── nothing chosen changes nothing ───────────────────────────────");
ok("no values: tier then install flags, untouched",
  eq(buildLaunchArgs({ tierFlags: TIER, installFlags: INSTALL }), [...TIER, ...INSTALL]));
ok("unknown ids and invalid values are ignored",
  eq(buildLaunchArgs({ tierFlags: TIER, installFlags: INSTALL,
    values: { nope: true, attention: "--use-evil", noMmap: "yes", reserveVram: 999 } }), [...TIER, ...INSTALL]));
ok("cleanValues keeps only valid ones", eq(cleanValues({ noMmap: true, attention: "--bogus", reserveVram: "1.5" }), { noMmap: true, reserveVram: 1.5 }));

console.log("\n── a choice replaces its whole family ──────────────────────────");
{
  const args = buildLaunchArgs({ tierFlags: TIER, installFlags: INSTALL, values: { attention: "--use-pytorch-cross-attention" } });
  ok("PyTorch attention removes the install's CK attention", !args.includes("--use-ck-attention"), args.join(" "));
  ok("...and is added once", args.filter((a) => a === "--use-pytorch-cross-attention").length === 1);
  ok("...while the install's model-paths YAML survives, with its path",
    args.includes("--extra-model-paths-config") && args[args.indexOf("--extra-model-paths-config") + 1] === INSTALL[2]);
}
{
  const args = buildLaunchArgs({ tierFlags: TIER, values: { asyncOffload: 2 } });
  ok("async offload streams replace the tier's '--async-offload 4' — VALUE AND ALL", eq(args, ["--lowvram", "--async-offload", "2"]), args.join(" "));
}
{
  const args = buildLaunchArgs({ tierFlags: TIER, values: { noAsyncOffload: true } });
  ok("disabling async offload removes the tier's streams", eq(args, ["--lowvram", "--disable-async-offload"]), args.join(" "));
}
{
  const args = buildLaunchArgs({ tierFlags: TIER, values: { vramMode: "--highvram" } });
  ok("a VRAM mode overrides the tier's --lowvram", !args.includes("--lowvram") && args.includes("--highvram"), args.join(" "));
}
ok("a boolean adds its flag", buildLaunchArgs({ values: { noMmap: true } }).includes("--disable-mmap"));
ok("a number adds flag and value", eq(buildLaunchArgs({ values: { reserveVram: 1.5 } }), ["--reserve-vram", "1.5"]));
ok("turning install flags off drops them", eq(buildLaunchArgs({ tierFlags: TIER, installFlags: INSTALL, useInstallFlags: false }), TIER));

console.log("\n── stripping never eats the next flag ──────────────────────────");
ok("values are dropped only up to the next flag",
  eq(stripFlags(["--async-offload", "4", "--lowvram"], new Set(["--async-offload"])), ["--lowvram"]));
ok("a flag with no value is removed cleanly", eq(stripFlags(["--async-offload", "--x"], new Set(["--async-offload"])), ["--x"]));

console.log("\n── the install decides what is offered ─────────────────────────");
{
  const cli = `attn_group.add_argument("--use-pytorch-cross-attention", action="store_true")
attn_group.add_argument("--use-ck-attention", action="store_true")
parser.add_argument("--disable-mmap", action="store_true")`;
  const avail = availableOptions(cli);
  const attention = avail.find((o) => o.id === "attention");
  ok("a choice keeps only the flags this ComfyUI defines", attention && attention.choices.length === 2, JSON.stringify(attention?.choices));
  ok("a boolean this ComfyUI defines is offered", avail.some((o) => o.id === "noMmap"));
  ok("a flag this ComfyUI lacks is not offered", !avail.some((o) => o.id === "fastDisk" || o.id === "vramMode"));
  ok("no cli_args text offers nothing", availableOptions(null).length === 0);
}

console.log("\n── the catalogue itself ────────────────────────────────────────");
const allFlags = COMFY_OPTIONS.flatMap(familyOf);
ok("no option can set a flag Studio owns", !allFlags.some((f) => STUDIO_OWNED.has(f)), allFlags.filter((f) => STUDIO_OWNED.has(f)).join(", "));
ok("option ids are unique", new Set(COMFY_OPTIONS.map((o) => o.id)).size === COMFY_OPTIONS.length);
ok("every option names a section and a label", COMFY_OPTIONS.every((o) => o.section && o.label));
ok("every number option has a range", COMFY_OPTIONS.filter((o) => o.kind === "number").every((o) => Number.isFinite(o.min) && Number.isFinite(o.max)));

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
