import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { PluginReview } from "@/components/skills/install-plugin";
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
 * becomes, and for each one left out, why. A plugin that installs less than it ships must say so
 * on the screen a person presses Install from.
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

test("names what will be installed, and what is left out and why", () => {
  const { getByText } = render(
    <PluginReview plan={installPlan(reading, new Set())} reading={reading} />,
  );
  expect(getByText("reports")).toBeTruthy();
  expect(getByText("1.2.0")).toBeTruthy();
  expect(getByText("/weekly-report")).toBeTruthy();
  expect(
    getByText(/Its other files aren't kept: skills\/weekly-report\/references/),
  ).toBeTruthy();
  expect(getByText("https://mcp.example.com/mcp")).toBeTruthy();
  expect(getByText("local")).toBeTruthy();
  expect(getByText(/runs a program on the computer/)).toBeTruthy();
  expect(getByText(/hooks\/ folder isn't part of Agent Plugins/)).toBeTruthy();
});

test("a skill's instructions can be read before it is installed", () => {
  const { getByText } = render(
    <PluginReview plan={installPlan(reading, new Set())} reading={reading} />,
  );
  expect(getByText("Read the instructions")).toBeTruthy();
  expect(getByText("Read the closed issues.")).toBeTruthy();
});

test("a skill the person already has is shown as left out, not as installed", () => {
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
