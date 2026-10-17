import { describe, expect, test } from "bun:test";
import {
  approveSkillShareSchema,
  skillSharePaths,
  skillShareRequestSchema,
} from "./skill-share-api";

const bot = {
  name: "Refund Bot",
  title: "Refund specialist",
  roleDescription: "Handles refund requests.",
};

describe("skillShareRequestSchema", () => {
  test("a share request parses", () => {
    const parsed = skillShareRequestSchema.parse({
      kind: "share",
      skillSlug: "refund-order",
    });
    expect(parsed).toEqual({ kind: "share", skillSlug: "refund-order" });
  });

  test("a make_bot request with a bot parses", () => {
    const parsed = skillShareRequestSchema.parse({
      kind: "make_bot",
      skillSlug: "refund-order",
      bot,
    });
    expect(parsed.kind).toBe("make_bot");
  });

  test("a make_bot request without a bot is rejected", () => {
    const result = skillShareRequestSchema.safeParse({
      kind: "make_bot",
      skillSlug: "refund-order",
    });
    expect(result.success).toBe(false);
  });

  test("a make_bot bot name of 81 characters is rejected", () => {
    const result = skillShareRequestSchema.safeParse({
      kind: "make_bot",
      skillSlug: "refund-order",
      bot: { ...bot, name: "a".repeat(81) },
    });
    expect(result.success).toBe(false);
  });

  test("an 80 character name is accepted", () => {
    const result = skillShareRequestSchema.safeParse({
      kind: "make_bot",
      skillSlug: "refund-order",
      bot: { ...bot, name: "a".repeat(80) },
    });
    expect(result.success).toBe(true);
  });

  test("a share request with an extra field is rejected", () => {
    const result = skillShareRequestSchema.safeParse({
      kind: "share",
      skillSlug: "refund-order",
      bot,
    });
    expect(result.success).toBe(false);
  });
});

describe("approveSkillShareSchema", () => {
  test("defaults addToBotIds to an empty list", () => {
    expect(approveSkillShareSchema.parse({})).toEqual({ addToBotIds: [] });
  });
});

describe("skillSharePaths", () => {
  test("encodes the request id", () => {
    expect(skillSharePaths.approve("a b")).toBe(
      "/api/approvals/skill-shares/a%20b/approve",
    );
    expect(skillSharePaths.decline("a b")).toBe(
      "/api/approvals/skill-shares/a%20b/decline",
    );
  });
});
