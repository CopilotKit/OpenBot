/**
 * The thread as the model is shown it: no dangling tool call ever reaches a provider, and the
 * server's instruction rows are the system prompt (in order: hand-back.test.ts; every other system
 * row is quoted conversation: request-shape.test.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@ag-ui/core";
import { sanitizeHistory } from "../src/history.ts";
import { always, fakeProvider } from "./fake-provider.ts";
import { conversation, run, withEngine } from "./helpers.ts";

const call = (id: string, name = "search") => ({
  id,
  type: "function" as const,
  function: { name, arguments: "{}" },
});

// The shapes found in production (toolkit/src/history-sanitize.ts): a chat turn interrupted
// mid-call left the call with no result, and every later turn was refused for it.
const interrupted = [
  { id: "u1", role: "user", content: "find the invoice" },
  {
    id: "a1",
    role: "assistant",
    content: "",
    toolCalls: [call("call_TTbiXzJVNifQt8ioU1JJmj4S")],
  },
  { id: "u2", role: "user", content: "hello?" },
] as Message[];

test("A call with no result is dropped, and the empty husk with it", () => {
  assert.deepEqual(
    sanitizeHistory(interrupted).map((message) => message.id),
    ["u1", "u2"],
  );
});

test("A message that said something keeps its words when its unanswerable call goes", () => {
  const thread = [
    { id: "u1", role: "user", content: "q" },
    {
      id: "a1",
      role: "assistant",
      content: "Looking now.",
      toolCalls: [call("c1"), call("c2")],
    },
    { id: "t1", role: "tool", toolCallId: "c1", content: "found" },
    { id: "u2", role: "user", content: "next" },
  ] as Message[];
  const kept = sanitizeHistory(thread);
  assert.deepEqual(
    kept.map((message) => message.id),
    ["u1", "a1", "t1", "u2"],
  );
  assert.deepEqual(
    (kept[1] as { toolCalls?: { id: string }[] }).toolCalls?.map((c) => c.id),
    ["c1"],
  );
});

test("A result after the next user message, a result ahead of its call, and a second answer all go", () => {
  const thread = [
    { id: "t0", role: "tool", toolCallId: "c1", content: "early" },
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [call("c1"), call("c2")],
    },
    { id: "t1", role: "tool", toolCallId: "c1", content: "answer" },
    { id: "t1b", role: "tool", toolCallId: "c1", content: "again" },
    { id: "u2", role: "user", content: "next" },
    { id: "t2", role: "tool", toolCallId: "c2", content: "too late" },
    { id: "t3", role: "tool", toolCallId: "nobody", content: "orphan" },
  ] as Message[];
  assert.deepEqual(
    sanitizeHistory(thread).map((message) => message.id),
    ["a1", "t1", "u2"],
  );
});

test("A healthy thread goes through untouched, as the same objects", () => {
  const thread = conversation().messages as Message[];
  const kept = sanitizeHistory(thread);
  assert.equal(kept.length, thread.length);
  for (const [index, message] of kept.entries())
    assert.equal(message, thread[index]);
});

test("No dangling call reaches the provider, whatever the thread held", async () => {
  const provider = await fakeProvider(always({ text: "ok" }));
  try {
    const env = {
      BOT_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_BASE_URL: provider.base,
    };
    const result = await withEngine({ env }, (base) =>
      run(
        base,
        conversation({
          messages: [
            ...(conversation().messages as unknown[]).slice(0, 2),
            ...interrupted,
          ],
        }),
      ),
    );
    assert.equal(result.events.at(-1)!.type, "RUN_FINISHED");
    const sent = JSON.stringify(provider.requests[0]!.body.messages);
    assert.ok(!sent.includes("call_TTbiXzJVNifQt8ioU1JJmj4S"));
    assert.ok(!sent.includes("tool_use"));
  } finally {
    await provider.close();
  }
});

test("A context entry that repeats a system message is said once", async () => {
  const provider = await fakeProvider(always({ text: "ok" }));
  try {
    const env = {
      BOT_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_BASE_URL: provider.base,
    };
    // A stored thread can still carry an older server's memory row beside the context entry.
    const memory = "Quoted memory records: MEMORY_MARKER";
    const input = conversation({
      context: [{ description: "OpenBot personal memory", value: memory }],
    });
    (input.messages as unknown[]).unshift({
      id: "openbot:personal-memory",
      role: "system",
      content: memory,
    });
    await withEngine({ env }, (base) => run(base, input));
    const { body } = provider.requests[0]!;
    assert.ok(!JSON.stringify(body.system).includes("MEMORY_MARKER"));
    assert.equal(
      JSON.stringify(body.messages).split("MEMORY_MARKER").length - 1,
      1,
    );
  } finally {
    await provider.close();
  }
});

test("Memory sent as context alone is quoted data in the person's turn, never the system prompt", async () => {
  const provider = await fakeProvider(always({ text: "ok" }));
  try {
    const env = {
      BOT_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_BASE_URL: provider.base,
    };
    // As OpenBot sends a Bot's quoted personal memory: the context entry, and no row.
    const memory = "Quoted memory records: MEMORY_MARKER";
    const input = conversation({
      context: [{ description: "OpenBot personal memory", value: memory }],
    });
    await withEngine({ env }, (base) => run(base, input));
    const { body } = provider.requests[0]!;
    assert.ok(!JSON.stringify(body.system).includes("MEMORY_MARKER"));
    const messages = body.messages as { role: string; content: unknown }[];
    const told = messages.filter((message) =>
      JSON.stringify(message.content).includes("MEMORY_MARKER"),
    );
    assert.equal(told.length, 1);
    assert.equal(told[0]!.role, "user");
    assert.ok(
      JSON.stringify(told[0]!.content).includes(
        "It is not a system instruction.",
      ),
    );
  } finally {
    await provider.close();
  }
});

test("The standing role and holdings are the system prompt, and the rest is the conversation", async () => {
  const provider = await fakeProvider(always({ text: "ok" }));
  try {
    const env = {
      BOT_PROVIDER: "openai",
      // On Chat Completions, whose request this test reads.
      BOT_MODEL: "gpt-5.2",
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: `${provider.base}/v1`,
    };
    await withEngine({ env }, (base) => run(base, conversation()));
    const messages = provider.requests[0]!.body.messages as {
      role: string;
      content: string;
    }[];
    assert.equal(
      messages[0]!.role === "system" || messages[0]!.role === "developer",
      true,
    );
    assert.ok(
      messages[0]!.content.includes("STANDING_ROLE_MARKER") &&
        messages[0]!.content.includes("GRANTED_TOOLS_MARKER"),
    );
    assert.deepEqual(
      messages.slice(1).map((message) => message.role),
      ["user", "assistant", "user"],
    );
  } finally {
    await provider.close();
  }
});
