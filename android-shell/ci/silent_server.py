#!/usr/bin/env python3
"""Accepts connections on 127.0.0.1:8797 and never answers: a load only the watchdog can end."""
import socket
import threading
import time

PORT = 8797
held = []


def main():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", PORT))
    server.listen(64)
    print(f"silent server on 127.0.0.1:{PORT}", flush=True)
    while True:
        connection, _ = server.accept()
        held.append(connection)  # read nothing, answer nothing, close nothing
        if len(held) > 200:
            held.pop(0).close()


if __name__ == "__main__":
    threading.Thread(target=main, daemon=True).start()
    while True:
        time.sleep(3600)
