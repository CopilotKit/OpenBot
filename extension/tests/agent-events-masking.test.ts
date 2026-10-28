// The agent events leave masked and cut to fit, on real traffic: a person who hands the agent a card number and a
// password they typed earlier into a password field (so the recording holds its digest), a person who pastes a log far
// over Intelligence's 16 KiB event limit, and OpenBot's own chat, whose every run starts with its whole tool list.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVENT_BUDGET_BYTES,
  normaliseSecret,
  REDACTED,
  sha256HexSync,
} from "@openbot/shared/recorder-masking";
import type { AgentObservation } from "../src/background/agent/observation";
import {
  CLOCK,
  loadFixture,
  observationsOf,
  record,
  sinkEvents,
} from "./agent-traffic";

const PASSWORD = "Tr0ub4dor-horse-77";
const CARD = /4111[ -]?1111[ -]?1111[ -]?1111/;
const digests = new Set([sha256HexSync(normaliseSecret(PASSWORD))]);

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

test("a password typed earlier and then pasted into the chat, and a card number in the chat and in a tool's arguments, never leave", async () => {
  const fixture = loadFixture("sse", "secrets");
  // CopilotKit's own events carry both as the person wrote them.
  const raw = JSON.stringify(sinkEvents(fixture.sink));
  expect(raw).toContain(PASSWORD);
  expect(raw).toMatch(CARD);

  const { emitted } = await record(observationsOf(fixture), digests);
  const out = JSON.stringify(emitted);
  expect(out).not.toContain(PASSWORD);
  expect(out).not.toMatch(CARD);

  const typed = emitted.find(
    (event) =>
      event.name === "agent.message" &&
      (event.value as { role?: string }).role === "user",
  )?.value as { text: string; textLength: number };
  const original = sinkEvents(fixture.sink).find(
    (event) =>
      event.name === "agent.message" &&
      (event.value as { role?: string }).role === "user",
  )?.value as { text: string };
  expect(typed.text).toContain(REDACTED);
  expect(typed.text).toContain("Pay invoice INV-7");
  expect(typed.textLength).toBe(original.text.length);

  const args = emitted
    .map(
      (event) =>
        (event.value as { event?: { type?: string; delta?: string } }).event,
    )
    .find((event) => event?.type === "TOOL_CALL_ARGS");
  expect(JSON.parse(args?.delta ?? "{}")).toEqual({
    invoice: "INV-7",
    cardNumber: REDACTED,
  });
});

test("without the digest of what was typed into the password field, the pasted password is ordinary text", async () => {
  const { emitted } = await record(
    observationsOf(loadFixture("sse", "secrets")),
  );
  const out = JSON.stringify(emitted);
  expect(out).toContain(PASSWORD);
  expect(out).not.toMatch(CARD);
});

test("a message over 16 KiB is cut to fit one Intelligence event, keeping its ids, its start and its full textLength", async () => {
  const fixture = loadFixture("sse", "long-message");
  const original = sinkEvents(fixture.sink).find(
    (event) =>
      event.name === "agent.message" &&
      (event.value as { role?: string }).role === "user",
  )?.value as { messageId: string; text: string };
  expect(bytes({ text: original.text })).toBeGreaterThan(16 * 1024);

  const { emitted } = await record(observationsOf(fixture));
  for (const event of emitted)
    expect(bytes(event)).toBeLessThanOrEqual(EVENT_BUDGET_BYTES);
  const message = emitted.find(
    (event) =>
      event.name === "agent.message" &&
      (event.value as { messageId?: string }).messageId === original.messageId,
  )?.value as { text: string; textLength: number; truncated?: boolean };
  expect(message.textLength).toBe(original.text.length);
  expect(message.text.length).toBeGreaterThan(10_000);
  expect(message.text.length).toBeLessThan(original.text.length);
  expect(original.text.startsWith(message.text)).toBe(true);
  expect(message.truncated).toBe(true);
});

/** Every string in a value, by where it sits and the field that holds it (an array's items are its field's). */
function strings(
  value: unknown,
  path = "",
  field: string | null = null,
): { path: string; field: string | null; text: string }[] {
  if (typeof value === "string") return [{ path, field, text: value }];
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      strings(item, `${path}/${index}`, field),
    );
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap(([key, item]) =>
      strings(item, `${path}/${key}`, key),
    );
  return [];
}

test("OpenBot's RUN_STARTED, its 39 tools and 5 context entries far over 16 KiB, is cut in its text only: its ids, its tool names and its schemas' types leave whole", async () => {
  // End-to-end run 3's run, as Intelligence's socket delivered it: the RUN_STARTED left as row 011 with its threadId,
  // its runId and every tool name cut to 23 characters, so the row joined neither its Thread nor its run.
  const fixture = JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/e2e-run3-openbot-run.json"),
      "utf8",
    ),
  ) as {
    agentId: string;
    received: [
      {
        threadId: string;
        runId: string;
        input: {
          tools: { name: string; description: string; parameters: unknown }[];
          context: { description: string; value: string }[];
        };
      },
      unknown,
    ];
  };
  const { agentId } = fixture;
  const [started, error] = fixture.received;
  const { threadId, runId, input } = started;
  expect(bytes(input)).toBeGreaterThan(90 * 1024);
  // The page's run request (its RunAgentInput, which RUN_STARTED's `input` repeats), its JSON answer naming the
  // Thread's channel, then the run's events on Intelligence's socket.
  const observations: AgentObservation[] = [
    {
      kind: "request",
      tabId: 1,
      streamId: "run",
      at: CLOCK,
      url: `http://127.0.0.1:7410/api/copilotkit/agent/${agentId}/run`,
      agentId,
      method: "agent/run",
      input,
    },
    {
      kind: "end",
      tabId: 1,
      streamId: "run",
      at: CLOCK + 82,
      outcome: "complete",
    },
    ...[started, error].map(
      (event): AgentObservation => ({
        kind: "event",
        tabId: 1,
        streamId: `thread:${threadId}`,
        at: CLOCK + 274,
        agentId,
        threadId,
        event,
      }),
    ),
    {
      kind: "end",
      tabId: 1,
      streamId: `thread:${threadId}`,
      at: CLOCK + 276,
      outcome: "complete",
    },
  ];

  const { emitted } = await record(observations);
  for (const event of emitted)
    expect(bytes(event)).toBeLessThanOrEqual(EVENT_BUDGET_BYTES);
  const row = emitted.find(
    ({ name, value }) =>
      name === "agent.event" &&
      (value as { event: { type: string } }).event.type === "RUN_STARTED",
  )?.value as {
    threadId: string;
    runId: string;
    agentId: string;
    truncated?: boolean;
    event: {
      type: string;
      input: {
        tools: { name: string; description: string; parameters: unknown }[];
        context: { description: string; value: string }[];
      };
    };
  };
  expect(row.truncated).toBe(true);
  // It joins its Thread and its run.
  expect(row).toMatchObject({ threadId, runId, agentId });
  // Every tool, whole by name and in order, its parameters' schema still JSON with every type and required name.
  const tools = row.event.input.tools;
  expect(tools.map(({ name }) => name)).toEqual(
    input.tools.map(({ name }) => name),
  );
  const kept = new Set(["type", "required", "enum"]);
  const sorted = (list: { path: string; text: string }[]) =>
    list.map(({ path, text }) => `${path} ${text}`).sort();
  for (const [index, tool] of tools.entries())
    expect(
      sorted(
        strings(tool.parameters).filter(({ field }) => kept.has(field ?? "")),
      ),
    ).toEqual(
      sorted(
        strings(input.tools[index]?.parameters).filter(({ field }) =>
          kept.has(field ?? ""),
        ),
      ),
    );
  expect(row.event.input.context).toHaveLength(input.context.length);
  // Only the text is cut, the longest first: every cut string is the start of its own, all cut to one length, and no
  // text left whole is longer than that.
  const text = ({ field }: { field: string | null }) =>
    field === "description" || field === "value";
  const before = new Map(
    strings(input)
      .filter(text)
      .map(({ path, text }) => [path, text]),
  );
  const after = strings(row.event.input).filter(text);
  expect(after.map(({ path }) => path).sort()).toEqual(
    [...before.keys()].sort(),
  );
  const cut = after.filter(({ path, text }) => text !== before.get(path));
  expect(cut.length).toBeGreaterThan(0);
  for (const { path, text } of cut)
    expect(before.get(path)?.startsWith(text)).toBe(true);
  const length = Math.max(...cut.map(({ text }) => text.length));
  expect(new Set(cut.map(({ text }) => text.length))).toEqual(
    new Set([length]),
  );
  for (const { text } of after) expect(text.length).toBeLessThanOrEqual(length);
});

type Tool = { name: string; description?: string; parameters?: unknown };
type Started = {
  truncated?: boolean;
  event: {
    type: string;
    input: {
      tools?: Tool[];
      context?: { description: string; value: string }[];
      messages?: { id: string; role: string; content?: unknown }[];
    };
  };
};

/** OpenBot's tool list and context as its chat sends them with every run: end-to-end run 3's run request. */
function openBotSetup(): { tools: Tool[]; context: unknown[] } {
  const fixture = JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/e2e-run3-openbot-run.json"),
      "utf8",
    ),
  ) as { received: [{ input: { tools: Tool[]; context: unknown[] } }] };
  const { tools, context } = fixture.received[0].input;
  return { tools, context };
}

/** A conversation as OpenBot's page sends it: each run offers OpenBot's 39 tools beside the conversation's own, with
 * OpenBot's 5 context entries, in its request and in a RUN_STARTED that echoes the request. */
function onOpenBot(observations: AgentObservation[]): AgentObservation[] {
  const { tools, context } = openBotSetup();
  const dressed = (input: unknown) => {
    const own = input as { tools?: Tool[] };
    return { ...own, tools: [...(own.tools ?? []), ...tools], context };
  };
  return observations.map((observation) => {
    if (observation.kind === "request")
      return { ...observation, input: dressed(observation.input) };
    const event =
      observation.kind === "event"
        ? (observation.event as { type?: unknown; input?: unknown })
        : null;
    if (event?.type === "RUN_STARTED" && event.input !== undefined)
      return {
        ...observation,
        event: { ...event, input: dressed(event.input) },
      };
    return observation;
  });
}

const runStarts = (emitted: { name: string; value: unknown }[]) =>
  emitted
    .filter(
      ({ name, value }) =>
        name === "agent.event" &&
        (value as Started).event.type === "RUN_STARTED",
    )
    .map(({ value }) => value as Started);

/** The frontend tool's result as the page put it into the history: the tool message of the follow-up run's request. */
function pageResult(transport: "sse" | "intelligence") {
  const fixture = loadFixture(transport, "frontend-tool");
  const [, followUp] = fixture.exchanges;
  const { body } = JSON.parse(followUp?.body ?? "{}") as {
    body: { messages: { role: string; content: string }[] };
  };
  const result = body.messages.find(({ role }) => role === "tool")?.content;
  if (!result) throw new Error("no result in the follow-up request");
  return { fixture, result, followUpAt: followUp?.at as number };
}

for (const transport of ["sse", "intelligence"] as const)
  test(`a Thread's tools and context are carried when they change, so a frontend tool's result, carried only in the next run's history, lands once and whole: ${transport}`, async () => {
    // End-to-end run 3: every run's RUN_STARTED carried OpenBot's same 39 tool schemas and 5 context entries (61,104 of
    // the trajectory's 82,300 bytes), so each was cut to fit, and with it the only copy of each frontend tool's result:
    // list_bots's answer left as "3 coworkers already e".
    const { fixture, result } = pageResult(transport);
    expect(result.length).toBeGreaterThan(21);
    const { emitted } = await record(onOpenBot(observationsOf(fixture)));
    for (const event of emitted)
      expect(bytes(event)).toBeLessThanOrEqual(EVENT_BUDGET_BYTES);
    const [first, followUp, ...more] = runStarts(emitted);
    expect(more).toHaveLength(0);
    // The Thread's first run carries the page's whole setup, every tool by name.
    const { tools } = openBotSetup();
    expect(first?.event.input.tools?.map(({ name }) => name)).toEqual([
      "showGreeting",
      ...tools.map(({ name }) => name),
    ]);
    expect(first?.event.input.context).toHaveLength(5);
    // The follow-up offers the same: nothing of it again, nothing cut, and the tool's result whole.
    expect(followUp?.event.input).not.toHaveProperty("tools");
    expect(followUp?.event.input).not.toHaveProperty("context");
    expect(followUp?.truncated).toBeUndefined();
    expect(
      followUp?.event.input.messages?.find(({ role }) => role === "tool")
        ?.content,
    ).toBe(result);
    // Once in the whole trajectory: CopilotKit announces a frontend tool's result nowhere else.
    expect(JSON.stringify(emitted).split(result)).toHaveLength(2);
  });

for (const transport of ["sse", "intelligence"] as const)
  test(`a RUN_STARTED over budget has the page's tools and context cut before its messages, so the person's words and a frontend tool's result stay whole: ${transport}`, async () => {
    // A recording that began after the tool ran: the follow-up run is the first of its Thread the recording sees, so
    // its RUN_STARTED carries OpenBot's whole setup beside the history, the tool's result in it.
    const { fixture, result, followUpAt } = pageResult(transport);
    const { emitted } = await record(
      onOpenBot(observationsOf(fixture, { from: followUpAt })),
    );
    for (const event of emitted)
      expect(bytes(event)).toBeLessThanOrEqual(EVENT_BUDGET_BYTES);
    const [started] = runStarts(emitted);
    expect(started?.truncated).toBe(true);
    const { tools } = openBotSetup();
    expect(started?.event.input.tools?.map(({ name }) => name)).toEqual([
      "showGreeting",
      ...tools.map(({ name }) => name),
    ]);
    // Every message of the history the run's RUN_STARTED holds (the runtime echoes the part new to it) whole, as the
    // page sent it: the tool's result among them.
    const [, sentFollowUp] = fixture.exchanges;
    const sent = new Map(
      (
        JSON.parse(sentFollowUp?.body ?? "{}") as {
          body: { messages: { id: string; content?: unknown }[] };
        }
      ).body.messages.map((message) => [message.id, message]),
    );
    const carried = started?.event.input.messages ?? [];
    expect(carried.length).toBeGreaterThan(0);
    for (const message of carried)
      expect(message.content ?? null).toEqual(
        sent.get(message.id)?.content ?? null,
      );
    expect(carried.find(({ role }) => role === "tool")?.content).toBe(result);
    // What was cut is the setup's text.
    const setupText = strings({
      tools: started?.event.input.tools,
      context: started?.event.input.context,
    }).filter(({ field }) => field === "description" || field === "value");
    expect(setupText.some(({ text }) => text.length < 21)).toBe(true);
  });
