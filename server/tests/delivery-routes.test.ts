import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createOpenTagTransport } from "../src/delivery/opentag";
import type { ConverseResult } from "../src/delivery/router";
import { createDeliveryWebhookRoutes } from "../src/delivery/routes";
import { createTwilioTransport } from "../src/delivery/twilio";
import type { DeliveryBinding } from "../src/delivery/types";

const SECRET = "x".repeat(48);
const APPROVAL = "0f8fad5b-d9cb-469f-a165-70867728950e";
const bound: DeliveryBinding = {
  id: "b1",
  ownerUserId: "owner",
  channelId: "ch",
  agentId: "bot",
  threadId: "canonical",
  transport: "slack",
  realm: "T1",
  identity: "U1",
  address: "U1",
  enabled: true,
};
type IdentityAdapter = {
  redeem(
    code: string,
    sender: { teamId: string; userId: string },
  ): Promise<"linked" | "conflict" | "invalid">;
};
function fixture(
  options: {
    converse?: ConverseResult;
    bound?: boolean;
    identity?: IdentityAdapter;
  } = {},
) {
  const calls: unknown[] = [];
  const decisions: unknown[] = [];
  const twilio = createTwilioTransport({
    accountSid: "AC1",
    authToken: "token",
    verifyServiceSid: "VA1",
    from: "+15550000000",
    webhookUrl: "https://o.test/api/delivery/webhooks/sms",
    statusUrl: "https://o.test/api/delivery/webhooks/sms/status",
  });
  const routes = createDeliveryWebhookRoutes({
    router: {
      receive: async (input) => {
        calls.push(input);
        return { queued: true };
      },
      notify: async (scope, input) => {
        calls.push({ notify: [scope, input] });
      },
      smsOptOut: async (...input) => {
        calls.push({ optOut: input });
        return 1;
      },
      converse: async (input) => {
        calls.push({ converse: input });
        return (
          options.converse ?? {
            kind: "replied",
            binding: bound,
            inboxId: "in1",
            replyText: "Hello from your Bot.",
            extras: { approvals: [], questions: [] },
          }
        );
      },
    },
    store: {
      readChallenge: async (id: string) =>
        id === "11111111-2222-4333-8444-555555555555"
          ? {
              id,
              ownerUserId: "owner",
              channelId: "ch",
              agentId: "bot",
              threadId: "canonical",
              transport: "slack",
              address: null,
            }
          : null,
      consumeChallenge: async () => true,
      bind: async (input) => {
        calls.push({ bind: input });
        return { ...bound, ...input };
      },
      updateSmsStatus: async (...input) => {
        calls.push(input);
      },
      findBinding: async (transport, realm, identity) =>
        options.bound !== false &&
        transport === "slack" &&
        realm === "T1" &&
        identity === "U1"
          ? bound
          : null,
      botIdentity: async (agentId) => ({ agentId, name: "Research Bot" }),
    },
    scopeFor: async (ownerUserId, channelId, agentId) =>
      ownerUserId === "owner"
        ? { ownerUserId, channelId, agentId, threadId: "canonical" }
        : null,
    slack: createOpenTagTransport({ secret: SECRET }),
    ingestSlack: async (event) => {
      calls.push({ trigger: event });
      return { matched: 0, deliveries: [] };
    },
    twilio,
    ...(options.identity ? { identity: options.identity } : {}),
    approvals: {
      store: {
        get: async (owner, id) => {
          if (owner !== "owner" || id !== APPROVAL)
            throw new Error("not found");
          return {
            status: "pending",
            action: {
              botId: "bot",
              toolRef: "browser/navigate",
              effect: "write",
              threadId: "canonical",
              args: { url: "https://example.com" },
            },
          };
        },
      },
      decide: async (...input) => {
        decisions.push(input);
        return {};
      },
      answerQuestion: async (...input) => {
        decisions.push({ answer: input });
        return {};
      },
      inbox: async () => ({ questions: [] }),
    },
  });
  return { routes, calls, decisions };
}
const sender = (
  user = "slack:T1:U1",
  conversation: unknown = { id: "D0123456789", kind: "im" },
) => ({
  description: "openbot.sender",
  value: JSON.stringify({ user, event: "Ev9", conversation }),
});
async function run(
  f: ReturnType<typeof fixture>,
  body: Record<string, unknown>,
  authorization = `Bearer ${SECRET}`,
) {
  const response = await f.routes.request("/opentag/agent", {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify({
      threadId: "opentag-thread",
      runId: "run1",
      state: {},
      tools: [],
      messages: [],
      context: [],
      forwardedProps: {},
      ...body,
    }),
  });
  if (response.status !== 200) return { status: response.status, events: [] };
  const text = await response.text();
  const events = text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)));
  return { status: response.status, events };
}
const said = (events: { type: string; delta?: string }[]) =>
  events
    .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
    .map((e) => e.delta)
    .join("");

test("OpenTag agent refuses a wrong shared secret before reading the run", async () => {
  const f = fixture();
  expect((await run(f, {}, "Bearer wrong")).status).toBe(401);
  expect((await run(f, {}, SECRET)).status).toBe(401);
  expect(f.calls).toHaveLength(0);
});
test("unbound and unattributed senders get instructions, never a run", async () => {
  const f = fixture({ bound: false });
  const unbound = await run(f, {
    context: [sender()],
    messages: [{ id: "m1", role: "user", content: "<@UBOT> hi" }],
  });
  expect(unbound.events[0]).toMatchObject({ type: "RUN_STARTED" });
  expect(said(unbound.events)).toContain("link <code>");
  expect(unbound.events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
  const anonymous = await run(f, {
    messages: [{ id: "m1", role: "user", content: "hi" }],
  });
  expect(said(anonymous.events)).toContain("did not say who sent");
  const twice = await run(f, {
    context: [sender(), sender("slack:T1:U2")],
    messages: [{ id: "m1", role: "user", content: "hi" }],
  });
  expect(said(twice.events)).toContain("did not say who sent");
  expect(
    f.calls.filter((c) => (c as { converse?: unknown }).converse),
  ).toHaveLength(0);
});
test("a link code binds the verified sender to the challenge's own scope", async () => {
  const f = fixture({ bound: false });
  const result = await run(f, {
    context: [sender()],
    messages: [
      {
        id: "m1",
        role: "user",
        content: "<@UBOT> link 11111111-2222-4333-8444-555555555555",
      },
    ],
  });
  expect(said(result.events)).toContain("Linked");
  expect(f.calls).toEqual([
    {
      bind: {
        ownerUserId: "owner",
        channelId: "ch",
        agentId: "bot",
        threadId: "canonical",
        transport: "slack",
        realm: "T1",
        identity: "U1",
        address: "U1",
      },
    },
  ]);
});
const IDENTITY_CODE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EXPIRED =
  "That link code expired, was already used, or is for another app. Create a new one in OpenBot.";
function identityFixture(outcome?: "linked" | "conflict" | "invalid") {
  const redeemed: unknown[] = [];
  const f = fixture({
    bound: false,
    ...(outcome
      ? {
          identity: {
            redeem: async (code, who) => {
              redeemed.push([code, who]);
              return outcome;
            },
          },
        }
      : {}),
  });
  return { f, redeemed };
}
const linkMessage = (code: string) => ({
  messages: [
    { id: "m1", role: "user", content: `<@UBOT> link ${code.toUpperCase()}` },
  ],
});
test("a Reachability code is checked before the identity adapter", async () => {
  const { f, redeemed } = identityFixture("linked");
  const result = await run(f, {
    context: [sender()],
    ...linkMessage("11111111-2222-4333-8444-555555555555"),
  });
  expect(said(result.events)).toContain("Linked");
  expect(f.calls).toHaveLength(1);
  expect(redeemed).toEqual([]);
});
test("an identity code from a Slack sender is redeemed through the adapter", async () => {
  const { f, redeemed } = identityFixture("linked");
  const result = await run(f, {
    context: [sender()],
    ...linkMessage(IDENTITY_CODE),
  });
  expect(said(result.events)).toBe(
    "Linked your Slack account to OpenBot. You can see it under Settings → Connected accounts.",
  );
  expect(redeemed).toEqual([[IDENTITY_CODE, { teamId: "T1", userId: "U1" }]]);
});
test("an identity code sent where others can read it is not redeemed", async () => {
  for (const conversation of [{ id: "C0123456789", kind: "channel" }, null]) {
    const { f, redeemed } = identityFixture("linked");
    const result = await run(f, {
      context: [sender("slack:T1:U1", conversation)],
      ...linkMessage(IDENTITY_CODE),
    });
    expect(said(result.events)).toBe(
      "Send your link code to me in a direct message, not in a channel. It still works until it expires.",
    );
    expect(redeemed).toEqual([]);
    expect(f.calls).toEqual([]);
  }
});
test("a Reachability code still links from a shared conversation", async () => {
  const { f, redeemed } = identityFixture("linked");
  const result = await run(f, {
    context: [sender("slack:T1:U1", { id: "C0123456789", kind: "channel" })],
    ...linkMessage("11111111-2222-4333-8444-555555555555"),
  });
  expect(said(result.events)).toContain("Linked.");
  expect(redeemed).toEqual([]);
});
test("an identity code conflict names the other user", async () => {
  const { f } = identityFixture("conflict");
  const result = await run(f, {
    context: [sender()],
    ...linkMessage(IDENTITY_CODE),
  });
  expect(said(result.events)).toBe(
    "This Slack account is already linked to another OpenBot user.",
  );
});
test("an invalid identity code gets the expired reply", async () => {
  const { f } = identityFixture("invalid");
  const result = await run(f, {
    context: [sender()],
    ...linkMessage(IDENTITY_CODE),
  });
  expect(said(result.events)).toBe(EXPIRED);
});
test("a Teams sender never reaches the identity adapter", async () => {
  const { f, redeemed } = identityFixture("linked");
  const result = await run(f, {
    context: [sender("teams:tenant1:user1")],
    ...linkMessage(IDENTITY_CODE),
  });
  expect(said(result.events)).toBe(EXPIRED);
  expect(redeemed).toEqual([]);
});
test("without an identity adapter an unknown code gets the expired reply", async () => {
  const { f } = identityFixture();
  const result = await run(f, {
    context: [sender()],
    ...linkMessage(IDENTITY_CODE),
  });
  expect(said(result.events)).toBe(EXPIRED);
});
test("bound sender runs the canonical turn and an approval becomes an OpenTag card", async () => {
  const f = fixture({
    converse: {
      kind: "waiting",
      binding: bound,
      inboxId: "in1",
      replyText: "",
      extras: { approvals: [APPROVAL], questions: [] },
    },
  });
  const result = await run(f, {
    context: [sender()],
    messages: [{ id: "m9", role: "user", content: "<@UBOT> open example.com" }],
  });
  expect(
    f.calls.find((c) => (c as { converse?: unknown }).converse),
  ).toMatchObject({
    converse: {
      transport: "slack",
      realm: "T1",
      identity: "U1",
      externalId: "event:Ev9",
      text: "open example.com",
    },
  });
  const card = result.events.find(
    (e) => e.type === "CUSTOM" && e.name === "on_interrupt",
  );
  expect(card.value).toEqual({
    __opentag_interrupt_id__: "0f8fad5bd9cb469fa16570867728950e",
    __copilotkit_interrupt_value__: {
      action: "confirm_write",
      args: {
        action: "Research Bot: browser/navigate",
        fields: [{ label: "url", value: "https://example.com" }],
        approver: "slack:U1",
        effect: "write",
        allow_always: true,
      },
    },
  });
  expect(result.events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
});
test("in a conversation others may read, the answer goes to the owner privately", async () => {
  const f = fixture({
    converse: {
      kind: "waiting",
      binding: bound,
      inboxId: "in1",
      replyText: "Your salary review is attached.",
      extras: {
        approvals: [APPROVAL],
        questions: [{ id: "q1", text: "Research Bot asks: which quarter?" }],
      },
    },
  });
  for (const conversation of [{ id: "C0123456789", kind: "channel" }, null]) {
    f.calls.length = 0;
    const result = await run(f, {
      context: [sender("slack:T1:U1", conversation)],
      messages: [{ id: "m1", role: "user", content: "<@UBOT> status?" }],
    });
    expect(said(result.events)).toBe(
      "Other people may be able to read this conversation, so I sent my answer to you directly.",
    );
    expect(
      result.events.some(
        (e) => e.type === "CUSTOM" && e.name === "on_interrupt",
      ),
    ).toBe(false);
    const sent = f.calls
      .map(
        (c) =>
          (c as { notify?: [unknown, { kind: string; text: string }] })
            .notify?.[1],
      )
      .filter(Boolean);
    expect(sent.map((n) => n?.kind)).toEqual(["reply", "question", "approval"]);
    expect(sent[0]?.text).toBe("Your salary review is attached.");
  }
});
test("verified Slack events feed the owners' triggers once, and observe-only runs stay quiet", async () => {
  const f = fixture();
  await run(f, {
    context: [sender()],
    messages: [{ id: "m1", role: "user", content: "<@UBOT> hi" }],
  });
  const mention = JSON.parse(sender().value);
  mention.mentioned = true;
  mention.event = "Ev10";
  await run(f, {
    context: [
      { description: "openbot.sender", value: JSON.stringify(mention) },
    ],
    messages: [{ id: "m2", role: "user", content: "<@UBOT> hi" }],
  });
  const observed = await run(f, {
    context: [
      {
        description: "openbot.sender",
        value: JSON.stringify({
          user: "slack:T1:U1",
          event: "Ev11",
          conversation: { id: "C0123456789", kind: "channel" },
          observe: "reaction_added",
          reaction: ":eyes:",
        }),
      },
    ],
  });
  expect(said(observed.events)).toBe("");
  expect(observed.events.map((e) => e.type)).toEqual([
    "RUN_STARTED",
    "RUN_FINISHED",
  ]);
  const triggers = f.calls
    .map((c) => (c as { trigger?: Record<string, unknown> }).trigger)
    .filter(Boolean);
  expect(triggers.map((t) => t?.type)).toEqual([
    "message",
    "app_mention",
    "reaction_added",
  ]);
  expect(triggers[0]).toMatchObject({
    teamId: "T1",
    eventId: "Ev9",
    channelId: "D0123456789",
    userId: "U1",
    text: "hi",
  });
  expect(triggers[2]).toMatchObject({
    reaction: "eyes",
    channelId: "C0123456789",
  });
  // Only one conversational turn per real message; the reaction ran none.
  expect(
    f.calls.filter((c) => (c as { converse?: unknown }).converse),
  ).toHaveLength(2);
});
test("card resume decides through the approvals service as the binding owner only", async () => {
  const f = fixture();
  const resume = (value: unknown) =>
    run(f, {
      forwardedProps: {
        command: { resume: { "0f8fad5bd9cb469fa16570867728950e": value } },
      },
    });
  expect(
    said(
      (await resume({ confirmed: true, always: true, by: "slack:T1:U1" }))
        .events,
    ),
  ).toContain("Always allowed");
  expect(f.decisions).toEqual([["owner", APPROVAL, "allow_always"]]);
  expect(
    said((await resume({ confirmed: true, by: "slack:T1:U2" })).events),
  ).toContain("not linked");
  expect(said((await resume({ confirmed: true })).events)).toContain(
    "did not say who answered",
  );
  expect(f.decisions).toHaveLength(1);
  await resume({ confirmed: false, by: "slack:T1:U1" });
  expect(f.decisions[1]).toEqual(["owner", APPROVAL, "deny"]);
});
test("SMS STOP and START record opt-out without a turn or a second reply", async () => {
  const f = fixture();
  const signedRequest = (params: URLSearchParams) => {
    const signed =
      "https://o.test/api/delivery/webhooks/sms" +
      [...params.keys()]
        .sort()
        .map((k) => k + params.get(k))
        .join("");
    return f.routes.request("/sms", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": createHmac("sha1", "token")
          .update(signed)
          .digest("base64"),
      },
      body: params.toString(),
    });
  };
  const base = { AccountSid: "AC1", From: "+15551234567", To: "+15550000000" };
  const stop = await signedRequest(
    new URLSearchParams({
      ...base,
      MessageSid: "SM1",
      Body: "STOP",
      OptOutType: "STOP",
    }),
  );
  expect(await stop.text()).toBe("<Response/>");
  await signedRequest(
    new URLSearchParams({ ...base, MessageSid: "SM2", Body: "start" }),
  );
  await signedRequest(
    new URLSearchParams({ ...base, MessageSid: "SM3", Body: "HELP" }),
  );
  expect(f.calls).toEqual([
    { optOut: ["AC1", "+15551234567", true] },
    { optOut: ["AC1", "+15551234567", false] },
  ]);
});
test("Twilio canonical signature validates account and recipient then returns empty TwiML", async () => {
  const f = fixture();
  const params = new URLSearchParams({
    AccountSid: "AC1",
    MessageSid: "SM1",
    From: "+15551234567",
    To: "+15550000000",
    Body: "hello",
  });
  const signed =
    "https://o.test/api/delivery/webhooks/sms" +
    [...params.keys()]
      .sort()
      .map((k) => k + params.get(k))
      .join("");
  const signature = createHmac("sha1", "token").update(signed).digest("base64");
  const response = await f.routes.request("https://untrusted-host.test/sms", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body: params.toString(),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("<Response/>");
  expect(f.calls[0]).toMatchObject({
    source: "sms",
    realm: "AC1",
    identity: "+15551234567",
    externalId: "SM1",
    text: "hello",
  });
  const bad = await f.routes.request("/sms", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": "bad",
    },
    body: params.toString(),
  });
  expect(bad.status).toBe(401);
});

test("a chart the Bot drew is drawn natively by the Channel, and its follow-up run stays quiet", async () => {
  const f = fixture({
    converse: {
      kind: "replied",
      binding: bound,
      inboxId: "in1",
      replyText: "github.com led the front page.",
      components: [
        {
          name: "showBarChart",
          args: {
            title: "Top domains",
            points: [
              { label: "github.com", value: 3 },
              { label: "a-very-long-domain-name.example.com", value: 2 },
            ],
          },
        },
        { name: "showRecord", args: { title: "Not a chart", fields: [] } },
      ],
      extras: { approvals: [], questions: [] },
    },
  });
  const offered = [{ name: "render_chart", description: "", parameters: {} }];
  const result = await run(f, {
    tools: offered,
    context: [sender()],
    messages: [{ id: "m1", role: "user", content: "chart it" }],
  });
  expect(said(result.events)).toBe("github.com led the front page.");
  const start = result.events.find((e) => e.type === "TOOL_CALL_START");
  expect(start).toMatchObject({ toolCallName: "render_chart" });
  expect(start.toolCallId).toStartWith("openbot-component-");
  const args = JSON.parse(
    result.events.find((e) => e.type === "TOOL_CALL_ARGS").delta,
  );
  expect(args).toEqual({
    title: "Top domains",
    chart: {
      type: "bar",
      series: [
        {
          name: "Top domains",
          data: [
            { label: "github.com", value: 3 },
            { label: "a-very-long-domain-…", value: 2 },
          ],
        },
      ],
      axis_config: { categories: ["github.com", "a-very-long-domain-…"] },
    },
  });
  expect(
    result.events.filter((e) => e.type === "TOOL_CALL_START"),
  ).toHaveLength(1);
  expect(result.events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });

  // A Channel that offers no chart component gets the text only.
  const plain = await run(f, {
    context: [sender()],
    messages: [{ id: "m2", role: "user", content: "chart it" }],
  });
  expect(plain.events.some((e) => e.type === "TOOL_CALL_START")).toBe(false);

  // The Channel runs us again with the component's result: nothing new runs or is said.
  const turns = f.calls.filter(
    (c) => (c as { converse?: unknown }).converse,
  ).length;
  const followUp = await run(f, {
    tools: offered,
    context: [sender()],
    messages: [
      { id: "m1", role: "user", content: "chart it" },
      {
        // As the Channel sends it: an assistant tool-call message has no content key at all.
        id: "a1",
        role: "assistant",
        toolCalls: [
          {
            id: start.toolCallId,
            type: "function",
            function: { name: "render_chart", arguments: "{}" },
          },
        ],
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: start.toolCallId,
        content: 'Rendered component "render_chart".',
      },
    ],
  });
  expect(said(followUp.events)).toBe("");
  expect(followUp.events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
  expect(
    f.calls.filter((c) => (c as { converse?: unknown }).converse),
  ).toHaveLength(turns);
});
test("a channel message from a colleague who never linked still reaches the owners' Slack triggers", async () => {
  // Whose triggers fire is decided by each owner's channel membership in the ingest, never by the
  // author's own link: the author here has no OpenBot binding at all.
  const f = fixture({ bound: false });
  const observed = await run(f, {
    context: [
      {
        description: "openbot.sender",
        value: JSON.stringify({
          user: "slack:T1:U9COLLEAGUE",
          event: "Ev42",
          conversation: { id: "C0123456789", kind: "channel" },
          observe: "message",
        }),
      },
    ],
    messages: [{ id: "m1", role: "user", content: "deploy is broken" }],
  });
  expect(said(observed.events)).toBe("");
  const triggers = f.calls
    .map((c) => (c as { trigger?: Record<string, unknown> }).trigger)
    .filter(Boolean);
  expect(triggers).toEqual([
    expect.objectContaining({
      teamId: "T1",
      eventId: "Ev42",
      channelId: "C0123456789",
      userId: "U9COLLEAGUE",
      text: "deploy is broken",
    }),
  ]);
});
