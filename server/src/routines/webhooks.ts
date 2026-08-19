/**
 * Whether a delivery that arrived on the public port may set a Bot working.
 *
 * Everything here is a pure decision about one request. The receiver does the listening and the
 * store does the writing; this decides, so that "an unverified trigger does not run anything" is a
 * sentence with a test next to it rather than a branch buried in a request handler.
 *
 * Three separate gates, in this order, because they fail for three different reasons and a caller
 * deserves to be told which:
 *
 *  1. The secret. Wrong, missing or malformed, and nothing else is even looked at.
 *  2. Verification. A brand new trigger keeps the first authenticated delivery as a sample and runs
 *     nothing at all. Somebody looks at what actually arrived and confirms it. This is the gate that
 *     catches a hook pointed at the wrong trigger, which is otherwise discovered by its results.
 *  3. The event type, when the trigger names any. An allowlist, because "only act on
 *     deployment.succeeded" is a decision about what may reach the Bot, not a request to the model.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The prefix every webhook secret carries.
 *
 * Present so a secret is recognisable on sight in a log somebody is about to paste into a ticket,
 * and so the secret scanners that watch public repositories have something to match. It is not a
 * security property; the entropy after it is.
 */
export const WEBHOOK_SECRET_PREFIX = "obw_";

/** 32 bytes of randomness. Long enough that guessing is not a strategy and short enough to paste. */
const SECRET_BYTES = 32;

/** 18 bytes, base64url. The public path segment: unguessable, and short enough to read aloud. */
const ENDPOINT_BYTES = 18;

export type MintedSecret = {
  /**
   * The only time this value exists outside the caller's own configuration.
   *
   * Returned once, at creation and at rotation, and never stored. A secret the product can show
   * again is a secret held by a screen, a backup and a database dump, and the entire value of a
   * bearer token is that only the caller has it.
   */
  secret: string;
  /** What goes in the table. */
  hash: string;
};

export function mintWebhookSecret(): MintedSecret {
  const secret = `${WEBHOOK_SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return { secret, hash: hashWebhookSecret(secret) };
}

export function mintEndpointId(): string {
  return randomBytes(ENDPOINT_BYTES).toString("base64url");
}

export function hashWebhookSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Compare a presented secret against a stored hash without leaking how close it was.
 *
 * Both sides are hashed first, which does two things. It makes the comparison fixed-width, so
 * `timingSafeEqual` can be used at all, it throws on buffers of different lengths and a caller can
 * present a secret of any length they like. And it means the timing of the comparison carries no
 * information about the secret, only about its digest, which tells an attacker nothing they can walk
 * towards.
 *
 * The naive version of this, `presented === stored`, returns early at the first differing byte. That
 * is a real attack against a value an attacker can retry against as fast as the network allows,
 * which is precisely the situation a public endpoint is in.
 */
export function webhookSecretMatches(
  presented: string,
  storedHash: string,
): boolean {
  const candidate = Buffer.from(hashWebhookSecret(presented), "hex");
  let expected: Buffer;
  try {
    expected = Buffer.from(storedHash, "hex");
  } catch {
    return false;
  }
  // A stored value that is not a SHA-256 digest cannot match anything. Checked rather than assumed,
  // because reaching timingSafeEqual with mismatched lengths throws, and an exception on the public
  // port would be answered with a 500 that says more about the deployment than a 401 does.
  if (expected.byteLength !== candidate.byteLength) return false;
  return timingSafeEqual(candidate, expected);
}

/**
 * Pull the secret out of an Authorization header.
 *
 * Bearer only, and the scheme is matched case-insensitively because that is what the specification
 * says and what the systems calling this actually send. Anything else returns null and is refused
 * as an unauthenticated delivery rather than being interpreted generously.
 */
export function bearerSecret(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

/** What a trigger looks like to this decision. Deliberately not the whole row. */
export type WebhookTriggerFacts = {
  enabled: boolean;
  verificationPending: boolean;
  secretHash: string;
  /** Empty means every event type is acceptable. */
  eventTypes: string[];
};

export type WebhookDecision =
  /** Run the work. */
  | { outcome: "run" }
  /** Authenticated, and deliberately not run: this is the first delivery and it becomes the sample. */
  | { outcome: "capture"; reason: string }
  /** Refused. `status` is what the caller is told, `reason` is what the trail records. */
  | { outcome: "reject"; status: 401 | 403 | 404; reason: string };

/**
 * Decide what to do with one delivery.
 *
 * A disabled trigger answers 404, not 403. The distinction matters on a public endpoint: 403 confirms
 * that this endpoint id exists and is merely switched off, which is more than an unauthenticated
 * caller has earned. A wrong secret answers 401 for the same reason it always does, and says nothing
 * about whether the endpoint is real.
 */
export function decideWebhookDelivery(
  trigger: WebhookTriggerFacts | null,
  delivery: { authorization: string | null; eventType: string | null },
): WebhookDecision {
  if (!trigger?.enabled) {
    return {
      outcome: "reject",
      status: 404,
      reason: "No trigger is listening on that endpoint.",
    };
  }

  const presented = bearerSecret(delivery.authorization);
  if (!presented || !webhookSecretMatches(presented, trigger.secretHash)) {
    return {
      outcome: "reject",
      status: 401,
      reason: "The delivery did not present this trigger's secret.",
    };
  }

  if (trigger.verificationPending) {
    return {
      outcome: "capture",
      reason:
        "The first delivery to a new trigger is kept as a sample and runs nothing. " +
        "Confirm it in Admin once you have looked at what arrived.",
    };
  }

  if (
    trigger.eventTypes.length > 0 &&
    (!delivery.eventType || !trigger.eventTypes.includes(delivery.eventType))
  ) {
    return {
      outcome: "reject",
      status: 403,
      reason: delivery.eventType
        ? `This trigger does not act on ${delivery.eventType}.`
        : "This trigger only acts on named event types, and the delivery named none.",
    };
  }

  return { outcome: "run" };
}

/**
 * Where the event type is read from.
 *
 * The header first, because the systems that have one send it there and it is the part a person can
 * see without opening the body. Then two field names in the body, which are what the rest send. A
 * delivery that names its event type in some fourth way is treated as naming none, which an
 * allowlist then refuses: guessing at a field would mean a trigger silently acting on events it was
 * told not to.
 */
export function eventTypeOf(
  headers: { get(name: string): string | null },
  body: unknown,
): string | null {
  const header =
    headers.get("x-openbot-event") ?? headers.get("x-event-type") ?? null;
  if (header?.trim()) return header.trim();
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    for (const field of ["event", "eventType", "type"]) {
      const value = record[field];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

/**
 * What the Bot is told a webhook said.
 *
 * The body is handed over as JSON inside a sentence rather than as a bare payload, because the Bot
 * is being asked to do a job and the delivery is evidence for it, not the instruction. Truncated,
 * because a delivery is somebody else's payload and can be any size at all, and a prompt that grows
 * without limit is a run that fails for a reason nobody can see from the routine.
 */
export const MAX_DELIVERY_CHARACTERS = 8_000;

export function deliveryPrompt(
  instruction: string,
  body: unknown,
  eventType: string | null,
): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(body ?? null, null, 2) ?? "null";
  } catch {
    rendered = "(the delivery could not be rendered as JSON)";
  }
  const truncated =
    rendered.length > MAX_DELIVERY_CHARACTERS
      ? `${rendered.slice(0, MAX_DELIVERY_CHARACTERS)}\n… (truncated)`
      : rendered;

  return [
    instruction,
    eventType
      ? `This was triggered by an incoming ${eventType} delivery:`
      : "This was triggered by an incoming delivery:",
    truncated,
  ].join("\n\n");
}
