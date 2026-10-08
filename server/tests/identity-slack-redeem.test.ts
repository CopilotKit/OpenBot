import { describe, expect, spyOn, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { slackCodeRedeemer } from "../src/identity/slack-redeem";
import type { IdentityStore } from "../src/identity/store";
import {
  IdentityConflictError,
  IdentityInputError,
  type IdentityLink,
  IdentityLinkError,
} from "../src/identity/types";

const sender = { teamId: "T1", userId: "U1" };

function setup(
  behavior: () => Promise<IdentityLink>,
  discarded: () => Promise<boolean> = async () => true,
) {
  const calls: unknown[][] = [];
  const discards: unknown[][] = [];
  const events: AuditEventInput[] = [];
  const store = {
    redeemChallenge: async (...args: unknown[]) => {
      calls.push(args);
      return behavior();
    },
    discardChallenge: async (...args: unknown[]) => {
      discards.push(args);
      return discarded();
    },
  } as unknown as Pick<IdentityStore, "redeemChallenge" | "discardChallenge">;
  const auditStore: AuditStore = {
    insert: async (event) => {
      events.push(event);
    },
  };
  return { calls, discards, events, store, auditStore };
}

const link = {
  id: "link-1",
  userId: "user-1",
  provider: "slack",
  realm: "opentag:opentag:T1",
  subject: "U1",
} as unknown as IdentityLink;

describe("slackCodeRedeemer", () => {
  test("links, audits without realm or subject", async () => {
    const { calls, events, store, auditStore } = setup(async () => link);
    const result = await slackCodeRedeemer(store, auditStore).redeem(
      "CODE",
      sender,
    );
    expect(result).toBe("linked");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    expect(calls[0]).toEqual([
      "CODE",
      { provider: "slack", realm: "opentag:opentag:T1", subject: "U1" },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      eventType: "identity.linked",
      targetType: "identity_link",
      targetId: "link-1",
      actorUserId: "user-1",
      payload: { actor: "user-1", provider: "slack" },
    });
    const json = JSON.stringify(events[0]);
    expect(json).not.toContain("opentag:opentag");
    expect(json).not.toContain("U1");
  });

  test("an invalid code is invalid and not audited", async () => {
    const { events, store, auditStore } = setup(async () => {
      throw new IdentityLinkError();
    });
    expect(await slackCodeRedeemer(store, auditStore).redeem("X", sender)).toBe(
      "invalid",
    );
    expect(events).toHaveLength(0);
  });

  test("an input error is invalid", async () => {
    const { store, auditStore } = setup(async () => {
      throw new IdentityInputError();
    });
    expect(await slackCodeRedeemer(store, auditStore).redeem("X", sender)).toBe(
      "invalid",
    );
  });

  test("an incomplete sender is invalid", async () => {
    const { calls, store, auditStore } = setup(async () => link);
    expect(
      await slackCodeRedeemer(store, auditStore).redeem("X", {
        teamId: " ",
        userId: "U1",
      }),
    ).toBe("invalid");
    expect(calls).toHaveLength(0);
  });

  test("a conflict is reported and not audited", async () => {
    const { events, store, auditStore } = setup(async () => {
      throw new IdentityConflictError();
    });
    expect(await slackCodeRedeemer(store, auditStore).redeem("X", sender)).toBe(
      "conflict",
    );
    expect(events).toHaveLength(0);
  });

  test("other errors rethrow", async () => {
    const { store, auditStore } = setup(async () => {
      throw new Error("db down");
    });
    await expect(
      slackCodeRedeemer(store, auditStore).redeem("X", sender),
    ).rejects.toThrow("db down");
  });

  test("an audit write that fails after the link committed still reports linked, and logs", async () => {
    const { store } = setup(async () => link);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing: AuditStore = {
        insert: async () => {
          throw new Error("audit db down");
        },
      };
      expect(
        await slackCodeRedeemer(store, failing).redeem("CODE-1", sender),
      ).toBe("linked");
      const logged = errors.mock.calls.map((args: unknown[]) =>
        String(args[0]),
      );
      expect(logged).toHaveLength(1);
      expect(JSON.parse(logged[0] as string)).toEqual({
        type: "identity-link-audit-failed",
        provider: "slack",
        error: "Error: audit db down",
      });
      expect(logged[0]).not.toContain("CODE-1");
      expect(logged[0]).not.toContain("U1");
    } finally {
      errors.mockRestore();
    }
  });

  test("works without an audit store", async () => {
    const { store } = setup(async () => link);
    expect(await slackCodeRedeemer(store).redeem("X", sender)).toBe("linked");
  });

  test("discard cancels a Slack code and reports whether one existed", async () => {
    for (const existed of [true, false]) {
      const { calls, discards, events, store, auditStore } = setup(
        async () => link,
        async () => existed,
      );
      expect(await slackCodeRedeemer(store, auditStore).discard("CODE")).toBe(
        existed,
      );
      expect(discards).toEqual([["CODE", "slack"]]);
      expect(calls).toHaveLength(0);
      expect(events).toHaveLength(0);
    }
  });

  test("discard propagates a store failure", async () => {
    const { store } = setup(
      async () => link,
      async () => {
        throw new Error("db down");
      },
    );
    await expect(slackCodeRedeemer(store).discard("CODE")).rejects.toThrow(
      "db down",
    );
  });
});
