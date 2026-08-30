import type { ChannelIdentityContext } from "@copilotkit/channels";

export const MANAGED_SLACK_TENANT_ERROR =
  "Managed Slack delivery did not provide the configured canonical tenant.";
const MANAGED_SLACK_TENANT_CODE = "slack_identity_tenant_invalid" as const;

function managedSlackTenantError(): Error & {
  code: typeof MANAGED_SLACK_TENANT_CODE;
} {
  return Object.assign(new Error(MANAGED_SLACK_TENANT_ERROR), {
    code: MANAGED_SLACK_TENANT_CODE,
  });
}

function canonicalTenantId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const tenantId = value.trim();
  return tenantId && tenantId.toLowerCase() !== "unknown"
    ? tenantId
    : undefined;
}

function withTenantId(
  context: ChannelIdentityContext,
  tenantId: string,
): ChannelIdentityContext {
  return Object.freeze({
    ...context,
    tenant: Object.freeze({ ...context.tenant, id: tenantId }),
  });
}

/**
 * Supply the operator-owned workspace only when managed Channels omitted its canonical tenant.
 * Every other identity fact remains the adapter's immutable value.
 */
export function normalizeSlackTenantContext(
  context: ChannelIdentityContext,
  configuredTenantId?: string,
): ChannelIdentityContext {
  const managedTenantId = canonicalTenantId(context.tenant?.id);
  const fallbackTenantId = canonicalTenantId(configuredTenantId);

  if (managedTenantId) {
    if (fallbackTenantId && managedTenantId !== fallbackTenantId) {
      throw managedSlackTenantError();
    }
    return context.tenant.id === managedTenantId
      ? context
      : withTenantId(context, managedTenantId);
  }
  if (!fallbackTenantId) {
    throw managedSlackTenantError();
  }

  return withTenantId(context, fallbackTenantId);
}
