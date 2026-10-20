import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { CopilotKitContext } from "@copilotkit/react-core/v2/context";
import type { ReactNode } from "react";
import type { VisibleChatItem } from "../src/components/channels/chat-messages";
import {
  groupToolSteps,
  stepDetails,
  summarise,
  ToolActivity,
  type ToolGroup,
  useDrawnTool,
} from "../src/components/channels/tool-activity";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

type ToolItem = Extract<VisibleChatItem, { kind: "tool" }>;

function call(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
  result?: string,
): ToolItem {
  return {
    kind: "tool",
    id,
    toolCall: {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
    ...(result === undefined ? {} : { result }),
  };
}

const search = (id = "search", result = '"Results"') =>
  call(id, "mcp__exa__web_search_exa", { query: "top 5 GDP 2025" }, result);
const fetch = (urls: string[], id = "fetch") =>
  call(id, "mcp__exa__web_fetch_exa", { urls }, '"Page text"');
// The names this app draws itself, as CopilotKit's renderer registry would list them.
const drawn = (name: string) =>
  name === "showBarChart" || name === "computer_request_help";
const text = (id: string): VisibleChatItem => ({
  kind: "text",
  id,
  role: "assistant",
  text: "Here is what I found.",
});

test("adjacent connector calls fold into one row named after the first", () => {
  const items = [
    search(),
    fetch(["https://imf.org/a"]),
    call("drive", "mcp__google-drive__search_files", { q: "budget" }, '"x"'),
    text("answer"),
  ];
  const grouped = groupToolSteps(items, drawn);
  expect(grouped.map((item) => item.kind)).toEqual(["tools", "text"]);
  expect(grouped[0]).toMatchObject({ id: "search", steps: items.slice(0, 3) });
});

test("one connector call keeps its own line, and anything the app draws stays where it is", () => {
  expect(groupToolSteps([search()], drawn)).toEqual([search()]);
  const chart = call("chart", "showBarChart");
  const help = call("help", "computer_request_help");
  for (const boundary of [chart, help, text("between")]) {
    const grouped = groupToolSteps([search("a"), boundary, search("b")], drawn);
    expect(grouped.map((item) => item.id)).toEqual(["a", boundary.id, "b"]);
  }
});

test("a run of tools the app does not draw folds like connector calls do", () => {
  const commands = ["1", "2", "3", "4", "5"].map((n) =>
    call(`cmd${n}`, "run_command", { command: "echo 5" }, '"5"'),
  );
  const grouped = groupToolSteps([...commands, text("answer")], drawn);
  expect(grouped.map((item) => item.kind)).toEqual(["tools", "text"]);
  expect(grouped[0]).toMatchObject({ id: "cmd1", steps: commands });
  // On its own it keeps its own line, as a lone connector call does.
  expect(groupToolSteps([commands[0] as ToolItem], drawn)).toEqual([
    commands[0] as ToolItem,
  ]);
  // And it joins a run of connector calls rather than splitting it.
  const mixed = groupToolSteps([search("a"), commands[0] as ToolItem], drawn);
  expect(mixed.map((item) => item.kind)).toEqual(["tools"]);
});

test("a tool the app draws ends a run, whatever it is called", () => {
  const grouped = groupToolSteps(
    [
      call("a", "run_command", {}, '"x"'),
      call("b", "run_command", {}, '"x"'),
      call("chart", "showBarChart"),
      call("c", "run_command", {}, '"x"'),
    ],
    drawn,
  );
  expect(grouped.map((item) => item.id)).toEqual(["a", "chart", "c"]);
});

test("a tool step is named in words and counted as tools", () => {
  const steps = ["1", "2", "3", "4", "5"]
    .map((n) => call(n, "run_command", { command: "echo 5" }, '"5"'))
    .map(stepDetails);
  expect(steps[0]).toMatchObject({ kind: "tool", label: "Run command" });
  expect(summarise(steps)).toBe("Used 5 tools");
  expect(
    summarise(
      [
        search(),
        call("t", "runCommand", {}, '"x"'),
        call("u", "read_file", {}, '"x"'),
      ].map(stepDetails),
    ),
  ).toBe("Searched the web and used 2 tools");
});

test("the tools CopilotKit has a renderer for are the ones the app draws", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <CopilotKitContext.Provider
      value={
        {
          copilotkit: {
            renderToolCalls: [{ name: "showBarChart" }],
            subscribe: () => ({ unsubscribe() {} }),
          },
        } as never
      }
    >
      {children}
    </CopilotKitContext.Provider>
  );
  const { result } = renderHook(() => useDrawnTool(), { wrapper });
  expect(result.current("showBarChart")).toBe(true);
  expect(result.current("run_command")).toBe(false);
  // Outside a provider nothing is drawn, so nothing is held back from a group.
  const bare = renderHook(() => useDrawnTool());
  expect(bare.result.current("showBarChart")).toBe(false);
});

test("a request to connect the person's own account is never folded away", () => {
  const consent = call(
    "consent",
    "mcp__gmail__send",
    {},
    JSON.stringify(
      'Refused. [team-bot-consent]{"botId":"b","serverId":"gmail"} Use your own Gmail?',
    ),
  );
  const grouped = groupToolSteps([search("a"), consent, search("b")], drawn);
  expect(grouped.map((item) => item.id)).toContain("consent");
});

test("a request to connect an app at all is never folded away either", () => {
  const prompt = call(
    "connect",
    "mcp__notion__search",
    {},
    JSON.stringify(
      'Refused. [connect-app]{"serverId":"srv_notion","title":"Notion"} You have not connected your Notion account. Connect it and ask again.',
    ),
  );
  const grouped = groupToolSteps([search("a"), prompt, search("b")], drawn);
  expect(grouped.map((item) => item.id)).toContain("connect");
});

test("the summary says what was done, never which provider searched", () => {
  const steps = [
    search(),
    fetch(["https://imf.org/a", "https://worldbank.org/b"]),
  ].map(stepDetails);
  expect(summarise(steps)).toBe("Searched the web and read 2 pages");
  expect(JSON.stringify(steps.map((step) => step.label))).not.toContain("exa");
  expect(steps[0]?.detail).toBe("top 5 GDP 2025");
  expect(steps[1]?.detail).toBe("imf.org and 1 more");
  expect(
    summarise(
      [
        call("d1", "mcp__google-drive__search_files", {}, '"x"'),
        call("d2", "mcp__google-drive__read_file", {}, '"x"'),
        call("n", "mcp__notion__search", {}, '"x"'),
      ].map(stepDetails),
    ),
  ).toBe("Used 2 connectors");
  expect(
    summarise(
      [call("d", "mcp__google-drive__search_files", {}, '"x"')].map(
        stepDetails,
      ),
    ),
  ).toBe("Used Google Drive");
});

test("a refusal and a failure each count as an issue on the folded line", () => {
  const group: ToolGroup = {
    kind: "tools",
    id: "a",
    steps: [
      search("a", JSON.stringify("Refused. Not allowed here.")),
      search("b", JSON.stringify("That tool could not be called: timeout")),
    ],
  };
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ToolActivity group={group} active={false} />
    </QueryClientProvider>,
  );
  expect(view.getByText("2 issues")).toBeDefined();
  expect(view.getByText("Blocked")).toBeDefined();
  expect(view.getByText("Didn't work")).toBeDefined();
});

test("while running, the line names the step in progress; opened, a step shows its inputs", () => {
  const group: ToolGroup = {
    kind: "tools",
    id: "a",
    steps: [
      search(),
      call("f", "mcp__exa__web_fetch_exa", { urls: ["https://imf.org"] }),
    ],
  };
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ToolActivity group={group} active />
    </QueryClientProvider>,
  );
  expect(view.getByText("Read web pages…")).toBeDefined();
  fireEvent.click(view.getAllByText("Search the web")[0] as HTMLElement);
  expect(view.getByText("query")).toBeDefined();
  expect(view.getAllByText("top 5 GDP 2025").length).toBeGreaterThan(0);
});
