"""
Needle, served on this computer for OpenBot's server.

Needle (https://github.com/cactus-compute/needle, Apache-2.0, by Cactus Compute) is a tiny model
that reads a request and picks which of the given tools it needs. OpenBot asks it which of a Bot's
skills a message is about, so the big AI is only shown the tools that matter.

One request at a time, on purpose: the engine holds one model and one set of tools at once.
Usage counts are off (NEEDLE_TELEMETRY=0, DO_NOT_TRACK=1, set in the Dockerfile and here).

  POST /complete  {"text": "...", "tools": [...], "system": "..."}  ->  Needle's JSON answer
  GET  /health    ->  {"ok": true}
"""

import json
import os
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, HTTPServer

os.environ["NEEDLE_TELEMETRY"] = "0"
os.environ["DO_NOT_TRACK"] = "1"

import needle  # noqa: E402  (after the environment, so the engine starts with usage counts off)

MAX_BODY = 256 * 1024
agents: "OrderedDict[str, needle.Needle]" = OrderedDict()


def agent_for(tools: list, system: str) -> "needle.Needle":
    key = json.dumps([tools, system], sort_keys=True)
    if key in agents:
        agents.move_to_end(key)
        return agents[key]
    agent = needle.Needle(tools=json.dumps(tools), system=system or None, stateless=True)
    agents[key] = agent
    while len(agents) > 16:
        agents.popitem(last=False)
    return agent


class Handler(BaseHTTPRequestHandler):
    def reply(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/health":
            self.reply(200, {"ok": True})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/complete":
            self.reply(404, {"error": "not found"})
            return
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_BODY:
            self.reply(400, {"error": "body missing or too large"})
            return
        try:
            body = json.loads(self.rfile.read(length))
            text = str(body.get("text") or "")
            tools = body.get("tools")
            if not text.strip() or not isinstance(tools, list) or not tools:
                self.reply(400, {"error": "text and tools are required"})
                return
            self.reply(200, agent_for(tools, str(body.get("system") or "")).complete(text, max_new_tokens=256))
        except Exception as error:  # A bad request costs that request, never the helper.
            self.reply(500, {"error": str(error)[:300]})

    def log_message(self, *args) -> None:  # Requests carry people's messages: never logged.
        pass


if __name__ == "__main__":
    port = int(os.environ.get("NEEDLE_PORT", "4310"))
    # Loads the model once at start, so the first real request is fast.
    needle.Needle(tools=[{"name": "noop", "description": "Nothing.", "parameters": {"type": "object", "properties": {}}}])
    print(f"Needle is ready on port {port}", flush=True)
    HTTPServer(("0.0.0.0", port), Handler).serve_forever()
