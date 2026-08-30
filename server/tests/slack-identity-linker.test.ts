import { describe, expect, test } from "bun:test";
import type { ChannelIdentityContext } from "@copilotkit/channels";
import type { AgentActor } from "../src/agents/profile-types";
import type { ExternalLinkAuthorizationStore } from "../src/external/link-store";
import type {
  ExternalProviderIdentity,
  ExternalUserLink,
} from "../src/external/schema-types";
import { SlackIdentityLinker } from "../src/slack/identity-linker";

const KEY = "slack-identity-linker-test-key";
const IDENTITY: ExternalProviderIdentity = {
  provider: "slack",
  providerTenantId: "T1",
  providerUserId: "U1",
  providerEmail: "adapter@example.test",
};

type ActiveUser = { id: string; name: string; role: AgentActor["role"] };

function linked(
  openbotUserId: string,
  providerEmail = IDENTITY.providerEmail,
): ExternalUserLink {
  return {
    ...IDENTITY,
    providerEmail,
    openbotUserId,
    linkedAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function context(
  overrides: Partial<ChannelIdentityContext> = {},
): ChannelIdentityContext {
  return {
    provider: "slack",
    tenant: { id: "T1" },
    installation: { id: "I1" },
    actor: { id: "U1", kind: "human", email: "untrusted@example.test" },
    conversation: { id: "C1" },
    trigger: "message",
    event: { id: "Ev1" },
    raw: null,
    ...overrides,
  };
}

function storeFor(
  input: {
    link?: ExternalUserLink | null;
    found?: { id: string; name: string } | null;
    active?: Map<string, ActiveUser>;
    onLink?: () => { link: ExternalUserLink; error?: Error };
  } = {},
): ExternalLinkAuthorizationStore & {
  linkedWith: ExternalProviderIdentity[];
  findKeys: [string, string, string][];
  verifiedEmails: string[];
  activeIds: string[];
} {
  let currentLink = input.link ?? null;
  const linkedWith: ExternalProviderIdentity[] = [];
  const findKeys: [string, string, string][] = [];
  const verifiedEmails: string[] = [];
  const activeIds: string[] = [];
  const active = input.active ?? new Map<string, ActiveUser>();
  return {
    linkedWith,
    findKeys,
    verifiedEmails,
    activeIds,
    async find(provider, tenantId, providerUserId) {
      findKeys.push([provider, tenantId, providerUserId]);
      return currentLink;
    },
    async findVerifiedUserByEmail(email) {
      verifiedEmails.push(email);
      return input.found ?? null;
    },
    async resolveActiveUser(id) {
      activeIds.push(id);
      return active.get(id) ?? null;
    },
    async link(value) {
      linkedWith.push(value);
      const outcome = input.onLink?.();
      if (outcome) {
        currentLink = outcome.link;
        if (outcome.error) throw outcome.error;
      } else {
        currentLink = linked(value.openbotUserId, value.providerEmail);
      }
      return currentLink;
    },
  };
}

function linker(
  store: ExternalLinkAuthorizationStore,
  appUrl = "https://openbot.test",
) {
  return new SlackIdentityLinker({ store, encryptionKey: KEY, appUrl });
}

describe("SlackIdentityLinker", () => {
  test("reloads the current OpenBot user and role for every existing link", async () => {
    const store = storeFor({
      link: linked("alice"),
      active: new Map([
        ["alice", { id: "alice", name: "Alice Now", role: "admin" }],
      ]),
    });

    await expect(linker(store).resolve(context())).resolves.toMatchObject({
      kind: "linked",
      user: { id: "alice", name: "Alice Now" },
      actor: { id: "alice", role: "admin" },
    });
  });

  test("refuses a linked user that has been revoked or lost every supported role", async () => {
    const store = storeFor({ link: linked("alice") });

    const result = await linker(store).resolve(context());

    expect(result.kind).toBe("unlinked");
    expect(store.linkedWith).toEqual([]);
  });

  test("accepts only human provider actors", async () => {
    const store = storeFor({
      found: { id: "alice", name: "Alice" },
      active: new Map([
        ["alice", { id: "alice", name: "Alice", role: "user" }],
      ]),
    });

    await expect(
      linker(store).resolve(context({ actor: { id: "B1", kind: "bot" } })),
    ).rejects.toThrow("Slack identity requires a known tenant and actor id.");
    expect(store.linkedWith).toEqual([]);
  });

  test("uses only the adapter profile email for automatic linking", async () => {
    const store = storeFor({
      found: { id: "alice", name: "Alice" },
      active: new Map([
        ["alice", { id: "alice", name: "Alice", role: "user" }],
      ]),
    });
    const result = await linker(store).resolve(
      context({
        actor: { id: "U1", kind: "human", email: "attacker@example.test" },
        lookupProfile: async () => ({
          id: "U1",
          kind: "human",
          email: "  ADAPTER@EXAMPLE.TEST  ",
        }),
      }),
    );

    expect(result).toMatchObject({
      kind: "linked",
      actor: { id: "alice", role: "user" },
    });
    expect(store.linkedWith).toEqual([{ ...IDENTITY, openbotUserId: "alice" }]);
  });

  test("returns a secure linking flow for absent, ambiguous, unverified, or revoked adapter email", async () => {
    for (const profile of [
      undefined,
      { id: "U1", kind: "human" as const },
      { id: "U1", kind: "human" as const, email: "" },
    ]) {
      const store = storeFor();
      const result = await linker(store).resolve(
        context({ lookupProfile: async () => profile }),
      );
      expect(result.kind).toBe("unlinked");
      expect(store.linkedWith).toEqual([]);
      if (result.kind === "unlinked")
        expect(result.linkUrl).toStartWith(
          "https://openbot.test/link/slack?token=",
        );
    }
  });

  test("does not auto-link a matching email without an active OpenBot role", async () => {
    const store = storeFor({ found: { id: "alice", name: "Alice" } });
    const result = await linker(store).resolve(
      context({
        lookupProfile: async () => ({
          id: "U1",
          kind: "human",
          email: IDENTITY.providerEmail ?? undefined,
        }),
      }),
    );
    expect(result.kind).toBe("unlinked");
    expect(store.linkedWith).toEqual([]);
  });

  test("does not reassign a conflicting identity and only accepts the safe existing winner", async () => {
    const store = storeFor({
      found: { id: "alice", name: "Alice" },
      active: new Map([
        ["alice", { id: "alice", name: "Alice", role: "user" }],
        ["bob", { id: "bob", name: "Bob", role: "admin" }],
      ]),
      onLink: () => ({
        link: linked("bob"),
        error: new Error("That Slack identity is already linked."),
      }),
    });
    const result = await linker(store).resolve(
      context({
        lookupProfile: async () => ({
          id: "U1",
          kind: "human",
          email: IDENTITY.providerEmail ?? undefined,
        }),
      }),
    );

    expect(result).toMatchObject({
      kind: "linked",
      actor: { id: "bob", role: "admin" },
    });
    expect(store.linkedWith).toHaveLength(1);
  });

  test("requires a configured absolute app URL for an unlinked result", async () => {
    await expect(linker(storeFor(), "").resolve(context())).rejects.toThrow(
      "Slack link setup requires an absolute OPENBOT_APP_URL.",
    );
    await expect(
      linker(storeFor(), "/relative").resolve(context()),
    ).rejects.toThrow("Slack link setup requires an absolute OPENBOT_APP_URL.");
  });

  test("derives tenant and provider user only from ChannelIdentityContext", async () => {
    const store = storeFor();
    const result = await linker(store).resolve(
      context({
        tenant: { id: "T-trusted" },
        actor: {
          id: "U-trusted",
          kind: "human",
          email: "ignored@example.test",
        },
        raw: { tenant: "attacker", user: "attacker" },
      }),
    );
    expect(result).toMatchObject({
      identity: {
        provider: "slack",
        providerTenantId: "T-trusted",
        providerUserId: "U-trusted",
      },
    });
  });

  test("rejects noncanonical Slack tenant and actor identities before every store operation", async () => {
    for (const input of [
      { tenant: { id: "" } },
      { tenant: { id: "   " } },
      { tenant: { id: "UnKnOwN" } },
      { actor: { id: "" } },
      { actor: { id: "  " } },
      { actor: { id: " unknown " } },
      { actor: { id: undefined as never } },
      { tenant: { id: undefined as never } },
      { provider: "discord" },
    ]) {
      const store = storeFor();
      await expect(
        linker(store).resolve(
          context({
            ...input,
            actor: {
              id: "U1",
              kind: "human",
              ...(input.actor ?? {}),
            },
          }),
        ),
      ).rejects.toMatchObject({
        message: "Slack identity requires a known tenant and actor id.",
        code: expect.stringMatching(
          /^slack_identity_(provider|actor_kind|tenant|actor)_invalid$/,
        ),
      });
      expect(store.findKeys).toEqual([]);
      expect(store.verifiedEmails).toEqual([]);
      expect(store.linkedWith).toEqual([]);
      expect(store.activeIds).toEqual([]);
    }
  });

  test("classifies each invalid canonical identity field separately", async () => {
    const cases = [
      [context({ provider: "discord" }), "slack_identity_provider_invalid"],
      [
        context({ actor: { id: "U1", kind: "unknown" } }),
        "slack_identity_actor_kind_invalid",
      ],
      [context({ tenant: { id: "unknown" } }), "slack_identity_tenant_invalid"],
      [
        context({ actor: { id: "unknown", kind: "human" } }),
        "slack_identity_actor_invalid",
      ],
    ] as const;

    for (const [identityContext, code] of cases) {
      await expect(
        linker(storeFor()).resolve(identityContext),
      ).rejects.toMatchObject({ code });
    }
  });

  test("classifies link lookup failures without exposing their details", async () => {
    const store = storeFor();
    store.find = async () => {
      throw new Error("postgres host and credential detail");
    };

    await expect(linker(store).resolve(context())).rejects.toMatchObject({
      message: "Slack identity link lookup failed.",
      code: "slack_identity_link_lookup_failed",
    });
  });

  test("uses canonical trimmed tenant and actor ids for every store key and link", async () => {
    const store = storeFor({
      found: { id: "alice", name: "Alice" },
      active: new Map([
        ["alice", { id: "alice", name: "Alice", role: "user" }],
      ]),
    });
    await linker(store).resolve(
      context({
        tenant: { id: " T1 " },
        actor: { id: " U1 ", kind: "human" },
        lookupProfile: async () => ({
          id: " U1 ",
          kind: "human",
          email: "adapter@example.test",
        }),
      }),
    );

    expect(store.findKeys).toEqual([
      ["slack", "T1", "U1"],
      ["slack", "T1", "U1"],
    ]);
    expect(store.linkedWith).toEqual([{ ...IDENTITY, openbotUserId: "alice" }]);
  });

  test("requires a matching human adapter profile before automatic linking", async () => {
    for (const profile of [
      { id: "another-user", kind: "human" as const, email: "other@test" },
      { id: "U1", kind: "bot" as const, email: "other@test" },
    ]) {
      const store = storeFor({
        found: { id: "alice", name: "Alice" },
        active: new Map([
          ["alice", { id: "alice", name: "Alice", role: "user" }],
        ]),
      });
      const result = await linker(store).resolve(
        context({ lookupProfile: async () => profile }),
      );

      expect(result.kind).toBe("unlinked");
      if (result.kind === "unlinked") {
        expect(result.identity.providerEmail).toBeNull();
      }
      expect(store.verifiedEmails).toEqual([]);
      expect(store.linkedWith).toEqual([]);
    }
  });

  test("uses an explicit link flow when adapter profile lookup rejects", async () => {
    const store = storeFor();
    const result = await linker(store).resolve(
      context({
        lookupProfile: async () => {
          throw new Error("adapter unavailable");
        },
      }),
    );

    expect(result.kind).toBe("unlinked");
    if (result.kind === "unlinked") {
      expect(result.identity.providerEmail).toBeNull();
    }
    expect(store.verifiedEmails).toEqual([]);
    expect(store.linkedWith).toEqual([]);
  });

  test("rejects unsafe app URLs and permits only loopback HTTP development URLs", async () => {
    for (const appUrl of [
      "https://user:secret@example.com",
      "http://example.com",
      "ftp://example.com",
    ]) {
      await expect(
        linker(storeFor(), appUrl).resolve(context()),
      ).rejects.toThrow(
        "Slack link setup requires an absolute OPENBOT_APP_URL.",
      );
    }
    for (const appUrl of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
    ]) {
      const result = await linker(storeFor(), appUrl).resolve(context());
      expect(result.kind).toBe("unlinked");
      if (result.kind === "unlinked") {
        expect(result.linkUrl).toStartWith(`${appUrl}/link/slack?token=`);
        expect(result.linkUrl).not.toContain("@example.com");
      }
    }
  });
});
