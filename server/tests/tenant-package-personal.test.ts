import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadTenantPackage } from "../src/tenant-package";

const personal = fileURLToPath(
  new URL("../../examples/personal", import.meta.url),
);
const fintech = fileURLToPath(
  new URL("../../examples/fintech", import.meta.url),
);

/**
 * The personal edition's package: one Bot to start with, and nothing from the fintech example.
 *
 * Kept out of `tenant-package.test.ts` because that suite opens a database at import.
 */
test("the personal package starts with the Personal Assistant and nothing else", async () => {
  const { agents, channels } = await loadTenantPackage(personal);
  expect(agents.map((agent) => agent.id)).toEqual(["personal-assistant"]);
  expect(agents[0]).toMatchObject({
    name: "Personal Assistant",
    type: "built_in",
  });
  expect(channels.map((channel) => channel.id)).toEqual(["personal-assistant"]);
});

test("none of the fintech example's Bots come with it", async () => {
  const { agents } = await loadTenantPackage(personal);
  const theirs = (await loadTenantPackage(fintech)).agents.map(
    (agent) => agent.id,
  );
  for (const agent of agents) expect(theirs).not.toContain(agent.id);
});

test("it can make Bots and write skills in a conversation", async () => {
  const { agents } = await loadTenantPackage(personal);
  expect(agents[0]?.skills).toEqual(["bot-creator", "skill-creator"]);
});
