import { describe, expect, test } from "bun:test";
import type {
  LearningSettings,
  LearningSource,
} from "@openbot/shared/learning";
import { personalLearningContainerId } from "../src/learning/personal-space";
import { learningScopes } from "../src/learning/scopes";

const settings = (patch: Partial<LearningSettings>): LearningSettings => ({
  enabled: true,
  defaultTarget: null,
  agents: {},
  ...patch,
});

const own: LearningSource = {
  containerId: personalLearningContainerId("ada"),
  kind: "recordings",
  label: "From your recordings",
};
const conversations = (containerId: string): LearningSource => ({
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

  test("the person's own space named as a Bot's or the default target stays listed once, as recordings", () => {
    expect(
      learningScopes({
        edition: "personal",
        userId: "ada",
        settings: settings({
          defaultTarget: { containerId: own.containerId },
          agents: {
            a: { containerId: own.containerId },
            b: { containerId: "bot-b" },
          },
        }),
      }),
    ).toEqual([own, conversations("bot-b")]);
  });

  test("with Learning switched off, the personal edition still lists the Bot spaces, so what is waiting can be reviewed", () => {
    expect(
      learningScopes({
        edition: "personal",
        userId: "ada",
        settings: settings({
          enabled: false,
          defaultTarget: { containerId: "shared" },
          agents: { a: { containerId: "bot-a" } },
        }),
      }),
    ).toEqual([own, conversations("shared"), conversations("bot-a")]);
  });
});
