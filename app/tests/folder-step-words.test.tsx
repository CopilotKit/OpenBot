import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { VisibleChatItem } from "../src/components/channels/chat-messages";
import { ServerToolLine } from "../src/components/channels/chat-transcript";
import { stepDetails } from "../src/components/channels/tool-activity";
import { REFUSAL_MARKER } from "../src/lib/plugins/tool-result";
import { settleReactWork } from "./settle-react-work";

/**
 * A step on a folder on the person's computer, as the conversation draws it.
 *
 * FOUND ON WINDOWS: the person pressed Deny on OpenBot Desktop's "Allow this file change?" and the
 * step read "Blocked: Saved a file", past tense for a file that was never saved. A blocked step says
 * what was tried, and which file, the way a blocked step on the Bot's own computer does
 * ("Blocked: Save file  notes.txt · You declined it.").
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** What the desktop answers when the person presses Deny, behind the server's refusal marker. */
const DECLINED = `${REFUSAL_MARKER} Declined in OpenBot Desktop.`;

const write = JSON.stringify({
  grantId: "host-grant-1",
  path: "todo.txt",
  content: "pick up dry cleaning\n",
});

function line(name: string, args: string, result?: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ServerToolLine args={args} name={name} result={result} />
    </QueryClientProvider>,
  );
}

test("a blocked file change says what was tried, and on which file", () => {
  const view = line("host_write_file", write, DECLINED);
  const text = view.container.textContent ?? "";
  expect(text).toContain("Blocked: Save a file");
  expect(text).toContain("todo.txt");
  expect(text).not.toContain("Saved a file");
});

test("every folder step that is blocked reads as what was tried", () => {
  const cases = [
    ["host_list_files", { grantId: "g" }, "Blocked: List files"],
    ["host_read_file", { grantId: "g", path: "a.md" }, "Blocked: Read a file"],
    [
      "host_run_command",
      { grantId: "g", command: "dir" },
      "Blocked: Run a command",
    ],
    ["host_list_folders", {}, "Blocked: Check your folders"],
  ] as const;
  for (const [name, args, words] of cases) {
    const view = line(name, JSON.stringify(args), DECLINED);
    expect(view.container.textContent).toContain(words);
    view.unmount();
  }
});

test("a file change that happened keeps its past tense, and names the file too", () => {
  const view = line("host_write_file", write, JSON.stringify({ ok: true }));
  const text = view.container.textContent ?? "";
  expect(text).toContain("Saved a file");
  expect(text).toContain("todo.txt");
  expect(text).not.toContain("Blocked");
});

test("in a folded run, a blocked folder step is named for what was tried beside Blocked", () => {
  const item: Extract<VisibleChatItem, { kind: "tool" }> = {
    kind: "tool",
    id: "w",
    toolCall: {
      id: "w",
      type: "function",
      function: { name: "host_write_file", arguments: write },
    },
    result: DECLINED,
  };
  expect(stepDetails(item)).toMatchObject({
    refused: true,
    label: "Save a file",
  });
  const { result: _blocked, ...running } = item;
  expect(stepDetails(running)).toMatchObject({ label: "Saving a file" });
});
