/**
 * Every server instance holds the conversations it read lately, and every delivery binding and push
 * device, in memory, and keeps them fresh from Intelligence's change announcements. These are the
 * guarantees a turn relies on when it reads from that memory instead of Intelligence: a change made
 * on one instance reaches another's copy without a read of its own, a thread made a moment ago on
 * another instance is still found, and a conversation purged elsewhere is forgotten here.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeKey } from "../src/conversations/http";
import {
  createDeliveryBindingsClient,
  createDeliveryDirectory,
} from "../src/delivery/directory";
import { testIntelligence, useTestBots } from "./support/bots";
import {
  eventually,
  newThreadId,
  otherReplica,
  purgeConversations,
  seedChannel,
  useTestConversations,
} from "./support/conversations";

const made: string[] = [];
let replica: Awaited<ReturnType<typeof otherReplica>>;

beforeAll(async () => {
  await useTestBots();
  replica = await otherReplica();
});

afterAll(async () => {
  replica?.stop();
  await purgeConversations(made);
});

test("a change made on one instance reaches another's copy from the announcement alone", async () => {
  const { conversations } = await useTestConversations();
  const owner = `directory-${randomUUID()}`;
  const conversation = await seedChannel(owner, ["research"]);
  made.push(conversation.id);
  // The other instance reads it once, and holds it.
  expect((await replica.get(conversation.id))?.lastMessage).toBeNull();

  const { conversation: changed } = await conversations.client.activity(
    conversation.id,
    {
      userId: owner,
      text: "Said on the first instance.",
      at: new Date(),
      agentId: null,
      sourceId: null,
      enrichFrom: null,
    },
    writeKey("test.activity"),
  );

  // Held, newer, without the other instance asking Intelligence for it.
  await eventually(
    () =>
      replica.peek(conversation.id)?.version === changed.version &&
      replica.peek(conversation.id)?.lastMessage ===
        "Said on the first instance.",
    { what: "The other instance's copy" },
  );
});

test("a thread written on one instance a moment ago is found on another", async () => {
  const { conversations } = await useTestConversations();
  const owner = `directory-${randomUUID()}`;
  const conversation = await seedChannel(owner, ["research", "writer"]);
  made.push(conversation.id);
  await replica.get(conversation.id);

  const threadId = newThreadId();
  await conversations.client.thread(
    conversation.id,
    { userId: owner, agentId: "writer", threadId },
    writeKey("test.thread"),
  );

  // Asked straight away, before any announcement could have arrived: read through.
  const found = await replica.byThread(threadId);
  expect(found?.conversation.id).toBe(conversation.id);
  expect(found?.thread).toMatchObject({ userId: owner, agentId: "writer" });
  // A thread nobody wrote is nothing, and asking again soon does not go back to Intelligence.
  expect(await replica.byThread(newThreadId())).toBeNull();
});

test("a conversation purged elsewhere is forgotten here", async () => {
  const owner = `directory-${randomUUID()}`;
  const conversation = await seedChannel(owner, ["research"]);
  await replica.get(conversation.id);
  expect(replica.peek(conversation.id)).toBeDefined();

  await purgeConversations([conversation.id]);

  await eventually(() => replica.peek(conversation.id) === undefined, {
    what: "The purge announcement",
  });
  expect(await replica.get(conversation.id)).toBeNull();
});

test("a binding made on one instance is held by another, and its change follows", async () => {
  const { delivery } = await useTestConversations();
  const intelligence = testIntelligence();
  const other = createDeliveryDirectory({
    client: createDeliveryBindingsClient({
      apiUrl: intelligence.apiUrl,
      apiKey: intelligence.apiKey,
    }),
    gatewayWsUrl: intelligence.gatewayWsUrl,
  });
  await other.start();
  try {
    const owner = `directory-${randomUUID()}`;
    const binding = await delivery.bind({
      id: randomUUID(),
      ownerUserId: owner,
      channelId: `channel_${randomUUID()}`,
      agentId: "research",
      threadId: newThreadId(),
      transport: "slack",
      realm: `T${randomUUID().slice(0, 8)}`,
      identity: `U${randomUUID().slice(0, 8)}`,
      address: `D${randomUUID().slice(0, 8)}`,
    });
    await eventually(
      () => other.bindings().some((held) => held.id === binding.id),
      { what: "The binding's announcement" },
    );
    await delivery.changeBinding(binding.id, { enabled: false });
    await eventually(
      () =>
        other.bindings().find((held) => held.id === binding.id)?.enabled ===
        false,
      { what: "The binding's change" },
    );
  } finally {
    other.stop();
  }
});
