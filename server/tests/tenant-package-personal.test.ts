import { afterEach, beforeEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadTenantPackage } from "../src/tenant-package";

const personal = fileURLToPath(
  new URL("../../examples/personal", import.meta.url),
);
const fintech = fileURLToPath(
  new URL("../../examples/fintech", import.meta.url),
);

// No Bot picked unless a test picks one, whatever the shell running the tests has set.
const PICKED = ["PICKED_HARNESS_URL", "PICKED_HARNESS_NAME"] as const;
const saved = Object.fromEntries(
  PICKED.map((name) => [name, process.env[name]]),
);

beforeEach(() => {
  for (const name of PICKED) delete process.env[name];
});

afterEach(() => {
  for (const name of PICKED) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

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

test("the loader reads a configured harness template alongside the fallback", async () => {
  process.env.PICKED_HARNESS_URL = "http://127.0.0.1:4206/ag-ui";
  process.env.PICKED_HARNESS_NAME = "LangGraph";
  const { agents } = await loadTenantPackage(personal);
  expect(agents.map((agent) => agent.id)).toEqual([
    "personal-assistant",
    "picked-harness",
  ]);
  expect(agents[1]).toMatchObject({
    name: "LangGraph",
    // What runs it under its name, not its name a second time.
    title: "Powered by LangGraph",
    type: "remote_ag_ui",
    configuration: { endpoint: "http://127.0.0.1:4206/ag-ui" },
  });
});

test("the Bot that ships says it runs on OpenBot itself", async () => {
  const { agents } = await loadTenantPackage(personal);
  expect(agents[0]).toMatchObject({
    name: "Personal Assistant",
    title: "Powered by OpenBot",
    type: "built_in",
  });
});

test("it can make Bots and write skills in a conversation", async () => {
  const { agents } = await loadTenantPackage(personal);
  expect(agents[0]?.skills).toEqual(["bot-creator", "skill-creator"]);
});

// Package-owned Bot ids survive edition changes only within the same deployment package.
test("switching an existing desktop to personal retains ownership of its picked Bot", async () => {
  process.env.PICKED_HARNESS_URL = "http://127.0.0.1:4206/ag-ui";
  const previous = await loadTenantPackage(fintech);
  const next = await loadTenantPackage(personal);
  expect(previous.agents.some((agent) => agent.id === "picked-harness")).toBe(
    true,
  );
  expect(next.agents.some((agent) => agent.id === "picked-harness")).toBe(true);
  expect(next.tenantId).toBe(previous.tenantId);
});
