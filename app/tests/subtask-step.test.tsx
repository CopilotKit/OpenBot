import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  CopilotChatConfigurationProvider,
  CopilotKitProvider,
} from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { subagentThreadId } from "@openbot/shared/subagent";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";
import { answered, handedBack, type RecordedSubtask } from "./subagent.fixture";

/**
 * A Bot's subtask, drawn by the real transcript as one step of the line its turn's work folds into,
 * from a call, a result and a subagent thread recorded off a real run (see the fixture). The
 * subagent's steps are read through the same route a conversation's history is, answered here the
 * way the server answered it, and only once its row is opened.
 */

const originalFetch = globalThis.fetch;
/** The subagent threads the history route serves, by id. */
const served = new Map<string, unknown[]>();

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost/").pathname;
      const id = /^\/api\/copilotkit\/threads\/([^/]+)\/messages$/.exec(
        path,
      )?.[1];
      const messages = id ? served.get(decodeURIComponent(id)) : undefined;
      return messages
        ? Response.json({ messages })
        : Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  served.clear();
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

/** The person's ask, the Bot's call, and its result when there is one. */
function turn(subtask: RecordedSubtask, settled: boolean): Message[] {
  return [
    {
      id: "ask",
      role: "user",
      content: "Which account needs attention first?",
    },
    {
      id: "call-message",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: subtask.call.id,
          type: "function",
          function: { name: subtask.call.name, arguments: subtask.call.args },
        },
      ],
    },
    ...(settled
      ? [
          {
            id: "result",
            role: "tool" as const,
            toolCallId: subtask.call.id,
            content: subtask.result,
          },
        ]
      : []),
  ];
}

function wrap(parentThreadId: string, transcript: ReactElement) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <CopilotChatConfigurationProvider
          agentId="general-assistant"
          threadId={parentThreadId}
        >
          {transcript}
        </CopilotChatConfigurationProvider>
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

async function draw(
  subtask: RecordedSubtask,
  { settled, busy }: { settled: boolean; busy: boolean },
  steps: unknown[] = subtask.subagent,
) {
  served.set(
    await subagentThreadId(subtask.parentThreadId, subtask.call.id),
    steps,
  );
  return render(
    wrap(
      subtask.parentThreadId,
      <ChatTranscript
        busy={busy}
        messages={turn(subtask, settled)}
        restoring={false}
      />,
    ),
  );
}

/** Opens a disclosure by its line, as a person clicking it would. */
function open(line: HTMLElement) {
  const details = line.closest("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

/** The subtask's own row, opened, from inside the turn's folded work line. */
async function subtaskRow(view: Awaited<ReturnType<typeof draw>>) {
  const row = (await view.findByText("Subtask")).closest("li") as HTMLElement;
  open(row.querySelector("summary") as HTMLElement);
  return within(row);
}

test("a subtask is one step of the turn's work line, not a card of its own", async () => {
  const view = await draw(answered, { settled: true, busy: false });
  expect(await view.findByText("Ran a subtask")).toBeTruthy();
  expect(view.container.querySelector("figure")).toBeNull();
  // Its own line says what it was asked and how many steps it took.
  const line = within(
    view.getByText("Subtask").closest("summary") as HTMLElement,
  );
  expect(line.getByText(/For customer account Birch Labs/)).toBeTruthy();
  expect(line.getByText("2 steps")).toBeTruthy();
});

test("while it works, the line says so, and the row opens to each step as the subagent takes it", async () => {
  // Its first step only: the subagent has asked for the account and the tickets, and nothing is back.
  const view = await draw(answered, { settled: false, busy: true }, [
    ...answered.subagent.slice(0, 2),
  ]);
  expect(await view.findByText("Working on a subtask…")).toBeTruthy();
  const row = await subtaskRow(view);
  expect(row.getByText("Working")).toBeTruthy();
  expect(await row.findByText("Get account")).toBeTruthy();
  expect(row.getByText("List open tickets")).toBeTruthy();
  expect(row.getAllByText("In progress")).toHaveLength(2);
});

test("when it is done, its row opens to the answer and the steps it took", async () => {
  const view = await draw(answered, { settled: true, busy: false });
  const row = await subtaskRow(view);
  // The answer, drawn as the Bot wrote it. The step that read the account says the same name inside it.
  expect(row.getAllByText(/Marco Diaz/).length).toBeGreaterThan(0);
  expect(await row.findByText("Get account")).toBeTruthy();
  expect(row.getByText("List open tickets")).toBeTruthy();
  // Finished steps do not say they are in progress.
  expect(row.queryByText("In progress")).toBeNull();
});

test("an action it handed back is said plainly, and nothing asks for an approval it cannot give", async () => {
  const view = await draw(handedBack, { settled: true, busy: false });
  expect(await view.findByText("Handed back")).toBeTruthy();
  expect(view.queryByText("Needs your approval")).toBeNull();
  const row = await subtaskRow(view);
  const notice = within(row.getByRole("region", { name: "Handed back" }));
  expect(
    notice.getByText(/the Bot asks you in this conversation/),
  ).toBeTruthy();
  expect(notice.getByText("List open tickets on accounts")).toBeTruthy();
  expect(notice.getByText("Acme Robotics")).toBeTruthy();
});

test("a subtask its turn left behind says it never finished, and one the server refused says so", async () => {
  const stopped = await draw(answered, { settled: false, busy: false });
  expect(await stopped.findByText("Not completed")).toBeTruthy();
  expect(stopped.queryByText("Working")).toBeNull();
  cleanup();

  const refused = await draw(
    {
      ...answered,
      result: JSON.stringify(
        "Refused. No subagent was started: one answer can start up to 5 subagents, and this one has. Do this part yourself.",
      ),
    },
    { settled: true, busy: false },
  );
  expect(await refused.findByText("Blocked")).toBeTruthy();
});

test("subtasks started together share one line that counts them while their turn runs", async () => {
  // Two calls in one step, neither answered yet: the second row is drawn under the first.
  const first = answered;
  const second = { ...handedBack, parentThreadId: answered.parentThreadId };
  const view = await draw(first, { settled: false, busy: true }, [
    ...first.subagent.slice(0, 2),
  ]);
  view.rerender(
    wrap(
      first.parentThreadId,
      <ChatTranscript
        busy
        messages={[
          ...turn(first, false),
          {
            id: "second-call",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: second.call.id,
                type: "function",
                function: {
                  name: second.call.name,
                  arguments: second.call.args,
                },
              },
            ],
          },
        ]}
        restoring={false}
      />,
    ),
  );
  expect(await view.findByText("Working on 2 subtasks…")).toBeTruthy();
  expect(view.getAllByText("Subtask")).toHaveLength(2);
  expect(view.getAllByText("Working")).toHaveLength(2);
  expect(view.queryByText("Not completed")).toBeNull();
});
