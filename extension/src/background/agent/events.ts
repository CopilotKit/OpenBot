// The agent's side of a recording: the AG-UI traffic the network capture observes (observation.ts), turned into exactly
// the events the CopilotKit SDK emits for the same traffic, so Intelligence cannot tell a Recorder trajectory from a
// CopilotKit one: `thread.linked`, `agent.run`, `agent.message` and `tool.call` as CopilotKit's LearningBridge emits them
// through a legacy sink, the agent context CopilotKit adds to a click, and `agent.event` for every piece of AG-UI the
// others leave out (agent-event.ts).
//
// LearningBridge links a Thread when a chat opens it (`thread.linked`, reason "open") and when the same chat moves to
// another Thread (reason "switch"), once per change of Thread in the page. The network shows a chat's Thread when the
// page first talks to its agent about it, so the page's chat for an agent is on that agent's latest Thread in the page:
// its first Thread in a page view is linked "open", a later one "switch", just before its first event; `hasMessages`
// says whether the Thread held messages before the page's new ones. A Thread the chat moved away from is no longer open.
//
// Each Thread of each agent in a tab is an AG-UI agent of its own (thread-agent.ts): a run's request adds the page's new
// messages to it as CopilotKit adds them before it runs, and the run's events are fed to it as they arrive, whatever the
// transport (an SSE or protobuf response, or the Intelligence WebSocket). A stream the recording joined mid-run waits for
// its next RUN_STARTED, and a run that never ends is left open, never finished for it: AG-UI forbids inventing a
// RUN_FINISHED. When a Thread's history is replayed (a page that reloads, a channel that joins again), a run already
// recorded for the Thread, or an event already recorded (Intelligence's event id), is not recorded again; a replay of a
// run cut short carries on where the recording left it. Runs CopilotKit makes for its suggestions are left out, as
// CopilotKit's own capture leaves them out. Whatever is dropped is counted in `recorder.dropped`.
//
// What a click's context and the links depend on survives a service-worker restart (`snapshot`, kept with the held
// steps, and `restore`): the page's open Threads, its run requests, the Thread linked last and each agent's last run.
// The AG-UI streams and the Threads' conversations are taken up again from the page's next traffic.
import type { Message, RunAgentInput } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/core";
import type {
  CapturedEvent,
  JsonValue,
} from "@openbot/shared/recorder-masking";
import { ReplaySubject } from "rxjs";
import {
  AGENT_TARGET_FIELD,
  type AgentTarget,
} from "../../shared/agent-target";
import { createExpressed, type Expressed } from "./agent-event";
import { finishAgentEvent } from "./mask";
import type {
  AgentRunRequest,
  AgentStreamEnd,
  AgentStreamEvent,
  CaptureObservation,
} from "./observation";
import { type FedEvent, type PageAgent, ThreadAgent } from "./thread-agent";

export type AgentEvents = {
  /** One observation from the network capture, in the order the capture saw it. */
  observe(observation: CaptureObservation): void;
  /** A click from a followed tab, before the steps see it: the agent context CopilotKit adds to a click. */
  enrichClick(tabId: number, click: CapturedEvent): CapturedEvent;
  /** A click as it leaves the steps, by what the page did after it. `joins` says whether a run the page asked for at a
   * time is the click's doing (after it, before the person's next step, within the steps' join): a click with the
   * open-Thread context takes the Thread of the first such run, the run it sent; one whose Thread the page has since
   * left, by no doing of the click, names none, since the page may have left it before the click. */
  settleClick(
    tabId: number,
    click: CapturedEvent,
    joins: (at: number) => boolean,
  ): CapturedEvent;
  /** Whether a click held in the steps still waits for the run it may have sent: one with the open-Thread context in a
   * tab whose page runs CopilotKit, whose join holds no run yet. */
  awaitsRun(
    tabId: number,
    click: CapturedEvent,
    joins: (at: number) => boolean,
  ): boolean;
  /** The tab's top frame reached another page: its open Threads close. */
  tabNavigated(tabId: number): void;
  /** What a click's context and the links depend on, as JSON, for a service worker that restarts to take up again. */
  snapshot(): AgentSnapshot;
  /** Takes up what another service worker's agent events knew (their `snapshot`), before any traffic or click. */
  restore(snapshot: AgentSnapshot): void;
  /** The recording ended: forget everything held. */
  stop(): void;
};

/** What the agent events know that a click's agent context and the Thread links depend on: per tab, that its page runs
 * CopilotKit, the Thread each chat has open and the Threads it left, the Thread linked last, the latest run requests and
 * each agent's last run; and the runs recorded per Thread, so a replay of one is never recorded again. Ids and times
 * only, never a message. The AG-UI streams and the Threads' conversations are not kept: a service worker that restarts
 * takes them up from the page's next traffic. */
export type AgentSnapshot = {
  tabs: (LinkState & {
    tabId: number;
    runs: { at: number; threadId: string }[];
    lastRunIds: [string, string][];
  })[];
  recordedRuns: [string, string[]][];
};

/** How many of a tab's latest run requests (and Threads its chats left) are kept for the clicks still held in their
 * steps. */
const MAX_RUNS_KEPT = 20;

/** CopilotKit's suggestion tool (`@copilotkit/core` suggestion-engine.ts): a run that forces it is a suggestion run. */
const SUGGEST_TOOL = "copilotkitSuggest";

/** The routing fields Intelligence's runner stamps on every event it relays, removed as CopilotKit's IntelligenceAgent
 * removes them (`stripIntelligenceRoutingFields`) and as AG-UI's enforcement removes the rest before anyone sees them. */
const ROUTING_FIELDS = ["thread_id", "run_id", "organization_id", "project_id"];
const RUN_IDENTITY_EVENTS = new Set(["RUN_STARTED", "RUN_FINISHED"]);

/** What the page sent for a run, as far as the agent events read it. */
type RunInput = Pick<
  RunAgentInput,
  "threadId" | "tools" | "context" | "forwardedProps" | "state" | "resume"
> & { runId: string | undefined; messages: Message[]; raw: unknown };

type PageRun = { input: RunInput; at: number; followUp: boolean };

type Run = {
  thread: Thread;
  runId: string | undefined;
  events: ReplaySubject<FedEvent>;
};

type Thread = {
  agentId: string | null;
  threadId: string;
  /** The recording it belongs to: what it emits after that recording stopped goes nowhere. */
  born: number;
  agent: ThreadAgent;
  /** Each step of the Thread (a request's messages, a run) waits for the one before it to be applied. */
  chain: Promise<void>;
  /** The run being fed, or one cut short that a replay may carry on. */
  open: Run | null;
  /** A run the page asked for whose RUN_STARTED has not arrived. */
  pending: PageRun | null;
  /** The run id CopilotKit reports the last run under (RunHandler's logical run id), which a follow-up continues. */
  lastLogicalRunId: string | undefined;
};

type Stream = {
  agentId: string | null;
  threadId: string | null;
  /** A request of the page opened it, so it starts at its beginning. */
  requested: boolean;
  suggestion: boolean;
  events: number;
  thread: Thread | null;
  run: Run | null;
  /** Inside a replayed run that is already recorded. */
  skipping: boolean;
  /** The RUN_STARTED of a stream no request opened, held until the next event shows whether it is a suggestion run. */
  held: { fed: FedEvent; id: string | null } | null;
};

type Tab = {
  /** The tab's page talks to a CopilotKit runtime: its clicks carry the open-Thread context. */
  traffic: boolean;
  /** The Thread each agent's chat in the page has open (CopilotKit's open-Thread registrations), in the order the chats
   * opened; a new document starts with none. */
  views: Map<string, string>;
  /** Threads a chat moved away from, and when the page showed the Thread it moved to. */
  left: { threadId: string; at: number }[];
  /** The Thread the page linked last (LearningBridge.lastLinkedThreadId); a new document starts with none. */
  lastLinked: string | null;
  /** The page's latest run requests, when each was seen and for which Thread: a click's step window may hold one. */
  runs: { at: number; threadId: string }[];
  /** Links decided whose `thread.linked` the Thread's steps have not emitted yet, oldest first, each with what the tab's
   * Threads were before it: `snapshot` gives the Threads as they were before the oldest, so a service worker that
   * restarts before a link is emitted makes it again, and never takes up a link that went nowhere. */
  pendingLinks: { before: LinkState; done: boolean }[];
  /** CopilotKit's agent in the page, per agent id. */
  agents: Map<string, PageAgent>;
  streams: Map<string, Stream>;
  threads: Map<string, Thread>;
  drops: Map<string, number>;
};

/** A tab's open Threads, the Threads its chats left and the Thread linked last, as a snapshot keeps them. */
type LinkState = {
  views: [string, string][];
  left: { threadId: string; at: number }[];
  lastLinked: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMessage = (value: unknown): value is Message =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.role === "string";

function readInput(raw: unknown): RunInput | null {
  if (!isRecord(raw) || typeof raw.threadId !== "string" || raw.threadId === "")
    return null;
  return {
    threadId: raw.threadId,
    runId: typeof raw.runId === "string" ? raw.runId : undefined,
    messages: Array.isArray(raw.messages) ? raw.messages.filter(isMessage) : [],
    tools: Array.isArray(raw.tools) ? (raw.tools as RunInput["tools"]) : [],
    context: Array.isArray(raw.context)
      ? (raw.context as RunInput["context"])
      : [],
    forwardedProps: raw.forwardedProps,
    state: raw.state,
    ...(Array.isArray(raw.resume)
      ? { resume: raw.resume as RunInput["resume"] }
      : {}),
    raw,
  };
}

/** A run CopilotKit's suggestion engine makes: it forces the suggestion tool, and offers no other. */
function isSuggestion(input: unknown): boolean {
  if (!isRecord(input)) return false;
  const choice = isRecord(input.forwardedProps)
    ? input.forwardedProps.toolChoice
    : undefined;
  const forced =
    isRecord(choice) && isRecord(choice.function)
      ? choice.function.name
      : undefined;
  const tools = Array.isArray(input.tools) ? input.tools : [];
  return (
    forced === SUGGEST_TOOL ||
    (tools.length > 0 &&
      tools.every((tool) => isRecord(tool) && tool.name === SUGGEST_TOOL))
  );
}

/** The event the library applies: a copy, since applying a state patch can change the values it inserts, and the
 * capture's own observation is never changed. */
function normalise(raw: unknown): BaseEvent | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  const event: Record<string, unknown> = structuredClone(raw);
  for (const field of ROUTING_FIELDS) delete event[field];
  if (!RUN_IDENTITY_EVENTS.has(event.type as string)) {
    delete event.threadId;
    delete event.runId;
  }
  return event as unknown as BaseEvent;
}

/** Intelligence's durable id of an event it relays (IntelligenceAgent.readEventId); an id it has not stored yet
 * (`cpki_ingested...`) is none. */
function eventIdOf(event: BaseEvent): string | null {
  const metadata = (event as { metadata?: unknown }).metadata;
  const id = isRecord(metadata) ? metadata.cpki_event_id : undefined;
  return typeof id === "string" &&
    id.trim() !== "" &&
    !id.startsWith("cpki_ingested")
    ? id
    : null;
}

const isTerminal = (event: BaseEvent) =>
  event.type === "RUN_FINISHED" || event.type === "RUN_ERROR";

function readTarget(raw: unknown): AgentTarget | null {
  if (!isRecord(raw)) return null;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return { messageId: text(raw.messageId), toolCallId: text(raw.toolCallId) };
}

export function createAgentEvents(options: {
  /** A masked event ready for the trajectory, in its tab's order. */
  emit(tabId: number, event: CapturedEvent): void;
  /** The recording's sensitive-value digests. */
  digests(): ReadonlySet<string>;
  now(): number;
  /** What `snapshot` reads changed: called as each change is made. */
  onChange?(): void;
}): AgentEvents {
  const tabs = new Map<number, Tab>();
  /** Per Thread, across tabs: the runs recorded, and what has been carried. */
  const recordedRuns = new Map<string, Set<string>>();
  const expressedByThread = new Map<string, Expressed>();
  /** Intelligence event ids already recorded. */
  const recordedEvents = new Set<string>();
  /** Bumped when the recording stops: what the library still applies afterwards belongs to no recording and is not
   * emitted. */
  let recording = 0;
  const changed = () => options.onChange?.();

  /** CopilotKit's agent in a page: its last run id, which says when it changes. */
  const pageAgent = (lastRunId: string | undefined): PageAgent => {
    let current = lastRunId;
    return {
      get lastRunId() {
        return current;
      },
      set lastRunId(next) {
        if (next === current) return;
        current = next;
        changed();
      },
    };
  };

  const tabOf = (tabId: number): Tab => {
    let tab = tabs.get(tabId);
    if (!tab) {
      tab = {
        traffic: false,
        views: new Map(),
        left: [],
        lastLinked: null,
        runs: [],
        pendingLinks: [],
        agents: new Map(),
        streams: new Map(),
        threads: new Map(),
        drops: new Map(),
      };
      tabs.set(tabId, tab);
    }
    return tab;
  };

  const drop = (tab: Tab, reason: string, count = 1) =>
    tab.drops.set(reason, (tab.drops.get(reason) ?? 0) + count);

  const reportDrops = (tabId: number, tab: Tab) => {
    for (const [reason, count] of tab.drops)
      options.emit(tabId, {
        type: "CUSTOM",
        name: "recorder.dropped",
        timestamp: options.now(),
        value: { count, reason },
      });
    tab.drops.clear();
  };

  const runsOf = (threadId: string): Set<string> => {
    let runs = recordedRuns.get(threadId);
    if (!runs) {
      runs = new Set();
      recordedRuns.set(threadId, runs);
    }
    return runs;
  };

  const expressedOf = (threadId: string): Expressed => {
    let expressed = expressedByThread.get(threadId);
    if (!expressed) {
      expressed = createExpressed();
      expressedByThread.set(threadId, expressed);
    }
    return expressed;
  };

  const keyOf = (agentId: string | null) => JSON.stringify(agentId);

  const linkStateOf = (tab: Tab): LinkState => ({
    views: [...tab.views],
    left: tab.left.map((entry) => ({ ...entry })),
    lastLinked: tab.lastLinked,
  });

  /** The Threads open in the tab, each once, in the order their chats opened (LearningBridge.distinctOpenThreadIds). */
  const openIds = (tab: Tab): string[] => [...new Set(tab.views.values())];

  const pageAgentOf = (tab: Tab, agentId: string | null): PageAgent => {
    const key = keyOf(agentId);
    let agent = tab.agents.get(key);
    if (!agent) {
      agent = pageAgent(undefined);
      tab.agents.set(key, agent);
    }
    return agent;
  };

  /** The page shows the Thread in its agent's chat: CopilotKit's registerOpenThread for the chat's first Thread in the
   * page, its registration's update when the chat moves to another. Says how LearningBridge links it: "open" for a
   * chat's first Thread, "switch" for a later one, null when that changes nothing or the Thread is open in another
   * chat. */
  const showThread = (
    tab: Tab,
    thread: Thread,
    at: number,
  ): "open" | "switch" | null => {
    const key = keyOf(thread.agentId);
    const previous = tab.views.get(key);
    if (previous === thread.threadId) return null;
    const elsewhere = openIds(tab).includes(thread.threadId);
    tab.views.set(key, thread.threadId);
    if (previous !== undefined && !openIds(tab).includes(previous)) {
      tab.left.push({ threadId: previous, at });
      if (tab.left.length > MAX_RUNS_KEPT) tab.left.shift();
    }
    changed();
    if (elsewhere) return null;
    return previous === undefined ? "open" : "switch";
  };

  /** The Thread an agent id and Thread id name in a tab; a stream that names no agent takes the tab's Thread of that id. */
  const threadOf = (
    tabId: number,
    tab: Tab,
    agentId: string | null,
    threadId: string,
  ): Thread => {
    const key = JSON.stringify([agentId, threadId]);
    const existing =
      tab.threads.get(key) ??
      (agentId === null
        ? [...tab.threads.values()].find(
            (thread) => thread.threadId === threadId,
          )
        : undefined);
    if (existing) return existing;
    const born = recording;
    const thread: Thread = {
      agentId,
      threadId,
      born,
      agent: new ThreadAgent(
        agentId,
        threadId,
        {
          emit: (name, value, at) => {
            if (born !== recording) return;
            options.emit(
              tabId,
              finishAgentEvent(name, value, at, options.digests()),
            );
          },
          invalid: () => drop(tab, "agent-refused"),
        },
        expressedOf(threadId),
        pageAgentOf(tab, agentId),
      ),
      chain: Promise.resolve(),
      open: null,
      pending: null,
      lastLogicalRunId: undefined,
    };
    tab.threads.set(key, thread);
    return thread;
  };

  const streamOf = (
    tab: Tab,
    streamId: string,
    agentId: string | null,
  ): Stream => {
    let stream = tab.streams.get(streamId);
    if (!stream) {
      stream = {
        agentId,
        threadId: null,
        requested: false,
        suggestion: false,
        events: 0,
        thread: null,
        run: null,
        skipping: false,
        held: null,
      };
      tab.streams.set(streamId, stream);
    }
    stream.agentId ??= agentId;
    return stream;
  };

  /** LearningBridge.emitThreadLinked for the Thread the page now talks to its agent about: nothing when its chat already
   * shows it, or it is the Thread linked last in the page. Decided in the order the page's traffic came; the function
   * it returns sends the link from inside the Thread's step, so it leaves before the Thread's events that follow. */
  const linkThread = (
    tabId: number,
    tab: Tab,
    thread: Thread,
    at: number,
  ): ((hasMessages: boolean, at: number) => void) => {
    const before = linkStateOf(tab);
    const reason = showThread(tab, thread, at);
    if (reason === null || tab.lastLinked === thread.threadId) return () => {};
    tab.lastLinked = thread.threadId;
    const pending = { before, done: false };
    tab.pendingLinks.push(pending);
    changed();
    return (hasMessages, at) => {
      // The link is decided for good as it goes to the steps.
      pending.done = true;
      while (tab.pendingLinks[0]?.done) tab.pendingLinks.shift();
      changed();
      if (thread.born !== recording) return;
      options.emit(
        tabId,
        finishAgentEvent(
          "thread.linked",
          {
            threadId: thread.threadId,
            agentId: thread.agentId,
            hasMessages,
            reason,
          },
          at,
          options.digests(),
        ),
      );
    };
  };

  /** A step of the Thread, after the steps before it; a step the library refuses is counted, never thrown. */
  const step = (tab: Tab, thread: Thread, work: () => void | Promise<void>) => {
    thread.chain = thread.chain.then(work).catch(() => {
      drop(tab, "agent-refused");
    });
  };

  /** The Thread's open run is over without its end (cut short, or replaced by a new run): its events stop, and nothing is
   * invented for it. */
  const endOpenRun = (tab: Tab, thread: Thread) => {
    const run = thread.open;
    if (!run) return;
    thread.open = null;
    run.events.complete();
    for (const stream of tab.streams.values())
      if (stream.run === run) stream.run = null;
  };

  const feed = (tab: Tab, run: Run, event: BaseEvent, at: number) => {
    run.events.next({ event, at });
    if (!isTerminal(event)) return;
    run.events.complete();
    if (run.thread.open === run) run.thread.open = null;
    for (const stream of tab.streams.values())
      if (stream.run === run) stream.run = null;
  };

  /** CopilotKit adds the person's new messages with `addMessage` before it runs (an `agent.message` each), and a frontend
   * tool's result straight into the history: the request shows both, after what the Thread already holds. The page's
   * `link` goes first, saying whether the Thread held messages before the person's new ones. */
  const addPageMessages = (
    thread: Thread,
    page: PageRun,
    link: (hasMessages: boolean, at: number) => void,
  ) => {
    const held = new Set(thread.agent.messages.map(({ id }) => id));
    const carried = expressedOf(thread.threadId).messages;
    const { messages } = page.input;
    let start = messages.length;
    while (start > 0) {
      const message = messages[start - 1] as Message;
      if (
        message.role !== "user" ||
        held.has(message.id) ||
        carried.has(message.id)
      )
        break;
      start--;
    }
    link(start > 0, page.at);
    const typed = messages.slice(start);
    const added = messages
      .slice(0, start)
      .map((message, index) => ({
        message: structuredClone(message),
        after: index > 0 ? (messages[index - 1] as Message).id : null,
      }))
      .filter(({ message }) => !held.has(message.id));
    page.followUp =
      typed.length === 0 &&
      added.some(({ message }) => message.role === "tool");
    thread.agent.addFromPage(
      added,
      typed.map((message) => structuredClone(message)),
      page.at,
    );
  };

  const startRun = (
    tabId: number,
    tab: Tab,
    stream: Stream,
    thread: Thread,
    first: FedEvent,
    id: string | null,
  ) => {
    endOpenRun(tab, thread);
    const page = thread.pending;
    thread.pending = null;
    // A run no request of the page's showed (a channel joined on its own): its Thread shows itself here.
    const link = page ? null : linkThread(tabId, tab, thread, first.at);
    const started = first.event as BaseEvent & {
      runId?: string;
      input?: unknown;
    };
    const runId = started.runId ?? page?.input.runId;
    const run: Run = { thread, runId, events: new ReplaySubject<FedEvent>() };
    if (runId !== undefined && !runsOf(thread.threadId).has(runId)) {
      runsOf(thread.threadId).add(runId);
      changed();
    }
    thread.open = run;
    stream.run = run;
    const input =
      page?.input ??
      readInput(started.input) ??
      ({
        threadId: thread.threadId,
        runId,
        messages: [],
        tools: [],
        context: [],
        forwardedProps: undefined,
        state: undefined,
        raw: undefined,
      } satisfies RunInput);
    step(tab, thread, async () => {
      link?.(thread.agent.messages.length > 0, first.at);
      const resumed = thread.agent.continuationRunIdFor(input);
      const followUp = page?.followUp === true;
      const continuation =
        resumed !== undefined || followUp
          ? { expectedRunId: resumed ?? thread.lastLogicalRunId }
          : null;
      const runIdOnInput = input.runId ?? runId ?? crypto.randomUUID();
      thread.lastLogicalRunId = continuation
        ? continuation.expectedRunId
        : runIdOnInput;
      await thread.agent.applyRun(
        run.events,
        { ...input, runId: runIdOnInput },
        continuation,
        page?.input.raw,
      );
    });
    if (id !== null) recordedEvents.add(id);
    feed(tab, run, first.event, first.at);
  };

  const onRequest = (tabId: number, tab: Tab, request: AgentRunRequest) => {
    const input = readInput(request.input);
    const stream = streamOf(tab, request.streamId, request.agentId);
    stream.requested = true;
    if (!input) {
      drop(tab, "agent-unreadable");
      return;
    }
    stream.threadId = input.threadId;
    if (isSuggestion(request.input)) {
      stream.suggestion = true;
      return;
    }
    const thread = threadOf(tabId, tab, request.agentId, input.threadId);
    stream.thread = thread;
    const link = linkThread(tabId, tab, thread, request.at);
    if (request.method !== "agent/run") {
      step(tab, thread, () => link(input.messages.length > 0, request.at));
      return;
    }
    tab.runs.push({ at: request.at, threadId: input.threadId });
    if (tab.runs.length > MAX_RUNS_KEPT) tab.runs.shift();
    changed();
    // The page started a new run: a run of the Thread still open was cut short.
    endOpenRun(tab, thread);
    const page: PageRun = { input, at: request.at, followUp: false };
    thread.pending = page;
    step(tab, thread, () => addPageMessages(thread, page, link));
  };

  const onRunStarted = (
    tabId: number,
    tab: Tab,
    stream: Stream,
    fed: FedEvent,
    id: string | null,
  ) => {
    const event = fed.event as BaseEvent & {
      threadId?: string;
      runId?: string;
      input?: unknown;
    };
    const threadId = event.threadId || stream.threadId;
    if (!threadId) {
      drop(tab, "agent-unreadable");
      return;
    }
    if (!stream.requested && isSuggestion(event.input)) {
      stream.suggestion = true;
      return;
    }
    const thread = threadOf(tabId, tab, stream.agentId, threadId);
    stream.thread = thread;
    stream.skipping = false;
    const replayed =
      (event.runId !== undefined && runsOf(threadId).has(event.runId)) ||
      (id !== null && recordedEvents.has(id));
    if (replayed) {
      showThread(tab, thread, fed.at);
      // The page's agent applies the replay, so the run it saw last is this one, though the recording has it already.
      if (event.runId !== undefined)
        pageAgentOf(tab, thread.agentId).lastRunId = event.runId;
      drop(tab, "agent-replayed");
      // A run cut short whose replay names each event can carry on: its recorded events are skipped one by one.
      if (
        id !== null &&
        thread.open !== null &&
        thread.open.runId === event.runId
      )
        stream.run = thread.open;
      else stream.skipping = true;
      return;
    }
    if (
      !stream.requested &&
      event.input === undefined &&
      thread.pending === null
    ) {
      stream.held = { fed, id };
      return;
    }
    startRun(tabId, tab, stream, thread, fed, id);
  };

  const onEvent = (tabId: number, tab: Tab, observation: AgentStreamEvent) => {
    const stream = streamOf(tab, observation.streamId, observation.agentId);
    if (observation.threadId) stream.threadId ??= observation.threadId;
    if (stream.suggestion) return;
    const event = normalise(observation.event);
    if (!event) {
      drop(tab, "agent-unreadable");
      return;
    }
    stream.events++;
    const fed: FedEvent = { event, at: observation.at };
    if (stream.held) {
      const { held } = stream;
      stream.held = null;
      const toolCallName = (event as { toolCallName?: unknown }).toolCallName;
      if (event.type === "TOOL_CALL_START" && toolCallName === SUGGEST_TOOL) {
        stream.suggestion = true;
        return;
      }
      if (stream.thread)
        startRun(tabId, tab, stream, stream.thread, held.fed, held.id);
    }
    const id = eventIdOf(event);
    if (event.type === "RUN_STARTED") {
      onRunStarted(tabId, tab, stream, fed, id);
      return;
    }
    if (stream.skipping) {
      if (id !== null) recordedEvents.add(id);
      drop(tab, "agent-replayed");
      if (isTerminal(event)) stream.skipping = false;
      return;
    }
    if (id !== null && recordedEvents.has(id)) {
      drop(tab, "agent-replayed");
      return;
    }
    if (!stream.run) {
      // A run the page asked for that failed before it started still ends in CopilotKit's `agent.run` error.
      if (
        event.type === "RUN_ERROR" &&
        stream.requested &&
        stream.events === 1 &&
        stream.thread?.pending
      )
        startRun(tabId, tab, stream, stream.thread, fed, id);
      else drop(tab, "agent-mid-run");
      return;
    }
    if (id !== null) recordedEvents.add(id);
    feed(tab, stream.run, event, observation.at);
  };

  const onEnd = (tabId: number, tab: Tab, end: AgentStreamEnd) => {
    const stream = tab.streams.get(end.streamId);
    if (!stream) return;
    if (stream.held && stream.thread)
      startRun(
        tabId,
        tab,
        stream,
        stream.thread,
        stream.held.fed,
        stream.held.id,
      );
    tab.streams.delete(end.streamId);
    reportDrops(tabId, tab);
  };

  /** The agent context CopilotKit adds to a click (LearningBridge.enrich): the exact message first, then the open
   * Threads. */
  const clickContext = (
    tab: Tab,
    target: AgentTarget | null,
  ): Record<string, JsonValue> => {
    if (target?.messageId) {
      for (const thread of tab.threads.values()) {
        const message = thread.agent.messages.find(
          ({ id }) => id === target.messageId,
        );
        if (!message) continue;
        const toolCall =
          target.toolCallId !== null && message.role === "assistant"
            ? message.toolCalls?.find(({ id }) => id === target.toolCallId)
            : undefined;
        const answered =
          toolCall !== undefined &&
          thread.agent.messages.some(
            (other) =>
              other.role === "tool" && other.toolCallId === toolCall.id,
          );
        return {
          threadId: thread.agent.threadId,
          agentId: thread.agent.id,
          messageId: message.id,
          runId: thread.agent.runIdForMessage(message.id),
          ...(toolCall === undefined
            ? {}
            : {
                toolCallId: toolCall.id,
                toolName: toolCall.function.name,
                toolStatus: thread.agent.isExecuting(toolCall.id)
                  ? "executing"
                  : answered
                    ? "complete"
                    : "inProgress",
              }),
        };
      }
    }
    const open = openIds(tab);
    if (open.length > 1)
      return {
        threadId: null,
        threadAmbiguity: { reason: "multiple-open", candidates: open },
      };
    return { threadId: open[0] ?? null };
  };

  /** A click with the open-Thread context (no message of its own, no ambiguity) in a tab whose page runs CopilotKit. */
  const openContextOf = (
    tabId: number,
    click: CapturedEvent,
  ): { tab: Tab; value: Record<string, unknown> } | null => {
    const value = click.value;
    const tab = tabs.get(tabId);
    if (
      !tab?.traffic ||
      !isRecord(value) ||
      !Object.hasOwn(value, "threadId") ||
      value.messageId !== undefined ||
      value.threadAmbiguity !== undefined
    )
      return null;
    return { tab, value };
  };

  return {
    observe(observation) {
      const tab = tabOf(observation.tabId);
      if (!tab.traffic) {
        tab.traffic = true;
        changed();
      }
      // The page asked its CopilotKit runtime what it serves: it runs CopilotKit, which is all this says.
      if (observation.kind === "runtime") return;
      try {
        if (observation.kind === "request")
          onRequest(observation.tabId, tab, observation);
        else if (observation.kind === "event")
          onEvent(observation.tabId, tab, observation);
        else onEnd(observation.tabId, tab, observation);
      } catch {
        drop(tab, "agent-unreadable");
      }
    },
    enrichClick(tabId, click) {
      const value = click.value;
      if (!isRecord(value)) return click;
      const { [AGENT_TARGET_FIELD]: target, ...rest } = value;
      const tab = tabs.get(tabId);
      if (!tab?.traffic)
        return target === undefined ? click : { ...click, value: rest };
      return {
        ...click,
        value: { ...rest, ...clickContext(tab, readTarget(target)) },
      };
    },
    settleClick(tabId, click, joins) {
      const context = openContextOf(tabId, click);
      if (!context) return click;
      const { tab, value } = context;
      // The run the click sent: a run goes out on its chat's open Thread, so that is the Thread the click was made in.
      const run = tab.runs.find(({ at }) => joins(at));
      if (run)
        return run.threadId === value.threadId
          ? click
          : { ...click, value: { ...value, threadId: run.threadId } };
      // The page showed the click's chat on another Thread after the click, by no doing of the click's: the chat may
      // have left the click's Thread at any moment since that Thread's own traffic (a New thread button calls nothing),
      // so which Thread the click was made in is not known, and a stale one is never given.
      const left = tab.left.some(
        ({ threadId, at }) =>
          threadId === value.threadId && at >= click.timestamp && !joins(at),
      );
      return left ? { ...click, value: { ...value, threadId: null } } : click;
    },
    awaitsRun(tabId, click, joins) {
      const context = openContextOf(tabId, click);
      return context !== null && !context.tab.runs.some(({ at }) => joins(at));
    },
    tabNavigated(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) return;
      // A new document: its chats open their Threads anew, and CopilotKit's agents in it have run nothing yet.
      tab.views.clear();
      tab.lastLinked = null;
      changed();
      for (const agent of tab.agents.values()) agent.lastRunId = undefined;
      for (const thread of tab.threads.values()) thread.agent.pageGone();
      reportDrops(tabId, tab);
    },
    snapshot() {
      return {
        tabs: [...tabs]
          .filter(([, tab]) => tab.traffic)
          .map(([tabId, tab]) => ({
            tabId,
            ...(tab.pendingLinks[0]?.before ?? linkStateOf(tab)),
            runs: tab.runs.map((run) => ({ ...run })),
            lastRunIds: [...tab.agents].flatMap(([key, agent]) =>
              agent.lastRunId === undefined
                ? []
                : [[key, agent.lastRunId] as [string, string]],
            ),
          })),
        recordedRuns: [...recordedRuns].map(([threadId, runs]) => [
          threadId,
          [...runs],
        ]),
      };
    },
    restore(snapshot) {
      for (const kept of snapshot.tabs) {
        const tab = tabOf(kept.tabId);
        tab.traffic = true;
        tab.views = new Map(kept.views);
        tab.left = kept.left.map((entry) => ({ ...entry }));
        tab.lastLinked = kept.lastLinked;
        tab.runs = kept.runs.map((run) => ({ ...run }));
        tab.agents = new Map(
          kept.lastRunIds.map(([key, runId]) => [key, pageAgent(runId)]),
        );
      }
      for (const [threadId, runs] of snapshot.recordedRuns)
        for (const runId of runs) runsOf(threadId).add(runId);
    },
    stop() {
      for (const [tabId, tab] of tabs) {
        for (const thread of tab.threads.values()) {
          thread.agent.flushHeld();
          if (thread.open) thread.open.events.complete();
        }
        reportDrops(tabId, tab);
      }
      recording++;
      tabs.clear();
      recordedRuns.clear();
      expressedByThread.clear();
      recordedEvents.clear();
    },
  };
}
