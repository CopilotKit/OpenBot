import { expect, test } from "bun:test";
import {
  SOLID_FACE_COLORS,
  solidFaceColor,
} from "../src/components/agents/solid-face";

test("a Bot keeps the same solid colour every time it is drawn", () => {
  expect(solidFaceColor("scout")).toBe(solidFaceColor("scout"));
  for (const seed of ["", "a", "scout", "a much longer seed 123"]) {
    expect(SOLID_FACE_COLORS).toContain(solidFaceColor(seed));
  }
});
