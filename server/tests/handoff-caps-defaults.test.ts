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

const helpers = await Bun.file("charts/openbot/templates/_helpers.tpl").text();
const docs = await Bun.file("docs/configuration.md").text();

/** What `handoffCaps` falls back to with nothing in the environment. */
const code = loadConfig(testEnvironment()).handoff;

/** The `| default N` a template falls back to when the values key is absent entirely. */
function helperDefault(variable: string): number {
  const match = helpers.match(
    new RegExp(`name: ${variable}[\\s\\S]{0,120}?default (\\d+)`),
  );
  if (!match?.[1]) {
    throw new Error(
      `No \`| default\` found for ${variable} in _helpers.tpl. Without one, an upgrade that reuses values renders it empty.`,
    );
  }
  return Number(match[1]);
}

describe("the handoff caps say the same thing everywhere", () => {
  test("the chart's values match the code's fallbacks", () => {
    expect(chart.config?.handoff?.maxDepth).toBe(code.maxDepth);
    expect(chart.config?.handoff?.maxPerRun).toBe(code.maxPerRun);
  });

  /*
   * This is the one that bites on an upgrade: the values key is absent on every release made before
   * it existed, so the template's own default is what those deployments actually get.
   */
  test("the template's fallbacks match them too", () => {
    expect(helperDefault("BOT_HANDOFF_MAX_DEPTH")).toBe(code.maxDepth);
    expect(helperDefault("BOT_HANDOFF_MAX_PER_RUN")).toBe(code.maxPerRun);
  });

  test("and the documented defaults are those numbers", () => {
    const row = (name: string) =>
      docs.split("\n").find((line) => line.includes(name)) ?? "";
    expect(row("BOT_HANDOFF_MAX_DEPTH")).toContain(`\`${code.maxDepth}\``);
    expect(row("BOT_HANDOFF_MAX_PER_RUN")).toContain(`\`${code.maxPerRun}\``);
  });
});
