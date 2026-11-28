#!/usr/bin/env python3
"""The small servers the RN shell's UI tests need besides the mock stacks. Standard library only.

  127.0.0.1:3013  accepts connections and never answers (a load only the watchdog can end)
  127.0.0.1:3014  answers 502 to everything (a 5xx main document on the app's own origin)
  127.0.0.1:8790  the header probe, playing the app's origin (the app is told openbot.base_url
                  http://localhost:8790 and openbot.probe_url http://localhost:8790/enter-probe):
                    /enter-probe  records whether `OpenBot-Shell` came, 303 to /landing
                    /landing      records it, then the page goes to /same by script
                    /same         records it, then the page goes to http://127.0.0.1:8791/other
                    /report       "HEADER PROBE PASS" when the header came on /enter-probe only
                                  (the 303 it answered may carry it too: same origin, harmless) and on
                                  no later request; "HEADER PROBE FAIL ..." otherwise
  127.0.0.1:8791  another origin: /other records it, then the page goes back to /report on 8790

Every request is printed with its path and whether the header came (its value, never anything else).
"""
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

seen = []  # (path, header value or None)
lock = threading.Lock()


def page(title, body, script=""):
    return f"""<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title></head><body style="font:20px -apple-system,Roboto,sans-serif;padding:24px">
<main><h1>{title}</h1>{body}</main><script>{script}</script></body></html>""".encode()


class Probe(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def record(self):
        value = self.headers.get("OpenBot-Shell")
        path = self.path.split("?")[0]
        with lock:
            seen.append((f"{self.server.server_port}{path}", value))
        print(f"probe {self.server.server_port} {path} header={value!r}", flush=True)

    def send(self, status, content, location=None):
        self.send_response(status)
        if location:
            self.send_header("Location", location)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/favicon.ico":
            self.send(404, b"")
            return
        if self.server.server_port == 8791:
            self.record()
            self.send(200, page("Another origin", "<p>Going back.</p>", "setTimeout(function(){location.assign('http://localhost:8790/report')},700)"))
            return
        if path == "/enter-probe":
            with lock:
                seen.clear()
            self.record()
            self.send(303, b"", "/landing")
        elif path == "/landing":
            self.record()
            self.send(200, page("Landing", "<p>Header probe running.</p>", "setTimeout(function(){location.assign('/same')},700)"))
        elif path == "/same":
            self.record()
            self.send(200, page("Same origin", "<p>Header probe running.</p>", "setTimeout(function(){location.assign('http://127.0.0.1:8791/other')},700)"))
        elif path == "/report":
            self.record()
            with lock:
                rows = list(seen)
            enter = [v for p, v in rows if p == "8790/enter-probe"]
            later = [(p, v) for p, v in rows if p not in ("8790/enter-probe", "8790/landing")]
            ok = bool(enter) and enter[0] in ("ios", "android") and all(v is None for _, v in later)
            verdict = "HEADER PROBE PASS" if ok else "HEADER PROBE FAIL"
            listing = "".join(f"<li>{p}: {v or 'no header'}</li>" for p, v in rows)
            self.send(200, page(verdict, f"<ul>{listing}</ul>"))
        else:
            self.send(404, page("Not here", ""))


class BadGateway(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        body = b"<html><body><h1>502 Bad Gateway</h1></body></html>"
        self.send_response(502)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def silent(port):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", port))
    server.listen(64)
    held = []
    while True:
        connection, _ = server.accept()
        held.append(connection)
        if len(held) > 200:
            held.pop(0).close()


def serve(port, handler):
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()


if __name__ == "__main__":
    threading.Thread(target=silent, args=(3013,), daemon=True).start()
    threading.Thread(target=serve, args=(3014, BadGateway), daemon=True).start()
    threading.Thread(target=serve, args=(8790, Probe), daemon=True).start()
    threading.Thread(target=serve, args=(8791, Probe), daemon=True).start()
    print("test servers up: 3013 silent, 3014 502, 8790/8791 header probe", flush=True)
    while True:
        time.sleep(3600)
