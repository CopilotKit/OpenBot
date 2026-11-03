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
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { SubagentTool } from "@/lib/copilot/subagent-tool";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";
import { answered, handedBack, type RecordedSubtask } from "./subagent.fixture";

/**
 * A Bot's subtask, drawn by the real transcript through the renderer the app registers, from a call,
 * a result and a subagent thread recorded off a real run (see the fixture). The subagent's steps are
 * read through the same route a conversation's history is, answered here the way the server
 * answered it.
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
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <CopilotChatConfigurationProvider
          agentId="general-assistant"
          threadId={subtask.parentThreadId}
        >
          <SubagentTool />
          <ChatTranscript
            busy={busy}
            messages={turn(subtask, settled)}
            restoring={false}
          />
        </CopilotChatConfigurationProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

const card = async (view: Awaited<ReturnType<typeof draw>>) =>
  within((await view.findByText("Subtask")).closest("figure") as HTMLElement);

test("while it works, the card shows the task and each step as the subagent takes it", async () => {
  // Its first step only: the subagent has asked for the account and the tickets, and nothing is back.
  const view = await draw(answered, { settled: false, busy: true }, [
    ...answered.subagent.slice(0, 2),
  ]);
  const subtask = await card(view);
  expect(subtask.getByText("Working")).toBeTruthy();
  expect(subtask.getByText(/For customer account Birch Labs/)).toBeTruthy();
  expect(await subtask.findByText("Get account")).toBeTruthy();
  expect(subtask.getByText("List open tickets")).toBeTruthy();
  expect(subtask.getAllByText("In progress")).toHaveLength(2);
  expect(subtask.getByText(/2 steps so far/)).toBeTruthy();
});

test("when it is done, the card shows the answer, and opens to the steps it took", async () => {
  const view = await draw(answered, { settled: true, busy: false });
  const subtask = await card(view);
  expect(subtask.getByText("Done")).toBeTruthy();
  // The answer, drawn as the Bot wrote it. The step that read the account says the same name inside it.
  expect(subtask.getAllByText(/Marco Diaz/).length).toBeGreaterThan(0);
  const steps = await subtask.findByText("Show 2 steps");
  fireEvent.click(steps);
  expect(subtask.getByText("Get account")).toBeTruthy();
  expect(subtask.getByText("List open tickets")).toBeTruthy();
  // Finished steps do not say they are in progress.
  expect(subtask.queryByText("In progress")).toBeNull();
});

test("an action it handed back is said plainly, with what it would have done", async () => {
  const view = await draw(handedBack, { settled: true, busy: false });
  const subtask = await card(view);
  expect(subtask.getByText("Needs your approval")).toBeTruthy();
  const notice = within(
    subtask.getByRole("region", { name: "Needs your approval" }),
  );
  expect(notice.getByText("List open tickets on accounts")).toBeTruthy();
  expect(
    notice.getByText(/you're asked about it in this conversation/),
  ).toBeTruthy();
  expect(notice.getByText("Acme Robotics")).toBeTruthy();
});

test("a subtask its turn left behind says it never finished, and one the server refused says so", async () => {
  const stopped = await card(
    await draw(answered, { settled: false, busy: false }),
  );
  expect(stopped.getByText("Not completed")).toBeTruthy();
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
  expect(await refused.findByText("Blocked: Subtask")).toBeTruthy();
});

test("subtasks started together all say they are working while their turn runs", async () => {
  // Two calls in one step, neither answered yet: the second row is drawn under the first.
  const first = answered;
  const second = { ...handedBack, parentThreadId: answered.parentThreadId };
  served.set(
    await subagentThreadId(second.parentThreadId, second.call.id),
    second.subagent.slice(0, 2),
  );
  const view = await draw(first, { settled: false, busy: true }, [
    ...first.subagent.slice(0, 2),
  ]);
  view.rerender(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <CopilotChatConfigurationProvider
          agentId="general-assistant"
          threadId={first.parentThreadId}
        >
          <SubagentTool />
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
          />
        </CopilotChatConfigurationProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  expect(await view.findAllByText("Subtask")).toHaveLength(2);
  expect(view.getAllByText("Working")).toHaveLength(2);
  expect(view.queryByText("Not completed")).toBeNull();
});
