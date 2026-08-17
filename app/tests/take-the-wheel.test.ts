import { describe, expect, test } from "bun:test";
import { pageCoordinates } from "../src/components/computer/take-the-wheel";

/**
 * Coordinate conversion cases for scaled, offset, and not-yet-loaded screenshots.
 */

const VIEWPORT = { naturalWidth: 1280, naturalHeight: 800 };

describe("pageCoordinates", () => {
  test("maps a click through a half-size image", () => {
    // 640x400 on screen, so every on-screen pixel is two page pixels.
    const at = pageCoordinates(
      VIEWPORT,
      { left: 0, top: 0, width: 640, height: 400 },
      { clientX: 100, clientY: 50 },
    );
    expect(at).toEqual({ x: 200, y: 100 });
  });

  test("maps a click through an image drawn larger than the viewport", () => {
    const at = pageCoordinates(
      VIEWPORT,
      { left: 0, top: 0, width: 2560, height: 1600 },
      { clientX: 1000, clientY: 400 },
    );
    expect(at).toEqual({ x: 500, y: 200 });
  });

  test("subtracts where the image sits on screen", () => {
    // The overlay pads the picture away from the window edge; a click is in window coordinates.
    const at = pageCoordinates(
      VIEWPORT,
      { left: 200, top: 120, width: 1280, height: 800 },
      { clientX: 260, clientY: 140 },
    );
    expect(at).toEqual({ x: 60, y: 20 });
  });

  test("1:1 is the identity, minus the offset", () => {
    const at = pageCoordinates(
      VIEWPORT,
      { left: 0, top: 0, width: 1280, height: 800 },
      { clientX: 655, clientY: 155 },
    );
    expect(at).toEqual({ x: 655, y: 155 });
  });

  test("the far corner maps to the far corner", () => {
    const at = pageCoordinates(
      VIEWPORT,
      { left: 0, top: 0, width: 640, height: 400 },
      { clientX: 640, clientY: 400 },
    );
    expect(at).toEqual({ x: 1280, y: 800 });
  });

  test("returns nothing rather than NaN before the picture has loaded", () => {
    // Degenerate first-render sizes produce no request.
    expect(
      pageCoordinates(
        VIEWPORT,
        { left: 0, top: 0, width: 0, height: 0 },
        { clientX: 10, clientY: 10 },
      ),
    ).toBeNull();
    expect(
      pageCoordinates(
        { naturalWidth: 0, naturalHeight: 0 },
        { left: 0, top: 0, width: 640, height: 400 },
        { clientX: 10, clientY: 10 },
      ),
    ).toBeNull();
  });

  test("a non-square scale on each axis is handled independently", () => {
    // X and Y scale independently when the displayed image is not proportional.
    const at = pageCoordinates(
      VIEWPORT,
      { left: 0, top: 0, width: 1280, height: 400 },
      { clientX: 640, clientY: 200 },
    );
    expect(at).toEqual({ x: 640, y: 400 });
  });
});
