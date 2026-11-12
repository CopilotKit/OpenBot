import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  AbstractAgent,
  BaseEvent,
  Message,
  RunAgentInput,
} from "@ag-ui/client";
import type { StoredAttachment } from "../src/channels/attachment-parts";
import { buildAgents, standingRoleMessage } from "../src/copilot";

/*
 * A file a person attached stays a file on screen after a Bot on an endpoint answers.
 *
 * FOUND ON OPENBOT DESKTOP 1.0.2. The Personal Assistant on the LangGraph harness was sent a text
 * file. While it answered, the message showed the file; when the answer finished, the message turned
 * into the whole file as one giant block of text, and stayed that way after a reload. An image went
 * the other way: its thumbnail vanished.
 *
 * The server puts the file's contents in front of the model on the way to the endpoint, and the
 * endpoint (ag-ui-langgraph, like most AG-UI integrations) ends its run with a MESSAGES_SNAPSHOT of
 * the thread as it holds it: every message it was sent, contents included, and its reply. The
 * browser replaces its messages with that snapshot, and Intelligence stores it as the thread.
 *
 * So the endpoint here does exactly that, over real HTTP, and the Bot is built through
 * `buildAgents`, the path a person's run takes. The model must still be sent the file; the snapshot
 * that comes back must hold the person's message as they sent it.
 */

const FILE_TEXT = [
  "Quarterly planning notes",
  ...Array.from(
    { length: 40 },
    (_, index) =>
      `Line ${index + 1}: the lighthouse keeper logs the tide at dawn.`,
  ),
].join("\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const stored: Record<string, StoredAttachment> = {
  notes: {
    mimeType: "text/plain",
    name: "planning-notes.txt",
    bytes: Buffer.from(FILE_TEXT),
  },
  photo: { mimeType: "image/png", name: "gradient.png", bytes: PNG },
};

/** A person's message as the composer sends it: the words, then a reference per file. */
function sent(id: string, text: string, ...files: string[]): Message {
  return {
    id,
    role: "user",
    content: [
      { type: "text", text },
      ...files.map((file) => ({
        type: stored[file]?.mimeType.startsWith("image/")
          ? "image"
          : "document",
        source: { type: "url", value: `/api/attachments/${file}` },
        metadata: { attachmentId: file, filename: stored[file]?.name },
      })),
    ],
  } as Message;
}

/** What each run sent to the endpoint. */
const received: RunAgentInput[] = [];

/**
 * An AG-UI endpoint that answers in one line and ends with the thread as it holds it, which is how
 * ag-ui-langgraph ends every run: the messages it was given, as given, and its reply.
 */
const endpoint = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const body = (await request.json()) as RunAgentInput;
    received.push(body);
    const reply = {
      id: `reply-${received.length}`,
      role: "assistant",
      content: "It is a set of planning notes.",
    };
    const events = [
      { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
      { type: "TEXT_MESSAGE_START", messageId: reply.id, role: "assistant" },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: reply.id,
        delta: reply.content,
      },
      { type: "TEXT_MESSAGE_END", messageId: reply.id },
      { type: "MESSAGES_SNAPSHOT", messages: [...body.messages, reply] },
      { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
    ];
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});

afterAll(() => endpoint.stop(true));

const pickedHarness = {
  id: "picked-harness",
  name: "Personal Assistant",
  type: "remote_ag_ui" as const,
  endpoint: `http://127.0.0.1:${endpoint.port}/`,
  standingMessage: standingRoleMessage({
    id: "picked-harness",
    name: "Personal Assistant",
    title: "Everyday life. Powered by LangChain.",
    roleDescription: "Help with email, your calendar and everyday errands.",
  }),
};

let agent: AbstractAgent;

beforeAll(async () => {
  const agents = await buildAgents(
    [pickedHarness],
    { provider: "openai", defaultModel: "gpt-5.5" },
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (id) => stored[id] ?? null,
  );
  const built = agents["picked-harness"];
  if (!built) throw new Error("buildAgents returned no picked-harness Bot");
  agent = built;
});

/** One run of the Bot over `messages`, and the snapshot it emitted. */
async function run(messages: Message[]) {
  const bot = agent.clone();
  bot.threadId = "thread-attachment-snapshot";
  bot.setMessages(messages);
  const snapshots: Message[][] = [];
  await bot.runAgent(
    {},
    {
      onEvent: ({ event }: { event: BaseEvent }) => {
        if (event.type === "MESSAGES_SNAPSHOT")
          snapshots.push(
            (event as BaseEvent & { messages: Message[] }).messages,
          );
      },
    },
  );
  const snapshot = snapshots.at(-1);
  if (!snapshot) throw new Error("the run emitted no MESSAGES_SNAPSHOT");
  const after: Message[] = bot.messages;
  return { snapshot, after, toEndpoint: received.at(-1) };
}

const byId = (messages: readonly Message[] | undefined, id: string) =>
  messages?.find((message) => message.id === id);

describe("a Bot on an endpoint, answering a message with a file attached", () => {
  test("a text file: the model reads its contents, the thread keeps the file", async () => {
    const message = sent("m-text", "Describe this file.", "notes");
    const { snapshot, after, toEndpoint } = await run([message]);

    // The model is sent the contents, exactly as before.
    expect(JSON.stringify(byId(toEndpoint?.messages, "m-text"))).toContain(
      "Line 40: the lighthouse keeper logs the tide at dawn.",
    );
    // What comes back, and what the browser holds once it is applied, is the message as sent.
    expect(byId(snapshot, "m-text")?.content).toEqual(message.content);
    expect(byId(after, "m-text")?.content).toEqual(message.content);
    expect(JSON.stringify(after)).not.toContain("the lighthouse keeper");
    // The Bot's own reply is untouched.
    expect(after.find((message) => message.role === "assistant")?.content).toBe(
      "It is a set of planning notes.",
    );
  });

  test("an image: the model sees the picture, the thread keeps the reference", async () => {
    const message = sent("m-image", "What is in this picture?", "photo");
    const { snapshot, after, toEndpoint } = await run([message]);

    expect(JSON.stringify(byId(toEndpoint?.messages, "m-image"))).toContain(
      PNG.toString("base64"),
    );
    expect(byId(snapshot, "m-image")?.content).toEqual(message.content);
    expect(byId(after, "m-image")?.content).toEqual(message.content);
  });

  test("files earlier in the thread come back as sent too", async () => {
    const earlier = sent("m-1", "Here are my notes.", "notes");
    const now = sent("m-3", "And this picture?", "photo");
    const { snapshot } = await run([
      earlier,
      { id: "a-2", role: "assistant", content: "Got them." } as Message,
      now,
    ]);

    expect(byId(snapshot, "m-1")?.content).toEqual(earlier.content);
    expect(byId(snapshot, "a-2")?.content).toBe("Got them.");
    expect(byId(snapshot, "m-3")?.content).toEqual(now.content);
  });

  test("a message with no file comes back exactly as the endpoint sent it", async () => {
    const plain = { id: "m-plain", role: "user", content: "Hello" } as Message;
    const { snapshot } = await run([plain]);

    expect(byId(snapshot, "m-plain")).toEqual(plain);
  });
});
