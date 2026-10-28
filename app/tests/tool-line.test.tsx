import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ServerToolLine } from "@/components/channels/chat-transcript";
import { ToolLine } from "@/components/channels/tool-line";
import { REFUSAL_MARKER } from "@/lib/plugins/tool-result";
import { SHOW_APP_ACCESS_TOOL } from "@openbot/shared/connect-prompt";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/**
 * What one line says about how a call went. Only a call that worked carries the done mark, and a
 * call that did not happen is never named as though it had.
 */

const DECLINED =
  "The person declined this action when you asked for their approval, so it was not done. This was their decision, not a policy or a boundary.";

test("a line that worked carries the done mark", () => {
  const view = render(<ToolLine label="Searched the web" />);
  expect(view.getByText("Searched the web")).toBeDefined();
  expect(view.container.querySelector(".text-status-done")).not.toBeNull();
});

test("a refusal, a failure and a decline each say so, and none is marked done", () => {
  for (const [props, words, tone] of [
    [{ refused: true }, "Blocked: Send email", ".text-status-problem"],
    [{ failed: true }, "Send email, didn't work", ".text-status-needs"],
    [{ declined: true }, "You declined: Send email", null],
  ] as const) {
    const view = render(<ToolLine label="Send email" {...props} />);
    const line = view.getByText(words);
    expect(view.container.querySelector(".text-status-done")).toBeNull();
    if (tone) expect(line.closest(tone)).not.toBeNull();
    else {
      // The person's own decision is not an error, so it is drawn in neither error colour.
      expect(line.closest(".text-status-problem")).toBeNull();
      expect(line.closest(".text-status-needs")).toBeNull();
    }
    cleanup();
  }
});

test("a running line shimmers and is not yet marked done", () => {
  const view = render(<ToolLine label="Searching the web" running />);
  expect(
    view.getByText("Searching the web").closest(".tool-line-running"),
  ).not.toBeNull();
  expect(view.container.querySelector(".text-status-done")).toBeNull();
});

test("a send the person declined is never named as sent, and its words to the Bot stay out", () => {
  const view = render(
    <ServerToolLine
      name="mcp__composio-gmail__GMAIL_SEND_EMAIL"
      result={JSON.stringify(DECLINED)}
    />,
  );
  expect(view.getByText("You declined: Send your email")).toBeDefined();
  expect(view.queryByText(/Sent your email/)).toBeNull();
  // Not expandable: what is behind it was written for the Bot.
  expect(view.container.querySelector("details")).toBeNull();
  expect(view.container.textContent).not.toContain("their decision");
});

test("a refused or failed call is named for what it would have done", () => {
  const refused = render(
    <ServerToolLine
      name="mcp__composio-gmail__GMAIL_SEND_EMAIL"
      result={`${REFUSAL_MARKER} Sending mail is not allowed here.`}
    />,
  );
  expect(refused.getByText("Blocked: Send your email")).toBeDefined();
  cleanup();

  const failed = render(
    <ServerToolLine
      name={SHOW_APP_ACCESS_TOOL}
      result="That tool could not be called: timeout"
    />,
  );
  expect(failed.getByText("Show app access, didn't work")).toBeDefined();
  expect(failed.queryByText(/Checked app access/)).toBeNull();
});

test("a call that worked is named for what it did", () => {
  const view = render(
    <ServerToolLine
      name="mcp__composio-gmail__GMAIL_FETCH_EMAILS"
      result={JSON.stringify("3 messages")}
    />,
  );
  expect(view.getByText("Read your email")).toBeDefined();
  expect(view.getByText("Gmail")).toBeDefined();
});
