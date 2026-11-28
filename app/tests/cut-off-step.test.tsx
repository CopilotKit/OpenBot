import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { VisibleChatItem } from "../src/components/channels/chat-messages";
import { ServerToolLine } from "../src/components/channels/chat-transcript";
import {
  ToolActivity,
  type ToolGroup,
} from "../src/components/channels/tool-activity";
import { outputOf, readOutcome } from "../src/lib/computers/activity";

/*
 * A step that was under way when its run was cut off (the server restarted, or the run crashed) has
 * no result of its own. The Bot is told its outcome is unknown, in words written for the Bot, and
 * carries on. A person reading the thread is told the step was interrupted, in plain words, and
 * never reads the Bot's instructions.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

type ToolItem = Extract<VisibleChatItem, { kind: "tool" }>;

/** What a cut-off call is answered with, as the thread holds it. */
const CUT_OFF =
  "Outcome unknown: this call was started, and the run was cut off before its result was recorded. Nobody knows whether it happened. If it only reads, make it again. If it changes something, do not make it again yet: read the app first to check whether the change is already there, and only make it if it is not.";
const SAID = "This step was interrupted before its result came back.";

const SEARCH = "mcp__parallel__web_search";
const FETCH = "mcp__parallel__web_fetch";
const FOUND = JSON.stringify({
  search_id: "search_1",
  results: [
    {
      url: "https://www.usgs.gov/columbia",
      title: "The Columbia",
      excerpts: ["The Columbia River is 1,243 miles long."],
    },
  ],
});

function call(
  id: string,
  name: string,
  args: Record<string, unknown>,
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

function open(container: HTMLElement) {
  for (const summary of container.querySelectorAll("summary"))
    fireEvent.click(summary);
}

function group(steps: ToolItem[], active = false) {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ToolActivity
        active={active}
        group={{ kind: "tools", id: "g", steps } satisfies ToolGroup}
      />
    </QueryClientProvider>,
  );
  open(view.container);
  return view;
}

/*
 * A COMPUTER STEP CUT OFF INSIDE THE SERVER'S RUN. The server runs a Bot's computer steps itself, and
 * one cut off part way is answered `{ ok: false, error: "Outcome unknown: ..." }` there, or with the
 * sentence alone. Either way it was not run again, nothing turned it away, and the person reads why
 * in their own words: never "Blocked", and never a failure with nothing under it.
 */
test("a computer step cut off inside the server's run reads as not run, in the person's words, in every form it comes in", () => {
  for (const content of [
    JSON.stringify({ ok: false, error: CUT_OFF }),
    JSON.stringify({ ok: false, reason: CUT_OFF }),
    CUT_OFF,
    `Error: ${CUT_OFF}`,
  ]) {
    const outcome = readOutcome(content);
    expect(outcome?.ok).toBe(false);
    expect(outcome?.refused).toBeUndefined();
    expect(outcome ? outputOf(outcome) : "").toBe(
      "It started, but OpenBot can't tell whether it finished. It wasn't run again.",
    );
  }
});

test("a step cut off on its own line reads as interrupted, and opens to plain words", () => {
  // As the thread holds it, and as the runtime hands an errored result back.
  for (const result of [
    CUT_OFF,
    `Error: ${CUT_OFF}`,
    JSON.stringify(CUT_OFF),
  ]) {
    const view = render(<ServerToolLine name={SEARCH} result={result} />);
    open(view.container);
    expect(view.getByText("Search the web, interrupted")).toBeDefined();
    expect(view.getByText(new RegExp(SAID))).toBeDefined();
    expect(view.getByText(/The Bot carried on from here\./)).toBeDefined();
    const text = view.container.textContent ?? "";
    expect(text).not.toContain("Outcome unknown");
    expect(text).not.toContain("do not make it again");
    expect(text).not.toContain("didn't work");
    // Not still happening, and not an alarm.
    expect(view.container.querySelector(".tool-line-running")).toBeNull();
    expect(view.container.querySelector(".text-destructive")).toBeNull();
    cleanup();
  }
});

test("a step that changes something says it was interrupted too, not that it was done", () => {
  const view = render(
    <ServerToolLine
      name="mcp__composio-gmail__GMAIL_SEND_EMAIL"
      result={CUT_OFF}
    />,
  );
  open(view.container);
  expect(view.getByText("Send email, interrupted")).toBeDefined();
  expect(view.container.textContent).not.toContain("Outcome unknown");
});

test("inside a folded run, a cut-off step is counted as interrupted and says so when opened", () => {
  const view = group([
    call("s", SEARCH, { objective: "Columbia River length" }, FOUND),
    call("f", FETCH, { urls: ["https://www.usgs.gov/columbia"] }, CUT_OFF),
  ]);
  // The line says what was done, and that one step was interrupted beside it.
  expect(view.getByText("Searched the web")).toBeDefined();
  expect(view.getByText("1 interrupted")).toBeDefined();
  expect(view.getByText("Interrupted")).toBeDefined();
  expect(view.getByText(new RegExp(SAID))).toBeDefined();
  const text = view.container.textContent ?? "";
  expect(text).not.toContain("Outcome unknown");
  expect(text).not.toContain("Didn't work");
  expect(text).not.toContain("issue");
  expect(text).not.toContain("read 1 page");
});

test("a run whose every step was cut off says so on its line", () => {
  const view = group([
    call("a", SEARCH, { objective: "one" }, CUT_OFF),
    call("b", SEARCH, { objective: "two" }, CUT_OFF),
  ]);
  expect(view.getByText("2 steps interrupted")).toBeDefined();
  expect(view.container.textContent).not.toContain("Searched the web");
});

test("a search on its own line reads as done once it has its results", () => {
  const done = render(<ServerToolLine name={SEARCH} result={FOUND} />);
  expect(done.getByText("Searched the web")).toBeDefined();
  expect(done.container.querySelector(".tool-line-running")).toBeNull();
  cleanup();
  // Still under way: what it is doing, moving.
  const running = render(<ServerToolLine name={SEARCH} />);
  expect(running.getByText("Search the web")).toBeDefined();
  expect(running.container.querySelector(".tool-line-running")).not.toBeNull();
});

test("the steps beside it read as they did: failed, blocked, and not completed", () => {
  const failed = render(
    <ServerToolLine name={SEARCH} result="The vendor reported an error: 503" />,
  );
  expect(failed.getByText("Search the web, didn't work")).toBeDefined();
  cleanup();
  const blocked = render(
    <ServerToolLine name={SEARCH} result="Refused. You declined it." />,
  );
  expect(blocked.getByText("Blocked: Search the web")).toBeDefined();
  cleanup();
  // The person stopped the run before this step answered: the turn is over and it has no result.
  const stopped = group([
    call("s", SEARCH, { objective: "one" }, FOUND),
    call("f", FETCH, { urls: ["https://www.usgs.gov/columbia"] }),
  ]);
  expect(stopped.getByText("Not completed")).toBeDefined();
  expect(stopped.container.textContent).not.toContain("Interrupted");
});
