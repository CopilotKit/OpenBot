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
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { PluginRefusedError, type PluginStore } from "../src/plugins/store";
import { testEnvironment } from "./support/environment";

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
    // A run that began with a person is depth zero, which is what an unstated depth means.
    expect(readRunAssertion(signed, KEY)).toEqual({
      ...RUN,
      depth: 0,
      initiator: { kind: "person" },
    });
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
    expect(readRunAssertion(signed, KEY, 60 * 1000)).toEqual({
      ...RUN,
      depth: 0,
      initiator: { kind: "person" },
    });
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
      initiator: { kind: "person" },
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
      initiator: { kind: "person" },
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

/**
 * How deep a chain of Bots already is travels here because it has to cross a process.
 *
 * A Bot handing work to another is A to B to C, three runs on up to three pods. A counter in a
 * variable stops applying the moment the second hop lands somewhere else, which is also the moment a
 * loop starts costing real money: the cap would go quiet exactly when it was needed. Signed with the
 * rest, so it is the deployment's number rather than one a Bot can edit.
 */
describe("how deep a run is", () => {
  test("survives a round trip", () => {
    const signed = mintRunAssertion({ ...RUN, depth: 2 }, KEY);
    expect(readRunAssertion(signed, KEY)?.depth).toBe(2);
  });

  test("a run that began with a person is zero", () => {
    expect(readRunAssertion(mintRunAssertion(RUN, KEY), KEY)?.depth).toBe(0);
  });

  /*
   * Read as zero rather than refused. The signature has already been checked, so this is a field
   * that predates the feature being absent rather than a caller lying, and the cap refuses on the
   * way out anyway.
   */
  test("a depth that is not a depth reads as zero", () => {
    for (const nonsense of [-1, 1.5, "2", null]) {
      const signed = mintRunAssertion(
        { ...RUN, depth: nonsense as never },
        KEY,
      );
      expect(readRunAssertion(signed, KEY)?.depth).toBe(0);
    }
  });

  test("what started the run survives a round trip", () => {
    for (const initiator of [
      { kind: "person" } as const,
      { kind: "deployment" } as const,
      { kind: "routine", id: "routine_7" } as const,
      { kind: "handoff", id: "research-assistant" } as const,
    ]) {
      const signed = mintRunAssertion({ ...RUN, initiator }, KEY);
      expect(readRunAssertion(signed, KEY)?.initiator).toEqual(initiator);
    }
  });

  test("a run that says nothing about what started it reads as a person", () => {
    expect(
      readRunAssertion(mintRunAssertion(RUN, KEY), KEY)?.initiator,
    ).toEqual({ kind: "person" });
  });

  /*
   * The point of putting this inside the signature. A Bot cannot relabel its own run, and a kind
   * this deployment does not write cannot arrive as a string the Audit screen has no branch for.
   */
  test("an initiator that is not one reads as a person rather than being kept", () => {
    for (const nonsense of [
      { kind: "administrator" },
      { kind: "routine" },
      { kind: "handoff", id: "" },
      { kind: "routine", id: 7 },
      "routine",
      null,
    ]) {
      const signed = mintRunAssertion(
        { ...RUN, initiator: nonsense as never },
        KEY,
      );
      expect(readRunAssertion(signed, KEY)?.initiator).toEqual({
        kind: "person",
      });
    }
  });

  test("the conversation survives a round trip, and is absent when there is none", () => {
    expect(
      readRunAssertion(mintRunAssertion({ ...RUN, threadId: "t1" }, KEY), KEY)
        ?.threadId,
    ).toBe("t1");
    expect(readRunAssertion(mintRunAssertion(RUN, KEY), KEY)?.threadId).toBe(
      undefined,
    );
  });
});

/**
 * WHAT THE ROUTE THIS TOKEN GUARDS HANDS BACK WHEN THE CALL FAILS, which nothing exercised at all.
 *
 * `/api/agent-tools/call` is where a Bot running its own loop in its own process calls a tool. What
 * it answers with goes straight into that model's context as the tool result, so this surface is
 * the widest audience any error message in this deployment reaches: a model repeats what it is
 * given, to the person asking and into whatever it writes next.
 *
 * THE IN-PROCESS SIBLING ALREADY DECIDES THIS and decides it the other way. `plugins/tools.ts`
 * wraps the identical `callTool` for a Bot running here, and its catch refuses to relay anything on
 * the `isDeploymentFault` shelf — "a contradiction in this deployment's own tables says nothing to
 * a model". The route below relayed `error.message` with no such question asked, so one of the two
 * doors to one store answered a query failure with `Failed query: … params: …` and the other
 * answered "That tool could not be called." Which door a Bot came through is a deployment topology
 * decision, not a disclosure decision.
 */
describe("the tool-call route a callback token guards", () => {
  /** The deployment-wide token, which authenticates without naming a Bot of its own. */
  const DEPLOYMENT_TOKEN = "deployment-wide-agent-token";

  const config = loadConfig(
    testEnvironment({ AGENT_TOOL_TOKEN: DEPLOYMENT_TOKEN }),
  );

  /**
   * The app with one thing in it: a store whose `callTool` throws what the test is about.
   *
   * `pluginStore` is the fifteenth positional argument, so the gap is spelled rather than guessed —
   * a miscount here would silently hand the store to `componentStore` and leave the route absent.
   */
  function appWhoseToolThrows(thrown: unknown) {
    return createApp(
      config,
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
      undefined,
      undefined,
      undefined,
      {
        callTool: async () => {
          throw thrown;
        },
      } as unknown as PluginStore,
    );
  }

  /** What the model is handed, as the route builds it. */
  async function toolResult(thrown: unknown): Promise<string> {
    const response = await appWhoseToolThrows(thrown).request(
      "http://openbot.local/api/agent-tools/call",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": DEPLOYMENT_TOKEN,
        },
        body: JSON.stringify({
          name: "mcp__linear__LINEAR_CREATE_ISSUE",
          args: {},
          run: mintRunAssertion(
            { botId: "knowledge", actorId: "usr_7", runId: "run_1" },
            config.keyEncryptionKey,
          ),
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { text: string; isError: boolean };
    expect(body.isError).toBe(true);
    return body.text;
  }

  /**
   * The drizzle shape, spelled the way `plugin-store.integration.test.ts` spells it: the statement
   * and every value bound to it in `message`, the driver's own error on `cause`, and `query` and
   * `params` as own properties — which is what {@link isQueryFailure} recognises it by.
   */
  function queryFailure() {
    return Object.assign(
      new Error(
        'Failed query: select "credential_id" from "mcp_user_credentials" where "server_id" = $1 and "user_id" = $2 params: linear, usr_7',
      ),
      {
        query:
          'select "credential_id" from "mcp_user_credentials" where "server_id" = $1 and "user_id" = $2',
        params: ["linear", "usr_7"],
        cause: new Error("canceling statement due to statement timeout"),
      },
    );
  }

  test("a query of this deployment's own never reaches the model that asked", async () => {
    const text = await toolResult(queryFailure());

    /*
     * Not the statement, and not the values bound to it. On this path those are server ids, user
     * ids and credential ids, and a model handed them can repeat them to the person asking, quote
     * them into a document it writes, or send them to the next tool it calls — which is why this
     * is the worst of the three places this shape has been found leaking.
     */
    expect(text).not.toContain("Failed query");
    expect(text).not.toContain("params:");
    expect(text).not.toContain("mcp_user_credentials");
    expect(text).not.toContain("usr_7");
    // The same thing the in-process door says about the same shelf, which is the property.
    expect(text).toContain("That tool could not be called.");
  });

  /**
   * AND THE REFUSAL STILL SPEAKS, because a guard that silences everything is not the fix.
   *
   * A `PluginRefusedError` is this deployment telling a Bot it may not do something, and its
   * sentence is written for whoever reads the answer. Losing it would turn every policy boundary
   * into an unexplained failure, which is what the marker on this route exists to prevent.
   */
  test("a refusal this deployment wrote is still relayed in full", async () => {
    expect(
      await toolResult(
        new PluginRefusedError(
          "No Bot holds linear/LINEAR_CREATE_ISSUE, so nothing was called.",
          null,
        ),
      ),
    ).toContain("No Bot holds linear/LINEAR_CREATE_ISSUE");
  });

  /** And a vendor's own words, which are the useful half of a 403 and are nobody's secret. */
  test("a vendor's own sentence is still relayed", async () => {
    expect(
      await toolResult(new Error("The caller does not have permission.")),
    ).toContain("The caller does not have permission.");
  });

  /**
   * A VENDOR THAT ANSWERED WITH AN ERROR, rather than one that threw, which is how an MCP server says
   * no: `{ isError: true }` and a sentence, resolved and not thrown.
   *
   * The in-process door names that sentence as the vendor's (`plugins/tools.ts`), because handing it
   * over as content already cost a diagnosis: Google's "The caller does not have permission" read as
   * a result, and the model told the person it had no access to their Drive. Neither framework Bot
   * words it on its way through — the LangGraph Bot passes an `isError` answer on untouched, and
   * the Python one reads only `text` — so what this route writes is what the model reads.
   */
  function storeAnswering(result: { text: string; isError: boolean }) {
    return {
      callTool: async () => ({ ...result, truncated: false }),
      listForAgent: async () => ({
        tools: [
          {
            toolName: "mcp__linear__LINEAR_CREATE_ISSUE",
            ref: "linear/LINEAR_CREATE_ISSUE",
            description: "Create an issue.",
            inputSchema: { type: "object" },
          },
        ],
      }),
    } as unknown as PluginStore;
  }

  /** Both doors' answers to one call against the same store: the callback route's, and the in-process one's. */
  async function bothDoors(store: PluginStore) {
    const response = await createApp(
      config,
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
      undefined,
      undefined,
      undefined,
      store,
    ).request("http://openbot.local/api/agent-tools/call", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": DEPLOYMENT_TOKEN,
      },
      body: JSON.stringify({
        name: "mcp__linear__LINEAR_CREATE_ISSUE",
        args: {},
        run: mintRunAssertion(
          { botId: "knowledge", actorId: "usr_7", runId: "run_1" },
          config.keyEncryptionKey,
        ),
      }),
    });
    expect(response.status).toBe(200);
    const callback = (await response.json()) as {
      text: string;
      isError: boolean;
    };

    const { grantedTools } = await import("../src/plugins/tools");
    const [tool] = await grantedTools({
      store,
      botId: "knowledge",
      actorId: "usr_7",
    });
    const inProcess = await tool?.execute({});
    return { callback, inProcess };
  }

  test("a vendor's error answer is named as the vendor's, the way the in-process door names it", async () => {
    const { callback, inProcess } = await bothDoors(
      storeAnswering({
        text: "The caller does not have permission.",
        isError: true,
      }),
    );

    expect(callback.isError).toBe(true);
    // One store, one answer: which door a Bot comes through is topology, not what its model is told.
    expect(callback.text).toBe(inProcess);
    expect(callback.text).toBe(
      "The vendor reported an error: The caller does not have permission.",
    );
  });

  test("a vendor's result that is not an error reaches the model as the vendor wrote it", async () => {
    const { callback, inProcess } = await bothDoors(
      storeAnswering({ text: "Created LIN-42.", isError: false }),
    );

    expect(callback).toEqual({ text: "Created LIN-42.", isError: false });
    expect(callback.text).toBe(inProcess);
  });
});
