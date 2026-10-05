import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import type { AuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import {
  INSTRUCTIONS_LIMIT,
  InstructionsTooLongError,
  type UserInstructionsStore,
} from "../src/user-instructions";
import { testEnvironment } from "./support/environment";

const MEMBER = {
  id: "member-1",
  email: "member@openbot.test",
  name: "A Member",
  image: null,
};

const OTHER = {
  id: "member-2",
  email: "other@openbot.test",
  name: "Another Member",
  image: null,
};

/**
 * A person's own standing instructions, over HTTP.
 *
 * The rules worth pinning are the ones a screen cannot check for itself: that the text is scoped to
 * whoever the session says is asking rather than to anything in the request, that the cap is refused
 * rather than truncated, and that the trail records the change without recording the prose.
 */
function appWith(
  store?: UserInstructionsStore,
  options: { as?: typeof MEMBER; auditStore?: AuditStore } = {},
) {
  return createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: options.as ?? MEMBER }) },
    } as never,
    { rolesForUser: async () => ["user"] },
    /*
     * Positions 4-12 are the other stores, 13 is auditStore, 14-24 are more stores, and `store` is
     * 25, userInstructions, the signature's last. Every parameter from 4 on is optional, so a wrong
     * count is a silent type-check pass: see people-routes.test.ts, which learned this the hard way.
     */
    ...(Array.from({ length: 9 }) as never[]),
    options.auditStore as never,
    ...(Array.from({ length: 11 }) as never[]),
    store as never,
  );
}

/** One text per person, in memory, with the same trim, cap and clear rules the real store has. */
function memoryStore(initial: Record<string, string> = {}) {
  const state: Record<string, string> = { ...initial };
  const store: UserInstructionsStore = {
    read: async (userId) => state[userId] ?? null,
    write: async (userId, text) => {
      const instructions = text.trim();
      if (instructions.length > INSTRUCTIONS_LIMIT) {
        throw new InstructionsTooLongError();
      }
      if (instructions.length === 0) {
        delete state[userId];
        return "";
      }
      state[userId] = instructions;
      return instructions;
    },
  };
  return { store, state };
}

function memoryAudit() {
  const rows: Parameters<AuditStore["insert"]>[0][] = [];
  return {
    rows,
    store: {
      insert: async (event) => {
        rows.push(event);
      },
    } satisfies AuditStore,
  };
}

describe("standing instruction routes", () => {
  test("answers with an empty string when this person has written none", async () => {
    const { store } = memoryStore();
    const app = appWith(store);

    const response = await app.request(
      "http://openbot.local/api/settings/instructions",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ instructions: "" });
  });

  test("saves, trims, and answers with what was stored", async () => {
    const { store, state } = memoryStore();
    const app = appWith(store);

    const response = await app.request(
      "http://openbot.local/api/settings/instructions",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instructions: "  Write in British English.  " }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      instructions: "Write in British English.",
    });
    expect(state[MEMBER.id]).toBe("Write in British English.");
  });

  test("a later read returns what a save stored", async () => {
    const { store } = memoryStore();
    const app = appWith(store);

    await app.request("http://openbot.local/api/settings/instructions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "Never say we are a team." }),
    });

    const response = await app.request(
      "http://openbot.local/api/settings/instructions",
    );

    await expect(response.json()).resolves.toEqual({
      instructions: "Never say we are a team.",
    });
  });

  test("an empty save clears them", async () => {
    const { store, state } = memoryStore({
      [MEMBER.id]: "Write in British English.",
    });
    const app = appWith(store);

    const response = await app.request(
      "http://openbot.local/api/settings/instructions",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instructions: "   " }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ instructions: "" });
    expect(state[MEMBER.id]).toBeUndefined();
  });

  test("refuses more than the cap, and stores nothing when it does", async () => {
    const { store, state } = memoryStore({
      [MEMBER.id]: "Write in British English.",
    });
    const app = appWith(store);

    const response = await app.request(
      "http://openbot.local/api/settings/instructions",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instructions: "x".repeat(INSTRUCTIONS_LIMIT + 1),
        }),
      },
    );

    expect(response.status).toBe(400);
    // The sentence names the limit, because "too long" without a number is not something anybody can
    // act on while looking at a box they cannot count.
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain(String(INSTRUCTIONS_LIMIT));
    expect(state[MEMBER.id]).toBe("Write in British English.");
  });

  test.each([[{}], [{ instructions: null }], [{ instructions: 42 }]])(
    "refuses a body it does not understand: %j",
    async (body) => {
      const { store, state } = memoryStore();
      const app = appWith(store);

      const response = await app.request(
        "http://openbot.local/api/settings/instructions",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );

      expect(response.status).toBe(400);
      expect(state).toEqual({});
    },
  );

  /*
   * The scoping test, and the reason this endpoint has no user id anywhere in it.
   *
   * This text is read into a prompt that then speaks as that person's coworker in every channel they
   * work in. A route that took the person from the path or the body would be a way to put words in
   * somebody else's mouth, so the only source is the session.
   */
  test("two people never see each other's instructions", async () => {
    const { store, state } = memoryStore();

    await appWith(store, { as: MEMBER }).request(
      "http://openbot.local/api/settings/instructions",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instructions: "Write in British English." }),
      },
    );
    await appWith(store, { as: OTHER }).request(
      "http://openbot.local/api/settings/instructions",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instructions: "Answer in one paragraph." }),
      },
    );

    await expect(
      appWith(store, { as: MEMBER })
        .request("http://openbot.local/api/settings/instructions")
        .then((response) => response.json()),
    ).resolves.toEqual({ instructions: "Write in British English." });
    await expect(
      appWith(store, { as: OTHER })
        .request("http://openbot.local/api/settings/instructions")
        .then((response) => response.json()),
    ).resolves.toEqual({ instructions: "Answer in one paragraph." });
    expect(state).toEqual({
      [MEMBER.id]: "Write in British English.",
      [OTHER.id]: "Answer in one paragraph.",
    });
  });

  test("records that they changed, and never what they say", async () => {
    const { store } = memoryStore();
    const audit = memoryAudit();
    const app = appWith(store, { auditStore: audit.store });

    await app.request("http://openbot.local/api/settings/instructions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "Write in British English." }),
    });

    expect(audit.rows).toEqual([
      {
        eventType: "configuration.changed",
        targetType: "user_instructions",
        targetId: MEMBER.id,
        actorUserId: MEMBER.id,
        payload: {
          change: "instructions_saved",
          characters: "Write in British English.".length,
          limit: INSTRUCTIONS_LIMIT,
        },
      },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain("British");
  });

  test("records a clearing as a clearing", async () => {
    const { store } = memoryStore({ [MEMBER.id]: "Write in British English." });
    const audit = memoryAudit();
    const app = appWith(store, { auditStore: audit.store });

    await app.request("http://openbot.local/api/settings/instructions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "" }),
    });

    expect(audit.rows[0]?.payload).toEqual({
      change: "instructions_cleared",
      characters: 0,
      limit: INSTRUCTIONS_LIMIT,
    });
  });

  /*
   * 503, not an empty string. "You have written none" and "this deployment cannot tell you" are
   * different answers, and the wrong one on this screen shows somebody an empty box, which invites
   * them to type it all in again over the top of something that is still there.
   */
  test("answers 503 rather than pretending when there is no store", async () => {
    const app = appWith(undefined);

    await expect(
      app
        .request("http://openbot.local/api/settings/instructions")
        .then((response) => response.status),
    ).resolves.toBe(503);
    await expect(
      app
        .request("http://openbot.local/api/settings/instructions", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ instructions: "Write in British English." }),
        })
        .then((response) => response.status),
    ).resolves.toBe(503);
  });
});
