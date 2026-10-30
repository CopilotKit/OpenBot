import { describe, expect, test } from "bun:test";
import {
  avatarSeedProblem,
  BOT_COLOURS,
  namedColour,
  newFace,
  recoloured,
  seedFor,
} from "./bot-look";

describe("a seed that names its colour", () => {
  test("names one of the eight, and never violet", () => {
    expect(BOT_COLOURS).toHaveLength(8);
    expect(BOT_COLOURS).not.toContain("violet" as never);
    for (const colour of BOT_COLOURS) {
      expect(namedColour(seedFor(colour, "k2p9x7aq"))).toBe(colour);
    }
    expect(namedColour("violet:k2p9x7aq")).toBeNull();
  });

  test("any other seed names no colour", () => {
    for (const seed of [
      "research-desk",
      "agent_3f6c",
      "",
      "purple:k2p9x7aq",
      "Moss:k2p9x7aq",
      ":moss",
    ]) {
      expect(namedColour(seed)).toBeNull();
    }
  });
});

describe("what the server accepts as a look", () => {
  test("a short safe token, named colour or not", () => {
    expect(avatarSeedProblem("research-desk")).toBeNull();
    expect(avatarSeedProblem(`agent_${crypto.randomUUID()}`)).toBeNull();
    expect(avatarSeedProblem("moss:k2p9x7aq")).toBeNull();
    expect(avatarSeedProblem("x".repeat(64))).toBeNull();
  });

  test("refuses anything else in a plain sentence", () => {
    for (const seed of [
      "",
      "x".repeat(65),
      "moss:k2 p9",
      "<script>",
      "moss:ü",
      42,
      null,
    ]) {
      expect(avatarSeedProblem(seed)).toBe(
        "A Bot's look is 1 to 64 letters, numbers, hyphens, underscores or colons.",
      );
    }
  });

  test("refuses violet, which is OpenBot's, and a colour no Bot has", () => {
    expect(avatarSeedProblem("violet:k2p9x7aq")).toBe(
      "Violet is kept for OpenBot. Pick another colour.",
    );
    expect(avatarSeedProblem("purple:k2p9x7aq")).toBe(
      "That isn't a colour a Bot can have. Pick one of the eight.",
    );
  });
});

describe("a new look", () => {
  test("a new face is new each time, and always an acceptable seed", () => {
    const faces = Array.from({ length: 50 }, newFace);
    expect(new Set(faces).size).toBe(50);
    for (const face of faces) {
      expect(face).toMatch(/^[a-z0-9]{8}$/);
      expect(avatarSeedProblem(seedFor("ember", face))).toBeNull();
    }
  });

  test("another colour keeps the face, so going back finds it", () => {
    expect(recoloured("research-desk", "moss")).toBe("moss:research-desk");
    expect(recoloured("moss:research-desk", "sky")).toBe("sky:research-desk");
    expect(recoloured(recoloured("ocean:k2p9", "sun"), "ocean")).toBe(
      "ocean:k2p9",
    );
  });

  test("a face that can't be kept is drawn anew", () => {
    for (const seed of ["Research Desk", `copy-of-${"x".repeat(60)}`]) {
      const next = recoloured(seed, "coral");
      expect(namedColour(next)).toBe("coral");
      expect(avatarSeedProblem(next)).toBeNull();
    }
  });
});
