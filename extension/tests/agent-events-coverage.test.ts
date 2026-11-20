// Every piece of AG-UI the page received lands in the Trajectory, and lands once: on real recordings, each streamed
// message and each tool call's arguments arrive as one whole value in exactly one event (never one event per token),
// each tool result once with the call it answers, the state's patch operations in their order, and every other field of
// every event (a run's input, its outcome and usage, reasoning's bounds) somewhere in what is emitted. Intelligence's
// routing and bookkeeping fields, and an event's own clock, are not the agent's and are left out.
import { describe, expect, test } from "bun:test";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import {
  fixtureNames,
  loadFixture,
  observationsOf,
  record,
} from "./agent-traffic";

type Event = Record<string, unknown> & { type: string };

/** Changed on the way out on purpose (masked, cut to fit): agent-events-masking.test.ts covers them. */
const CHANGED_ON_THE_WAY_OUT = new Set(["secrets", "long-message"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An event as the agent sent it: without Intelligence's routing fields and bookkeeping, and without its own clock. */
function agentsOwn(raw: unknown): Event {
  const event = { ...(raw as Event) };
  for (const field of [
    "thread_id",
    "run_id",
    "organization_id",
    "project_id",
    "timestamp",
  ])
    delete event[field];
  if (!["RUN_STARTED", "RUN_FINISHED"].includes(event.type)) {
    delete event.threadId;
    delete event.runId;
  }
  if (isRecord(event.metadata)) {
    const kept = Object.fromEntries(
      Object.entries(event.metadata).filter(
        ([key]) => !key.startsWith("cpki_"),
      ),
    );
    if (Object.keys(kept).length > 0) event.metadata = kept;
    else delete event.metadata;
  }
  return event;
}

/** Every string, number and boolean in a value, but a tool call's `type`, which AG-UI fixes as "function". */
function leaves(
  value: unknown,
  out: unknown[] = [],
  inToolCalls = false,
): unknown[] {
  if (Array.isArray(value))
    for (const item of value) leaves(item, out, inToolCalls);
  else if (isRecord(value))
    for (const [key, item] of Object.entries(value)) {
      if (inToolCalls && key === "type") continue;
      leaves(item, out, key === "toolCalls");
    }
  else if (value !== null && value !== undefined) out.push(value);
  return out;
}

const SUGGEST = "copilotkitSuggest";
const isSuggestionRequest = (input: unknown) =>
  isRecord(input) &&
  Array.isArray(input.tools) &&
  input.tools.length > 0 &&
  input.tools.every((tool) => isRecord(tool) && tool.name === SUGGEST);

const agentEvent = (event: CapturedEvent) =>
  (event.value as { event?: Event }).event;

for (const transport of ["sse", "intelligence"] as const)
  describe(`every piece of AG-UI over ${transport}, once`, () => {
    for (const name of fixtureNames(transport).filter(
      (fixtureName) => !CHANGED_ON_THE_WAY_OUT.has(fixtureName),
    ))
      test(name, async () => {
        const fixture = loadFixture(transport, name);
        const observations = observationsOf(fixture, {
          until: fixture.replayFromAt,
        });
        const suggestionStreams = new Set(
          observations
            .filter(
              (observation) =>
                observation.kind === "request" &&
                isSuggestionRequest(observation.input),
            )
            .map((observation) => observation.streamId),
        );
        const received = observations
          .filter(
            (observation) =>
              observation.kind === "event" &&
              !suggestionStreams.has(observation.streamId),
          )
          .map((observation) =>
            agentsOwn(observation.kind === "event" ? observation.event : null),
          );
        const { emitted } = await record(observations);
        const out = emitted.filter(
          (event) => event.name !== "recorder.dropped",
        );
        const outLeaves = leaves(out.map((event) => event.value));
        const count = (value: unknown) =>
          outLeaves.filter((leaf) => leaf === value).length;

        // Never one event per streamed token.
        expect(
          out
            .map(agentEvent)
            .filter((event) => event?.type.endsWith("_CONTENT")),
        ).toEqual([]);

        // A streamed message, as one whole text, in exactly one event: its agent.message.
        const texts = new Map<string, string>();
        for (const event of received)
          if (
            event.type === "TEXT_MESSAGE_CONTENT" ||
            event.type === "REASONING_MESSAGE_CONTENT"
          )
            texts.set(
              event.messageId as string,
              (texts.get(event.messageId as string) ?? "") + event.delta,
            );
        for (const [messageId, text] of texts) {
          const messages = out.filter(
            (event) =>
              event.name === "agent.message" &&
              (event.value as { messageId: string }).messageId === messageId,
          );
          expect(
            messages.map((event) => (event.value as { text: string }).text),
          ).toEqual([text]);
          expect(count(text)).toBe(1);
        }

        // A tool call's arguments, whole, in exactly one TOOL_CALL_ARGS.
        const args = new Map<string, string>();
        for (const event of received)
          if (event.type === "TOOL_CALL_ARGS")
            args.set(
              event.toolCallId as string,
              (args.get(event.toolCallId as string) ?? "") + event.delta,
            );
        for (const [toolCallId, delta] of args) {
          const carried = out
            .map(agentEvent)
            .filter(
              (event) =>
                event?.type === "TOOL_CALL_ARGS" &&
                event.toolCallId === toolCallId,
            );
          expect(carried).toEqual([
            { type: "TOOL_CALL_ARGS", toolCallId, delta },
          ]);
        }

        // A tool result: its text once, and which call it answers.
        for (const event of received.filter(
          (candidate) => candidate.type === "TOOL_CALL_RESULT",
        )) {
          expect(count(event.content)).toBe(1);
          expect(out.map(agentEvent)).toContainEqual({
            type: "TOOL_CALL_RESULT",
            messageId: event.messageId,
            toolCallId: event.toolCallId,
          });
        }

        // The state's patch operations, in their order, whatever deltas they were merged into.
        const operations = (events: (Event | undefined)[]) =>
          events
            .filter((event) => event?.type === "STATE_DELTA")
            .flatMap((event) => event?.delta as unknown[]);
        expect(operations(out.map(agentEvent))).toEqual(operations(received));

        // Every other field of every event, somewhere.
        const streamed = new Set([
          "TEXT_MESSAGE_CONTENT",
          "REASONING_MESSAGE_CONTENT",
          "TOOL_CALL_ARGS",
        ]);
        for (const event of received.filter(
          (candidate) => !streamed.has(candidate.type),
        ))
          for (const leaf of leaves({ ...event, type: undefined }))
            expect({ type: event.type, leaf, found: count(leaf) > 0 }).toEqual({
              type: event.type,
              leaf,
              found: true,
            });
      });
  });
