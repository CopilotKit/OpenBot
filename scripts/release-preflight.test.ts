/**
 * The Release workflow's preflight, on the inputs that broke releases by hand: server images built
 * from an OpenBot commit whose policy was still the previous release's, a server tree still
 * saying the previous version, a chart left at a candidate's appVersion, and notes that were not
 * there. Each must be refused before anything is built, and the inputs 1.1.2 finally shipped with
 * must pass.
 */
import { expect, test } from "bun:test";
import {
  changelogSection,
  notesProblems,
  policyProblems,
  previousStable,
  versionProblems,
} from "./release-preflight";
import fixture from "./release-preflight.fixture.json";

const PIN = "OpenBot 198f3cb0a353, which the server images are built from,";

test("the previous release is the newest stable tag below the one being cut", () => {
  expect(previousStable(fixture.tags, "1.1.2")).toBe("v1.1.1");
  expect(previousStable(fixture.tags, "1.1.2-rc.1")).toBe("v1.1.1");
  // A final's previous release is the stable one before its candidates, never a candidate.
  expect(previousStable(fixture.tags, "1.1.1")).toBe("v1.1.0");
  expect(previousStable(fixture.tags, "1.2.0")).toBe("v1.1.1");
  expect(previousStable([], "0.0.1")).toBeUndefined();
});

test("server images built from a commit whose policy is the previous release's are refused", () => {
  // 1.1.2's server images were first built from 198f3cb0a, whose policy said v1.1.1 and did not
  // upgrade from v1.1.1. The release window check found it an hour and a half in.
  const problems = policyProblems(
    PIN,
    fixture.staleInterimPolicy,
    "1.1.2",
    "v1.1.1",
  );
  expect(problems).toHaveLength(2);
  expect(problems[0]).toContain("written for v1.1.1, not v1.1.2");
  expect(problems[0]).toContain(PIN);
  expect(problems[1]).toContain("leaves out v1.1.1");
});

test("the policy 1.1.2 shipped with passes, for its candidate and for its final", () => {
  expect(policyProblems(PIN, fixture.policyFor112, "1.1.2", "v1.1.1")).toEqual(
    [],
  );
  expect(
    policyProblems(PIN, fixture.policyFor112, "1.1.2-rc.1", "v1.1.1"),
  ).toEqual([]);
  // A candidate's policy, moved along by Create release PR, still counts for its final.
  const candidate = { ...fixture.policyFor112, version: "v1.1.2-rc.2" };
  expect(policyProblems(PIN, candidate, "1.1.2", "v1.1.1")).toEqual([]);
});

test("the 1.1.2 policy is refused for the next release", () => {
  const problems = policyProblems(PIN, fixture.policyFor112, "1.1.3", "v1.1.2");
  expect(problems.join("\n")).toContain("written for v1.1.2, not v1.1.3");
  expect(problems.join("\n")).toContain("leaves out v1.1.2");
});

test("a missing policy, or one with no upgrade list, is refused", () => {
  expect(policyProblems(PIN, undefined, "1.1.2", "v1.1.1")[0]).toContain(
    "has no release-policy.json",
  );
  expect(
    policyProblems(PIN, { version: "v1.1.2" }, "1.1.2", "v1.1.1")[0],
  ).toContain("no upgrade.fromVersions");
});

const CHARTS_112 = {
  openbot: "1.1.2",
  "openbot-bundle": "1.1.2",
  "openbot-agent": "1.1.2",
};

test("a server tree still on an older release than OpenBot is refused", () => {
  // The shape of 1.1.1's server images: built from a tree that still said 1.1.0.
  const problems = versionProblems(
    {
      openbot: "1.1.1",
      server: "1.1.0",
      charts: {
        openbot: "1.1.0",
        "openbot-bundle": "1.1.0",
        "openbot-agent": "1.1.0",
      },
    },
    "1.1.2",
  );
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("package.json says 1.1.0");
  expect(problems[0]).toContain("OpenBot's says 1.1.1");
});

test("a chart left at a candidate's appVersion is refused", () => {
  // 1.1.1 published the openbot-agent chart still saying 1.1.1-rc.1.
  const problems = versionProblems(
    {
      openbot: "1.1.0",
      server: "1.1.1",
      charts: {
        openbot: "1.1.1",
        "openbot-bundle": "1.1.1",
        "openbot-agent": "1.1.1-rc.1",
      },
    },
    "1.1.1",
  );
  expect(problems).toEqual([
    expect.stringContaining(
      "The openbot-agent chart's appVersion is 1.1.1-rc.1",
    ),
  ]);
});

test("versions that agree pass, before the bump and after it", () => {
  // Both still on the last release.
  expect(
    versionProblems(
      {
        openbot: "1.1.1",
        server: "1.1.1",
        charts: {
          openbot: "1.1.1",
          "openbot-bundle": "1.1.1",
          "openbot-agent": "1.1.1",
        },
      },
      "1.1.2",
    ),
  ).toEqual([]);
  // The server images already moved to the release, as a run started again finds them.
  expect(
    versionProblems(
      { openbot: "1.1.1", server: "1.1.2", charts: CHARTS_112 },
      "1.1.2",
    ),
  ).toEqual([]);
});

// The head of CHANGELOG.md on main as 1.1.2 was being cut.
const CHANGELOG = `# Changelog

Newest first. \`Unreleased\` is what is on \`main\` and not yet tagged.

## Unreleased

### OpenBot Desktop

- **Install on a computer with an earlier OpenBot install** sets up the software OpenBot runs on
  again when it is gone.

## 1.1.1

**Before upgrading.** Read these first.
`;

test("notes under Unreleased pass", () => {
  expect(notesProblems(CHANGELOG, "1.1.2")).toEqual([]);
  expect(changelogSection(CHANGELOG, "Unreleased")).toContain(
    "Install on a computer",
  );
});

test("an empty Unreleased section is refused", () => {
  const promoted = CHANGELOG.replace(
    "## Unreleased\n",
    "## Unreleased\n\n## 1.1.2\n",
  );
  const problems = notesProblems(promoted, "1.1.2");
  expect(problems).toHaveLength(2);
  expect(problems[0]).toContain("nothing under ## Unreleased");
  expect(problems[1]).toContain("already has a ## 1.1.2 section");
});

test("a changelog with no Unreleased section is refused", () => {
  const without = CHANGELOG.replace("## Unreleased\n", "");
  expect(notesProblems(without, "1.1.2")[0]).toContain(
    "no ## Unreleased section",
  );
});
