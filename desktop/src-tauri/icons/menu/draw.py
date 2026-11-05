"""Draws the menu bar menu's icons: thin, geometric, one stroke weight, in the CopilotKit style.

macOS does not treat these as template images, so each is drawn twice, in the light menu's ink and
the dark menu's, and the app picks by the system appearance. 36px squares: muda shows menu icons
18pt high, and these are for 2x screens.

Run with `python3 draw.py` from this directory; it needs nothing beyond the standard library.
"""

import math
import struct
import zlib

SIZE = 36
SAMPLES = 4  # per axis, for anti-aliasing
STROKE = 2.6  # px at 36px, about 1.3pt


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy or 1)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def arc_dist(px, py, cx, cy, r, start, end):
    """Distance to an arc from `start` to `end` radians, counterclockwise in screen terms."""
    angle = math.atan2(py - cy, px - cx) % (2 * math.pi)
    s, e = start % (2 * math.pi), end % (2 * math.pi)
    inside = s <= angle <= e if s <= e else angle >= s or angle <= e
    if inside:
        return abs(math.hypot(px - cx, py - cy) - r)
    return min(
        math.hypot(px - (cx + r * math.cos(a)), py - (cy + r * math.sin(a))) for a in (s, e)
    )


def rounded_rect_dist(px, py, x0, y0, x1, y1, r):
    cx, cy = min(max(px, x0 + r), x1 - r), min(max(py, y0 + r), y1 - r)
    return abs(math.hypot(px - cx, py - cy) - r) if (px < x0 + r or px > x1 - r) and (py < y0 + r or py > y1 - r) else min(
        abs(px - x0) if y0 + r <= py <= y1 - r else 1e9,
        abs(px - x1) if y0 + r <= py <= y1 - r else 1e9,
        abs(py - y0) if x0 + r <= px <= x1 - r else 1e9,
        abs(py - y1) if x0 + r <= px <= x1 - r else 1e9,
        abs(math.hypot(px - cx, py - cy) - r),
    )


def dot_dist(px, py, cx, cy, r):
    return max(0.0, math.hypot(px - cx, py - cy) - r) - STROKE / 2


# Each icon: a function from a point to its distance from the drawing.
ICONS = {
    # A window: rounded frame with a title bar line.
    "open": lambda x, y: min(
        rounded_rect_dist(x, y, 6, 8, 30, 28, 3.5),
        seg_dist(x, y, 6, 13.5, 30, 13.5),
    ),
    # A dashboard: three bars of rising height on a baseline.
    "dashboard": lambda x, y: min(
        seg_dist(x, y, 9, 28, 9, 20),
        seg_dist(x, y, 18, 28, 18, 13),
        seg_dist(x, y, 27, 28, 27, 8),
    ),
    # Status: a pulse line.
    "status": lambda x, y: min(
        seg_dist(x, y, 5, 19, 12, 19),
        seg_dist(x, y, 12, 19, 15.5, 10),
        seg_dist(x, y, 15.5, 10, 20.5, 27),
        seg_dist(x, y, 20.5, 27, 24, 19),
        seg_dist(x, y, 24, 19, 31, 19),
    ),
    # About: an "i" in a ring.
    "about": lambda x, y: min(
        arc_dist(x, y, 18, 18, 12, 0, 2 * math.pi - 1e-6),
        seg_dist(x, y, 18, 17, 18, 25),
        dot_dist(x, y, 18, 12.3, 0),
    ),
    # Quit: the power symbol, an open ring with a stem.
    "quit": lambda x, y: min(
        arc_dist(x, y, 18, 19.5, 10, math.radians(-50), math.radians(230)),
        seg_dist(x, y, 18, 6.5, 18, 17),
    ),
}


def render(shape, ink):
    rows = []
    for j in range(SIZE):
        row = bytearray([0])  # filter: none
        for i in range(SIZE):
            covered = 0
            for sj in range(SAMPLES):
                for si in range(SAMPLES):
                    x = i + (si + 0.5) / SAMPLES
                    y = j + (sj + 0.5) / SAMPLES
                    if shape(x, y) <= STROKE / 2:
                        covered += 1
            alpha = round(255 * covered / (SAMPLES * SAMPLES))
            row += bytes((*ink, alpha))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


if __name__ == "__main__":
    for name, shape in ICONS.items():
        for theme, ink in (("light", (0x01, 0x05, 0x07)), ("dark", (0xFF, 0xFF, 0xFF))):
            with open(f"{name}-{theme}.png", "wb") as out:
                out.write(render(shape, ink))
            print(f"{name}-{theme}.png")
