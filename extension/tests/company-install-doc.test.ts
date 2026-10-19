import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";

const root = join(import.meta.dir, "..", "..");
const guide = readFileSync(
  join(root, "docs", "recorder-company-install.md"),
  "utf8",
);
const index = readFileSync(join(root, "docs", "README.md"), "utf8");

/** The text of the first `## ` section, heading included. */
function firstSection(markdown: string): string {
  const [, rest = ""] = markdown.split(/^## /m);
  return `## ${rest.split(/^## /m)[0]}`;
}

describe("the company-install guide", () => {
  test("opens with the Intelligence settings capture needs", () => {
    const section = firstSection(guide);
    const heading = section.split("\n")[0];
    expect(heading).toContain("Intelligence");
    for (const term of [
      "trajectories",
      "FF_LEARNING_TRAJECTORIES",
      "INTELLIGENCE_GATEWAY_WS_URL",
      "CHECK_ORIGIN",
      "LEARNING_RUNTIME_ENABLED",
      `chrome-extension://${RECORDER_EXTENSION_ID}`,
    ]) {
      expect(section).toContain(term);
    }
  });

  test("names the force-install policy, the packing flag and the id", () => {
    expect(guide).toContain("ExtensionInstallForcelist");
    expect(guide).toContain("--pack-extension");
    expect(guide).toContain(RECORDER_EXTENSION_ID);
  });

  test("states what has been tested and what has not", () => {
    expect(guide).toContain("What has been tested and what has not");
  });

  // A public guide for IT teams: Intelligence's own source files, commits, gaps lists and open bugs are not theirs.
  test("names no Intelligence internals", () => {
    for (const internal of [
      /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/, // a commit
      /\.exs?\b/,
      /cloudformation|release\.yaml|values[-.][a-z-]*\.yaml|install\.sh/i,
      /\b(?:apps|charts|deploy)\//,
      /Intelligence gaps?/i,
      /Known issue/i,
      /Intelligence team/i,
    ]) {
      expect(guide).not.toMatch(internal);
    }
  });

  test("tells IT to confirm the policy reached the browser, since Chrome withholds a value of the wrong type", () => {
    expect(guide).toContain("chrome://policy");
    expect(guide).toMatch(/status OK/);
    expect(guide).toMatch(/wrong type never reaches the Recorder/);
    expect(guide).toMatch(/which means no restriction/);
    expect(guide).toMatch(/one address on its own/);
    expect(guide).not.toMatch(/refused, never ignored/);
  });

  test("covers the native messaging host OpenBot Desktop registers per person", () => {
    for (const term of [
      "ai.copilotkit.openbot.recorder",
      "NativeMessagingAllowlist",
      "NativeMessagingBlocklist",
      "NativeMessagingUserLevelHosts",
      "/etc/opt/chrome/native-messaging-hosts/",
      "HKLM\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts",
      `"allowed_origins": ["chrome-extension://${RECORDER_EXTENSION_ID}/"]`,
    ]) {
      expect(guide).toContain(term);
    }
  });

  test("is linked from the docs index", () => {
    expect(index).toContain("recorder-company-install.md");
  });

  test("describes only what the Recorder records now: no screen, sound or transcription", () => {
    for (const removed of [
      /screen/i,
      /voice|audio|sound|microphone/i,
      /transcri/i,
    ]) {
      expect(guide).not.toMatch(removed);
    }
  });

  test("has no em dash", () => {
    expect(guide).not.toContain("—");
  });
});
