import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type InfiniteData,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, render, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { VisibleChatItem } from "@/components/channels/chat-messages";
import {
  type ConversationStep,
  ConversationPresenceProvider,
} from "@/components/channels/conversation-presence";
import { ConversationView } from "@/components/channels/conversation-view";
import { StepLog, stepLogEntries } from "@/components/computer/step-log";
import type { ApprovalInboxData } from "@/lib/approvals";
import { type ChannelPage, channelKeys } from "@/lib/channels/queries";
import {
  type ComputerActivity,
  clearActivity,
  recordActivity,
} from "@/lib/computers/activity";
import { settleReactWork } from "./settle-react-work";

/**
 * The step log under the Bot's screen: what the Bot did on its computer, oldest first and newest
 * last. Browser steps come from the conversation's messages, because a click the person approves
 * runs on the server and never reaches a browser handler; commands and files come from this
 * session's command log, which has what they printed. Each step is named in the words its line in
 * the conversation uses, and says how it went in the status colours: done, waiting for you, failed.
 */

const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
beforeEach(() => {
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  clearActivity("ana");
  setSystemTime();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

type ToolItem = Extract<VisibleChatItem, { kind: "tool" }>;

function call(
  id: string,
  name: string,
  args: Record<string, unknown>,
  result?: unknown,
): ToolItem {
  return {
    kind: "tool",
    id,
    toolCall: {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
    ...(result === undefined
      ? {}
      : {
          result: typeof result === "string" ? result : JSON.stringify(result),
        }),
  };
}

function step(item: ToolItem, at: number, latest = true): ConversationStep {
  return { item, at, latest };
}

function command(
  id: string,
  at: number,
  patch: Partial<ComputerActivity> = {},
): ComputerActivity {
  return {
    id,
    at,
    kind: "command",
    subject: "rg --version",
    output: "ripgrep 14.1.0\n",
    exitCode: 0,
    ...patch,
  };
}

const OPENED = call(
  "nav",
  "computer_navigate",
  { url: "https://example.com" },
  { ok: true, url: "https://example.com/", title: "Example Domain" },
);
const at = { working: false, held: new Set<string>() };

describe("the order", () => {
  test("browser steps and commands interleave by when they happened, newest last", () => {
    const entries = stepLogEntries(
      [
        step(OPENED, 1000),
        step(
          call("click", "computer_click", { ref: "e1" }, { ok: true }),
          3000,
        ),
      ],
      [
        command("ran", 2000),
        command("read", 4000, { kind: "read_file", subject: "notes.md" }),
      ],
      at,
    );
    expect(entries.map((entry) => entry.id)).toEqual([
      "nav",
      "ran",
      "click",
      "read",
    ]);
  });

  test("steps seen at the same moment keep the conversation's order", () => {
    const entries = stepLogEntries(
      [
        step(call("b", "computer_click", { ref: "e1" }, { ok: true }), 1000),
        step(call("a", "computer_scroll", {}, { ok: true }), 1000),
      ],
      [],
      at,
    );
    expect(entries.map((entry) => entry.id)).toEqual(["b", "a"]);
  });
});

describe("how each step stands", () => {
  const pendingClick = call("click", "computer_click", { ref: "e1" });
  const states = (
    steps: ConversationStep[],
    context: { working: boolean; held: ReadonlySet<string> } = at,
  ) => stepLogEntries(steps, [], context).map((entry) => entry.status);

  test("a step that worked is done", () => {
    expect(states([step(OPENED, 1)])).toEqual(["done"]);
  });

  test("a step held on its approval card waits for the person", () => {
    expect(
      states([step(pendingClick, 1)], {
        working: false,
        held: new Set(["click"]),
      }),
    ).toEqual(["waiting"]);
    // Whatever its result says yet: the note that it went to the card is not the click.
    const noted = call(
      "click",
      "computer_click",
      { ref: "e1" },
      {
        waiting: true,
      },
    );
    expect(
      states([step(noted, 1)], { working: false, held: new Set(["click"]) }),
    ).toEqual(["waiting"]);
    // Allowed, the server runs it, and until its result arrives it is in progress.
    expect(
      states([step(noted, 1)], { working: true, held: new Set() }),
    ).toEqual(["running"]);
  });

  test("a step without a result runs only in the turn the Bot is on", () => {
    expect(
      states([step(pendingClick, 1)], { working: true, held: new Set() }),
    ).toEqual(["running"]);
    // Cut off: an earlier turn's call never got its result, or the Bot has stopped.
    expect(
      states([step(pendingClick, 1, false)], {
        working: true,
        held: new Set(),
      }),
    ).toEqual(["stopped"]);
    expect(states([step(pendingClick, 1)])).toEqual(["stopped"]);
  });

  test("refused, failed, declined, not yet done and stopped are told apart", () => {
    expect(
      states([
        step(
          call(
            "refused",
            "computer_click",
            { ref: "e1" },
            { ok: false, refused: true, reason: "Sending is off." },
          ),
          1,
        ),
        step(
          call(
            "failed",
            "computer_click",
            { ref: "e1" },
            { ok: false, reason: "That button is gone." },
          ),
          2,
        ),
        step(
          call(
            "declined",
            "computer_click",
            { ref: "e1" },
            "The person declined this action when you asked for their approval, so it was not done.",
          ),
          3,
        ),
        step(
          call(
            "starting",
            "computer_click",
            { ref: "e1" },
            { ok: false, starting: true, reason: "Still starting." },
          ),
          4,
        ),
        step(
          call(
            "stopped",
            "computer_click",
            { ref: "e1" },
            { ok: false, stopped: true, reason: "Stopped." },
          ),
          5,
        ),
      ]),
    ).toEqual(["blocked", "failed", "declined", "notYet", "stopped"]);
  });

  test("a command that exited non-zero failed, and one a boundary refused is blocked", () => {
    const entries = stepLogEntries(
      [],
      [
        command("ok", 1),
        command("bad", 2, { exitCode: 2, output: "no such file" }),
        command("refused", 3, { refused: true, output: "sudo is off." }),
      ],
      at,
    );
    expect(entries.map((entry) => entry.status)).toEqual([
      "done",
      "failed",
      "blocked",
    ]);
  });
});

function inboxWith(pending: string[]): ApprovalInboxData {
  return {
    enabled: true,
    requests: pending.map((toolCallId, index) => ({
      id: `r-${index}`,
      status: "pending",
      createdAt: "2026-10-28T00:00:00.000Z",
      action: {
        botId: "ana",
        toolRef: "computer/click",
        effect: "write",
        scope: "external",
        threadId: "t-1",
        toolCallId,
        args: {},
        target: {},
      },
    })),
    rules: [],
    teamRules: [],
    questions: [],
  };
}

function listOf(): InfiniteData<ChannelPage> {
  return {
    pages: [{ channels: [], nextCursor: null }],
    pageParams: [""],
  };
}

const asked = (id: string, content: string): Message => ({
  id,
  role: "user",
  content,
});

/** An assistant message calling `name`, and its result when there is one. */
function called(
  id: string,
  name: string,
  args: Record<string, unknown>,
  result?: unknown,
): Message[] {
  const message: Message = {
    id: `${id}-call`,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
  return result === undefined
    ? [message]
    : [
        message,
        {
          id: `${id}-result`,
          role: "tool",
          toolCallId: id,
          content: JSON.stringify(result),
        },
      ];
}

/** The conversation reporting into the route's presence, and the pane's step log reading it. */
function renderPane(
  chat: ReactNode,
  { inbox = inboxWith([]) }: { inbox?: ApprovalInboxData } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(channelKeys.list(), listOf());
  client.setQueryData(["approvals"], inbox);
  const tree = (screen: ReactNode) => (
    <QueryClientProvider client={client}>
      <CopilotKitProvider>
        <ConversationPresenceProvider channelId="c-1" threadId="t-1">
          {screen}
          <section aria-label="Steps">
            <StepLog computerId="ana" />
          </section>
        </ConversationPresenceProvider>
      </CopilotKitProvider>
    </QueryClientProvider>
  );
  const view = render(tree(chat));
  return {
    view,
    show: (screen: ReactNode) => act(() => view.rerender(tree(screen))),
    log: () => within(view.getByRole("region", { name: "Steps" })),
    rows: () =>
      Array.from(
        view.getByRole("region", { name: "Steps" }).querySelectorAll("li"),
      ).map((row) => row.getAttribute("data-step")),
  };
}

function Chat({
  busy = false,
  messages,
}: {
  busy?: boolean;
  messages: Message[];
}) {
  return (
    <ConversationView
      busy={busy}
      channelId="c-1"
      messages={messages}
      onSubmit={() => {}}
      pending={busy}
    />
  );
}

describe("the step log under the screen", () => {
  test("says what will appear while there is nothing yet", () => {
    const pane = renderPane(<Chat messages={[]} />);
    expect(
      pane
        .log()
        .getByText(
          "Nothing yet. Pages the Bot opens and commands it runs appear here.",
        ),
    ).toBeTruthy();
  });

  test("reads the conversation's browser steps, a gated click included, in the tool line's words", () => {
    const pane = renderPane(
      <Chat
        messages={[
          asked("u1", "Book the table."),
          ...called(
            "nav",
            "computer_navigate",
            { url: "https://example.com" },
            { ok: true, url: "https://example.com/", title: "Example Domain" },
          ),
          // Held on its card: the server runs it once the person allows it.
          ...called("click", "computer_click", { ref: "e7" }),
        ]}
      />,
      { inbox: inboxWith(["click"]) },
    );
    const log = pane.log();
    expect(log.getByText("Opened page")).toBeTruthy();
    expect(log.getByText("Example Domain")).toBeTruthy();
    expect(log.getByText("Clicked on page")).toBeTruthy();
    const waiting = log.getByText("Waiting for you");
    expect(waiting.className).toContain("text-status-needs");
    // Done is said by its mark, in the done colour.
    const done = log.getByText("Opened page").closest("li");
    expect(done?.querySelector(".text-status-done")).not.toBeNull();
  });

  test("a step that did not work says so in the problem colour, with why", () => {
    const pane = renderPane(
      <Chat
        messages={[
          asked("u1", "Press it."),
          ...called(
            "click",
            "computer_click",
            { ref: "e1" },
            { ok: false, reason: "That button is gone." },
          ),
        ]}
      />,
    );
    const failed = pane.log().getByText("Didn't work");
    expect(failed.className).toContain("text-status-problem");
    expect(pane.log().getByText("That button is gone.")).toBeTruthy();
  });

  test("steps and commands land where they happened, newest last, as the Bot works", () => {
    setSystemTime(new Date("2026-10-28T10:00:00.000Z"));
    const opened = [
      asked("u1", "Check the page, then the logs."),
      ...called(
        "nav-live",
        "computer_navigate",
        { url: "https://example.com" },
        { ok: true, url: "https://example.com/", title: "Example Domain" },
      ),
    ];
    const pane = renderPane(<Chat busy messages={opened} />);

    setSystemTime(new Date("2026-10-28T10:00:05.000Z"));
    act(() =>
      recordActivity("ana", {
        kind: "command",
        subject: "tail -n 20 app.log",
        output: "ready\n",
        exitCode: 0,
      }),
    );

    setSystemTime(new Date("2026-10-28T10:00:09.000Z"));
    pane.show(
      <Chat
        busy
        messages={[...opened, ...called("scroll-live", "computer_scroll", {})]}
      />,
    );

    expect(pane.rows()).toEqual([
      "nav-live",
      expect.any(String),
      "scroll-live",
    ]);
    const rows = pane.view
      .getByRole("region", { name: "Steps" })
      .querySelectorAll("li");
    expect(rows[1]?.textContent).toContain("Ran a command");
    expect(rows[1]?.textContent).toContain("tail -n 20 app.log");
    // The newest step is the one the Bot is on.
    expect(rows[2]?.textContent).toContain("In progress");
  });

  test("a step keeps its place when the conversation is opened again", () => {
    setSystemTime(new Date("2026-10-28T10:00:00.000Z"));
    const messages = [
      asked("u1", "Open it."),
      ...called(
        "nav-again",
        "computer_navigate",
        { url: "https://example.com" },
        { ok: true, url: "https://example.com/", title: "Example Domain" },
      ),
    ];
    const first = renderPane(<Chat messages={messages} />);
    first.view.unmount();

    setSystemTime(new Date("2026-10-28T10:00:05.000Z"));
    recordActivity("ana", {
      kind: "list_files",
      subject: "the workspace",
      output: "notes.md",
    });

    setSystemTime(new Date("2026-10-28T10:00:09.000Z"));
    const second = renderPane(<Chat messages={messages} />);
    expect(second.rows()).toEqual(["nav-again", expect.any(String)]);
  });
});
