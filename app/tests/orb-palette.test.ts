import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ORB_NAMES,
  ORB_PALETTES,
  orbName,
  orbPalette,
} from "../src/lib/orb-palette";

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

describe("a Bot's tile gradient", () => {
  const styles = readFileSync(
    join(import.meta.dir, "../src/styles.css"),
    "utf8",
  );

  test("every palette has a name and the designers' tile gradient", () => {
    expect(ORB_NAMES.length).toBe(ORB_PALETTES.length);
    for (const name of ORB_NAMES)
      expect(styles).toContain(`--gradient-bot-${name}:`);
  });

  test("a Bot's tile is named as its colours are picked, from its seed", () => {
    for (const seed of SEEDS)
      expect(ORB_PALETTES[ORB_NAMES.indexOf(orbName(seed))]).toBe(
        orbPalette(seed),
      );
  });
});
