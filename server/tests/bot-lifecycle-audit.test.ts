import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { retireReplacedKey } from "../src/agents/auth-header";
import { createAgentRoutes } from "../src/agents/routes";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";

/**
 * The actions that change what a Bot is, and what it can reach.
 *
 * The trail recorded every mouse movement a Bot made and nothing about the Bot itself. Ten mutating
 * routes wrote one audit row between them, and there was no event type for any of the other nine, so
 * this was a missing vocabulary before it was a missing call.
 *
 * A Bot's endpoint is where conversation content is sent and its callback token is a capability
 * handed to somebody else's infrastructure. "Who pointed this Bot at that host, and when" is the
 * first question asked in an incident and the trail could not answer it.
 */

const ACTOR = { id: "u1", email: "admin@openbot.test", role: "admin" } as const;

function app(overrides: Record<string, unknown> = {}) {
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };

  const store = {
    create: async () => ({ id: "bot-1", name: "Sales" }),
    update: async () => ({ id: "bot-1", name: "Sales" }),
    duplicate: async () => ({ id: "bot-2", name: "Sales copy" }),
    setHidden: async () => undefined,
    softDelete: async () => undefined,
    issueCallbackToken: async () => "the-token-nobody-records",
    revokeCallbackToken: async () => undefined,
    ...overrides,
  } as never;

  const requireUser: MiddlewareHandler = async (context, next) => {
    context.set("actor", ACTOR);
    await next();
  };

  const routes = createAgentRoutes(store, requireUser, true, auditStore);
  return { rows, hono: new Hono().route("/api/agents", routes) };
}

type MiddlewareHandler = Parameters<typeof createAgentRoutes>[1];

/** Everything the input parser insists on, so a test about auditing is not a test about validation. */
const VALID = {
  name: "Sales",
  title: "Sales assistant",
  roleDescription: "Helps with sales questions.",
  visibility: "public",
};

const json = (body: Record<string, unknown>) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...VALID, ...body }),
});

describe("what a Bot is, on the trail", () => {
  test("creating one records the endpoint it was pointed at", async () => {
    const { rows, hono } = app();

    await hono.request(
      "http://t/api/agents",
      json({ endpoint: "https://partner.example/ag-ui" }),
    );

    expect(rows[0]?.eventType).toBe("bot.created");
    expect(rows[0]?.targetId).toBe("bot-1");
    expect(rows[0]?.payload.endpoint).toBe("https://partner.example/ag-ui");
    expect(rows[0]?.actorUserId).toBe("u1");
  });

  test("repointing one records where to", async () => {
    // The dangerous edit. It decides which host conversation content is sent to.
    const { rows, hono } = app();

    await hono.request("http://t/api/agents/bot-1", {
      ...json({ endpoint: "https://elsewhere.example/ag-ui" }),
      method: "PATCH",
    });

    expect(rows[0]?.eventType).toBe("bot.updated");
    expect(rows[0]?.payload.endpoint).toBe("https://elsewhere.example/ag-ui");
  });

  /*
   * The other dangerous edit, and the one the trail was silent about.
   *
   * `visibility` is not a display preference. `accessFilter` admits a public coworker to every
   * signed-in person, and `canRunAgent` is `canAccessAgent`, so public hands everybody in the
   * deployment the right to act as this Bot and spend the connector grants it holds. It is one click
   * in the coworker dialog.
   */
  test("creating one records who may reach it", async () => {
    const { rows, hono } = app();

    await hono.request("http://t/api/agents", json({ visibility: "private" }));

    expect(rows[0]?.eventType).toBe("bot.created");
    expect(rows[0]?.payload.visibility).toBe("private");
  });

  test("opening one to the whole deployment says so", async () => {
    const { rows, hono } = app();

    await hono.request("http://t/api/agents/bot-1", {
      ...json({ visibility: "public" }),
      method: "PATCH",
    });

    expect(rows[0]?.eventType).toBe("bot.updated");
    expect(rows[0]?.payload.visibility).toBe("public");
  });

  test("an edit that leaves it private says that too", async () => {
    // Carried on every row rather than only on the row that moved it: reading the trail forward has
    // to tell you what was reachable at each point, and the route has no before to compare against.
    const { rows, hono } = app();

    await hono.request("http://t/api/agents/bot-1", {
      ...json({ visibility: "private", title: "Sales assistant, revised" }),
      method: "PATCH",
    });

    expect(rows[0]?.payload.visibility).toBe("private");
  });

  test("a replaced key is noted and never recorded", async () => {
    const { rows, hono } = app();

    await hono.request("http://t/api/agents/bot-1", {
      ...json({
        endpoint: "https://partner.example/ag-ui",
        auth: { header: "Authorization", value: "Bearer sk-do-not-log-me" },
      }),
      method: "PATCH",
    });

    expect(rows[0]?.payload.keyReplaced).toBe(true);
    expect(JSON.stringify(rows[0]?.payload)).not.toContain("sk-do-not-log-me");
  });

  test("issuing a callback token records that, never the token", async () => {
    // A trail that records credentials is a credential store with worse access control.
    const { rows, hono } = app();

    const response = await hono.request(
      "http://t/api/agents/bot-1/callback-token",
      { method: "POST" },
    );

    expect(await response.json()).toEqual({
      token: "the-token-nobody-records",
    });
    expect(rows[0]?.eventType).toBe("bot.callback_token_issued");
    expect(JSON.stringify(rows[0])).not.toContain("the-token-nobody-records");
  });

  test.each([
    ["/api/agents/bot-1/hide", "POST", "bot.hidden"],
    ["/api/agents/bot-1/unhide", "POST", "bot.unhidden"],
    [
      "/api/agents/bot-1/callback-token",
      "DELETE",
      "bot.callback_token_revoked",
    ],
    ["/api/agents/bot-1", "DELETE", "bot.deleted"],
  ])("%s writes %s", async (path, method, eventType) => {
    const { rows, hono } = app();

    await hono.request(`http://t${path}`, { method });

    expect(rows[0]?.eventType).toBe(eventType);
    expect(rows[0]?.targetId).toBe("bot-1");
  });

  test("duplicating records the copy and names the original", async () => {
    // A duplicate inherits an endpoint, so a reader needs to know a second Bot now points at it.
    const { rows, hono } = app();

    await hono.request("http://t/api/agents/bot-1/duplicate", {
      method: "POST",
    });

    expect(rows[0]?.eventType).toBe("bot.duplicated");
    expect(rows[0]?.targetId).toBe("bot-2");
    expect(rows[0]?.payload.copiedFrom).toBe("bot-1");
  });

  test("a refused change writes nothing", async () => {
    // The row says what happened. An attempt that the store rejected did not happen.
    const { rows, hono } = app({
      update: async () => {
        throw new Error("nope");
      },
    });

    await hono.request("http://t/api/agents/bot-1", {
      ...json({ endpoint: "https://partner.example/ag-ui" }),
      method: "PATCH",
    });

    expect(rows).toHaveLength(0);
  });

  test("a trail that is down does not fail the change", async () => {
    // The Bot is already updated and the caller has been told so.
    const failing: AuditStore = {
      insert: async () => {
        throw new Error("the trail is unavailable");
      },
    };
    const requireUser: MiddlewareHandler = async (context, next) => {
      context.set("actor", ACTOR);
      await next();
    };
    const routes = createAgentRoutes(
      { setHidden: async () => undefined } as never,
      requireUser,
      true,
      failing,
    );
    const hono = new Hono<{ Variables: AppVariables }>().route(
      "/api/agents",
      routes,
    );

    const response = await hono.request("http://t/api/agents/bot-1/hide", {
      method: "POST",
    });

    expect(response.status).toBe(204);
  });
});

/**
 * Rotating a key is the standard answer to a suspected leak, and it only answers it if the old one
 * stops working. Editing a Bot's key wrote a new vault row and repointed the agent at it, leaving
 * the previous one decryptable and still valid with nothing listing it.
 */
describe("retiring the key an edit replaced", () => {
  function vault() {
    const revoked: string[] = [];
    return {
      revoked,
      store: { revoke: async (id: string) => void revoked.push(id) },
    };
  }

  test("revokes the one that was replaced", async () => {
    const { revoked, store } = vault();

    await retireReplacedKey(
      store,
      { auth: { credentialId: "old-key" } },
      { auth: { credentialId: "new-key" } },
    );

    expect(revoked).toEqual(["old-key"]);
  });

  test("never revokes the one just stored", async () => {
    // The direction that would be a catastrophe: the Bot would stop working the moment its key was
    // rotated, and the leaked one would be the survivor.
    const { revoked, store } = vault();

    await retireReplacedKey(
      store,
      { auth: { credentialId: "same-key" } },
      { auth: { credentialId: "same-key" } },
    );

    expect(revoked).toEqual([]);
  });

  test("does nothing when there was no key before", async () => {
    const { revoked, store } = vault();

    await retireReplacedKey(store, {}, { auth: { credentialId: "new-key" } });

    expect(revoked).toEqual([]);
  });

  test("retires the key when a Bot is removed entirely", async () => {
    // Deleting the Bot was the last chance anybody had to retire its credential.
    const { revoked, store } = vault();

    await retireReplacedKey(store, { auth: { credentialId: "old-key" } }, {});

    expect(revoked).toEqual(["old-key"]);
  });

  test("a vault that refuses does not fail the edit", async () => {
    // The new key is stored and the Bot works. This is loud and it is not fatal.
    const store = {
      revoke: async () => {
        throw new Error("the vault is unavailable");
      },
    };

    await expect(
      retireReplacedKey(
        store,
        { auth: { credentialId: "old-key" } },
        { auth: { credentialId: "new-key" } },
      ),
    ).resolves.toBeUndefined();
  });
});
