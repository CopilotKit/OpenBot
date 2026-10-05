import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { BOT_CREATOR_SLUG } from "@/lib/agents/proposal";

/**
 * The coupling that breaks silently, in both directions.
 *
 * `BOT_CREATOR_SLUG` decides which Bots the app offers `list_bots`, `read_bot`, `list_bot_skills`
 * and `save_bot` to. The shipped package decides which slug exists in a deployment and which Bot
 * holds it. Nothing connects the two but the string, and every way of breaking it looks like a
 * healthy deployment: rename it in the YAML and the tools are never offered; grant it to nobody and
 * there is no Bot to make coworkers with. In both cases a person asks their Bot to make a coworker,
 * it says it cannot, and there is nothing on any screen that explains why.
 *
 * So this reads the package the way the loader does and asserts the three facts that have to hold
 * together. It is the only thing that makes that failure loud, which is why it must not be deleted
 * along with whichever half of the coupling a later change moves.
 */

const PACKAGE = join(import.meta.dir, "../../examples/fintech");

type SkillsFile = { skills: { slug: string; tools?: unknown }[] };
type AgentsFile = { agents: { id: string; skills?: string[] }[] };

function read<T>(file: string): T {
  return parse(readFileSync(join(PACKAGE, file), "utf8")) as T;
}

test("the deployment ships a skill under the slug the app gates on", () => {
  const { skills } = read<SkillsFile>("skills.yaml");
  const shipped = skills.find((skill) => skill.slug === BOT_CREATOR_SLUG);

  expect(shipped).toBeDefined();
});

test("a Bot in the package actually holds it", () => {
  const { agents } = read<AgentsFile>("agents.yaml");
  const holders = agents.filter((agent) =>
    (agent.skills ?? []).includes(BOT_CREATOR_SLUG),
  );

  // At least one, because a slug granted to nobody offers the tools to nobody.
  expect(holders.length).toBeGreaterThan(0);
});

/**
 * The declaration stays empty, and that is a rule rather than an accident.
 *
 * `tools:` on a skill is intersected with its Bot's MCP grants to narrow what a run is offered. The
 * four tools this skill exists for are the app's own, registered in the browser and gated on the
 * grant of the skill itself — they are not MCP refs and can never appear in a grant. Naming them
 * here would therefore name nothing, while looking exactly like the thing that makes them work.
 */
test("it declares no tools, because the ones it is for are not MCP refs", () => {
  const { skills } = read<SkillsFile>("skills.yaml");
  const shipped = skills.find((skill) => skill.slug === BOT_CREATOR_SLUG);

  expect(shipped?.tools ?? []).toEqual([]);
});
