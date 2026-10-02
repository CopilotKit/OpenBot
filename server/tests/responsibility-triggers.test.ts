import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, createSign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEmailTriggerRoutes,
  createSnsVerifier,
  extractEmailText,
  isSnsUrl,
  type SnsMessage,
  snsStringToSign,
} from "../src/responsibilities/email";
import {
  verifyBearer,
  verifyGithubSignature,
  verifyLinearSignature,
  verifyPagerDutySignature,
  verifySentrySignature,
  verifyStandardWebhook,
} from "../src/responsibilities/signatures";
import {
  createSlackTriggerIngest,
  type SlackTriggerEvent,
  slackTriggerMatches,
} from "../src/responsibilities/slack";
import { createTriggerIngressRoutes } from "../src/responsibilities/trigger-routes";
import {
  fitPayload,
  matchesFilter,
  parseTriggerConfig,
  type ResolvedTrigger,
  type TriggerConfig,
} from "../src/responsibilities/triggers";
import type { ResponsibilityEvent } from "../src/responsibilities/types";

const TRIGGER_ID = "5b0f5a36-8f3e-4b0e-9f53-0a4c1d1e2f30";
const NOW = 1_790_000_000_000;

/** Independent implementation of the HMAC, to cross-check ours against OpenSSL's CLI. */
function opensslHmacHex(secret: string, data: string) {
  const out = spawnSync(
    "openssl",
    ["dgst", "-sha256", "-hmac", secret, "-hex"],
    {
      input: data,
    },
  );
  return out.stdout.toString().trim().split(" ").pop() ?? "";
}

describe("vendor signature schemes", () => {
  test("GitHub's documented test vector verifies", () => {
    // https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries#testing-the-webhook-payload-validation
    expect(
      verifyGithubSignature(
        "It's a Secret to Everybody",
        "Hello, World!",
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      ),
    ).toBe(true);
    expect(
      verifyGithubSignature(
        "wrong",
        "Hello, World!",
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      ),
    ).toBe(false);
  });
  test("Standard Webhooks' published test vector verifies, and the window is enforced", () => {
    const headers = {
      id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
      timestamp: "1614265330",
      signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    };
    const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const body = '{"test": 2432232314}';
    expect(verifyStandardWebhook(secret, body, headers, 1614265330)).toBe(true);
    expect(verifyStandardWebhook(secret, `${body} `, headers, 1614265330)).toBe(
      false,
    );
    expect(verifyStandardWebhook(secret, body, headers, 1614265330 + 301)).toBe(
      false,
    );
    // A rotation header carrying a stale signature first still passes on the live one.
    expect(
      verifyStandardWebhook(
        secret,
        body,
        { ...headers, signature: `v1,AAAA ${headers.signature}` },
        1614265330,
      ),
    ).toBe(true);
  });
  test("Linear, Sentry and PagerDuty match OpenSSL's HMAC-SHA256 over the raw body", () => {
    const secret = "lin_wh_fixture";
    const body =
      '{"action":"create","type":"Issue","data":{"id":"1"},"webhookTimestamp":1}';
    const hex = opensslHmacHex(secret, body);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyLinearSignature(secret, body, hex)).toBe(true);
    expect(verifyLinearSignature(secret, body, hex.replace(/.$/, "0"))).toBe(
      hex.endsWith("0"),
    );
    expect(verifySentrySignature(secret, body, hex)).toBe(true);
    // Sentry signs JSON.stringify(body): a re-encoded (pretty) body still verifies.
    expect(
      verifySentrySignature(
        secret,
        JSON.stringify(JSON.parse(body), null, 2),
        hex,
      ),
    ).toBe(true);
    expect(verifyPagerDutySignature(secret, body, `v1=${hex}`)).toBe(true);
    expect(
      verifyPagerDutySignature(secret, body, `v1=${"0".repeat(64)}, v1=${hex}`),
    ).toBe(true);
    expect(verifyPagerDutySignature(secret, body, `v2=${hex}`)).toBe(false);
  });
  test("bearer compares the whole token", () => {
    expect(verifyBearer("whsec_abc", "Bearer whsec_abc")).toBe(true);
    expect(verifyBearer("whsec_abc", "Bearer whsec_ab")).toBe(false);
    expect(verifyBearer("whsec_abc", "whsec_abc")).toBe(false);
  });
});

describe("matching rule", () => {
  test("event type matches exactly or by prefix, with one optional field equality", () => {
    const filter = {
      eventTypes: ["Issue"],
      field: { path: "data.team.key", equals: "eng" },
    };
    expect(
      matchesFilter(filter, "Issue.create", { data: { team: { key: "ENG" } } }),
    ).toBe(true);
    expect(
      matchesFilter(filter, "Issue.create", { data: { team: { key: "OPS" } } }),
    ).toBe(false);
    expect(
      matchesFilter(filter, "IssueLabel.create", {
        data: { team: { key: "ENG" } },
      }),
    ).toBe(false);
    expect(matchesFilter({ eventTypes: [] }, "anything", {})).toBe(true);
  });
  test("oversized payloads are fitted under the ledger cap, keeping top-level scalars", () => {
    const fitted = fitPayload({ action: "created", huge: "x".repeat(100_000) });
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(32_768);
    expect(fitted.action).toBe("created");
    expect(fitted.truncated).toBe(true);
  });
  test("a payload whose top-level scalars alone exceed the cap is still fitted", () => {
    // Forty 1000-character fields: before, this never returned.
    const flat = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`field${i}`, "y".repeat(1000)]),
    );
    const fitted = fitPayload(flat);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(32_768);
    expect(fitted.field0).toBe("y".repeat(1000));
    expect(fitted.truncated).toBe(true);
  });
  test("config validation refuses a phrase listener with no phrases", () => {
    expect(() =>
      parseTriggerConfig({ kind: "slack", teamId: "T123", mode: "phrase" }),
    ).toThrow();
  });
});

function trigger(
  config: TriggerConfig,
  overrides: Partial<ResolvedTrigger> = {},
): ResolvedTrigger {
  return {
    id: TRIGGER_ID,
    ownerUserId: "owner-1",
    responsibilityId: "goal-1",
    responsibilityStatus: "active",
    kind: config.kind,
    config,
    secret: "whsec_c2VjcmV0LWZpeHR1cmUtb25seQ==",
    enabled: true,
    createdAt: new Date(NOW - 60_000),
    ...overrides,
  };
}
function ingress(resolved: ResolvedTrigger | null) {
  const events: ResponsibilityEvent[] = [];
  const audits: unknown[] = [];
  const routes = createTriggerIngressRoutes({
    directory: {
      resolve: async (id) => (id === TRIGGER_ID ? resolved : null),
      slackTriggers: async () => [],
    },
    ingest: async (event) => {
      events.push(event);
      return { eventId: "event-1", duplicate: false, runIds: ["run-1"] };
    },
    auditStore: { insert: async (entry) => void audits.push(entry) },
    now: () => NOW,
  });
  const post = (body: string, headers: Record<string, string>) =>
    routes.fetch(
      new Request(`https://openbot.test/${TRIGGER_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      }),
    );
  return { events, audits, post };
}
const webhook = parseTriggerConfig({ kind: "webhook" });

describe("generic webhook ingress", () => {
  test("bearer delivery is accepted with 200, bound to the registered owner and target, and audited", async () => {
    const { events, audits, post } = ingress(trigger(webhook));
    const response = await post(
      JSON.stringify({ type: "deploy.finished", ownerUserId: "attacker" }),
      {
        authorization: "Bearer whsec_c2VjcmV0LWZpeHR1cmUtb25seQ==",
        "idempotency-key": "abc-1",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      accepted: true,
      queued: true,
      runIds: ["run-1"],
    });
    expect(events[0]).toMatchObject({
      ownerUserId: "owner-1",
      responsibilityId: "goal-1",
      triggerId: TRIGGER_ID,
      source: "webhook",
      type: "deploy.finished",
      externalId: `${TRIGGER_ID}:abc-1`,
    });
    expect(audits[0]).toMatchObject({
      eventType: "responsibility.triggered",
      payload: { source: "webhook" },
    });
  });
  test("Standard Webhooks HMAC is accepted as an alternative to the bearer", async () => {
    const { events, post } = ingress(trigger(webhook));
    const body = "{}";
    const timestamp = String(NOW / 1000);
    const key = Buffer.from("c2VjcmV0LWZpeHR1cmUtb25seQ==", "base64");
    const signature = createHmac("sha256", key)
      .update(`msg_1.${timestamp}.${body}`)
      .digest("base64");
    const response = await post(body, {
      "webhook-id": "msg_1",
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    });
    expect(response.status).toBe(200);
    expect(events[0]?.externalId).toBe(`${TRIGGER_ID}:msg_1`);
  });
  test("a wrong key, an unknown trigger and a paused responsibility never queue", async () => {
    const wrong = ingress(trigger(webhook));
    expect(
      (await wrong.post("{}", { authorization: "Bearer nope" })).status,
    ).toBe(401);
    const unknown = ingress(null);
    expect(
      (await unknown.post("{}", { authorization: "Bearer x" })).status,
    ).toBe(404);
    const paused = ingress(
      trigger(webhook, { responsibilityStatus: "paused" }),
    );
    const response = await paused.post("{}", {
      authorization: "Bearer whsec_c2VjcmV0LWZpeHR1cmUtb25seQ==",
    });
    expect(response.status).toBe(409);
    expect(
      wrong.events.length + unknown.events.length + paused.events.length,
    ).toBe(0);
  });
  test("a filtered-out delivery is acknowledged but not queued; an oversized body is refused", async () => {
    const filtered = ingress(
      trigger(
        parseTriggerConfig({
          kind: "webhook",
          filter: { eventTypes: ["deploy"] },
        }),
      ),
    );
    const response = await filtered.post(
      JSON.stringify({ type: "build.started" }),
      {
        authorization: "Bearer whsec_c2VjcmV0LWZpeHR1cmUtb25seQ==",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ queued: false });
    expect(filtered.events).toHaveLength(0);
    const big = await filtered.post(
      JSON.stringify({ x: "y".repeat(300 * 1024) }),
      {
        authorization: "Bearer whsec_c2VjcmV0LWZpeHR1cmUtb25seQ==",
      },
    );
    expect(big.status).toBe(413);
  });
});

describe("provider ingress", () => {
  test("Linear: signature over raw body, fresh webhookTimestamp, signed-body dedup, Entity.action type", async () => {
    const secret = "lin_wh_fixture";
    const { events, post } = ingress(
      trigger(parseTriggerConfig({ kind: "linear" }), { secret }),
    );
    const body = JSON.stringify({
      action: "create",
      type: "Issue",
      data: { id: "i1" },
      webhookTimestamp: NOW - 5_000,
    });
    const response = await post(body, {
      "linear-signature": createHmac("sha256", secret)
        .update(body)
        .digest("hex"),
      "linear-delivery": "d-1",
      "linear-event": "Issue",
    });
    expect(response.status).toBe(200);
    expect(events[0]).toMatchObject({
      type: "Issue.create",
      externalId: `${TRIGGER_ID}:body-${createHash("sha256").update(body).digest("hex")}`,
      source: "linear",
    });
    const stale = JSON.stringify({
      action: "create",
      type: "Issue",
      webhookTimestamp: NOW - 120_000,
    });
    expect(
      (
        await post(stale, {
          "linear-signature": createHmac("sha256", secret)
            .update(stale)
            .digest("hex"),
          "linear-delivery": "d-2",
        })
      ).status,
    ).toBe(401);
  });
  test("Sentry: resource.action type, installation hooks acknowledged without a run", async () => {
    const secret = "sentry-client-secret";
    const { events, post } = ingress(
      trigger(
        parseTriggerConfig({
          kind: "sentry",
          filter: { eventTypes: ["issue.created"] },
        }),
        { secret },
      ),
    );
    const body = JSON.stringify({
      action: "created",
      data: { issue: { id: "1" } },
    });
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    const ok = await post(body, {
      "sentry-hook-signature": signature,
      "sentry-hook-resource": "issue",
      "request-id": "r-1",
    });
    expect(ok.status).toBe(200);
    expect(events[0]?.type).toBe("issue.created");
    const install = await post(body, {
      "sentry-hook-signature": signature,
      "sentry-hook-resource": "installation",
      "request-id": "r-2",
    });
    expect(await install.json()).toMatchObject({ queued: false });
    expect(events).toHaveLength(1);
  });
  test("PagerDuty: v1 signature, event.id dedup, event_type filter, ping ignored", async () => {
    const secret = "pd-secret";
    const { events, post } = ingress(
      trigger(
        parseTriggerConfig({
          kind: "pagerduty",
          filter: { eventTypes: ["incident.triggered"] },
        }),
        { secret },
      ),
    );
    const sign = (body: string) =>
      `v1=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const body = JSON.stringify({
      event: {
        id: "01ABC",
        event_type: "incident.triggered",
        data: { id: "P1" },
      },
    });
    expect(
      (await post(body, { "x-pagerduty-signature": sign(body) })).status,
    ).toBe(200);
    expect(events[0]).toMatchObject({
      type: "incident.triggered",
      externalId: `${TRIGGER_ID}:01ABC`,
    });
    const ping = JSON.stringify({
      event: { id: "01PING", event_type: "pagey.ping" },
    });
    expect(
      await (await post(ping, { "x-pagerduty-signature": sign(ping) })).json(),
    ).toMatchObject({ queued: false });
    expect(
      (await post(body, { "x-pagerduty-signature": "v1=00" })).status,
    ).toBe(401);
  });
  test("GitHub: repository lock and event.action type", async () => {
    const secret = "gh-secret";
    const { events, post } = ingress(
      trigger(
        parseTriggerConfig({ kind: "github", repository: "openbot/demo" }),
        { secret },
      ),
    );
    const send = (repository: string) => {
      const body = JSON.stringify({
        action: "opened",
        repository: { full_name: repository },
      });
      return post(body, {
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        "x-github-event": "issues",
        "x-github-delivery": `g-${repository}`,
      });
    };
    expect((await send("openbot/demo")).status).toBe(200);
    expect((await send("someone/else")).status).toBe(403);
    expect(events.map((event) => event.type)).toEqual(["issues.opened"]);
  });
  test("a provider trigger with no pasted secret yet refuses with 503", async () => {
    const { post } = ingress(
      trigger(parseTriggerConfig({ kind: "linear" }), { secret: null }),
    );
    expect((await post("{}", {})).status).toBe(503);
  });
});

describe("Slack triggers", () => {
  const base: SlackTriggerEvent = {
    teamId: "T0001",
    eventId: "Ev1",
    eventTime: NOW / 1000,
    type: "message",
    channelId: "C0001",
    userId: "U1",
    ts: `${NOW / 1000}.000100`,
    text: "Please deploy the release now",
  };
  const slack = (config: Record<string, unknown>) => ({
    ...trigger(
      parseTriggerConfig({ kind: "slack", teamId: "T0001", ...config }),
    ),
    agentId: "bot-1",
  });
  test("each mode fires only on its own event type", () => {
    expect(slackTriggerMatches(slack({ mode: "message" }), base)).toBe(true);
    expect(slackTriggerMatches(slack({ mode: "mention" }), base)).toBe(false);
    expect(
      slackTriggerMatches(slack({ mode: "mention" }), {
        ...base,
        type: "app_mention",
      }),
    ).toBe(true);
    expect(
      slackTriggerMatches(
        slack({ mode: "phrase", phrases: ["DEPLOY the"] }),
        base,
      ),
    ).toBe(true);
    expect(
      slackTriggerMatches(
        slack({ mode: "phrase", phrases: ["rollback"] }),
        base,
      ),
    ).toBe(false);
    const reaction = {
      ...base,
      type: "reaction_added" as const,
      reaction: "eyes",
    };
    expect(
      slackTriggerMatches(
        slack({ mode: "reaction", reactions: ["eyes"] }),
        reaction,
      ),
    ).toBe(true);
    expect(
      slackTriggerMatches(
        slack({ mode: "reaction", reactions: ["fire"] }),
        reaction,
      ),
    ).toBe(false);
    expect(slackTriggerMatches(slack({ mode: "reaction" }), reaction)).toBe(
      true,
    );
  });
  test("channel scope, other workspaces, other Bots, bots and pre-existing messages are ignored", () => {
    expect(
      slackTriggerMatches(
        slack({ mode: "message", channels: ["C0002"] }),
        base,
      ),
    ).toBe(false);
    expect(
      slackTriggerMatches(
        slack({ mode: "message", channels: ["C0001"] }),
        base,
      ),
    ).toBe(true);
    expect(
      slackTriggerMatches(slack({ mode: "message" }), {
        ...base,
        teamId: "T0002",
      }),
    ).toBe(false);
    // Which Bot the author linked, if any, does not decide whose trigger fires: the owner's
    // channel membership does, checked in the ingest. A trigger on another Bot still matches.
    expect(
      slackTriggerMatches(
        { ...slack({ mode: "message" }), agentId: "bot-2" },
        base,
      ),
    ).toBe(true);
    expect(
      slackTriggerMatches(slack({ mode: "message" }), { ...base, isBot: true }),
    ).toBe(false);
    expect(
      slackTriggerMatches(slack({ mode: "message" }), {
        ...base,
        subtype: "message_changed",
      }),
    ).toBe(false);
    const old = `${(NOW - 3_600_000) / 1000}.000100`;
    expect(
      slackTriggerMatches(slack({ mode: "reaction" }), {
        ...base,
        type: "reaction_added",
        reaction: "eyes",
        ts: old,
      }),
    ).toBe(false);
  });
  test("ingestSlackEvent queues matching triggers with event_id dedup", async () => {
    const events: ResponsibilityEvent[] = [];
    const ingest = createSlackTriggerIngest({
      directory: {
        resolve: async () => null,
        slackTriggers: async () => [
          slack({ mode: "message" }),
          slack({ mode: "mention" }),
        ],
      },
      slackAccess: () => ({
        linkedIdentity: async () => "U1",
        isMember: async () => true,
      }),
      ingest: async (event) => {
        events.push(event);
        return { eventId: "e", duplicate: false, runIds: ["r"] };
      },
    });
    const result = await ingest(base);
    expect(result.matched).toBe(1);
    expect(events[0]).toMatchObject({
      source: "slack",
      type: "message",
      externalId: `${TRIGGER_ID}:Ev1`,
    });
    await expect(ingest({ ...base, teamId: "lowercase" })).rejects.toThrow();
  });
});

describe("inbound email via SES -> SNS", () => {
  const dir = mkdtempSync(join(tmpdir(), "sns-"));
  spawnSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    join(dir, "key.pem"),
    "-out",
    join(dir, "cert.pem"),
    "-subj",
    "/CN=sns.us-east-1.amazonaws.com",
  ]);
  const key = readFileSync(join(dir, "key.pem"), "utf8");
  const cert = readFileSync(join(dir, "cert.pem"), "utf8");
  const TOPIC = "arn:aws:sns:us-east-1:123456789012:openbot-inbound";
  const CERT_URL =
    "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-fixture.pem";
  function signed(
    message: Omit<
      SnsMessage,
      "Signature" | "SignatureVersion" | "SigningCertURL"
    >,
    version = "2",
  ) {
    const full = {
      ...message,
      SignatureVersion: version,
      SigningCertURL: CERT_URL,
      Signature: "",
    } as SnsMessage;
    const signer = createSign(version === "1" ? "RSA-SHA1" : "RSA-SHA256");
    signer.update(snsStringToSign(full) ?? "");
    return { ...full, Signature: signer.sign(key, "base64") };
  }
  const mime = [
    "From: Ops <ops@example.com>",
    "Subject: Disk full",
    'Content-Type: multipart/alternative; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "The disk on db-1 is at 99=25.",
    "--b1",
    "Content-Type: text/html",
    "",
    "<p>html</p>",
    "--b1--",
  ].join("\r\n");
  function notification(dkim: string, from = "Ops <ops@example.com>") {
    return JSON.stringify({
      notificationType: "Received",
      mail: {
        messageId: "ses-1",
        source: "ops@example.com",
        commonHeaders: { from: [from], to: ["x"], subject: "Disk full" },
      },
      receipt: {
        recipients: [`trigger-${TRIGGER_ID}@in.openbot.test`],
        spamVerdict: { status: "PASS" },
        virusVerdict: { status: "PASS" },
        dkimVerdict: { status: dkim },
        dmarcVerdict: { status: "GRAY" },
      },
      content: mime,
    });
  }
  function harness(config: Record<string, unknown> = {}) {
    const events: ResponsibilityEvent[] = [];
    const confirmed: string[] = [];
    const fetched: string[] = [];
    const routes = createEmailTriggerRoutes({
      directory: {
        resolve: async (id) =>
          id === TRIGGER_ID
            ? trigger(parseTriggerConfig({ kind: "email", ...config }), {
                secret: null,
              })
            : null,
        slackTriggers: async () => [],
      },
      ingest: async (event) => {
        events.push(event);
        return { eventId: "e", duplicate: false, runIds: ["r"] };
      },
      config: { domain: "in.openbot.test", topicArns: [TOPIC] },
      verify: createSnsVerifier(async (url) => {
        fetched.push(url);
        return cert;
      }),
      confirmSubscription: async (url) => void confirmed.push(url),
    });
    const post = (message: unknown) =>
      routes.fetch(
        new Request("https://openbot.test/sns", {
          method: "POST",
          body: JSON.stringify(message),
        }),
      );
    return { events, confirmed, fetched, post };
  }
  const base = {
    Type: "Notification" as const,
    MessageId: "m-1",
    TopicArn: TOPIC,
    Timestamp: "2026-09-29T00:00:00.000Z",
  };

  test("MIME text extraction prefers text/plain and decodes quoted-printable", () => {
    expect(extractEmailText(mime)).toBe("The disk on db-1 is at 99%.");
  });
  test("signing certificate URLs must be HTTPS on an sns.<region>.amazonaws.com host", () => {
    expect(isSnsUrl(CERT_URL, true)).toBe(true);
    expect(
      isSnsUrl("https://sns.us-east-1.amazonaws.com.evil.test/x.pem", true),
    ).toBe(false);
    expect(isSnsUrl("http://sns.us-east-1.amazonaws.com/x.pem", true)).toBe(
      false,
    );
  });
  test("a signed SES notification (v1 and v2) routes by recipient address to the trigger", async () => {
    for (const version of ["1", "2"]) {
      const { events, post } = harness();
      const response = await post(
        signed({ ...base, Message: notification("PASS") }, version),
      );
      expect(response.status).toBe(200);
      expect(events[0]).toMatchObject({
        source: "email",
        type: "received",
        externalId: `${TRIGGER_ID}:ses-1`,
        payload: {
          from: "ops@example.com",
          subject: "Disk full",
          text: "The disk on db-1 is at 99%.",
        },
      });
    }
  });
  test("tampering, a foreign topic and a foreign cert host are refused", async () => {
    const { events, post } = harness();
    const good = signed({ ...base, Message: notification("PASS") });
    expect(
      (await post({ ...good, Message: notification("PASS", "evil@x.test") }))
        .status,
    ).toBe(401);
    expect(
      (await post({ ...good, TopicArn: "arn:aws:sns:us-east-1:999:other" }))
        .status,
    ).toBe(403);
    expect(
      (await post({ ...good, SigningCertURL: "https://evil.test/cert.pem" }))
        .status,
    ).toBe(401);
    expect(events).toHaveLength(0);
  });
  test("allowedSenders requires the sender to match and pass DKIM or DMARC", async () => {
    const unauthenticated = harness({ allowedSenders: ["example.com"] });
    await unauthenticated.post(
      signed({ ...base, Message: notification("FAIL") }),
    );
    expect(unauthenticated.events).toHaveLength(0);
    const authenticated = harness({ allowedSenders: ["example.com"] });
    await authenticated.post(
      signed({ ...base, Message: notification("PASS") }),
    );
    expect(authenticated.events).toHaveLength(1);
    const otherSender = harness({ allowedSenders: ["ops@other.test"] });
    await otherSender.post(signed({ ...base, Message: notification("PASS") }));
    expect(otherSender.events).toHaveLength(0);
  });
  test("a signed SubscriptionConfirmation from the allowed topic is confirmed", async () => {
    const { confirmed, post } = harness();
    const url =
      "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t";
    const response = await post(
      signed({
        ...base,
        Type: "SubscriptionConfirmation",
        Message: "confirm",
        SubscribeURL: url,
        Token: "t",
      }),
    );
    expect(response.status).toBe(200);
    expect(confirmed).toEqual([url]);
  });
});

describe("a captured signed delivery replayed with a fresh unsigned id", () => {
  // The dedupe identity must come from what the sender signed. Each pair below is the same signed
  // request with only an unsigned id header changed, so both must name the same event.
  test("Standard Webhooks dedupes on the signed webhook-id, not Idempotency-Key", async () => {
    const { events, post } = ingress(trigger(webhook));
    const body = "{}";
    const timestamp = String(NOW / 1000);
    const key = Buffer.from("c2VjcmV0LWZpeHR1cmUtb25seQ==", "base64");
    const signature = createHmac("sha256", key)
      .update(`msg_1.${timestamp}.${body}`)
      .digest("base64");
    const headers = {
      "webhook-id": "msg_1",
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    };
    await post(body, { ...headers, "idempotency-key": "first" });
    await post(body, { ...headers, "idempotency-key": "second" });
    expect(events.map((event) => event.externalId)).toEqual([
      `${TRIGGER_ID}:msg_1`,
      `${TRIGGER_ID}:msg_1`,
    ]);
  });
  test("GitHub, Sentry and Linear dedupe on the signed body, not their delivery headers", async () => {
    const github = ingress(
      trigger(parseTriggerConfig({ kind: "github" }), { secret: "gh" }),
    );
    const ghBody = JSON.stringify({ action: "opened", issue: { id: 1 } });
    for (const delivery of ["g-1", "g-2"])
      await github.post(ghBody, {
        "x-hub-signature-256": `sha256=${createHmac("sha256", "gh").update(ghBody).digest("hex")}`,
        "x-github-event": "issues",
        "x-github-delivery": delivery,
      });
    const sentry = ingress(
      trigger(parseTriggerConfig({ kind: "sentry" }), { secret: "se" }),
    );
    const seBody = JSON.stringify({ action: "created", data: { id: "1" } });
    for (const request of ["r-1", "r-2"])
      await sentry.post(seBody, {
        "sentry-hook-signature": createHmac("sha256", "se")
          .update(seBody)
          .digest("hex"),
        "sentry-hook-resource": "issue",
        "request-id": request,
      });
    const linear = ingress(
      trigger(parseTriggerConfig({ kind: "linear" }), { secret: "li" }),
    );
    const liBody = JSON.stringify({
      action: "create",
      type: "Issue",
      webhookTimestamp: NOW - 5_000,
    });
    for (const delivery of ["d-1", "d-2"])
      await linear.post(liBody, {
        "linear-signature": createHmac("sha256", "li")
          .update(liBody)
          .digest("hex"),
        "linear-delivery": delivery,
      });
    for (const { events } of [github, sentry, linear]) {
      expect(events).toHaveLength(2);
      expect(events[0]?.externalId).toBe(events[1]?.externalId as string);
    }
  });
});
