import { describe, expect, test } from "bun:test";
import {
  bearerSecret,
  decideWebhookDelivery,
  deliveryPrompt,
  eventTypeOf,
  hashWebhookSecret,
  MAX_DELIVERY_CHARACTERS,
  mintEndpointId,
  mintWebhookSecret,
  webhookSecretMatches,
  WEBHOOK_SECRET_PREFIX,
  type WebhookTriggerFacts,
} from "../src/routines/webhooks";

/**
 * The door that opens to somebody who has not signed in, and the three gates behind it.
 *
 * These are the tests where a pass is not the interesting result. Every case below is one where the
 * wrong behaviour is plausible: a delivery with no secret at all, a brand new trigger that would
 * happily start real work on its first call, an event type the trigger was told not to act on. Each
 * of them is a way for somebody else's system to make a Bot do something on somebody's live
 * accounts, so each of them has a test rather than a comment.
 */

const secret = mintWebhookSecret();

const verified: WebhookTriggerFacts = {
  enabled: true,
  verificationPending: false,
  secretHash: secret.hash,
  eventTypes: [],
};

describe("the secret", () => {
  test("is recognisable and is not what gets stored", () => {
    expect(secret.secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    // The row keeps a digest. A table that could return the secret is a table that has put it on an
    // administrator's screen, in a backup and in every database dump since.
    expect(secret.hash).not.toContain(secret.secret);
    expect(secret.hash).toBe(hashWebhookSecret(secret.secret));
  });

  test("is different every time", () => {
    expect(mintWebhookSecret().secret).not.toBe(mintWebhookSecret().secret);
    expect(mintEndpointId()).not.toBe(mintEndpointId());
  });

  test("matches itself and nothing else", () => {
    expect(webhookSecretMatches(secret.secret, secret.hash)).toBe(true);
    expect(webhookSecretMatches(`${secret.secret}x`, secret.hash)).toBe(false);
    expect(webhookSecretMatches("", secret.hash)).toBe(false);
  });

  /*
   * The comparison is over digests, not over the secrets. That is what makes a constant-time compare
   * possible at all: `timingSafeEqual` throws on buffers of different lengths, and a caller can
   * present a value of any length they like. Hashing first fixes the width, so a one-character guess
   * and a ten-thousand-character one take the same path and neither of them throws.
   *
   * The naive alternative, `presented === stored`, returns at the first differing byte, which is a
   * real attack against a value somebody can retry as fast as the network allows.
   */
  test.each([
    ["a single character", "x"],
    ["something enormous", "x".repeat(10_000)],
    ["something that looks like hex", "a".repeat(64)],
    ["a near miss", `${WEBHOOK_SECRET_PREFIX}${"A".repeat(43)}`],
  ])("rejects %s without throwing", (_label, candidate) => {
    expect(webhookSecretMatches(candidate, secret.hash)).toBe(false);
  });

  test("a stored value that is not a digest matches nothing", () => {
    expect(webhookSecretMatches(secret.secret, "not-a-digest")).toBe(false);
    expect(webhookSecretMatches(secret.secret, "")).toBe(false);
  });

  test("reads a bearer header, and only a bearer header", () => {
    expect(bearerSecret("Bearer abc")).toBe("abc");
    expect(bearerSecret("bearer abc")).toBe("abc");
    expect(bearerSecret("Basic abc")).toBeNull();
    expect(bearerSecret("abc")).toBeNull();
    expect(bearerSecret(null)).toBeNull();
  });
});

describe("deciding what to do with a delivery", () => {
  test("runs an authenticated delivery to a verified trigger", () => {
    expect(
      decideWebhookDelivery(verified, {
        authorization: `Bearer ${secret.secret}`,
        eventType: null,
      }),
    ).toEqual({ outcome: "run" });
  });

  test("a wrong secret is refused, and nothing else is looked at", () => {
    const decision = decideWebhookDelivery(verified, {
      authorization: "Bearer wrong",
      eventType: null,
    });
    expect(decision).toMatchObject({ outcome: "reject", status: 401 });
  });

  test("no secret at all is refused", () => {
    expect(
      decideWebhookDelivery(verified, {
        authorization: null,
        eventType: null,
      }),
    ).toMatchObject({ outcome: "reject", status: 401 });
  });

  /*
   * 404 rather than 403, deliberately. On a public endpoint a 403 confirms that this endpoint id
   * exists and is merely switched off, which is more than an unauthenticated caller has earned.
   */
  test("a trigger that is switched off answers as though it were not there", () => {
    expect(
      decideWebhookDelivery(
        { ...verified, enabled: false },
        { authorization: `Bearer ${secret.secret}`, eventType: null },
      ),
    ).toMatchObject({ outcome: "reject", status: 404 });
  });

  test("an endpoint nobody is listening on answers the same way", () => {
    expect(
      decideWebhookDelivery(null, {
        authorization: `Bearer ${secret.secret}`,
        eventType: null,
      }),
    ).toMatchObject({ outcome: "reject", status: 404 });
  });

  /*
   * The gate this feature exists for. A hook pointed at the wrong trigger, or carrying a payload
   * nothing like what was expected, must not start real work; the first anybody would hear of it is
   * the result. The first authenticated delivery is kept and nothing runs.
   */
  test("a new trigger captures its first delivery and runs nothing", () => {
    const decision = decideWebhookDelivery(
      { ...verified, verificationPending: true },
      { authorization: `Bearer ${secret.secret}`, eventType: "build.finished" },
    );
    expect(decision.outcome).toBe("capture");
  });

  test("the secret is still checked before anything is captured", () => {
    // Otherwise the sample is whatever the last stranger sent, and confirming it confirms theirs.
    expect(
      decideWebhookDelivery(
        { ...verified, verificationPending: true },
        { authorization: "Bearer wrong", eventType: null },
      ),
    ).toMatchObject({ outcome: "reject", status: 401 });
  });

  test("an event type on the list is run", () => {
    expect(
      decideWebhookDelivery(
        { ...verified, eventTypes: ["deployment.succeeded"] },
        {
          authorization: `Bearer ${secret.secret}`,
          eventType: "deployment.succeeded",
        },
      ),
    ).toEqual({ outcome: "run" });
  });

  test("an event type that is not on the list is refused", () => {
    const decision = decideWebhookDelivery(
      { ...verified, eventTypes: ["deployment.succeeded"] },
      {
        authorization: `Bearer ${secret.secret}`,
        eventType: "deployment.failed",
      },
    );
    expect(decision).toMatchObject({ outcome: "reject", status: 403 });
    expect((decision as { reason: string }).reason).toContain(
      "deployment.failed",
    );
  });

  /*
   * A delivery that names nothing must not slip past a list. An allowlist that only refuses the
   * types it has heard of is not an allowlist.
   */
  test("a delivery naming no event type is refused when a list exists", () => {
    expect(
      decideWebhookDelivery(
        { ...verified, eventTypes: ["deployment.succeeded"] },
        { authorization: `Bearer ${secret.secret}`, eventType: null },
      ),
    ).toMatchObject({ outcome: "reject", status: 403 });
  });

  test("an empty list means every type", () => {
    expect(
      decideWebhookDelivery(verified, {
        authorization: `Bearer ${secret.secret}`,
        eventType: "anything.at.all",
      }),
    ).toEqual({ outcome: "run" });
  });
});

describe("finding the event type", () => {
  const headers = (values: Record<string, string>) => ({
    get: (name: string) => values[name.toLowerCase()] ?? null,
  });

  test("prefers the header, which is the part a person can see", () => {
    expect(
      eventTypeOf(headers({ "x-openbot-event": "build.finished" }), {
        event: "something.else",
      }),
    ).toBe("build.finished");
  });

  test.each([["event"], ["eventType"], ["type"]])(
    "falls back to a %s field in the body",
    (field) => {
      expect(eventTypeOf(headers({}), { [field]: "build.finished" })).toBe(
        "build.finished",
      );
    },
  );

  /*
   * A delivery that names its type in some fourth way is treated as naming none, which an allowlist
   * then refuses. Guessing at a field would mean a trigger quietly acting on events it was told not
   * to, which is the failure the allowlist exists to prevent.
   */
  test("names nothing when it is somewhere else entirely", () => {
    expect(eventTypeOf(headers({}), { kind: "build.finished" })).toBeNull();
    expect(eventTypeOf(headers({}), null)).toBeNull();
    expect(eventTypeOf(headers({}), [1, 2, 3])).toBeNull();
  });
});

describe("what the Bot is told a delivery said", () => {
  test("puts the instruction first and the payload underneath it", () => {
    const prompt = deliveryPrompt(
      "Summarise the failing build.",
      { branch: "main" },
      "build.failed",
    );
    expect(prompt.startsWith("Summarise the failing build.")).toBe(true);
    expect(prompt).toContain("build.failed");
    expect(prompt).toContain('"branch": "main"');
  });

  /*
   * The body is somebody else's payload and can be any size at all. A prompt that grows without
   * limit is a run that fails somewhere the routine cannot explain.
   */
  test("truncates an enormous payload and says that it did", () => {
    const prompt = deliveryPrompt(
      "Look at this.",
      { blob: "x".repeat(50_000) },
      null,
    );
    expect(prompt.length).toBeLessThan(MAX_DELIVERY_CHARACTERS + 500);
    expect(prompt).toContain("truncated");
  });

  test("a payload that cannot be rendered still produces a usable prompt", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const prompt = deliveryPrompt("Look at this.", circular, null);
    expect(prompt.startsWith("Look at this.")).toBe(true);
    expect(prompt).toContain("could not be rendered");
  });
});
