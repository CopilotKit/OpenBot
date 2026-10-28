// Records real AG-UI traffic and what CopilotKit itself emits for it, as the fixtures of the agent events' parity test
// (tests/agent-events-parity.test.ts). Nothing is scripted: a real CopilotKit runtime (runtime.ts, its own process) runs
// real OpenAI agents, and the real CopilotKitCore drives each conversation through its real agent with the legacy
// `learning: { sink }`, so the sink holds exactly the events CopilotKit emits. Both come from the CopilotKit checkout
// named by COPILOTKIT_CHECKOUT (built), so the reference is CopilotKit's current source, not an older npm release.
// Every request body and response stream is captured as it crosses fetch, and every AG-UI frame of the Intelligence
// WebSocket as it arrives, each with when it arrived.
//
//   COPILOTKIT_CHECKOUT=<checkout> bun extension/scripts/agent-traffic/record.ts <file holding OPENAI_API_KEY=...>
//     [--intelligence <file holding INTELLIGENCE_API_URL, INTELLIGENCE_GATEWAY_WS_URL, INTELLIGENCE_API_KEY>] [name]
//
// Keys are read from those files into the runtime process's environment only. No header, socket address or join token
// is recorded, and a fixture that contains a key is refused.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AbstractAgent } from "@ag-ui/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const checkout = process.env.COPILOTKIT_CHECKOUT;
if (!checkout) throw new Error("COPILOTKIT_CHECKOUT is not set");
const args = process.argv.slice(2);
const intelligenceAt = args.indexOf("--intelligence");
const intelligenceFile =
  intelligenceAt === -1 ? undefined : args.splice(intelligenceAt, 2)[1];
const [envFile, only] = args;
if (!envFile) throw new Error("usage: record.ts <file holding OPENAI_API_KEY>");

const readEnv = async (file: string, names: string[]) => {
  const values: Record<string, string> = {};
  for (const line of (await Bun.file(file).text()).split("\n")) {
    const at = line.indexOf("=");
    const name = line.slice(0, at).trim();
    if (at > 0 && names.includes(name))
      values[name] = line
        .slice(at + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
  }
  for (const name of names)
    if (!values[name]) throw new Error(`no ${name} in ${file}`);
  return values;
};
const secrets = {
  ...(await readEnv(envFile, ["OPENAI_API_KEY"])),
  ...(intelligenceFile
    ? await readEnv(intelligenceFile, [
        "INTELLIGENCE_API_URL",
        "INTELLIGENCE_GATEWAY_WS_URL",
        "INTELLIGENCE_API_KEY",
      ])
    : {}),
};
const transport = intelligenceFile ? "intelligence" : "sse";
const OUT = join(
  import.meta.dir,
  "../../tests/fixtures/agent-traffic",
  transport,
);

const runtimeProcess = Bun.spawn(["bun", join(import.meta.dir, "runtime.ts")], {
  env: { ...process.env, ...secrets, COPILOTKIT_TELEMETRY_DISABLED: "true" },
  stdout: "pipe",
  stderr: "inherit",
});
const port = await (async () => {
  const reader = runtimeProcess.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error("the runtime exited before it was ready");
    text += decoder.decode(value, { stream: true });
    const ready = /ready (\d+)/.exec(text);
    if (ready) return Number(ready[1]);
  }
})();
const runtimeUrl = `http://127.0.0.1:${port}/api/copilotkit`;

// CopilotKitCore connects to its runtime only where a window exists, as in a page. Bun's own network and stream classes
// stay, so the traffic is real HTTP and a real WebSocket.
const bunGlobals = {
  fetch,
  Request,
  Response,
  Headers,
  ReadableStream,
  WritableStream,
  TransformStream,
  TextDecoder,
  TextEncoder,
  URL,
  AbortController,
  AbortSignal,
  WebSocket,
};
GlobalRegistrator.register({ url: `http://127.0.0.1:${port}/` });
Object.assign(globalThis, bunGlobals);

const { CopilotKitCore } = await import(
  `${checkout}/packages/core/dist/index.mjs`
);
const { z } = await import(
  `${checkout}/packages/core/node_modules/zod/index.js`
);
type Core = InstanceType<typeof CopilotKitCore>;

type Exchange = {
  at: number;
  url: string;
  method: string;
  body: string | null;
  status: number;
  contentType: string | null;
  chunks: { at: number; text: string }[];
  end: { at: number; outcome: "complete" | "failed" } | null;
};
/** One Phoenix frame of the Intelligence WebSocket: an AG-UI event, a replay control, or a channel join or leave. */
type Frame = {
  at: number;
  socket: number;
  direction: "in" | "out";
  joinRef: string | null;
  topic: string;
  event: string;
  payload?: unknown;
};

let clockZero = 0;
const clock = () => Math.round(performance.now() - clockZero);
let exchanges: Exchange[] = [];
let frames: Frame[] = [];
const pending = new Set<Promise<void>>();

/** The join credentials a run or connect answers with in Intelligence mode hold a join token: it is never recorded. */
const withoutTokens = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), (key, value) =>
      /token/i.test(key) ? "[omitted]" : value,
    );
  } catch {
    return text;
  }
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const exchange: Exchange = {
    at: clock(),
    url,
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? init.body : null,
    status: 0,
    contentType: null,
    chunks: [],
    end: null,
  };
  exchanges.push(exchange);
  const response = await bunGlobals.fetch(input, init);
  exchange.status = response.status;
  exchange.contentType = response.headers.get("content-type");
  if (!response.body) {
    exchange.end = { at: clock(), outcome: "complete" };
    return response;
  }
  const [mine, theirs] = response.body.tee();
  const reading = (async () => {
    const reader = mine.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        exchange.chunks.push({
          at: clock(),
          text: decoder.decode(value, { stream: true }),
        });
      }
      exchange.end = { at: clock(), outcome: "complete" };
    } catch {
      exchange.end = { at: clock(), outcome: "failed" };
    }
  })();
  pending.add(reading);
  void reading.finally(() => pending.delete(reading));
  return new Response(theirs, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}) as typeof fetch;

let sockets = 0;
const PHOENIX_FRAMES = new Set([
  "ag_ui_event",
  "replay_complete",
  "replay_failed",
  "stream_idle",
  "phx_join",
  "phx_leave",
  "phx_close",
  "phx_error",
]);
const recordFrame = (
  socket: number,
  direction: Frame["direction"],
  data: unknown,
) => {
  if (typeof data !== "string") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  if (!Array.isArray(parsed) || parsed.length !== 5) return;
  const [joinRef, , topic, event, payload] = parsed as [
    string | null,
    string | null,
    string,
    string,
    unknown,
  ];
  if (!PHOENIX_FRAMES.has(event)) return;
  frames.push({
    at: clock(),
    socket,
    direction,
    joinRef,
    topic,
    event,
    // A join's params name the replay cursor and the mode; nothing in them is a credential.
    ...(event === "ag_ui_event" || event === "phx_join" ? { payload } : {}),
  });
};
class RecordingWebSocket extends bunGlobals.WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    const socket = ++sockets;
    this.addEventListener("message", (event) =>
      recordFrame(socket, "in", (event as MessageEvent).data),
    );
    const send = this.send.bind(this);
    this.send = (data) => {
      recordFrame(socket, "out", data);
      send(data);
    };
  }
}
globalThis.WebSocket = RecordingWebSocket as typeof WebSocket;
if (typeof window !== "undefined")
  (window as unknown as { WebSocket: unknown }).WebSocket = RecordingWebSocket;

/** What the legacy sink receives: a batch of the collector's events, each stamped with Date.now(). */
type SinkBatch = { trajectoryId: string; events: unknown[]; dropped?: number };

async function startCore(
  clicks = false,
): Promise<{ core: Core; sink: SinkBatch[] }> {
  const sink: SinkBatch[] = [];
  const core: Core = new CopilotKitCore({
    runtimeUrl,
    runtimeTransport: "single",
    learning: {
      sink: (batch: SinkBatch) => {
        sink.push(batch);
      },
      capture: {
        clicks,
        inputs: false,
        navigation: false,
        network: false,
        agentText: true,
      },
    },
  });
  const started = await core.startTrajectory();
  if (started.status !== "started")
    throw new Error(`startTrajectory: ${JSON.stringify(started)}`);
  return { core, sink };
}

async function agentOf(core: Core, id: string): Promise<AbstractAgent> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const agent = core.getAgent(id);
    if (agent) return agent;
    await Bun.sleep(50);
  }
  throw new Error(`agent ${id} never appeared`);
}

async function say(
  core: Core,
  agent: AbstractAgent,
  content: string,
): Promise<void> {
  agent.addMessage({ id: crypto.randomUUID(), role: "user", content });
  await core.runAgent({ agent });
}

async function settle(): Promise<void> {
  await Bun.sleep(transport === "intelligence" ? 1500 : 300);
  await Promise.all([...pending]);
  await Bun.sleep(50);
}

/** A run or connect of an agent: a REST path, or the single route's `{ method, params, body }` envelope. */
const agentMethod = (exchange: Exchange): string | null => {
  const path = /\/agent\/[^/]+\/(run|connect)$/.exec(
    new URL(exchange.url).pathname,
  );
  if (path) return `agent/${path[1]}`;
  try {
    const method = (JSON.parse(exchange.body ?? "") as { method?: unknown })
      .method;
    return method === "agent/run" || method === "agent/connect" ? method : null;
  } catch {
    return null;
  }
};

async function record(
  name: string,
  conversation: (helpers: {
    core: Core;
    sink: SinkBatch[];
  }) => Promise<unknown>,
): Promise<void> {
  exchanges = [];
  frames = [];
  clockZero = performance.now();
  const { core, sink } = await startCore(name === "clicks");
  /** What a conversation adds to its fixture beside the traffic and the sink. */
  const extra = ((await conversation({ core, sink })) ?? {}) as Record<
    string,
    unknown
  >;
  await settle();
  core.stopTrajectory();
  const fixture = {
    name,
    transport,
    recordedWith: {
      copilotkit: (
        await Bun.$`git -C ${checkout} rev-parse --short HEAD`.text()
      ).trim(),
      "@ag-ui/client": "1.0.2",
    },
    exchanges: exchanges
      .filter((exchange) => agentMethod(exchange) !== null)
      .map((exchange) => ({
        ...exchange,
        ...(transport === "intelligence"
          ? {
              chunks: exchange.chunks.map((chunk) => ({
                ...chunk,
                text: withoutTokens(chunk.text),
              })),
            }
          : {}),
      })),
    frames,
    sink,
    ...extra,
  };
  const text = `${JSON.stringify(fixture, null, 2)}\n`.replaceAll(
    `127.0.0.1:${port}`,
    "127.0.0.1:4000",
  );
  for (const secret of [secrets.OPENAI_API_KEY, secrets.INTELLIGENCE_API_KEY])
    if (secret && text.includes(secret))
      throw new Error(`${name}: the fixture holds a secret; not written`);
  if (/sk-[A-Za-z0-9_-]{20,}|join_token|Bearer /i.test(text))
    throw new Error(`${name}: the fixture holds a credential; not written`);
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, `${name}.json`), text);
  console.log(
    `${transport}/${name}: ${fixture.exchanges.length} exchanges, ${frames.length} frames, ${sink.flatMap((batch) => batch.events).length} sink events`,
  );
}

const conversations: Record<string, Parameters<typeof record>[1]> = {
  "text-answer": async ({ core }) => {
    const agent = await agentOf(core, "default");
    await say(
      core,
      agent,
      "Reply with exactly five words about the sea. Call no tools.",
    );
  },
  "backend-tool": async ({ core }) => {
    const agent = await agentOf(core, "default");
    await say(
      core,
      agent,
      "What is the weather in Lisbon? Call lookupWeather once, then answer in one sentence.",
    );
  },
  "frontend-tool": async ({ core }) => {
    core.addTool({
      name: "showGreeting",
      description: "Show a greeting card to the person in the page.",
      parameters: z.object({ name: z.string(), mood: z.string() }),
      handler: async ({ name }: { name: string }) =>
        `Shown a greeting card for ${name}.`,
    });
    const agent = await agentOf(core, "default");
    await say(
      core,
      agent,
      "Call showGreeting with name Ada and mood cheerful, then say done in one word.",
    );
  },
  // A frontend tool that fails: CopilotKit puts `Error: <message>` in the history as the tool's result and runs no
  // follow-up, so the result reaches the runtime only with the person's next message.
  "frontend-tool-error": async ({ core }) => {
    core.addTool({
      name: "showGreeting",
      description: "Show a greeting card to the person in the page.",
      parameters: z.object({ name: z.string(), mood: z.string() }),
      handler: async () => {
        throw new Error("The greeting card could not be shown.");
      },
    });
    const agent = await agentOf(core, "default");
    await say(
      core,
      agent,
      "Call showGreeting with name Ada and mood cheerful, then say done in one word.",
    );
    await say(core, agent, "Say ok in one word. Call no tools.");
  },
  "two-runs": async ({ core }) => {
    const agent = await agentOf(core, "default");
    await say(core, agent, "Name one planet. One word only. Call no tools.");
    await say(core, agent, "Name another one. One word only. Call no tools.");
  },
  state: async ({ core }) => {
    const agent = await agentOf(core, "default");
    agent.setState({ todos: [] });
    await say(
      core,
      agent,
      'First call AGUISendStateSnapshot with snapshot {"todos":["buy milk"]}. Then call AGUISendStateDelta to add "walk dog" at /todos/-. Then call AGUISendStateDelta again to add "post letter" at /todos/-. Then say done.',
    );
  },
  reasoning: async ({ core }) => {
    const agent = await agentOf(core, "reasoner");
    await say(
      core,
      agent,
      "Think it through step by step first: a bat and a ball cost 1.10 dollars in total, and the bat costs 1.00 dollar more than the ball. How much is the ball? Call no tools, answer with the amount only.",
    );
  },
  "run-error": async ({ core }) => {
    const agent = await agentOf(core, "broken");
    await say(core, agent, "Hello?");
  },
  interrupt: async ({ core }) => {
    const agent = await agentOf(core, "shopper");
    await say(
      core,
      agent,
      "Buy one coffee for 4 dollars. Ask for approval with approvePurchase first.",
    );
    const resume = agent.pendingInterrupts.map((interrupt) => ({
      interruptId: interrupt.id,
      status: "resolved" as const,
      payload: { approved: true },
    }));
    if (resume.length === 0)
      throw new Error("interrupt: the model raised no interrupt");
    await core.runAgent({ agent, resume });
  },
  // CopilotKit's suggestions: after the person's run its suggestion engine runs the agent again on a Thread of its own,
  // forcing its suggestion tool. CopilotKit's capture records none of it.
  suggestions: async ({ core }) => {
    core.addSuggestionsConfig({
      instructions: "Suggest what the person could ask next.",
      minSuggestions: 1,
      maxSuggestions: 2,
      available: "always",
    });
    const agent = await agentOf(core, "default");
    await say(core, agent, "Name one river. One word only. Call no tools.");
    for (
      let waited = 0;
      waited < 60 && core.getSuggestions("default").isLoading !== false;
      waited++
    )
      await Bun.sleep(250);
    await Bun.sleep(500);
  },
  // Secrets the person gives the agent: a password (the test digests it, as if typed into a password field earlier) and a
  // card number the agent passes to a tool.
  secrets: async ({ core }) => {
    const agent = await agentOf(core, "default");
    await say(
      core,
      agent,
      "This is a test system with test data. Pay invoice INV-7 with card 4111 1111 1111 1111 by calling payInvoice once. My account password is Tr0ub4dor-horse-77, do not repeat it. Then say paid.",
    );
  },
  // A message far over Intelligence's 16 KiB event limit: the person pastes a long order log and asks for one line.
  "long-message": async ({ core }) => {
    const agent = await agentOf(core, "default");
    const log = Array.from(
      { length: 600 },
      (_, index) =>
        `Order ${index + 1}: ${(index % 7) + 1} widgets shipped to warehouse ${(index % 5) + 1}.`,
    ).join("\n");
    await say(
      core,
      agent,
      `Here is our order log:\n${log}\nIn one short sentence, how many orders are there? Call no tools.`,
    );
  },
  // The agent context CopilotKit adds to a click: CopilotKit's own click capture (its legacy collector, clicks on) records
  // real clicks on a chat built from the agent's own messages, with one chat open and then with two. `clicks` says where
  // each click landed, in the order the sink holds their `click` events.
  clicks: async ({ core }) => {
    const first = await agentOf(core, "default");
    core.registerOpenThread({ agentId: "default", threadId: first.threadId });
    await say(
      core,
      first,
      "What is the weather in Lisbon? Call lookupWeather once, then answer in one sentence.",
    );
    const chat = (agent: AbstractAgent) =>
      agent.messages
        .map((message) => {
          const calls =
            message.role === "assistant"
              ? (message.toolCalls ?? [])
                  .map(
                    (call) =>
                      `<div data-tool-call-id="${call.id}"><span>${call.function.name}</span><button type="button">Details</button></div>`,
                  )
                  .join("")
              : "";
          const text =
            typeof message.content === "string" ? message.content : "";
          return `<div data-message-id="${message.id}"><p>${text.replaceAll("<", "&lt;")}</p>${calls}</div>`;
        })
        .join("");
    const page = (agents: AbstractAgent[]) =>
      `<main><section>${agents.map(chat).join("")}</section><div role="log">${chat(agents[0] as AbstractAgent)}</div><div data-message-id="not-a-message"><button type="button">Other</button></div><button id="elsewhere" type="button">Settings</button></main>`;
    const selectors = [
      "section [data-message-id] p",
      "section [data-tool-call-id] button",
      "section [data-tool-call-id] span",
      '[role="log"] [data-message-id] p',
      '[data-message-id="not-a-message"] button',
      "#elsewhere",
    ];
    // happy-dom's events are not trusted, and CopilotKit's click capture ignores untrusted clicks: these are made trusted,
    // as a person's are.
    const press = (element: Element, type: string) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        composed: true,
        detail: 1,
      });
      Object.defineProperty(event, "isTrusted", { value: true });
      element.dispatchEvent(event);
    };
    const clickAll = (html: string) => {
      document.body.innerHTML = html;
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`clicks: nothing at ${selector}`);
        press(element, "pointerdown");
        press(element, "click");
      }
      return { at: clock(), html, selectors };
    };
    const oneOpen = clickAll(page([first]));
    // A second chat on another registered agent. (A per-thread clone of the first would not do: CopilotKit tracks a clone
    // only once it runs, so it never emits the clone's first message, which the network cannot tell from any other.)
    const second = await agentOf(core, "shopper");
    core.registerOpenThread({ agentId: "shopper", threadId: second.threadId });
    await say(core, second, "Name one planet. One word only. Call no tools.");
    await settle();
    return { clicks: [oneOpen, clickAll(page([first, second]))] };
  },
  // A page that reloads during a recording: a second page (its own CopilotKitCore) restores the Thread of the first,
  // and the runtime replays the Thread's history to it. `replaySink` is what the second page's CopilotKit emits.
  reload: async ({ core }) => {
    const agent = await agentOf(core, "default");
    await say(
      core,
      agent,
      "Name three oceans, separated by commas. Call no tools.",
    );
    await settle();
    const replayFromAt = clock();
    const { core: second, sink: replaySink } = await startCore();
    const restored = await agentOf(second, "default");
    restored.threadId = agent.threadId;
    await second.connectAgent({ agent: restored });
    await settle();
    second.stopTrajectory();
    return { replaySink, replayFromAt };
  },
};

try {
  for (const [name, conversation] of Object.entries(conversations)) {
    if (only && only !== name) continue;
    await record(name, conversation);
  }
} finally {
  runtimeProcess.kill();
}
process.exit(0);
