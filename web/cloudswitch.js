/**
 * "NO STRONG GRAPHICS CARD?" — the Settings card, and the one question every
 * paid run asks.
 *
 * Friend first, then your own key (the owner, 2026-09-24). The order, the
 * sentences, the keys' status and what a paid run would cost all come from the
 * server (server/cloud-switch.js, GET /api/cloud and each door's
 * "confirm-spend" refusal); this file shows them and asks. It decides nothing:
 * no threshold, no price, no order of its own.
 *
 * The Hosted engine's controls inside the card (#apiEnabled, #apiKey, the cap)
 * are still painted by web/app.js loadApiMode, as they always were.
 */
import { appConfirm } from "./dialog.js";

const $ = (id) => document.getElementById(id);

/**
 * The paid-run question. `reply` is a door's refusal with reason
 * "confirm-spend": its `error` is the server's own sentence (what it runs on,
 * about how much, which key it bills, how much of the month's cap is spent).
 * `takes` is how many runs this one press queues, said so they are not a
 * surprise. Returns true only on the person's explicit yes.
 */
export async function confirmPaidRun(reply, { takes = 1 } = {}) {
  if (reply?.reason !== "confirm-spend") return false;
  const more = takes > 1
    ? `\n\nThis press queues ${takes} takes, and each one is billed.` : "";
  return !!(await appConfirm(`${reply.error}${more}`, {
    title: "Pay for this?", ok: takes > 1 ? `Pay for ${takes}` : "Pay and make it", cancel: "Not now",
  }));
}

async function call(body) {
  const r = await fetch("/api/cloud", body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) throw new Error(j?.error || `${r.status}`);
  return j;
}

/* A server sentence into an element, hidden when there is none. */
function say(id, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
}

function paint(d) {
  const [friend, paid] = d.ways || [];
  /* Step 1: one sentence and the button; how to set it up and what it cannot
   * do yet stay behind "More". The note is this launch mode's (Collab runs in
   * Full Studio only). */
  if (friend && $("cloudFriendHow")) $("cloudFriendHow").textContent = friend.how;
  if (friend && $("cloudFriendLimits")) $("cloudFriendLimits").textContent = friend.limits || "";
  say("cloudFriendNote", d.friend?.note);
  if ($("cloudFriendGo")) $("cloudFriendGo").disabled = d.friend?.available === false;
  if (paid && $("cloudPaidHow")) $("cloudPaidHow").textContent = paid.how;
  /* The hosted engine makes songs in Full Studio only. Where it cannot run,
   * the card says so and its switch cannot be turned ON (only off, so a switch
   * left on elsewhere can still be cleared here). */
  say("cloudHostedNote", d.hosted?.note);
  if ($("apiEnabled")) $("apiEnabled").disabled = d.hosted?.runsHere === false && !d.hosted?.on;
  if (d.comfy?.note && $("cloudComfyNote")) $("cloudComfyNote").textContent = d.comfy.note;
  const k = d.comfy?.key || {};
  if ($("cloudComfyState")) {
    $("cloudComfyState").textContent = [d.comfy?.keySaid, k.set ? k.protection : ""].filter(Boolean).join(" ");
  }
  if ($("cloudComfyForget")) $("cloudComfyForget").hidden = !k.set;
}

let wired = false;
/** Paint the card from GET /api/cloud. `setView` opens Collab. */
export async function paintCloudCard({ setView } = {}) {
  if (!wired && $("cloudFriendGo")) {
    wired = true;
    $("cloudFriendGo").addEventListener("click", () => { if (typeof setView === "function") setView("collab"); });
    const save = async () => {
      const key = $("cloudComfyKey").value.trim();
      if (!key) { $("cloudComfyKey").focus(); return; }
      $("cloudComfySave").disabled = true;
      $("cloudComfyState").textContent = "Checking the key with Comfy…";
      try {
        const d = await call({ action: "comfyKey", key });
        $("cloudComfyKey").value = "";   // never left sitting in the page
        paint(d);
      } catch (e) {
        $("cloudComfyState").textContent = e.message;
      } finally {
        $("cloudComfySave").disabled = false;
      }
    };
    $("cloudComfySave").addEventListener("click", save);
    $("cloudComfyKey").addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
    $("cloudComfyForget").addEventListener("click", async () => {
      if (!(await appConfirm("Forget the saved Comfy API key on this computer? Every copy of Studio on this Windows account uses the same saved key.",
        { ok: "Forget", tone: "danger" }))) return;
      try { paint(await call({ action: "forgetComfyKey" })); }
      catch (e) { $("cloudComfyState").textContent = e.message; }
    });
  }
  try { paint(await call()); } catch { /* the card keeps its written text */ }
}
