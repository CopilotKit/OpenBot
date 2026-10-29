import { describe, expect, test } from "bun:test";
import { ORB_PALETTES, orbPalette } from "../src/lib/orb-palette";

/*
 * A Bot's orb color comes from its seed (`avatarSeed`, the Bot's id by default), never its name,
 * so renaming a Bot keeps its color.
 */

const SEEDS = [
  "general-assistant",
  "knowledge",
  "risk-analyst",
  "expense-review",
  "research-desk",
  "meeting-follow-ups",
  "release-notes",
  "onboarding-buddy",
  "ticket-triage",
  "vendor-review",
];

describe("orbPalette", () => {
  test("the same seed always gives the same palette", () => {
    for (const seed of SEEDS) expect(orbPalette(seed)).toBe(orbPalette(seed));
  });

  test("every palette is one of the eight", () => {
    expect(ORB_PALETTES).toHaveLength(8);
    for (const seed of SEEDS) expect(ORB_PALETTES).toContain(orbPalette(seed));
  });

  test("a roster of ten Bots shows at least five colors", () => {
    expect(new Set(SEEDS.map(orbPalette)).size).toBeGreaterThanOrEqual(5);
  });

  test("an empty seed gives the first palette", () => {
    expect(orbPalette("")).toBe(ORB_PALETTES[0]);
  });
});
