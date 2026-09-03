import { expect, test } from "bun:test";
import { startWithChosen } from "../src/lib/channels/start";

/**
 * A conversation whose coworker the person picked themselves has to reach the trail the same way a
 * routed one does. `/channel/new` — the sidebar's +, a coworker's card, its profile — started the
 * channel and told nobody; the home composer told the server about an `@`. Both now run this one
 * sequence, so what it does is what the trail sees.
 */

function harness(record: (text: string, agentId: string) => Promise<unknown>) {
  const calls: string[] = [];
  return {
    calls,
    record: (text: string, agentId: string) => {
      calls.push(`record ${agentId} ${text}`);
      return record(text, agentId);
    },
    start: async (agentId: string, text: string) => {
      calls.push(`start ${agentId} ${text}`);
    },
  };
}

test("tells the server the choice before the channel is made", async () => {
  const { calls, record, start } = harness(async () => ({
    agentId: "risk-analyst",
  }));

  await startWithChosen({
    agentId: "risk-analyst",
    text: "hello",
    record,
    start,
  });

  expect(calls).toEqual([
    "record risk-analyst hello",
    "start risk-analyst hello",
  ]);
});

test("a record that fails to write does not stop the conversation", async () => {
  const { calls, record, start } = harness(async () => {
    throw new Error("Could not choose a coworker.");
  });

  await startWithChosen({
    agentId: "risk-analyst",
    text: "hello",
    record,
    start,
  });

  expect(calls).toEqual([
    "record risk-analyst hello",
    "start risk-analyst hello",
  ]);
});

test("the server's answer cannot change who the person chose", async () => {
  const { calls, record, start } = harness(async () => ({
    agentId: "somebody-else",
  }));

  await startWithChosen({
    agentId: "risk-analyst",
    text: "hello",
    record,
    start,
  });

  expect(calls[1]).toBe("start risk-analyst hello");
});

test("a channel that cannot be started still fails the send", async () => {
  const { record } = harness(async () => undefined);
  const start = async () => {
    throw new Error("Could not start a channel");
  };

  await expect(
    startWithChosen({ agentId: "risk-analyst", text: "hello", record, start }),
  ).rejects.toThrow("Could not start a channel");
});
