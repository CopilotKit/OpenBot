import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { Outcome, PluginReview } from "@/components/skills/install-plugin";
import { installPlan } from "@/lib/agent-plugins/install";
import {
  MCP_SCHEMA_1_0_0,
  PLUGIN_SCHEMA_1_0_0,
  readPlugin,
} from "@/lib/agent-plugins/read";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(cleanup);

/**
 * The review lists every skill and server a plugin ships before anything is installed: what each
 * becomes, and for each one left out, why. The same rows then say how each one came out, so the
 * screen a person pressed Install on is the screen that tells them what happened.
 */

const reading = readPlugin([
  {
    path: "plugin.json",
    text: JSON.stringify({
      $schema: PLUGIN_SCHEMA_1_0_0,
      name: "reports",
      version: "1.2.0",
      description: "Weekly reports from your tracker.",
    }),
  },
  {
    path: "skills/weekly-report/SKILL.md",
    text: "---\nname: weekly-report\ndescription: Write the weekly report.\n---\nRead the closed issues.",
  },
  { path: "skills/weekly-report/references/template.md", text: null },
  {
    path: "mcp.json",
    text: JSON.stringify({
      $schema: MCP_SCHEMA_1_0_0,
      mcpServers: {
        tracker: {
          type: "streamable-http",
          url: "https://mcp.example.com/mcp",
        },
        local: { type: "stdio", command: "./bin/server" },
      },
    }),
  },
  { path: "hooks/hooks.json", text: null },
]);
if (!reading.ok) throw new Error(reading.error);

test("names what will be installed, and what won't be and why", () => {
  const { getByText } = render(
    <PluginReview plan={installPlan(reading, new Set())} reading={reading} />,
  );
  expect(getByText("reports")).toBeTruthy();
  expect(getByText("1.2.0")).toBeTruthy();
  expect(getByText("Adds 1 skill and 1 server.")).toBeTruthy();
  expect(getByText("/weekly-report")).toBeTruthy();
  expect(getByText("https://mcp.example.com/mcp")).toBeTruthy();
  // Left out, behind one disclosure: the stdio server, and the hooks folder.
  expect(getByText("Won't be installed")).toBeTruthy();
  expect(getByText("local")).toBeTruthy();
  expect(getByText(/runs a program on the computer/)).toBeTruthy();
  expect(getByText(/hooks\/ folder isn't part of Agent Plugins/)).toBeTruthy();
});

test("a skill's instructions, and the files it won't keep, can be read before installing", () => {
  const { getByText } = render(
    <PluginReview plan={installPlan(reading, new Set())} reading={reading} />,
  );
  expect(getByText("Instructions")).toBeTruthy();
  expect(getByText("Read the closed issues.")).toBeTruthy();
  expect(
    getByText("Not kept: skills/weekly-report/references/template.md"),
  ).toBeTruthy();
});

test("a skill the person already has is shown as not installed, not as installed", () => {
  const { getByText, queryByText } = render(
    <PluginReview
      plan={installPlan(reading, new Set(["weekly-report"]))}
      reading={reading}
    />,
  );
  expect(queryByText("/weekly-report")).toBeNull();
  expect(
    getByText("You already have /weekly-report, so it was left as it is."),
  ).toBeTruthy();
});

test("somebody who can't add servers sees why, before pressing Install", () => {
  const { getByText, queryByText } = render(
    <PluginReview
      plan={installPlan(reading, new Set(), { mayAddServers: false })}
      reading={reading}
    />,
  );
  expect(getByText("Adds 1 skill.")).toBeTruthy();
  expect(queryByText("https://mcp.example.com/mcp")).toBeNull();
  expect(getByText(/Only an admin adds a server here/)).toBeTruthy();
});

test("each row says how it came out, and the one being written says so", () => {
  const plan = installPlan(reading, new Set());
  const working = render(
    <PluginReview
      plan={plan}
      progress={{
        working: { kind: "skill", key: "weekly-report" },
        result: { servers: [{ name: "tracker", status: "added" }], skills: [] },
      }}
      reading={reading}
      result={{ servers: [{ name: "tracker", status: "added" }], skills: [] }}
    />,
  );
  expect(working.getByText("Added")).toBeTruthy();
  expect(working.getByText("Adding")).toBeTruthy();
  cleanup();

  const failed = render(
    <PluginReview
      plan={plan}
      reading={reading}
      result={{
        servers: [{ name: "tracker", status: "not-approved" }],
        skills: [
          {
            slug: "weekly-report",
            saved: false,
            message: "Somebody else owns /weekly-report.",
          },
        ],
      }}
    />,
  );
  expect(failed.getByText("Not on your admin's approved list.")).toBeTruthy();
  expect(failed.getByText("Somebody else owns /weekly-report.")).toBeTruthy();
});

test("the outcome counts what was installed, what needs setup, and what didn't install", () => {
  const all = render(
    <Outcome
      result={{
        servers: [{ name: "tracker", status: "added" }],
        skills: [{ slug: "weekly-report", saved: true }],
      }}
    />,
  );
  expect(all.getByText("Installed 1 skill and 1 server.")).toBeTruthy();
  expect(all.getByRole("status")).toBeTruthy();
  cleanup();

  const mixed = render(
    <Outcome
      result={{
        servers: [
          { name: "tracker", status: "sign-in" },
          { name: "billing", status: "needs-key", message: "Needs a key." },
          { name: "ledger", status: "failed", message: "Network down." },
        ],
        skills: [{ slug: "weekly-report", saved: true }],
      }}
    />,
  );
  // The server refused for want of a key was never added, so it isn't counted as installed.
  expect(mixed.getByText("Installed 1 skill and 1 server.")).toBeTruthy();
  expect(
    mixed.getByText(
      /Finish setting up 1 server by signing in before a Bot can use it\./,
    ),
  ).toBeTruthy();
  expect(mixed.getByText(/1 server needs a key/)).toBeTruthy();
  expect(
    mixed.getByText(/1 couldn't be installed; each row says why\./),
  ).toBeTruthy();
});
