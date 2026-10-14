import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { VisibleChatItem } from "../src/components/channels/chat-messages";
import {
  groupToolSteps,
  stepDetails,
  summarise,
  ToolActivity,
  type ToolGroup,
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
  const grouped = groupToolSteps(items);
  expect(grouped.map((item) => item.kind)).toEqual(["tools", "text"]);
  expect(grouped[0]).toMatchObject({ id: "search", steps: items.slice(0, 3) });
});

test("one connector call keeps its own line, and anything the app draws stays where it is", () => {
  expect(groupToolSteps([search()])).toEqual([search()]);
  const chart = call("chart", "showBarChart");
  const help = call("help", "computer_request_help");
  for (const boundary of [chart, help, text("between")]) {
    const grouped = groupToolSteps([search("a"), boundary, search("b")]);
    expect(grouped.map((item) => item.id)).toEqual(["a", boundary.id, "b"]);
  }
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
  const grouped = groupToolSteps([search("a"), consent, search("b")]);
  expect(grouped.map((item) => item.id)).toContain("consent");
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
