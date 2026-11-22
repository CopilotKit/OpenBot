import { expect, test } from "bun:test";
import { mulberry32 } from "./random";

function firstFive(seed: number): number[] {
  const next = mulberry32(seed);
  return [next(), next(), next(), next(), next()];
}

test("the same seed gives the same first five values", () => {
  expect(firstFive(1)).toEqual(firstFive(1));
  expect(firstFive(1)).not.toEqual(firstFive(2));
});

test("the standard mulberry32 gives its known first value for seed 1", () => {
  expect(mulberry32(1)()).toBeCloseTo(0.6270739405881613, 12);
});

test("values are in [0, 1)", () => {
  const next = mulberry32(42);
  for (let i = 0; i < 10_000; i++) {
    const value = next();
    expect(value >= 0 && value < 1).toBe(true);
  }
});
