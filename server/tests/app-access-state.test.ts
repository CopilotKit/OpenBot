// server/tests/app-access-state.test.ts
import { describe, expect, test } from "bun:test";
import {
  type AppAccessFacts,
  accountOf,
  appAccessState,
  connectOf,
  ownerGrantsOf,
  REQUEST_KIND_FOR,
  unavailableReason,
} from "../src/plugins/app-access";
import { catalogueEntry } from "../src/plugins/catalogue";

/**
 * The rule one app's state is decided by, case by case, with every fact spelled out.
 *
 * The store gathers these facts from the tables; this file pins what the rule makes of them, so a
 * change to the rule shows up as a changed expectation here rather than as a Bot page that quietly
 * says something different.
 */

const composio = (overrides: Partial<AppAccessFacts> = {}): AppAccessFacts => ({
  provider: "composio",
  present: true,
  composioConfigured: true,
  authScheme: "OAUTH2",
  accountMode: "personal",
  catalogueAuth: null,
  hasCredential: false,
  granted: true,
  ownerGrants: null,
  mayGiveOwn: false,
  personal: null,
  shared: null,
  sharedAdmitted: null,
  ...overrides,
});

const drive = catalogueEntry("google-drive");
const notion = catalogueEntry("notion");
const parallel = catalogueEntry("parallel-authenticated");
if (!drive || !notion || !parallel)
  throw new Error("The catalogue entries these cases use are missing.");

const catalogue = (
  auth: AppAccessFacts["catalogueAuth"],
  overrides: Partial<AppAccessFacts> = {},
): AppAccessFacts => ({
  provider: "catalogue",
  present: true,
  composioConfigured: false,
  authScheme: null,
  accountMode: null,
  catalogueAuth: auth,
  hasCredential: true,
  granted: true,
  ownerGrants: null,
  mayGiveOwn: false,
  personal: null,
  shared: null,
  sharedAdmitted: null,
  ...overrides,
});

describe("a Composio app used under each person's own account", () => {
  test("not connected, connected, and connected with a refused key", () => {
    expect(appAccessState(composio())).toBe("not_connected");
    expect(appAccessState(composio({ personal: { usable: true } }))).toBe(
      "ready",
    );
    expect(appAccessState(composio({ personal: { usable: false } }))).toBe(
      "reconnect",
    );
  });

  test("tells a key form from a consent screen", () => {
    expect(connectOf(composio())).toBe("consent");
    expect(connectOf(composio({ authScheme: "API_KEY" }))).toBe("key");
    expect(accountOf(composio())).toBe("personal");
  });

  test("the Bot holding none of it is not_granted, whatever the person has", () => {
    expect(
      appAccessState(composio({ granted: false, personal: { usable: true } })),
    ).toBe("not_granted");
  });

  test("off at the deployment is disabled before anything else is asked", () => {
    for (const facts of [
      composio({ present: false }),
      composio({ composioConfigured: false }),
      composio({ authScheme: null }),
      composio({ granted: false, present: false }),
    ])
      expect(appAccessState(facts)).toBe("disabled");
    expect(unavailableReason(composio({ composioConfigured: false }))).toBe(
      "composio_unconfigured",
    );
    expect(unavailableReason(composio({ authScheme: "SOMETHING_NEW" }))).toBe(
      "scheme_unreadable",
    );
  });
});

describe("a Shared Composio app", () => {
  test("is ready only with a usable team account, whatever the person holds", () => {
    const shared = (over: Partial<AppAccessFacts>) =>
      composio({ accountMode: "shared", ...over });
    expect(appAccessState(shared({}))).toBe("shared_not_connected");
    expect(appAccessState(shared({ personal: { usable: true } }))).toBe(
      "shared_not_connected",
    );
    expect(appAccessState(shared({ shared: { usable: false } }))).toBe(
      "shared_not_connected",
    );
    expect(appAccessState(shared({ shared: { usable: true } }))).toBe("ready");
    // Connected, and the gate would refuse this person's calls through this Bot.
    expect(
      appAccessState(
        shared({ shared: { usable: true }, sharedAdmitted: false }),
      ),
    ).toBe("shared_not_approved");
    expect(
      appAccessState(
        shared({ shared: { usable: true }, sharedAdmitted: true }),
      ),
    ).toBe("ready");
    // The audience matters only once there is an account to reach.
    expect(appAccessState(shared({ sharedAdmitted: false }))).toBe(
      "shared_not_connected",
    );
    expect(accountOf(shared({}))).toBe("shared");
  });
});

describe("an app with no account at all", () => {
  test("a no-auth Composio app is ready once granted", () => {
    const facts = composio({ authScheme: "NO_AUTH" });
    expect(appAccessState(facts)).toBe("ready");
    expect(accountOf(facts)).toBe("deployment");
    expect(connectOf(facts)).toBeNull();
  });

  test("a server added by URL is ready once granted", () => {
    expect(
      appAccessState({
        ...catalogue(null),
        provider: "custom",
        hasCredential: false,
      }),
    ).toBe("ready");
  });

  test("a deployment-token entry needs its token first", () => {
    expect(appAccessState(catalogue(parallel.auth))).toBe("ready");
    expect(
      appAccessState(catalogue(parallel.auth, { hasCredential: false })),
    ).toBe("disabled");
    expect(
      unavailableReason(catalogue(parallel.auth, { hasCredential: false })),
    ).toBe("token_missing");
  });
});

describe("a catalogue app each person signs in to", () => {
  test("a manual OAuth client must be registered before anybody can connect", () => {
    expect(
      unavailableReason(catalogue(drive.auth, { hasCredential: false })),
    ).toBe("oauth_client_missing");
    expect(appAccessState(catalogue(drive.auth))).toBe("not_connected");
    expect(connectOf(catalogue(drive.auth))).toBe("oauth");
  });

  test("a self-registering client is ready as soon as the row is", () => {
    expect(
      appAccessState(catalogue(notion.auth, { hasCredential: false })),
    ).toBe("not_connected");
  });

  test("a withdrawn credential is reconnect", () => {
    expect(
      appAccessState(catalogue(drive.auth, { personal: { usable: false } })),
    ).toBe("reconnect");
    expect(
      appAccessState(catalogue(drive.auth, { personal: { usable: true } })),
    ).toBe("ready");
  });
});

test("only the three states an administrator can fix file a request", () => {
  expect(REQUEST_KIND_FOR).toEqual({
    ready: null,
    not_connected: null,
    reconnect: null,
    shared_not_connected: "connect_shared",
    // The refused call files the administrator's request itself.
    shared_not_approved: null,
    disabled: "enable",
    not_granted: "grant",
    // The Bot's owner gives it the app themselves; there is nobody to ask.
    owner_grantable: null,
  });
});

describe("who may give an app to a Bot", () => {
  const routines = catalogueEntry("routines");
  if (!routines) throw new Error("The Routines entry is missing.");

  test("owners decide by default where the app runs on the asker's own account, and for Routines", () => {
    expect(ownerGrantsOf(composio())).toBe("any");
    expect(ownerGrantsOf(catalogue(drive.auth))).toBe("any");
    expect(ownerGrantsOf(catalogue(routines.auth))).toBe("any");
  });

  test("an admin decides by default for a team account, a deployment token and no account", () => {
    expect(ownerGrantsOf(composio({ accountMode: "shared" }))).toBe("admin");
    expect(
      ownerGrantsOf(composio({ authScheme: "NO_AUTH", accountMode: null })),
    ).toBe("admin");
    expect(ownerGrantsOf(catalogue(parallel.auth))).toBe("admin");
    expect(ownerGrantsOf({ ...catalogue(null), provider: "custom" })).toBe(
      "admin",
    );
  });

  test("what an administrator chose wins over the default, either way", () => {
    expect(ownerGrantsOf(composio({ ownerGrants: "admin" }))).toBe("admin");
    expect(
      ownerGrantsOf(composio({ accountMode: "shared", ownerGrants: "any" })),
    ).toBe("any");
  });

  test("an app the Bot does not hold is the owner's to give only where both say so", () => {
    const notHeld = { granted: false };
    expect(appAccessState(composio({ ...notHeld, mayGiveOwn: true }))).toBe(
      "owner_grantable",
    );
    // Not their Bot, or the feature switched off for them.
    expect(appAccessState(composio({ ...notHeld, mayGiveOwn: false }))).toBe(
      "not_granted",
    );
    // Their Bot, and an app an administrator keeps for themselves.
    expect(
      appAccessState(
        composio({ ...notHeld, mayGiveOwn: true, ownerGrants: "admin" }),
      ),
    ).toBe("not_granted");
    // Switched off is still switched off: an owner never turns an app on.
    expect(
      appAccessState(
        composio({ ...notHeld, mayGiveOwn: true, present: false }),
      ),
    ).toBe("disabled");
  });
});
