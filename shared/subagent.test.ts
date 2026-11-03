import { expect, test } from "bun:test";
import { readSubagentResult, subagentThreadId } from "./subagent";

/*
 * The server and the browser find a subagent's thread the same way, from the conversation and the
 * call, so the browser can show its steps before its result exists. Pinned against a thread id this
 * deployment minted (`channels/thread-identity.ts`) and a call id as OpenAI writes one.
 */
const parent = "55569917-dab5-8e00-871d-f32189296876";
const call = "call_Lo8pMYCXoxGTh7qG1TKwnUMB";

test("a subagent's thread is derived, not minted, and is its own", async () => {
  const thread = await subagentThreadId(parent, call);
  expect(await subagentThreadId(parent, call)).toBe(thread);
  expect(await subagentThreadId(parent, "call_other")).not.toBe(thread);
  expect(thread).not.toBe(parent);
  // A version 8 UUID carrying its conversation's deployment fingerprint, as every thread here does.
  expect(thread).toMatch(
    /^55569917-dab5-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("a result is read back from the tool message as the store holds it", () => {
  const stored = JSON.stringify(
    JSON.stringify({ answer: "Healthy.", threadId: "t", steps: 2 }),
  );
  expect(readSubagentResult(stored)).toEqual({
    answer: "Healthy.",
    threadId: "t",
    steps: 2,
  });
  expect(readSubagentResult("Refused. No subagent was started.")).toBeNull();
});
