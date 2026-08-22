import { describe, expect, test } from "bun:test";
import {
  authoriseAgentCall,
  hashCallbackToken,
  looksLikeCallbackToken,
  mintCallbackToken,
  mintRunAssertion,
  readRunAssertion,
  sameToken,
} from "../src/agents/callback-token";

const KEY = "test-encryption-key-not-a-real-one";
const RUN = { botId: "knowledge", actorId: "user_7", runId: "run_1" };

describe("an agent's callback token", () => {
  test("is recognisable, and different every time", () => {
    const first = mintCallbackToken();
    const second = mintCallbackToken();
    expect(looksLikeCallbackToken(first)).toBe(true);
    expect(first).not.toBe(second);
  });

  test("does not accept something that is not one of ours", () => {
    expect(looksLikeCallbackToken("Bearer hunter2")).toBe(false);
    expect(looksLikeCallbackToken("obot_agt_")).toBe(false);
  });

  test("matches only its own hash", () => {
    const token = mintCallbackToken();
    expect(sameToken(hashCallbackToken(token), hashCallbackToken(token))).toBe(
      true,
    );
    expect(
      sameToken(
        hashCallbackToken(token),
        hashCallbackToken(mintCallbackToken()),
      ),
    ).toBe(false);
  });
});

describe("the run assertion", () => {
  test("survives a round trip", () => {
    const signed = mintRunAssertion(RUN, KEY);
    expect(readRunAssertion(signed, KEY)).toEqual(RUN);
  });

  test("is refused when signed with another key", () => {
    const signed = mintRunAssertion(RUN, "another-key");
    expect(readRunAssertion(signed, KEY)).toBeNull();
  });

  test("is refused when the Bot is edited", () => {
    // The whole point: an agent must not be able to promote itself to another Bot's grants.
    const signed = mintRunAssertion(RUN, KEY);
    const [value, signature] = signed.split(".");
    const payload = JSON.parse(
      Buffer.from(value ?? "", "base64url").toString("utf8"),
    );
    payload.botId = "risk-analyst";
    const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;
    expect(readRunAssertion(forged, KEY)).toBeNull();
  });

  test("is refused once it has expired", () => {
    const signed = mintRunAssertion(RUN, KEY, 0);
    // Eleven minutes later: past the ten-minute life of an assertion.
    expect(readRunAssertion(signed, KEY, 11 * 60 * 1000)).toBeNull();
    // Still good a minute in, so the bound is a real window rather than nothing.
    expect(readRunAssertion(signed, KEY, 60 * 1000)).toEqual(RUN);
  });

  test("is refused when it is missing, empty or not a string", () => {
    expect(readRunAssertion(undefined, KEY)).toBeNull();
    expect(readRunAssertion("", KEY)).toBeNull();
    expect(readRunAssertion(42, KEY)).toBeNull();
    expect(readRunAssertion("not-signed-at-all", KEY)).toBeNull();
  });
});

describe("who may call a tool back, and as whom", () => {
  const AGENT_A = "agent_a";
  const AGENT_B = "agent_b";
  const tokenA = mintCallbackToken();
  const tokenB = mintCallbackToken();

  /** The two agents this deployment has issued a token to, and nobody else. */
  const lookup = async (hash: string) => {
    if (hash === hashCallbackToken(tokenA)) return { id: AGENT_A };
    if (hash === hashCallbackToken(tokenB)) return { id: AGENT_B };
    return null;
  };

  const runForA = () =>
    mintRunAssertion(
      { botId: AGENT_A, actorId: "visitor_9", runId: "r1" },
      KEY,
    );

  const call = (presented: string, run: unknown, legacyToken?: string) =>
    authoriseAgentCall({
      presented,
      run,
      encryptionKey: KEY,
      lookup,
      ...(legacyToken ? { legacyToken } : {}),
    });

  test("allows an agent to act as the Bot its token was issued for", async () => {
    expect(await call(tokenA, runForA())).toEqual({
      ok: true,
      botId: AGENT_A,
      actorId: "visitor_9",
    });
  });

  test("refuses another agent presenting a valid assertion it did not earn", async () => {
    /*
     * The whole point of the change. One deployment-wide token used to mean any holder could spend any
     * Bot's grants; the token now says who is calling and this says they may not be somebody else.
     */
    expect(await call(tokenB, runForA())).toEqual({
      ok: false,
      status: 403,
      reason: "That token is not for this Bot.",
    });
  });

  test("refuses a token with no assertion at all", async () => {
    expect(await call(tokenA, undefined)).toEqual({
      ok: false,
      status: 401,
      reason: "Not authorised.",
    });
  });

  test("refuses an unknown token", async () => {
    expect(await call(mintCallbackToken(), runForA())).toEqual({
      ok: false,
      status: 401,
      reason: "Not authorised.",
    });
  });

  test("refuses an empty token", async () => {
    expect(await call("", runForA())).toEqual({
      ok: false,
      status: 401,
      reason: "Not authorised.",
    });
  });

  test("says the same thing whichever half was wrong", async () => {
    // A caller told its token was fine but its assertion stale has learned its token is fine.
    const badToken = await call(mintCallbackToken(), runForA());
    const badAssertion = await call(tokenA, "not-signed");
    expect(badToken).toEqual(badAssertion);
  });

  test("accepts the deployment-wide token, and still takes identity from the assertion", async () => {
    // The Bots in the box are configured with it. It authenticates; it does not assert.
    expect(await call("legacy-secret", runForA(), "legacy-secret")).toEqual({
      ok: true,
      botId: AGENT_A,
      actorId: "visitor_9",
    });
  });

  test("refuses the deployment-wide token when it is not configured", async () => {
    expect(await call("legacy-secret", runForA())).toEqual({
      ok: false,
      status: 401,
      reason: "Not authorised.",
    });
  });

  test("refuses the deployment-wide token with no assertion, which is what the old hole was", async () => {
    /*
     * Before this, the Bot and the actor came out of the request body, so this exact call succeeded
     * and could name any Bot and any person.
     */
    expect(await call("legacy-secret", undefined, "legacy-secret")).toEqual({
      ok: false,
      status: 401,
      reason: "Not authorised.",
    });
  });
});

/**
 * A refused callback leaves a row, because it is a boundary being held.
 *
 * The three MCP call outcomes are all written inside `callTool`, which is reached only once the
 * caller has proved which Bot it is. A caller that fails that check never gets there, so this
 * refusal used to leave nothing behind at all: no row, no log, nothing to count.
 *
 * Which made the product's most confusing failure silent. A Bot holding a token the deployment no
 * longer accepts — a secret rotated, a container not recreated with it — has every call refused
 * here, returns nothing to its own model, and the model tells the person "no files were found". A
 * false negative delivered as an answer, with every place somebody would check agreeing that
 * nothing had happened. That is how it was found: by driving Drive and getting "no results" from a
 * Drive that had them.
 *
 * These assert the shape the row must keep. `authoriseAgentCall` is the decision the route acts on,
 * so a verdict that stops being a refusal is the thing that would silently drop the row again.
 */
describe("a callback that cannot prove which Bot it is", () => {
  test("is refused, with a reason and a status to record", async () => {
    const verdict = await authoriseAgentCall({
      presented: "obot_agt_not_a_token_this_deployment_issued",
      run: await mintRunAssertion(RUN, KEY),
      encryptionKey: KEY,
      legacyToken: "the-deployment-secret",
      lookup: async () => null,
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    // Both are written onto the audit row, so both have to exist.
    expect(typeof verdict.reason).toBe("string");
    expect(verdict.reason.length).toBeGreaterThan(0);
    expect(verdict.status).toBeGreaterThanOrEqual(400);
  });

  test("is refused when the token is right and the run assertion is not", async () => {
    // The other half of the pair. A shared secret alone must not be enough to spend a Bot's grants:
    // without a run this deployment signed, there is no statement of who it is acting for.
    const verdict = await authoriseAgentCall({
      presented: "the-deployment-secret",
      run: "not-an-assertion-this-deployment-signed",
      encryptionKey: KEY,
      legacyToken: "the-deployment-secret",
      lookup: async () => null,
    });

    expect(verdict.ok).toBe(false);
  });

  test("carries no Bot or actor to record, which is why the row names neither", async () => {
    /*
     * The row deliberately records no bot and no actor. Both arrive inside the credential that just
     * failed to verify, so writing them down would put an unproven claim in the one place that is
     * supposed to be believed. This holds that there is nothing trustworthy to write.
     */
    const verdict = await authoriseAgentCall({
      presented: "",
      run: undefined,
      encryptionKey: KEY,
      legacyToken: "the-deployment-secret",
      lookup: async () => null,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict).not.toHaveProperty("botId");
    expect(verdict).not.toHaveProperty("actorId");
  });
});
