import { describe, expect, test } from "bun:test";
import type { ChannelIdentityContext } from "@copilotkit/channels";
import {
  MANAGED_SLACK_TENANT_ERROR,
  normalizeSlackTenantContext,
} from "../src/slack/tenant-context";

function identity(tenantId: string): ChannelIdentityContext {
  return {
    provider: "slack",
    tenant: { id: tenantId, name: "Workspace" },
    installation: { id: "I1" },
    actor: { id: "U1", kind: "human", name: "User" },
    conversation: { id: "C1", kind: "channel" },
    trigger: "message",
    event: { id: "E1", threadId: "TH1" },
    raw: { untrusted: true },
    lookupProfile: async () => ({
      id: "U1",
      kind: "human",
      name: "User",
      email: "user@example.test",
    }),
  };
}

describe("managed Slack tenant context", () => {
  test("keeps a known managed tenant authoritative without configuration", () => {
    const context = identity("T1");

    expect(normalizeSlackTenantContext(context)).toBe(context);
  });

  test("keeps a known managed tenant when configuration matches exactly", () => {
    const context = identity("T1");

    expect(normalizeSlackTenantContext(context, "T1")).toBe(context);
  });

  test("shares one canonical known tenant with linking and ingress", () => {
    const context = identity(" T1 ");

    const normalized = normalizeSlackTenantContext(context, "T1");

    expect(normalized).not.toBe(context);
    expect(normalized.tenant).toEqual({ id: "T1", name: "Workspace" });
    expect(context.tenant.id).toBe(" T1 ");
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.tenant)).toBe(true);
  });

  test.each(["unknown", " UNKNOWN ", "", "   "])(
    "replaces a missing canonical tenant %j with operator configuration",
    (tenantId) => {
      const context = identity(tenantId);

      const normalized = normalizeSlackTenantContext(context, "T1");

      expect(normalized).not.toBe(context);
      expect(normalized.tenant).toEqual({ id: "T1", name: "Workspace" });
      expect(normalized.provider).toBe(context.provider);
      expect(normalized.installation).toBe(context.installation);
      expect(normalized.actor).toBe(context.actor);
      expect(normalized.conversation).toBe(context.conversation);
      expect(normalized.event).toBe(context.event);
      expect(normalized.trigger).toBe(context.trigger);
      expect(normalized.raw).toBe(context.raw);
      expect(normalized.lookupProfile).toBe(context.lookupProfile);
      expect(Object.isFrozen(normalized)).toBe(true);
      expect(Object.isFrozen(normalized.tenant)).toBe(true);
      expect(context.tenant.id).toBe(tenantId);
    },
  );

  test("rejects a conflict between managed and configured tenants", () => {
    expect(() => normalizeSlackTenantContext(identity("T2"), "T1")).toThrow(
      expect.objectContaining({
        message: MANAGED_SLACK_TENANT_ERROR,
        code: "slack_identity_tenant_invalid",
      }),
    );
  });

  test.each(["unknown", " UNKNOWN ", "", "   "])(
    "fails closed for missing canonical tenant %j without configuration",
    (tenantId) => {
      expect(() => normalizeSlackTenantContext(identity(tenantId))).toThrow(
        expect.objectContaining({
          message: MANAGED_SLACK_TENANT_ERROR,
          code: "slack_identity_tenant_invalid",
        }),
      );
    },
  );
});
