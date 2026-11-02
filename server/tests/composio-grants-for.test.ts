import { describe, expect, test } from "bun:test";
import type { ConnectedAppBroker, GrantState } from "../src/plugins/broker";
import {
  buildComposioClient,
  type ComposioVendor,
} from "../src/plugins/composio-adapter";

/**
 * `grantsFor` through Composio, whose answer is DEGENERATE AND IS STILL AN ANSWER.
 *
 * The seam asks one question both providers answer: what does this account hold at this app.
 * Composio's auth config fixes the scope set when it is created, so every action in a toolkit
 * shares one state and one scope list — and reporting that state once per action is the honest
 * rendering of a toolkit-wide grant, not a stub standing in for a missing implementation. The
 * assertions below are therefore about SAMENESS as much as about the state: one entry per action,
 * the same verdict on each, and the scopes read off this deployment's own config rather than
 * invented per action.
 *
 * THE FAKE VENDOR BELOW FILTERS, AND THAT IS THE OTHER HALF OF WHAT THIS FILE CLAIMS. A fake that
 * hands back every fixture row whatever it was asked for cannot tell a correct question from a
 * wrong one, so a suite built on one asserts the SHAPE of `grantsFor`'s answer while leaving the
 * three things that make the answer this person's — which person, which statuses count as
 * connected, and which app — entirely unguarded. Every listing here therefore honours the query it
 * is given, and every test below carries at least one row the query must leave out.
 *
 * This file is named in `server/tsconfig.json`'s `include`, because the last describe is a TYPE
 * test and a `@ts-expect-error` inside an unchecked directory asserts nothing at all.
 */

/** A vendor method nothing in a given test should reach, which says so rather than answering. */
const refuse = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} should not have been called in this test.`);
};

/**
 * The person every fixture here asks about.
 *
 * THE TWO IDS DIFFER, which they did not when this file was written. `userId` is this deployment's
 * own id for somebody and `vendorUserId` is the id Composio knows them by; spelling both as
 * `user_1` made the two interchangeable in every assertion here, so a listing asked with the local
 * id — which is not an id Composio has ever seen — read exactly like one asked with the vendor's.
 */
const ACCOUNT = {
  holder: "person",
  userId: "user_1",
  vendorUserId: "composio_user_1",
} as const;

/** Somebody else at this deployment, whose rows no question about {@link ACCOUNT} may return. */
const OTHER_PERSON = "composio_user_2";

/**
 * The vendor's account statuses, spelled here because the adapter keeps its copy private.
 *
 * Written as a union rather than as `string` so that a fixture naming a status the vendor does not
 * publish is a type error here instead of a row that silently matches nothing and leaves the test
 * it belongs to passing for the wrong reason.
 */
type AccountStatus =
  | "INITIALIZING"
  | "INITIATED"
  | "ACTIVE"
  | "FAILED"
  | "EXPIRED"
  | "INACTIVE"
  | "REVOKED";

/**
 * A connected account as the vendor holds it: the row it would send, and the three facts the
 * listing is filtered on. The two are kept apart so that the routing facts cannot leak into the
 * row and be read by the adapter as fields the vendor sent.
 */
type AccountFixture = {
  row: { id?: unknown; data?: unknown; authConfig?: unknown };
  userId: string;
  status: AccountStatus;
  toolkit: string;
  /**
   * The id of the auth config this account was minted against, which the listing filters
   * `authConfigIds` on and which the row carries as `authConfig.id` — as `@composio/core` 0.18.1
   * builds every row (`src/utils/transformers/connectedAccounts.ts:55-62`). Written once here so
   * the filter and the row cannot disagree; a row that spells its own `authConfig` keeps it, which
   * is how a test hands over one Composio described unreadably.
   */
  config: string;
};

/** An auth config as the vendor holds it, beside the app whose listing returns it. */
type ConfigFixture = {
  row: { id?: unknown; name?: unknown; status?: unknown; scopes?: unknown };
  toolkit: string;
};

/** A published action, beside the app whose listing returns it. */
type ActionFixture = { row: { slug: string }; toolkit: string };

/**
 * A vendor answering the three listings `grantsFor` reads, and refusing everything else.
 *
 * The three are the whole of the implementation's reach: whether this person holds an account for
 * the app, which of this deployment's own auth configs stand for it (and what scopes they carry),
 * and which actions the app publishes. A fourth call is a change in what the method does, and it
 * names itself here rather than passing.
 *
 * EACH LISTING HONOURS ITS QUERY. `connectedAccounts.list` is filtered by `userIds`, `statuses`
 * and `toolkitSlugs`; `authConfigs.list` by `toolkit`; `tools.list` by `toolkit_slug`. Those are
 * the parameters that carry the whole of the scope isolation this file is about, and a fake that
 * ignored them would answer "yes, connected, here are the scopes" to a question about the wrong
 * person, about a half-finished consent, or about another app entirely.
 */
function vendorWith(parts: {
  accounts: AccountFixture[];
  configs: ConfigFixture[];
  actions: ActionFixture[];
}): ComposioVendor {
  return {
    tools: {
      list: async (query) => ({
        items: parts.actions
          .filter((action) => action.toolkit === query.toolkit_slug)
          .map((action) => action.row),
        next_cursor: null,
      }),
      getRawComposioToolBySlug: refuse("tools.getRawComposioToolBySlug"),
      execute: refuse("tools.execute"),
    },
    toolkits: {
      list: refuse("toolkits.list"),
      retrieve: refuse("toolkits.retrieve"),
    },
    authConfigs: {
      list: async (query) => ({
        items: parts.configs
          .filter((config) => config.toolkit === query.toolkit)
          .map((config) => config.row),
        nextCursor: null,
      }),
      create: refuse("authConfigs.create"),
      delete: refuse("authConfigs.delete"),
    },
    connectedAccounts: {
      list: async (query) => ({
        items: parts.accounts
          .filter(
            (account) =>
              query.userIds.includes(account.userId) &&
              query.toolkitSlugs.includes(account.toolkit) &&
              // `some` rather than `includes` only because the query's element type is the
              // adapter's own private union: the comparison is the same one.
              query.statuses.some((status) => status === account.status) &&
              // Absent means every config, which is what the vendor does with no filter at all.
              (query.authConfigIds === undefined ||
                query.authConfigIds.includes(account.config)),
          )
          .map((account) =>
            "authConfig" in account.row
              ? account.row
              : { ...account.row, authConfig: { id: account.config } },
          ),
        nextCursor: null,
      }),
      link: refuse("connectedAccounts.link"),
      create: refuse("connectedAccounts.create"),
      delete: refuse("connectedAccounts.delete"),
    },
  };
}

/** This deployment's own gmail config, which is where a gmail answer's scopes must come from. */
const OUR_GMAIL_CONFIG: ConfigFixture = {
  row: {
    id: "ac_1",
    name: "gmail (OpenBot)",
    status: "ENABLED",
    scopes: ["gmail.readonly", "gmail.send"],
  },
  toolkit: "gmail",
};

/**
 * A gmail config an operator made by hand in Composio's dashboard, carrying a scope nothing here
 * chose.
 *
 * IT IS IN EVERY GMAIL FIXTURE BELOW ON PURPOSE. The configs listing is scoped to the project
 * rather than to this deployment, so this row comes back beside ours on every read, and the only
 * thing telling the two apart is the `(OpenBot)` suffix. Without such a row present, `grantsFor`
 * reading `held` instead of `ours` answers identically to `grantsFor` reading `ours` — which is to
 * say the suite could not see the distinction it is named after. `gmail.modify` appears nowhere
 * else in this file, so it names which side of the filter an answer came from.
 */
const OPERATORS_GMAIL_CONFIG: ConfigFixture = {
  row: {
    id: "ac_0",
    name: "gmail hand-made by an operator",
    status: "ENABLED",
    scopes: ["gmail.modify"],
  },
  toolkit: "gmail",
};

describe("Composio's grantsFor", () => {
  test("answers one state per action, the same one for each, carrying the config's scopes", async () => {
    const { broker } = buildComposioClient(
      vendorWith({
        accounts: [
          {
            row: { id: "ca_1" },
            userId: ACCOUNT.vendorUserId,
            status: "ACTIVE",
            toolkit: "gmail",
            config: "ac_1",
          },
        ],
        configs: [OPERATORS_GMAIL_CONFIG, OUR_GMAIL_CONFIG],
        actions: [
          { row: { slug: "GMAIL_FETCH_EMAILS" }, toolkit: "gmail" },
          { row: { slug: "GMAIL_SEND_EMAIL" }, toolkit: "gmail" },
          { row: { slug: "GMAIL_CREATE_LABEL" }, toolkit: "gmail" },
        ],
      }),
    );

    const grants = await broker.grantsFor({
      toolkit: "gmail",
      account: ACCOUNT,
    });

    expect(grants).toEqual([
      {
        action: "GMAIL_FETCH_EMAILS",
        state: "authorized",
        scopes: ["gmail.readonly", "gmail.send"],
        authorization: "held",
      },
      {
        action: "GMAIL_SEND_EMAIL",
        state: "authorized",
        scopes: ["gmail.readonly", "gmail.send"],
        authorization: "held",
      },
      {
        action: "GMAIL_CREATE_LABEL",
        state: "authorized",
        scopes: ["gmail.readonly", "gmail.send"],
        authorization: "held",
      },
    ]);
    // The sameness is the claim, asserted on its own so that a per-action answer invented here
    // fails even if each entry happens to be well-formed.
    expect(new Set(grants.map((grant) => grant.state))).toEqual(
      new Set(["authorized"]),
    );
    // And the operator's scope is named rather than merely absent from the list above, so that a
    // reader can see which of the two configs this answer was allowed to read.
    // `scopes` lives on two of {@link GrantState}'s four members, so the narrowing is part of the
    // claim: a grant that arrived as `needs-operator` or `unknown` carries no scope list at all
    // and would make this assertion vacuous by having nothing to look through.
    expect(
      grants.flatMap((grant) =>
        "scopes" in grant ? grant.scopes : [`no scopes on a ${grant.state}`],
      ),
    ).not.toContain("gmail.modify");
  });

  test("answers needs-consent for each action where this person has connected nothing", async () => {
    const { broker } = buildComposioClient(
      vendorWith({
        accounts: [],
        configs: [
          {
            row: {
              id: "ac_1",
              name: "gmail (OpenBot)",
              status: "ENABLED",
              scopes: ["gmail.readonly"],
            },
            toolkit: "gmail",
          },
          OPERATORS_GMAIL_CONFIG,
        ],
        actions: [
          { row: { slug: "GMAIL_FETCH_EMAILS" }, toolkit: "gmail" },
          { row: { slug: "GMAIL_SEND_EMAIL" }, toolkit: "gmail" },
        ],
      }),
    );

    expect(
      await broker.grantsFor({ toolkit: "gmail", account: ACCOUNT }),
    ).toEqual([
      {
        action: "GMAIL_FETCH_EMAILS",
        state: "needs-consent",
        scopes: ["gmail.readonly"],
      },
      {
        action: "GMAIL_SEND_EMAIL",
        state: "needs-consent",
        scopes: ["gmail.readonly"],
      },
    ]);
  });

  /**
   * SOMEBODY ELSE'S CONNECTION IS NOT THIS PERSON'S, and the only thing that makes it so is the
   * `userIds` the listing is asked with. This is the gate `./access` leans on before running an
   * action, so reading it off the wrong person is a call made under a grant its caller never gave.
   */
  test("answers needs-consent where the only account for the app belongs to somebody else", async () => {
    const { broker } = buildComposioClient(
      vendorWith({
        accounts: [
          {
            row: { id: "ca_other" },
            userId: OTHER_PERSON,
            status: "ACTIVE",
            toolkit: "gmail",
            config: "ac_1",
          },
        ],
        configs: [OUR_GMAIL_CONFIG, OPERATORS_GMAIL_CONFIG],
        actions: [{ row: { slug: "GMAIL_FETCH_EMAILS" }, toolkit: "gmail" }],
      }),
    );

    expect(
      await broker.grantsFor({ toolkit: "gmail", account: ACCOUNT }),
    ).toEqual([
      {
        action: "GMAIL_FETCH_EMAILS",
        state: "needs-consent",
        scopes: ["gmail.readonly", "gmail.send"],
      },
    ]);
  });

  /**
   * A GRANT THAT NO LONGER OPENS ANYTHING, OR NEVER DID, IS NOT A CONNECTION — see `CONNECTED` in
   * the adapter, which is `["ACTIVE"]` and nothing else. Each row below is a state the vendor will
   * hand back to a listing that forgot to ask, and each one of them reported as `authorized` tells
   * a person their app is wired up and then fails every call they make with it.
   */
  test.each([
    ["INITIATED" as const],
    ["EXPIRED" as const],
    ["INACTIVE" as const],
    ["REVOKED" as const],
    ["FAILED" as const],
    ["INITIALIZING" as const],
  ])(
    "answers needs-consent where this person's only account is %s",
    async (status) => {
      const { broker } = buildComposioClient(
        vendorWith({
          accounts: [
            {
              row: { id: "ca_1" },
              userId: ACCOUNT.vendorUserId,
              status,
              toolkit: "gmail",
              config: "ac_1",
            },
          ],
          configs: [OUR_GMAIL_CONFIG, OPERATORS_GMAIL_CONFIG],
          actions: [{ row: { slug: "GMAIL_FETCH_EMAILS" }, toolkit: "gmail" }],
        }),
      );

      expect(
        await broker.grantsFor({ toolkit: "gmail", account: ACCOUNT }),
      ).toEqual([
        {
          action: "GMAIL_FETCH_EMAILS",
          state: "needs-consent",
          scopes: ["gmail.readonly", "gmail.send"],
        },
      ]);
    },
  );

  /**
   * ONE APP'S ANSWER IS ABOUT THAT APP. All three listings carry the toolkit, and all three of them
   * are wrong in a different way without it: another app's account makes this one read connected,
   * another app's config lends this one scopes nobody granted here, and another app's actions
   * arrive as entries in a grant list for an app that does not publish them.
   */
  test("reads the account, the config and the actions of the app asked about and no other", async () => {
    const { broker } = buildComposioClient(
      vendorWith({
        accounts: [
          {
            row: { id: "ca_slack" },
            userId: ACCOUNT.vendorUserId,
            status: "ACTIVE",
            toolkit: "slack",
            config: "ac_2",
          },
        ],
        configs: [
          OUR_GMAIL_CONFIG,
          OPERATORS_GMAIL_CONFIG,
          {
            row: {
              id: "ac_2",
              name: "slack (OpenBot)",
              status: "ENABLED",
              scopes: ["slack.chat.write"],
            },
            toolkit: "slack",
          },
        ],
        actions: [
          { row: { slug: "GMAIL_FETCH_EMAILS" }, toolkit: "gmail" },
          { row: { slug: "SLACK_SEND_MESSAGE" }, toolkit: "slack" },
        ],
      }),
    );

    // This person is connected to slack and not to gmail, and the gmail answer says so without
    // borrowing slack's action or slack's scope.
    expect(
      await broker.grantsFor({ toolkit: "gmail", account: ACCOUNT }),
    ).toEqual([
      {
        action: "GMAIL_FETCH_EMAILS",
        state: "needs-consent",
        scopes: ["gmail.readonly", "gmail.send"],
      },
    ]);
    expect(
      await broker.grantsFor({ toolkit: "slack", account: ACCOUNT }),
    ).toEqual([
      {
        action: "SLACK_SEND_MESSAGE",
        state: "authorized",
        scopes: ["slack.chat.write"],
        authorization: "held",
      },
    ]);
  });

  /**
   * THE SCOPES ARE THE CONFIG THE CONNECTION WAS MINTED AGAINST, WHICH NEED NOT BE OURS.
   *
   * `isConnected` — the gate `./access` asks before running an action — counts an account on any
   * config, because the call that runs an action names the person and the toolkit, not the
   * account. So a person whose only gmail account sits on an operator's hand-made config CAN act,
   * and `authorized` is the truth about them. What they hold is that config's scope set: answering
   * `authorized` with THIS deployment's scopes describes a grant they never made. Narrowing the
   * state to our configs instead would tell them to consent to an app the gate already lets them
   * use — the two read-only seam members disagreeing about one person.
   */
  test("answers authorized with the operator's config's scopes where that is the only config this person is connected on", async () => {
    const { broker } = buildComposioClient(
      vendorWith({
        accounts: [
          {
            row: { id: "ca_op" },
            userId: ACCOUNT.vendorUserId,
            status: "ACTIVE",
            toolkit: "gmail",
            config: "ac_0",
          },
        ],
        configs: [OUR_GMAIL_CONFIG, OPERATORS_GMAIL_CONFIG],
        actions: [{ row: { slug: "GMAIL_FETCH_EMAILS" }, toolkit: "gmail" }],
      }),
    );

    expect(
      await broker.grantsFor({ toolkit: "gmail", account: ACCOUNT }),
    ).toEqual([
      {
        action: "GMAIL_FETCH_EMAILS",
        state: "authorized",
        scopes: ["gmail.modify"],
        authorization: "held",
      },
    ]);
    // And the gate agrees, which is the consistency the state is measured for.
    expect(
      await broker.isConnected({ toolkit: "gmail", account: ACCOUNT }),
    ).toBe(true);
  });

  test("answers authorized with every scope this person holds where they are connected on both configs", async () => {
    const { broker } = buildComposioClient(
      vendorWith({
        accounts: [
          {
            row: { id: "ca_op" },
            userId: ACCOUNT.vendorUserId,
            status: "ACTIVE",
            toolkit: "gmail",
            config: "ac_0",
          },
          {
            row: { id: "ca_ours" },
            userId: ACCOUNT.vendorUserId,
            status: "ACTIVE",
            toolkit: "gmail",
            config: "ac_1",
          },
        ],
        configs: [OUR_GMAIL_CONFIG, OPERATORS_GMAIL_CONFIG],
        actions: [{ row: { slug: "GMAIL_FETCH_EMAILS" }, toolkit: "gmail" }],
      }),
    );

    expect(
      await broker.grantsFor({ toolkit: "gmail", account: ACCOUNT }),
    ).toEqual([
      {
        action: "GMAIL_FETCH_EMAILS",
        state: "authorized",
        scopes: ["gmail.modify", "gmail.readonly", "gmail.send"],
        authorization: "held",
      },
    ]);
  });

  /**
   * A CONFIG NOBODY CAN NAME LENDS NO SCOPES — neither ours nor anybody's. An account whose
   * `authConfig` Composio described unreadably is still an ACTIVE account, so the state is
   * `authorized`; what it was minted against is not something this deployment can read, and the
   * answer says nothing about it rather than borrowing this deployment's scope set. The same
   * report-not-refuse posture `scopesOf` takes for a config publishing no scopes at all.
   */
  test("lends no config's scopes to an account whose config Composio did not name", async () => {
    const { broker } = buildComposioClient(
      vendorWith({
        accounts: [
          {
            row: { id: "ca_blank", authConfig: { id: 7 } },
            userId: ACCOUNT.vendorUserId,
            status: "ACTIVE",
            toolkit: "gmail",
            config: "ac_1",
          },
        ],
        configs: [OUR_GMAIL_CONFIG, OPERATORS_GMAIL_CONFIG],
        actions: [{ row: { slug: "GMAIL_FETCH_EMAILS" }, toolkit: "gmail" }],
      }),
    );

    expect(
      await broker.grantsFor({ toolkit: "gmail", account: ACCOUNT }),
    ).toEqual([
      {
        action: "GMAIL_FETCH_EMAILS",
        state: "authorized",
        scopes: [],
        authorization: "held",
      },
    ]);
  });

  /**
   * A config publishing no scope set is an empty list rather than a refusal, because this method
   * REPORTS rather than acts: Composio publishes no scopes for a key-scheme config at all, and an
   * app whose grant cannot be described scope by scope is still an app this person is connected to.
   */
  test("carries an empty scope list where the config publishes none", async () => {
    const { broker } = buildComposioClient(
      vendorWith({
        accounts: [
          {
            row: { id: "ca_1" },
            userId: ACCOUNT.vendorUserId,
            status: "ACTIVE",
            toolkit: "firecrawl",
            config: "ac_1",
          },
        ],
        configs: [
          {
            row: { id: "ac_1", name: "firecrawl (OpenBot)", status: "ENABLED" },
            toolkit: "firecrawl",
          },
          {
            row: {
              id: "ac_0",
              name: "firecrawl hand-made by an operator",
              status: "ENABLED",
              scopes: ["firecrawl.everything"],
            },
            toolkit: "firecrawl",
          },
        ],
        actions: [{ row: { slug: "FIRECRAWL_SCRAPE" }, toolkit: "firecrawl" }],
      }),
    );

    expect(
      await broker.grantsFor({ toolkit: "firecrawl", account: ACCOUNT }),
    ).toEqual([
      {
        action: "FIRECRAWL_SCRAPE",
        state: "authorized",
        scopes: [],
        authorization: "held",
      },
    ]);
  });
});

/**
 * `authorizations` is a DECLARED value, and Composio's declaration is `null`.
 *
 * Read with a presence test and never with a vendor name: the point of the field is that the
 * broker says what it runs, on the object it hands over.
 */
describe("Composio's authorizations", () => {
  test("declares null rather than offering a flow it does not run", () => {
    const { broker } = buildComposioClient(
      vendorWith({ accounts: [], configs: [], actions: [] }),
    );

    expect(broker.authorizations).toBeNull();
  });
});

/**
 * THE NULLABILITY IS ONLY WORTH ANYTHING IF OMITTING THE FIELD FAILS, which is a claim about the
 * type and therefore a claim only `tsc` can settle — hence this file in `server/tsconfig.json`.
 *
 * An optional-shaped capability is the exact shape that failed open at `store.ts:1631`: nine broker
 * stubs omitted `grantIsLocal`, the gate's exemption read `undefined`, and a call ran for somebody
 * who had connected nothing. The two assertions below are the two halves of that — a literal
 * missing `authorizations` must not compile, and a literal declaring it `null` must.
 */
describe("the declared sub-surface", () => {
  /** Every member of the seam except `authorizations`, which is what the two tests vary. */
  const members = {
    grantIsLocal: true,
    // Nothing here asks what auth provider a connection is held under.
    authProviderOf: async () => null,
    grantsFor: async (): Promise<GrantState[]> => [],
    listApps: async () => [],
    ensureAuthConfig: async () => "not-needed" as const,
    deleteAuthConfig: async () => {},
    authorize: async () => ({
      redirectUrl: "https://openbot.test/x",
      authorizationId: null,
    }),
    isConnected: async () => false,
    revoke: async () => false,
    connectionFields: async () => [],
    connectWithFields: async () => ({ accountId: "ca_1" }),
    revokeAccount: async () => {},
    accountName: async () => null,
  };

  test("a broker literal omitting authorizations does not compile", () => {
    // @ts-expect-error `authorizations` is required: a broker must SAY whether it runs a
    // correlated, pollable authorization flow, and an omission is not an answer.
    const omitted: ConnectedAppBroker = members;
    const declared: ConnectedAppBroker = { ...members, authorizations: null };

    expect(omitted.grantIsLocal).toBe(true);
    expect(declared.authorizations).toBeNull();
  });
});
