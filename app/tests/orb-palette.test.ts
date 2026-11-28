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

  test("generated Bot seeds that collide with a starter use another palette", () => {
    expect(orbPalette("general-assistant")).toBe(ORB_PALETTES[6]);
    expect(orbPalette("personal-assistant")).toBe(ORB_PALETTES[0]);

    const generatedSeeds = [
      "agent_9b1c6f0e-7f0e-4c1e-9d55-2f4a8c1b6e21",
      "agent_9b1c6f0e-7f0e-4c1e-9d55-2f4a8c1b6e23",
    ];
    const palettes = generatedSeeds.map(orbPalette);
    for (const palette of palettes) {
      expect(palette).not.toBe(orbPalette("general-assistant"));
      expect(palette).not.toBe(orbPalette("personal-assistant"));
    }
    expect(new Set(palettes).size).toBe(generatedSeeds.length);
  });

  test("a generated Bot outside the starter palettes keeps its palette", () => {
    expect(orbPalette("agent_9b1c6f0e-7f0e-4c1e-9d55-2f4a8c1b6e27")).toBe(
      ORB_PALETTES[4],
    );
  });

  test("an empty seed gives the first palette", () => {
    expect(orbPalette("")).toBe(ORB_PALETTES[0]);
  });
});
