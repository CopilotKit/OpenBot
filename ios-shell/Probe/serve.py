#!/usr/bin/env python3
"""Probe server for the iOS web view shell. Python 3 standard library only.

Serves two origins on 127.0.0.1:
  APP port 8765 ("the web app origin"):
    GET  /, /index.html, /probe.js, /popup.html, /persist.html   static files from this folder
    GET  /api/set-cookie      sets probe_session (HttpOnly, SameSite=Lax, session cookie)
    GET  /api/echo-cookie     returns the NAMES of the cookies the request carried
    GET  /api/sse             server-sent events: 3 events 300 ms apart, then closes
    GET  /api/stream          text/plain body written in 3 lines 300 ms apart (streaming fetch)
    POST /api/persist/set     sets probe_persist (HttpOnly, SameSite=Lax, Max-Age one year)
    POST /api/persist/clear   expires probe_persist
    GET  /api/persist/check   {"cookie": true|false}: did probe_persist come back
    GET  /status/503          an HTML error page with status 503
    GET  /download            a text file sent as an attachment (Content-Disposition)
  API port 8766 ("a different-origin API"), nothing static:
    GET     /nocors           JSON with no CORS headers (a cross-origin fetch must be blocked)
    GET     /cors             JSON with Access-Control-Allow-Origin: <the app origin> and
                              Access-Control-Allow-Credentials: true
    OPTIONS /cors             preflight answer: allows POST, Content-Type and X-Probe
    POST    /cors             echoes whether X-Probe arrived and how many preflights were seen
    GET     /set-cookie       with CORS headers, sets probe_api (SameSite=Lax)
    GET     /echo-cookie      with CORS headers, returns the NAMES of the cookies it got
    GET     /alert.html       a page that calls alert() as it loads (another site's dialog)

Run: python3 ios-shell/Probe/serve.py   (PROBE_APP_PORT / PROBE_API_PORT override the ports)
"""
import json
import os
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = os.environ.get("PROBE_HOST", "127.0.0.1")
APP_PORT = int(os.environ.get("PROBE_APP_PORT", "8765"))
API_PORT = int(os.environ.get("PROBE_API_PORT", "8766"))
ALLOWED_ORIGINS = {f"http://127.0.0.1:{APP_PORT}", f"http://localhost:{APP_PORT}"}
preflights = {"count": 0}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)

    # Helpers

    def is_api(self):
        return self.server.server_address[1] == API_PORT

    def path_only(self):
        return self.path.split("?", 1)[0]

    def cookie_names(self):
        raw = self.headers.get("Cookie", "")
        return sorted({part.split("=", 1)[0].strip() for part in raw.split(";") if part.strip()})

    def cors_headers(self):
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            return [
                ("Access-Control-Allow-Origin", origin),
                ("Access-Control-Allow-Credentials", "true"),
                ("Vary", "Origin"),
            ]
        return [("Vary", "Origin")]

    def send_json(self, obj, status=200, headers=()):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in headers:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def send_body(self, status, content_type, text, headers=()):
        body = text.encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in headers:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def send_slowly(self, content_type, pieces):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        for piece in pieces:
            self.wfile.write(piece.encode())
            self.wfile.flush()
            time.sleep(0.3)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # Routes

    def do_OPTIONS(self):
        if self.is_api() and self.path_only() == "/cors":
            preflights["count"] += 1
            self.send_response(204)
            for key, value in self.cors_headers():
                self.send_header(key, value)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Probe")
            self.send_header("Access-Control-Max-Age", "0")
            self.end_headers()
            return
        self.send_json({"error": "not found"}, 404)

    def do_GET(self):
        path = self.path_only()
        if self.is_api():
            if path == "/nocors":
                return self.send_json({"ok": True})
            if path == "/cors":
                return self.send_json({"ok": True}, headers=self.cors_headers())
            if path == "/set-cookie":
                return self.send_json({"ok": True}, headers=self.cors_headers()
                                      + [("Set-Cookie", "probe_api=1; Path=/; SameSite=Lax")])
            if path == "/echo-cookie":
                return self.send_json({"cookieNames": self.cookie_names()}, headers=self.cors_headers())
            if path == "/alert.html":
                return self.send_body(200, "text/html; charset=utf-8",
                                      "<!doctype html><script>alert('from another site')</script>")
            return self.send_json({"error": "not found"}, 404)

        if path == "/api/set-cookie":
            return self.send_json({"ok": True}, headers=[
                ("Set-Cookie", "probe_session=1; Path=/; HttpOnly; SameSite=Lax")])
        if path == "/api/echo-cookie":
            return self.send_json({"cookieNames": self.cookie_names()})
        if path == "/api/persist/check":
            return self.send_json({"cookie": "probe_persist" in self.cookie_names()})
        if path == "/api/sse":
            return self.send_slowly("text/event-stream", [f"data: event {i}\n\n" for i in (1, 2, 3)])
        if path == "/api/stream":
            return self.send_slowly("text/plain; charset=utf-8", [f"line {i}\n" for i in (1, 2, 3)])
        if path.startswith("/api/"):
            return self.send_json({"error": "not found"}, 404)
        if path == "/status/503":
            return self.send_body(503, "text/html; charset=utf-8",
                                  "<!doctype html><title>503</title><h1>Service Unavailable</h1>")
        if path == "/download":
            return self.send_body(200, "text/plain; charset=utf-8", "probe download\n",
                                  [("Content-Disposition", 'attachment; filename="probe.txt"')])
        return super().do_GET()

    def do_POST(self):
        path = self.path_only()
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)  # read and drop the body
        if self.is_api() and path == "/cors":
            return self.send_json({
                "ok": True,
                "gotProbeHeader": self.headers.get("X-Probe") == "1",
                "preflightsSeen": preflights["count"],
            }, headers=self.cors_headers())
        if not self.is_api() and path == "/api/persist/set":
            return self.send_json({"ok": True}, headers=[
                ("Set-Cookie", "probe_persist=1; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax")])
        if not self.is_api() and path == "/api/persist/clear":
            return self.send_json({"ok": True}, headers=[
                ("Set-Cookie", "probe_persist=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")])
        return self.send_json({"error": "not found"}, 404)


def serve(port):
    server = ThreadingHTTPServer((HOST, port), Handler)
    server.daemon_threads = True
    print(f"probe: serving http://{HOST}:{port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    threading.Thread(target=serve, args=(API_PORT,), daemon=True).start()
    serve(APP_PORT)
