"""THE BACKSTOP: SEXUAL CONTENT INVOLVING MINORS IS NOT RUN BY THIS ENGINE.

AIPLAY Studio refuses such a request before it reaches ComfyUI (the engine
door, server/engine/client.js, checks every graph with server/safety/graph.js).
This node covers the ways in that never pass through the Studio: the port the
Studio can reveal to a person or an agent, ComfyUI's own web page, and scripts
on a pinned port. It registers an on_prompt handler that sends every submitted
graph to the Studio's check (POST /api/safety/check) and, when the Studio says
no, swaps the graph for a single AiplaySafetyRefusal node whose validation
fails with the Studio's sentence. ComfyUI then answers the poster with a 400
that carries that sentence, and nothing is queued.

WHY THE HANDLER NEVER RAISES. ComfyUI's trigger_on_prompt catches a handler's
exception, logs it and carries on with the ORIGINAL prompt. A raise here would
therefore be a bypass. Every path returns a dict; the last resort is an empty
dict, which ComfyUI refuses as "no_prompt".

WHERE IT ASKS. The Studio's supervisor sets AIPLAY_SAFETY_URL and a per-boot
AIPLAY_SAFETY_TOKEN when it spawns the engine (server/safety/backstop.js). A
ComfyUI started by hand has neither and this node stays inert: that engine is
not the Studio's. When they ARE set and the Studio cannot answer, every prompt
is refused (fail closed) rather than run unchecked.

The words are judged in one place only, the Studio, so this file holds no
word list that could drift from it.
"""

import json
import os
import urllib.request

REFUSAL = "This can't be made: it pairs a child or teenager with sexual content."
UNREACHABLE = ("This engine was started by AIPLAY Studio and the Studio's safety check did not answer, "
               "so nothing was run. Restart AIPLAY Studio.")
TIMEOUT_S = 15


class AiplaySafetyRefusal:
    """Stands in for a refused graph. It is an output node, so ComfyUI
    validates it, and its validation always fails with the reason."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"reason": ("STRING", {"default": REFUSAL})}}

    RETURN_TYPES = ()
    FUNCTION = "refuse"
    OUTPUT_NODE = True
    CATEGORY = "AIPLAY"
    DESCRIPTION = "Put in place of a graph AIPLAY Studio refused. It never runs."

    @classmethod
    def VALIDATE_INPUTS(cls, reason):
        return str(reason or REFUSAL)

    def refuse(self, reason):
        raise RuntimeError(str(reason or REFUSAL))


def _ask_studio(url, token, prompt):
    body = json.dumps({"prompt": prompt}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "x-aiplay-safety-token": token,
    })
    # No proxy: a loopback verdict must never be routed anywhere else.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=TIMEOUT_S) as r:
        return json.loads(r.read().decode("utf-8") or "{}")


def _refused(json_data, why):
    out = dict(json_data) if isinstance(json_data, dict) else {}
    out["prompt"] = {"1": {"class_type": "AiplaySafetyRefusal", "inputs": {"reason": str(why or REFUSAL)}}}
    # A partial run names nodes of the old graph; the refusal must be the output.
    out.pop("partial_execution_targets", None)
    return out


def gate(json_data, environ=None):
    """The on_prompt handler. Returns the prompt to run: the one it was given,
    or a refusal in its place. Never raises."""
    try:
        env = os.environ if environ is None else environ
        url = env.get("AIPLAY_SAFETY_URL") or ""
        token = env.get("AIPLAY_SAFETY_TOKEN") or ""
        if not url and not token:
            return json_data
        if not isinstance(json_data, dict) or "prompt" not in json_data:
            return json_data
        # Half a configuration is still a Studio engine: refuse, do not guess.
        if not url or not token:
            return _refused(json_data, UNREACHABLE)
        try:
            verdict = _ask_studio(url, token, json_data.get("prompt"))
        except Exception:
            return _refused(json_data, UNREACHABLE)
        if isinstance(verdict, dict) and verdict.get("ok") is True:
            return json_data
        why = verdict.get("error") if isinstance(verdict, dict) else None
        return _refused(json_data, why or REFUSAL)
    except Exception:
        try:
            return _refused(json_data, REFUSAL)
        except Exception:
            return {}


STATUS_PATH = "/aiplay/safety_status"


def status(environ=None):
    """Whether this engine's backstop is ARMED: loaded, and told by a Studio
    where to ask. The Studio reads this before it hands the engine's port to
    anybody (engine_reveal_port), because a revealed port on an unarmed engine
    is a door with nobody at it."""
    try:
        env = os.environ if environ is None else environ
        return {"armed": bool(env.get("AIPLAY_SAFETY_URL") and env.get("AIPLAY_SAFETY_TOKEN")),
                "node": "aiplay_safety_gate"}
    except Exception:
        return {"armed": False, "node": "aiplay_safety_gate"}


try:
    from server import PromptServer  # ComfyUI's own server module

    PromptServer.instance.add_on_prompt_handler(gate)
except Exception as exc:  # pragma: no cover - only outside a ComfyUI process
    print(f"[aiplay] the safety gate could not register with ComfyUI: {exc}")

# The status door, in its own try: a ComfyUI without aiohttp routes on its
# PromptServer must still get the handler above.
try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get(STATUS_PATH)
    async def _aiplay_safety_status(request):  # noqa: ARG001 (aiohttp's signature)
        return web.json_response(status())
except Exception as exc:  # pragma: no cover - only outside a ComfyUI process
    print(f"[aiplay] the safety gate's status door is not available: {exc}")

NODE_CLASS_MAPPINGS = {"AiplaySafetyRefusal": AiplaySafetyRefusal}
NODE_DISPLAY_NAME_MAPPINGS = {"AiplaySafetyRefusal": "AIPLAY safety refusal"}
