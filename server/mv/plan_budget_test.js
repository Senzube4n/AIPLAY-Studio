// The spend gate SHIPS OFF. brief.agentBudgetMinutes null / undefined / "" is
// "no gate" — the plan strand's prover found Number(null) === 0 turning that into
// a zero-minute budget that refused the first agent render after any spend.
// The meter reads e.t and skips events it cannot date, so the fixture is dated.
import { spendMeter, SPEND_FIELD } from "./plan.js";
let ok = 0, bad = 0;
const check = (c, m) => { if (c) ok++; else { bad++; console.log("  FAIL", m); } };
const t = new Date().toISOString();
const spent = [{ t, actor: "agent:plan", type: "generate", data: { [SPEND_FIELD]: 12.5 } }];
for (const v of [null, undefined, ""]) {
  const m = spendMeter({ brief: { agentBudgetMinutes: v } }, spent);
  check(m.unattendedMinutesSinceApproval === 12.5, `budget ${JSON.stringify(v)} still COUNTS the spend (meter visible)`);
  check(m.budgetMinutes === null, `budget ${JSON.stringify(v)} reads as no gate`);
  check(m.over === false, `budget ${JSON.stringify(v)} refuses nothing after 12.5 min of spend`);
}
const on = spendMeter({ brief: { agentBudgetMinutes: 10 } }, spent);
check(on.budgetMinutes === 10 && on.over === true, "a real budget of 10 is over after 12.5 min");
const zero = spendMeter({ brief: { agentBudgetMinutes: 0 } }, spent);
check(zero.budgetMinutes === 0 && zero.over === true, "an explicit 0 is a real (immediate) gate, not no-gate");
const undated = spendMeter({ brief: { agentBudgetMinutes: 10 } }, [{ actor: "agent:x", data: { [SPEND_FIELD]: 99 } }]);
check(undated.unattendedMinutesSinceApproval === 0 && undated.over === false, "an undated event is not counted (and says so by omission)");
console.log(`  ${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
