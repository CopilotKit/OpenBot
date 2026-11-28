import { describe, expect, test } from "bun:test";
import { type Box, gaps, offGrid } from "./geometry";

const box = (x: number, y: number, width: number, height: number): Box => ({
  x,
  y,
  width,
  height,
});

describe("offGrid", () => {
  test("distance to nearest grid line", () => {
    expect(offGrid(box(13, 16, 1, 1), 4)).toEqual({ x: 1, y: 0 });
  });

  test("handles negative values", () => {
    expect(offGrid(box(-1, -4, 1, 1), 4)).toEqual({ x: 1, y: 0 });
  });
});

describe("gaps", () => {
  const target = box(100, 100, 50, 50);

  test("nearest per side", () => {
    const result = gaps(target, [
      box(100, 60, 50, 20),
      box(100, 20, 50, 20),
      box(170, 100, 20, 50),
      box(200, 100, 20, 50),
      box(100, 170, 50, 20),
      box(100, 250, 50, 20),
      box(60, 100, 20, 50),
      box(0, 100, 20, 50),
    ]);
    expect(result).toEqual({ top: 20, right: 20, bottom: 20, left: 20 });
  });

  test("ignores a box that does not overlap on the other axis", () => {
    const result = gaps(target, [box(200, 60, 20, 20)]);
    expect(result).toEqual({
      top: null,
      right: null,
      bottom: null,
      left: null,
    });
  });

  test("ignores a box that only touches on the other axis", () => {
    expect(gaps(target, [box(150, 60, 20, 20)]).top).toBeNull();
  });

  test("null on empty sides", () => {
    expect(gaps(target, [])).toEqual({
      top: null,
      right: null,
      bottom: null,
      left: null,
    });
  });

  test("ignores an intersecting box", () => {
    expect(gaps(target, [box(120, 120, 50, 50)])).toEqual({
      top: null,
      right: null,
      bottom: null,
      left: null,
    });
  });

  test("adjacent box has a gap of zero", () => {
    expect(gaps(target, [box(100, 80, 50, 20)]).top).toBe(0);
  });
});
