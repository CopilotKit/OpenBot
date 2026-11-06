import { describe, expect, test } from "bun:test";
import type { LearningSettings } from "@openbot/shared/learning";
import { personalLearningContainerId } from "../src/learning/personal-space";
import { learningScopes } from "../src/learning/scopes";

const settings = (patch: Partial<LearningSettings>): LearningSettings => ({
  enabled: true,
  defaultTarget: null,
  agents: {},
  ...patch,
});

const own = {
  containerId: personalLearningContainerId("ada"),
  kind: "recordings",
  label: "From your recordings",
};
const conversations = (containerId: string) => ({
  containerId,
  kind: "conversations",
  label: "From your conversations",
});

describe("learningScopes", () => {
  test("the team edition gives only the person's own space", () => {
    expect(
      learningScopes({
        edition: "team",
        userId: "ada",
        settings: settings({
          defaultTarget: { containerId: "shared" },
          agents: { a: { containerId: "bot-a" } },
        }),
      }),
    ).toEqual([own]);
  });

  test("the personal edition adds the default and each distinct Bot space in order", () => {
    expect(
      learningScopes({
        edition: "personal",
        userId: "ada",
        settings: settings({
          defaultTarget: { containerId: "shared" },
          agents: {
            a: { containerId: "bot-a" },
            b: null,
            c: { containerId: "shared" },
            d: { containerId: "bot-d" },
            e: { containerId: "bot-a" },
          },
        }),
      }),
    ).toEqual([
      own,
      conversations("shared"),
      conversations("bot-a"),
      conversations("bot-d"),
    ]);
  });

  test("the personal edition with no targets gives only the own space", () => {
    expect(
      learningScopes({
        edition: "personal",
        userId: "ada",
        settings: settings({}),
      }),
    ).toEqual([own]);
  });
});
