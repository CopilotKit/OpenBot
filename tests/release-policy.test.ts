import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseReleasePolicy } from "../scripts/release-manifest";
import candidate from "../shared/fixtures/releases/candidate.json";
import { releaseFiles } from "./support/release-files";

// The upgrade policy is reviewed with the release it describes: it lives in the tree, is read from
// the release commit, and is refused unless it names the version being released and the database
// transition its migrations actually make.

// The cases that read published release files package two charts with real `helm`, as
// release-charts.test.ts does. On a fresh GitHub-hosted runner the first `helm package` calls take
// several seconds (ubuntu-26.04 image 20261122: over five each, then a fraction of a second), which
// the default five-second limit stopped, failing the release gate of every release.
setDefaultTimeout(30_000);

const root = join(import.meta.dir, "..");
const cli = join(root, "scripts/release-manifest.ts");
const policy = JSON.parse(
  readFileSync(join(root, "release-policy.json"), "utf8"),
);
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function validate(cwd: string, env: Record<string, string>) {
  const run = Bun.spawnSync([process.execPath, cli, "--validate-policy"], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, output: `${run.stdout}${run.stderr}` };
}
function commit(repo: string, message: string) {
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=Release Test",
    "-c",
    "user.email=release@example.test",
    "commit",
    "-m",
    message,
  );
}
/** A Drizzle journal whose last migration is the given tag. */
function journal(repo: string, last: string) {
  mkdirSync(join(repo, "server/drizzle/meta"), { recursive: true });
  writeFileSync(
    join(repo, "server/drizzle/meta/_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: ["0000_schema", last].map((tag, idx) => ({
        idx,
        version: "7",
        when: 1786891733850 + idx,
        tag,
        breakpoints: true,
      })),
    }),
  );
}
/**
 * The upstream repository publishing a release: earlier releases tagged with the last migration
 * each shipped, then the release commit with its own last migration and the given policy. By
 * default the fixture's migrations are the ones the committed policy names, so writing the next
 * release's policy never breaks these tests.
 */
function publisher(
  committed: unknown,
  {
    // `null` is a release whose tree carries no migrations: its server is a published image.
    tags = { "v0.3.0": policy.compatibility.database.from[0] } as Record<
      string,
      string | null
    >,
    migration = policy.compatibility.database.to as string | null,
  } = {},
) {
  const repo = mkdtempSync(join(tmpdir(), "openbot-policy-"));
  directories.push(repo);
  git(repo, "init", "-b", "main");
  const tree = (last: string | null) =>
    last === null
      ? rmSync(join(repo, "server"), { recursive: true, force: true })
      : journal(repo, last);
  for (const [version, last] of Object.entries(tags)) {
    tree(last);
    writeFileSync(join(repo, "core.txt"), `${version}\n`);
    commit(repo, version);
    git(repo, "tag", version);
  }
  tree(migration);
  writeFileSync(join(repo, "core.txt"), "release\n");
  if (committed !== undefined)
    writeFileSync(
      join(repo, "release-policy.json"),
      `${JSON.stringify(committed, null, 2)}\n`,
    );
  commit(repo, "release");
  return {
    repo,
    env: {
      GITHUB_REPOSITORY: "CopilotKit/OpenBot",
      GITHUB_SHA: git(repo, "rev-parse", "HEAD"),
      VERSION: "v0.4.0",
    },
  };
}
// The fixture's starting releases all ship the policy's first starting database, so the policy it
// writes starts from that one alone. The committed policy can list more than one (a release that
// upgrades from several releases with different last migrations), and copied whole it would name a
// starting database no fixture release has.
const forVersion = (version: string, fromVersions = ["v0.3.0"]) => ({
  ...policy,
  version,
  compatibility: {
    ...policy.compatibility,
    database: {
      ...policy.compatibility.database,
      from: [policy.compatibility.database.from[0]],
    },
  },
  upgrade: { ...policy.upgrade, fromVersions },
});

describe("release policy", () => {
  // Its database transition is checked at release time, against the release commit and tags. A
  // test against this tree would fail every pull request that adds a migration, and CI's shallow
  // checkout has no tags, so here it is held to everything else.
  test("the committed policy is a valid policy for the version it names", () => {
    expect(() => parseReleasePolicy(policy, policy.version)).not.toThrow();
  });

  test("the committed policy is for this release or the next one, never an earlier one", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(
      Bun.semver.order(policy.version, `v${pkg.version}`),
    ).toBeGreaterThanOrEqual(0);
    expect(policy.upgrade.fromVersions.length).toBeGreaterThan(0);
  });

  test("the committed policy names its schema, and the schema's references resolve", () => {
    const schemaPath = join(root, policy.$schema);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    expect(schema.required).toEqual(["version", "compatibility", "upgrade"]);
    const refs = JSON.stringify(schema).match(/"\$ref":"([^"]+)"/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const [file, pointer] = ref.slice(8, -1).split("#");
      const target = JSON.parse(
        readFileSync(join(dirname(schemaPath), file!), "utf8"),
      );
      const resolved = pointer!
        .split("/")
        .slice(1)
        .reduce((node, key) => node?.[key], target);
      expect(resolved).toBeDefined();
    }
  });

  test("a policy left over from the previous release is refused, and says why", () => {
    const { repo, env } = publisher(forVersion("v0.3.0", ["v0.2.0"]));
    const result = validate(repo, env);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(
      'release-policy.json describes "v0.3.0", but this release is v0.4.0',
    );
  });

  test("a policy written for this release passes", () => {
    const { repo, env } = publisher(forVersion("v0.4.0"));
    expect(validate(repo, env)).toEqual({
      exitCode: 0,
      output: expect.stringContaining("describes v0.4.0"),
    });
  });

  test("a migration that landed after the policy was written stops the release, naming the fix", () => {
    const { repo, env } = publisher(forVersion("v0.4.0"), {
      migration: "0075_later_migration",
    });
    const result = validate(repo, env);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(
      'Set compatibility.database.to to "0075_later_migration".',
    );
  });

  test("a starting database other than the one its starting release shipped stops the release", () => {
    const { repo, env } = publisher(forVersion("v0.4.0"), {
      tags: { "v0.3.0": "0060_shipped_in_v0_3_0" },
    });
    const result = validate(repo, env);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(
      'Set compatibility.database.from to ["0060_shipped_in_v0_3_0"].',
    );
  });

  test("every starting release needs its own database, read at its tag", () => {
    const { repo, env } = publisher(
      forVersion("v0.4.0", ["v0.2.0", "v0.3.0"]),
      {
        tags: { "v0.2.0": "0040_older", "v0.3.0": "0053_identity_links" },
      },
    );
    const result = validate(repo, env);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(
      'Set compatibility.database.from to ["0040_older","0053_identity_links"].',
    );
  });

  test("a starting release with no tag stops the release", () => {
    const { repo, env } = publisher(forVersion("v0.4.0", ["v0.3.0", "v0.3.1"]));
    const result = validate(repo, env);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("has no v0.3.1 tag");
  });

  test("two starting releases on the same migration name it once", () => {
    const { repo, env } = publisher(
      forVersion("v0.4.0", ["v0.3.0", "v0.3.1"]),
      {
        // Both on the migration the committed policy starts from, whichever release that is.
        tags: {
          "v0.3.0": policy.compatibility.database.from[0],
          "v0.3.1": policy.compatibility.database.from[0],
        },
      },
    );
    expect(validate(repo, env).exitCode).toBe(0);
  });

  /**
   * The server ships as a published image, so the release commit has no migrations of its own to
   * read. `verify` used to stop every such release: "has no server/drizzle/meta/_journal.json".
   * The database it migrates to is the one its OpenBot images published beside them.
   */
  describe("a release whose tree carries no migrations", () => {
    const to = policy.compatibility.database.to;
    /**
     * By default the chart does what the committed policy declares, as a release's chart must.
     * `"absent"` is a chart from before the `openbot.ai/requires-downtime` annotation.
     */
    function published(
      database: string,
      version = "v0.4.0",
      downtime: boolean | "absent" = policy.upgrade.requiresDowntime,
    ) {
      const files = releaseFiles({
        version,
        database,
        ...(downtime === "absent" ? {} : { requiresDowntime: downtime }),
      });
      directories.push(dirname(files));
      return files;
    }
    /** A folder holding the release manifest an earlier release attached, as `<version>.json`. */
    function manifests(databases: Record<string, string>) {
      const directory = mkdtempSync(join(tmpdir(), "openbot-manifests-"));
      directories.push(directory);
      for (const [version, database] of Object.entries(databases))
        writeFileSync(
          join(directory, `${version}.json`),
          JSON.stringify({
            ...candidate,
            version,
            compatibility: {
              ...candidate.compatibility,
              database: { from: [], to: database, rollbackCompatible: true },
            },
          }),
        );
      return directory;
    }

    test("passes on the database its OpenBot images published", () => {
      const { repo, env } = publisher(forVersion("v0.4.0"), {
        migration: null,
      });
      expect(
        validate(repo, { ...env, OPENBOT_RELEASE_FILES: published(to) }),
      ).toEqual({
        exitCode: 0,
        output: expect.stringContaining("describes v0.4.0"),
      });
    });

    test("stops on a migration its images apply that the policy does not name, naming the fix", () => {
      const { repo, env } = publisher(forVersion("v0.4.0"), {
        migration: null,
      });
      const result = validate(repo, {
        ...env,
        OPENBOT_RELEASE_FILES: published("0099_shipped_in_the_image"),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain(
        "the published OpenBot images of this release apply",
      );
      expect(result.output).toContain(
        'Set compatibility.database.to to "0099_shipped_in_the_image".',
      );
    });

    test("refuses release files published for another version", () => {
      const { repo, env } = publisher(forVersion("v0.4.0"), {
        migration: null,
      });
      const result = validate(repo, {
        ...env,
        OPENBOT_RELEASE_FILES: published(to, "v0.3.9"),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain(
        'openbot-release.json is for "v0.3.9", but this release is v0.4.0',
      );
    });

    test("says what to fetch when nothing names its database", () => {
      const { repo, env } = publisher(forVersion("v0.4.0"), {
        migration: null,
      });
      const result = validate(repo, env);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain(
        "Nothing says which database this release migrates to",
      );
      expect(result.output).toContain("scripts/release-files.sh");
    });

    test("reads a starting release with no migrations at its tag from the manifest it attached", () => {
      const from = policy.compatibility.database.from[0];
      const { repo, env } = publisher(
        forVersion("v0.4.0", ["v0.3.0", "v0.3.1"]),
        { tags: { "v0.3.0": from, "v0.3.1": null }, migration: null },
      );
      const files = published(to);
      const without = validate(repo, { ...env, OPENBOT_RELEASE_FILES: files });
      expect(without.exitCode).not.toBe(0);
      expect(without.output).toContain(
        "nothing says which database v0.3.1 left",
      );
      expect(
        validate(repo, {
          ...env,
          OPENBOT_RELEASE_FILES: files,
          OPENBOT_RELEASE_MANIFESTS: manifests({ "v0.3.1": from }),
        }).exitCode,
      ).toBe(0);
      // The manifest is evidence, not permission: another database in it stops the release.
      const other = validate(repo, {
        ...env,
        OPENBOT_RELEASE_FILES: files,
        OPENBOT_RELEASE_MANIFESTS: manifests({ "v0.3.1": "0061_other" }),
      });
      expect(other.exitCode).not.toBe(0);
      expect(other.output).toContain("0061_other");
    });

    /**
     * The policy's downtime is what the release's chart does, not a note beside it. 1.1.0 declared
     * downtime while its chart upgraded the servers one by one, so a plain `helm upgrade` ran old and
     * new servers on a database the old could not read. The chart now stops every old server first
     * when its Chart.yaml declares `openbot.ai/requires-downtime: "true"`, and the release is held to
     * the two agreeing.
     */
    describe("downtime", () => {
      const declaring = (requiresDowntime: boolean) => {
        const written = forVersion("v0.4.0");
        return publisher(
          { ...written, upgrade: { ...written.upgrade, requiresDowntime } },
          { migration: null },
        );
      };

      test("a policy that declares downtime beside a chart that rolls is refused, naming both fixes", () => {
        const { repo, env } = declaring(true);
        const result = validate(repo, {
          ...env,
          OPENBOT_RELEASE_FILES: published(to, "v0.4.0", false),
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.output).toContain(
          "release-policy.json says this release requires downtime, but the openbot chart it attaches upgrades its servers one by one",
        );
        expect(result.output).toContain(
          "set upgrade.requiresDowntime to false in release-policy.json",
        );
      });

      test("a policy that declares no downtime beside a chart that stops every server is refused", () => {
        const { repo, env } = declaring(false);
        const result = validate(repo, {
          ...env,
          OPENBOT_RELEASE_FILES: published(to, "v0.4.0", true),
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.output).toContain(
          "release-policy.json says this release needs no downtime, but the openbot chart it attaches stops every old server",
        );
      });

      test("a chart that declares downtime under a policy that does passes", () => {
        const { repo, env } = declaring(true);
        expect(
          validate(repo, {
            ...env,
            OPENBOT_RELEASE_FILES: published(to, "v0.4.0", true),
          }).exitCode,
        ).toBe(0);
      });

      test("a chart from before the annotation rolls, so it passes under a policy with no downtime", () => {
        const { repo, env } = declaring(false);
        expect(
          validate(repo, {
            ...env,
            OPENBOT_RELEASE_FILES: published(to, "v0.4.0", "absent"),
          }),
        ).toEqual({
          exitCode: 0,
          output: expect.stringContaining("describes v0.4.0"),
        });
        const { repo: other, env: otherEnv } = declaring(true);
        expect(
          validate(other, {
            ...otherEnv,
            OPENBOT_RELEASE_FILES: published(to, "v0.4.0", "absent"),
          }).exitCode,
        ).not.toBe(0);
      });
    });
  });

  test("a repository variable cannot stand in for the committed policy", () => {
    const { repo, env } = publisher(forVersion("v0.3.0", ["v0.2.0"]));
    const result = validate(repo, {
      ...env,
      OPENBOT_RELEASE_POLICY: JSON.stringify(forVersion("v0.4.0")),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('describes "v0.3.0"');
  });

  test("the policy is read from the release commit, not the working tree", () => {
    const { repo, env } = publisher(forVersion("v0.3.0", ["v0.2.0"]));
    writeFileSync(
      join(repo, "release-policy.json"),
      JSON.stringify(forVersion("v0.4.0")),
    );
    const result = validate(repo, env);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(
      'release-policy.json describes "v0.3.0", but this release is v0.4.0',
    );
  });

  test("a release commit without a policy is refused", () => {
    const { repo, env } = publisher(undefined);
    expect(existsSync(join(repo, "release-policy.json"))).toBe(false);
    const result = validate(repo, env);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("has no release-policy.json");
  });

  test.each([
    [
      "names this version as a starting version",
      forVersion("v0.4.0", ["v0.4.0"]),
      "is not earlier than v0.4.0",
    ],
    [
      "names a later starting version",
      forVersion("v0.4.0", ["v0.5.0"]),
      "is not earlier than v0.4.0",
    ],
    [
      "names something that is not a release",
      forVersion("v0.4.0", ["latest"]),
      "is not a release version",
    ],
    [
      "carries an unknown field",
      { ...forVersion("v0.4.0"), notes: "x" },
      "unsupported fields: notes",
    ],
    [
      "promises a restart onto a database the previous release cannot read",
      {
        ...forVersion("v0.4.0"),
        upgrade: {
          ...forVersion("v0.4.0").upgrade,
          recovery: "restart-previous",
        },
      },
      "incompatible database requires restore-backup",
    ],
  ])("refuses a policy that %s", (_name, committed, reason) => {
    const { repo, env } = publisher(committed);
    const result = validate(repo, env);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(reason);
  });
});
