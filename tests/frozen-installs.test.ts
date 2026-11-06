import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Every `bun install` that CI or an image runs installs from a lockfile.
 *
 * The Mastra Bot had none: its CI step and its Dockerfile ran a plain `bun install` against
 * `"*"` ranges, so every run resolved the registry afresh. CI failed the day a dependency's new
 * release was still reaching npm's CDN (a 404 for a version minutes old), and the Bot's image
 * could ship different code from one build to the next with nothing in the tree changed.
 *
 * `--frozen-lockfile` alone does not hold this. With no `bun.lock` beside the package.json, Bun
 * resolves freshly and exits 0, so the lockfile's presence is checked too: in the directory a CI
 * step installs in, and as a COPY ahead of the install in a Dockerfile.
 */

const root = join(import.meta.dir, "..");

type Step = { run?: string; "working-directory"?: string };
type Workflow = {
  jobs?: Record<
    string,
    { steps?: Step[]; strategy?: { matrix?: Record<string, unknown> } }
  >;
};

/** A step's directory, once per value its job's matrix gives `${{ matrix.<key> }}`. */
function expandMatrix(
  dir: string,
  matrix: Record<string, unknown> = {},
): string[] {
  const key = dir.match(/\$\{\{\s*matrix\.(\w+)\s*\}\}/)?.[1];
  if (!key) return [dir];
  const values = matrix[key];
  if (!Array.isArray(values)) return [dir];
  return values.map((value) => dir.replace(/\$\{\{[^}]*\}\}/, String(value)));
}

function workflowInstalls() {
  const dir = join(root, ".github/workflows");
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .flatMap((name) => {
      const workflow = Bun.YAML.parse(
        readFileSync(join(dir, name), "utf8"),
      ) as Workflow;
      return Object.entries(workflow.jobs ?? {}).flatMap(
        ([job, { steps, strategy }]) =>
          (steps ?? []).flatMap((step) =>
            (step.run ?? "")
              .split("\n")
              .filter((line) => /\bbun install\b/.test(line))
              .flatMap((line) =>
                expandMatrix(
                  line.match(/\bcd\s+(\S+)\s*&&/)?.[1] ??
                    step["working-directory"] ??
                    ".",
                  strategy?.matrix,
                ).map((cwd) => ({
                  where: `${name} ${job} (${cwd}): ${line.trim()}`,
                  line,
                  cwd,
                })),
              ),
          ),
      );
    });
}

function dockerfiles(dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return dockerfiles(path);
    return /^Dockerfile/.test(entry.name) ? [path] : [];
  });
}

function dockerInstalls() {
  return dockerfiles().flatMap((path) => {
    const lines = readFileSync(path, "utf8").split("\n");
    return lines.flatMap((line, index) => {
      if (!/^RUN\b.*\bbun install\b/.test(line)) return [];
      const dir = line.match(/\bcd\s+(\S+)\s*&&/)?.[1];
      const lock = dir ? `${dir}/bun.lock` : "bun.lock";
      return [
        {
          where: `${path.slice(root.length + 1)}:${index + 1}: ${line.trim()}`,
          line,
          copiesLock: lines
            .slice(0, index)
            .some((before) => /^COPY\b/.test(before) && before.includes(lock)),
        },
      ];
    });
  });
}

describe("bun installs come from a lockfile", () => {
  test("CI finds installs to check", () => {
    // A parser that matched nothing would pass every assertion below.
    expect(workflowInstalls().length).toBeGreaterThan(5);
    expect(dockerInstalls().length).toBeGreaterThan(5);
  });

  test("every CI install is frozen, in a directory with a bun.lock", () => {
    const loose = workflowInstalls().filter(
      ({ line, cwd }) =>
        !line.includes("--frozen-lockfile") ||
        !existsSync(join(root, cwd, "bun.lock")),
    );
    expect(loose.map(({ where }) => where)).toEqual([]);
  });

  test("every Dockerfile install is frozen, after a COPY of its bun.lock", () => {
    const loose = dockerInstalls().filter(
      ({ line, copiesLock }) =>
        !line.includes("--frozen-lockfile") || !copiesLock,
    );
    expect(loose.map(({ where }) => where)).toEqual([]);
  });
});
