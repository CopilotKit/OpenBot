/**
 * The chart as `helm upgrade --reuse-values` renders it for a release from before a values key.
 *
 * Such a release's stored values do not have the key, so the new chart's default for it is not
 * there either: `--reuse-values` replaces the new chart's values.yaml with the old release's
 * computed values. For a key of this chart's own, `--set <key>=null` reproduces that.
 *
 * NOT FOR A KEY UNDER A DEPENDENCY'S BLOCK (`intelligence.…`, `postgresql.…`). There, null also
 * deletes the dependency chart's own default beneath the key, which `--reuse-values` never does:
 * the old release's computed values carry that chart's defaults, and the new one's are merged under
 * them when it renders. Nulling `intelligence.learning.queue` takes away the Intelligence chart's
 * whole queue block and its templates fail on it, on an upgrade that in fact renders. So a key under
 * a dependency is taken out of a copy of values.yaml instead, which leaves the dependency's own
 * default in force exactly as an upgrade does.
 */
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, parseDocument } from "yaml";

/** The values keys a chart hands to its dependencies: each one's alias, or else its name. */
export function dependencyKeys(chartYaml: string): Set<string> {
  const chart = parse(chartYaml) as {
    dependencies?: { name: string; alias?: string }[];
  };
  return new Set(
    (chart.dependencies ?? []).map(
      (dependency) => dependency.alias ?? dependency.name,
    ),
  );
}

/** Whether a values key sits under a dependency's block, rather than being that block itself. */
export function underDependency(
  path: string,
  dependencies: ReadonlySet<string>,
): boolean {
  const [first, ...rest] = path.split(".");
  return rest.length > 0 && dependencies.has(first as string);
}

/**
 * Runs `use` on a copy of the chart at `chart` whose values.yaml lacks `path`, with nothing else
 * changed, then removes the copy.
 */
export async function withoutChartDefault<T>(
  chart: string,
  path: string,
  use: (copy: string) => T | Promise<T>,
): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), "openbot-chart-"));
  try {
    const copy = join(scratch, "openbot");
    await cp(chart, copy, { recursive: true });
    const file = join(copy, "values.yaml");
    const values = parseDocument(await Bun.file(file).text());
    values.deleteIn(path.split("."));
    await Bun.write(file, values.toString());
    return await use(copy);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
