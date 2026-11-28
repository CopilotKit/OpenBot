import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelChat } from "@/components/channels/channel-chat";
import { GALLERY as ACTIVITY } from "@/components/gallery/activity";
import { GALLERY as CARDS } from "@/components/gallery/cards";
import { GALLERY as CHARTS } from "@/components/gallery/charts";
import { GALLERY as DECISIONS } from "@/components/gallery/decisions";
import { UNREADABLE } from "@/components/gallery/failed";
import { GALLERY as FORMS } from "@/components/gallery/form";
import { GALLERY as QUOTES } from "@/components/gallery/quote";
import { GALLERY as TABLES } from "@/components/gallery/table";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { ActiveBotProvider } from "@/lib/copilot/active-bot";
import {
  GALLERY_COMPONENTS,
  type GalleryComponent,
} from "@/lib/copilot/gallery-registry";
import { GalleryTools } from "@/lib/copilot/gallery-tools";
import { queryClient } from "@/query-client";
import { botGrantsPath, botGrantsResponse } from "./bot-grants-api";
import { answerBotsList } from "./bots-api";
import {
  ANNOUNCE_COMPONENTS_PATH,
  announcedResponse,
  botComponentsPath,
  botComponentsResponse,
  CHECK_COMPONENT,
  checkResponse,
} from "./components-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A gallery call whose arguments are not what the component takes is answered as the mistake it is,
 * and nothing broken is drawn.
 *
 * FOUND BY THE AG-UI CONFORMANCE SUITE. A stock Microsoft Agent Framework agent on gpt-4o called
 * `showBarChart` with `labels` and `series`, the shape of a line chart, where the bar chart takes
 * `points`. The person saw an empty chart, "There is no data to chart.", and the agent was told "The
 * bar chart is now on screen for the person.", so it never learned the call was wrong. The handler
 * answered every call with the component's confirmation without reading its arguments.
 *
 * Driven as the app runs: the real chat, the real gallery tools and the CopilotKit core running the
 * calls, against a runtime that streams the Bot's calls and keeps the thread, so what the Bot was told
 * is read from the run the browser starts next, and the conversation is opened again from the thread.
 */

const NativeResponse = globalThis.Response;
const SINCE = "2026-11-25T09:00:00.000Z";

const GALLERY: GalleryComponent[] = [
  ...ACTIVITY,
  ...CARDS,
  ...CHARTS,
  ...DECISIONS,
  ...FORMS,
  ...QUOTES,
  ...TABLES,
];
const SHOWN = GALLERY.filter((component) => component.kind !== "decision");
const ASKED = GALLERY.filter((component) => component.kind === "decision");

let bots = 0;
let bot = "";
let channel: AgentChannel;
let stored: Message[] = [];
let runs: RunAgentInput[] = [];
type Call = { id: string; name: string; args: Record<string, unknown> };
type Turn = { step: Call[] } | { reply: string };
let turns: Turn[] = [];
let originalFetch: typeof fetch;
let originalSocket: typeof WebSocket;

class QuietSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  send() {}
  close() {}
}

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** What a run saves in the thread: the input messages the thread does not hold yet. */
function persisted(input: RunAgentInput): Message[] {
  const held = new Set(stored.map((message) => message.id));
  let thread = stored;
  for (const message of input.messages.filter((m) => !held.has(m.id))) {
    if (message.role === "tool")
      thread = thread.filter(
        (saved) =>
          saved.role !== "tool" || saved.toolCallId !== message.toolCallId,
      );
    thread = [...thread, message];
  }
  return thread;
}

function runEvents(input: RunAgentInput): unknown[] {
  const ids = { threadId: input.threadId, runId: input.runId };
  const started = { type: "RUN_STARTED", ...ids };
  const finished = { type: "RUN_FINISHED", ...ids };
  const turn = turns.shift() ?? { reply: "Done." };
  if ("step" in turn) {
    const messageId = `step-${input.runId}`;
    stored = [
      ...persisted(input),
      {
        id: messageId,
        role: "assistant",
        toolCalls: turn.step.map(({ id, name, args }) => ({
          id,
          type: "function" as const,
          function: { name, arguments: JSON.stringify(args) },
        })),
      },
    ];
    return [
      started,
      ...turn.step.flatMap(({ id, name, args }) => [
        {
          type: "TOOL_CALL_START",
          toolCallId: id,
          toolCallName: name,
          parentMessageId: messageId,
        },
        { type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(args) },
        { type: "TOOL_CALL_END", toolCallId: id },
      ]),
      finished,
    ];
  }
  const id = `reply-${input.runId}`;
  stored = [
    ...persisted(input),
    { id, role: "assistant", content: turn.reply },
  ];
  return [
    started,
    { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: turn.reply },
    { type: "TEXT_MESSAGE_END", messageId: id },
    finished,
  ];
}

beforeAll(() => {
  // `import.meta.glob` is Vite's, so under `bun test` the registry finds no gallery modules.
  GALLERY_COMPONENTS.push(...GALLERY);
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = QuietSocket as unknown as typeof WebSocket;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      const request = input instanceof Request ? input : new Request(url, init);
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { [bot]: { description: "Fixture", capabilities: {} } },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: stored },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      if (url.pathname.endsWith("/run")) {
        const body = RunAgentInputSchema.parse(await request.json());
        runs.push(body);
        return sse(runEvents(body));
      }
      if (url.pathname.match(/\/threads\/[^/]+\/messages$/))
        return NativeResponse.json({ messages: stored });
      const listed = answerBotsList(url, init, { visible: [] });
      if (listed) return listed;
      if (url.pathname === botGrantsPath(bot)) return botGrantsResponse();
      if (
        /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/voice-sessions$/.test(
          url.pathname,
        )
      )
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (
        /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/(activity|signal-busy)$/.test(
          url.pathname,
        )
      )
        return new NativeResponse(null, { status: 204 });
      if (url.pathname === ANNOUNCE_COMPONENTS_PATH) return announcedResponse();
      // The Bot holds every component.
      if (url.pathname === botComponentsPath(bot))
        return botComponentsResponse(
          GALLERY.map(({ name, description }) => ({ name, description })),
        );
      if (CHECK_COMPONENT.test(url.pathname))
        return checkResponse({ allowed: true });
      return NativeResponse.json({ error: "Not found" }, { status: 404 });
    },
    { preconnect: () => undefined },
  );
});

beforeEach(() => {
  bots += 1;
  bot = `arguments-bot-${bots}`;
  channel = {
    id: `arguments-channel-${bots}`,
    name: "Arguments test",
    agentIds: [bot],
    threadId: `arguments-thread-${bots}`,
    active: true,
    lastMessageAt: SINCE,
  };
  stored = [];
  runs = [];
  turns = [];
  sessionStorage.clear();
  queryClient.clear();
  queryClient.setQueryData<InfiniteData<ChannelPage>>(channelKeys.list(), {
    pages: [
      {
        channels: [
          {
            ...channel,
            summary: null,
            lastMessage: null,
            lastMessageAgentId: null,
            createdAt: SINCE,
            pinned: false,
            lastReadAt: null,
          } satisfies ChannelSummary,
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
});
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  for (const component of GALLERY)
    GALLERY_COMPONENTS.splice(GALLERY_COMPONENTS.indexOf(component), 1);
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
  GlobalRegistrator.unregister();
});

function app() {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <ActiveBotProvider>
          <GalleryTools />
          <ChannelChat channel={channel} runtimeAgentId={bot} />
        </ActiveBotProvider>
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

async function ask(view: ReturnType<typeof render>, text: string) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(await view.findByRole("textbox", { name: "Message" }), text);
  await user.click(view.getByRole("button", { name: "Send message" }));
}

/** Which of these phrases were ever on the page while it was watched, read on every change to it. */
function watch(phrases: readonly string[]) {
  const shown = new Set<string>();
  const look = () => {
    const text = document.body.textContent ?? "";
    for (const phrase of phrases) if (text.includes(phrase)) shown.add(phrase);
  };
  look();
  const observer = new MutationObserver(look);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  return {
    shown: () => phrases.filter((phrase) => shown.has(phrase)),
    stop: () => observer.disconnect(),
  };
}

/** The answer each call got, in what the browser sent with its next run. */
function answersIn(run: RunAgentInput | undefined): Record<string, string> {
  return Object.fromEntries(
    (run?.messages ?? []).flatMap((message) =>
      message.role === "tool"
        ? [[message.toolCallId, String(message.content)]]
        : [],
    ),
  );
}

const failure = (title: string) => `Couldn't show the ${title.toLowerCase()}.`;

/** The conformance suite's call, word for word in shape: a line chart's arguments for a bar chart. */
const LABELS_AND_SERIES = {
  title: "Quarterly revenue",
  labels: ["Q1", "Q2", "Q3", "Q4"],
  series: [{ name: "Revenue", data: [120, 135, 160, 180] }],
};

test("a bar chart called with labels and series tells the Bot what was wrong, and draws no empty chart", async () => {
  turns = [
    {
      step: [{ id: "chart", name: "showBarChart", args: LABELS_AND_SERIES }],
    },
    { reply: "I sent the chart in the wrong shape. Here it is again." },
  ];
  const seen = watch(["There is no data to chart."]);
  const view = render(app());

  await ask(view, "Chart our quarterly revenue.");
  expect(
    await view.findByText(
      "I sent the chart in the wrong shape. Here it is again.",
      {},
      { timeout: 5000 },
    ),
  ).toBeTruthy();
  seen.stop();

  // The Bot is told what was wrong, by field, and not that the chart is on screen.
  const told = answersIn(runs[1]).chart ?? "";
  expect(told).not.toBe(
    CHARTS.find((component) => component.name === "showBarChart")
      ?.confirmation ?? "",
  );
  expect(told).toStartWith("Error: showBarChart was not shown");
  expect(told).toMatch(/points: [^.;]*expected array/);
  expect(told).toContain("It doesn't take labels or series.");
  expect(told).toContain("Its fields are title, caption, basis");
  expect(told).toContain("Call showBarChart again");

  // The person sees the chart couldn't be shown, never an empty chart, not even for a moment.
  expect(view.getByText(failure("Bar chart"))).toBeTruthy();
  expect(view.getByText(UNREADABLE)).toBeTruthy();
  expect(seen.shown()).toEqual([]);

  // Opened again from the thread: the same.
  cleanup();
  const reopened = render(app());
  expect(
    await reopened.findByText(failure("Bar chart"), {}, { timeout: 5000 }),
  ).toBeTruthy();
  expect(reopened.queryByText("There is no data to chart.")).toBeNull();
});

test("a bar chart called with the arguments it takes is drawn and confirmed, as before", async () => {
  const chart = CHARTS.find((component) => component.name === "showBarChart");
  turns = [
    {
      step: [
        {
          id: "chart",
          name: "showBarChart",
          args: {
            title: "Quarterly revenue",
            basis: "given",
            points: [
              { label: "Q1", value: 120 },
              { label: "Q2", value: 135 },
            ],
          },
        },
      ],
    },
    { reply: "Here is the chart." },
  ];
  const view = render(app());

  await ask(view, "Chart our quarterly revenue.");
  expect(
    await view.findByText("Here is the chart.", {}, { timeout: 5000 }),
  ).toBeTruthy();
  expect(answersIn(runs[1]).chart).toBe(chart?.confirmation ?? "");
  expect(view.getByText("Quarterly revenue")).toBeTruthy();
  expect(view.queryByText(failure("Bar chart"))).toBeNull();
});

test("a null where a field may be left out is read as left out, as before", async () => {
  const chart = CHARTS.find((component) => component.name === "showBarChart");
  turns = [
    {
      step: [
        {
          id: "chart",
          name: "showBarChart",
          args: {
            title: "Quarterly revenue",
            caption: null,
            basis: "given",
            asOf: null,
            points: [{ label: "Q1", value: 120, link: null }],
          },
        },
      ],
    },
    { reply: "Here is the chart." },
  ];
  const view = render(app());

  await ask(view, "Chart our quarterly revenue.");
  expect(
    await view.findByText("Here is the chart.", {}, { timeout: 5000 }),
  ).toBeTruthy();
  expect(answersIn(runs[1]).chart).toBe(chart?.confirmation ?? "");
  expect(view.queryByText(failure("Bar chart"))).toBeNull();
});

test("every component shown with arguments it doesn't take tells the Bot which, and shows it couldn't be drawn", async () => {
  turns = [
    {
      step: SHOWN.map((component) => ({
        id: `call-${component.name}`,
        name: component.name,
        args: { heading: "Not a field of any component" },
      })),
    },
    { reply: "I'll send those again." },
  ];
  const view = render(app());

  await ask(view, "Show me everything.");
  expect(
    await view.findByText("I'll send those again.", {}, { timeout: 5000 }),
  ).toBeTruthy();

  const told = answersIn(runs[1]);
  for (const component of SHOWN) {
    const answer = told[`call-${component.name}`] ?? "";
    expect(answer).toStartWith(`Error: ${component.name} `);
    expect(answer).toContain("heading");
    expect(answer).not.toBe(component.confirmation);
    expect(view.getByText(failure(component.title))).toBeTruthy();
  }
});

test("every card that asks the person something, called with arguments it doesn't take, is answered for the Bot and asks nobody", async () => {
  turns = [
    {
      step: ASKED.map((component) => ({
        id: `call-${component.name}`,
        name: component.name,
        args: { heading: "Not a field of any component" },
      })),
    },
    { reply: "I'll ask again properly." },
  ];
  const view = render(app());

  await ask(view, "Ask me something.");
  expect(
    await view.findByText("I'll ask again properly.", {}, { timeout: 5000 }),
  ).toBeTruthy();

  const told = answersIn(runs[1]);
  for (const component of ASKED) {
    const answer = told[`call-${component.name}`] ?? "";
    expect(answer).toStartWith(`Error: ${component.name} `);
    expect(answer).toContain("heading");
    expect(view.getByText(failure(component.title))).toBeTruthy();
  }
  expect(
    view.queryByRole("button", { name: /Approve|Submit answers/ }),
  ).toBeNull();
});
