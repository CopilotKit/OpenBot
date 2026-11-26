import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { VisibleChatItem } from "../src/components/channels/chat-messages";
import {
  groupToolSteps,
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
  args: Record<string, unknown>,
  result: unknown,
): ToolItem {
  return {
    kind: "tool",
    id,
    toolCall: {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
    result: typeof result === "string" ? result : JSON.stringify(result),
  };
}

const PAGE = "https://the-internet.herokuapp.com/login";
const EMAIL = "sam@example.com";
const PASSWORD = "hunter2-SuperSecret!";

/**
 * A sign-in, as the conversation stores it: the computer's own answers, each acting step carrying
 * the element the computer resolved from the snapshot: its role and its accessible name.
 */
const SIGN_IN: ToolItem[] = [
  call(
    "open",
    "computer_navigate",
    { url: PAGE },
    {
      ok: true,
      url: PAGE,
      title: "The Internet",
    },
  ),
  call(
    "look",
    "computer_snapshot",
    {},
    {
      snapshotId: 4,
      url: PAGE,
      title: "The Internet",
      truncated: false,
      elements: [
        { ref: "e3", role: "textbox", name: "Email address", type: "email" },
        { ref: "e4", role: "textbox", name: "Password", type: "password" },
        { ref: "e5", role: "button", name: "Sign in" },
      ],
    },
  ),
  call(
    "email",
    "computer_type",
    { ref: "e3", snapshotId: 4, text: EMAIL },
    {
      ok: true,
      action: "type",
      ref: "e3",
      url: PAGE,
      element: { role: "textbox", name: "Email address" },
    },
  ),
  call(
    "password",
    "computer_type",
    { ref: "e4", snapshotId: 4, text: PASSWORD, submit: true },
    {
      ok: true,
      action: "type",
      ref: "e4",
      url: PAGE,
      element: { role: "textbox", name: "Password" },
    },
  ),
  call(
    "submit",
    "computer_click",
    { ref: "e5", snapshotId: 4 },
    {
      ok: true,
      action: "click",
      ref: "e5",
      url: PAGE,
      element: { role: "button", name: "Sign in" },
    },
  ),
];

function opened(steps: ToolItem[]) {
  const grouped = groupToolSteps(steps, () => false);
  expect(grouped).toHaveLength(1);
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ToolActivity group={grouped[0] as ToolGroup} active={false} />
    </QueryClientProvider>,
  );
  fireEvent.click(view.getByText("Browsed the-internet.herokuapp.com"));
  return view;
}

/** Each step's line, as a person reads it: its words, then what it acted on. */
function lines(view: ReturnType<typeof render>): string[] {
  return [...view.container.querySelectorAll("ol > li")].map((li) =>
    (li.textContent ?? "").trim(),
  );
}

test("an opened browse step names the field it filled in and the button it clicked, never what was typed", () => {
  // Found in the 1.2.0-rc.6 Mac install test: every field said "Filled in field", and which one
  // was only on the approval card, if there was one.
  const view = opened(SIGN_IN);
  expect(lines(view)).toEqual([
    "Opened pageThe Internet",
    "Inspected page",
    "Filled in fieldEmail address",
    "Filled in fieldPassword",
    "Clicked on pageSign in",
  ]);
  const shown = view.container.textContent ?? "";
  expect(shown).not.toContain(EMAIL);
  expect(shown).not.toContain(PASSWORD);
  expect(shown).not.toContain("hunter2");
});

test("a field whose label repeats what was typed in it is not named, so the value never shows", () => {
  // A page can set a field's label from what is in it (`aria-label` kept in step with the value).
  // The field is then named by its value, and a password would be drawn on the step.
  const echoing = call(
    "echo",
    "computer_type",
    { ref: "e4", snapshotId: 4, text: PASSWORD },
    {
      ok: true,
      action: "type",
      ref: "e4",
      url: PAGE,
      element: { role: "textbox", name: `Password ${PASSWORD}` },
    },
  );
  const view = opened([SIGN_IN[0] as ToolItem, echoing]);
  expect(lines(view)).toEqual(["Opened pageThe Internet", "Filled in field"]);
  expect(view.container.textContent ?? "").not.toContain("hunter2");
});
