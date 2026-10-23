import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
function form() {
  const values = { imgEngine: "moss-image", imgMossPreset: "standard", imgSize: "custom", imgW: "720", imgH: "1280", imgCount: "3" };
  const elements = new Map(Object.entries(values).map(([id, value]) => [id, { value, disabled: false, hidden: false }]));
  const $ = id => { if (!elements.has(id)) elements.set(id, { value: "", disabled: false, hidden: false }); return elements.get(id); };
  const context = vm.createContext({ $, URLSearchParams, imgSampling() {}, imgQwenShape() {},
    imgEffectiveEngine: () => $("imgEngine").value === "checkpoint" ? "moss-image" : $("imgEngine").value });
  const start = app.indexOf("const IMG_MOSS_PRESETS = {");
  const end = app.indexOf("let imgQwenStatus =", start);
  assert.ok(start >= 0 && end > start, "actual MOSS form controller exists");
  vm.runInContext(app.slice(start, end) + "\nimgMossCheck = () => {}; globalThis.shape = imgMossShape;", context);
  return { $, shape: context.shape };
}

test("hires applies its tested size once and restores the previous form on recipe change", () => {
  const { $, shape } = form();
  $("imgMossPreset").value = "moss-hires-v03";
  shape(true);
  for (const id of ["imgSize", "imgW", "imgH", "imgCount"]) assert.equal($(id).disabled, true, id);
  assert.equal($("imgW").value, "2048"); assert.equal($("imgH").value, "2048");
  assert.equal($("imgCount").value, "1"); assert.equal($("imgCustomW").hidden, false);
  assert.equal($("imgSteps").value, 25); assert.equal($("imgCfg").value, 4);
  shape(); // Repaints must not replace the saved size with the forced hires size.
  $("imgMossPreset").value = "kromoss-dmd2-8";
  shape(true);
  assert.equal($("imgSize").value, "custom"); assert.equal($("imgW").value, "720");
  assert.equal($("imgH").value, "1280"); assert.equal($("imgCount").value, "3");
  for (const id of ["imgSize", "imgW", "imgH", "imgCount"]) assert.equal($(id).disabled, false, id);
  assert.equal($("imgSteps").value, 8); assert.equal($("imgCfg").value, 1);
});

test("leaving MOSS restores the person's named size and does not unlock another engine on later paints", () => {
  const { $, shape } = form();
  $("imgSize").value = "1280x720";
  $("imgMossPreset").value = "moss-hires-v03"; shape(true);
  $("imgEngine").value = "qwen-image-2.1"; shape();
  assert.equal($("imgSize").value, "1280x720"); assert.equal($("imgCustomW").hidden, true);
  $("imgSize").disabled = true; // Qwen may lock size to a reference after the MOSS controller runs.
  shape(); assert.equal($("imgSize").disabled, true);
});

test("choosing a named recipe leaves a custom file that could shadow its checkpoint", () => {
  const { $ } = form();
  $("imgEngine").value = "checkpoint";
  let engineChanges = 0; $("imgEngine").onchange = () => { engineChanges++; };
  $("imgMossPreset").value = "kromoss-standard";
  $("imgMossPreset").onchange();
  assert.equal($("imgEngine").value, "moss-image"); assert.equal(engineChanges, 1);
  assert.equal($("imgSteps").value, 25); assert.equal($("imgCfg").value, 2.5);
});
