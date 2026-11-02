import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config";

const environment = {
  DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:5432/openbot",
  KEY_ENCRYPTION_KEY: "b3BlbmJvdC1wcm9kdWN0aW9uLXRlc3Qta2V5LTMyMzI=",
  INTELLIGENCE_API_URL: "https://api.intelligence.copilotkit.ai",
  INTELLIGENCE_GATEWAY_WS_URL: "wss://realtime.intelligence.copilotkit.ai",
  INTELLIGENCE_API_KEY: "test-project-key",
  OPENBOT_SINGLE_USER: "true",
};

const first = "a".repeat(32);
const second = "abcdefghijklmnopabcdefghijklmnop";

test("a valid extra extension id parses", () => {
  expect(
    loadConfig({ ...environment, OPENBOT_RECORDER_EXTRA_EXTENSION_IDS: first })
      .recorder,
  ).toEqual({ extraExtensionIds: [first] });
});

test("an id that is not 32 letters a to p refuses boot and names the value", () => {
  expect(() =>
    loadConfig({ ...environment, OPENBOT_RECORDER_EXTRA_EXTENSION_IDS: "abc" }),
  ).toThrow("abc");
  expect(() =>
    loadConfig({
      ...environment,
      OPENBOT_RECORDER_EXTRA_EXTENSION_IDS: `${first},${"z".repeat(32)}`,
    }),
  ).toThrow("z".repeat(32));
});

test("ids with spaces after the comma are each trimmed", () => {
  expect(
    loadConfig({
      ...environment,
      OPENBOT_RECORDER_EXTRA_EXTENSION_IDS: `${first}, ${second} `,
    }).recorder,
  ).toEqual({ extraExtensionIds: [first, second] });
});

test("unset gives no extra ids", () => {
  expect(loadConfig(environment).recorder).toEqual({ extraExtensionIds: [] });
});

test("the example environment and the changelog name the variable and that a bad value stops boot", () => {
  const example = readFileSync(
    new URL("../../.env.example", import.meta.url),
    "utf8",
  );
  expect(example).toContain("# OPENBOT_RECORDER_EXTRA_EXTENSION_IDS=");
  expect(example).toMatch(/Any\s+other value stops the server at boot/);
  const [unreleased = ""] = readFileSync(
    new URL("../../CHANGELOG.md", import.meta.url),
    "utf8",
  )
    .split("## Unreleased")[1]
    ?.split(/^## /m) ?? [""];
  for (const term of [
    "0066_recorder_extension",
    "OPENBOT_RECORDER_EXTRA_EXTENSION_IDS",
    "stops the server at boot",
    "Settings → Browsers",
    "1.79.1",
    "COPILOTKIT_OPENAI_API=responses",
  ]) {
    expect(unreleased).toContain(term);
  }
});
