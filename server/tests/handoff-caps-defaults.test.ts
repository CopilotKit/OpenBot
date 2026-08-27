import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/**
 * One number, written down in four places.
 *
 * The caps have a fallback in `config.ts`, a default in the chart's `values.yaml`, a second default
 * in `_helpers.tpl` (which has to be there, because `--reuse-values` leaves the values key absent on
 * an existing release), and a figure quoted in `docs/configuration.md`. The helper always renders
 * the variable, so on Kubernetes the code fallback never runs and the docs describe a source the
 * deployment is not using.
 *
 * Nothing here can merge them: they are read by three different things at three different times. So
 * they are held together, and the next person to change one finds out here rather than from an
 * operator debugging a refusal against a number their deployment never had.
 */

const chart = parse(await Bun.file("charts/openbot/values.yaml").text()) as {
  config?: { handoff?: { maxDepth?: number; maxPerRun?: number } };
};

const docs = await Bun.file("docs/configuration.md").text();

/** What `handoffCaps` falls back to with nothing in the environment. */
const code = loadConfig(testEnvironment()).handoff;

/**
 * What the chart actually renders for a given value, read out of the rendered YAML.
 *
 * NOT OUT OF THE TEMPLATE SOURCE. Matching the `$maxDepth := 1` assignment looked like it pinned the
 * fallback and pinned almost nothing: `{{ $maxDepth | default 1 }}` still matched, which is the very
 * construct that swallowed an explicit zero, and it never checked WHICH env var the number ended up
 * on, so swapping the two emissions passed too. Rendering answers both.
 */
function rendered(variable: string, set: string[]): string | undefined {
  const result = Bun.spawnSync(
    [
      "helm",
      "template",
      "ci",
      "charts/openbot",
      "--values",
      "charts/openbot/ci/eks-values.yaml",
      "--set-string",
      `secrets.keyEncryptionKey=${btoa("0".repeat(32))}`,
      ...set.flatMap((one) => ["--set", one]),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) return undefined;
  const lines = new TextDecoder().decode(result.stdout).split("\n");
  const at = lines.findIndex((line) => line.includes(`name: ${variable}`));
  if (at === -1) return undefined;
  return lines[at + 1]
    ?.trim()
    .replace(/^value:\s*/, "")
    .replace(/"/g, "");
}

describe("the handoff caps say the same thing everywhere", () => {
  test("the chart's values match the code's fallbacks", () => {
    expect(chart.config?.handoff?.maxDepth).toBe(code.maxDepth);
    expect(chart.config?.handoff?.maxPerRun).toBe(code.maxPerRun);
  });

  /*
   * This is the one that bites on an upgrade: the values key is absent on every release made before
   * it existed, so the template's own fallback is what those deployments actually get.
   */
  test("the template's fallbacks match them too", () => {
    expect(rendered("BOT_HANDOFF_MAX_DEPTH", ["config.handoff=null"])).toBe(
      String(code.maxDepth),
    );
    expect(rendered("BOT_HANDOFF_MAX_PER_RUN", ["config.handoff=null"])).toBe(
      String(code.maxPerRun),
    );
  });

  /*
   * The fallback must not eat a deliberate zero, and each number has to land on its OWN variable.
   * Both were true of the version this replaced, and neither was tested.
   */
  test("an explicit zero reaches the container as a zero", () => {
    expect(
      rendered("BOT_HANDOFF_MAX_DEPTH", [
        "config.handoff.maxDepth=0",
        "config.handoff.maxPerRun=9",
      ]),
    ).toBe("0");
    expect(
      rendered("BOT_HANDOFF_MAX_PER_RUN", [
        "config.handoff.maxDepth=0",
        "config.handoff.maxPerRun=9",
      ]),
    ).toBe("9");
  });

  test("and the documented defaults are those numbers", () => {
    const row = (name: string) =>
      docs.split("\n").find((line) => line.includes(name)) ?? "";
    expect(row("BOT_HANDOFF_MAX_DEPTH")).toContain(`\`${code.maxDepth}\``);
    expect(row("BOT_HANDOFF_MAX_PER_RUN")).toContain(`\`${code.maxPerRun}\``);
  });
});
