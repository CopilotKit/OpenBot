import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Budgets, EXPRESSION, jobKey, wildcard } from "./ci-watch";

/**
 * CI cannot grow slow without anybody seeing it. Every job of every workflow stops at its own
 * `timeout-minutes` rather than GitHub's six hours, and every job of a workflow CI watches
 * (.github/workflows/ci-watch.yml) has a budget in .github/ci-budgets.json, under its time limit,
 * which scripts/ci-watch.ts holds each run to.
 */

const ROOT = join(import.meta.dir, "..");
const WORKFLOWS = join(ROOT, ".github/workflows");

type Job = {
  name?: string;
  "runs-on"?: unknown;
  uses?: string;
  "timeout-minutes"?: number | string;
  strategy?: { matrix?: Record<string, unknown> };
};
type Workflow = { name?: string; jobs: Record<string, Job> };

const read = (file: string) =>
  Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;

const files = readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file));
const budgets = JSON.parse(
  readFileSync(join(ROOT, ".github/ci-budgets.json"), "utf8"),
) as Budgets;
const watch = Bun.YAML.parse(
  readFileSync(join(WORKFLOWS, "ci-watch.yml"), "utf8"),
) as { on: { workflow_run: { workflows: string[] } } };

/**
 * The budget names a job reports under: its matrix expanded where the name uses it, and where a
 * part of the name is known only once the run starts, the wildcard every leg shares.
 */
function names(id: string, job: Job): string[] {
  const name = job.name ?? id;
  if (!name.includes(EXPRESSION)) return [name];
  const [key, values] = Object.entries(job.strategy?.matrix ?? {})[0] ?? [];
  const expanded = Array.isArray(values)
    ? values.map((value) =>
        name
          .replaceAll(`${EXPRESSION} matrix.${key} }}`, String(value))
          .replaceAll(
            `${EXPRESSION} strategy.job-total }}`,
            String(values.length),
          ),
      )
    : [name];
  return [
    ...new Set(
      expanded.map((n) => (n.includes(EXPRESSION) ? wildcard(n) : jobKey(n))),
    ),
  ];
}

describe("every job has a time limit", () => {
  for (const file of files) {
    test(file, () => {
      const missing = Object.entries(read(file).jobs)
        .filter(([, job]) => job["runs-on"] !== undefined)
        .filter(([, job]) => job["timeout-minutes"] === undefined)
        .map(([id]) => id);
      expect({ file, missing }).toEqual({ file, missing: [] });
    });
  }
});

describe("every job CI watches has a budget under its time limit", () => {
  test("every workflow with budgets is one CI watches", () => {
    for (const workflow of Object.keys(budgets))
      expect(watch.on.workflow_run.workflows).toContain(workflow);
  });

  for (const workflow of Object.keys(budgets)) {
    test(workflow, () => {
      const file = files.find((f) => read(f).name === workflow);
      expect(file).toBeDefined();
      const budget = budgets[workflow];
      const problems: string[] = [];
      for (const [id, job] of Object.entries(read(file as string).jobs)) {
        if (job["runs-on"] === undefined) continue;
        const limit = Number(job["timeout-minutes"]);
        for (const name of names(id, job)) {
          const allowed = budget?.jobs[name];
          if (allowed === undefined) problems.push(`${name}: no budget`);
          else if (!(allowed < limit))
            problems.push(
              `${name}: budget ${allowed} is not under its limit ${limit}`,
            );
        }
      }
      expect({ workflow, problems }).toEqual({ workflow, problems: [] });
      expect(budget?.run ?? 0).toBeGreaterThan(0);
    });
  }
});
