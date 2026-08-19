import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sign, verify } from "../auth/signed-value";

/**
 * What an agent presents when it calls a tool back, and on whose behalf.
 *
 * Two separate things, because they answer different questions and one cannot answer both.
 *
 * The **token** says which agent is calling. It is issued per agent, held by whoever runs that agent,
 * and stored here only as a hash: we issue it and we only ever need to check one, so keeping the
 * token itself would make a database dump a working credential for every registered agent.
 *
 * The **run assertion** says which Bot and which person the call is for. A token cannot carry that:
 * it is minted once and reused for months, while the answer changes every run. Before this existed,
 * `/api/agent-tools/call` read the Bot and the actor out of the request body, so anything holding the
 * one deployment-wide token could spend any Bot's grants and write any person's name into the audit
 * trail. The trail is the product; a forgeable trail is worse than no trail.
 *
 * The two are checked against each other. An assertion names the Bot it was issued for, and a call is
 * refused unless that Bot is the one the presented token belongs to, so an agent cannot replay an
 * assertion it happened to see and act as somebody else's Bot.
 */

/** Recognisable on sight, so a leaked one can be found in a log or by a secret scanner. */
const TOKEN_PREFIX = "okai_agt_";

/**
 * Long enough that guessing is not a strategy.
 *
 * 32 bytes, which is the same material the deployment's other secrets use. There is no reason to be
 * thriftier here: nobody types this.
 */
const TOKEN_BYTES = 32;

/** Signed under its own label, so a signature here can never be replayed as a visitor's cookie. */
const RUN_LABEL = "openbot:agent-run";

/**
 * How long an assertion is good for.
 *
 * A run is not instant: a Bot may answer, call a tool, read the result and call another. Ten minutes
 * covers a slow tool loop with room to spare, and bounds what a captured assertion is worth.
 */
const RUN_TTL_MS = 10 * 60 * 1000;

export function mintCallbackToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

export function hashCallbackToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Is this even shaped like one of ours? Cheap, and keeps obvious rubbish out of a database lookup. */
export function looksLikeCallbackToken(value: string): boolean {
  return (
    value.startsWith(TOKEN_PREFIX) && value.length > TOKEN_PREFIX.length + 20
  );
}

/**
 * Compare two hashes without leaking how much of one was right.
 *
 * The hashes are the same length by construction, so a length mismatch is malformed input rather than
 * a near miss.
 */
export function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export type RunAssertion = {
  /** The Bot this run is for. Checked against the agent the token belongs to. */
  botId: string;
  /** Who the deployment resolved this run to. What the audit row will say. */
  actorId: string;
  /** The run itself, so a trail can tie a tool call to the answer it informed. */
  runId: string;
};

type SignedRun = RunAssertion & { exp: number };

/**
 * Mint the assertion for one run.
 *
 * Sent to the agent in `forwardedProps` rather than a header, because that is the part of an AG-UI
 * run a framework hands back to the code the customer writes. A header would arrive at their HTTP
 * layer and be gone by the time their tool call needs it.
 */
export function mintRunAssertion(
  run: RunAssertion,
  encryptionKey: string,
  now: number = Date.now(),
): string {
  const payload: SignedRun = { ...run, exp: now + RUN_TTL_MS };
  const value = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return sign(value, encryptionKey, RUN_LABEL);
}

/**
 * The assertion a call carries, or nothing.
 *
 * Nothing on any doubt: a bad signature, an expired one, a payload that is not the right shape. The
 * caller refuses when this returns null, so every unclear case fails closed.
 */
export function readRunAssertion(
  signed: unknown,
  encryptionKey: string,
  now: number = Date.now(),
): RunAssertion | null {
  if (typeof signed !== "string" || !signed) return null;

  const value = verify(signed, encryptionKey, RUN_LABEL);
  if (!value) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<SignedRun>;
    if (
      typeof payload.botId !== "string" ||
      typeof payload.actorId !== "string" ||
      typeof payload.runId !== "string" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    if (payload.exp <= now) return null;
    return {
      botId: payload.botId,
      actorId: payload.actorId,
      runId: payload.runId,
    };
  } catch {
    return null;
  }
}

export type CallVerdict =
  | { ok: true; botId: string; actorId: string }
  | { ok: false; status: 401 | 403; reason: string };

/**
 * May this call proceed, and as whom?
 *
 * Pure, and separate from the route, because this is the whole of the security decision and it should
 * be readable and testable without standing up an app. The route's job is to turn the verdict into a
 * response.
 *
 * Two credentials, checked against each other:
 * the token says which agent is calling, the assertion says which Bot and person the run is for, and
 * an agent may only act as the Bot its token was issued for. Everything unclear is a refusal.
 */
export async function authoriseAgentCall(options: {
  /** The `x-openbot-agent-token` header, as presented. */
  presented: string;
  /** The `run` field from the body, as presented. */
  run: unknown;
  /** The deployment key the assertion was signed with. */
  encryptionKey: string;
  /**
   * The deployment-wide token, still accepted for the Bots that ship in the box.
   *
   * It authenticates only. The Bot and the actor still come from the assertion, so it cannot be used
   * to spend another Bot's grants or to write somebody else's name into the trail. Empty disables it.
   */
  legacyToken?: string;
  /** Which agent holds a token hash, if any. */
  lookup: (hash: string) => Promise<{ id: string } | null>;
  now?: number;
}): Promise<CallVerdict> {
  const { presented, run, encryptionKey, legacyToken, lookup, now } = options;

  if (!presented) return { ok: false, status: 401, reason: "Not authorised." };

  const assertion = readRunAssertion(run, encryptionKey, now);
  /*
   * Refused without saying which half was wrong.
   *
   * A caller learning that its token was accepted but its assertion was stale has learned that its
   * token is good, which is the useful half of a guess.
   */
  if (!assertion) return { ok: false, status: 401, reason: "Not authorised." };

  const caller = looksLikeCallbackToken(presented)
    ? await lookup(hashCallbackToken(presented))
    : legacyToken && sameToken(presented, legacyToken)
      ? { id: assertion.botId }
      : null;

  if (!caller) return { ok: false, status: 401, reason: "Not authorised." };

  /*
   * An agent may only act as the Bot it was issued for.
   *
   * Without this, an assertion seen once could be replayed by any other credentialled agent to borrow
   * that Bot's grants. The token says who is calling; this says they may not be somebody else.
   */
  if (caller.id !== assertion.botId) {
    return {
      ok: false,
      status: 403,
      reason: "That token is not for this Bot.",
    };
  }

  return { ok: true, botId: assertion.botId, actorId: assertion.actorId };
}
