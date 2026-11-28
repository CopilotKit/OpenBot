#!/usr/bin/env python3
"""Runs mock stack C's front end (app/serve.ts on APP_PORT 3013) and lets a test stop and start it.

The self-hosted lock-screen test needs that OpenBot to really go away and come back. This listens on
127.0.0.1:8790 (reached from the emulator through adb reverse) and answers:
  POST /stack-c/stop   stops the front end: 3013 refuses connections
  POST /stack-c/start  starts it again and waits until it answers
  GET  /stack-c        "up" or "down"
Standard-library Python; started by the test workflow's "other" shard only.
"""

import http.server
import os
import subprocess
import sys
import time
import urllib.request

ROOT = sys.argv[1] if len(sys.argv) > 1 else "."
LOG = sys.argv[2] if len(sys.argv) > 2 else os.devnull
ENV = dict(os.environ, APP_PORT="3013", SERVER_PORT="3003")
state = {"process": None}


def up():
    try:
        with urllib.request.urlopen("http://127.0.0.1:3013/", timeout=2) as answer:
            return answer.status == 200
    except Exception:
        return False


def start():
    if state["process"] is None or state["process"].poll() is not None:
        log = open(LOG, "ab")
        state["process"] = subprocess.Popen(["bun", "app/serve.ts"], cwd=ROOT, env=ENV, stdout=log, stderr=log)
    for _ in range(60):
        if up():
            return True
        time.sleep(0.5)
    return False


def stop():
    process = state["process"]
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
    state["process"] = None
    for _ in range(20):
        if not up():
            return True
        time.sleep(0.5)
    return False


class Handler(http.server.BaseHTTPRequestHandler):
    def answer(self, status, text):
        body = text.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/stack-c":
            return self.answer(200, "up" if up() else "down")
        self.answer(404, "not found")

    def do_POST(self):
        if self.path == "/stack-c/stop":
            return self.answer(200 if stop() else 500, "down")
        if self.path == "/stack-c/start":
            return self.answer(200 if start() else 500, "up")
        self.answer(404, "not found")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    start()
    http.server.ThreadingHTTPServer(("127.0.0.1", 8790), Handler).serve_forever()
