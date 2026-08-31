import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { SKILL_CREATOR_SLUG } from "@/lib/skills/proposal";

/**
 * The one coupling in this feature that can break silently.
 *
 * The app offers the four authoring tools only to a Bot holding `SKILL_CREATOR_SLUG`, and the shipped
 * package is what puts a skill under that slug in the deployment and grants it to a Bot. Neither half
 * fails loudly without the other: rename the slug in the YAML and the tools are simply never offered,
 * grant it to nobody and there is no Bot to write a skill with. Both look like a working deployment
 * where writing a skill in a conversation does nothing, which is the kind of break nobody finds.
 *
 * Read from the file rather than from a fixture, because the file is what ships.
 */

const packageDir = new URL("../../examples/fintech", import.meta.url).pathname;

const shipped = parse(readFileSync(`${packageDir}/skills.yaml`, "utf8")) as {
  skills: { slug: string; title: string; instructions: string }[];
};

const roster = parse(readFileSync(`${packageDir}/agents.yaml`, "utf8")) as {
  agents: { id: string; skills?: string[] }[];
};

describe("the shipped package and the app agree on the authoring skill", () => {
  test("the package ships a skill under the slug the app gates on", () => {
    const slugs = shipped.skills.map((skill) => skill.slug);
    expect(slugs).toContain(SKILL_CREATOR_SLUG);
  });

  test("at least one shipped coworker is granted it", () => {
    // A skill on no Bot is inert: it is in everybody's `/` menu and no run can act on it.
    const holders = roster.agents.filter((agent) =>
      (agent.skills ?? []).includes(SKILL_CREATOR_SLUG),
    );
    expect(holders.length).toBeGreaterThan(0);
  });

  test("its instruction names the tool that actually saves the skill", () => {
    // The instruction is the feature. One that never reaches `save_skill` produces a Bot that
    // interviews somebody thoroughly and then asks them to retype it into the form.
    const creator = shipped.skills.find(
      (skill) => skill.slug === SKILL_CREATOR_SLUG,
    );
    expect(creator?.instructions).toContain("save_skill");
  });
});
