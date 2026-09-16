/** Source contracts only: actual clipping/layout is checked separately in a browser. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../web/styles.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const normalize = (s) => s.trim().replace(/\s+/g, " ").replace(/\s*>\s*/g, ">");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((m) =>
  m[1].split(",").map((selector) => ({ selector: normalize(selector), body: m[2] })));
function declaration(selector, property, expected) {
  const pattern = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`);
  const values = rules.filter((r) => r.selector === normalize(selector))
    .map((r) => pattern.exec(r.body)?.[1]?.trim()).filter((v) => v !== undefined);
  assert.ok(values.some((v) => expected.test(v)),
    `${selector} must declare ${property}: ${expected}; got ${JSON.stringify(values)}`);
}
function containerBody() {
  const match = /@container\s+music-create\s*\(\s*max-width\s*:\s*340px\s*\)\s*\{/.exec(css);
  assert.ok(match, "Narrow layout follows the named Music panel, not the viewport");
  const start = match.index + match[0].length;
  let depth = 1;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i);
  }
  assert.fail("Music container query must close");
}

test("Music parameter sizing is scoped to its shrinkable named container", () => {
  declaration(".create", "container-name", /^music-create$/);
  declaration(".create", "container-type", /^inline-size$/);
  declaration(".create .params", "grid-template-columns",
    /^minmax\(\s*0\s*,[^)]+\)\s+minmax\(\s*0\s*,[^)]+\)$/);
  declaration(".create .params > *", "min-width", /^0(?:px)?$/);
  // Other pages use this shared grid: the narrow Music fix must not redefine it globally.
  declaration(".params", "grid-template-columns", /^auto\s+1fr$/);
  declaration("#settings .params", "grid-template-columns", /^180px\s+minmax\(\s*0\s*,\s*340px\s*\)$/);
});

test("long Music selects stay constrained without relying on parent clipping", () => {
  const selector = ".create .params .pv > .sel2";
  declaration(selector, "width", /^100%$/);
  declaration(selector, "min-width", /^0(?:px)?$/);
  declaration(selector, "max-width", /^100%$/);
});

test("Music ranges can shrink alongside their visible numeric values", () => {
  const selector = ".create .params input[type=range]";
  declaration(selector, "flex", /^1\s+1\s+0(?:px|%)?$/);
  declaration(selector, "width", /^0(?:px)?$/);
  declaration(selector, "min-width", /^0(?:px)?$/);
  declaration(".create .params .pv b", "flex", /^(?:none|0\s+0\s+auto)$/);
});

test("Music numeric inputs and the seed row have bounded scoped rules", () => {
  declaration(".create .params .sv", "min-width", /^0(?:px)?$/);
  declaration(".create .params .sv", "max-width", /^100%$/);
  declaration(".create .seedrow", "flex-wrap", /^wrap$/);
});

test("a narrow Music panel stacks the paired grid while hidden controls stay hidden", () => {
  assert.match(containerBody(), /\.create\s+\.params\s*\{[^}]*grid-template-columns\s*:\s*(?:minmax\(\s*0\s*,\s*1fr\s*\)|1fr)\s*;/);
  declaration("[hidden]", "display", /^none\s*!important$/);
});

test("engine and planner controls retain unique IDs and associated labels", () => {
  const labels = {
    maxDur: "Length ceiling", qSteps: "Quality", qArCfg: "Composition guidance",
    qCfg: "Render guidance 4×", qTier: "Graphics memory", qModel: "Precision",
    yCot: "Thinking", yCfg: "Guidance", yPrecision: "Precision",
    yGgufPrecision: "Native precision", ySteps: "Steps",
    yPlanBpm: "Quarter-note BPM", yPlanMeter: "Outline meter", yPlanLength: "Target notation length",
  };
  for (const [id, label] of Object.entries(labels)) {
    assert.equal([...html.matchAll(new RegExp(`\\bid="${id}"`, "g"))].length, 1, `${id} remains unique`);
    const match = new RegExp(`<label\\b[^>]*\\bfor="${id}"[^>]*>([\\s\\S]*?)<\\/label>`).exec(html);
    assert.ok(match, `${id} retains its label`);
    assert.equal(match[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(), label);
  }
  for (const id of ["seed", "seedLock", "seedRand", "seedNote", "maxDurV", "qStepsV", "qArCfgV", "qCfgV", "yPlanLengthValue"]) {
    assert.equal([...html.matchAll(new RegExp(`\\bid="${id}"`, "g"))].length, 1, `${id} remains unique`);
  }
});
