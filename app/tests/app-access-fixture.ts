import type { AppAccess } from "@/lib/app-access/queries";

/**
 * One app on a Bot as the screens read it (listBotApps, getBotApp): Gmail, from the directory, under
 * each person's own account, ready. Each test overrides only the fields its case is about.
 */
export function appAccess(overrides: Partial<AppAccess> = {}): AppAccess {
  return {
    key: "composio-gmail",
    displayName: "Gmail",
    logo: null,
    source: "directory",
    account: "personal",
    connect: "consent",
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
