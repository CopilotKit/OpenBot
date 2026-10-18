import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RECORDER_EXTENSION_ID } from "../../shared/recorder-extension";

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
      "CHECK_ORIGIN",
      "PublicAppOrigin",
      "REALTIME_CHECK_ORIGIN",
      "LEARNING_RUNTIME_ENABLED",
      "Intelligence gap",
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
    expect(guide).toContain("Intelligence gaps");
    expect(guide).toContain("Known issue under investigation");
  });

  test("is linked from the docs index", () => {
    expect(index).toContain("recorder-company-install.md");
  });

  test("has no em dash", () => {
    expect(guide).not.toContain("—");
  });
});
