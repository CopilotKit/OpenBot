import { describe, expect, test } from "bun:test";
import {
  avatarResponse,
  avatarUrl,
  MAX_AVATAR_BYTES,
  parseAvatarImage,
} from "../src/avatar";

const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("avatar image validation", () => {
  test("accepts a bounded image and the explicit reset", () => {
    expect(parseAvatarImage(ONE_PIXEL_PNG)).toEqual({
      ok: true,
      value: ONE_PIXEL_PNG,
    });
    expect(parseAvatarImage(null)).toEqual({ ok: true, value: null });
  });

  test("uses a short versioned URL and serves the original bytes safely", async () => {
    const url = avatarUrl("/api/me/avatar/image", ONE_PIXEL_PNG);
    expect(url).toMatch(/^\/api\/me\/avatar\/image\?v=[a-z0-9]+$/);
    expect(url).not.toContain("base64");

    const response = avatarResponse(ONE_PIXEL_PNG);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from(ONE_PIXEL_PNG.split(",")[1], "base64"),
    );
  });

  test("does not trust the data URL MIME label", () => {
    const disguised = ONE_PIXEL_PNG.replace("image/png", "image/jpeg");

    expect(parseAvatarImage(disguised)).toEqual({
      ok: false,
      error: "Avatar image does not match its PNG, JPEG, or WebP format.",
    });
  });

  test("rejects oversized payloads before storing them", () => {
    const encoded = Buffer.alloc(MAX_AVATAR_BYTES + 1).toString("base64");

    expect(parseAvatarImage(`data:image/png;base64,${encoded}`)).toEqual({
      ok: false,
      error: "Avatar image must be 2 MB or smaller.",
    });
  });

  test("rejects compressed images with unsafe bitmap dimensions", () => {
    const header = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
    header.writeUInt32BE(4097, 16);
    header.writeUInt32BE(1, 20);

    expect(
      parseAvatarImage(`data:image/png;base64,${header.toString("base64")}`),
    ).toEqual({
      ok: false,
      error: "Avatar image dimensions must be at most 4096 by 4096 pixels.",
    });
  });
});
