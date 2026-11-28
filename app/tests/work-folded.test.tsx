import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { SEND_FILE_TOOL } from "@openbot/shared/send-file";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { forgetOpenedLines } from "@/components/channels/tool-line";
import { CodingTools } from "@/lib/copilot/coding-tools";
import { ComputerTools } from "@/lib/copilot/computer-tools";
import { queryClient } from "@/query-client";
import { approvalInboxResponse } from "./approvals-api";
import { recorded } from "./coding-tools.fixture";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's work is folded in the conversation, and its answer is not.
 *
 * Reported from OpenBot Cloud: asked for the day's top five articles on a news site, a Bot ran one
 * `curl` piped into Python, and the conversation drew the command and every line it printed in a
 * terminal card the height of the window, so the five articles the person asked for sat below a
 * screen of raw output. Every step a Bot takes (a command, a file it wrote or changed, its plan, a
 * search) is now one line saying what was done, which the person opens if they want the detail.
 * What the person must see stays in view: the reply, and what the Bot hands them, such as a file.
 *
 * Drawn by the real transcript, through the renderers the app registers, from a conversation as a
 * reload or a replay has it: the calls and their stored answers.
 */

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // Each line asks whether OpenBot is waiting on the person about its call; nothing is.
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      const approvals = approvalInboxResponse(url.pathname, { requests: [] });
      if (approvals) return approvals;
      // The file the Bot sent is still there.
      if (url.pathname.includes("/attachments/"))
        return new Response(null, { status: 200 });
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  forgetOpenedLines();
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

/** What the Bot ran in the report, and the start of what it printed: a screen of it. */
const COMMAND =
  'curl -s "https://dev.to/api/articles?top=1&per_page=5" | python3 -c "import json,sys; [print(i, a[\'title\']) for i, a in enumerate(json.load(sys.stdin), 1)]"';
const PRINTED = Array.from(
  { length: 30 },
  (_, line) => `${line + 1} An article title | https://dev.to/a/${line + 1}`,
).join("\n");
const ANSWER = "Here are today's top five articles on Dev.to.";

type Call = { id: string; name: string; args: unknown; result?: string };

/** A turn: the person asks, the Bot makes each call, then answers in words if it has. */
function conversation(calls: Call[], answer?: string): Message[] {
  return [
    { id: "u1", role: "user", content: "What are the top 5 articles today?" },
    ...calls.flatMap((call, index): Message[] => [
      {
        id: `a-${index}`,
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments:
                typeof call.args === "string"
                  ? call.args
                  : JSON.stringify(call.args),
            },
          },
        ],
      },
      ...(call.result === undefined
        ? []
        : [
            {
              id: `t-${index}`,
              role: "tool" as const,
              toolCallId: call.id,
              content: call.result,
            },
          ]),
    ]),
    ...(answer
      ? [{ id: "a-end", role: "assistant" as const, content: answer }]
      : []),
  ];
}

function transcript(messages: Message[], busy = false) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <ComputerTools />
        <CodingTools />
        <ChatTranscript busy={busy} messages={messages} restoring={false} />
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

const ranCommand = (id: string, result?: string): Call => ({
  id,
  name: "computer_run_command",
  args: { command: COMMAND },
  ...(result === undefined ? {} : { result }),
});

const PRINTED_RESULT = JSON.stringify({
  ok: true,
  exitCode: 0,
  stdout: PRINTED,
  stderr: "",
});

/** The fold around a card, found by the card's own name. */
async function foldOf(
  view: ReturnType<typeof render>,
  card: string,
): Promise<HTMLDetailsElement> {
  const region = await view.findByRole("region", { name: card });
  const fold = region.closest("details");
  if (!fold) throw new Error(`"${card}" is drawn open in the conversation.`);
  return fold;
}

/** What the folded line says, read as a person would: the chevron is decoration. */
function lineOf(fold: HTMLDetailsElement): string {
  const summary = fold.querySelector("summary")?.cloneNode(true) as HTMLElement;
  for (const hidden of summary.querySelectorAll("[aria-hidden]"))
    hidden.remove();
  return summary.textContent ?? "";
}

test("a command the Bot ran is one line saying what ran, and opens to its terminal", async () => {
  const view = render(
    transcript(conversation([ranCommand("run-1", PRINTED_RESULT)], ANSWER)),
  );

  const fold = await foldOf(view, "Ran a command");
  expect(fold.open).toBe(false);
  expect(lineOf(fold)).toBe(`Ran a command${COMMAND}`);
  // The answer is in view, not behind anything.
  expect(view.getByText(ANSWER).closest("details")).toBeNull();

  // Opened, it is the terminal block as it always was: the command, the end of the output, the exit.
  fireEvent.click(fold.querySelector("summary") as HTMLElement);
  expect(fold.open).toBe(true);
  const block = view.getByRole("region", { name: "Ran a command" });
  expect(block.textContent).toContain(`$${COMMAND}`);
  expect(block.textContent).toContain("Exit 0");
  expect(block.textContent).toContain("30 An article title");
});

test("a line the person opened stays open when it is drawn again, and a reload folds it", async () => {
  const messages = conversation([ranCommand("run-2", PRINTED_RESULT)], ANSWER);
  const view = render(transcript(messages));
  const fold = await foldOf(view, "Ran a command");
  fireEvent.click(fold.querySelector("summary") as HTMLElement);
  expect(fold.open).toBe(true);

  // Drawn anew from nothing, as the SDK does when it replaces a renderer: still open.
  cleanup();
  const again = render(transcript(messages));
  expect((await foldOf(again, "Ran a command")).open).toBe(true);

  // A reload, or the conversation replayed another day: folded, as it was first drawn.
  cleanup();
  forgetOpenedLines();
  const reloaded = render(transcript(messages));
  expect((await foldOf(reloaded, "Ran a command")).open).toBe(false);
});

test("a command still running shimmers on its line, and goes still when it is done", async () => {
  const view = render(transcript(conversation([ranCommand("run-3")]), true));
  const running = await foldOf(view, "Ran a command");
  expect(running.open).toBe(false);
  expect(lineOf(running)).toBe(`Running a command${COMMAND}`);
  expect(
    running.querySelector("summary .tool-line-running")?.textContent,
  ).toContain("Running a command");

  view.rerender(
    transcript(conversation([ranCommand("run-3", PRINTED_RESULT)], ANSWER)),
  );
  const done = await foldOf(view, "Ran a command");
  expect(lineOf(done)).toBe(`Ran a command${COMMAND}`);
  expect(done.querySelector("summary .tool-line-running")).toBeNull();
});

test("a command that failed says so on its line, still folded", async () => {
  const view = render(
    transcript(
      conversation([
        ranCommand(
          "run-4",
          JSON.stringify({
            ok: true,
            exitCode: 2,
            stdout: "",
            stderr: "curl: (6) Could not resolve host: dev.to",
          }),
        ),
      ]),
    ),
  );
  const fold = await foldOf(view, "Ran a command");
  expect(fold.open).toBe(false);
  expect(lineOf(fold)).toBe(`Ran a command, exit 2${COMMAND}`);
});

test("a coding Bot's command, edits, new file and plan are each one folded line", async () => {
  const calls = [
    recorded.todoPlan,
    recorded.write,
    recorded.edit,
    recorded.run,
  ];
  const view = render(
    transcript(
      conversation(
        calls.map((call, index) => ({
          id: `code-${index}`,
          name: call.name,
          args: call.arguments,
          result: call.history,
        })),
        "greet.py prints its greeting.",
      ),
    ),
  );
  const lines = [
    [
      "Ran a command",
      "Ran a commandpython3 /private/tmp/claude-harness-run/work4/greet.py",
    ],
    ["Edited a file", "Edited a filegreet.py +1 −1"],
    ["Wrote a file", "Wrote a filegreet.py +38"],
  ];
  for (const [card, line] of lines) {
    const fold = await foldOf(view, card);
    expect(fold.open).toBe(false);
    expect(lineOf(fold)).toBe(line);
  }
  const plan = (await view.findByText("To-dos")).closest("details");
  expect(plan?.open).toBe(false);
  expect(lineOf(plan as HTMLDetailsElement)).toBe(
    "Updated the to-dos0 of 4 done",
  );
  expect(
    view.getByText("greet.py prints its greeting.").closest("details"),
  ).toBeNull();
});

test("a file the Bot sent the person stays in view beside its folded work", async () => {
  const view = render(
    transcript(
      conversation(
        [
          ranCommand("run-5", PRINTED_RESULT),
          {
            id: "send-1",
            name: SEND_FILE_TOOL,
            args: { path: "articles.csv" },
            result: JSON.stringify({
              ok: true,
              file: {
                attachmentId: "7f1c2a9e-0b5d-4c41-9a37-2f8e6d4b1c01",
                name: "articles.csv",
                mimeType: "text/csv",
                sizeBytes: 2048,
                url: "/api/attachments/7f1c2a9e-0b5d-4c41-9a37-2f8e6d4b1c01",
              },
            }),
          },
        ],
        ANSWER,
      ),
    ),
  );
  expect((await foldOf(view, "Ran a command")).open).toBe(false);
  const file = await view.findByRole("figure", {
    name: "File from the Bot: articles.csv",
  });
  expect(file.closest("details")).toBeNull();
});
