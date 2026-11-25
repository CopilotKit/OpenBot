import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Change,
  CI_RULES,
  DESKTOP_RULES,
  type Deps,
  decide,
  isBunTest,
  isCode,
  isDocs,
  isTestFile,
  type PullRequest,
  PYTHON_HARNESSES,
  SHARDS,
  SUITE_RULE,
} from "./ci-changes";

const ROOT = join(import.meta.dir, "..");

/** Every check a full CI run passes, by the job names the Actions API reports. */
const ALL_CI = [...CI_RULES, SUITE_RULE].flatMap((rule) => rule.checks);

const PR: PullRequest = {
  labels: [],
  headRef: "fix/a-thing",
  headRepository: "CopilotKit/OpenBot",
  repository: "CopilotKit/OpenBot",
  head: "c3",
  base: "main",
};

/**
 * A pull request's history: `c3` pushed, `c2` and `c1` its earlier pushes, `m0` the main commit it
 * branched from. `changes[sha]` is what changed from that commit to `c3`.
 */
function deps(options: {
  passed: Record<string, string[]>;
  changes: Record<string, string[]>;
  deleted?: string[];
  mentions?: Record<string, string[]>;
  files?: Record<string, string>;
  violations?: string[];
}): Deps {
  return {
    ancestors: () => ["c3", "c2", "c1", "m0"],
    passed: (sha) => new Set(options.passed[sha] ?? []),
    diff: (from): Change[] =>
      (options.changes[from] ?? []).map((path) => ({
        path,
        deleted: options.deleted?.includes(path) ?? false,
      })),
    mentions: (paths) => [
      ...new Set(paths.flatMap((path) => options.mentions?.[path] ?? [])),
    ],
    read: (path) => options.files?.[path] ?? "",
    releaseViolations: () => options.violations ?? [],
  };
}

const running = (decision: ReturnType<typeof decide>) =>
  Object.entries(decision.run)
    .filter(([, run]) => run)
    .map(([output]) => output)
    .sort();

describe("what a changed file is", () => {
  test("documents, tests and code, on paths from this tree", () => {
    for (const path of [
      "README.md",
      "CHANGELOG.md",
      "docs/ci.md",
      "docs/release/process.md",
      "desktop/TELEMETRY.md",
      ".claude/skills/openbot-copy/SKILL.md",
      "LICENSE",
    ]) {
      expect(isDocs(path)).toBe(true);
    }
    for (const path of [
      "app/tests/maths-rendering.test.tsx",
      "scripts/release-ci-gate.test.ts",
      "desktop/src/setupLayout.browser.test.ts",
      "agent-mastra/src/receiver.test.ts",
    ]) {
      expect(isBunTest(path)).toBe(true);
      expect(isCode(path)).toBe(false);
    }
    // Node's tests and the harnesses' pytest files are tests, but not the suite's.
    for (const path of [
      "agent-langgraph-ts/src/run.test.ts",
      "agent-crewai/tests/test_provider_boundary.py",
    ]) {
      expect(isBunTest(path)).toBe(false);
      expect(isTestFile(path)).toBe(true);
    }
    for (const path of [
      "app/src/lib/marks.ts",
      "release-policy.json",
      "package.json",
      "bun.lock",
      ".github/workflows/ci.yml",
      "app/tests/preload.ts",
      "app/tests/fixtures/composio-key-apps.json",
      "agent-crewai/src/agent.py",
    ]) {
      expect(isCode(path)).toBe(true);
    }
  });
});

describe("a pull request push", () => {
  test("one test file changed since a green push runs that test and the lint, nothing else", () => {
    const decision = decide(
      "ci",
      PR,
      deps({
        passed: { c2: ALL_CI, m0: ALL_CI },
        changes: { c2: ["app/tests/task-line.test.ts"] },
      }),
    );
    expect(running(decision)).toEqual(["partial", "static"]);
    expect(decision.tests).toEqual(["app/tests/task-line.test.ts"]);
  });

  test("a test fixed after a red push runs only that test when the rest passed there", () => {
    // c2 ran only its changed test and that failed; the suite last passed on c1.
    const others = ALL_CI.filter((name) => !SUITE_RULE.checks.includes(name));
    const decision = decide(
      "ci",
      PR,
      deps({
        passed: { c2: others, c1: ALL_CI },
        changes: {
          c2: ["app/tests/task-line.test.ts"],
          c1: ["app/tests/task-line.test.ts"],
        },
      }),
    );
    expect(running(decision)).toEqual(["partial", "static"]);
    expect(decision.tests).toEqual(["app/tests/task-line.test.ts"]);
  });

  test("a source change since the suite last passed runs the whole suite", () => {
    const decision = decide(
      "ci",
      PR,
      deps({
        passed: {
          c2: ALL_CI.filter((name) => !name.startsWith("tests (")),
          m0: ALL_CI,
        },
        changes: {
          c2: ["app/tests/task-line.test.ts"],
          m0: ["app/src/lib/task-line.ts", "app/tests/task-line.test.ts"],
        },
      }),
    );
    expect(decision.run.suite).toBe(true);
    expect(decision.run.partial).toBe(false);
  });

  test("an app change runs the app's jobs, not the native app, the TypeScript engine or the harnesses", () => {
    const decision = decide(
      "ci",
      PR,
      deps({
        passed: { c2: ALL_CI },
        changes: { c2: ["app/src/lib/marks.ts"] },
      }),
    );
    expect(running(decision)).toEqual([
      "api",
      "app_browser",
      "build",
      "startup",
      "static",
      "suite",
    ]);
  });

  test("a Recorder change runs the code jobs, not the native app, the TypeScript engine or the harnesses", () => {
    const decision = decide(
      "ci",
      PR,
      deps({
        passed: { c2: ALL_CI },
        changes: { c2: ["extension/src/background/offscreen-document.ts"] },
      }),
    );
    expect(running(decision)).toEqual([
      "api",
      "app_browser",
      "build",
      "startup",
      "static",
      "suite",
    ]);
  });

  test("docs only run nothing but the tests that name them", () => {
    const decision = decide(
      "ci",
      PR,
      deps({
        passed: { c2: ALL_CI },
        changes: { c2: ["docs/ci.md", "CHANGELOG.md"] },
        mentions: { "CHANGELOG.md": ["tests/release-policy.test.ts"] },
      }),
    );
    expect(running(decision)).toEqual(["partial"]);
    expect(decision.tests).toEqual(["tests/release-policy.test.ts"]);
  });

  test("a document nothing names runs nothing at all", () => {
    const decision = decide(
      "ci",
      PR,
      deps({ passed: { c2: ALL_CI }, changes: { c2: ["docs/ci.md"] } }),
    );
    expect(running(decision)).toEqual([]);
  });

  test("a job with no commit where it passed runs", () => {
    const decision = decide("ci", PR, deps({ passed: {}, changes: {} }));
    expect(running(decision)).toEqual(
      [...CI_RULES.map((rule) => rule.output), "suite"].sort(),
    );
  });

  test("a skipped job is not a pass: the walk goes on to where it last ran", () => {
    const decision = decide(
      "ci",
      PR,
      deps({
        // c2 skipped the harnesses; they last passed on m0, and the harness changed since.
        passed: {
          c2: ALL_CI.filter((name) => !name.startsWith("python harness (")),
          m0: ALL_CI,
        },
        changes: { c2: [], m0: ["agent-crewai/src/agent.py"] },
      }),
    );
    expect(decision.run.python_harness).toBe(true);
  });

  test("a harness test runs the harnesses, not the suite", () => {
    const decision = decide(
      "ci",
      PR,
      deps({
        passed: { c2: ALL_CI },
        changes: { c2: ["agent-crewai/tests/test_provider_boundary.py"] },
      }),
    );
    expect(running(decision)).toEqual(["python_harness", "static"]);
  });

  test("a TypeScript engine test runs that engine's job, not the suite", () => {
    const decision = decide(
      "ci",
      PR,
      deps({
        passed: { c2: ALL_CI },
        changes: { c2: ["agent-langgraph-ts/src/run.test.ts"] },
      }),
    );
    expect(running(decision)).toEqual(["langgraph_ts", "static"]);
    expect(decision.tests).toEqual([]);
  });

  test("a changed browser test runs in a browser, with WebKit when it asks for it", () => {
    const decision = decide(
      "ci",
      PR,
      deps({
        passed: { c2: ALL_CI },
        changes: {
          c2: [
            "app/tests/maths-rendering.test.tsx",
            "app/tests/composer-dictation-language.test.tsx",
            "desktop/src/setupLayout.browser.test.ts",
          ],
        },
        files: {
          "app/tests/maths-rendering.test.tsx":
            'const asked = process.env.OPENBOT_APP_BROWSER === "1";',
          "app/tests/composer-dictation-language.test.tsx":
            "process.env.OPENBOT_APP_BROWSER; process.env.OPENBOT_APP_ENGINES",
        },
      }),
    );
    expect(running(decision)).toEqual(["partial", "static"]);
    expect(decision.tests).toEqual([]);
    expect(decision.browserTests).toEqual([
      "app/tests/composer-dictation-language.test.tsx",
      "app/tests/maths-rendering.test.tsx",
    ]);
    expect(decision.webkitTests).toEqual([
      "app/tests/composer-dictation-language.test.tsx",
    ]);
    expect(decision.desktopBrowserTests).toEqual([
      "desktop/src/setupLayout.browser.test.ts",
    ]);
  });

  test("a deleted test is not run, a test that names it is", () => {
    const decision = decide(
      "ci",
      PR,
      deps({
        passed: { c2: ALL_CI },
        changes: { c2: ["tests/old.test.ts"] },
        deleted: ["tests/old.test.ts"],
        mentions: { "tests/old.test.ts": ["scripts/test-floor.test.ts"] },
      }),
    );
    expect(decision.tests).toEqual(["scripts/test-floor.test.ts"]);
  });

  test("a change to CI itself runs every job", () => {
    const decision = decide(
      "ci",
      PR,
      deps({
        passed: { c2: ALL_CI },
        changes: { c2: [".github/workflows/ci.yml"] },
      }),
    );
    expect(running(decision)).toEqual(
      [...CI_RULES.map((rule) => rule.output), "suite"].sort(),
    );
  });

  test("a path with a control character runs the job rather than being reasoned about", () => {
    const decision = decide(
      "ci",
      PR,
      deps({ passed: { c2: ALL_CI }, changes: { c2: ["docs/a\nb.md"] } }),
    );
    expect(decision.run.static).toBe(true);
    expect(decision.run.suite).toBe(true);
  });
});

describe("everything runs", () => {
  test("on any event but a pull request: main, the release's call, a schedule", () => {
    const decision = decide("ci", undefined, deps({ passed: {}, changes: {} }));
    expect(running(decision)).toEqual(
      [...CI_RULES.map((rule) => rule.output), "suite"].sort(),
    );
  });

  test("on a pull request labelled full-ci, even with nothing changed", () => {
    const decision = decide(
      "ci",
      { ...PR, labels: ["full-ci"] },
      deps({ passed: { c3: ALL_CI }, changes: { c3: [] } }),
    );
    expect(decision.run.suite).toBe(true);
    expect(decision.run.static).toBe(true);
  });
});

describe("a release PR", () => {
  // Release v1.1.2 (#1905): what Create release PR wrote.
  const RELEASE: PullRequest = {
    ...PR,
    labels: ["release"],
    headRef: "release/publish/v1.1.2",
  };
  const RELEASE_FILES = [
    "CHANGELOG.md",
    "backend-images.env",
    "desktop/src-tauri/Cargo.lock",
    "desktop/src-tauri/Cargo.toml",
    "package.json",
  ];
  const RELEASE_TESTS = [
    "scripts/release-ci-gate.test.ts",
    "tests/release-policy.test.ts",
  ];

  test("of only the release files runs the lint and the tests that read them", () => {
    const decision = decide(
      "ci",
      RELEASE,
      deps({
        passed: {},
        changes: { m0: RELEASE_FILES },
        mentions: {
          "CHANGELOG.md": RELEASE_TESTS,
          "release-policy.json": ["tests/release-policy.test.ts"],
        },
      }),
    );
    expect(running(decision)).toEqual(["partial", "static"]);
    expect(decision.tests).toEqual(RELEASE_TESTS);
  });

  test("builds no Desktop app", () => {
    const decision = decide(
      "desktop",
      RELEASE,
      deps({ passed: {}, changes: {} }),
    );
    expect(running(decision)).toEqual([]);
  });

  test("that changes more than the release files is checked like any pull request", () => {
    const decision = decide(
      "ci",
      RELEASE,
      deps({
        passed: {},
        changes: {},
        violations: ["app/src/lib/marks.ts is not a release file"],
      }),
    );
    expect(decision.run.suite).toBe(true);
    expect(decision.run.build).toBe(true);
  });

  test("from a fork, or unlabelled, is not one", () => {
    for (const pr of [
      { ...RELEASE, headRepository: "someone/OpenBot" },
      { ...RELEASE, labels: [] },
      { ...RELEASE, headRef: "release/publish/latest" },
    ]) {
      const decision = decide("ci", pr, deps({ passed: {}, changes: {} }));
      expect(decision.run.suite).toBe(true);
    }
  });
});

describe("the Desktop workflow", () => {
  const ALL_DESKTOP = DESKTOP_RULES.flatMap((rule) => rule.checks);

  test("a setup window test alone builds no app; a Rust change builds and lints", () => {
    const testOnly = decide(
      "desktop",
      PR,
      deps({
        passed: { c2: ALL_DESKTOP },
        changes: { c2: ["desktop/src/App.test.tsx"] },
      }),
    );
    expect(running(testOnly)).toEqual([]);
    const rust = decide(
      "desktop",
      PR,
      deps({
        passed: { c2: ALL_DESKTOP },
        changes: { c2: ["desktop/src-tauri/src/harness.rs"] },
      }),
    );
    expect(running(rust)).toEqual(["app", "core"]);
  });
});

/** A GitHub Actions expression, written so the linter does not read it as a template literal. */
const expression = (value: string) => ["$", "{{ ", value, " }}"].join("");

/** The job names a workflow's runs report, with the two matrix forms ci.yml uses expanded. */
function jobNames(workflow: string): string[] {
  const parsed = Bun.YAML.parse(
    readFileSync(join(ROOT, ".github/workflows", workflow), "utf8"),
  ) as {
    jobs: Record<
      string,
      {
        name?: string;
        uses?: string;
        strategy?: { matrix?: Record<string, unknown[]> };
      }
    >;
  };
  const names: string[] = [];
  for (const [id, job] of Object.entries(parsed.jobs)) {
    const name = job.name ?? id;
    const matrix = job.strategy?.matrix ?? {};
    const [key, values] = Object.entries(matrix)[0] ?? [];
    if (!key || !name.includes("${{")) {
      names.push(name);
      continue;
    }
    for (const value of values as unknown[]) {
      names.push(
        name
          .replace(expression(`matrix.${key}`), String(value))
          .replace(expression("strategy.job-total"), String(values?.length)),
      );
    }
  }
  return names;
}

describe("the rules name the jobs the workflows run", () => {
  test("ci.yml: every check a rule waits on is a job, and the shards are the matrix's", () => {
    const names = jobNames("ci.yml");
    for (const check of ALL_CI) expect(names).toContain(check);
    expect(
      names.filter((name) => name.startsWith("tests (shard")),
    ).toHaveLength(SHARDS);
  });

  test("ci.yml: the harness matrix is every harness with tests, and the rule waits on each", () => {
    const names = jobNames("ci.yml");
    const withTests = readdirSync(ROOT)
      .filter(
        (dir) =>
          dir.startsWith("agent-") &&
          existsSync(join(ROOT, dir, "requirements-test.txt")),
      )
      .sort();
    expect([...PYTHON_HARNESSES].sort()).toEqual(withTests);
    expect(names.filter((name) => name.startsWith("python harness ("))).toEqual(
      PYTHON_HARNESSES.map((harness) => `python harness (${harness})`),
    );
  });

  test("ci.yml: each real-browser job's Playwright image is the playwright-core the root pins", () => {
    // The image's browsers are the builds of its own Playwright version, and playwright-core
    // launches only its own builds, so a bump of one without the other fails the job.
    const parsed = Bun.YAML.parse(
      readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"),
    ) as { jobs: Record<string, { env?: Record<string, string> }> };
    const root = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const version = root.dependencies?.["playwright-core"];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const job of [
      "app-browser",
      "app-browser-webkit",
      "app-browser-desktop",
    ]) {
      expect(parsed.jobs[job]?.env?.PLAYWRIGHT_IMAGE ?? "").toMatch(
        new RegExp(
          `^mcr\\.microsoft\\.com/playwright:v${version?.replaceAll(".", "\\.")}-noble@sha256:[0-9a-f]{64}$`,
        ),
      );
    }
  });

  test("ci.yml: each real-browser job runs its files side by side, in one step", () => {
    // The WebKit job began with one file and no --parallel. Files were added to its list, and as
    // steps of their own, until it ran 30 files in two engines one after another: 35 minutes, the
    // whole length of a run. A run narrowed to some of a file's tests (-t) is the one exception.
    const parsed = Bun.YAML.parse(
      readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"),
    ) as { jobs: Record<string, { steps?: { run?: string }[] }> };
    for (const job of [
      "app-browser",
      "app-browser-webkit",
      "app-browser-desktop",
    ]) {
      const lists = (parsed.jobs[job]?.steps ?? [])
        .map((step) => step.run ?? "")
        .filter((run) => /\bbun test\b/.test(run) && !/\s-t\s/.test(run));
      expect({ job, steps: lists.length }).toEqual({ job, steps: 1 });
      const files = lists[0]?.match(/\S+\.test\.tsx?\b/g) ?? [];
      if (files.length > 1) {
        expect({
          job,
          parallel: /\bbun test --parallel\b/.test(lists[0] ?? ""),
        }).toEqual({
          job,
          parallel: true,
        });
      }
    }
  });

  test("desktop.yml: core, each platform the shared build makes, and the live tests beside them", () => {
    const names = jobNames("desktop.yml");
    expect(names).toContain("core");
    const parsed = Bun.YAML.parse(
      readFileSync(join(ROOT, ".github/workflows/desktop.yml"), "utf8"),
    ) as {
      jobs: {
        app: { with: { platforms: string } };
        live: { if: string };
      };
    };
    const platforms = JSON.parse(parsed.jobs.app.with.platforms) as string[];
    const live = names.filter((name) => name.startsWith("live ("));
    expect(live.length).toBeGreaterThan(0);
    expect(DESKTOP_RULES.find((rule) => rule.output === "app")?.checks).toEqual(
      [...platforms.map((platform) => `app / app (${platform})`), ...live],
    );
    // The live jobs stand on the app's gate, so a commit that skips the builds skips them too.
    expect(parsed.jobs.live.if).toBe("needs.changes.outputs.app == 'true'");
  });

  // The Docker regression tests moved out of the Linux build into desktop.yml's live jobs. Every
  // suite still runs, and runs once.
  test("desktop.yml's live jobs run every Docker regression suite once", () => {
    const parsed = Bun.YAML.parse(
      readFileSync(join(ROOT, ".github/workflows/desktop.yml"), "utf8"),
    ) as {
      jobs: {
        live: {
          strategy: { matrix: { suite: string[] } };
          steps: { if?: string; run?: string }[];
        };
      };
    };
    const { suite } = parsed.jobs.live.strategy.matrix;
    const runs = parsed.jobs.live.steps.filter((step) =>
      step.run?.includes("--ignored"),
    );
    expect(
      runs.map((step) => step.run?.match(/--lib (\S+) --/)?.[1]).sort(),
    ).toEqual([
      "ai_connection::tests::real_engine",
      "host_access::live",
      "local_eval::stack_lost_live::engine",
      "local_images::live",
      "netavark_rules::live",
      "update_ready::live",
    ]);
    for (const step of runs) {
      expect(suite.map((name) => `matrix.suite == '${name}'`)).toContain(
        step.if,
      );
    }
    for (const name of suite) {
      expect(runs.some((step) => step.if === `matrix.suite == '${name}'`)).toBe(
        true,
      );
    }
  });
});
