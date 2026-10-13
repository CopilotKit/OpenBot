import { expect, test } from "bun:test";
import {
  requireSavedCall,
  SAVED_CALL_REFUSAL,
  type SavedHistory,
} from "../src/approvals/saved-call";

const REQUESTED = {
  toolCallId: "call-1",
  toolName: "computer_click",
  args: { ref: "f8e31", snapshotId: 59 },
};
const COMPLETE = JSON.stringify(REQUESTED.args);
const WAIT_MS = 60_000;

function withCall(args: string, name = REQUESTED.toolName): SavedHistory {
  return {
    messages: [
      { role: "user" },
      {
        role: "assistant",
        toolCalls: [{ id: REQUESTED.toolCallId, name, args }],
      },
    ],
  };
}
const EMPTY: SavedHistory = { messages: [{ role: "user" }] };

/**
 * Replays the saved conversation as a sequence of readings on a fake clock, so the deadline is
 * exercised without waiting for it. The last reading repeats for as long as the gate keeps asking.
 */
function saves(...readings: (SavedHistory | Error)[]) {
  let clock = 0;
  let reads = 0;
  const logs: string[] = [];
  return {
    logs,
    reads: () => reads,
    elapsed: () => clock,
    run: () =>
      requireSavedCall(
        async () => {
          const reading = readings[Math.min(reads++, readings.length - 1)];
          if (reading instanceof Error) throw reading;
          return reading;
        },
        REQUESTED,
        {
          waitMs: WAIT_MS,
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
          log: (message) => logs.push(message),
        },
      ),
  };
}

test("allows a call whose arguments were still being written, once they are complete", async () => {
  const gate = saves(
    withCall(""),
    withCall('{"ref":"f8'),
    withCall('{"ref":"f8e31","snapshotId":'),
    withCall(COMPLETE),
  );
  await expect(gate.run()).resolves.toBeUndefined();
  expect(gate.reads()).toBe(4);
});

test("allows a call whose name was saved empty at first, once it is complete", async () => {
  const gate = saves(withCall("", ""), withCall('{"', ""), withCall(COMPLETE));
  await expect(gate.run()).resolves.toBeUndefined();
  expect(gate.reads()).toBe(3);
});

// The sequence managed Intelligence saved for one click, a few seconds apart: pieces of the
// arguments out of order, one of them parseable and wrong, then the real thing.
test("allows a call whose saved arguments parse but are wrong for a while, once they are repaired", async () => {
  const gate = saves(
    withCall('{"', ""),
    withCall('{"ref8e31Id59}'),
    withCall('{"ref8e31snapshotId59}'),
    withCall('{"reff8e31snapshotId":59}'),
    withCall(COMPLETE),
  );
  await expect(gate.run()).resolves.toBeUndefined();
  expect(gate.reads()).toBe(5);
});

test("allows a call that is saved after the first readings miss it, within the deadline", async () => {
  // 80 readings at 250ms: 20s, well past the old 5s limit and inside the wait.
  const gate = saves(
    ...Array<SavedHistory>(80).fill(EMPTY),
    withCall(COMPLETE),
  );
  await expect(gate.run()).resolves.toBeUndefined();
  expect(gate.elapsed()).toBe(20_000);
  expect(gate.logs.join("\n")).toContain("found saved after 20000ms");
});

test("keeps reading through a failed read of the conversation", async () => {
  const gate = saves(new Error("502 Bad Gateway"), withCall(COMPLETE));
  await expect(gate.run()).resolves.toBeUndefined();
});

test("never allows a call whose saved arguments stay different, and says which fields differ", async () => {
  const gate = saves(withCall(JSON.stringify({ ref: "e99", snapshotId: 59 })));
  await expect(gate.run()).rejects.toThrow(SAVED_CALL_REFUSAL);
  expect(gate.elapsed()).toBe(WAIT_MS);
  const log = gate.logs.join("\n");
  expect(log).toContain("differ from the request in ref");
  expect(log).not.toContain("e99");
});

test("never allows a saved call to a different tool", async () => {
  const gate = saves(withCall(COMPLETE, "computer_type"));
  await expect(gate.run()).rejects.toThrow(SAVED_CALL_REFUSAL);
  expect(gate.elapsed()).toBe(WAIT_MS);
});

test("refuses a call that already has a saved result on the first reading", async () => {
  const answered = withCall(COMPLETE);
  answered.messages.push({ role: "tool", toolCallId: REQUESTED.toolCallId });
  const gate = saves(answered);
  await expect(gate.run()).rejects.toThrow(SAVED_CALL_REFUSAL);
  expect(gate.reads()).toBe(1);
});

test("refuses a call that is never saved, once the deadline passes", async () => {
  const gate = saves(EMPTY);
  await expect(gate.run()).rejects.toThrow(SAVED_CALL_REFUSAL);
  expect(gate.elapsed()).toBe(WAIT_MS);
  expect(gate.logs.join("\n")).toContain("not saved yet");
});

test("refuses a call whose saved arguments never become valid, once the deadline passes", async () => {
  const gate = saves(withCall('{"ref":"f8e31","snap'));
  await expect(gate.run()).rejects.toThrow(SAVED_CALL_REFUSAL);
  expect(gate.elapsed()).toBe(WAIT_MS);
  expect(gate.logs.join("\n")).toContain("do not parse");
});

test("never treats arguments that parse to something other than an object as a match", async () => {
  const gate = saves(withCall("null"));
  await expect(gate.run()).rejects.toThrow(SAVED_CALL_REFUSAL);
  expect(gate.elapsed()).toBe(WAIT_MS);
});
