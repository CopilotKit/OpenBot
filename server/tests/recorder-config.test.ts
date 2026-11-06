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
  // Everything written since 0.2.0: `## Unreleased` until the release workflow promotes it, then the
  // release's own section. Reading `## Unreleased` alone fails on the release commit, where it is
  // empty, and that commit's checks gate the publish.
  const changelog = readFileSync(
    new URL("../../CHANGELOG.md", import.meta.url),
    "utf8",
  );
  const notes = changelog.slice(
    changelog.indexOf("## Unreleased"),
    changelog.search(/^## 0\.2\.0$/m),
  );
  const runtime = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).dependencies["@copilotkit/runtime"];
  for (const term of [
    "0066_recorder_extension",
    "OPENBOT_RECORDER_EXTRA_EXTENSION_IDS",
    "stops the server at boot",
    "Settings → Browsers",
    `CopilotKit ${runtime}`,
    "COPILOTKIT_OPENAI_API=responses",
  ]) {
    expect(notes).toContain(term);
  }
});
