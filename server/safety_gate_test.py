"""THE ENGINE'S OWN BACKSTOP: server/comfy_nodes/aiplay_safety_gate.py.

ComfyUI calls every on_prompt handler inside a try/except that logs the error
and carries on with the ORIGINAL prompt, so a handler that raises is a bypass.
This suite holds the gate to the one property that matters: whatever it is
given and whatever the Studio answers, it returns a prompt that is either the
one it was given (the Studio said yes, or this engine is not the Studio's) or a
refusal that cannot run. It never raises.

A tiny HTTP server on 127.0.0.1 stands in for the Studio's /api/safety/check.
Stdlib only: no ComfyUI, no torch, no GPU.

    python server/safety_gate_test.py
"""

import importlib.util
import json
import os
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
NODE = os.path.join(HERE, "comfy_nodes", "aiplay_safety_gate.py")
MINORS = os.path.join(HERE, "safety", "minors.js")

PASSED = 0
FAILED = []


def ok(label, cond, detail=""):
    global PASSED
    if cond:
        PASSED += 1
        print(f"  ok    {label}")
    else:
        FAILED.append(label)
        print(f"  FAIL  {label}" + (f"\n          {detail}" if detail else ""))


# ── ComfyUI's server module, as much of it as the node touches ──────────────
registered = []


class _PromptServer:
    instance = types.SimpleNamespace(add_on_prompt_handler=lambda h: registered.append(h))


sys.modules["server"] = types.SimpleNamespace(PromptServer=_PromptServer)

spec = importlib.util.spec_from_file_location("aiplay_safety_gate", NODE)
gate_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate_mod)
gate = gate_mod.gate

# ── the stand-in Studio ───────────────────────────────────────────────────
STATE = {"answer": {"ok": True}, "status": 200, "seen": []}


class Studio(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 (http.server's name)
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        STATE["seen"].append({"token": self.headers.get("x-aiplay-safety-token"), "body": body, "path": self.path})
        out = json.dumps(STATE["answer"]).encode("utf-8")
        self.send_response(STATE["status"])
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


httpd = HTTPServer(("127.0.0.1", 0), Studio)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{httpd.server_address[1]}/api/safety/check"
ENV = {"AIPLAY_SAFETY_URL": URL, "AIPLAY_SAFETY_TOKEN": "t" * 48}

GRAPH = {"1": {"class_type": "CLIPTextEncode", "inputs": {"text": "whatever the poster sent"}}}


def is_refusal(out, why=None):
    p = out.get("prompt") if isinstance(out, dict) else None
    if not isinstance(p, dict) or list(p.keys()) != ["1"]:
        return False
    node = p["1"]
    return node.get("class_type") == "AiplaySafetyRefusal" and (why is None or node["inputs"]["reason"] == why)


print("\n  -- registration and the sentence --")
ok("the node registers its handler with ComfyUI's PromptServer", registered == [gate])
ok("the refusal node is exported", "AiplaySafetyRefusal" in gate_mod.NODE_CLASS_MAPPINGS)
with open(MINORS, encoding="utf-8") as fh:
    ok("the node's sentence is the Studio's own, word for word", f'"{gate_mod.REFUSAL}"' in fh.read())
R = gate_mod.AiplaySafetyRefusal
ok("the refusal node is an output node, so ComfyUI validates it", R.OUTPUT_NODE is True)
ok("...and its validation always fails, carrying the reason", R.VALIDATE_INPUTS("because") == "because"
   and R.VALIDATE_INPUTS("") == gate_mod.REFUSAL and R.VALIDATE_INPUTS("x") is not True)
try:
    R().refuse("because")
    ok("...and it can never run", False)
except RuntimeError:
    ok("...and it can never run", True)

print("\n  -- the Studio's answer --")
STATE.update(answer={"ok": True}, status=200)
data = {"prompt": GRAPH, "client_id": "c1"}
out = gate(dict(data), ENV)
ok("the Studio says yes: the prompt runs untouched", out == data, json.dumps(out))
ok("...asked with the per-boot token, about the whole graph",
   STATE["seen"][-1]["token"] == "t" * 48 and STATE["seen"][-1]["body"] == {"prompt": GRAPH})

STATE.update(answer={"ok": False, "error": gate_mod.REFUSAL, "code": "minor-sexual"}, status=200)
out = gate({"prompt": GRAPH, "client_id": "c1", "partial_execution_targets": ["1"], "extra_data": {"a": 1}}, ENV)
ok("the Studio says no: the graph is swapped for the refusal, with the Studio's sentence",
   is_refusal(out, gate_mod.REFUSAL), json.dumps(out))
ok("...the poster's own fields survive, the old graph's partial targets do not",
   out.get("client_id") == "c1" and out.get("extra_data") == {"a": 1} and "partial_execution_targets" not in out)
ok("...and none of the refused graph's words remain in the prompt", "whatever the poster sent" not in json.dumps(out["prompt"]))

STATE.update(answer={"ok": False, "error": "The Studio could not read this graph, so it was not run.", "code": "unreadable"})
ok("an unreadable graph is refused with the Studio's reason", is_refusal(gate({"prompt": GRAPH}, ENV), STATE["answer"]["error"]))

STATE.update(answer={"what": "no ok field"})
ok("an answer without ok:true is a no", is_refusal(gate({"prompt": GRAPH}, ENV)))
STATE.update(answer=["not", "a", "dict"])
ok("an answer that is not an object is a no", is_refusal(gate({"prompt": GRAPH}, ENV)))
STATE.update(answer={"ok": True}, status=403)
ok("a 403 (wrong token) is a no", is_refusal(gate({"prompt": GRAPH}, ENV), gate_mod.UNREACHABLE))
STATE.update(status=200)

print("\n  -- fail closed, never raise --")
dead = {"AIPLAY_SAFETY_URL": "http://127.0.0.1:9/api/safety/check", "AIPLAY_SAFETY_TOKEN": "t" * 48}
ok("the Studio cannot be reached: refused, with the reason", is_refusal(gate({"prompt": GRAPH}, dead), gate_mod.UNREACHABLE))
ok("a token with no address is still a Studio engine: refused", is_refusal(gate({"prompt": GRAPH}, {"AIPLAY_SAFETY_TOKEN": "x"})))
ok("an address with no token: refused without asking", is_refusal(gate({"prompt": GRAPH}, {"AIPLAY_SAFETY_URL": URL})))
for label, junk in [("None", None), ("a list", [1, 2]), ("a string", "prompt"), ("a dict without prompt", {"client_id": "c"})]:
    try:
        res = gate(junk, ENV)
        ok(f"junk in ({label}) never raises", True)
        ok(f"...and is handed back for ComfyUI to refuse as it always has ({label})", res == junk)
    except Exception as exc:  # pragma: no cover - the failure being tested for
        ok(f"junk in ({label}) never raises", False, repr(exc))


class Hostile(dict):
    """A prompt dict whose copy blows up, to reach the last-resort path."""

    def get(self, *a, **k):
        raise RuntimeError("boom")

    def keys(self):
        raise RuntimeError("boom")


try:
    res = gate(Hostile(prompt=GRAPH), ENV)
    ok("even a prompt that explodes when read does not raise", True)
    ok("...and what comes back cannot run the original graph", "whatever the poster sent" not in json.dumps(res.get("prompt", {}) if isinstance(res, dict) else {}))
except Exception as exc:  # pragma: no cover
    ok("even a prompt that explodes when read does not raise", False, repr(exc))

print("\n  -- the status door the Studio reads before it reveals the port --")
ok("armed when a Studio told it where to ask", gate_mod.status(ENV) == {"armed": True, "node": "aiplay_safety_gate"})
ok("not armed in a ComfyUI started by hand", gate_mod.status({})["armed"] is False)
ok("not armed with half a configuration", gate_mod.status({"AIPLAY_SAFETY_TOKEN": "x"})["armed"] is False)
ok("status never raises, whatever it is handed", gate_mod.status(None)["armed"] in (True, False)
   and gate_mod.status(["not", "a", "mapping"])["armed"] is False)
ok("the path is the one the Studio asks (server/engine/client.js BACKSTOP_STATUS_PATH)",
   gate_mod.STATUS_PATH == "/aiplay/safety_status")
with open(os.path.join(HERE, "engine", "client.js"), encoding="utf-8") as fh:
    ok("...word for word", 'BACKSTOP_STATUS_PATH = "/aiplay/safety_status"' in fh.read())

print("\n  -- a ComfyUI not started by the Studio --")
calls = len(STATE["seen"])
out = gate({"prompt": GRAPH}, {})
ok("no address and no token: the node is inert and asks nobody", out == {"prompt": GRAPH} and len(STATE["seen"]) == calls)

httpd.shutdown()
print(f"\n  {PASSED} passed, {len(FAILED)} failed\n")
sys.exit(1 if FAILED else 0)
