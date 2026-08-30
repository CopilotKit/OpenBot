import { describe, expect, test } from "bun:test";
import { createApprovalAuthorizer } from "../src/slack/approval-authorizer";
import type { ApprovalPresentation } from "../src/slack/approval-store";
import type { LinkedSlackIngress } from "../src/slack/ingress-registry";

const presentation: ApprovalPresentation = {
  presentationId: "11111111-1111-4111-8111-111111111111",
  channelsThreadId: "thread-1",
  conversationKey: "conversation-1",
  agentId: "risk",
  createdByUserId: "creator",
  createdAt: new Date(),
};

const liveIdentity: LinkedSlackIngress = {
  identityContext: {
    provider: "slack",
    tenant: { id: "tenant-1" },
    installation: { id: "installation-1" },
    actor: { id: "provider-user-1", kind: "human" },
    conversation: { id: "channel-1" },
    trigger: "interaction",
    event: { id: "event-1", threadId: "provider-thread-1" },
    raw: null,
  },
  identityResult: {
    kind: "linked",
    user: { id: "u1", name: "u1" },
    actor: { id: "u1", role: "user" },
    identity: {
      provider: "slack",
      providerTenantId: "tenant-1",
      providerUserId: "provider-user-1",
      providerEmail: null,
    },
  },
};

function authorizer(
  options: {
    active?: boolean;
    boundAgentId?: string | null;
    accessible?: boolean;
  } = {},
) {
  return createApprovalAuthorizer({
    links: {
      resolveActiveUser: async (id) =>
        options.active === false
          ? null
          : { id, name: id, role: "user" as const },
    } as never,
    threads: {
      getByChannelsThreadId: async () =>
        options.boundAgentId === null
          ? null
          : ({
              channelsThreadId: "thread-1",
              provider: "slack",
              providerTenantId: "tenant-1",
              providerConversationId: "channel-1",
              providerThreadId: "provider-thread-1",
              agentId: options.boundAgentId ?? "risk",
              agentName: "Risk Analyst",
              createdByUserId: "creator",
              createdAt: new Date(),
            } as const),
    } as never,
    profiles: {
      get: async () => (options.accessible === false ? null : ({} as never)),
    },
  });
}

describe("Slack approval authorization", () => {
  test("fails closed for unlinked, rebound, and inaccessible participants", async () => {
    expect(
      await authorizer({ active: false })({
        userId: "u1",
        presentation,
        liveIdentity,
      }),
    ).toBe(false);
    expect(
      await authorizer({ boundAgentId: "other" })({
        userId: "u1",
        presentation,
        liveIdentity,
      }),
    ).toBe(false);
    expect(
      await authorizer({ accessible: false })({
        userId: "u1",
        presentation,
        liveIdentity,
      }),
    ).toBe(false);
  });

  test("accepts only an active canonical user with current access to the pinned coworker", async () => {
    expect(
      await authorizer()({ userId: "u1", presentation, liveIdentity }),
    ).toEqual({
      actor: { id: "u1", role: "user" },
      applicationUser: { id: "u1", name: "u1" },
      provider: "slack",
      providerTenantId: "tenant-1",
      providerConversationId: "channel-1",
      providerThreadId: "provider-thread-1",
    });
  });
});
