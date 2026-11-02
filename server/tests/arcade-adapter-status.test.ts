import { afterEach, describe, expect, test } from "bun:test";
import Arcade from "@arcadeai/arcadejs";
import { useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import type { AccountRef } from "../src/plugins/shared-accounts";

/** Prototype stubs BEFORE construction; `new Arcade({ apiKey })` opens no socket. */
type Methods = Record<string, (...args: unknown[]) => unknown>;
const protoOf = (pick: (c: Arcade) => unknown): Methods =>
  Object.getPrototypeOf(
    pick(new Arcade({ apiKey: "never-dialled" })),
  ) as Methods;

const restores: (() => void)[] = [];
function stub(
  pick: (c: Arcade) => unknown,
  name: string,
  impl: (...args: unknown[]) => unknown,
) {
  const on = protoOf(pick);
  const was = on[name];
  on[name] = impl;
  restores.push(() => {
    on[name] = was;
  });
}
afterEach(() => {
  while (restores.length) restores.pop()?.();
  useArcadeClient(null);
});

const account: AccountRef = {
  holder: "person",
  userId: "u1",
  vendorUserId: "vendor-u1",
};

/** The listing calls, so a test can assert what went out with them. */
const listCalls: unknown[] = [];
function listing(items: unknown[]) {
  listCalls.length = 0;
  stub(
    (c) => c.tools,
    "list",
    (query) => {
      listCalls.push(query);
      return Promise.resolve({ items });
    },
  );
}

const tool = (name: string, requirements: unknown) => ({
  fully_qualified_name: `${name}@1.0.0`,
  qualified_name: name,
  name: name.split(".")[1],
  toolkit: { name: "Github" },
  requirements,
});

describe("grantsFor maps a toolkit listing to this deployment's vocabulary", () => {
  test("sends the user_id it was given and maps all four states", async () => {
    listing([
      tool("Github.SetStarred", {
        met: true,
        authorization: {
          provider_id: "github",
          status: "active",
          token_status: "completed",
          oauth2: { scopes: ["repo", "user"] },
        },
        secrets: [],
      }),
      tool("Github.ListStargazers", {
        met: false,
        authorization: {
          provider_id: "github",
          status: "inactive",
          token_status: "not_started",
          oauth2: { scopes: ["repo"] },
        },
        secrets: [],
      }),
      tool("Github.CreateIssue", {
        met: false,
        authorization: {
          provider_id: "github",
          status: "active",
          token_status: "completed",
          oauth2: { scopes: ["repo"] },
        },
        // The live listing: an operator sets this once for everybody and no amount
        // of consenting moves it.
        secrets: [
          { key: "GITHUB_SERVER_URL", met: false, status_reason: "unset" },
        ],
      }),
      // An authorization block in a shape this deployment cannot read. NOT a row with no block at
      // all: that is the vendor saying the action needs none, and is `authorized` — see below.
      tool("Github.CountStargazers", { met: false, authorization: "oauth2" }),
    ]);

    const { broker } = createArcadeClient("never-dialled");
    const grants = await broker.grantsFor({ toolkit: "Github", account });

    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]).toMatchObject({
      toolkit: "Github",
      user_id: "vendor-u1",
    });

    expect(grants).toEqual([
      {
        action: "Github.SetStarred",
        state: "authorized",
        scopes: ["repo", "user"],
        authorization: "held",
      },
      {
        action: "Github.ListStargazers",
        state: "needs-consent",
        scopes: ["repo"],
      },
      {
        action: "Github.CreateIssue",
        state: "needs-operator",
        missing: ["GITHUB_SERVER_URL"],
      },
      {
        action: "Github.CountStargazers",
        state: "unknown",
        reason: expect.any(String),
      },
    ]);
  });

  test("an unreadable authorization is unknown, never a pessimistic needs-consent", async () => {
    listing([
      // An authorization block with neither a status nor a token_status: the listing
      // says neither "connected" nor "not connected".
      tool("Github.WhoAmI", {
        met: false,
        authorization: { provider_id: "github", oauth2: { scopes: ["user"] } },
        secrets: [],
      }),
    ]);

    const { broker } = createArcadeClient("never-dialled");
    const grants = await broker.grantsFor({ toolkit: "Github", account });

    expect(grants).toHaveLength(1);
    expect(grants[0]?.state).toBe("unknown");
    expect(grants[0]?.state).not.toBe("needs-consent");
    expect(grants[0]).toEqual({
      action: "Github.WhoAmI",
      state: "unknown",
      reason: expect.any(String),
    });
  });
});

/**
 * ONE READING OF A MISSING AUTHORIZATION BLOCK, ASKED OF BOTH QUESTIONS ON THE SAME ROW.
 *
 * The catalogue files an app whose actions publish no `requirements.authorization` as `no-auth`;
 * the grants screen once read that same silence as "could not be read" and drew every action of
 * such an app as `unknown` — the broker-outage state — forever, with nothing anybody could do about
 * it. `Apollo` is the live shape (one deployment secret, no authorization block), here with its
 * secret SET, which is the state that used to stick.
 */
describe("an action that publishes no authorization needs none, on every screen", () => {
  const silent = [
    tool("Apollo.EnrichOrganization", {
      met: true,
      secrets: [{ key: "APOLLO_API_KEY", met: true }],
    }),
    tool("Apollo.SearchPeople", null),
    {
      qualified_name: "Apollo.SearchOrganizations",
      toolkit: { name: "Github" },
    },
  ];

  test("the catalogue says no-auth and the grants screen says usable, never unknown", async () => {
    listing(silent);
    const { broker } = createArcadeClient("never-dialled");

    const apps = await broker.listApps();
    expect(apps.map((app) => app.connection)).toEqual([{ kind: "no-auth" }]);

    expect(await broker.grantsFor({ toolkit: "Github", account })).toEqual([
      {
        action: "Apollo.EnrichOrganization",
        state: "authorized",
        scopes: [],
        authorization: "not-required",
      },
      {
        action: "Apollo.SearchPeople",
        state: "authorized",
        scopes: [],
        authorization: "not-required",
      },
      {
        action: "Apollo.SearchOrganizations",
        state: "authorized",
        scopes: [],
        authorization: "not-required",
      },
    ]);
  });

  test("an UNSET secret on such an action is still the operator's, not authorized", async () => {
    listing([
      tool("Apollo.EnrichOrganization", {
        met: false,
        secrets: [{ key: "APOLLO_API_KEY", met: false }],
      }),
    ]);
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.grantsFor({ toolkit: "Apollo", account })).toEqual([
      {
        action: "Apollo.EnrichOrganization",
        state: "needs-operator",
        missing: ["APOLLO_API_KEY"],
      },
    ]);
  });
});

/**
 * THE LEAK TEST. `auth.status` answers with a LIVE provider access token and the person's full
 * profile; the narrowing is a type, not a rule somebody has to remember.
 */
const TOKEN = "gho_16C7e42F292c6912E7710c838347Ae178B4a";
const PROFILE = {
  email: "ada@example.com",
  name: "Ada Lovelace",
  login: "ada",
  id: 4711,
};

function statusAnswers(answer: unknown) {
  stub(
    (c) => c.auth,
    "status",
    () => Promise.resolve(answer),
  );
}

describe("authorizations.status narrows and drops the rest", () => {
  const raw = {
    id: "auth_123",
    status: "completed",
    user_id: "vendor-u1",
    scopes: ["repo", "user"],
    provider_id: "github",
    url: "https://cloud.arcade.dev/approve/abc123",
    context: { token: TOKEN, user_info: PROFILE },
  };

  test("returns exactly the three fields", async () => {
    statusAnswers(raw);
    const { broker } = createArcadeClient("never-dialled");
    const flow = broker.authorizations;
    if (!flow) throw new Error("Arcade must declare an authorization flow.");

    const narrowed = await flow.status("auth_123");
    expect(Object.keys(narrowed).sort()).toEqual([
      "scopes",
      "status",
      "userId",
    ]);
    expect(narrowed).toEqual({
      status: "completed",
      userId: "vendor-u1",
      scopes: ["repo", "user"],
    });
  });

  test("the token, the profile and the url do not survive the narrowing", async () => {
    statusAnswers(raw);
    const { broker } = createArcadeClient("never-dialled");
    const flow = broker.authorizations;
    if (!flow) throw new Error("Arcade must declare an authorization flow.");

    const serialized = JSON.stringify(await flow.status("auth_123"));
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("gho_");
    expect(serialized).not.toContain(PROFILE.email);
    expect(serialized).not.toContain(PROFILE.name);
    expect(serialized).not.toContain(PROFILE.login);
    expect(serialized).not.toContain("user_info");
    expect(serialized).not.toContain("token");
    // An authorization url is a bearer capability and is not one of the three fields.
    expect(serialized).not.toContain(raw.url);
    expect(serialized).not.toContain("provider_id");
  });

  test("a missing status and user_id answer a string and a null, not undefined", async () => {
    statusAnswers({ context: { token: TOKEN, user_info: PROFILE } });
    const { broker } = createArcadeClient("never-dialled");
    const flow = broker.authorizations;
    if (!flow) throw new Error("Arcade must declare an authorization flow.");

    const narrowed = await flow.status("auth_123");
    expect(narrowed.userId).toBeNull();
    expect(typeof narrowed.status).toBe("string");
    expect(narrowed.scopes).toEqual([]);
    expect(JSON.stringify(narrowed)).not.toContain(TOKEN);
  });

  /**
   * AN EMPTY STATUS IS NOT A STATUS AND AN EMPTY USER ID IS NOT AN ID. `??` falls through on null
   * and undefined only, so a `textOf` answering `""` as text handed the return leg an empty status
   * in place of `"unknown"` and an empty string where the identity comparison expects `null`.
   */
  test("an empty status and user_id read as absent, not as empty text", async () => {
    statusAnswers({ status: "", user_id: "   ", scopes: [] });
    const { broker } = createArcadeClient("never-dialled");
    const flow = broker.authorizations;
    if (!flow) throw new Error("Arcade must declare an authorization flow.");

    const narrowed = await flow.status("auth_123");
    expect(narrowed.status).toBe("unknown");
    expect(narrowed.userId).toBeNull();
  });
});
