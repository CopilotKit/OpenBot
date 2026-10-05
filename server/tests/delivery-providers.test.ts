import { describe, expect, test } from "bun:test";
import {
  AG_UI_HEARTBEAT_MS,
  agUiStream,
  BUN_IDLE_TIMEOUT_MS,
  createOpenTagTransport,
} from "../src/delivery/opentag";
import { createExpoPushTransport } from "../src/delivery/push";
import {
  createTwilioTransport,
  smsOptKeyword,
  verifyTwilioRequest,
} from "../src/delivery/twilio";

const http = (responses: unknown[]) => {
  const requests: { url: string; init?: RequestInit }[] = [];
  return {
    requests,
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json(responses.shift());
    },
  };
};
describe("signed provider ingress", () => {
  test("Twilio official fixture uses configured canonical URL and every form field", () => {
    const params = new URLSearchParams({
      CallSid: "CA1234567890ABCDE",
      Caller: "+14158675310",
      Digits: "1234",
      From: "+14158675310",
      To: "+18005551212",
    });
    const input = {
      url: "https://example.com/myapp.php?foo=1&bar=2",
      params,
      token: "12345",
      signature: "L/OH5YylLD5NRKLltdqwSvS0BnU=",
    };
    expect(verifyTwilioRequest(input)).toBe(true);
    expect(
      verifyTwilioRequest({
        ...input,
        url: "https://attacker.test/myapp.php?foo=1&bar=2",
      }),
    ).toBe(false);
    params.append("From", "+19999999999");
    expect(verifyTwilioRequest(input)).toBe(false);
  });
});
describe("real HTTP provider adapters", () => {
  test("OpenTag proactive delivery authenticates, names the Bot, and reports refusals", async () => {
    const secret = "s".repeat(40);
    const wire = http([{ ok: true, id: "171.5", channel: "D0987654321" }]);
    const opentag = createOpenTagTransport({
      secret,
      url: "http://127.0.0.1:3000",
      iconUrlTemplate: "https://avatars.test/{seed}.png",
      fetch: wire.fetch,
    });
    expect(opentag.authenticates(`Bearer ${secret}`)).toBe(true);
    expect(opentag.authenticates(`Bearer ${secret}x`)).toBe(false);
    expect(opentag.authenticates(secret)).toBe(false);
    expect(opentag.authenticates(undefined)).toBe(false);
    expect(
      await opentag.send({
        id: "out1",
        address: "U1",
        text: "Done",
        transport: "slack",
        sender: { agentId: "bot1", name: "Research Bot", avatarSeed: "a b" },
      }),
    ).toEqual({ id: "D0987654321/171.5", status: "sent" });
    expect(wire.requests[0]?.url).toBe("http://127.0.0.1:3000/openbot/deliver");
    expect(
      (wire.requests[0]?.init?.headers as Record<string, string> | undefined)
        ?.authorization,
    ).toBe(`Bearer ${secret}`);
    expect(JSON.parse(String(wire.requests[0]?.init?.body))).toEqual({
      id: "out1",
      platform: "slack",
      address: "U1",
      text: "Done",
      sender: {
        name: "Research Bot",
        iconUrl: "https://avatars.test/a%20b.png",
      },
    });
    const refused = createOpenTagTransport({
      secret,
      url: "http://127.0.0.1:3000",
      fetch: async () =>
        Response.json(
          { ok: false, error: "teams_proactive_unsupported" },
          { status: 501 },
        ),
    });
    await expect(
      refused.send({ id: "o", address: "x", text: "t", transport: "teams" }),
    ).rejects.toMatchObject({
      code: "teams_proactive_unsupported",
      uncertain: true,
    });
    await expect(
      createOpenTagTransport({ secret }).send({
        id: "o",
        address: "x",
        text: "t",
      }),
    ).rejects.toMatchObject({ code: "proactive_delivery_not_configured" });
  });
  test("OpenTag membership fails closed", async () => {
    const secret = "s".repeat(40);
    const ask = { teamId: "T1", slackUserId: "U1", channelId: "C1" };
    const yes = http([{ ok: true, member: true }]);
    expect(
      await createOpenTagTransport({
        secret,
        url: "http://127.0.0.1:3000",
        fetch: yes.fetch,
      }).isMember(ask),
    ).toBe(true);
    expect(yes.requests[0]?.url).toBe(
      "http://127.0.0.1:3000/openbot/membership",
    );
    expect(await createOpenTagTransport({ secret }).isMember(ask)).toBe(false);
    expect(
      await createOpenTagTransport({
        secret,
        url: "http://127.0.0.1:3000",
        fetch: async () => {
          throw new Error("down");
        },
      }).isMember(ask),
    ).toBe(false);
  });
  test("Twilio opt-out keywords follow Advanced Opt-Out and 21610 is named", async () => {
    expect(smsOptKeyword("STOP", "anything")).toBe("STOP");
    expect(smsOptKeyword(null, " unsubscribe ")).toBe("STOP");
    expect(smsOptKeyword(null, "Start")).toBe("START");
    expect(smsOptKeyword(null, "help")).toBe("HELP");
    expect(smsOptKeyword(null, "please stop that")).toBeNull();
    const twilio = createTwilioTransport({
      accountSid: "AC1",
      authToken: "secret",
      verifyServiceSid: "VA1",
      from: "+15550000000",
      webhookUrl: "https://o.test/sms",
      fetch: async () =>
        Response.json(
          { code: 21610, message: "Attempt to send to unsubscribed recipient" },
          { status: 400 },
        ),
    });
    await expect(
      twilio.send({ address: "+15551234567", text: "Reply", id: "out1" }),
    ).rejects.toMatchObject({ provider: "Twilio", code: "21610" });
  });
  test("Twilio verifies phone ownership before binding and sends through Messages API", async () => {
    const wire = http([
      { sid: "VE1", status: "pending" },
      { status: "approved", to: "+15551234567" },
      { sid: "SM1", status: "queued" },
    ]);
    const twilio = createTwilioTransport({
      accountSid: "AC1",
      authToken: "secret",
      verifyServiceSid: "VA1",
      from: "+15550000000",
      webhookUrl: "https://o.test/sms",
      fetch: wire.fetch,
    });
    await twilio.startVerification("+15551234567");
    expect(await twilio.checkVerification("+15551234567", "123456")).toBe(true);
    expect(
      await twilio.send({ address: "+15551234567", text: "Reply", id: "out1" }),
    ).toEqual({ id: "SM1", status: "queued" });
    expect(wire.requests[2]?.url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json",
    );
    expect(
      new URLSearchParams(String(wire.requests[2]?.init?.body)).get("To"),
    ).toBe("+15551234567");
  });
  test("Expo sends canonical deep links and reads receipts including invalid devices", async () => {
    const wire = http([
      { data: { status: "ok", id: "ticket1" } },
      {
        data: {
          ticket1: {
            status: "error",
            details: { error: "DeviceNotRegistered" },
          },
        },
      },
    ]);
    const push = createExpoPushTransport({ fetch: wire.fetch });
    expect(
      await push.send({
        token: "ExpoPushToken[abc]",
        title: "OpenBot",
        body: "Question",
        channelId: "ch1",
        kind: "question",
        requestId: "q1",
      }),
    ).toEqual({ id: "ticket1", status: "accepted" });
    const message = JSON.parse(String(wire.requests[0]?.init?.body));
    expect(message.data).toEqual({
      channelId: "ch1",
      kind: "question",
      requestId: "q1",
      url: "openbotmobile://approvals?channelId=ch1&requestId=q1",
    });
    expect(await push.receipt("ticket1")).toEqual({
      status: "failed",
      error: "DeviceNotRegistered",
      revokeDevice: true,
    });
  });
});

test("a quiet OpenTag stream speaks before Bun closes it as idle", async () => {
  // At 20 s a turn longer than Bun's 10 s idle limit lost its stream mid-answer.
  expect(AG_UI_HEARTBEAT_MS).toBeLessThan(BUN_IDLE_TIMEOUT_MS);
  const stream = agUiStream(
    () => new Promise((resolve) => setTimeout(resolve, 60)),
    10,
  );
  const text = await new Response(stream).text();
  expect(text).toContain('"name":"openbot.working"');
});
