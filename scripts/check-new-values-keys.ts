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
import { parse, parseAllDocuments } from "yaml";

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
/**
 * The parent of `a.b` is `a`; a top-level key has none.
 *
 * `slice(0, lastIndexOf("."))` looks right and is not: `lastIndexOf` answers -1 for a dotless key,
 * and `slice(0, -1)` chops the last character. `routines` became `routine`, which is in nobody's
 * value file, so every NEW TOP-LEVEL KEY was filtered out of the check — precisely the case that
 * caused this script to be written.
 */
function parentOf(path: string): string | null {
  const cut = path.lastIndexOf(".");
  return cut === -1 ? null : path.slice(0, cut);
}

const added = now
  .filter((path) => !before.has(path))
  .filter((path) => {
    const parent = parentOf(path);
    // A key whose parent is also new is covered by nulling the parent, which is the harsher test.
    return parent === null || before.has(parent);
  });

if (added.length === 0) {
  console.log(`No values keys added since ${since}.`);
} else {
  console.log(`Keys added since ${since}: ${added.join(", ")}`);
}

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

/*
 * And that a value of ZERO is rendered as zero, WHETHER OR NOT ANY KEY IS NEW.
 *
 * This is not about upgrades, so it does not belong under the added-keys check: once `config.handoff`
 * ships in a tag it stops being new, and an assertion that stopped running with it would let a
 * `| default 1` come back unnoticed.
 *
 * `| default` substitutes on empty, and in Go templates zero IS empty, so a guard added for the
 * absent case silently rewrote `maxDepth: 0` to `1` — switching a capability back on for a
 * deployment that had switched it off. A nil-guard that defeats an off switch is worse than the nil
 * dereference it was added for, and it renders perfectly, so nothing above would have caught it.
 */
const offSwitches: Array<{ path: string; variable: string }> = [
  { path: "config.handoff.maxDepth", variable: "BOT_HANDOFF_MAX_DEPTH" },
  { path: "config.handoff.maxPerRun", variable: "BOT_HANDOFF_MAX_PER_RUN" },
];

/** The value rendered onto a named env var, or undefined if it is not there. */
function renderedValue(out: string, variable: string): string | undefined {
  const lines = out.split("\n");
  const at = lines.findIndex((line) => line.includes(`name: ${variable}`));
  if (at === -1) return undefined;
  return lines[at + 1]
    ?.trim()
    .replace(/^value:\s*/, "")
    .replace(/"/g, "");
}

/*
 * And that the TEMPLATE's own fallback is the number values.yaml documents.
 *
 * Reached only on an upgrade from before the key existed, which is exactly when nobody is looking.
 * Asserted here rather than in the suite that checks values.yaml against the code, because that one
 * runs in a job with no Helm — and a test that shells out to a binary which is not there returns
 * undefined rather than failing.
 */
const rawChartValues = await Bun.file("charts/openbot/values.yaml").text();
const chartValues = parse(rawChartValues) as {
  config?: { handoff?: Record<string, number> };
};
const absent = render(["--set", "config.handoff=null"]);
for (const { path, variable } of offSwitches) {
  const leaf = path.slice(path.lastIndexOf(".") + 1);
  const documented = chartValues.config?.handoff?.[leaf];
  const got = absent.ok ? renderedValue(absent.out, variable) : undefined;
  if (got !== String(documented)) {
    console.error(
      `::error::With config.handoff absent, ${variable} rendered ${got ?? "nothing"} but values.yaml documents ${documented}.`,
    );
    bad += 1;
  } else {
    console.log(`${variable} falls back to ${got}, as values.yaml says`);
  }
}
/**
 * What has to be switched on for the workload carrying this fallback to render at all.
 *
 * The culler only needs the sandbox mode it belongs to. Routines additionally need the credential
 * the worker presents, and WHERE that lives differs per target: three of the five read secrets from
 * a cloud store, where naming `secrets.workerSharedSecret` is not enough and `externalSecrets.data`
 * has to name it too. Appended after whatever the target already declares rather than turning the
 * store off, so this still renders the target as shipped.
 */
const targetValues = parse(await Bun.file(valuesFile).text()) as {
  externalSecrets?: { enabled?: boolean; data?: unknown[] };
};
function enableFor(component: string): string[] {
  if (component === "culler") return ["--set", "computers.mode=sandbox"];
  const on = ["--set", "routines.enabled=true"];
  if (!targetValues.externalSecrets?.enabled) {
    return [
      ...on,
      "--set-string",
      "secrets.workerSharedSecret=for-rendering-only",
    ];
  }
  const next = targetValues.externalSecrets.data?.length ?? 0;
  return [
    ...on,
    "--set",
    `externalSecrets.data[${next}].secretKey=worker-shared-secret`,
    "--set",
    `externalSecrets.data[${next}].remoteRef.key=openbot/worker-shared-secret`,
  ];
}

/** One step of a dotted path through parsed YAML, without asserting a shape it may not have. */
function at(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** What sits at a dotted path, or undefined if any step of it is missing. */
function valueAt(root: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((here, key) => at(here, key), root);
}

/*
 * The same assertion for the fallbacks that are not env vars.
 *
 * `offSwitches` above reads a rendered `name:`/`value:` pair, so it can only see a fallback that
 * reaches a container's environment. Two do not: the routines schedule and the culler's deadline are
 * fields on a CronJob. They were left unchecked as "no drift test yet" and the routines schedule had
 * already been wrong once — `* * * * *`, five times more often than anything documents — which is
 * the whole argument for asserting it rather than trusting the two comments that describe it.
 *
 * Nulling the LEAF, not the parent, because that is the shape `--reuse-values` actually produces
 * here: an existing release carries `routines.enabled` from the release that introduced it and
 * simply has no `schedule` key, so nulling the parent would delete the feature and render nothing
 * to assert against.
 */
const fieldFallbacks: ReadonlyArray<{
  /** The values key, as `--set` names it. */
  path: string;
  /** The component label on the workload that carries the field. */
  component: string;
  /** Where the field sits on the rendered resource. */
  field: readonly string[];
}> = [
  {
    path: "routines.schedule",
    component: "routines",
    field: ["spec", "schedule"],
  },
  {
    path: "computers.sandbox.culler.activeDeadlineSeconds",
    component: "culler",
    field: ["spec", "jobTemplate", "spec", "activeDeadlineSeconds"],
  },
];

const chartValuesTree = parse(rawChartValues) as unknown;

for (const { path, component, field } of fieldFallbacks) {
  const documented = valueAt(chartValuesTree, path.split("."));
  const attempt = render([...enableFor(component), "--set", `${path}=null`]);
  if (!attempt.ok) {
    console.error(
      `::error::The chart failed to render with ${path} absent: ${attempt.err.trim().split("\n")[0]}`,
    );
    bad += 1;
    continue;
  }
  /*
   * Found by its component label rather than by name, because a name is the release name plus a
   * suffix and this check would then be pinned to both.
   *
   * Narrowed to pod-carrying kinds: a NetworkPolicy naming the same component carries the label too.
   */
  const WORKLOAD_KINDS = new Set([
    "CronJob",
    "DaemonSet",
    "Deployment",
    "Job",
    "StatefulSet",
  ]);
  const carriers = parseAllDocuments(attempt.out)
    .map((document) => document.toJS() as unknown)
    .filter(
      (resource) =>
        WORKLOAD_KINDS.has(String(valueAt(resource, ["kind"]))) &&
        valueAt(resource, [
          "metadata",
          "labels",
          "app.kubernetes.io/component",
        ]) === component,
    );
  if (carriers.length !== 1) {
    console.error(
      `::error::Rendering with ${path} absent produced ${carriers.length} workloads labelled ${component}, not one.`,
    );
    bad += 1;
    continue;
  }
  const got = valueAt(carriers[0], field);
  if (String(got) !== String(documented)) {
    console.error(
      `::error::With ${path} absent, the ${component} workload rendered ${JSON.stringify(got)} but values.yaml documents ${JSON.stringify(documented)}.`,
    );
    bad += 1;
    continue;
  }
  console.log(
    `${path} falls back to ${JSON.stringify(got)}, as values.yaml says`,
  );
}

for (const { path, variable } of offSwitches) {
  const attempt = render(["--set", `${path}=0`]);
  if (!attempt.ok) {
    console.error(`::error::The chart failed to render with ${path}=0.`);
    bad += 1;
    continue;
  }
  const lines = attempt.out.split("\n");
  const at = lines.findIndex((line) => line.includes(`name: ${variable}`));
  const value = at === -1 ? undefined : lines[at + 1]?.trim();
  if (value !== 'value: "0"') {
    console.error(
      `::error::Setting ${path}=0 rendered ${value ?? "nothing"} rather than value: "0". A zero is an off switch, not an absent value.`,
    );
    bad += 1;
    continue;
  }
  console.log(`${path}=0 stays zero`);
}
process.exit(bad === 0 ? 0 : 1);
