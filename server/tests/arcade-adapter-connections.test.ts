import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Arcade from "@arcadeai/arcadejs";
import { useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import { brokerSentence } from "../src/plugins/broker";
import type { AccountRef } from "../src/plugins/shared-accounts";

/** Prototype stubs BEFORE construction; `new Arcade({ apiKey })` opens no socket. */
type Methods = Record<string, (...args: unknown[]) => unknown>;
const connectionsProto = (): Methods =>
  Object.getPrototypeOf(
    new Arcade({ apiKey: "never-dialled" }).admin.userConnections,
  ) as Methods;

const toolsProto = (): Methods =>
  Object.getPrototypeOf(
    new Arcade({ apiKey: "never-dialled" }).tools,
  ) as Methods;

const authProvidersProto = (): Methods =>
  Object.getPrototypeOf(
    new Arcade({ apiKey: "never-dialled" }).admin.authProviders,
  ) as Methods;

const restores: (() => void)[] = [];
function stub(
  name: string,
  impl: (...args: unknown[]) => unknown,
  on: Methods = connectionsProto(),
) {
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

/**
 * One user-connection row, whose `provider_id` is a provider INSTANCE id and NEVER a provider type.
 *
 * That is the live shape, and it is the whole subject of this file: on a tool listing
 * `provider_id` is the TYPE (`google`), on a connection row it is the operator's CONFIGURATION of
 * that type (`google-openbot`, `arcade-google`, `cpk-poc`). A fixture spelling both sides alike —
 * which every fixture here once did — makes the two meanings coincide and hides a comparison that
 * matches nothing on any real deployment.
 */
const row = (n: number, instance: string, info?: unknown) => ({
  id: `at_${n}`,
  connection_id: `ac_${n}`,
  provider_id: instance,
  provider_user_info: info,
});

/**
 * What the toolkit's listing says its auth provider TYPE is, keyed by the toolkit asked about. A
 * toolkit absent from the map is answered by a listing that names no provider, i.e. UNRESOLVED.
 * Counts the listing reads so a test can pin that a call resolves once.
 */
function providers(byToolkit: Record<string, string>) {
  const asked: unknown[] = [];
  stub(
    "list",
    (query) => {
      asked.push(query);
      const toolkit = (query as { toolkit: string }).toolkit;
      const provider = byToolkit[toolkit];
      return Promise.resolve({
        items: [
          {
            qualified_name: `${toolkit}.A`,
            requirements: {
              authorization: {
                id: "x",
                ...(provider ? { provider_id: provider } : {}),
              },
            },
          },
        ],
      });
    },
    toolsProto(),
  );
  return asked;
}

/**
 * The project's configured auth providers, verbatim in shape from the live project: `id` is the
 * INSTANCE and `provider_id` is the TYPE. Two instances share the type `google` on purpose — an
 * operator's own and one of Arcade's defaults — because a person may hold a connection under
 * either and reducing the type to one instance would drop one of them.
 */
const CONFIGS = [
  { id: "cpk-poc", provider_id: "github", type: "oauth2", status: "active" },
  {
    id: "google-openbot",
    provider_id: "google",
    type: "oauth2",
    status: "active",
  },
  {
    id: "arcade-google",
    provider_id: "google",
    type: "oauth2",
    status: "active",
  },
];

/**
 * The configuration listing, PAGED BY THE QUERY IT IS HANDED — the sibling of {@link listing}, and
 * scoped for the same reason.
 *
 * `admin.authProviders.list(options)` takes a bare `RequestOptions`, so its paging lives in a
 * NESTED `{ query: { limit, offset } }` and nowhere else: a flat `{ limit, offset }` is not an error
 * the SDK reports, it is a request carrying no query at all, answered with whatever page the vendor
 * defaults to. A stub that served every config to every call made that shape — and the size and
 * position of the page the adapter asks for — unobservable: asking for nothing, asking flat, or
 * asking for the wrong offset all passed every test in this file. So a page is served only to a
 * `query` naming a numeric `limit` and `offset`, sliced exactly as asked, and any other call gets a
 * real empty page whose `total_count` still counts every config — so the adapter's own
 * incompleteness cross-check fails loudly rather than answering a silent "not connected".
 *
 * Returns the options it was asked, so a test can assert the shape by name as well as by effect,
 * and pin that a call reads the configurations once.
 */
type ConfigsOptions = { query?: { limit?: unknown; offset?: unknown } };
function configs(items: unknown[] = CONFIGS) {
  const asked: ConfigsOptions[] = [];
  stub(
    "list",
    (options) => {
      const o = (options ?? {}) as ConfigsOptions;
      asked.push(o);
      const { limit, offset } = o.query ?? {};
      if (typeof limit !== "number" || typeof offset !== "number") {
        return Promise.resolve({ items: [], total_count: items.length });
      }
      return Promise.resolve({
        items: items.slice(offset, offset + limit),
        offset,
        limit,
        total_count: items.length,
      });
    },
    authProvidersProto(),
  );
  return asked;
}

/**
 * A PAGE, NOT A BARE GENERATOR. `connectionsFor` pages the connection listing itself rather than
 * leaning on the SDK's auto-pagination, because `OffsetPage` stops after page one whenever the
 * engine omits `total_count` — see `arcade-pagination-engine.test.ts`, which proves that against a
 * real HTTP engine. So the stub answers what the real `list` resolves to: an object with `items`,
 * honouring the `limit`/`offset` the adapter sends.
 *
 * AND SCOPED TO THE IDENTITY THE QUERY NAMES, which is the other half of what the real listing
 * does and what this stub once left out. `admin.userConnections.list` answers the connections of
 * ONE `user_id`; a stub that served its rows to every query made the identity the adapter sends
 * unobservable, so sending `account.userId` — the LOCAL id — or sending no `user_id` at all passed
 * every test in this file. Scoping the read to `account.vendorUserId` is the whole subject of
 * commit `28b13e4a`, a live defect in which one person's Disconnect could read, and spend DELETEs
 * against, another person's connections. So: rows are served only to a query naming `heldBy`
 * (the vendor identity by default), and any other query — wrong id, or none — gets a real empty
 * page, exactly as the vendor would answer for an identity holding nothing.
 *
 * Returns the queries it was asked, so a test can assert the identity by name as well as by effect.
 */
type ListingQuery = { user_id?: unknown; limit?: number; offset?: number };
function listing(rows: unknown[], heldBy: string = account.vendorUserId) {
  const asked: ListingQuery[] = [];
  stub("list", (query) => {
    const q = (query ?? {}) as ListingQuery;
    asked.push(q);
    const mine = q.user_id === heldBy ? rows : [];
    const offset = q.offset ?? 0;
    const limit = q.limit ?? mine.length;
    return Promise.resolve({
      items: mine.slice(offset, offset + limit),
      offset,
      limit,
      total_count: mine.length,
    });
  });
  return asked;
}

/** The TYPE each toolkit's listing names. Nothing here is an instance id. */
const TOOLKIT_TYPES = {
  Github: "github",
  GitHub: "github",
  Google: "google",
  Gmail: "google",
};

describe("arcade adapter connection lifecycle", () => {
  beforeEach(() => {
    providers(TOOLKIT_TYPES);
    configs();
  });

  test("isConnected is true on a non-empty list and false on an empty one", async () => {
    const rows: unknown[] = [row(1, "cpk-poc")];
    listing(rows);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.isConnected({ account, toolkit: "Github" })).toBe(true);
    rows.length = 0;
    expect(await broker.isConnected({ account, toolkit: "Github" })).toBe(
      false,
    );
  });

  test("isConnected ignores another app's connection", async () => {
    listing([row(1, "google-openbot")]);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.isConnected({ account, toolkit: "Github" })).toBe(
      false,
    );
  });

  /*
   * THE IDENTITY THE LISTING IS READ FOR, ASSERTED BY NAME. `AccountRef` carries two ids and they
   * are not interchangeable: `userId` is this deployment's own, `vendorUserId` is the one Arcade
   * files a connection under. Reading the listing for the wrong one is what commit `28b13e4a`
   * fixed in the source, and sending no `user_id` at all is worse still — `admin.userConnections`
   * then answers EVERY account's connections, which `revoke` would attribute to this one and
   * spend DELETEs against. Both are spelled out here because an effect-only assertion cannot tell
   * the difference between "scoped to the right id" and "scoped to a wrong id that happens to
   * hold these rows".
   */
  test("the connection listing is read for the VENDOR identity, on every page and every member", async () => {
    const asked = listing([row(1, "cpk-poc", { name: "Ada" })]);
    stub("delete", () => Promise.resolve());
    const { broker } = createArcadeClient("never-dialled");
    const toolkit = "Github";
    expect(await broker.isConnected({ account, toolkit })).toBe(true);
    expect(await broker.accountName({ account, toolkit })).toBe("Ada");
    expect(await broker.revoke({ account, toolkit })).toBe(true);
    expect(asked.length).toBeGreaterThan(0);
    for (const query of asked) {
      expect(query.user_id).toBe(account.vendorUserId);
      expect(query.user_id).not.toBe(account.userId);
    }
  });

  test("connections held by ANOTHER vendor identity are neither read nor deleted", async () => {
    listing([row(1, "cpk-poc", { name: "Ada" })], "vendor-somebody-else");
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    const toolkit = "Github";
    expect(await broker.isConnected({ account, toolkit })).toBe(false);
    expect(await broker.accountName({ account, toolkit })).toBeNull();
    expect(await broker.revoke({ account, toolkit })).toBe(false);
    expect(deleted).toEqual([]);
  });

  test("delete is passed the ac_ connection_id, never the at_ id", async () => {
    listing([row(7, "cpk-poc")]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.revoke({ account, toolkit: "Github" })).toBe(true);
    expect(deleted).toEqual(["ac_7"]);
    expect(String(deleted[0]).startsWith("at_")).toBe(false);
  });

  test("revokeAccount deletes by the id it is handed", async () => {
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    await broker.revokeAccount("ac_9");
    expect(deleted).toEqual(["ac_9"]);
  });

  test("revoke answers false on nothing-found and deletes nothing", async () => {
    listing([row(1, "google-openbot")]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.revoke({ account, toolkit: "Github" })).toBe(false);
    expect(deleted).toEqual([]);
  });

  test("revoke THROWS when one of several deletes fails, after trying them all", async () => {
    listing([row(1, "cpk-poc"), row(2, "cpk-poc"), row(3, "cpk-poc")]);
    const tried: unknown[] = [];
    stub("delete", (id) => {
      tried.push(id);
      return id === "ac_2"
        ? Promise.reject(new Error("500"))
        : Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    let outcome: unknown = "returned";
    try {
      outcome = await broker.revoke({ account, toolkit: "Github" });
    } catch (error) {
      outcome = error;
    }
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/1 of 3/);
    expect(tried).toEqual(["ac_1", "ac_2", "ac_3"]);
  });

  test("accountName never answers another app's name", async () => {
    listing([
      row(1, "cpk-poc", {}),
      row(2, "google-openbot", { name: "Grace" }),
      row(3, "cpk-poc", { name: "Ada" }),
    ]);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.accountName({ account, toolkit: "GitHub" })).toBe(
      "Ada",
    );
    expect(await broker.accountName({ account, toolkit: "Google" })).toBe(
      "Grace",
    );
  });

  test("accountName is null, not the second app's name, when the first carries none", async () => {
    listing([
      row(1, "cpk-poc", {}),
      row(2, "google-openbot", { name: "Grace" }),
    ]);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.accountName({ account, toolkit: "Github" })).toBeNull();
  });

  /*
   * THE DEFECT THIS FILE EXISTS FOR, AT ITS THREE MEMBERS. `Gmail` names the TYPE `google`; the
   * connection is held under the INSTANCE `google-openbot`. A comparison of the two raw strings
   * finds nothing — and `revoke` then answers false WITHOUT SPENDING A DELETE, so the vendor
   * connection outlives the Disconnect that was supposed to end it.
   */
  test("a Gmail connection under the custom instance `google-openbot` is FOUND by all three members", async () => {
    listing([row(4, "google-openbot", { name: "Grace" })]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    const toolkit = "Gmail";
    expect(await broker.isConnected({ account, toolkit })).toBe(true);
    expect(await broker.accountName({ account, toolkit })).toBe("Grace");
    expect(await broker.revoke({ account, toolkit })).toBe(true);
    // The `ac_…` connection_id, never the `at_…` row id.
    expect(deleted).toEqual(["ac_4"]);
  });

  test("a Gmail connection under Arcade's DEFAULT instance `arcade-google` is found too", async () => {
    listing([row(5, "arcade-google", { name: "Ada" })]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    const toolkit = "Gmail";
    expect(await broker.isConnected({ account, toolkit })).toBe(true);
    expect(await broker.accountName({ account, toolkit })).toBe("Ada");
    expect(await broker.revoke({ account, toolkit })).toBe(true);
    expect(deleted).toEqual(["ac_5"]);
  });

  test("BOTH instances of one type are matched; neither is dropped for the other", async () => {
    listing([row(4, "google-openbot"), row(5, "arcade-google")]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.revoke({ account, toolkit: "Gmail" })).toBe(true);
    expect(deleted.sort()).toEqual(["ac_4", "ac_5"]);
  });

  test("an UNRELATED instance (`cpk-poc`, type github) is not a Gmail connection", async () => {
    listing([row(1, "cpk-poc", { name: "Ada" })]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    const toolkit = "Gmail";
    expect(await broker.isConnected({ account, toolkit })).toBe(false);
    expect(await broker.accountName({ account, toolkit })).toBeNull();
    expect(await broker.revoke({ account, toolkit })).toBe(false);
    expect(deleted).toEqual([]);
  });

  test("the TYPE itself is not an instance id, so a row spelled `google` is not matched", async () => {
    // Nothing anywhere falls back to comparing the raw type against a row.
    listing([row(6, "google", { name: "Grace" })]);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.isConnected({ account, toolkit: "Gmail" })).toBe(false);
  });

  test("an instance the configuration list does not name is fail-closed, not deleted", async () => {
    // A provider configuration deleted while a connection outlived it.
    listing([row(8, "retired-google", { name: "Grace" })]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.revoke({ account, toolkit: "Gmail" })).toBe(false);
    expect(deleted).toEqual([]);
  });

  test("both the type and the instance are compared case-insensitively", async () => {
    providers({ Gmail: "GOOGLE" });
    configs([{ id: "Google-OpenBot", provider_id: "Google" }]);
    listing([row(4, "google-openbot", { name: "Grace" })]);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.isConnected({ account, toolkit: "Gmail" })).toBe(true);
  });

  test("a different provider on the same identity is still excluded", async () => {
    listing([row(1, "cpk-poc", { name: "Ada" }), row(2, "google-openbot", {})]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.accountName({ account, toolkit: "Gmail" })).toBeNull();
    expect(await broker.revoke({ account, toolkit: "Gmail" })).toBe(true);
    expect(deleted).toEqual(["ac_2"]);
  });

  /**
   * AN UNATTRIBUTABLE TOOLKIT REFUSES OUT OF ALL THREE LIFECYCLE MEMBERS, AND NEVER FALLS BACK TO
   * ITS NAME. Both halves matter and they used to be answered the same wrong way.
   *
   * The fallback is still refused: each fixture below serves a row whose instance id IS literally
   * the toolkit name folded down, so a fallback would find it and delete it — attributing somebody
   * else's connection to this app on a guess.
   *
   * And answering NO ROWS is refused too, which is this pair's reason for existing. `revoke` then
   * said `false` — "there was nothing to withdraw" — without spending a single DELETE, while
   * `store.ts`'s disconnect path deletes the local `brokered_connections` row on that answer
   * regardless: a live grant at the vendor that no row this deployment holds any longer names.
   * `isConnected` and `accountName` said not-connected for the same person, so Connect offered a
   * second authorization beside the live one. The listing was not read; refusing is the only
   * honest answer, and `broker.ts`'s `revoke` contract requires it.
   */
  test("a toolkit whose listing names NO provider refuses rather than answering no rows", async () => {
    providers({});
    listing([row(1, "gmail", { name: "Grace" })]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    const toolkit = "Gmail";
    const refusal = /names no auth provider at all/;
    await expect(broker.isConnected({ account, toolkit })).rejects.toThrow(
      refusal,
    );
    await expect(broker.accountName({ account, toolkit })).rejects.toThrow(
      refusal,
    );
    await expect(broker.revoke({ account, toolkit })).rejects.toThrow(refusal);
    expect(deleted).toEqual([]);
  });

  test("a toolkit whose listing names TWO providers refuses, naming both", async () => {
    // Two actions of one toolkit under two different provider types: the toolkit disagrees with
    // itself, so which of this account's connections are its own cannot be read off the listing.
    stub(
      "list",
      (query) => {
        const toolkit = (query as { toolkit: string }).toolkit;
        return Promise.resolve({
          items: ["microsoft", "google"].map((provider, n) => ({
            qualified_name: `${toolkit}.A${n}`,
            requirements: { authorization: { id: "x", provider_id: provider } },
          })),
        });
      },
      toolsProto(),
    );
    listing([row(1, "gmail", { name: "Grace" })]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    const toolkit = "Gmail";
    // Sorted, so the sentence does not change with the order the listing happened to arrive in.
    const refusal = /names 2 different auth providers \(google, microsoft\)/;
    await expect(broker.isConnected({ account, toolkit })).rejects.toThrow(
      refusal,
    );
    await expect(broker.accountName({ account, toolkit })).rejects.toThrow(
      refusal,
    );
    await expect(broker.revoke({ account, toolkit })).rejects.toThrow(refusal);
    expect(deleted).toEqual([]);
  });

  test("the unattributable refusal is an AUTHORED one, so the route shows its sentence", async () => {
    // A `BrokerRefusalError` and not a bare `Error`: `brokerSentence` is what the Disconnect and
    // Connect routes read, and a bare error would have them say "the vendor said nothing about
    // why, check the key" about a sentence this deployment wrote itself.
    providers({});
    listing([row(1, "google-openbot")]);
    const { broker } = createArcadeClient("never-dialled");
    const error = await broker
      .revoke({ account, toolkit: "Gmail" })
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(brokerSentence(error)).toMatch(/names no auth provider at all/);
  });

  test("a malformed listing THROWS out of the lifecycle members rather than answering no rows", async () => {
    stub("list", () => Promise.resolve({ items: "nope" }), toolsProto());
    listing([row(1, "google-openbot")]);
    const { broker } = createArcadeClient("never-dialled");
    await expect(broker.revoke({ account, toolkit: "Gmail" })).rejects.toThrow(
      /action list/,
    );
  });

  test("a malformed auth-provider listing THROWS rather than answering no rows", async () => {
    stub(
      "list",
      () => Promise.resolve({ items: "nope" }),
      authProvidersProto(),
    );
    listing([row(1, "google-openbot")]);
    const { broker } = createArcadeClient("never-dialled");
    await expect(broker.revoke({ account, toolkit: "Gmail" })).rejects.toThrow(
      /auth-provider list/,
    );
  });

  /**
   * AN AUTHORIZATION BLOCK THIS DEPLOYMENT CANNOT READ IS NOT AN ACTION THAT NAMES NO PROVIDER.
   *
   * `authProvidersNamedBy` once skipped it in silence, so a `Gmail` listing of one readable
   * `google` action beside one whose authorization arrived unreadable resolved to `google`, and
   * all three members answered — `revoke` spending DELETEs — off a listing that was not read whole.
   * The unreadable action may name another provider; one id beside it is not an attribution.
   */
  const beside = (unreadable: Record<string, unknown>) =>
    stub(
      "list",
      (query) => {
        const toolkit = (query as { toolkit: string }).toolkit;
        return Promise.resolve({
          items: [
            {
              qualified_name: `${toolkit}.Readable`,
              requirements: {
                authorization: { id: "x", provider_id: "google" },
              },
            },
            { qualified_name: `${toolkit}.Unreadable`, ...unreadable },
          ],
        });
      },
      toolsProto(),
    );

  test.each([
    [
      "an authorization that is a string",
      { requirements: { authorization: "oauth2" } },
      /Arcade sent a string where Gmail's action Gmail\.Unreadable carries its authorization requirement/,
    ],
    [
      "requirements that are a list",
      { requirements: ["oauth2"] },
      /Arcade sent a list where Gmail's action Gmail\.Unreadable carries its requirements/,
    ],
    [
      "a provider_id that is a number",
      { requirements: { authorization: { id: "x", provider_id: 42 } } },
      /Arcade sent a number where Gmail's action Gmail\.Unreadable carries its auth provider id/,
    ],
  ])(
    "an action carrying %s REFUSES, rather than resolving off the readable one",
    async (_, unreadable, refusal) => {
      beside(unreadable);
      listing([row(1, "google-openbot", { name: "Grace" })]);
      const deleted: unknown[] = [];
      stub("delete", (id) => {
        deleted.push(id);
        return Promise.resolve();
      });
      const { broker } = createArcadeClient("never-dialled");
      const toolkit = "Gmail";
      await expect(broker.isConnected({ account, toolkit })).rejects.toThrow(
        refusal,
      );
      await expect(broker.accountName({ account, toolkit })).rejects.toThrow(
        refusal,
      );
      const error = await broker
        .revoke({ account, toolkit })
        .then(() => null)
        .catch((thrown: unknown) => thrown);
      // AUTHORED, so the Disconnect route shows this sentence rather than vendor-outage advice.
      expect(brokerSentence(error)).toMatch(refusal);
      expect(deleted).toEqual([]);
    },
  );

  test("an action with NO authorization block beside a readable one still resolves — absence is not unreadability", async () => {
    beside({ requirements: { authorization: null } });
    listing([row(1, "google-openbot", { name: "Grace" })]);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.isConnected({ account, toolkit: "Gmail" })).toBe(true);
  });

  test("each call resolves the provider and its configurations once, however many rows", async () => {
    const asked = providers({ Gmail: "google" });
    const read = configs();
    listing([
      row(1, "google-openbot"),
      row(2, "google-openbot"),
      row(3, "arcade-google"),
    ]);
    stub("delete", () => Promise.resolve());
    const { broker } = createArcadeClient("never-dialled");
    await broker.revoke({ account, toolkit: "Gmail" });
    expect(asked).toHaveLength(1);
    expect(read).toHaveLength(1);
  });

  /*
   * THE CONFIGURATION LISTING'S PAGING, ASSERTED BY NAME AND BY EFFECT. The instance a person is
   * held under sits on PAGE TWO, behind a full page of other configurations, so an adapter that
   * reads one page, asks flat, or asks for the wrong offset cannot find it; and the options are
   * pinned verbatim, because `RequestOptions` drops anything outside `query` without a word.
   */
  test("the auth-provider listing is paged in the nested query shape, to the page holding the instance", async () => {
    const filler = Array.from({ length: 100 }, (_, n) => ({
      id: `filler-${n}`,
      provider_id: "github",
    }));
    const read = configs([
      ...filler,
      { id: "google-openbot", provider_id: "google" },
    ]);
    listing([row(1, "google-openbot", { name: "Grace" })]);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.isConnected({ account, toolkit: "Gmail" })).toBe(true);
    expect(read).toEqual([
      { query: { limit: 100, offset: 0 } },
      { query: { limit: 100, offset: 100 } },
    ]);
  });
});

/**
 * The same row, carrying the vendor's OWN answer to "is this connection still usable".
 *
 * Separate from {@link row} rather than a fourth parameter on it, because the point is that the
 * field is OPTIONAL on the wire: every fixture above omits it on purpose, and omission must keep
 * meaning "the vendor said nothing". A `null` status omits the key entirely, which is the shape an
 * engine that does not send the field answers with.
 */
const statusRow = (
  n: number,
  instance: string,
  status: string | null,
  info?: unknown,
) => ({
  ...row(n, instance, info),
  ...(status === null ? {} : { connection_status: status }),
});

/**
 * THE ROW'S EXISTENCE IS NOT THE ANSWER, AND THE THREE MEMBERS DO NOT AGREE ABOUT WHAT IS.
 *
 * `connection_status` is Arcade saying whether a connection still works. The positive reads —
 * `isConnected`, `accountName` — must SKIP a row it reports as expired, revoked, pending or failed,
 * because a screen saying "Connected, as Grace" off such a row is wrong in the one place somebody
 * looks to check, and nothing contradicts it until a tool call fails far away from here.
 *
 * `revoke` must STILL DELETE that row, which is the half a fixture set of live-only rows cannot
 * tell apart from the other. A dead row is a row the VENDOR still holds; skipping it would have
 * `revoke` answer `false` — "there was nothing to withdraw" — while `store.ts`'s disconnect path
 * deletes the local `brokered_connections` row on that answer regardless, leaving a grant at the
 * vendor that nothing this deployment holds any longer names. That is the exact signature of the
 * live defect this seam has already shipped once.
 *
 * Every fixture here is under `cpk-poc`/`google-openbot`, INSTANCE ids this project's
 * configuration names, so nothing below can pass or fail for the instance-vs-type reason the rest
 * of this file is about: the only variable is the status.
 */
describe("a connection the vendor reports as dead", () => {
  beforeEach(() => {
    providers(TOOLKIT_TYPES);
    configs();
  });

  test("is skipped by isConnected and accountName, and is STILL DELETED by revoke", async () => {
    listing([statusRow(1, "cpk-poc", "expired", { name: "Ada" })]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    const toolkit = "Github";
    expect(await broker.isConnected({ account, toolkit })).toBe(false);
    expect(await broker.accountName({ account, toolkit })).toBeNull();
    // Not `false`-with-no-delete: the row is the vendor's, and Disconnect must spend the call.
    expect(await broker.revoke({ account, toolkit })).toBe(true);
    expect(deleted).toEqual(["ac_1"]);
  });

  test("beside a live row, the LIVE one answers and revoke deletes both", async () => {
    listing([
      statusRow(1, "cpk-poc", "expired", { name: "Ada" }),
      statusRow(2, "cpk-poc", "active", { name: "Grace" }),
    ]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    const toolkit = "Github";
    expect(await broker.isConnected({ account, toolkit })).toBe(true);
    // The dead row is FIRST, so a member that stopped at the first row would say "Ada".
    expect(await broker.accountName({ account, toolkit })).toBe("Grace");
    expect(await broker.revoke({ account, toolkit })).toBe(true);
    expect([...deleted].sort()).toEqual(["ac_1", "ac_2"]);
  });

  /*
   * K2 SETTLED WHAT "BLANK" MEANS, ONCE, FOR EVERY VENDOR DECISION FIELD: a status the vendor did
   * not send (or sent as `null`) is SILENCE and the row stands; a status sent BLANK is present and
   * carries nothing, which is UNREADABLE — the judgement `authProvidersNamedBy` makes of a blank
   * `provider_id` — and an unreadable status is not "live". This row once asserted the opposite for
   * blank, which made the two readers disagree about the same wire value.
   */
  test("a status the vendor did not send is SILENCE and still reads as live; a blank one does not", async () => {
    listing([
      statusRow(1, "cpk-poc", null, { name: "Ada" }),
      statusRow(2, "google-openbot", "", { name: "Grace" }),
    ]);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.isConnected({ account, toolkit: "Github" })).toBe(true);
    expect(await broker.accountName({ account, toolkit: "Github" })).toBe(
      "Ada",
    );
    expect(await broker.isConnected({ account, toolkit: "Gmail" })).toBe(false);
    expect(await broker.accountName({ account, toolkit: "Gmail" })).toBeNull();
  });

  test("the status is folded and trimmed, so ` ACTIVE ` is live and `Expired` is not", async () => {
    listing([statusRow(1, "cpk-poc", " ACTIVE ", { name: "Ada" })]);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.isConnected({ account, toolkit: "Github" })).toBe(true);
    listing([statusRow(2, "cpk-poc", "Expired", { name: "Ada" })]);
    expect(await broker.isConnected({ account, toolkit: "Github" })).toBe(
      false,
    );
  });
});
