import type { AppAccess } from "@/lib/app-access/queries";

/**
 * One app as `GET /api/plugins/for/:agentId/apps` answers it: Gmail, through Composio, under each
 * person's own account, ready. Each test overrides only the fields its case is about.
 */
export function appAccess(overrides: Partial<AppAccess> = {}): AppAccess {
  return {
    key: "composio-gmail",
    displayName: "Gmail",
    logo: null,
    provider: "composio",
    account: "personal",
    connect: "consent",
    authScheme: "OAUTH2",
    accountMode: "personal",
    state: "ready",
    unavailable: null,
    accountHolder: "you",
    asksFirst: false,
    granted: true,
    ownerGrants: "any",
    givenByOwner: false,
    needsConnect: false,
    connectedAt: null,
    requestKind: null,
    request: null,
    ...overrides,
  };
}
