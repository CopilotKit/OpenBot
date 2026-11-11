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
import { NOT_RUN_AFTER_FAILURE } from "@openbot/shared/approval-outcomes";
import { NOT_ASKED, NOT_DRAWN } from "@openbot/shared/tool-steps";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelChat } from "@/components/channels/channel-chat";
import { GALLERY as CHARTS } from "@/components/gallery/charts";
import { GALLERY as DECISIONS } from "@/components/gallery/decisions";
import { GALLERY as TABLES } from "@/components/gallery/table";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { ActiveBotProvider } from "@/lib/copilot/active-bot";
import { ComputerTools } from "@/lib/copilot/computer-tools";
import { GALLERY_COMPONENTS } from "@/lib/copilot/gallery-registry";
import { GalleryTools } from "@/lib/copilot/gallery-tools";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A step: the tool calls a Bot asks for in one response. Claude asks for several at once by default,
 * and two things went wrong with that in the browser.
 *
 * It drew before it read. General Assistant asked for its searches and the chart and table meant to
 * show them in the same step, so they were drawn with figures it had not read, and it then wrote
 * under them that it had drawn them before it read the results. And a form's fields typed in one
 * step went to the browser as one batch, with nothing to stop the rest when one failed.
 *
 * These drive the app as it runs: the real chat, the real computer tools behind the real approval
 * wrapper, the real gallery, and the CopilotKit core executing the calls, against a runtime that
 * streams a step the way the built-in Bot does (its own searches answered inside the run) and a gate
 * that answers as the real one does. See `shared/tool-steps.ts`.
 */

const NativeResponse = globalThis.Response;
const SINCE = "2026-11-10T09:00:00.000Z";

let bots = 0;
let bot = "";
let channel: AgentChannel;

/** The thread as the runtime has stored it. */
let stored: Message[] = [];
let runs: RunAgentInput[] = [];
/** One call of a step. `answered` is a search the Bot's own runtime answers inside the run. */
type Call = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  answered?: string;
};
/** What the Bot does on each of its runs, in order: ask for one step's calls, or answer in words. */
type Turn = { step: Call[] } | { reply: string };
let turns: Turn[] = [];
/** The steps the gate was sent, in the order they arrived, and how many were in flight at once. */
let gated: { toolCallId: string; args: Record<string, unknown> }[] = [];
let inFlight = 0;
let mostInFlight = 0;
/** How the gate answers a typing step, by the ref it types into. */
let gate: (ref: string) => Response;
let originalFetch: typeof fetch;
let originalSocket: typeof WebSocket;

const GALLERY = [...CHARTS, ...TABLES, ...DECISIONS];

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

/**
 * A run streamed as a model streams it: every event but the last at once, then a pause before the
 * run finishes, as while the model is still writing the step's next call. A call already streamed
 * has its arguments and no answer yet, which is when a component used to draw.
 */
function streamed(events: unknown[]) {
  const encoder = new TextEncoder();
  const line = (event: unknown) =>
    encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  return new NativeResponse(
    new ReadableStream({
      async start(controller) {
        for (const event of events.slice(0, -1))
          controller.enqueue(line(event));
        await new Promise((resolve) => setTimeout(resolve, 400));
        controller.enqueue(line(events.at(-1)));
        controller.close();
      },
    }),
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
      ...turn.step.flatMap(({ id, answered }) =>
        answered === undefined
          ? []
          : [
              {
                id: `result-${id}`,
                role: "tool" as const,
                toolCallId: id,
                content: answered,
              },
            ],
      ),
    ];
    return [
      started,
      // Every call of the step in one assistant message, as the runtime streams a step.
      ...turn.step.flatMap(({ id, name, args, answered }) => [
        {
          type: "TOOL_CALL_START",
          toolCallId: id,
          toolCallName: name,
          parentMessageId: messageId,
        },
        { type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(args) },
        { type: "TOOL_CALL_END", toolCallId: id },
        ...(answered === undefined
          ? []
          : [
              {
                type: "TOOL_CALL_RESULT",
                messageId: `result-${id}`,
                toolCallId: id,
                role: "tool",
                content: answered,
              },
            ]),
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
        return streamed(runEvents(body));
      }
      if (url.pathname.match(/\/threads\/[^/]+\/messages$/))
        return NativeResponse.json({ messages: stored });
      // The gate: `POST /api/approvals/computer/:botId` in server/src/approvals/routes.ts.
      if (url.pathname === `/api/approvals/computer/${bot}`) {
        const body = (await request.json()) as {
          toolCallId: string;
          args: Record<string, unknown>;
        };
        gated.push({ toolCallId: body.toolCallId, args: body.args });
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        // Long enough that steps sent together would overlap here.
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        return gate(String(body.args.ref));
      }
      if (url.pathname === "/api/approvals")
        return NativeResponse.json({
          enabled: true,
          requests: [],
          rules: [],
          teamRules: [],
          questions: [],
        });
      if (/^\/api\/approvals\/threads\/[^/]+$/.test(url.pathname))
        return NativeResponse.json({ asksEveryStep: false });
      if (url.pathname.startsWith(`/api/computers/${bot}/`))
        return NativeResponse.json({ botId: bot, state: "ready" });
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname === `/api/plugins/for/${bot}`)
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      if (url.pathname === "/api/components/catalogue")
        return NativeResponse.json({ added: [] });
      // The Bot holds the chart, the table and the approval card.
      if (url.pathname === `/api/components/for-agent/${bot}`)
        return NativeResponse.json({
          components: GALLERY.map(({ name, description }) => ({
            name,
            description,
          })),
        });
      if (/^\/api\/components\/[^/]+\/decision$/.test(url.pathname))
        return NativeResponse.json({ allowed: true });
      return NativeResponse.json({ error: "Not found" }, { status: 404 });
    },
    { preconnect: () => undefined },
  );
});

beforeEach(() => {
  bots += 1;
  bot = `step-bot-${bots}`;
  channel = {
    id: `step-channel-${bots}`,
    name: "Step test",
    agentIds: [bot],
    threadId: `step-thread-${bots}`,
    active: true,
    lastMessageAt: SINCE,
  };
  stored = [];
  runs = [];
  turns = [];
  gated = [];
  inFlight = 0;
  mostInFlight = 0;
  gate = () =>
    NativeResponse.json({ error: "Unexpected step" }, { status: 500 });
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
          <ComputerTools />
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

/**
 * Which of these phrases were ever on the page while it was watched, read on every change to it, so
 * one drawn for a moment and taken away again is caught too.
 */
function watch(phrases: readonly string[]): {
  shown: () => string[];
  stop: () => void;
} {
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
function answersIn(run: RunAgentInput | undefined): Record<string, unknown> {
  return Object.fromEntries(
    (run?.messages ?? []).flatMap((message) =>
      message.role === "tool" ? [[message.toolCallId, message.content]] : [],
    ),
  );
}

const typing = (id: string, ref: string, text: string): Call => ({
  id,
  name: "computer_type",
  args: { ref, snapshotId: 3, text },
});

test("a form's fields typed in one step go one at a time, in order, and stop at the first that fails", async () => {
  turns = [
    {
      step: [
        typing("type-name", "e1", "Halvorsen Freight"),
        typing("type-website", "e2", "halvorsen.com"),
        typing("type-headquarters", "e3", "Oslo"),
      ],
    },
    { reply: "The Website field was gone, so I'll look at the form again." },
  ];
  gate = (ref) =>
    ref === "e2"
      ? NativeResponse.json(
          {
            error:
              "Element e2 is not on the page any more. Take a fresh snapshot and use the refs from it.",
          },
          { status: 409 },
        )
      : NativeResponse.json({
          result: {
            ok: true,
            action: "type",
            element: {
              role: "textbox",
              name: ref === "e1" ? "Account name" : "Headquarters",
            },
          },
        });
  const view = render(app());

  await ask(view, "Add Halvorsen Freight as a new account.");
  expect(
    await view.findByText(
      "The Website field was gone, so I'll look at the form again.",
      {},
      { timeout: 5000 },
    ),
  ).toBeTruthy();

  // In the order asked for, one at a time, and nothing after the one that failed was sent.
  expect(gated.map((step) => step.args.ref)).toEqual(["e1", "e2"]);
  expect(mostInFlight).toBe(1);
  // Every call still has its answer, and the one not run says so to the Bot.
  const answers = answersIn(runs[1]);
  expect(JSON.parse(String(answers["type-name"]))).toMatchObject({ ok: true });
  expect(JSON.parse(String(answers["type-website"]))).toMatchObject({
    ok: false,
    staleRefs: true,
  });
  expect(answers["type-headquarters"]).toBe(NOT_RUN_AFTER_FAILURE);
  // And the person reads it in their words, on the step's line.
  expect(
    await view.findByText(/Not done\. A step before it didn't work\./),
  ).toBeTruthy();
});

const SEARCH: Call = {
  id: "search",
  name: "web_search",
  args: { query: "mid-size logistics companies AI initiatives this quarter" },
  // The Bot's own search, answered by its runtime inside the same run.
  answered:
    "Halvorsen Freight (Oslo, 1,200 people) announced AI route planning.",
};

const chart = (title: string) => ({
  title,
  basis: "read",
  sources: [{ title: "Search results" }],
  points: [{ label: "Halvorsen Freight", value: 1200 }],
});
const table = (title: string) => ({
  title,
  columns: ["Company", "Employees"],
  rows: [{ cells: ["Halvorsen Freight", 1200] }],
});

test("a chart and table asked for beside a search are never drawn, and are drawn when asked for after it", async () => {
  turns = [
    {
      step: [
        SEARCH,
        {
          id: "chart-early",
          name: "showBarChart",
          args: chart("Drawn before reading"),
        },
        {
          id: "table-early",
          name: "showTable",
          args: table("Listed before reading"),
        },
      ],
    },
    {
      step: [
        {
          id: "chart",
          name: "showBarChart",
          args: chart("Headcount by company"),
        },
        {
          id: "table",
          name: "showTable",
          args: table("Companies and sources"),
        },
      ],
    },
    { reply: "Here are the companies I found." },
  ];
  const seen = watch([
    "Drawn before reading",
    "Listed before reading",
    "Headcount by company",
  ]);
  const view = render(app());

  await ask(view, "Find five mid-size logistics companies with AI news.");
  expect(
    await view.findByText(
      "Here are the companies I found.",
      {},
      { timeout: 5000 },
    ),
  ).toBeTruthy();
  seen.stop();

  // Asked for beside the search: answered for the Bot, and never on screen, not even for a moment.
  const early = answersIn(runs[1]);
  expect(early["chart-early"]).toBe(NOT_DRAWN);
  expect(early["table-early"]).toBe(NOT_DRAWN);
  // Only the chart drawn after the search was ever on the page. The watch sees a chart's title
  // when one is drawn, so the two it did not see were never there, not even while they streamed.
  expect(seen.shown()).toEqual(["Headcount by company"]);
  // Asked for together, after the search: the chart and its table are both drawn, as always.
  expect(view.getByText("Headcount by company")).toBeTruthy();
  expect(view.getByText("Companies and sources")).toBeTruthy();
  expect(answersIn(runs[2]).chart).not.toBe(NOT_DRAWN);

  // Opened again, from the thread as it is stored: still nothing of the calls made too early.
  cleanup();
  const reopened = render(app());
  expect(
    await reopened.findByText("Headcount by company", {}, { timeout: 5000 }),
  ).toBeTruthy();
  expect(reopened.getByText("Companies and sources")).toBeTruthy();
  expect(reopened.queryByText("Drawn before reading")).toBeNull();
  expect(reopened.queryByText("Listed before reading")).toBeNull();
});

test("an approval card asked for beside a search is not shown, and the Bot is told to ask again", async () => {
  turns = [
    {
      step: [
        SEARCH,
        {
          id: "approve-early",
          name: "askApproval",
          args: {
            title: "Email these five companies?",
            summary: "Send each one an introduction.",
          },
        },
      ],
    },
    { reply: "I read the results. Here they are before I ask you anything." },
  ];
  const seen = watch(["Email these five companies?"]);
  const view = render(app());

  await ask(view, "Find logistics companies and offer to email them.");
  expect(
    await view.findByText(
      "I read the results. Here they are before I ask you anything.",
      {},
      { timeout: 5000 },
    ),
  ).toBeTruthy();
  seen.stop();

  expect(answersIn(runs[1])["approve-early"]).toBe(NOT_ASKED);
  expect(seen.shown()).toEqual([]);
});
