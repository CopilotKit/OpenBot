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

describe("the handoff caps say the same thing everywhere", () => {
  test("the chart's values match the code's fallbacks", () => {
    expect(chart.config?.handoff?.maxDepth).toBe(code.maxDepth);
    expect(chart.config?.handoff?.maxPerRun).toBe(code.maxPerRun);
  });

  /*
   * The TEMPLATE's own fallback, and that it does not eat a deliberate zero, are asserted where Helm
   * exists — `scripts/check-new-values-keys.ts`, run by the chart job. This suite runs in a job with
   * no Helm binary, and a test that shells out to one that is not there does not fail, it returns
   * undefined and compares it to nothing. That is how the first version of this passed locally and
   * failed in CI.
   *
   * The two halves chain: the script holds the rendered fallback to values.yaml, and this holds
   * values.yaml to the code and the docs.
   */

  test("and the documented defaults are those numbers", () => {
    const row = (name: string) =>
      docs.split("\n").find((line) => line.includes(name)) ?? "";
    expect(row("BOT_HANDOFF_MAX_DEPTH")).toContain(`\`${code.maxDepth}\``);
    expect(row("BOT_HANDOFF_MAX_PER_RUN")).toContain(`\`${code.maxPerRun}\``);
  });
});
