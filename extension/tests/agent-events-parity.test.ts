// The heart of the agent events: for real traffic from a real CopilotKit runtime and real OpenAI agents, recorded with
// what CopilotKit itself emitted for it (scripts/agent-traffic/record.ts), the Recorder emits CopilotKit's own
// `thread.linked`, `agent.run`, `agent.message` and `tool.call` events, field for field and in the same order, over SSE
// and over the Intelligence WebSocket alike, a frontend tool's executing and completed among them. How long a frontend
// tool ran is the one thing the page times and the network cannot: it is the gap from its run's end to the request that
// carries its result, held on its own. CopilotKit's events are compared as they would leave the Recorder (masked, and
// cut to one Intelligence event): for every conversation but the one that hands the agent secrets and the one whose
// answer is over 16 KiB, that changes nothing.
import { describe, expect, test } from "bun:test";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import { finishAgentEvent } from "../src/background/agent/mask";
import {
  agentEventsFor,
  feed,
  firstThreadOf,
  fixtureNames,
  loadFixture,
  movedTo,
  newThreadRuns,
  observable,
  observationsOf,
  record,
  sinkEvents,
  withoutDuration,
  withoutSeq,
} from "./agent-traffic";

/** Conversations whose CopilotKit events the Recorder's masking or trimming changes (agent-events-masking.test.ts). */
const CHANGED_ON_THE_WAY_OUT = new Set(["secrets", "long-message"]);

/** CopilotKit's event as it would leave the Recorder: without the sequence number CopilotKit's collector adds. */
const leaving = (event: CapturedEvent): CapturedEvent => {
  const { name, value } = withoutSeq(event);
  return finishAgentEvent(name, value, event.timestamp, new Set());
};

for (const transport of ["sse", "intelligence"] as const)
  describe(`CopilotKit's agent events over ${transport}`, () => {
    for (const name of fixtureNames(transport))
      test(name, async () => {
        const fixture = loadFixture(transport, name);
        const { emitted } = await record(
          observationsOf(fixture, { until: fixture.replayFromAt }),
        );
        const copilotKit = sinkEvents(fixture.sink)
          .filter(observable)
          .map(withoutSeq);
        const expected = sinkEvents(fixture.sink)
          .filter(observable)
          .map(leaving)
          .map(withoutSeq);
        expect(expected.length).toBeGreaterThan(0);
        if (!CHANGED_ON_THE_WAY_OUT.has(name))
          expect(expected).toEqual(copilotKit);
        expect(
          emitted.filter(observable).map(withoutSeq).map(withoutDuration),
        ).toEqual(expected.map(withoutDuration));
      });

    test("a frontend tool executes from its run's RUN_FINISHED until the request that carries its result, and lasts the gap between them", async () => {
      const fixture = loadFixture(transport, "frontend-tool");
      const observations = observationsOf(fixture);
      const { emitted } = await record(observations);
      const phase = (event: CapturedEvent, value: string) =>
        event.name === "tool.call" &&
        (event.value as { phase?: unknown }).phase === value;
      const executing = emitted.find((event) => phase(event, "executing"));
      const completed = emitted.find((event) => phase(event, "completed"));
      const finished = observations.find(
        (observation) =>
          observation.kind === "event" &&
          (observation.event as { type?: unknown }).type === "RUN_FINISHED",
      );
      const followUp = observations.filter(
        (observation) => observation.kind === "request",
      )[1];
      expect(executing?.timestamp).toBe(finished?.at as number);
      expect(completed?.timestamp).toBe(followUp?.at as number);
      const { durationMs } = (completed as CapturedEvent).value as {
        durationMs: number;
      };
      expect(durationMs).toBe(
        (followUp?.at as number) - (finished?.at as number),
      );
      // CopilotKit timed the tool inside the page, before the request went out: never longer than the gap.
      const theirs = sinkEvents(fixture.sink).find((event) =>
        phase(event, "completed"),
      );
      expect(durationMs).toBeGreaterThanOrEqual(
        ((theirs as CapturedEvent).value as { durationMs: number }).durationMs,
      );
      expect(durationMs).toBeLessThan(10);
    });

    test("thread.linked once for a Thread whatever its runs, as CopilotKit's legacy capture sends it, before the Thread's first event", async () => {
      const fixture = loadFixture(transport, "two-runs");
      const { emitted } = await record(observationsOf(fixture));
      const threadId = firstThreadOf(fixture);
      const linked = emitted.filter((event) => event.name === "thread.linked");
      expect(linked.map((event) => event.value)).toEqual([
        { threadId, agentId: "default", hasMessages: false, reason: "open" },
      ]);
      expect(emitted[0]).toBe(linked[0] as CapturedEvent);
    });

    test("a page that reloads replays the Thread: the runs already recorded are not recorded again, and the replay is counted", async () => {
      const fixture = loadFixture(transport, "reload");
      const observations = observationsOf(fixture);
      const { emitted, agentEvents } = agentEventsFor();
      const from = fixture.replayFromAt as number;
      await feed(
        agentEvents,
        observations.filter(
          (observation) => observation.at < 1_792_000_000_000 + from,
        ),
      );
      agentEvents.tabNavigated(1);
      await feed(
        agentEvents,
        observations.filter(
          (observation) => observation.at >= 1_792_000_000_000 + from,
        ),
      );
      expect(emitted.filter(observable).map(withoutSeq)).toEqual(
        sinkEvents(fixture.sink).filter(observable).map(withoutSeq),
      );
      const replayed = emitted.filter(
        (event) =>
          event.name === "recorder.dropped" &&
          (event.value as { reason: string }).reason === "agent-replayed",
      );
      expect(replayed.length).toBeGreaterThan(0);
    });

    test("a replay of a run the recording never saw is recorded as the reloaded page's CopilotKit records it", async () => {
      const fixture = loadFixture(transport, "reload");
      const { emitted } = await record(
        observationsOf(fixture, { from: fixture.replayFromAt }),
      );
      expect(emitted.filter(observable).map(withoutSeq)).toEqual(
        sinkEvents(fixture.replaySink ?? [])
          .filter(observable)
          .map(withoutSeq),
      );
    });
  });

test("thread.linked as CopilotKit's legacy capture sent it for two chats on one page: each Thread linked before its first message, with its agent, field for field", async () => {
  const fixture = loadFixture("sse", "clicks");
  const { emitted } = await record(observationsOf(fixture));
  const rows = (events: CapturedEvent[]) =>
    events
      .filter((event) => event.name === "thread.linked" || observable(event))
      .map(withoutSeq);
  const copilotKit = rows(sinkEvents(fixture.sink));
  expect(
    copilotKit.filter(({ name }) => name === "thread.linked"),
  ).toHaveLength(2);
  expect(rows(emitted)).toEqual(copilotKit);
});

/** A chat's move to its second Thread, ids named in the order they appear: the first Thread's last run, the second
 * Thread's link, and the person's first message in it. */
function moveRows(rows: CapturedEvent[]) {
  const value = (row: CapturedEvent) => row.value as Record<string, unknown>;
  const link = rows.filter(({ name }) => name === "thread.linked")[1];
  if (!link) throw new Error("no second thread.linked");
  const at = rows.indexOf(link);
  const lastRun = rows
    .slice(0, at)
    .findLast(
      (row) => row.name === "agent.run" && value(row).phase === "started",
    );
  const typed = rows
    .slice(at)
    .find((row) => row.name === "agent.message" && value(row).role === "user");
  const ids = new Map<string, string>();
  const named = (id: string) => {
    if (!ids.has(id)) ids.set(id, `id-${ids.size + 1}`);
    return ids.get(id);
  };
  return [lastRun, link, typed].map((row) => {
    if (!row) throw new Error("a row of the move is missing");
    const { name, value: fields } = withoutSeq(row);
    return {
      name,
      value: Object.fromEntries(
        Object.entries(fields)
          .filter(([field]) => field !== "text" && field !== "textLength")
          .map(([field, item]) => [
            field,
            ["threadId", "runId", "messageId"].includes(field) &&
            typeof item === "string"
              ? named(item)
              : item,
          ]),
      ),
    };
  });
}

for (const transport of ["sse", "intelligence"] as const)
  test(`a chat moved to a new Thread is linked "switch", and the person's first message there names the agent's last run on the Thread before, as CopilotKit's own capture sent it on the learning page: ${transport}`, async () => {
    // End-to-end runs 1 and 2: CopilotKit's legacy capture linked the Thread New thread opened with reason "switch", and
    // gave the person's first message in it the run its agent ran last, on the Thread before (LearningBridge's
    // runIdForMessage falls back to lastRunIds.get(agent), and the page's agent outlives the move). The Recorder sent
    // "open" and null.
    const theirs = newThreadRuns().map(({ copilotKit }) =>
      moveRows(copilotKit),
    );
    expect(theirs).toHaveLength(2);
    expect(theirs[1]).toEqual(theirs[0] as ReturnType<typeof moveRows>);
    expect(theirs[0]?.[1]?.value.reason).toBe("switch");
    expect(theirs[0]?.[2]?.value.runId).toBe(theirs[0]?.[0]?.value.runId);

    // The same move on real traffic: one agent's answer on one Thread, then, on a new Thread of the same agent, a
    // question that calls a tool, 16 s later as in run 1.
    const first = loadFixture(transport, "text-answer");
    const second = loadFixture(transport, "backend-tool");
    const ended = Math.max(...observationsOf(first).map(({ at }) => at));
    const { emitted } = await record(movedTo(first, second, ended + 16_000));
    expect(moveRows(emitted)).toEqual(theirs[0] as ReturnType<typeof moveRows>);
    expect(
      emitted
        .filter(({ name }) => name === "thread.linked")
        .map(({ value }) => value),
    ).toEqual([
      {
        threadId: firstThreadOf(first),
        agentId: "default",
        hasMessages: false,
        reason: "open",
      },
      {
        threadId: firstThreadOf(second),
        agentId: "default",
        hasMessages: false,
        reason: "switch",
      },
    ]);
    // Field for field CopilotKit's own rows for each conversation, the one row the move changes changed as it does.
    const lastStarted = sinkEvents(first.sink).findLast(
      ({ name, value }) =>
        name === "agent.run" &&
        (value as { phase?: unknown }).phase === "started",
    );
    const lastRun = String(
      (lastStarted?.value as { runId?: string } | undefined)?.runId,
    );
    const moved = sinkEvents(second.sink).map((event, index, all) =>
      event.name === "agent.message" &&
      (event.value as { role?: unknown }).role === "user" &&
      all.findIndex(({ name }) => name === "agent.message") === index
        ? { ...event, value: { ...(event.value as object), runId: lastRun } }
        : event,
    );
    expect(
      emitted.filter(observable).map(withoutSeq).map(withoutDuration),
    ).toEqual(
      [...sinkEvents(first.sink), ...moved]
        .filter(observable)
        .map(leaving)
        .map(withoutSeq)
        .map(withoutDuration),
    );
  });
