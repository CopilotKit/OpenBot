/**
 * A Bot is the same color on the phone as on the desktop: the phone's orb palette is the web app's,
 * and the same seed picks the same palette. Only the ground differs, which the phone doesn't draw.
 */
import { expect, test } from "bun:test";
import {
  orbPalette as webOrbPalette,
  ORB_PALETTES as webPalettes,
} from "../../app/src/lib/orb-palette";
import { ORB_PALETTES, orbPalette } from "../src/orb-palette";

const withoutGround = ({ bg: _bg, ...colors }: { bg: string }) => colors;

test("the phone's palettes are the web app's, in the same order", () => {
  expect(ORB_PALETTES.map(withoutGround)).toEqual(
    webPalettes.map(withoutGround),
  );
});

test("every seed picks the palette it picks on the web", () => {
  const seeds = [
    "",
    "general-assistant",
    "personal-assistant",
    "agent_0b7f2a3c-1d4e-4f5a-8b6c-7d8e9f0a1b2c",
    "agent_ffffffff-ffff-4fff-bfff-ffffffffffff",
    "research",
    "engineer",
  ];
  for (const seed of seeds) {
    expect(withoutGround(orbPalette(seed))).toEqual(
      withoutGround(webOrbPalette(seed)),
    );
  }
});
