import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const environment = {
  DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
  KEY_ENCRYPTION_KEY: "b3BlbmJvdC1wcm9kdWN0aW9uLXRlc3Qta2V5LTMyMzI=",
  INTELLIGENCE_API_URL: "https://api.intelligence.copilotkit.ai",
  INTELLIGENCE_GATEWAY_WS_URL: "wss://realtime.intelligence.copilotkit.ai",
  INTELLIGENCE_API_KEY: "test-project-key",
  OPENBOT_SINGLE_USER: "true",
};

test("Learning is optional at startup even if a revision was left behind", () => {
  expect(loadConfig(environment).learning).toBeUndefined();
  expect(
    loadConfig({ ...environment, CPK_INTELLIGENCE_SKILLS_REVISION: "old" })
      .learning,
  ).toBeUndefined();
});

test("an operator can seed a validated default and optional opaque revision", () => {
  expect(
    loadConfig({
      ...environment,
      CPK_INTELLIGENCE_LEARNING_CONTAINER_ID: " support-learning ",
      CPK_INTELLIGENCE_SKILLS_REVISION: "revision-1",
    }).learning,
  ).toEqual({ containerId: "support-learning", revision: "revision-1" });
  expect(() =>
    loadConfig({
      ...environment,
      CPK_INTELLIGENCE_LEARNING_CONTAINER_ID: "Bad--Id",
    }),
  ).toThrow("CPK_INTELLIGENCE_LEARNING_CONTAINER_ID");
});
