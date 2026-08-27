/**
 * Every values key this release adds has to survive being absent.
 *
 * `helm upgrade --reuse-values` takes the previous release's computed values rather than merging the
 * new chart's defaults, so a key introduced by the release being installed is simply missing on every
 * deployment that already exists. Reached unguarded that is a nil dereference, and because the
 * helpers are included by the server deployment it fails the WHOLE render: the upgrade does not lose
 * the new feature, it does not install. Emitted unguarded it writes an empty scalar, which is null,
 * which Kubernetes reads as unset — a value that silently stops applying on exactly the deployments
 * old enough to need it.
 *
 * Both shipped. `config.handoff` was found in review; `routines` was found by this script's absence,
 * on a live upgrade, after the same fault had been fixed one key over. So the list of keys to check
 * is not a list anybody maintains: it is whatever this release added that the last one did not.
 *
 *     bun scripts/check-new-values-keys.ts <ci-values.yaml> [--since v0.0.4]
 */
import { parse } from "yaml";

const [valuesFile, ...rest] = process.argv.slice(2);
if (!valuesFile) {
  console.error(
    "Usage: bun scripts/check-new-values-keys.ts <ci-values.yaml> [--since <ref>]",
  );
  process.exit(2);
}
const sinceFlag = rest.indexOf("--since");
const since = sinceFlag === -1 ? await lastReleaseTag() : rest[sinceFlag + 1];

/**
 * What an existing deployment would already have in its stored values.
 *
 * The newest release whose tree actually contains the chart, because that is the oldest thing
 * somebody could be upgrading FROM. The chart has not been released yet, so today that is nothing
 * and this falls back to `origin/main`: a key this branch adds on top of what is already merged.
 * Once the chart ships, the tag becomes the honest baseline on its own.
 */
async function lastReleaseTag(): Promise<string> {
  const tags = await run(["git", "tag", "--list", "v*", "--sort=-v:refname"]);
  for (const tag of tags
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    const has = Bun.spawnSync(
      ["git", "cat-file", "-e", `${tag}:charts/openbot/values.yaml`],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (has.exitCode === 0) return tag;
  }
  return "origin/main";
}

async function run(command: string[]): Promise<string> {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}

/** Every path through a values map, as Helm's `--set` would name it. */
function paths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  const here = prefix ? [prefix] : [];
  return here.concat(
    Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      paths(child, prefix ? `${prefix}.${key}` : key),
    ),
  );
}

const before = new Set(
  paths(
    parse(await run(["git", "show", `${since}:charts/openbot/values.yaml`])),
  ),
);
const now = paths(parse(await Bun.file("charts/openbot/values.yaml").text()));
/*
 * A key whose parent is also new is covered by nulling the parent, and nulling both is the same
 * test twice. The parent is the harsher of the two, because that is what --reuse-values actually
 * leaves absent.
 */
const added = now
  .filter((path) => !before.has(path))
  .filter((path) => {
    const parent = path.slice(0, path.lastIndexOf("."));
    return parent === "" || before.has(parent);
  });

if (added.length === 0) {
  console.log(`No values keys added since ${since}.`);
  process.exit(0);
}
console.log(`Keys added since ${since}: ${added.join(", ")}`);

/** Render, and say what came out. */
function render(extra: string[]): { ok: boolean; out: string; err: string } {
  const result = Bun.spawnSync(
    [
      "helm",
      "template",
      "ci",
      "charts/openbot",
      "--values",
      valuesFile,
      "--set-string",
      `secrets.keyEncryptionKey=${btoa("0".repeat(32))}`,
      "--api-versions",
      "agents.x-k8s.io/v1beta1/Sandbox",
      "--api-versions",
      "extensions.agents.x-k8s.io/v1beta1/SandboxTemplate",
      ...extra,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  return {
    ok: result.exitCode === 0,
    out: new TextDecoder().decode(result.stdout),
    err: new TextDecoder().decode(result.stderr),
  };
}

/**
 * Keys rendered with nothing after them.
 *
 * An empty scalar is null, which Kubernetes reads as unset rather than as the chart's default. But
 * `key:` with nothing after it is also how YAML opens a nested mapping or a block sequence, so the
 * test is whether anything belongs UNDER it, not what the line looks like on its own.
 */
function emptyKeys(rendered: string): Set<string> {
  const lines = rendered.split("\n");
  const indentOf = (line: string) => line.length - line.trimStart().length;
  const found = new Set<string>();
  lines.forEach((line, index) => {
    if (!/^\s*[A-Za-z][A-Za-z0-9_.-]*:\s*$/.test(line)) return;
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next] ?? "";
      if (candidate.trim() === "") continue;
      if (indentOf(candidate) > indentOf(line)) return;
      // A block sequence may sit at the same indentation as the key it belongs to.
      if (
        indentOf(candidate) === indentOf(line) &&
        candidate.trimStart().startsWith("- ")
      ) {
        return;
      }
      found.add(line.trim());
      return;
    }
    found.add(line.trim());
  });
  return found;
}

/*
 * What this chart renders empty ANYWAY, so only what a missing key causes is reported.
 *
 * The bundled PostgreSQL subchart emits an empty `annotations:` of its own on some targets. Flagging
 * that would train whoever reads this to ignore it, which is the same as not having the check.
 */
const baseline = render([]);
if (!baseline.ok) {
  console.error(
    `::error::The chart does not render with ${valuesFile} at all.`,
  );
  console.error(baseline.err.trim().split("\n").slice(-3).join(" "));
  process.exit(1);
}
const alreadyEmpty = emptyKeys(baseline.out);

let bad = 0;
for (const path of added) {
  const attempt = render(["--set", `${path}=null`]);
  if (!attempt.ok) {
    const why = attempt.err.trim().split("\n").slice(-3).join(" ");
    console.error(
      `::error::Rendering without ${path} failed, which is what --reuse-values does to it. ${why}`,
    );
    bad += 1;
    continue;
  }
  const caused = [...emptyKeys(attempt.out)].filter(
    (key) => !alreadyEmpty.has(key),
  );
  if (caused.length > 0) {
    console.error(
      `::error::Rendering without ${path} left a key with an empty value: ${caused[0]}`,
    );
    bad += 1;
    continue;
  }
  console.log(`renders without ${path}`);
}
process.exit(bad === 0 ? 0 : 1);
