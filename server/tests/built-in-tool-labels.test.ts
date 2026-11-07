import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ownToolLabel, readToolName } from "@openbot/shared/tool-name";
import { builtInTools } from "./support/built-in-tools";

/**
 * Every tool OpenBot offers a Bot has words for the transcript.
 *
 * A step line names a tool from `OWN_TOOLS` in `shared/tool-name.ts`, and a tool with no entry there
 * falls through to its identifier. That is how a live conversation came to read
 * `copilotkit_load_skill`, `list_bots` and `remember_personal_fact` between "Searched the web" and
 * "Asked Knowledge": each tool was added where it is registered and nobody added its words. The names
 * here are read from those registrations (see `support/built-in-tools.ts`), so the next tool added
 * without words fails this file the day it lands rather than the day somebody sees it.
 */

const repoRoot = join(import.meta.dir, "..", "..");
const scan = builtInTools(repoRoot);

/**
 * The registrations whose names are decided at run time, and why none of them is a tool of its own.
 *
 * Keyed `file: expression`. A new one fails below until it is either written as a literal, so this
 * file can check its words, or added here with the reason it needs none.
 */
const DECIDED_AT_RUN_TIME: Record<string, string> = {
  "server/src/plugins/tools.ts: tool.toolName":
    "An app's tool, offered as mcp__<app>__<tool>, which readToolName names from the app and the action.",
  "server/src/copilot.ts: tool.name":
    "A Bot's own tools, and its learned skills, handed on to the model or a remote Bot. Each is registered, and checked, where it is made.",
  "server/src/index.ts: tool.name":
    "A responsibility run's tools handed to the headless runner. Each is registered, and checked, where it is made.",
  "server/src/responsibilities/wiring.ts: tool.name":
    "A responsibility run's tools handed to the headless runner. Each is registered, and checked, where it is made.",
  "server/src/agents/plan-model.ts: tool.name":
    "The tools of the run it plans for, handed through unchanged.",
  "server/src/proactive/restriction.ts: name":
    "A hidden refusal standing in for a tool a check-in was not given. The tool itself is registered elsewhere.",
  "server/src/components/headless.ts: spec.name":
    "A gallery component drawn where no browser is. It draws itself and is named by whoever wrote it.",
  "app/src/lib/copilot/gallery-tools.tsx: spec.name":
    "A gallery component. It draws itself and is named by whoever wrote it.",
  "app/src/lib/copilot/sandboxed-tools.tsx: component.name":
    "A component somebody wrote in the browser. It draws itself and is named by whoever wrote it.",
  "agent-bot/src/index.ts: tool.name":
    "The tools OpenBot sends a run, handed to the model provider unchanged.",
};

describe("the tools OpenBot offers a Bot", () => {
  test("are found by reading every way a tool is registered", () => {
    const names = new Set(scan.named.map((tool) => tool.name));
    // One per way a name is written, so a scan that stopped reading one of them cannot pass quietly.
    for (const name of [
      "list_bots", // a literal, in a browser tool
      "show_app_access", // a constant from another package
      "remember_personal_fact", // a helper's parameter, followed to its calls
      "pause_goal", // a template literal over a for...of
      "computer_screenshot", // a headless computer tool's definition
      "copilotkit_load_skill", // an AG-UI tool the runtime hands the model
      "search_tools", // a constant in the same file
    ])
      expect(names).toContain(name);
    expect(scan.components.map((tool) => tool.name)).toContain("showBarChart");
  });

  test("every one has words for its line, while it runs and once it is done", () => {
    const missing = scan.named
      .filter(
        (tool) =>
          ownToolLabel(tool.name, true) === null ||
          ownToolLabel(tool.name) === null ||
          readToolName(tool.name, true).label === tool.name ||
          readToolName(tool.name).label === tool.name,
      )
      .map((tool) => `${tool.name} (${tool.file}:${tool.line})`);
    expect(missing).toEqual([]);
  });

  test("a name the scan cannot follow fails rather than being skipped", () => {
    expect(scan.unresolved.map((tool) => `${tool.site}:${tool.line}`)).toEqual(
      [],
    );
  });

  test("a name decided at run time is one of the few that are meant to be", () => {
    const unexplained = scan.dynamic
      .filter((tool) => !Object.hasOwn(DECIDED_AT_RUN_TIME, tool.site))
      .map((tool) => `${tool.site} (line ${tool.line})`);
    expect(unexplained).toEqual([]);
    // And the list does not outlive what it explains.
    const sites = new Set(scan.dynamic.map((tool) => tool.site));
    expect(
      Object.keys(DECIDED_AT_RUN_TIME).filter((site) => !sites.has(site)),
    ).toEqual([]);
  });
});
