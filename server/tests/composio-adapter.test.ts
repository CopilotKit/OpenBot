import { describe, expect, test } from "bun:test";
import { Composio, telemetry } from "@composio/core";
import {
  type BrokerConnection,
  BrokerRefusalError,
  brokerSentence,
  type ComposioBroker,
} from "../src/plugins/broker";
import {
  type ComposioActions,
  LISTING_LIMIT,
  vendorSentence,
} from "../src/plugins/composio";
import {
  buildComposioClient,
  createComposioClient,
} from "../src/plugins/composio-adapter";
import {
  A_CRASH,
  expectOnlyRefusal,
  type RefusalName,
} from "./helpers/refusals";

/**
 * The three facts about the adapter that a type checker cannot settle, asserted with no network.
 *
 * {@link buildComposioClient} takes the vendor OBJECT rather than an API key, and that is the whole
 * reason this file can exist: every test below hands it a literal whose methods record what they
 * were asked and answer from memory, so the adapter's own decisions are what is under test and
 * nothing here dials Composio. A `createComposioClient` that only took a key would have made this
 * file either a live test or no test at all.
 *
 * WHAT IS WORTH ASSERTING IS WHAT IS EASY TO GET SILENTLY WRONG. The mapping of the vendor's fields
 * onto ours is one such thing — a listing that omitted its limit, or a catalogue row that read the
 * wrong key for an action count, both answer plausibly and both are wrong in a way no exception
 * reports. The refusal is the other: it is the one place this adapter is required to NOT make a
 * vendor call, and an implementation that forwarded a mismatch would pass every test that only
 * looked at what came back.
 */

/**
 * The connection every fixture in this file resolves to, because none of them publishes a scheme.
 *
 * These rows were written to exercise the field mapping and the cache, so they carry a slug, a name
 * and a meta and nothing about authentication — which is itself a readable answer: an app Composio
 * says nothing about the auth of is one no flow here could run. It is named once rather than
 * retyped into five assertions, so a change to the sentence is a change in one place.
 */
const NO_SCHEME: BrokerConnection = {
  kind: "unsupported",
  reason:
    "Composio published no authentication scheme for this app, so there is no flow this deployment could run, and its own OAuth client is not something this deployment can register.",
};

/** A vendor method nothing in a given test should reach, which says so rather than answering. */
function refuse(what: string) {
  return async (): Promise<never> => {
    throw new Error(`${what} should not have been called in this test.`);
  };
}

/**
 * A vendor object whose every method refuses, with the few a test cares about substituted in.
 *
 * The refusals are the point rather than filler. A test about the catalogue that accidentally
 * executed a tool, or one about a refusal that reached the vendor anyway, would otherwise fail on
 * something unrelated — or, worse, pass. Here the unasked-for call names itself.
 */
function fakeVendor(parts: {
  tools?: Record<string, unknown>;
  toolkits?: Record<string, unknown>;
  authConfigs?: Record<string, unknown>;
  connectedAccounts?: Record<string, unknown>;
}) {
  return {
    tools: {
      list: refuse("tools.list"),
      getRawComposioToolBySlug: refuse("tools.getRawComposioToolBySlug"),
      execute: refuse("tools.execute"),
      ...parts.tools,
    },
    toolkits: {
      list: refuse("toolkits.list"),
      retrieve: refuse("toolkits.retrieve"),
      ...parts.toolkits,
    },
    authConfigs: {
      list: refuse("authConfigs.list"),
      create: refuse("authConfigs.create"),
      delete: refuse("authConfigs.delete"),
      ...parts.authConfigs,
    },
    connectedAccounts: {
      list: refuse("connectedAccounts.list"),
      link: refuse("connectedAccounts.link"),
      create: refuse("connectedAccounts.create"),
      delete: refuse("connectedAccounts.delete"),
      ...parts.connectedAccounts,
    },
  };
}

/**
 * The page every listing here asks for, WRITTEN OUT rather than imported.
 *
 * AN ASSERTION THAT IMPORTS THE CONSTANT IT IS ABOUT CANNOT FAIL WHEN THAT CONSTANT MOVES, because
 * both sides move together: each `limit` assertion below asked for whatever page the adapter had
 * just decided to ask for, and `LISTING_LIMIT` 1000 -> 20 left all of them passing. The sibling
 * `composio-transport.test.ts` writes its two numbers out for exactly this reason and documents it
 * at length; this file imported one and called it pinned.
 *
 * So the literal lives here, and the imported constant is read in exactly one test below — which is
 * where the argument for the number belongs: 1000 is the vendor's stated page ceiling and therefore
 * the whole listing.
 */
const WHOLE_LISTING = 1000;

/**
 * How many pages of one listing the adapter reads before it refuses, WRITTEN OUT for the reason
 * {@link WHOLE_LISTING} is — and asserted exactly, for a reason of its own.
 *
 * `expect(calls).toBeLessThan(200)` stood against a ceiling of 50. That bound pins nothing: it
 * passes at 50 pages, at 51, at 199, and at any ceiling anybody cares to raise it to short of the
 * test's own runaway stop — which is to say it asserted that the paging terminated and called that
 * an assertion about the ceiling. It was also green over the off-by-one it was the only test in a
 * position to see: the adapter read 51 pages while its refusal said 50, because the ceiling was
 * tested before the page it was counting had been recorded.
 *
 * So the number of pages READ and the number the refusal STATES are both asserted, and both
 * against this literal.
 *
 * IT WAS 50 AND IT IS 200, WHICH IS A DELIBERATE CHANGE RATHER THAN A TEST FOLLOWING A MODULE. 50
 * was argued from the only two listings that paged — one app's authorization configs and one
 * person's accounts for one app — where a second page is already extraordinary. The app catalogue
 * now pages too and is not that listing: Composio publishes more than {@link WHOLE_LISTING}
 * toolkits, so its second page is the ordinary case. The module states the arithmetic; what matters
 * here is that both numbers are written out, so a ceiling that moves again reddens the tests that
 * are about it rather than redefining them.
 */
const PAGES_BEFORE_REFUSING = 200;

/** The page this deployment sends somebody back to once the consent screen is done with them. */
const RETURN_URL = "https://openbot.test/settings/connected-accounts/x";

/**
 * What Composio answers a withdrawal it actually performed, returned by every double that performs
 * one.
 *
 * A DOUBLE THAT OMITS THIS IS NOT A DOUBLE OF THE VENDOR. `success` is a REQUIRED field of
 * `ConnectedAccountDeleteResponse` — "indicates whether the connected account was successfully
 * deleted" (`@composio/client` 0.1.0-alpha.76, `resources/connected-accounts.d.ts:7445-7451`) — and
 * every fixture here used to answer `undefined`, which Composio cannot send. That was harmless only
 * for as long as the adapter read nothing off the reply; the moment it started telling a performed
 * delete from a declined one, a fixture answering nothing was a fixture asserting the adapter's
 * behaviour against a reply no vendor produces.
 *
 * SPELLED AT EACH DOUBLE RATHER THAN DEFAULTED IN {@link fakeVendor}, for the reason the refusals
 * there are spelled: the two tests next door hand back `{ success: false }` and `{}` on purpose,
 * and a default would put the interesting answer and the ordinary one at different distances from
 * the reader.
 */
const WITHDRAWN = { success: true };

/**
 * What Composio answers a creation it actually performed, for the reason {@link WITHDRAWN} exists.
 *
 * `transformCreateAuthConfigResponse` builds this answer by reading `response.auth_config.id`
 * (`@composio/core` 0.18.1, `src/utils/transformers/authConfigs.ts:96-106`), so an id is the one
 * thing a created config comes back with. A double answering `undefined` is a double of a reply the
 * vendor cannot send — harmless only for as long as the adapter read nothing off it, which is
 * exactly the state that let a shape drift here report that nothing had been created over a config
 * standing at Composio.
 */
const CREATED = { id: "ac_created" };

/**
 * The three auth configs this file reasons about, named once rather than spelled at each fixture.
 *
 * Two of them are ours and one is an operator's dashboard work, and every decision the adapter
 * makes about an app's configs is a decision about which of the three it is looking at. Naming
 * them is what lets a fixture be written OUT of the order its assertion expects — see {@link MIXED}
 * — instead of being an array whose index quietly carries the answer.
 */
const BY_HAND = { id: "ac_by_hand", name: "Linear", status: "ENABLED" };
const OURS = { id: "ac_ours", name: "Linear (OpenBot)", status: "ENABLED" };
/** The spare from a lost enable race: two administrators both found nothing and both created. */
const OURS_SPARE = {
  id: "ac_ours_spare",
  name: "Linear (OpenBot)",
  status: "ENABLED",
};

/**
 * The gmail config this deployment made, which is what a withdrawal is now allowed to reach.
 *
 * `revoke` READS THE CONFIGS BEFORE IT READS THE ACCOUNTS, which is why every fixture below that
 * withdraws anything answers this listing. The account listing is scoped to the ids that come back
 * from it, so a fixture that did not answer it would be describing a deployment with no config of
 * its own — for which there is, correctly, nothing to withdraw — and every assertion about what the
 * delete was asked would be an assertion about a call that never went out.
 *
 * ITS OWN CONSTANT RATHER THAN {@link OURS}, because the suffix is the whole of what the adapter
 * reads and the rest of the name is the app an administrator typed. A gmail withdrawal answered
 * with a config called "Linear (OpenBot)" would pass, and would leave the one fixture in this file
 * that names the app it is about naming the wrong one.
 */
const OUR_GMAIL = {
  id: "ac_gmail_ours",
  name: "Gmail (OpenBot)",
  status: "ENABLED",
};

/** An operator's own gmail config, carrying no suffix, which is the whole of what tells them apart. */
const BY_HAND_GMAIL = {
  id: "ac_gmail_by_hand",
  name: "Gmail",
  status: "ENABLED",
};

/** That listing as a vendor double, since every withdrawing fixture below needs the same one. */
const ourGmailConfig = async () => ({ items: [OUR_GMAIL] });

/**
 * The three sentences `authorize` can refuse with, told apart by the remedy each one prescribes.
 *
 * `rejects.toThrow(/linear/)` MATCHES ALL THREE, WHICH IS NOT A DETAIL. Deleting the no-config
 * branch outright left this suite at 24 pass / 0 fail, because the call then fell through to the
 * disabled branch and that sentence names the app too. The three remedies are three different acts
 * by three different people — an administrator adding the app again, an operator enabling the
 * config in Composio's own dashboard, and nobody at all because the app is not connected by
 * visiting a page — so a test that cannot tell the sentences apart cannot tell a correct
 * classification from a wrong one, which is the whole thing these refusals exist to get right.
 *
 * Each is the fragment of its own sentence that no other one contains, and each test below asserts
 * its own AND the absence of the others.
 */
const NO_CONFIG_REMEDY =
  /removing the app on its Plugins page and adding it again creates one/;
const DISABLED_REMEDY = /can enable it in Composio's dashboard/;
const NO_PAGE_REMEDY =
  /connected by entering a credential rather than by visiting a page/;

/**
 * The error a call raised, or a failure saying it answered where the test required a refusal.
 *
 * `rejects.toThrow(...)` cannot be followed by a second question about the SAME error — which kind
 * it was, what else its sentence does not say — so every refusal assertion that wanted more than
 * one fact about one throw had to settle for the first. This hands the error over instead.
 *
 * IT TOLD TWO LIES ABOUT ITS OWN FAILURES, and a helper every refusal in this file is read through
 * is the last place a wrong answer about what happened should come from.
 *
 * `null` WAS BOTH ANSWERS AT ONCE. It was the value the resolve arm produced AND a value the reject
 * arm can hand back — `Promise.reject(null)` is a rejection, and a vendor stub or an adapter path
 * that raises a falsy value is exactly the kind of thing the tests below are written to catch — so
 * a call that REFUSED with one was reported as "The call answered where this test requires it to
 * have refused." That sends the reader to look for a missing guard when the guard fired. The two
 * outcomes are now told apart by which arm ran rather than by the value it carried.
 *
 * `undefined` WAS RETURNED AS AN `Error` IT IS NOT. The cast made the type check and nothing else:
 * the caller's very next line reads `.message` off it and the suite fails with the runtime's own
 * "undefined is not an object", which is the phrasing this file's own {@link A_CRASH}
 * exists to flag as a crash wearing a refusal's clothes — raised here, in the helper, about the
 * test rather than about the adapter. A rejection that is not an `Error` has no message to read, so
 * this says so itself instead of handing the caller something that will.
 */
async function failureOf(work: Promise<unknown>): Promise<Error> {
  type Outcome = { refused: false } | { refused: true; raised: unknown };

  const outcome = await work.then<Outcome, Outcome>(
    () => ({ refused: false }),
    (raised: unknown) => ({ refused: true, raised }),
  );
  if (!outcome.refused) {
    throw new Error(
      "The call answered where this test requires it to have refused.",
    );
  }
  if (!(outcome.raised instanceof Error)) {
    throw new Error(
      `The call refused with ${
        outcome.raised === null ? "null" : typeof outcome.raised
      } rather than with an Error, so there is no message on it for this test to read.`,
    );
  }
  return outcome.raised;
}

/*
 * {@link A_CRASH} IS IMPORTED RATHER THAN DECLARED HERE, and it is asked of every refusal this file
 * added after the shape sweep: a guard that is missing does not answer politely, it reads a field
 * off `undefined` and hands an administrator a sentence naming a vendor method. It moved to
 * `./helpers/refusals` because {@link expectOnlyRefusal} asks it of every sentence it grades, and
 * two copies of one judgement about what a crash reads like is the drift this file legislates
 * against everywhere else.
 */

/**
 * The envelope guard's own sentence, so a test about a ROW can say it was not this one.
 *
 * `pageOf` refuses an answer that is not `{ items: [...] }` before any row reader sees a row, and
 * every listing in {@link ComposioVendor} now comes off the RAW client, whose answers are envelopes
 * — `{ items, next_cursor }` — rather than the bare arrays the SDK's transformers used to return.
 * A fixture written as a bare array therefore dies at this guard, and a test asserting only "it
 * refused in a sentence" passes on a refusal about the container while its name promises one about
 * a field. Asserting the absence of this sentence is what makes the fixture's SHAPE load-bearing.
 */
const NOT_A_LISTING = /is not a listing at all/i;

/**
 * Every sentence one failure carries, its own first and then the ones hanging off it.
 *
 * A COUNT IS A SENTENCE WITH ITS REASONS SOMEWHERE ELSE, which is why a question about what a reader
 * was told cannot always be asked of `message` alone. `revoke` and `deleteAuthConfig` withdraw a SET
 * and make the count their whole message on purpose — it is the part a reader can act on — and hang
 * every refusal the loop met on `cause`, as one error or as an `AggregateError` of them. Asking only
 * the first line there would grade those two methods on a wording that is deliberately not where
 * their detail lives.
 */
function everythingSaidBy(error: unknown, depth = 0): string[] {
  if (!(error instanceof Error) || depth > 4) return [];
  const carried =
    error instanceof AggregateError
      ? error.errors.flatMap((one) => everythingSaidBy(one, depth + 1))
      : [];
  return [
    error.message,
    ...carried,
    ...everythingSaidBy(error.cause, depth + 1),
  ];
}

describe("the page size this file is written against", () => {
  test("the module's ceiling is still the number every assertion here spells out", () => {
    // The one place the imported constant is read. Changing `LISTING_LIMIT` reddens exactly this
    // test, which is where the argument for the number lives, rather than silently moving every
    // assertion in the file to whatever the module has just decided.
    expect(LISTING_LIMIT).toBe(WHOLE_LISTING);
  });
});

describe("listing an app's actions", () => {
  test("the caller's page reaches the vendor, so the vendor's default never applies", async () => {
    const asked: unknown[] = [];
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          list: async (query: unknown) => {
            asked.push(query);
            return {
              items: [
                {
                  slug: "GMAIL_FETCH_EMAILS",
                  name: "Fetch emails",
                  description: "Fetch emails from Gmail.",
                  input_parameters: { type: "object", properties: {} },
                  tags: ["readOnlyHint"],
                  version: "20260903_00",
                  toolkit: { slug: "gmail" },
                },
              ],
            };
          },
        },
      }),
    );

    const listed = await actions.listActions("gmail", {
      limit: WHOLE_LISTING,
    });

    // An omitted limit is not "no opinion": Composio's page defaults to 20, and the wrapper this
    // listing used to go through additionally set `important=true` whenever a toolkit query carried
    // no limit, no tags and no search (`@composio/core` 0.18.1, `src/models/Tools.ts:505-515`), so
    // the short answer was also a filtered one and nothing in it said so. The request is composed
    // here now, which is why the assertion is on the query and not on the answer: the limit, the
    // toolkit version the wrapper used to supply, and no `important` at all.
    expect(asked).toEqual([
      {
        toolkit_slug: "gmail",
        limit: WHOLE_LISTING,
        toolkit_versions: "latest",
      },
    ]);
    expect(listed).toEqual([
      {
        slug: "GMAIL_FETCH_EMAILS",
        description: "Fetch emails from Gmail.",
        inputParameters: { type: "object", properties: {} },
        tags: ["readOnlyHint"],
        version: "20260903_00",
      },
    ]);
  });

  test("a page of no rows is refused rather than dropped on the way to the vendor", async () => {
    const asked: unknown[] = [];
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          list: async (query: unknown) => {
            asked.push(query);
            // Twenty rows: Composio's own default page, which is what a dropped limit produced.
            return {
              items: Array.from({ length: 20 }, (_, index) => ({
                slug: `GMAIL_ACTION_${index}`,
              })),
            };
          },
        },
      }),
    );

    const refusal = await failureOf(actions.listActions("gmail", { limit: 0 }));

    /*
     * THE REASON MOVED AND THE REFUSAL DID NOT. Through the wrapper a zero did not travel short —
     * it did not travel: `getRawComposioTools` composed its request with `...(limit ? { limit } :
     * {})` (`@composio/core` 0.18.1, `src/models/Tools.ts:536`) over a schema spelling the field
     * `z.number().optional()` with no floor (`src/types/tool.types.ts:257`), so it went out with no
     * limit and came back as Composio's own page of twenty. The raw client passes a zero through,
     * so that particular substitution is gone. What is left is the argument that never rested on
     * it: the page is required on this seam precisely so that no layer supplies one quietly, and a
     * caller asking for no rows is a fault to report rather than one to correct on their behalf.
     */
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/0 rows is not a page/);
    expect(refusal.message).toMatch(/tools already held are untouched/);
    // Nothing went out, which is the point: the fault is in the request, not in the answer.
    expect(asked).toEqual([]);
  });
});

describe("the app catalogue", () => {
  test("a toolkit becomes the row an administrator chooses from", async () => {
    const asked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          list: async (query: unknown) => {
            asked.push(query);
            return {
              items: [
                {
                  slug: "gmail",
                  name: "Gmail",
                  is_local_toolkit: false,
                  meta: {
                    description: "Send and read mail.",
                    logo: "https://logos.composio.dev/gmail.png",
                    categories: [
                      { id: "productivity", name: "Productivity" },
                      { id: "email", name: "Email" },
                    ],
                    tools_count: 63,
                  },
                },
                // A toolkit that publishes none of the optional fields, because several do. An
                // administrator picking from a few hundred apps is better served by a missing logo
                // than by a broken one, so the absence has to survive as null rather than as "".
                {
                  slug: "sparse",
                  name: "Sparse",
                  is_local_toolkit: false,
                  meta: {},
                },
              ],
            };
          },
        },
      }),
    );

    const apps = await broker.listApps();

    // Pages at the documented ceiling, ordered by usage so the apps anybody actually connects come
    // first, and carrying no cursor field on the first request. No search term: the catalogue is
    // held for ten minutes and searched in this process by both of its callers, so a per-term
    // request would be a per-term cache.
    expect(asked).toEqual([{ limit: WHOLE_LISTING, sort_by: "usage" }]);
    expect(apps).toEqual([
      {
        slug: "gmail",
        name: "Gmail",
        description: "Send and read mail.",
        logo: "https://logos.composio.dev/gmail.png",
        categories: ["Productivity", "Email"],
        actionCount: 63,
        connection: NO_SCHEME,
      },
      {
        slug: "sparse",
        name: "Sparse",
        description: "",
        logo: null,
        categories: [],
        actionCount: 0,
        connection: NO_SCHEME,
      },
    ]);
  });
});

/**
 * The catalogue's lifetime, asserted by counting what the vendor was asked rather than what came
 * back.
 *
 * THE COST BEING AVOIDED IS NOT HYPOTHETICAL. The admin picker's search field debounces and then
 * asks `/composio/apps`, which filters the whole directory in this process because Composio's
 * toolkit listing takes no search term — so without a cache each distinct term a person types pulls
 * a few hundred rows over the wire, and pressing Add pulls them once more. Every test here therefore
 * asserts a CALL COUNT: an implementation that answered correctly and asked five times would pass
 * any assertion that only looked at the rows.
 *
 * The clock is the builder's second argument, which is why these can be written at all. Each
 * {@link buildComposioClient} holds its own cache, so a test starts from an empty one by building,
 * and moves time by assigning rather than by waiting ten minutes.
 */
describe("holding the catalogue", () => {
  /** The one row these tests map, kept out of the way of what they are actually asserting. */
  const GMAIL = {
    slug: "gmail",
    name: "Gmail",
    meta: { description: "Send and read mail.", tools_count: 63 },
  };
  const GMAIL_ROW = {
    slug: "gmail",
    name: "Gmail",
    description: "Send and read mail.",
    logo: null,
    categories: [],
    actionCount: 63,
    connection: NO_SCHEME,
  };

  test("a second listing inside the window asks the vendor nothing", async () => {
    let calls = 0;
    let clock = 1_000_000;
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          list: async () => {
            calls += 1;
            return { items: [GMAIL] };
          },
        },
      }),
      () => clock,
    );

    const first = await broker.listApps();
    // Nine minutes is a person searching, choosing and enabling: the whole interaction this cache
    // exists for happens inside one window.
    clock += 9 * 60 * 1000;
    const second = await broker.listApps();

    expect(calls).toBe(1);
    expect(first).toEqual([GMAIL_ROW]);
    expect(second).toEqual([GMAIL_ROW]);
  });

  test("a listing after the window asks again, and answers with what it just read", async () => {
    let calls = 0;
    let clock = 1_000_000;
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          list: async () => {
            calls += 1;
            // The catalogue moves between the two reads, which is the only way to tell a second
            // request apart from a cache that happened to be asked twice.
            return calls === 1
              ? { items: [GMAIL] }
              : {
                  items: [
                    GMAIL,
                    {
                      slug: "linear",
                      name: "Linear",
                      meta: { tools_count: 12 },
                    },
                  ],
                };
          },
        },
      }),
      () => clock,
    );

    await broker.listApps();
    clock += 10 * 60 * 1000 + 1;
    const later = await broker.listApps();

    expect(calls).toBe(2);
    expect(later).toEqual([
      GMAIL_ROW,
      {
        slug: "linear",
        name: "Linear",
        description: "",
        logo: null,
        categories: [],
        actionCount: 12,
        connection: NO_SCHEME,
      },
    ]);
  });

  test("callers arriving while a listing is in flight share the one request", async () => {
    let calls = 0;
    let answer: (page: { items: unknown[] }) => void = () => {};
    const inFlight = new Promise<{ items: unknown[] }>((resolve) => {
      answer = resolve;
    });
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          list: () => {
            calls += 1;
            return inFlight;
          },
        },
      }),
      () => 1_000_000,
    );

    // Not awaited between the two, because that is the case: three people opening the picker
    // together, or one debounce firing twice, all arrive before the first answer exists. A cache
    // that held the ROWS rather than the request would be empty for every one of them.
    const both = Promise.all([broker.listApps(), broker.listApps()]);
    answer({ items: [GMAIL] });
    const [first, second] = await both;

    expect(calls).toBe(1);
    expect(first).toEqual([GMAIL_ROW]);
    expect(second).toEqual([GMAIL_ROW]);
  });

  test("a refusal is not held, so the next caller asks the vendor again", async () => {
    let calls = 0;
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          list: async () => {
            calls += 1;
            // The real first failure here is a key that is unset or wrong, and the operator who
            // fixes it presses the button again within seconds. A cached refusal would keep
            // refusing for ten minutes with nothing left to fix.
            if (calls === 1) throw new Error("Composio refused the catalogue.");
            return { items: [GMAIL] };
          },
        },
      }),
      () => 1_000_000,
    );

    await expect(broker.listApps()).rejects.toThrow(/refused/);
    // The clock has not moved: the window is still open and it is the FAILURE rather than the
    // window that must not be remembered.
    const recovered = await broker.listApps();

    expect(calls).toBe(2);
    expect(recovered).toEqual([GMAIL_ROW]);
  });
});

describe("executing an action", () => {
  test("an action belonging to another app is refused before anything is sent", async () => {
    const executed: unknown[] = [];
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioToolBySlug: async () => ({
            slug: "GMAIL_FETCH_EMAILS",
            name: "Fetch emails",
            toolkit: { slug: "gmail" },
          }),
          execute: async (...call: unknown[]) => {
            executed.push(call);
            return { data: {}, error: null, successful: true };
          },
        },
      }),
    );

    // The gate in `./access` cleared this person for slack, because slack is what the connection's
    // url names. The slug was recorded by some earlier listing, and Composio's execute takes the
    // slug ALONE — there is no toolkit field on the wire — so forwarding this would run a Gmail
    // action under a gate that only ever looked at a Slack connection.
    const refused = actions.execute(
      {
        toolkit: "slack",
        slug: "GMAIL_FETCH_EMAILS",
        userId: "user_1",
        version: "20260903_00",
      },
      { max_results: 5 },
    );

    // Both apps are named, because a reader holding only one of them cannot tell whether the url
    // is wrong or the recorded action is.
    const refusal = await failureOf(refused);
    expect(refusal.message).toMatch(/slack/);
    expect(refusal.message).toMatch(/gmail/);
    // AND THE STEP, because a sentence that names both apps and stops there leaves the reader
    // holding a contradiction with nothing to do about it. The url this action was recorded under
    // has changed, and refreshing the app's tools is what reconciles the two.
    expect(refusal.message).toMatch(
      /Refreshing this app's tools on its Plugins page/,
    );
    expect(executed).toEqual([]);
  });

  /**
   * WHOSE CALL IT IS, WHICH NOTHING IN THIS FILE WAS ASKING.
   *
   * Every test around this one is about a call being REFUSED, and each asserts that nothing went
   * out. Not one asserted what goes out when the call is allowed — so the three fields that decide
   * what a successful call MEANS were covered by nobody. `userId` is the whole of a tool call's
   * attribution to a person: it is what Composio resolves to a connected account, so replacing it
   * with a literal runs one person's action against somebody else's mailbox, and the audit row this
   * deployment writes afterwards names the wrong human. `version` is what stops a recorded action
   * being run at whatever Composio publishes today. `arguments` is the call itself.
   *
   * ASSERTED AS THE WHOLE CALL RATHER THAN FIELD BY FIELD, because an extra field on this request is
   * as much a finding as a missing one — `allowMultiple`, a session id, a modifier — and a per-field
   * assertion is blind to every one of them.
   *
   * THE RESOLVE IS ASSERTED TOO, for the reason the execute is. It is the round trip this adapter
   * spends on purpose, and the version it carries is what decides WHICH definition of the action the
   * app-mismatch check below is made against.
   */
  test("a call that runs carries the person, the version and the arguments", async () => {
    const resolved: unknown[] = [];
    const ran: unknown[] = [];
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioToolBySlug: async (...call: unknown[]) => {
            resolved.push(call);
            return {
              slug: "GMAIL_FETCH_EMAILS",
              name: "Fetch emails",
              toolkit: { slug: "gmail" },
            };
          },
          execute: async (...call: unknown[]) => {
            ran.push(call);
            return { data: { messages: [] }, error: null, successful: true };
          },
        },
      }),
    );

    const answer = await actions.execute(
      {
        toolkit: "gmail",
        slug: "GMAIL_FETCH_EMAILS",
        // DELIBERATELY NOT THE `user_1` EVERY OTHER FIXTURE HERE USES. A literal standing in for
        // the caller's id is the mutation this test exists to catch, and the file's own house id is
        // the one literal a mutation would plausibly be — so a person named after nothing else is
        // what makes the assertion able to tell attribution from coincidence.
        userId: "user_whose_mailbox_this_is",
        version: "20260903_00",
      },
      { max_results: 5 },
    );

    expect(resolved).toEqual([
      ["GMAIL_FETCH_EMAILS", { version: "20260903_00" }],
    ]);
    expect(ran).toEqual([
      [
        "GMAIL_FETCH_EMAILS",
        {
          arguments: { max_results: 5 },
          userId: "user_whose_mailbox_this_is",
          version: "20260903_00",
        },
      ],
    ]);
    // And the vendor's answer crosses the seam as itself: this adapter adds nothing to a result and
    // takes nothing off one.
    expect(answer).toEqual({
      data: { messages: [] },
      error: null,
      successful: true,
    });
  });

  /**
   * AND THE ACCOUNT, WHERE THE CALLER MEANT ONE IN PARTICULAR.
   *
   * CRITERION. A call carrying `connectedAccountId` sends it to Composio under that name, beside
   * the three fields the test above pins. A call carrying none sends no such key at all, which is
   * what the whole-body assertion above already holds this to.
   *
   * REASON. A person and an app are not a name for an account. Composio takes one account per set
   * of credentials, one person may hold several for one app — a second mailbox, a stale account
   * beside a fresh one — and the vendor picks which of them an unpinned call runs in. For a Bot's
   * tool call that is right, and nothing here names an account. For a VERIFICATION it is the whole
   * meaning of the answer: `connectBrokeredWithFields` spends one call to find out whether the key
   * it has just attached works, and unpinned that call was answered by the person's OTHER account —
   * verifying a key nothing had tried, or condemning a good one, and deleting the account it had
   * just made, because some older account of theirs was broken.
   *
   * ASSERTED AT THE WIRE because this is the only place it can be. The field is the vendor's own —
   * `ToolExecuteParams` carries it — and every layer above this one can pass it perfectly while
   * this adapter drops it, which is exactly what it did: the seam had no such field, so the store
   * could not have sent one.
   */
  test("a call that names an account sends it as the connected account", async () => {
    const ran: unknown[] = [];
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioToolBySlug: async () => ({
            slug: "GMAIL_FETCH_EMAILS",
            name: "Fetch emails",
            toolkit: { slug: "gmail" },
          }),
          execute: async (...call: unknown[]) => {
            ran.push(call);
            return { data: {}, error: null, successful: true };
          },
        },
      }),
    );

    await actions.execute(
      {
        toolkit: "gmail",
        slug: "GMAIL_FETCH_EMAILS",
        userId: "user_whose_mailbox_this_is",
        version: "20260903_00",
        connectedAccountId: "ca_the_one_just_made",
      },
      {},
    );

    // The whole body again, for that test's reason: an extra field on this request is as much a
    // finding as a missing one.
    expect(ran).toEqual([
      [
        "GMAIL_FETCH_EMAILS",
        {
          arguments: {},
          userId: "user_whose_mailbox_this_is",
          version: "20260903_00",
          connectedAccountId: "ca_the_one_just_made",
        },
      ],
    ]);
  });
});

/**
 * Minting one person's connect link, which is the call that decides whether consent comes back.
 *
 * `connectedAccounts.link` RATHER THAN `toolkits.authorize`, and the difference is the whole
 * subject of these two tests. `toolkits.authorize` takes a user id, a toolkit and an optional auth
 * config id and has nowhere to put a callback, so every consent it started ended on Composio's own
 * hosted page: the person had granted access and the only way back to this deployment was to find
 * it again by hand. `link` carries the callback, and it is also the vendor's own named replacement
 * for `initiate` on Composio-managed OAuth, which is exactly what `ensureAuthConfig` creates here.
 *
 * The auth config is READ rather than created, because this deployment already made it when an
 * administrator enabled the app — named for this deployment, visible in an operator's dashboard.
 * `toolkits.authorize` would have created one on demand at Composio's defaults, which is the
 * behaviour enabling-time creation exists to replace.
 */
describe("beginning one person's connection", () => {
  test("the link carries the page this deployment sends them back to", async () => {
    const linked: unknown[] = [];
    const listed: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async (query: unknown) => {
            listed.push(query);
            return {
              items: [
                {
                  id: "ac_this_deployments",
                  name: "Linear (OpenBot)",
                  status: "ENABLED",
                },
              ],
            };
          },
        },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
    );

    const begun = await broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl:
        "https://openbot.test/settings/connected-accounts/composio-linear",
    });

    // The config this deployment already holds for the app — and no `authConfigs.create`, which
    // would refuse in `fakeVendor` if it were reached. The listing asks for disabled configs too,
    // because a config it cannot see is one `ensureAuthConfig` would create a second of.
    expect(listed).toEqual([
      { toolkit: "linear", limit: WHOLE_LISTING, showDisabled: true },
    ]);
    expect(linked).toEqual([
      [
        "user_1",
        "ac_this_deployments",
        {
          callbackUrl:
            "https://openbot.test/settings/connected-accounts/composio-linear",
        },
      ],
    ]);
    expect(begun).toEqual({
      redirectUrl: "https://backend.composio.dev/s/a-link",
    });
  });

  test("an app with no auth config is a refusal naming an administrator's step", async () => {
    /*
     * The state is real rather than defensive: an app enabled before this deployment created
     * configs at all, or a config deleted by hand in Composio's dashboard. Creating one here
     * instead would mint it unnamed, at the vendor's managed defaults, at the moment somebody
     * pressed Connect — and nothing would be minted for the person to visit either way, so the
     * honest answer names the app and the step that fixes it.
     */
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: [] }) },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
    );

    const refused = broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl:
        "https://openbot.test/settings/connected-accounts/composio-linear",
    });

    const refusal = await failureOf(refused);
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).toMatch(/linear/);
    // THE REMEDY AND NOT THE APP'S NAME. All three of this method's refusals name the app, so
    // `/linear/` passes whichever branch was taken and the branch under test could be deleted
    // outright without reddening anything. What distinguishes this state is what fixes it.
    expect(refusal.message).toMatch(NO_CONFIG_REMEDY);
    expect(refusal.message).not.toMatch(DISABLED_REMEDY);
    expect(refusal.message).not.toMatch(NO_PAGE_REMEDY);
    // And nothing was begun at the vendor: a link against a config chosen by nobody would attach
    // this person's account to a configuration this deployment cannot see or tighten.
    expect(linked).toEqual([]);
  });
});

/**
 * Choosing WHICH auth config, which is a question this file used to answer with "the first one".
 *
 * An auth config lives in the project the API key belongs to, beside any an operator built by hand
 * in Composio's own dashboard, and the vendor's listing has no documented order. So "the first row"
 * is a coin toss between an object this deployment created and an object it knows nothing about —
 * and the two callers tossed it separately, so they could land on different rows. The name is the
 * only provenance Composio offers: {@link CONFIG_SUFFIX} is written into it at creation for exactly
 * this, and was then read by nobody.
 */
describe("telling this deployment's auth configs from anybody else's", () => {
  /**
   * What a listing of one app's configs looks like when an operator has been in the dashboard.
   *
   * SPELLED OUT OF THE ORDER THE ASSERTIONS EXPECT, which is what makes the sort the thing under
   * test rather than scenery. Composio documents no order for this listing; `configsMadeHere`
   * filters to ours and then sorts on the id, and every fixture this file used to hold was already
   * id-ordered — so the sort could be replaced with a plain copy and all 24 tests stayed green.
   * Here the spare arrives FIRST and sorts SECOND, so a filter alone answers `ac_ours_spare` where
   * every assertion below names `ac_ours`, and the delete's order is the sort's rather than the
   * vendor's.
   */
  const MIXED = [OURS_SPARE, BY_HAND, OURS];

  test("a connection is begun against the config this deployment made, not the first row", async () => {
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: MIXED }) },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
    );

    await broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl: "https://openbot.test/settings/connected-accounts/x",
    });

    // A connection is a lasting attachment to whatever config it was made against: scopes, tool
    // restrictions and a lifetime this deployment neither chose nor can read. Attaching somebody to
    // the hand-made one is not a mistake a later call can correct.
    expect(linked).toEqual([
      [
        "user_1",
        "ac_ours",
        { callbackUrl: "https://openbot.test/settings/connected-accounts/x" },
      ],
    ]);
  });

  test("an app whose only config was made by hand is refused rather than borrowed", async () => {
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [BY_HAND] }),
        },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
    );

    const refused = broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl: "https://openbot.test/settings/connected-accounts/x",
    });

    const refusal = await failureOf(refused);
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    // The same state as an app with no configs at all — none of OURS — so the same remedy, and
    // not the disabled one: the config that exists here is enabled, and enabling it again is
    // advice that would send an operator to a dashboard to change nothing.
    expect(refusal.message).toMatch(NO_CONFIG_REMEDY);
    expect(refusal.message).not.toMatch(DISABLED_REMEDY);
    expect(linked).toEqual([]);
  });

  test("removing an app drops every config of ours and leaves the hand-made one standing", async () => {
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          // Both of ours go — leaving one behind would leave live grants — and the hand-made
          // one stands. The listing arrives spare-first, so the order asserted below is the sort's
          // and not the vendor's.
          list: async () => ({ items: MIXED }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
          },
        },
      }),
    );

    await broker.deleteAuthConfig("linear");

    // `revoke_on_delete` on each, because the endpoint soft-deletes and revokes nothing without it
    // — and this is the one call that reaches an account whose local row drifted away.
    expect(deleted).toEqual([
      ["ac_ours", { revoke_on_delete: true }],
      ["ac_ours_spare", { revoke_on_delete: true }],
    ]);
  });

  test("a config left standing is a failure, and the count is the message", async () => {
    /*
     * THE TWIN OF THE PARTIAL REVOKE, WHICH HAD TWO TESTS WHILE THIS HAD NONE — so this throw
     * could be deleted with the whole suite green. The caller is `removeServer`, which deletes the
     * app's row once this returns: a config left standing is a live grant that the removal was
     * supposed to end, and nothing in this deployment can find it again afterwards.
     *
     * The count is asserted rather than the fact of a refusal, because the count is the whole
     * remedy: an operator who reads that one of two went knows that pressing remove again finishes
     * the job rather than repeats it.
     */
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: MIXED }),
          delete: async (id: string) => {
            if (id === "ac_ours_spare") {
              throw new Error("Composio refused that one.");
            }
          },
        },
      }),
    );

    const refusal = await failureOf(broker.deleteAuthConfig("linear"));
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).toMatch(
      /removed 1 of this deployment's 2 authorization configs for linear/,
    );
  });

  test("an app whose configs no longer carry this deployment's name is not a clean removal", async () => {
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          /*
           * THE CONFIG THIS DEPLOYMENT MADE, RENAMED IN COMPOSIO'S DASHBOARD. Same object, same
           * grants on it, same accounts connected against it; the one field that changed is the
           * only one this file writes and the only one it can recognise itself by.
           */
          list: async () => ({
            items: [{ id: "ac_ours", name: "Linear", status: "ENABLED" }],
          }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
          },
        },
      }),
    );

    /*
     * QUIET IS THE FAILURE HERE, AND IT IS THE ONE NOTHING REPORTS. `deleteAuthConfig` returning
     * normally lets `removeServer` delete the app's row, which is the last thing in this
     * deployment naming the app — so an administrator reads that the app was withdrawn while the
     * config and every grant made against it stand at Composio with nothing pointing at them.
     */
    const refusal = await failureOf(broker.deleteAuthConfig("linear"));
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal).not.toBeInstanceOf(AggregateError);
    expect(refusal.message).not.toMatch(A_CRASH);
    // The count of what is standing and the marker that would claim it, which together are the
    // whole remedy: an operator can look at one config and see which of the two readings it is.
    expect(refusal.message).toMatch(/Composio holds 1 for linear/);
    expect(refusal.message).toMatch(/\(OpenBot\)/);
    /*
     * AND NOTHING WAS DELETED, which is the half this refusal is not allowed to trade away. The
     * row carries no marker, so deleting it is as likely to destroy an operator's own dashboard
     * work — with every account on THAT — as it is to finish the removal.
     */
    expect(deleted).toEqual([]);
  });

  /**
   * AND THAT REFUSAL PROMISES THE REMOVAL WILL GO THROUGH, WHICH AN UNREADABLE ROW MAKES FALSE.
   *
   * `readableConfigs` sorts every row into one of two piles, so "configs that are legible and carry
   * nobody's suffix" and "rows this deployment could not read at all" are facts about the same
   * listing and arrive together as readily as either arrives alone. The refusal above fired first
   * and closed with "only taking it out of that dashboard leaves this app with nothing standing,
   * after which the removal goes through" — a promise the unreadable row makes untrue, since the
   * next press meets the refusal this method raises for exactly that pile. The operator is sent to
   * do one act and told it finishes the job, and the clause saying otherwise was suppressed by a
   * branch about different rows.
   */
  test("an unreadable row is still reported beside configs that carry nobody's name", async () => {
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: "ac_theirs", name: "Linear", status: "ENABLED" },
              { id: "ac_nameless", status: "ENABLED" },
            ],
          }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
          },
        },
      }),
    );

    const refusal = await failureOf(broker.deleteAuthConfig("linear"));
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    // The renamed-config reading, which is the one this refusal already carried.
    expect(refusal.message).toMatch(/Composio holds 1 for linear/);
    expect(refusal.message).toMatch(/\(OpenBot\)/);
    // And the row that was never sorted, whose remedy is the same dashboard and whose existence is
    // what stops the sentence promising a removal that would go through.
    expect(refusal.message).toMatch(/no id or no name/);
    // Nothing is deleted either way: the whole refusal is about not guessing which row is whose.
    expect(deleted).toEqual([]);
  });

  /**
   * A CONFIG ROW THE LISTING NAMED TWICE IS ONE CONFIG, NOT TWO — the twin of the account dedupe
   * that landed a wave earlier, one function away, and was not brought here.
   *
   * The paging loop guards against the vendor repeating a CURSOR and not against it repeating a
   * ROW: a page boundary crossed while a config is created, or a proxy stitching two overlapping
   * pages together, hands one id over twice with the cursor advancing perfectly each time. The
   * second delete of that config then meets Composio's "there is no such auth config", which
   * arrives as a refusal — so a removal that had in fact COMPLETED was counted as partial,
   * `removeServer` never deleted the app's row, and every retry met the same duplicate and failed
   * in the same place. An app in that state can never be removed.
   *
   * THE DOUBLE REFUSES THE SECOND DELETE OF ONE CONFIG, which is what the vendor does and what
   * makes this test able to fail. A stub that answered both identically would be green against an
   * adapter that sent the delete twice.
   */
  test("a config the listing named twice is removed once", async () => {
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async (query: unknown) =>
            (query as { cursor?: string }).cursor === undefined
              ? { items: [OURS], nextCursor: "page_2" }
              : { items: [OURS], nextCursor: null },
          delete: async (id: string) => {
            if (deleted.includes(id)) {
              throw new Error(
                `Composio holds no auth config with the id ${id}.`,
              );
            }
            deleted.push(id);
          },
        },
      }),
    );

    await broker.deleteAuthConfig("linear");

    expect(deleted).toEqual(["ac_ours"]);
  });

  /**
   * AND THE COUNT IN A REAL PARTIAL REMOVAL IS OF CONFIGS, NOT OF ROWS — the same pairing the
   * account dedupe has, for the same reason: an inflated denominator is a figure nothing measured,
   * in the one sentence an operator is meant to act on.
   */
  test("a duplicated row is not a third config in the sentence a partial removal carries", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [OURS, OURS, OURS_SPARE] }),
          delete: async (id: string) => {
            if (id === "ac_ours_spare") {
              throw new Error("Composio refused that one.");
            }
          },
        },
      }),
    );

    const refusal = await failureOf(broker.deleteAuthConfig("linear"));
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).toMatch(
      /removed 1 of this deployment's 2 authorization configs for linear/,
    );
  });

  /**
   * AND A REPEATED ROW WHOSE SECOND COPY IS UNREADABLE IS STILL ONE CONFIG, NOT A REFUSAL.
   *
   * CRITERION. Where the listing repeats an id already accepted and the repeat carries no readable
   * name, nothing is added to `unreadable`: the config is deleted and the removal completes.
   *
   * REASON. The id de-duplication ran BELOW the name guard, so a second sighting of an already-read
   * id was still pushed into `unreadable` if that copy's name could not be read — which contradicts
   * the invariant the function states for itself, ONE ID IS ONE CONFIG HOWEVER MANY TIMES THE
   * LISTING NAMED IT. The paged listing repeating `ac_ours` across a page boundary is the same race
   * the test above is written for, and the repeat can perfectly well arrive mid-rename in the
   * dashboard, or stitched by a proxy out of two partial reads, as `{ id, name: null }`.
   *
   * WHAT IT COST IS A REFUSAL AFTER THE WORK WAS DONE. `configs` held the one readable copy and
   * `unreadable.length` was 1, so this method deleted the config, succeeded, and THEN threw "…and
   * the app has not been fully withdrawn" — over a config that was already gone. `removeServer`
   * treats that as a failure, so the app's row stayed on the Plugins page behind a removal that had
   * completed, and every retry met the same repeat and failed in the same place.
   */
  test("a repeated row whose second copy has no readable name is still one config", async () => {
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async (query: unknown) =>
            (query as { cursor?: string }).cursor === undefined
              ? { items: [OURS], nextCursor: "page_2" }
              : // The same config, named again with a name this deployment cannot read.
                { items: [{ ...OURS, name: null }], nextCursor: null },
          delete: async (id: string) => {
            deleted.push(id);
          },
        },
      }),
    );

    // Completes rather than refusing, which is the assertion: the throw used to come AFTER the
    // delete below had already gone through.
    await broker.deleteAuthConfig("linear");

    expect(deleted).toEqual(["ac_ours"]);
  });

  /**
   * AND THE OTHER ORDERING ANSWERS THE SAME, WHICH IS WHAT MAKES IT ONE CONFIG RATHER THAN ONE ROW.
   *
   * CRITERION. Where the UNREADABLE copy of a repeated id arrives first and the readable copy
   * second, the config is still deleted and the removal still completes.
   *
   * REASON. The fix above dropped the repeat before the name was read, which closed
   * good-copy-first and opened its mirror: the id was claimed by whichever copy came first, so an
   * unreadable first copy took the slot, the readable second copy returned at the de-duplication
   * test, and the config never reached `configs` at all. `deleteAuthConfig` then left standing a
   * config the other ordering would have deleted — one listing, two answers, decided by which side
   * of a page boundary the vendor happened to put the good row on.
   *
   * NEITHER ORDERING IS MORE LIKELY THAN THE OTHER. A rename in flight in Composio's dashboard, or
   * a proxy stitching two partial reads, is as free to hand the half-written row over first as
   * second, so a function whose verdict depends on that is deciding on a coin toss.
   */
  test("a repeated row read second is still the config, however the listing ordered the copies", async () => {
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async (query: unknown) =>
            (query as { cursor?: string }).cursor === undefined
              ? // The same config, named first with a name this deployment cannot read.
                { items: [{ ...OURS, name: null }], nextCursor: "page_2" }
              : { items: [OURS], nextCursor: null },
          delete: async (id: string) => {
            deleted.push(id);
          },
        },
      }),
    );

    await broker.deleteAuthConfig("linear");

    expect(deleted).toEqual(["ac_ours"]);
  });

  /**
   * A ROW THAT COULD NOT BE READ MUST NOT BLOCK THE CONNECTION IT HAS NOTHING TO DO WITH.
   *
   * Reading the configs used to throw on the first row it could not check, so one unreadable row
   * refused every call that reads this listing — including this one, where a config of ours was
   * read, is ENABLED, and is the right thing to attach somebody to whatever else the listing held.
   * The person is told the vendor's shape is wrong about an app they can perfectly well connect.
   */
  test("an unreadable row does not stop a connection against the config that was readable", async () => {
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [{ id: "ac_nameless", status: "ENABLED" }, OURS],
          }),
        },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
    );

    await broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl: RETURN_URL,
    });

    expect(linked).toEqual([
      ["user_1", "ac_ours", { callbackUrl: RETURN_URL }],
    ]);
  });

  /**
   * AND WHERE THERE IS NOTHING OF OURS TO GO ON, THE REMEDY IS NOT THE ONE FOR AN APP WITH NO
   * CONFIG. "Remove the app and add it again" is a loop that cannot close in this state: the
   * removal meets its own refusal over the same unreadable row, and so does the enable. The
   * sentences are told apart by their remedies here for the reason {@link NO_CONFIG_REMEDY} exists.
   */
  test("a listing this deployment cannot read is not an app with no config", async () => {
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [{ id: "ac_nameless" }] }),
        },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
    );

    const refusal = await failureOf(
      broker.authorize({
        userId: "user_1",
        toolkit: "linear",
        returnUrl: RETURN_URL,
      }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    /*
     * THE THIRD SENTENCE IS ASSERTED AND NOT ONLY THE OTHER TWO'S ABSENCE. This named what the
     * refusal must not be — an app with no config, a config Composio calls disabled — and left
     * what it IS to any third sentence, including one prescribing an act nobody on that page can
     * perform. Its twin one method over (`connectWithFields`, in "a listing this deployment cannot
     * read is not an app that publishes nothing") already asserts its own remedy, so the pair now
     * reads the one condition the one way.
     */
    expectOnlyRefusal(refusal.message, "unreadableNobodySent");
    expect(refusal.message).toMatch(
      /upgrading this deployment's @composio\/core/,
    );
    // And nobody was sent anywhere: a link is a lasting attachment to one config, so it is never
    // minted off a listing this deployment could not read.
    expect(linked).toEqual([]);
  });

  /**
   * AND NOTHING IS CREATED BESIDE A ROW THAT MIGHT ALREADY BE OURS, which is the one caller of the
   * four that must refuse rather than act on what it can name. A second config is not a duplicate
   * but a SPLIT: two populations of connections for one app, and a removal later that drops half.
   */
  test("a row this deployment cannot read stops a second config being created", async () => {
    const created: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [{ id: "ac_nameless" }] }),
          create: async (...call: unknown[]) => {
            created.push(call);
            return CREATED;
          },
        },
      }),
    );

    const refusal = await failureOf(
      broker.ensureAuthConfig({
        toolkit: "linear",
        name: "Linear",
        connection: { kind: "consent" },
      }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(created).toEqual([]);
  });

  test("an app Composio holds no configs for at all is still a quiet removal", async () => {
    /*
     * THE HALF THE REFUSAL ABOVE MUST NOT SWALLOW. Removing an app has to be able to happen twice:
     * an app can be removed, re-enabled and removed again, two administrators can press the button
     * together, and an app enabled before this deployment created configs at all has none to drop.
     * In each of those the end state is the one that was asked for, so a throw would report a
     * failure to somebody who got exactly what they wanted — and an implementation that reached
     * green above by refusing whenever it deleted nothing would do precisely that.
     *
     * AND IT SAYS SO RATHER THAN LEAVING IT TO BE INFERRED, which it did not: this test held no
     * assertion at all. What it actually pinned was "the call did not throw", which a reader has to
     * reconstruct from the absence of an `expect` — and the other half, that nothing was deleted,
     * rested on {@link fakeVendor}'s stub refusing, where a call that WAS made and a call that was
     * not both end the test the same way round. Both halves are stated here.
     */
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [] }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
          },
        },
      }),
    );

    await expect(broker.deleteAuthConfig("linear")).resolves.toBeUndefined();
    expect(deleted).toEqual([]);
  });

  test("a disabled config of ours stops a second one being created", async () => {
    const created: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          // Disabled configs are asked for, because this listing is what decides whether to create.
          // A listing that omitted them would find nothing and create the split it exists to stop.
          list: async () => ({
            items: [
              { id: "ac_ours", name: "Linear (OpenBot)", status: "DISABLED" },
            ],
          }),
          create: async (...call: unknown[]) => {
            created.push(call);
          },
        },
      }),
    );

    await broker.ensureAuthConfig({
      toolkit: "linear",
      name: "Linear",
      connection: { kind: "consent" },
    });

    expect(created).toEqual([]);
  });

  test("a disabled config is a refusal rather than a link that cannot work", async () => {
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: "ac_ours", name: "Linear (OpenBot)", status: "DISABLED" },
            ],
          }),
        },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
    );

    const refused = broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl: "https://openbot.test/settings/connected-accounts/x",
    });

    // Sending somebody to consent against a disabled config spends their consent and attaches
    // nothing, and nothing on the page they are on can fix it. The act that DOES fix it is an
    // operator's in Composio's own dashboard, which is the one thing the no-config sentence next
    // door never says — so that is what this asserts.
    const refusal = await failureOf(refused);
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).toMatch(DISABLED_REMEDY);
    expect(refusal.message).not.toMatch(NO_CONFIG_REMEDY);
    expect(linked).toEqual([]);
  });

  /**
   * AND HOLDING A DISABLED CONFIG BESIDE AN UNSETTLED ONE IS NOT A REASON TO BE TOLD ABOUT ONE.
   *
   * More than one config of ours is an ordinary outcome of a lost enable race, which this file says
   * for itself — so the two states the `ENABLED` test falls through into can and do arrive on one
   * listing. They were chained: the unsettled rows were reported and the disabled ones were not,
   * which leaves a reader with the one remedy nobody on that page can act on ("upgrade
   * `@composio/core`") while the act that WOULD have got them connected — enabling the disabled
   * config in Composio's dashboard — was withheld by the presence of a row it says nothing about.
   * The same chain, and the same suppression, that `revoke`'s clause list was corrected for.
   */
  test("a disabled config beside an unsettled one is told both remedies", async () => {
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: "ac_a", name: "Linear (OpenBot)", status: "DISABLED" },
              { id: "ac_b", name: "Linear (OpenBot)", status: "PENDING" },
            ],
          }),
        },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
      () => 1_000_000,
    );

    const refusal = await failureOf(
      broker.authorize({
        userId: "user_1",
        toolkit: "linear",
        returnUrl: RETURN_URL,
      }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    // The row whose state Composio would not name, whose only remedy is a package upgrade.
    expect(refusal.message).toMatch(/neither ENABLED nor DISABLED/);
    // And the one an administrator can act on today, which the chain was withholding.
    expect(refusal.message).toMatch(DISABLED_REMEDY);
    // Still a refusal either way: consent spent against a config that is not enabled attaches
    // nothing and cannot be spent again without sending the person round a second time.
    expect(linked).toEqual([]);
  });

  test("an app with only somebody else's config still gets one of our own", async () => {
    const created: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [BY_HAND] }),
          create: async (...call: unknown[]) => {
            created.push(call);
            return CREATED;
          },
        },
      }),
    );

    await broker.ensureAuthConfig({
      toolkit: "linear",
      name: "Linear",
      connection: { kind: "consent" },
    });

    // Adopting the hand-made one would have this deployment mint connections against scopes it
    // cannot see and delete an operator's work when the app is removed.
    expect(created).toEqual([
      [
        "linear",
        { type: "use_composio_managed_auth", name: "Linear (OpenBot)" },
      ],
    ]);
  });
});

/**
 * WHAT ENABLING AN APP ACTUALLY CREATES, WHICH IS A DIFFERENT ANSWER FOR EACH KIND OF APP.
 *
 * Every config this deployment ever made was `use_composio_managed_auth`, which is the right answer
 * for exactly one of the five kinds. The other four were wrong in four different ways, and only one
 * of them announced itself: Composio answers 404 for an app that has no managed OAuth client of its
 * own, so Linear's MCP app was unconnectable. The rest were quiet — a no-auth app whose creation
 * the vendor refuses outright, a key app whose people were sent to a consent screen with nothing to
 * ask them, and an app this deployment cannot drive at all, enabled anyway.
 *
 * THE ASSERTIONS ARE ON WHAT WENT OUT, AND ON WHAT DID NOT. Two of these four are about a call that
 * must not be made at all, which no assertion on a return value can see: {@link fakeVendor}'s
 * refusals name the unasked-for call, and the counters here say which door was not opened.
 */
describe("the config each kind of app is enabled with", () => {
  test("a self-registering app gets a custom config with no credentials in it", async () => {
    const created: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [] }),
          create: async (...call: unknown[]) => {
            created.push(call);
            return CREATED;
          },
        },
      }),
    );

    await broker.ensureAuthConfig({
      toolkit: "linear_mcp",
      name: "Linear MCP",
      connection: { kind: "self-registering" },
    });

    /*
     * `DCR_OAUTH` AND NO CREDENTIALS, which is the whole of what such an app needs: the vendor
     * registers a client of its own against the provider at connect time. The managed type is what
     * this used to send and it is the one answer that cannot work here — Composio has no OAuth
     * client of its own for these apps, so the managed path answers 404 and nobody connects.
     */
    expect(created).toEqual([
      [
        "linear_mcp",
        {
          type: "use_custom_auth",
          authScheme: "DCR_OAUTH",
          name: "Linear MCP (OpenBot)",
          credentials: {},
        },
      ],
    ]);
  });

  test("a key app gets a custom config carrying no secret, because the secret is per person", async () => {
    const created: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [] }),
          create: async (...call: unknown[]) => {
            created.push(call);
            return CREATED;
          },
        },
      }),
    );

    await broker.ensureAuthConfig({
      toolkit: "perplexityai",
      name: "Perplexity",
      connection: { kind: "fields", authScheme: "API_KEY" },
    });

    /*
     * NO KEY ON THE CONFIG, AND THAT IS NOT AN OMISSION TO BE FIXED LATER. The config is
     * per-deployment and the key is one person's; it belongs to each connection made against this
     * config, which is where the connect form sends it. A key here would be one person's secret
     * shared by everybody the app is enabled for.
     */
    expect(created).toEqual([
      [
        "perplexityai",
        {
          type: "use_custom_auth",
          authScheme: "API_KEY",
          name: "Perplexity (OpenBot)",
          credentials: {},
        },
      ],
    ]);
  });

  test("a no-auth app gets no config at all, because Composio refuses one", async () => {
    let listed = false;
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => {
            listed = true;
            return { items: [] };
          },
        },
      }),
    );

    await broker.ensureAuthConfig({
      toolkit: "hackernews",
      name: "Hacker News",
      connection: { kind: "no-auth" },
    });

    /*
     * NOT EVEN THE LISTING, which is the half that is easy to leave in. Composio's own refusal is
     * "Cannot create an auth config for toolkit hackernews because it does not require
     * authentication. You can use its tools directly without creating a connected account." — so
     * there is nothing to find and nothing to create, and a read made anyway is a round trip whose
     * answer no branch below could use. `create` is left at {@link fakeVendor}'s refusal, which
     * names itself if it is ever reached.
     */
    expect(listed).toBe(false);
  });

  test("an unsupported app is refused before anything is created", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [] }),
        },
      }),
    );

    const refusal = await failureOf(
      broker.ensureAuthConfig({
        toolkit: "docusign",
        name: "DocuSign",
        connection: {
          kind: "unsupported",
          reason: "needs its own OAuth client",
        },
      }),
    );

    /*
     * THE DERIVATION'S OWN SENTENCE, carried rather than restated. It is the one the picker filters
     * on and the one an administrator has already read beside the app; a second sentence invented
     * here would be a second account of why the app cannot be driven, and the two would drift.
     */
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).toMatch(/needs its own OAuth client/);
    expect(refusal.message).toMatch(/docusign/);
    expect(refusal.message).not.toMatch(A_CRASH);
  });
});

/**
 * Ending somebody's access, which is the claim this whole surface is here to be able to make.
 *
 * THE DELETE DOES NOT REVOKE, and that is the vendor's own description of it: it "soft-deletes a
 * connected account by marking it as deleted in the database", preserving the record, unless
 * `revoke_on_delete` is passed. Every path that says it ended somebody's access — a person
 * disconnecting, an app being removed, a person being offboarded — runs through this method and
 * wrote `true` into the audit trail while the refresh token at Google was untouched. The assertions
 * here are therefore on WHAT WENT OUT rather than on what came back: an implementation that dropped
 * the flag answers every one of them identically.
 */
describe("withdrawing one person's grants", () => {
  test("the delete asks for the upstream credentials to be revoked", async () => {
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({ items: [{ id: "ca_1" }] }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
            return WITHDRAWN;
          },
        },
      }),
    );

    expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
      true,
    );
    expect(deleted).toEqual([["ca_1", { revoke_on_delete: true }]]);
  });

  test("a delete Composio answered `success: false` is not a withdrawal", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({ items: [{ id: "ca_1" }] }),
          // A 200 whose body says the account was not deleted. The flag went out, Composio read
          // the request and answered it — this is the vendor declining, not failing.
          delete: async () => ({ success: false }),
        },
      }),
    );

    /*
     * WITHOUT THE CHECK THIS ANSWERS `true`, WHICH IS THE WHOLE FINDING. `store.ts` writes that
     * boolean into `mcp.account_disconnected` as `vendorRevocationRequested` and then deletes the
     * `composio_connections` row — the only thing in this deployment naming which app this person
     * connected. So a `success: false` nobody read ends as a trail entry claiming a grant was
     * withdrawn, an account that is still live at Google, and nothing left pointing at it.
     *
     * ASSERTED AS A REFUSAL AND AS A COUNT, because "did not answer true" is satisfied by a crash.
     */
    const refusal = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).toMatch(
      /withdrew 0 of this person's 1 accounts for gmail/,
    );
    expect(refusal.message).not.toMatch(A_CRASH);
    // The reason lives on `cause`, because the count is deliberately the whole of the sentence.
    expect(everythingSaidBy(refusal).join(" ")).toMatch(/success: false/);
  });

  test("a delete whose verdict Composio did not send is not counted as one either", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({ items: [{ id: "ca_1" }] }),
          /*
           * `success` IS REQUIRED IN THE DECLARATION AND ABSENT ON THIS WIRE, which is the shape
           * the check has to survive rather than the one it is for. `@composio/client` parses the
           * body and hands it over, so the schema's "required" is a promise about what Composio
           * means to send and not a fact about what arrived.
           */
          delete: async () => ({}),
        },
      }),
    );

    const refusal = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);

    /*
     * A DIFFERENT SENTENCE FROM THE ONE NEXT DOOR, and that is what this asserts. "Composio said
     * no" is a fact about this account that a second press can meet again; "Composio answered
     * something this deployment cannot read" is a fact about the package, correctable by nobody
     * holding an admin page. Collapsing them would send an operator to press a button for a
     * condition a button cannot change.
     */
    const said = everythingSaidBy(refusal).join(" ");
    expect(said).toMatch(/upgrading this deployment's @composio\/core/);
    expect(said).not.toMatch(/success: false/);
  });

  /**
   * AND NO DOCUMENT AT ALL IS NOT A DOCUMENT WITH ITS VERDICT MISSING.
   *
   * The delete comes off `@composio/client`, which parses the body and hands it over — the
   * declaration on {@link ComposioVendor} says so, and the test above rests on it for `{}`. So an
   * answer that is a bare string reaches this read as readily as the empty document does, and
   * `("deleted").success` is `undefined`, not a throw: the refusal said "Composio sent nothing where
   * its verdict belongs, and that field is the only thing in the reply", which asserts a reply with
   * one field missing about an answer that was not a reply. The shape is the finding.
   */
  test("a withdrawal answered with something that is not a document names the answer, not a missing verdict", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({ items: [{ id: "ca_1" }] }),
          delete: async () => "deleted",
        },
      }),
    );

    const refusal = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    const said = everythingSaidBy(refusal).join(" ");
    expect(said).toMatch(/sent a string where its reply to the withdrawal/);
    expect(said).not.toMatch(/where its verdict/);
    expect(said).toMatch(/upgrading this deployment's @composio\/core/);
  });

  test("the listing asks about every state a grant can be hiding in", async () => {
    const asked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async (query: unknown) => {
            asked.push(query);
            return { items: [] };
          },
        },
      }),
    );

    expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
      false,
    );

    /*
     * `accountType` because its default is private accounts only, so a shared account is invisible
     * to a listing that omits it — and an invisible account is a live grant this answers `false`
     * about. The statuses because an unfinished consent or a lapsed token is still something a
     * provider is holding. `REVOKED` is the one left out: it is the only status that says the grant
     * is already gone, and deleting a tombstone would have this report a withdrawal that never was.
     *
     * AND `authConfigIds`, WHICH THIS ASSERTION USED TO SAY WAS ABSENT. It was written out as the
     * whole query on the reasoning that the breadth is the point — and it is, for three of the four
     * parameters. The fourth is the opposite: omitting it asks about every authorization config in
     * the project, including ones an operator built by hand in Composio's dashboard, and this
     * listing is the one that decides what gets deleted with `revoke_on_delete`. The assertion was
     * therefore pinning the defect in place, which is why it moved rather than being relaxed.
     */
    expect(asked).toEqual([
      {
        userIds: ["user_1"],
        toolkitSlugs: ["gmail"],
        statuses: [
          "INITIALIZING",
          "INITIATED",
          "ACTIVE",
          "FAILED",
          "EXPIRED",
          "INACTIVE",
        ],
        accountType: "ALL",
        authConfigIds: [OUR_GMAIL.id],
        limit: WHOLE_LISTING,
      },
    ]);
  });

  test("being connected is a narrower question, and asked as one", async () => {
    const asked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        connectedAccounts: {
          list: async (query: unknown) => {
            asked.push(query);
            return { items: [{ id: "ca_1" }] };
          },
        },
      }),
    );

    expect(
      await broker.isConnected({ userId: "user_1", toolkit: "gmail" }),
    ).toBe(true);

    // ACTIVE only — an unfinished or expired account must not tell somebody their app is wired up —
    // but `accountType: "ALL"` all the same, because a shared account is a connected account.
    expect(asked).toEqual([
      {
        userIds: ["user_1"],
        toolkitSlugs: ["gmail"],
        statuses: ["ACTIVE"],
        accountType: "ALL",
        limit: WHOLE_LISTING,
      },
    ]);
  });

  test("nobody with no account for the app is answered no", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        connectedAccounts: { list: async () => ({ items: [] }) },
      }),
      () => 1_000_000,
    );

    /*
     * THE ONLY TEST IN THIS FILE THAT CAN FAIL A GATE THAT ALWAYS OPENS. Both assertions about
     * `isConnected` expected `true`, so `async isConnected() { return true }` was green — and a
     * gate that cannot answer no is a gate that lets every call through, which is exactly the
     * question `./access` asks this method before running somebody's action.
     */
    expect(
      await broker.isConnected({ userId: "user_1", toolkit: "gmail" }),
    ).toBe(false);
  });

  /**
   * AND THE STATUS FILTER IS A MODULE'S OWN ARRAY, WHICH IS NOT SOMETHING TO HAND ACROSS A SEAM.
   *
   * `CONNECTED` and `REVOCABLE` are written once at the top of the adapter and were passed straight
   * into the vendor's listing body, so the array the vendor was handed WAS the constant. A vendor
   * that sorted, normalised or appended to what it was given would not corrupt one call: it would
   * corrupt the constant, for the life of the process, and the next question asked with it would be
   * filtered by something nobody wrote down. It is the same sharing the catalogue's copy exists to
   * end, one seam over and with no ten-minute expiry to bound it — `isConnected` is the gate
   * `./access` asks before running somebody's action, and `REVOCABLE` decides what a disconnect can
   * even see.
   */
  test("the statuses a listing is filtered by are not the adapter's own array", async () => {
    const asked: string[][] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        connectedAccounts: {
          list: async (query: unknown) => {
            const statuses = (query as { statuses: string[] }).statuses;
            asked.push([...statuses]);
            // All it takes is a recipient that tidies up what it was handed.
            statuses.push("DELETED");
            return { items: [] };
          },
        },
      }),
      () => 1_000_000,
    );

    await broker.isConnected({ userId: "user_1", toolkit: "gmail" });
    await broker.isConnected({ userId: "user_1", toolkit: "gmail" });

    expect(asked).toEqual([["ACTIVE"], ["ACTIVE"]]);
  });

  test("a refusal partway through still asks about the accounts behind it", async () => {
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({
            items: [{ id: "ca_1" }, { id: "ca_2" }, { id: "ca_3" }],
          }),
          delete: async (id: string) => {
            if (id === "ca_2") throw new Error("Composio refused that one.");
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
    );

    const refused = broker.revoke({ userId: "user_1", toolkit: "gmail" });

    // The third account is the whole point: a throw at the second used to abandon it, so a grant
    // nobody ever asked about outlived a call that reported only the failure of a different one.
    await expect(refused).rejects.toThrow(/2 of this person's 3 accounts/);
    expect(deleted).toEqual(["ca_1", "ca_3"]);
  });

  test("a partial withdrawal is a failure rather than a reported disconnection", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({ items: [{ id: "ca_1" }, { id: "ca_2" }] }),
          delete: async (id: string) => {
            if (id === "ca_2") throw new Error("Composio refused that one.");
            return WITHDRAWN;
          },
        },
      }),
    );

    /*
     * NOT A `true`. `store.ts` revokes and only then deletes the `composio_connections` row, which
     * is the only thing naming which app this person connected; a `true` here deletes that row, the
     * trail records a disconnection, and the account this call could not end is left live with
     * nothing pointing at it. The throw leaves the row standing, so pressing disconnect again is a
     * second attempt with everything the first one had.
     */
    await expect(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    ).rejects.toBeInstanceOf(BrokerRefusalError);
  });

  /**
   * AN ACCOUNT THIS DEPLOYMENT CANNOT NAME MUST NOT STOP IT WITHDRAWING THE ONES IT CAN.
   *
   * The id check used to run over every row BEFORE any delete went out, so one row whose id
   * Composio omitted threw ahead of the first withdrawal — and the next attempt met the same row
   * and threw in the same place. A person with three grants and one unreadable row could never
   * withdraw any of them, for ever, and the page told them to try again.
   *
   * THE TWO FAILURES THIS SITS BETWEEN ARE BOTH WORSE, which is why the answer is neither of them. A
   * delete sent with `undefined` where an id belongs is a request Composio may read as anything,
   * followed by a `true` and an audit row saying this person's access ended. Refusing before
   * anything goes out is a permanent block over a row nobody can remove from here. What a person is
   * owed is the withdrawal of every grant this deployment CAN name, and a sentence counting what
   * was left — which is a state they can act on, by removing the rest in Composio's own dashboard.
   */
  test("an account with no id does not stop the accounts beside it being withdrawn", async () => {
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({
            items: [{ id: "ca_1" }, { id: null }, { id: "ca_3" }],
          }),
          delete: async (id: string) => {
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    // Both readable grants gone, and no delete sent for the row that had no id: a withdrawal of
    // `undefined` is the request this whole guard exists to stop being made.
    expect(deleted).toEqual(["ca_1", "ca_3"]);
    // STILL A FAILURE, because `store.ts` deletes the `composio_connections` row on a `true` and
    // that row is the only thing in this deployment naming which app this person connected.
    expect(failure).toBeInstanceOf(BrokerRefusalError);
    expect(failure.message).toMatch(/2 of this person's 3 accounts/);
    /*
     * And the reason the third could not be asked about is named, because "try again" is not the
     * remedy for it and the reader would otherwise be given a count with no way to read it.
     *
     * THE ROW AND THE LISTING RATHER THAN THE WORD. This asked `/id/` of `cause`, and `/id/` is
     * inside "invalid", "considered", "provided" and "identifier" — so it asserted almost nothing
     * about which reading produced the cause, and would not have noticed this sentence being
     * rewritten in the neighbouring listing's words. `withdrawableAccounts` and `readableConfigs`
     * raise the same fault over two different listings one function apart.
     */
    expectOnlyRefusal(
      everythingSaidBy(failure).join("\n"),
      "accountId",
      "row 2 of its gmail accounts for this person",
    );
  });

  /**
   * AND A CONFIG ROW THIS DEPLOYMENT CANNOT READ MUST NOT STOP IT EITHER — the same correction as
   * the account above, one listing earlier, where it was still live after that one landed.
   *
   * Reading the configs threw on the first row it could not check, and the withdrawal reads them
   * BEFORE it reads a single account. So one unreadable config row meant a person could never
   * withdraw anything for that app: every press met the same row and the same throw, ahead of the
   * first delete, with their readable grants standing the whole time. What they are owed is the
   * withdrawal of every grant this deployment can reach and a sentence about what it could not.
   */
  test("a config row that could not be read does not stop the grants behind the one that could", async () => {
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [{ id: "ac_gmail_nameless" }, OUR_GMAIL],
          }),
        },
        connectedAccounts: {
          list: async () => ({ items: [{ id: "ca_1" }] }),
          delete: async (id: string) => {
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    // The grant on the config that WAS readable is gone, which is the half a throw ahead of the
    // loop threw away.
    expect(deleted).toEqual(["ca_1"]);
    // And still a failure, because a grant of theirs may sit on the config that could not be read
    // and nothing here ever asked about it — so `store.ts` must not delete the row that names this
    // person's connection.
    expect(failure).toBeInstanceOf(BrokerRefusalError);
    expect(failure.message).not.toMatch(A_CRASH);
    expect(failure.message).toMatch(/withdrew 1 of this person's 1 accounts/);
    expect(failure.message).toMatch(/authorization configs for gmail/);
    /*
     * And the reason that row could not be sorted travels as `cause`, because the sentence above is
     * deliberately a count and leaves the reasons nowhere else to live.
     *
     * ASKED AS THE NAME GUARD'S OWN CLAUSE AND NOT AS THE WORD "name". `readableConfigs` has two
     * row guards and the id guard's sentence carries the word too — "the id is the whole of what a
     * deletion NAMES" — so `/name/` matched either of them, and the two guards reading each
     * other's field left this test green. Measured, not supposed.
     */
    expectOnlyRefusal(
      everythingSaidBy(failure).join("\n"),
      "configName",
      "row 1 of Composio's authorization configs for gmail",
    );
  });

  /**
   * AND A LISTING WHOSE ONLY FINDING IS AN UNREADABLE CONFIG ROW IS ITS OWN STATE, WHICH IS THE
   * BRANCH EVERY SIBLING OF THIS METHOD HAS AND THIS ONE DID NOT.
   *
   * With a config of ours that IS readable and no account on it, the partial-withdrawal throw at
   * the end of this method was what answered: "Composio withdrew 0 of this person's 0 accounts for
   * gmail." Both figures are counts of a set nothing measured, in the one sentence a reader is
   * meant to act on, and "withdrew" asserts that some withdrawal happened. Nothing was withdrawn
   * and nothing was there to withdraw. {@link ComposioBroker.deleteAuthConfig} was corrected for
   * the identical sentence about configs — "removed 0 of this deployment's 0" — and this is the
   * same count one listing further in.
   *
   * STILL A REFUSAL, which is the half that does not move: a grant of this person's may sit on the
   * config behind the row nothing could sort, so `store.ts` must not delete the row that names
   * their connection.
   */
  test("a person with no account and one unsortable config row is told that, not a count of nothing", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [{ id: "ac_gmail_nameless" }, OUR_GMAIL],
          }),
        },
        connectedAccounts: { list: async () => ({ items: [] }) },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    expect(failure).toBeInstanceOf(BrokerRefusalError);
    expect(failure.message).not.toMatch(A_CRASH);
    // No count of a set nothing measured, in either position.
    expect(failure.message).not.toMatch(/withdrew \d+ of this person's \d+/);
    // And the reason the question could not be settled travels, as it does on every sibling branch.
    expectOnlyRefusal(
      everythingSaidBy(failure).join("\n"),
      "unreadableNoAccountWithdrawn",
      undefined,
      ["configName"],
    );
  });

  /**
   * THE GATE IS A COUNT AND WAS ASKING FOR AN ID IT NEVER USES.
   *
   * `isConnected` answers whether this person holds an ACTIVE account for an app, which is a
   * question about how many rows came back — the id is the revoke's business and nothing this
   * question reads. Taking the ids anyway meant an account Composio described without one turned a
   * true answer into a thrown refusal: the person IS connected, and the gate that refuses their run
   * says so on the strength of a field it was never going to look at.
   */
  test("an account the vendor described without an id still counts as connected", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        connectedAccounts: { list: async () => ({ items: [{}] }) },
      }),
      () => 1_000_000,
    );

    expect(
      await broker.isConnected({ userId: "user_1", toolkit: "gmail" }),
    ).toBe(true);
  });

  /**
   * AN OPERATOR'S OWN AUTHORIZATION CONFIG IS NOT THIS DEPLOYMENT'S TO EMPTY.
   *
   * The account listing was asked by person, by app and by "all account types" and by nothing else,
   * so it returned every account Composio holds for that pair — including ones attached to a config
   * an operator built by hand in their dashboard, for purposes this deployment knows nothing about,
   * and including the SHARED ones other people are acting through. Each of those was then deleted
   * with `revoke_on_delete`, which tears the grant up at the provider. One person pressing
   * disconnect on their own settings page ended somebody else's integration, silently, and answered
   * `true`.
   *
   * WHICH IS THE PRINCIPLE `deleteAuthConfig` ALREADY STATES ONE LEVEL UP: it refuses to delete a
   * config it cannot show is this deployment's, on exactly the reasoning that an operator's
   * dashboard work is not ours to destroy. The accounts hanging off that config are the same work.
   *
   * ASSERTED ON WHAT WENT OUT, because an implementation that asked the unscoped question and then
   * deleted everything it found answers this test's `true` just as confidently.
   */
  test("the withdrawal asks only about accounts on configs this deployment made", async () => {
    const scoped: unknown[] = [];
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          // An operator's beside ours, which is the state the whole guard is about. Out of the
          // vendor's order, so a reader that took the first row would take the wrong one.
          list: async () => ({ items: [BY_HAND_GMAIL, OUR_GMAIL] }),
        },
        connectedAccounts: {
          list: async (query: unknown) => {
            scoped.push((query as { authConfigIds?: unknown }).authConfigIds);
            return { items: [{ id: "ca_1" }] };
          },
          delete: async (id: string) => {
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
    );

    expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
      true,
    );

    // The operator's config is not in the question, so no account on it can be in the answer and
    // none of them can reach the delete.
    expect(scoped).toEqual([[OUR_GMAIL.id]]);
    expect(deleted).toEqual(["ca_1"]);
  });

  /**
   * NOTHING AT ALL IS NOTHING TO WITHDRAW, AND IT IS ANSWERED WITHOUT ASKING.
   *
   * `authorize` mints every connect link against a config this deployment made and refuses where
   * there is none, so an app Composio holds no configs for never had a connection begun through it.
   * Listing accounts anyway could only turn up somebody else's, and the one thing this call does
   * with an account it turns up is delete it.
   *
   * THE ASSERTION IS THE DOUBLE. `connectedAccounts.list` is left at {@link fakeVendor}'s refusal,
   * so an implementation that asked the question at all fails here by name — which is a stronger
   * statement than the `false` beside it, because a listing scoped to an EMPTY set of configs would
   * answer `false` too while putting a filter on the wire that the far side is free to read as no
   * filter at all.
   */
  test("a person's accounts are not listed where Composio holds no config for the app", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({ authConfigs: { list: async () => ({ items: [] }) } }),
    );

    expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
      false,
    );
  });

  /**
   * AND "NONE OF OURS" IS NOT THAT STATE — THE SEVENTH ROUTE TO A REVOCATION THAT DID NOT REVOKE.
   *
   * THIS TEST ASSERTED THE `false`, AND THE `false` WAS THE DEFECT. It stood on the reasoning above
   * — none of ours means nothing was ever granted through this app — which is sound about an app
   * Composio holds no configs for and cannot tell that app from this one. An operator renames a
   * config in Composio's dashboard, dropping the suffix or editing the app's title past it, and
   * this deployment's own live grants read as somebody else's work: `store.ts` then writes
   * `vendorRevocationRequested: false` into the audit trail and deletes the `composio_connections`
   * row, so the person's grant stands at the provider with nothing naming it and the trail records
   * that no withdrawal was even asked for. The assertion is changed on purpose, and the case it
   * used to cover — Composio holding nothing at all — is asserted next door, where it is true.
   *
   * `deleteAuthConfig` HAS REFUSED IN EXACTLY THIS STATE SINCE THE WAVE BEFORE THIS ONE, which is
   * what makes this a disagreement rather than a judgement call: two halves of removing an app's
   * access read one condition two different ways, one function apart.
   *
   * THE DOUBLE IS STILL THE OTHER HALF OF THE ASSERTION. `connectedAccounts.list` is left refusing,
   * so an implementation that answered this by listing somebody else's accounts — and then deleting
   * what it found — fails here by name.
   */
  test("an app whose configs no longer carry this deployment's name is not a quiet disconnection", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: [BY_HAND_GMAIL] }) },
      }),
    );

    const refusal = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    // The count standing and the marker that would have claimed it, which is the same pair
    // `deleteAuthConfig` hands an operator for the same state and the same one act in a dashboard.
    expect(refusal.message).toMatch(/Composio holds 1 for gmail/);
    expect(refusal.message).toMatch(/\(OpenBot\)/);
  });

  /**
   * A WITHDRAWAL THAT HAPPENED, REPORTED AS A FAILURE — the guard for `success: false` overreaching.
   *
   * The installed client resolves two answers with no document at all: a 204 becomes `null`
   * ("fetch refuses to read the body when the status code is 204") and a JSON reply carrying
   * `content-length: 0` becomes `undefined` (`@composio/client` 0.1.0-alpha.76,
   * `src/internal/parse.ts:16-42`). Neither can be a rejection the vendor made: every `!response.ok`
   * is thrown as an `APIError` before parsing (`src/client.ts:539`), so an answer arriving at all is
   * Composio having accepted the request and deleted the account.
   *
   * READING THAT AS "NO VERDICT" TURNED A COMPLETED WITHDRAWAL INTO A PARTIAL-WITHDRAWAL REFUSAL,
   * which leaves the person's connection row standing, tells them their access has not ended, and
   * has them press disconnect again — against an account that is already gone, which is a second
   * fault waiting on the first. It is the same lie as the unread `success: false` before it, facing
   * the other way.
   *
   * THE OTHER DIRECTION IS ASSERTED NEXT DOOR AND IS NOT WEAKENED BY THIS: `{}` is a document that
   * arrived without its verdict, which is a fact about the package, and it still refuses.
   */
  for (const { shape, answer } of [
    { shape: "a 204 carrying no content", answer: null },
    { shape: "a JSON reply of content-length zero", answer: undefined },
  ]) {
    test(`a withdrawal Composio answered with ${shape} is a withdrawal`, async () => {
      const deleted: string[] = [];
      const { broker } = buildComposioClient(
        fakeVendor({
          authConfigs: { list: ourGmailConfig },
          connectedAccounts: {
            list: async () => ({ items: [{ id: "ca_1" }] }),
            delete: async (id: string) => {
              deleted.push(id);
              return answer;
            },
          },
        }),
      );

      expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
        true,
      );
      // And the flag still went out, so the `true` is about a delete that asked for the grant to be
      // revoked rather than about one that quietly filed the account away.
      expect(deleted).toEqual(["ca_1"]);
    });
  }

  /**
   * A ROW THE LISTING NAMED TWICE IS ONE ACCOUNT, NOT TWO.
   *
   * The paging loop guards against the vendor repeating a CURSOR and not against it repeating a
   * ROW, and those are different faults: a page boundary crossed while accounts are being created
   * or deleted, or a proxy stitching two overlapping pages together, hands the same id over twice
   * with a cursor that advanced perfectly each time. The second delete then meets Composio's "there
   * is no such account" — which arrives as a refusal — so a withdrawal that in fact COMPLETED was
   * thrown over as a partial one, the person's connection row was left standing, and every retry
   * met the same duplicate and failed in the same place.
   *
   * THE DOUBLE REFUSES THE SECOND DELETE OF ONE ACCOUNT, which is what the vendor does and what
   * makes this test able to fail. A stub that answered both identically would be green against an
   * adapter that sent the delete twice.
   */
  test("an account the listing named twice is withdrawn once", async () => {
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async (query: unknown) =>
            (query as { cursor?: string }).cursor === undefined
              ? { items: [{ id: "ca_1" }], nextCursor: "page_2" }
              : { items: [{ id: "ca_1" }], nextCursor: null },
          delete: async (id: string) => {
            if (deleted.includes(id)) {
              throw new Error(
                `Composio holds no connected account with the id ${id}.`,
              );
            }
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
    );

    expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
      true,
    );
    expect(deleted).toEqual(["ca_1"]);
  });

  /**
   * AND THE COUNT IN A REAL PARTIAL FAILURE IS OF ACCOUNTS, NOT OF ROWS.
   *
   * The denominator was `accounts.length`, which is how many rows the listing handed over — so a
   * listing that named one account twice made the sentence a reader is meant to act on state a
   * figure nothing had counted. "One of three" over two accounts is the same class of mistake as
   * the page-ceiling sentence that asserted a row count it had not measured.
   */
  test("a duplicated row is not a third account in the sentence a partial failure carries", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({
            items: [{ id: "ca_1" }, { id: "ca_1" }, { id: "ca_2" }],
          }),
          delete: async (id: string) => {
            if (id === "ca_2") throw new Error("Composio refused this one.");
            return WITHDRAWN;
          },
        },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );
    expect(failure).toBeInstanceOf(BrokerRefusalError);
    expect(failure.message).toMatch(/withdrew 1 of this person's 2 accounts/);
    expect(failure.message).not.toMatch(A_CRASH);
  });

  /**
   * AND HOLDING BOTH KINDS OF SURVIVING GRANT IS NOT A REASON TO BE TOLD ABOUT ONE OF THEM.
   *
   * The two clauses were an `if`/`else if`, so a person holding a nameless account AND a refused one
   * read only the dashboard sentence: "disconnecting again meets them unchanged". That is true of
   * the nameless row and false of the refused one, and it is the sentence that decides whether they
   * press the button again — so the advice that would actually have ended the refused grant was
   * suppressed by the presence of a row it says nothing about. `deleteAuthConfig` writes the
   * identical pair as two independent `if`s, and the comment over this chain already described both
   * remedies as two remedies.
   */
  test("a person holding a nameless account and a refused one is told both remedies", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({ items: [{}, { id: "ca_refused" }] }),
          delete: refuse("this account's withdrawal"),
        },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    expect(failure).toBeInstanceOf(BrokerRefusalError);
    expect(failure.message).toMatch(/withdrew 0 of this person's 2 accounts/);
    // The row Composio named nothing for, whose only remedy is the dashboard.
    expect(failure.message).toMatch(/no id at all/);
    // And the one a second press genuinely reaches, which the `else if` was withholding.
    expect(failure.message).toMatch(
      /Disconnecting again asks only for the accounts that are left\./,
    );
    expect(failure.message).not.toMatch(A_CRASH);
  });

  /**
   * AND THE SAME SUPPRESSION ONE CONDITION EARLIER, BEFORE A SINGLE ACCOUNT IS LOOKED AT.
   *
   * The two refusals over the config listing are `ours.length === 0 && held.length > 0` and
   * `ours.length === 0 && unreadable.length > 0`, and `held` counts the READABLE rows while
   * `unreadable` counts the rest — so both are ordinary facts about one listing and both can be
   * true at once. Written as consecutive throws the second is reachable only when the first is
   * false, so a person whose app holds one renamed config beside one unreadable row is told that
   * "renaming it to end with (OpenBot) lets disconnecting again withdraw them" — which is not true
   * while a row nothing could scope the account listing to is still sitting there. The method's own
   * partial-withdrawal sentence appends that fact as its own clause; the refusal ahead of it did
   * not.
   */
  test("a renamed config beside an unreadable one does not promise a disconnect that would finish", async () => {
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: "ac_theirs", name: "Gmail", status: "ENABLED" },
              { id: "ac_nameless", status: "ENABLED" },
            ],
          }),
        },
        connectedAccounts: {
          delete: async (id: string) => {
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    expect(failure).toBeInstanceOf(BrokerRefusalError);
    expect(failure.message).not.toMatch(A_CRASH);
    // The renamed-config reading, which this refusal already carried.
    expect(failure.message).toMatch(/Composio holds 1 for gmail/);
    expect(failure.message).toMatch(/\(OpenBot\)/);
    // And the row that was never sorted, which is what makes the rename alone insufficient.
    expect(failure.message).toMatch(/cannot read/);
    // Nothing was withdrawn either way — the listing was never scoped, so no delete was composed.
    expect(deleted).toEqual([]);
  });
});

/**
 * The three refusals this file authors, and the one thing a route has to be able to do with them.
 *
 * `routes.ts` answers a thrown broker error by reaching into it for the vendor's own sentence and,
 * finding none, telling the reader that Composio said nothing about why and that an administrator
 * should check this deployment's key. That advice is wrong for every sentence below: Composio
 * answered, this deployment decided, and the remedy is already written down. `brokerSentence` is the
 * one seam that tells the two apart, so these assert the recognition rather than the wording.
 */
describe("refusals a route can tell from an outage", () => {
  test("an app with no config of ours is recognised as this deployment's own refusal", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({ authConfigs: { list: async () => ({ items: [] }) } }),
    );

    const error = await broker
      .authorize({
        userId: "user_1",
        toolkit: "linear",
        returnUrl: "https://openbot.test/settings/connected-accounts/x",
      })
      .catch((raised: unknown) => raised);

    // `/An administrator/` opens two of this method's three refusals, so it recognised the class
    // and not the branch. The remedy is what a reader is being handed.
    expect(brokerSentence(error)).toMatch(NO_CONFIG_REMEDY);
    expect(brokerSentence(error)).not.toMatch(DISABLED_REMEDY);
  });

  test("a consent with nowhere to send anybody is recognised too", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: "ac_ours", name: "Linear (OpenBot)", status: "ENABLED" },
            ],
          }),
        },
        // An API-key toolkit is connected by typing a secret rather than by visiting a page, so the
        // vendor answers with no url. Nothing is wrong with the key, and saying so would be a
        // second wrong answer on top of a first.
        connectedAccounts: { link: async () => ({ redirectUrl: null }) },
      }),
    );

    const error = await broker
      .authorize({
        userId: "user_1",
        toolkit: "linear",
        returnUrl: "https://openbot.test/settings/connected-accounts/x",
      })
      .catch((raised: unknown) => raised);

    expect(brokerSentence(error)).toMatch(NO_PAGE_REMEDY);
    expect(brokerSentence(error)).not.toMatch(NO_CONFIG_REMEDY);
    expect(brokerSentence(error)).not.toMatch(DISABLED_REMEDY);
  });
});

/**
 * What the catalogue is allowed to be, given that it is cached and then believed.
 */
describe("a catalogue that might be a fragment", () => {
  /**
   * THIS TEST ASSERTED THE OPPOSITE AND WAS CHANGED ON PURPOSE, WHICH IS WORTH READING BEFORE THE
   * CODE UNDER IT.
   *
   * It was "a full page is refused rather than held for ten minutes", and it pinned a refusal whose
   * stated reason was that "`LISTING_LIMIT` is the largest page the toolkit endpoint allows and the
   * SDK drops the response's cursor, so a catalogue of exactly this size and one larger answer
   * identically". The consequence it guarded against is real and is still guarded: a fragment
   * committed here is served for ten minutes to the picker AND to the enable route, which then
   * tells an administrator that a real app "is not an app Composio lists".
   *
   * WHAT WAS FALSE WAS THE PREMISE. The cursor exists on the raw client and always did — see the
   * paging tests at the end of this file — so the two answers the refusal said were
   * indistinguishable are told apart by asking for the next page. And the refusal's cost was not
   * hypothetical: Composio publishes more than {@link WHOLE_LISTING} toolkits, so it fired on the
   * first call every time and the app picker showed an operator nothing at all.
   *
   * SO THE ASSERTION IS INVERTED RATHER THAN DELETED, and it is inverted at the same boundary. A
   * page of exactly {@link WHOLE_LISTING} rows with a cursor still outstanding is the shape that
   * used to be refused; what is asserted now is that the row on the far side of it arrives.
   */
  test("a full page is read on from rather than refused", async () => {
    let calls = 0;
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          list: async (query: unknown) => {
            calls += 1;
            return (query as { cursor?: string }).cursor === undefined
              ? {
                  items: Array.from({ length: WHOLE_LISTING }, (_, index) => ({
                    slug: `app_${index}`,
                    name: `App ${index}`,
                    meta: {},
                  })),
                  next_cursor: "page_2",
                }
              : {
                  items: [
                    { slug: "the_one_past_the_cut", name: "Past", meta: {} },
                  ],
                  next_cursor: null,
                };
          },
        },
      }),
      () => 1_000_000,
    );

    const apps = await broker.listApps();

    expect(calls).toBe(2);
    expect(apps).toHaveLength(WHOLE_LISTING + 1);
    // The app an administrator would have been told Composio does not publish.
    expect(apps.at(-1)?.slug).toBe("the_one_past_the_cut");
  });

  test("each caller gets its own rows, so one of them cannot edit the cache", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        toolkits: {
          list: async () => ({
            items: [
              {
                slug: "gmail",
                name: "Gmail",
                meta: {
                  description: "Send and read mail.",
                  categories: [{ id: "productivity", name: "Productivity" }],
                  tools_count: 63,
                },
              },
            ],
          }),
        },
      }),
      () => 1_000_000,
    );

    const first = await broker.listApps();
    first[0].name = "Not Gmail";
    first[0].categories.push("Invented");
    first.length = 0;

    // Nothing does this today, which is exactly why leaving it would be a trap: the first caller
    // that sorts or trims the rows would be editing what the next nine minutes of callers read as
    // Composio's answer, and the fault would surface in somebody else's request.
    const second = await broker.listApps();
    expect(second).toEqual([
      {
        slug: "gmail",
        name: "Gmail",
        description: "Send and read mail.",
        logo: null,
        categories: ["Productivity"],
        actionCount: 63,
        connection: NO_SCHEME,
      },
    ]);
  });

  /**
   * AND THE CONNECTION IS A ROW'S SECOND NON-PRIMITIVE, WHICH THE COPY ABOVE WAS NOT MAKING.
   *
   * The copy spread the row and rebuilt `categories`, on a comment claiming that array was the one
   * field here that is not a primitive. `connection` is an object too — see {@link BrokerConnection}
   * — so it travelled by reference out of the cache and into every caller for ten minutes, which is
   * the exact sharing the copy exists to end. It is also the worst field to share: the app picker
   * hides `unsupported` and the enable route branches on `kind` to decide whether to create an auth
   * config at all, so a caller that edited the object it was handed would be editing what those two
   * decisions read next.
   */
  test("each caller gets its own connection, so one of them cannot edit what the picker branches on", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        toolkits: {
          list: async () => ({
            items: [{ slug: "gmail", name: "Gmail", meta: {} }],
          }),
        },
      }),
      () => 1_000_000,
    );

    const first = await broker.listApps();
    const held = first[0].connection;
    if (held.kind !== "unsupported") {
      throw new Error(`The fixture resolved to ${held.kind}, not unsupported.`);
    }
    held.reason = "Invented";

    const second = await broker.listApps();
    expect(second[0].connection).toEqual(NO_SCHEME);
    expect(second[0].connection).not.toBe(first[0].connection);
  });
});

/**
 * WHAT ESCAPES THE SEAM WHEN THE VENDOR THROWS, asked of every method the seam has.
 *
 * ONE TABLE RATHER THAN A TEST PER DISCOVERY, because the defect this is about has been found four
 * times in four methods and each finding was fixed where it was pointed at. `routes.ts` answers a
 * thrown broker error by reaching into it for the vendor's own sentence and, finding none, telling
 * the reader that Composio said nothing about why and that an administrator should check this
 * deployment's Composio key. That is the right thing to say about a socket that hung up and the
 * wrong thing to say about every failure the vendor actually explained — and which of the two a
 * reader gets is decided by whether the `await vendor.*` that threw happened to sit inside
 * something that translates. TypeScript has no checked exceptions, so nothing enumerates the calls
 * that do and nothing notices a new one that does not.
 *
 * THE PROPERTY, STATED ONCE: an error leaving this seam must leave the route something to say —
 * either a {@link BrokerRefusalError}, whose sentence this deployment wrote and whose remedy is
 * already in it, or a vendor error whose own sentence {@link vendorSentence} can reach. Anything
 * else reaches the reader as "check your Composio key", so anything else has to be named below as
 * a failure that genuinely deserves that answer.
 *
 * THE ALLOW-LIST IS ASSERTED IN BOTH DIRECTIONS, which is what stops it becoming a list of
 * excuses. An entry on it must actually arrive unexplained; the day a method starts translating
 * the failure named there, its entry reddens and has to be deleted rather than quietly outliving
 * the state it describes.
 *
 * THE METHOD LIST IS THE SEAM'S OWN. It is read off the objects {@link buildComposioClient}
 * returns rather than copied into this file, and typed as `keyof ComposioBroker | keyof
 * ComposioActions`, so a method added to either seam with no entry here fails the completeness
 * test below instead of being covered by nobody.
 */
describe("what a vendor failure becomes on its way out of the seam", () => {
  /**
   * The two ways a vendor call fails, which are two different questions and not one.
   *
   * An OUTAGE carries nothing: a socket, a 502 from an edge, a timeout. Nobody wrote a sentence
   * about it, so there is none to find and "Composio did not say why" is the honest answer.
   *
   * A NAMED CONDITION is the opposite case and the one that keeps being missed. `@composio/core`
   * raises its own error classes — `ComposioMultipleConnectedAccountsError` and the four others
   * down the same door: `ComposioAclOnlyForSharedError`,
   * `ComposioFailedToCreateConnectedAccountLink`, `ValidationError`,
   * `ComposioRequestCancelledError` — and each one is the vendor saying WHICH condition happened,
   * in a message it wrote for a reader. None of it is nested where {@link vendorSentence} looks, so
   * a seam that lets one through unexamined converts an explanation into "check the key".
   *
   * A SHAPE THE SDK ITSELF COULD NOT READ is the third, and it is the one three rounds of review
   * wrote guards for at the wrong layer. `@composio/core` 0.18.1 does not hand a malformed listing
   * over to be inspected: its own transformers dereference the answer first, so
   * `response.items.map(transformAuthConfigRetrieveResponse)` off a bare list, and
   * `authConfig.toolkit.logo` off a row that is not an object, raise a bare `TypeError` from inside
   * the vendor's code before any reader here is reached (`src/utils/transformers/authConfigs.ts:79`,
   * `:41`, and the same two shapes in `connectedAccounts.ts:113`, `:60` and `models/Tools.ts:561`).
   * A `TypeError` arriving out of an `await vendor.*` is therefore Composio's shape and not a bug of
   * this deployment's, and what it needs is the same thing every other vendor failure needs: a
   * sentence.
   */
  const THROWN: {
    kind: string;
    raise: () => Error;
    /** What the sentence must say, where the kind of failure settles a remedy. */
    demands?: RegExp;
    /** What the sentence must not have picked up from the error it translated. */
    quiets?: RegExp;
  }[] = [
    {
      kind: "an outage",
      raise: () => new Error("socket hang up"),
    },
    {
      kind: "a named vendor condition",
      raise: () =>
        Object.assign(
          new Error(
            "Multiple connected accounts found for user user_1 and toolkit linear.",
          ),
          { name: "ComposioMultipleConnectedAccountsError" },
        ),
    },
    {
      kind: "a shape the SDK itself could not read",
      raise: () =>
        new TypeError(
          "undefined is not an object (evaluating 'response.items.map')",
        ),
      // One remedy, and it is a package rather than a page: nobody operating this deployment can
      // correct what Composio answers, and the key is demonstrably fine — the call went out.
      demands: /@composio\/core/,
      quiets: A_CRASH,
    },
  ];

  type SeamMethod = keyof ComposioBroker | keyof ComposioActions;

  /**
   * The failures this seam is allowed to hand on unexplained, one entry per state and each with
   * its reason written down.
   *
   * Every one of them is the same claim: the vendor call that failed said nothing this deployment
   * could pass on, so "Composio did not answer and an administrator should check the key and their
   * status page" is genuinely the best thing a reader can be told. That claim is true of a bare
   * `Error` out of a listing and it is NOT true of anything the vendor named.
   */
  const GENUINE_OUTAGES: {
    method: SeamMethod;
    kind: string;
    because: string;
  }[] = [
    {
      method: "listApps",
      kind: "an outage",
      because:
        "The catalogue did not answer. There is no app and no person in the question, so the only remedy is the deployment's key or the vendor's status page.",
    },
    {
      method: "ensureAuthConfig",
      kind: "an outage",
      because:
        "Creating the config failed with nothing said. An administrator pressed Add; the app is not enabled, and what to check is the key.",
    },
    {
      method: "authorize",
      kind: "an outage",
      because:
        "Minting the link failed with nothing said. Nobody was sent anywhere and nothing was attached, so trying again is the whole of the advice.",
    },
    {
      method: "isConnected",
      kind: "an outage",
      because:
        "The account listing did not answer. This is a gate rather than a page, and its caller refuses the run either way.",
    },
    {
      method: "connectionFields",
      kind: "an outage",
      because:
        "Reading what the app asks a person for did not answer. No form was drawn and nothing was attached, so there is nothing about this app to say that the route's own advice — the deployment's key, the vendor's status page — does not already cover.",
    },
    {
      method: "revokeAccount",
      kind: "an outage",
      because:
        "The delete did not answer. The vendor's own bare message travels on untouched, naming nothing, because there is nothing else to say: the account may be standing at Composio and this deployment cannot tell whether the request landed. Its caller is undoing its own work rather than a person pressing a button, and what it is owed is the failure itself.",
    },
    /*
     * THE TWO REASONS BELOW USED TO BE FALSE, AND THIS IS THE CASE THE ALLOW-LIST CANNOT CATCH BY
     * ITSELF. Its assertion asks whether an AUTHORED sentence reached the reader, so an entry whose
     * `because` mis-describes what the reader gets INSTEAD stays green for ever. Both of these said
     * the app gets named somewhere downstream; neither does. `listingSentence` returns the thrown
     * message verbatim whenever it is neither a schema mismatch nor the vendor's placeholder
     * (`./composio`), and `callTool` does the same on the execute path — so "socket hang up" reaches
     * an administrator's Plugins page and a model's context exactly like that, bare, naming no app.
     * The entries now say so, and the `allowed` branch of the test asserts the message travels
     * untouched, which is what makes the claim hold itself up.
     */
    {
      method: "listActions",
      kind: "an outage",
      because:
        "The action listing did not answer. `./composio`'s `listingSentence` passes the thrown message on verbatim, so the reader gets the vendor's own bare words with no app named — which is all there is, because a listing that did not answer leaves nothing else to say.",
    },
    {
      method: "execute",
      kind: "an outage",
      because:
        "The call itself failed with nothing said. `callTool` passes the thrown message on verbatim unless it is the vendor's placeholder, so the reader gets the vendor's own bare words — the app is named by the connection they pressed, not by this sentence.",
    },
  ];
  const UNEXPLAINABLE = new Set(
    GENUINE_OUTAGES.map((outage) => `${outage.method}/${outage.kind}`),
  );

  /**
   * Every method of the seam, with the vendor call that decides its answer aimed at the throw.
   *
   * THE CALL THAT DECIDES RATHER THAN THE FIRST ONE. Several of these read a listing before they
   * do the thing they are named for, and a vendor whose every method threw would have each of them
   * fail at that first read — so the table would be eight tests of one listing and F1, which lives
   * behind an auth-config listing that succeeds, would be unreachable. Each entry below answers
   * everything on the way in and throws at the step the method exists to perform.
   */
  const SEAM_CASES: {
    method: SeamMethod;
    vendor: (raise: () => Promise<never>) => Parameters<typeof fakeVendor>[0];
    ask: (client: ReturnType<typeof buildComposioClient>) => Promise<unknown>;
  }[] = [
    {
      method: "listApps",
      vendor: (raise) => ({ toolkits: { list: raise } }),
      ask: ({ broker }) => broker.listApps(),
    },
    {
      method: "ensureAuthConfig",
      vendor: (raise) => ({
        authConfigs: { list: async () => ({ items: [] }), create: raise },
      }),
      ask: ({ broker }) =>
        broker.ensureAuthConfig({
          toolkit: "linear",
          name: "Linear",
          connection: { kind: "consent" },
        }),
    },
    {
      method: "deleteAuthConfig",
      vendor: (raise) => ({
        authConfigs: { list: async () => ({ items: [OURS] }), delete: raise },
      }),
      ask: ({ broker }) => broker.deleteAuthConfig("linear"),
    },
    {
      method: "authorize",
      vendor: (raise) => ({
        authConfigs: { list: async () => ({ items: [OURS] }) },
        connectedAccounts: { link: raise },
      }),
      ask: ({ broker }) =>
        broker.authorize({
          userId: "user_1",
          toolkit: "linear",
          returnUrl: RETURN_URL,
        }),
    },
    {
      method: "isConnected",
      vendor: (raise) => ({ connectedAccounts: { list: raise } }),
      ask: ({ broker }) =>
        broker.isConnected({ userId: "user_1", toolkit: "gmail" }),
    },
    {
      method: "revoke",
      vendor: (raise) => ({
        // The configs first, because the withdrawal reads them to find out which accounts are this
        // deployment's to end before it asks for any account at all.
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({ items: [{ id: "ca_1" }] }),
          delete: raise,
        },
      }),
      ask: ({ broker }) =>
        broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    },
    {
      method: "connectionFields",
      vendor: (raise) => ({ toolkits: { retrieve: raise } }),
      ask: ({ broker }) =>
        broker.connectionFields({
          toolkit: "perplexityai",
          authScheme: "API_KEY",
        }),
    },
    {
      method: "connectWithFields",
      vendor: (raise) => ({
        // The configs first, for the reason the withdrawal above answers them first: the connection
        // is made against this deployment's own config, so the read that finds one has to succeed
        // before the create this row is about can be reached at all.
        authConfigs: { list: async () => ({ items: [OURS] }) },
        connectedAccounts: { create: raise },
      }),
      ask: ({ broker }) =>
        broker.connectWithFields({
          userId: "user_1",
          toolkit: "linear",
          authScheme: "API_KEY",
          values: { generic_api_key: "never-sent-anywhere" },
        }),
    },
    {
      method: "revokeAccount",
      vendor: (raise) => ({ connectedAccounts: { delete: raise } }),
      // No listing on the way in, which is the whole shape of this method: the id is what it was
      // handed, so the delete is the first vendor call it makes and the only one it can fail at.
      ask: ({ broker }) => broker.revokeAccount("ca_new"),
    },
    {
      method: "listActions",
      vendor: (raise) => ({ tools: { list: raise } }),
      ask: ({ actions }) =>
        actions.listActions("gmail", { limit: WHOLE_LISTING }),
    },
    {
      method: "execute",
      vendor: (raise) => ({
        tools: {
          getRawComposioToolBySlug: async () => ({
            slug: "GMAIL_FETCH_EMAILS",
            toolkit: { slug: "gmail" },
          }),
          execute: raise,
        },
      }),
      ask: ({ actions }) =>
        actions.execute(
          {
            toolkit: "gmail",
            slug: "GMAIL_FETCH_EMAILS",
            userId: "user_1",
            version: "20260903_00",
          },
          {},
        ),
    },
  ];

  test("every method the seam offers has an entry in the table", () => {
    // Read off the built objects rather than listed here a second time: a method added to either
    // projection arrives in this set, and the table that does not cover it fails here rather than
    // being the one door nobody thought to probe.
    const seam = buildComposioClient(fakeVendor({}));
    expect(
      [...Object.keys(seam.broker), ...Object.keys(seam.actions)].sort(),
    ).toEqual(SEAM_CASES.map((seamCase) => seamCase.method).sort());
  });

  for (const seamCase of SEAM_CASES) {
    for (const thrown of THROWN) {
      const allowed = UNEXPLAINABLE.has(`${seamCase.method}/${thrown.kind}`);
      test(`${seamCase.method} meeting ${thrown.kind} leaves the route ${
        allowed
          ? "nothing to say, and that is named as an outage"
          : "a sentence"
      }`, async () => {
        const raised = thrown.raise();
        const client = buildComposioClient(
          fakeVendor(
            seamCase.vendor(async () => {
              throw raised;
            }),
          ),
          () => 1_000_000,
        );

        const escaped = await failureOf(seamCase.ask(client));
        const sentence = brokerSentence(escaped) ?? vendorSentence(escaped);

        if (allowed) {
          // The allow-list's other direction. This entry claims the reader cannot be told anything
          // useful here; the day that stops being true, this line is what says so.
          expect(sentence).toBeNull();
          /*
           * AND WHAT THE READER DOES GET, WHICH IS THE HALF THE `because` COLUMN KEPT GETTING WRONG.
           * Two entries above used to claim the reader is left with a named app and only the reason
           * missing; the truth is that the vendor's own bare message travels on untouched — through
           * `listingSentence` into an app's `lastError`, and through `callTool` into a result — with
           * nothing added and no app named. That is what "unexplainable" costs here, so the entries
           * say so and this line holds them to it: the day a method starts wrapping the failure, the
           * `because` beside it stops being true and this reddens rather than outliving it.
           */
          expect(escaped.message).toBe(raised.message);
          return;
        }
        expect(sentence).not.toBeNull();
        expect(sentence?.trim()).not.toBe("");
        /*
         * THE REMEDY IS ASKED OF THE WHOLE FAILURE AND NOT OF ITS FIRST LINE, because two of these
         * methods deliberately make a COUNT their sentence. `revoke` and `deleteAuthConfig` are
         * withdrawing a SET, and what a reader can act on there is how many of it survived; every
         * reason the loop met travels on `cause` instead, which is the only place the detail lives.
         * So what has to be true is that the remedy reached the failure somewhere, and reading the
         * chain is what says so for both shapes at once.
         */
        if (thrown.demands) {
          expect(everythingSaidBy(escaped).join("\n")).toMatch(thrown.demands);
        }
        // The vendor's crash is carried as `cause` and never quoted: a sentence that reads like a
        // stack trace is the thing every refusal in this seam was written to stop being.
        if (thrown.quiets) expect(sentence).not.toMatch(thrown.quiets);
      });
    }
  }
});

/**
 * ONE REMEDY PER VENDOR CONDITION, WHICH IS THE HALF THE TABLE ABOVE CANNOT ASSERT.
 *
 * That table asks whether a reader is told ANYTHING, and a seam that answered every named condition
 * with one sentence would satisfy it completely. This file has already been bitten by exactly that:
 * `rejects.toThrow(/linear/)` matched three authored refusals prescribing three different acts by
 * three different people, so deleting a whole branch left the suite green. The app name is the part
 * every sentence shares; the remedy is the part that makes a sentence worth writing.
 *
 * SO EACH ROW BELOW IS ASSERTED IN BOTH DIRECTIONS: the sentence a condition produces must carry ITS
 * remedy and must carry NO OTHER ROW'S. Two conditions collapsed into one wording fail here twice
 * over — the row that lost its remedy, and the row that acquired a second one.
 *
 * THE CALL SITE OF EACH ROW IS ONE THAT ACTUALLY RAISES IT, read off `@composio/core` 0.18.1 rather
 * than chosen for convenience, so a row is also a record of where its condition comes from. The
 * table above already establishes that the translation is not call-site-specific; this one
 * establishes that the sentences are distinguishable, which is what stops the translation being a
 * fallback with a vendor's name on it.
 */
describe("each vendor condition reaches the reader as its own remedy", () => {
  /** The vendor's error as it arrives: a name, and a message nothing here reads. */
  function raising(name: string): () => Promise<never> {
    return async (): Promise<never> => {
      throw Object.assign(new Error(`${name} came out of Composio.`), { name });
    };
  }

  /** Minting this person's connect link, which is where three of the rows below come from. */
  function whileLinking(raise: () => Promise<never>): Promise<unknown> {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: [OURS] }) },
        connectedAccounts: { link: raise },
      }),
      () => 1_000_000,
    );
    return broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl: RETURN_URL,
    });
  }

  /** Creating this deployment's auth config, where the SDK parses what it is handed. */
  function whileCreatingConfig(raise: () => Promise<never>): Promise<unknown> {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: [] }), create: raise },
      }),
      () => 1_000_000,
    );
    return broker.ensureAuthConfig({
      toolkit: "linear",
      name: "Linear",
      connection: { kind: "consent" },
    });
  }

  /**
   * ONE APP ACROSS ALL FOUR CONTEXTS, WHICH IS WHAT MAKES THE CROSS-CHECK BELOW MEAN ANYTHING.
   *
   * Three of these remedies name the app they are about. The linking and creating contexts were
   * about `linear` and the resolving and running ones about `gmail`, so "this sentence does not
   * also prescribe somebody else's step" was being asked with a regular expression naming an app
   * the sentence could not have mentioned — it passed for every pair that crossed the two contexts
   * for a reason that had nothing to do with the sentences, which is most of the table. One app
   * makes every row comparable with every other.
   */
  const CALL = {
    toolkit: "linear",
    slug: "LINEAR_CREATE_ISSUE",
    userId: "user_1",
    version: "20260903_00",
  };

  /** Resolving the tool before it is run, which is the call that reports a withdrawn action. */
  function whileResolving(raise: () => Promise<never>): Promise<unknown> {
    const { actions } = buildComposioClient(
      fakeVendor({ tools: { getRawComposioToolBySlug: raise } }),
      () => 1_000_000,
    );
    return actions.execute(CALL, {});
  }

  /** Running it, once the resolve has already agreed about which app it belongs to. */
  function whileRunning(raise: () => Promise<never>): Promise<unknown> {
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioToolBySlug: async () => ({
            slug: CALL.slug,
            toolkit: { slug: CALL.toolkit },
          }),
          execute: raise,
        },
      }),
      () => 1_000_000,
    );
    return actions.execute(CALL, {});
  }

  const CONDITIONS: {
    name: string;
    raisedBy: string;
    remedy: RegExp;
    ask: (raise: () => Promise<never>) => Promise<unknown>;
  }[] = [
    {
      name: "ComposioMultipleConnectedAccountsError",
      raisedBy: "connectedAccounts.link",
      remedy: /disconnecting the account they already hold/,
      ask: whileLinking,
    },
    {
      name: "ComposioAclOnlyForSharedError",
      raisedBy: "connectedAccounts.link",
      remedy: /changing how linear is shared in Composio's own dashboard/,
      ask: whileLinking,
    },
    {
      name: "ComposioFailedToCreateConnectedAccountLink",
      raisedBy: "connectedAccounts.link",
      remedy: /no consent was spent/,
      ask: whileLinking,
    },
    {
      name: "ValidationError",
      raisedBy: "authConfigs.create",
      remedy: /upgrading this deployment's @composio\/core/,
      ask: whileCreatingConfig,
    },
    {
      name: "ComposioRequestCancelledError",
      raisedBy: "tools.execute",
      remedy: /asking for it again is what settles/,
      ask: whileRunning,
    },
    {
      name: "ComposioConnectedAccountNotFoundError",
      raisedBy: "tools.execute",
      remedy:
        /connecting linear again on this deployment's Connected accounts page/,
      ask: whileRunning,
    },
    {
      name: "ComposioToolNotFoundError",
      raisedBy: "tools.getRawComposioToolBySlug",
      remedy: /records what Composio publishes now/,
      ask: whileResolving,
    },
    {
      name: "ComposioToolVersionRequiredError",
      raisedBy: "tools.execute",
      remedy: /replaces "latest" with a version Composio will accept/,
      ask: whileRunning,
    },
  ];

  for (const condition of CONDITIONS) {
    test(`${condition.name} out of ${condition.raisedBy} prescribes its own step`, async () => {
      const failure = await failureOf(condition.ask(raising(condition.name)));
      const sentence = brokerSentence(failure) ?? vendorSentence(failure);

      expect(sentence).not.toBeNull();
      expect(sentence).toMatch(condition.remedy);

      // The other direction: a sentence that also prescribes somebody else's step is a sentence two
      // conditions are sharing, which is the state this whole table exists to catch.
      for (const other of CONDITIONS) {
        if (other.name === condition.name) continue;
        expect(sentence).not.toMatch(other.remedy);
      }
    });
  }

  /**
   * ONE VENDOR CLASS OVER EVERY WAY A FETCH CAN FAIL, which is a fact about the SDK rather than a
   * reading of its name. `getRawComposioToolBySlug` wraps its retrieve in a try whose catch
   * rethrows everything except a cancellation as `ComposioToolNotFoundError` (`@composio/core`
   * 0.18.1, `src/models/Tools.ts:709-721`), and `tools.execute` resolves through that same method
   * (`:1163`). A 500, a 429, a refused key and a socket that hung up therefore all arrive wearing
   * the name of an action that was withdrawn — and the sentence read the name as the finding,
   * telling an administrator during an outage that Composio no longer publishes their action and
   * that pressing Refresh at the vendor that is not answering will fix it.
   */
  test("the withdrawn-action condition does not claim to know Composio withdrew anything", async () => {
    const failure = await failureOf(
      whileResolving(raising("ComposioToolNotFoundError")),
    );
    const sentence = brokerSentence(failure);

    expect(sentence).not.toBeNull();
    // The refresh stays, because a withdrawn action is the commonest of them and the refresh is
    // the only act that settles that reading.
    expect(sentence).toMatch(/records what Composio publishes now/);
    // What was missing is the other reading, and the fact that separates the two — which is
    // something an administrator can go and look at.
    expect(sentence).toMatch(
      /a timeout, a dropped connection, a 500, a refused key/,
    );
    expect(sentence).toMatch(/says nothing that tells the two apart/);
    // And the claim it must no longer make.
    expect(sentence).not.toMatch(/no longer publishes that action/);
  });

  /**
   * The vendor's own words win where there are any, which is the limit on translating at all.
   *
   * `routes.ts` reads {@link brokerSentence} first and {@link vendorSentence} second, so a refusal
   * authored here HIDES whatever Composio's own server said. Several of the SDK's classes are
   * wrappers that carry the server's explanation underneath — `ComposioFailedToCreateConnectedAccountLink`
   * is one, and it is on the table above — so translating one of those unconditionally would replace
   * a specific server message with this deployment's general one. Where the vendor explained itself,
   * the error is passed on untouched and the reader gets the vendor's sentence.
   */
  test("a condition whose vendor message is reachable is passed on rather than reworded", async () => {
    const failure = await failureOf(
      whileLinking(async (): Promise<never> => {
        throw Object.assign(
          new Error("Failed to create connected account link"),
          {
            name: "ComposioFailedToCreateConnectedAccountLink",
            cause: {
              error: {
                error: {
                  message:
                    "The auth config linear (OpenBot) has no redirect URI registered.",
                },
              },
            },
          },
        );
      }),
    );

    expect(brokerSentence(failure)).toBeNull();
    expect(vendorSentence(failure)).toBe(
      "The auth config linear (OpenBot) has no redirect URI registered.",
    );
  });
});

/**
 * WHAT THE LOOP THAT DELETES A SET OF THINGS DOES WITH WHAT IT CATCHES.
 *
 * `deleteAuthConfig` and `revoke` each ask Composio to end several objects that independently hold
 * somebody's access, and both attempt all of them rather than stopping at the first refusal — which
 * is the right shape and was reporting almost none of what it learned. Two things were wrong with
 * it, and they are different failures rather than one.
 *
 * EVERY REASON AFTER THE FIRST WAS DISCARDED. The throw carried `cause: refused[0]` and nothing
 * else, so a person with five accounts of which three refused left one reason behind and two gone —
 * and the sentence a reader gets is a count, deliberately, so the reasons were the only place the
 * detail lived at all.
 *
 * AND A BUG OF OURS WAS COUNTED AS A REFUSAL BY COMPOSIO. The catch took everything, so a
 * `TypeError` out of this adapter's own code became one more "Composio refused the rest" — a
 * sentence telling an operator to press disconnect again, about a fault that will do the same thing
 * every time and that no amount of retrying reaches.
 */
describe("what the delete loop keeps of the failures it meets", () => {
  test("every account Composio refused is carried, not only the first", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({
            items: [{ id: "ca_1" }, { id: "ca_2" }, { id: "ca_3" }],
          }),
          delete: async (id: string) => {
            if (id !== "ca_1") throw new Error(`Composio refused ${id}.`);
            return WITHDRAWN;
          },
        },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    // The sentence stays the count, which is what a reader can act on. The reasons are what a log
    // reader needs, and there are two of them.
    expect(brokerSentence(failure)).toMatch(/1 of this person's 3 accounts/);
    const cause = failure.cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect(
      (cause as AggregateError).errors.map((one) => (one as Error).message),
    ).toEqual(["Composio refused ca_2.", "Composio refused ca_3."]);
  });

  test("a single refusal is still carried as itself rather than wrapped", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({ items: [{ id: "ca_1" }, { id: "ca_2" }] }),
          delete: async (id: string) => {
            if (id === "ca_2") throw new Error("Composio refused that one.");
            return WITHDRAWN;
          },
        },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    expect((failure.cause as Error).message).toBe("Composio refused that one.");
  });

  /**
   * A `TypeError` OUT OF A VENDOR CALL IS COMPOSIO'S SHAPE, AND THIS TEST USED TO ASSERT THE REVERSE.
   *
   * It was written around `isOurFault`, whose premise was that a `TypeError` is what a mistake in
   * this file looks like and never something "Composio can reply". Running `@composio/core` 0.18.1
   * falsifies that premise outright: a bare list where `{ items }` belongs, an envelope whose
   * `items` is a string, and a row that is not an object all raise a bare `TypeError` from inside
   * the vendor's own transformers, before any code here is reached. So the classification was
   * inverted — a vendor fault escaped the loop as a bug of ours, abandoning every account after it
   * unasked, and the reader was told nothing at all.
   *
   * WHICH IS WHY THE GUARD MOVED RATHER THAN BEING RETUNED. `askVendor` wraps the `await vendor.*`
   * and nothing else, so "the fault surfaced inside the vendor's code" is a fact about the call
   * stack there rather than a guess from an error class; the loop no longer has to tell the two
   * apart, because by the time an error reaches it the question has been answered one layer down.
   */
  test("a shape the SDK could not read is Composio refusing, and the loop goes on", async () => {
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({
            items: [{ id: "ca_1" }, { id: "ca_2" }, { id: "ca_3" }],
          }),
          delete: async (id: string) => {
            if (id === "ca_2") {
              throw new TypeError(
                "undefined is not an object (evaluating 'x')",
              );
            }
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    // The third account is the one the old classification abandoned: a `TypeError` at the second
    // escaped the loop, so a live grant was never asked about and nothing in the answer said so.
    expect(deleted).toEqual(["ca_1", "ca_3"]);
    expect(brokerSentence(failure)).toMatch(/2 of this person's 3 accounts/);
    // And the crash is carried rather than quoted: the sentence a person reads is this
    // deployment's, and the vendor's own words are on `cause` for whoever is reading a log.
    expect(failure.message).not.toMatch(A_CRASH);
    expect((failure.cause as Error).cause).toBeInstanceOf(TypeError);
  });

  test("the same two promises hold for the loop that removes an app's configs", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [OURS, OURS_SPARE] }),
          delete: async (id: string) => {
            throw new Error(`Composio refused ${id}.`);
          },
        },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(broker.deleteAuthConfig("linear"));

    expect(brokerSentence(failure)).toMatch(
      /0 of this deployment's 2 authorization configs/,
    );
    expect(
      (failure.cause as AggregateError).errors.map(
        (one) => (one as Error).message,
      ),
    ).toEqual(["Composio refused ac_ours.", "Composio refused ac_ours_spare."]);
  });
});

/**
 * WHAT EACH VENDOR LISTING IS ALLOWED TO BE, given that this file's types only assert its shape.
 *
 * A TYPESCRIPT INTERFACE OVER A WIRE VALUE IS AN ASSERTION AND NOT A CHECK, which is the reason
 * this table exists — but only for the fields, and that distinction is the whole of what a round of
 * running `@composio/core` 0.18.1 established. Three of these four listings go through the SDK's
 * warn-only `transform()`, which logs a `safeParse` failure and returns the unvalidated object, so a
 * toolkit whose name is null, an auth config whose id is missing and a connected account with no id
 * all arrive here exactly as they came off the wire. Those are the shapes below, and each one was
 * OBSERVED arriving rather than reasoned about.
 *
 * WHAT IS NOT BELOW ANY MORE IS THE CONTAINER, AND THAT IS A CORRECTION RATHER THAN A GAP. This
 * table used to open each listing with "nothing at all" and "a bare list where an envelope belongs",
 * on the claim that those had been observed too. They had not, and they cannot be: every one of the
 * SDK's list transformers dereferences the answer before returning it — `response.items.map(...)`
 * for the two paged listings and for the tool list, `item.meta.categories` for the catalogue — so a
 * container of the wrong shape dies inside the vendor's code, as a bare `TypeError` on three paths
 * and as `ComposioToolkitFetchError` on the catalogue, before any reader in the adapter is reached.
 * That failure is a vendor-shape fault and is answered as one, which is asserted next door in the
 * seam table rather than pretended at here.
 *
 * WHAT A MALFORMED ANSWER MUST NOT BECOME IS A CRASH REPORT. `f.toLowerCase is not a function` and
 * `null is not an object` are what these produce without a reader: the first as an unhandled 500 on
 * a live route, the rest as a 502 telling an administrator to check a key that is perfectly good. So
 * each case asserts that the call refuses, and that the refusal is a sentence rather than the name
 * of a method that was not there.
 *
 * ASSERTED AS A PROPERTY AND NOT AS A WORDING, because what is required is that a reader be told
 * something, and that nothing be sent to the vendor on the strength of a field the answer did not
 * carry. The second half is the one that had rotted: `sent` was a literal empty array in half these
 * cases and no stub ever wrote to it, so the assertion holding it was a tautology dressed as a
 * check. It is now every vendor call the adapter made, in order, and each listing says which single
 * call that should be.
 */
describe("a vendor listing that is not the shape it is declared to be", () => {
  /** Every vendor method the adapter reached, named, in the order it was called. */
  type Probe = {
    parts: Parameters<typeof fakeVendor>[0];
    sent: string[];
  };

  const MALFORMED_LISTINGS: {
    listing: string;
    answers: { shape: string; answer: unknown }[];
    probe: (answer: unknown) => Probe;
    /** The one call this listing's fault is allowed to have made before it refused. */
    asked: string[];
    ask: (client: ReturnType<typeof buildComposioClient>) => Promise<unknown>;
    /** Whether the refusal has to be one a route passes through as this deployment's own. */
    authored: boolean;
  }[] = [
    {
      listing: "the app catalogue",
      answers: [
        {
          shape: "a row whose slug is null",
          answer: { items: [{ slug: null, name: "Gmail", meta: {} }] },
        },
        {
          shape: "a row whose name is null",
          answer: { items: [{ slug: "gmail", name: null, meta: {} }] },
        },
        {
          shape: "a category the vendor named with nothing",
          answer: {
            items: [
              { slug: "gmail", name: "Gmail", meta: { categories: [{}] } },
            ],
          },
        },
      ],
      probe: (answer) => {
        const sent: string[] = [];
        return {
          parts: {
            toolkits: {
              list: async () => {
                sent.push("toolkits.get");
                return answer;
              },
            },
          },
          sent,
        };
      },
      asked: ["toolkits.get"],
      ask: ({ broker }) => broker.listApps(),
      authored: true,
    },
    {
      listing: "this app's auth configs",
      answers: [
        {
          shape: "a row with no name",
          answer: { items: [{ id: "ac_ours", status: "ENABLED" }] },
        },
        {
          shape: "a row whose id is null",
          answer: {
            items: [{ id: null, name: "Linear (OpenBot)", status: "ENABLED" }],
          },
        },
      ],
      probe: (answer) => {
        const sent: string[] = [];
        return {
          parts: {
            authConfigs: {
              list: async () => {
                sent.push("authConfigs.list");
                return answer;
              },
            },
            connectedAccounts: {
              link: async () => {
                sent.push("connectedAccounts.link");
                return { redirectUrl: "https://backend.composio.dev/s/a-link" };
              },
            },
          },
          sent,
        };
      },
      asked: ["authConfigs.list"],
      ask: ({ broker }) =>
        broker.authorize({
          userId: "user_1",
          toolkit: "linear",
          returnUrl: RETURN_URL,
        }),
      authored: true,
    },
    {
      listing: "this person's accounts",
      answers: [
        { shape: "a row with no id", answer: { items: [{}] } },
        { shape: "a row whose id is null", answer: { items: [{ id: null }] } },
        { shape: "a row whose id is a number", answer: { items: [{ id: 7 }] } },
      ],
      probe: (answer) => {
        const sent: string[] = [];
        return {
          parts: {
            authConfigs: {
              list: async () => {
                sent.push("authConfigs.list");
                return { items: [OUR_GMAIL] };
              },
            },
            connectedAccounts: {
              list: async () => {
                sent.push("connectedAccounts.list");
                return answer;
              },
              delete: async () => {
                sent.push("connectedAccounts.delete");
              },
            },
          },
          sent,
        };
      },
      // The whole listing is unreadable here, so there is no readable grant to withdraw and the
      // delete must not be reached at all — a withdrawal of `undefined` is the request this refusal
      // exists to stop being made. Where SOME rows are readable the answer is different and the
      // test for it sits beside `revoke`: those go, and the sentence counts what was left.
      //
      // The config listing goes out first because the withdrawal is scoped to this deployment's own
      // configs before it asks for an account at all; it is named here rather than left out so that
      // the assertion stays a statement about the whole conversation with the vendor.
      asked: ["authConfigs.list", "connectedAccounts.list"],
      ask: ({ broker }) =>
        broker.revoke({ userId: "user_1", toolkit: "gmail" }),
      authored: true,
    },
    {
      listing: "this app's actions",
      answers: [
        // The one row fault `ToolSchema` admits: `z.string()` is satisfied by the empty string, and
        // an action's slug is `mcp_tools.name` — NOT NULL and half the primary key — as well as
        // what a later call sends back to Composio.
        {
          shape: "an action whose slug is empty",
          answer: { items: [{ slug: "", name: "Fetch emails" }] },
        },
      ],
      probe: (answer) => {
        const sent: string[] = [];
        return {
          parts: {
            tools: {
              list: async () => {
                sent.push("tools.getRawComposioTools");
                return answer;
              },
            },
          },
          sent,
        };
      },
      asked: ["tools.getRawComposioTools"],
      ask: ({ actions }) =>
        actions.listActions("gmail", { limit: WHOLE_LISTING }),
      // `./composio` authors this one's sentence, not `./broker`: a listing failure is recorded in
      // the app's `lastError` rather than answered to a route, so what is required here is a
      // sentence and not a class.
      authored: false,
    },
  ];

  for (const listing of MALFORMED_LISTINGS) {
    for (const { shape, answer } of listing.answers) {
      test(`${listing.listing} answered with ${shape} is refused in a sentence`, async () => {
        const probe = listing.probe(answer);
        const client = buildComposioClient(
          fakeVendor(probe.parts),
          () => 1_000_000,
        );

        const failure = await failureOf(listing.ask(client));

        expect(failure.message).not.toMatch(A_CRASH);
        expect(failure.message.trim()).not.toBe("");
        // THE ROW READER ANSWERED AND NOT THE CONTAINER GUARD, which is the whole of what each of
        // these cases is named after. Every answer above is a well-formed envelope carrying ONE bad
        // row, so `pageOf`'s "what came back is not a listing at all" must not be the sentence:
        // that sentence means the fixture never reached the slug, name, category or id reader whose
        // fault the test claims to be about, and it is the exact way these tests rotted before —
        // three catalogue answers and the action answer were bare arrays, every one of them refused
        // at the envelope, and all four passed on the strength of a refusal they had not asked for.
        expect(failure.message).not.toMatch(NOT_A_LISTING);
        if (listing.authored) {
          expect(brokerSentence(failure)).not.toBeNull();
        }
        // Nothing was sent to the vendor on the strength of a field the answer did not carry: an
        // id-less account reaching the delete is a request to withdraw `undefined`, which the
        // vendor is free to read as anything at all. The listing itself is what SHOULD have gone
        // out, so the assertion names it rather than asking for silence — an adapter that stopped
        // asking at all would satisfy an empty expectation perfectly.
        expect(probe.sent).toEqual(listing.asked);
      });
    }
  }
});

/**
 * A listing that came back at the page ceiling, and what a caller may conclude from it.
 *
 * THE TWO LISTINGS HERE CARRY A CURSOR AND THE CATALOGUE DOES NOT, which is why they are answered
 * differently from the fragment refusal next door. `AuthConfigListParamsSchema` and
 * `ConnectedAccountListParamsSchema` both name a `cursor` (`@composio/core` 0.18.1,
 * `src/types/authConfigs.types.ts:124-131` and `src/types/connectedAccounts.types.ts:259-266`),
 * both models forward it (`src/models/AuthConfigs.ts:95`, `src/models/ConnectedAccounts.ts:118`),
 * and both transformers fill `nextCursor` in from the response
 * (`src/utils/transformers/authConfigs.ts:80`, `connectedAccounts.ts:116`). The toolkit listing has
 * none of that — its response is a bare array with the cursor dropped before any caller sees it —
 * so there the only honest answer is to refuse, and here it is to go and read the rest.
 *
 * WHAT IS ACTUALLY BEING PROTECTED IS `revoke`'s `true`. It means "this person's access has ended",
 * and `store.ts` writes that into the audit trail and then deletes the one row naming which app they
 * had connected. One page of their accounts is not the set of their accounts, so the assertions
 * below are on WHAT WENT OUT — every account, from every page — rather than on what came back: an
 * implementation that read one page answers `true` just as confidently.
 */
describe("a listing that arrived with a cursor still outstanding", () => {
  /** The statuses the revoke asks about, spelled once for the two queries asserted below. */
  const REVOCABLE_STATUSES = [
    "INITIALIZING",
    "INITIATED",
    "ACTIVE",
    "FAILED",
    "EXPIRED",
    "INACTIVE",
  ];

  test("every page of this person's accounts is read, and every account on them withdrawn", async () => {
    const asked: unknown[] = [];
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async (query: unknown) => {
            asked.push(query);
            return (query as { cursor?: string }).cursor === undefined
              ? { items: [{ id: "ca_1" }], nextCursor: "page_2" }
              : { items: [{ id: "ca_2" }], nextCursor: null };
          },
          delete: async (id: string) => {
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
    );

    expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
      true,
    );

    // `ca_2` is the whole test. It is on the second page, so a reader that stopped at the first
    // deletes `ca_1`, answers `true`, and leaves a live grant behind an audit row saying this
    // person's access ended.
    expect(deleted).toEqual(["ca_1", "ca_2"]);
    // The first request carries no cursor at all, and the second carries the vendor's own word for
    // where it left off — which is the half a reader cannot infer from the rows that came back.
    expect(asked).toEqual([
      {
        userIds: ["user_1"],
        toolkitSlugs: ["gmail"],
        statuses: REVOCABLE_STATUSES,
        accountType: "ALL",
        authConfigIds: [OUR_GMAIL.id],
        limit: WHOLE_LISTING,
      },
      {
        userIds: ["user_1"],
        toolkitSlugs: ["gmail"],
        statuses: REVOCABLE_STATUSES,
        accountType: "ALL",
        authConfigIds: [OUR_GMAIL.id],
        limit: WHOLE_LISTING,
        cursor: "page_2",
      },
    ]);
  });

  test("an account on a later page still decides whether somebody is connected", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        connectedAccounts: {
          list: async (query: unknown) =>
            (query as { cursor?: string }).cursor === undefined
              ? { items: [], nextCursor: "page_2" }
              : { items: [{ id: "ca_2" }], nextCursor: null },
        },
      }),
    );

    // A first page that is empty with a cursor still outstanding is exactly the shape that reads as
    // "this person has no account", which then tells them to connect an app they already hold — and
    // tells the gate in `./access` that they may not act through one they can.
    expect(
      await broker.isConnected({ userId: "user_1", toolkit: "gmail" }),
    ).toBe(true);
  });

  /**
   * A YES/NO QUESTION THAT PAGING MADE FAILABLE, WHICH IS THE OTHER HALF OF THE TEST ABOVE.
   *
   * Reading every page is what makes `isConnected`'s `false` honest, and it is also what put the
   * two cursor refusals and the page ceiling in front of a person whose ACTIVE account had already
   * been found. `true` is settled the moment one row arrives — no cursor Composio sends next and no
   * fiftieth page can turn it into anything else — so a fault on a page nobody needed was deciding
   * the answer to a question nobody still had. And the consequence is not a wasted request:
   * `store.ts` DELETES this person's `composio_connections` row on anything other than a `true`,
   * and the route turns the refusal into "Composio's answer could not be read" over an account that
   * is right there on page one.
   *
   * THE THREE FAULTS ARE ASSERTED SEPARATELY, because they are three different branches of
   * `everyRowOf` and an early stop that closed one of them would be green on a test that only asked
   * about another.
   */
  for (const { fault, pages } of [
    {
      fault: "a cursor that is not a cursor",
      pages: () => async () => ({ items: [{ id: "ca_1" }], nextCursor: 7 }),
    },
    {
      fault: "a cursor that never advances",
      pages: () => async () => ({
        items: [{ id: "ca_1" }],
        nextCursor: "page_2",
      }),
    },
    {
      fault: "a cursor that advances for ever",
      pages: () => {
        let page = 0;
        return async () => ({
          items: [{ id: `ca_${++page}` }],
          nextCursor: `page_${page + 1}`,
        });
      },
    },
  ]) {
    test(`${fault} cannot unanswer a connection the first page proved`, async () => {
      let asked = 0;
      const page = pages();
      const { broker } = buildComposioClient(
        fakeVendor({
          connectedAccounts: {
            list: async () => {
              asked += 1;
              return page();
            },
          },
        }),
        () => 1_000_000,
      );

      expect(
        await broker.isConnected({ userId: "user_1", toolkit: "gmail" }),
      ).toBe(true);
      // One request, because the first answer settled it. Counted rather than left implicit: an
      // implementation that read on and happened not to throw would answer `true` as well, and the
      // whole point is that the later pages are never reached.
      expect(asked).toBe(1);
    });
  }

  /**
   * AND THE `false` IS STILL NOT ALLOWED TO BE A GUESS, which is what stops the fix above from
   * collapsing into "read one page and answer".
   *
   * With no row in hand the question is genuinely unsettled, so a cursor this deployment cannot
   * follow means it does not know — and saying `false` there would delete the person's row and tell
   * a gate they may not act through an app they hold. The refusal is the honest answer, and it is
   * the one an early stop is most likely to take away by accident.
   */
  test("a cursor fault before any account has been seen is still a refusal", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        connectedAccounts: {
          list: async () => ({ items: [], nextCursor: 7 }),
        },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(
      broker.isConnected({ userId: "user_1", toolkit: "gmail" }),
    );
    expect(failure).toBeInstanceOf(BrokerRefusalError);
    expect(failure.message).not.toMatch(A_CRASH);
  });

  test("every page of this app's configs is read, so none is left standing", async () => {
    const asked: unknown[] = [];
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async (query: unknown) => {
            asked.push(query);
            return (query as { cursor?: string }).cursor === undefined
              ? { items: [OURS], nextCursor: "page_2" }
              : { items: [OURS_SPARE], nextCursor: null };
          },
          delete: async (id: string) => {
            deleted.push(id);
          },
        },
      }),
    );

    await broker.deleteAuthConfig("linear");

    // The spare from a lost enable race is on page two. Left behind, it is a config the removal was
    // supposed to drop, holding every grant made against it, with the app's row deleted after this
    // returns and nothing left in this deployment pointing at it.
    expect(deleted).toEqual(["ac_ours", "ac_ours_spare"]);
    expect(asked).toEqual([
      { toolkit: "linear", limit: WHOLE_LISTING, showDisabled: true },
      {
        toolkit: "linear",
        limit: WHOLE_LISTING,
        showDisabled: true,
        cursor: "page_2",
      },
    ]);
  });

  test("a config of ours on a later page is the one a connection is begun against", async () => {
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async (query: unknown) =>
            (query as { cursor?: string }).cursor === undefined
              ? { items: [BY_HAND], nextCursor: "page_2" }
              : { items: [OURS], nextCursor: null },
        },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
    );

    await broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl: RETURN_URL,
    });

    // Reading one page here answers "this deployment has no config for linear" and sends an
    // administrator to remove and re-add an app whose config is sitting on page two.
    expect(linked).toEqual([
      ["user_1", "ac_ours", { callbackUrl: RETURN_URL }],
    ]);
  });

  test("a cursor that is not a cursor is refused rather than read as the end of the list", async () => {
    let calls = 0;
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => {
            calls += 1;
            return { items: [{ id: "ca_1" }], nextCursor: 42 };
          },
          delete: async (id: string) => {
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
    );

    const refusal = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    // Read as absent, a cursor this deployment cannot follow is a truncated page wearing the
    // clothes of a complete answer — which is the one thing this guard exists to make impossible.
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(deleted).toEqual([]);

    /*
     * THE REFUSAL HAS TO BE THIS ONE AND NOT THE LOOP GUARD NEXT DOOR, which is what these two
     * assertions are for and what a mutation run proved they had to be. Coerce the unreadable
     * cursor to "" and the paging sends a SECOND request carrying it, gets the same page back, and
     * refuses — with a sentence saying Composio answered the same page twice, which is a complaint
     * about the vendor for something this deployment did. One request went out, and the sentence
     * names what arrived where a cursor belongs.
     */
    expect(calls).toBe(1);
    expect(refusal.message).toMatch(/where the cursor to the next page/);
  });

  /**
   * A CURSOR WITH NOTHING IN IT IS THE END OF THE LISTING, NOT A REFUSAL — AND THE VENDOR'S OWN
   * TYPES PERMIT IT.
   *
   * All four list responses in the installed client declare `next_cursor?: string | null`
   * (`@composio/client` 0.1.0-alpha.76, `resources/auth-configs.d.ts:248`,
   * `connected-accounts.d.ts:4987`, `toolkits.d.ts:326`, `tools.d.ts:204`), so `""` is type-legal
   * on the wire; both transformers write `response.next_cursor ?? null`, which does not catch it;
   * and it therefore reached the guard and became a hard refusal. What that refusal takes down is
   * not one call: `revoke`, `authorize`, `ensureAuthConfig`, `deleteAuthConfig` and `isConnected`
   * all read one of these two listings, so every app in the deployment stops working at once, for
   * as long as the vendor sends it — over a field whose whole content is that it has none.
   *
   * AND THERE IS NO SECOND REQUEST IT COULD HAVE MEANT. An empty cursor is exactly what this loop
   * sends when it has no position: the first request omits the field. Following it asks for page
   * one again, which is why the alternative reading ends in the loop guard next door accusing
   * Composio of answering the same page twice — a complaint about the vendor for something this
   * deployment did.
   *
   * THE ASSERTION IS ON WHAT WENT OUT AS WELL AS ON WHAT CAME BACK. An implementation that read the
   * empty cursor as the end and ALSO sent a second request would answer identically here without
   * the call count, and it is the second request that is the defect.
   */
  for (const { shape, cursor } of [
    { shape: "an empty string", cursor: "" },
    { shape: "a string of blank space", cursor: "   " },
  ]) {
    test(`a cursor Composio sent as ${shape} ends the listing rather than refusing it`, async () => {
      let calls = 0;
      const deleted: string[] = [];
      const { broker } = buildComposioClient(
        fakeVendor({
          authConfigs: { list: ourGmailConfig },
          connectedAccounts: {
            list: async () => {
              calls += 1;
              return { items: [{ id: "ca_1" }], nextCursor: cursor };
            },
            delete: async (id: string) => {
              deleted.push(id);
              return WITHDRAWN;
            },
          },
        }),
      );

      expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
        true,
      );
      expect(deleted).toEqual(["ca_1"]);
      expect(calls).toBe(1);
    });
  }

  /**
   * AND THE SAME ON THE CONFIG LISTING, WHICH IS THE HALF THIS FILE KEEPS FORGETTING.
   *
   * One cursor guard serves both listings, so a fix written against the accounts path is a fix
   * everywhere — and a test written only against the accounts path is a test that cannot tell the
   * difference. Removing an app reads this listing and nothing else, so an empty cursor refused
   * here is an app nobody can withdraw.
   */
  test("an empty cursor ends the config listing too, so the app can still be removed", async () => {
    let calls = 0;
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => {
            calls += 1;
            return { items: [OURS], nextCursor: "" };
          },
          delete: async (id: string) => {
            deleted.push(id);
          },
        },
      }),
    );

    await broker.deleteAuthConfig("linear");

    expect(deleted).toEqual(["ac_ours"]);
    expect(calls).toBe(1);
  });

  test("a cursor that never advances is refused rather than followed for ever", async () => {
    let calls = 0;
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => {
            calls += 1;
            if (calls > 20) throw new Error("The paging did not terminate.");
            return { items: [{ id: "ca_1" }], nextCursor: "page_2" };
          },
          // The delete ANSWERS rather than refusing, which is what makes this test able to fail: a
          // reader that follows no cursor withdraws `ca_1`, reports a completed disconnection, and
          // would satisfy any assertion that only asked for a refusal of some kind.
          delete: async (id: string) => {
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
    );

    const refusal = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    // A vendor answering the same cursor for ever is a hung request rather than a long one, and the
    // caller here is a person waiting on a page they pressed disconnect from.
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    // EXACTLY TWO, AND `toBeLessThanOrEqual(3)` WAS THE SLACK THAT PINNED NOTHING. The first
    // request carries no cursor; the second carries `page_2`; the third would carry `page_2` again,
    // which is the repetition the guard exists to catch — so it is refused before it is made and
    // two is the only count this guard can produce. A bound of three was green over a guard that
    // allowed one repeat before refusing, which is a guard that has stopped answering the question
    // "did following the cursor advance". It also read as an assertion about the CEILING, which is
    // the other test, and which stops at 200.
    expect(calls).toBe(2);
    expect(deleted).toEqual([]);
  });

  test("a cursor that advances for ever is stopped at a ceiling, and stopping is a refusal", async () => {
    let calls = 0;
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => {
            calls += 1;
            // A cursor that is different every time defeats the same-page guard above, so this is
            // the one shape only the ceiling catches. The throw is the test's own stop: without a
            // ceiling in the adapter this listing has no end at all.
            if (calls > 200) throw new Error("The paging did not terminate.");
            // One row a page, so the row count in the refusal is a figure somebody counted rather
            // than the page size this deployment asked for.
            return {
              items: [{ id: `ca_${calls}` }],
              nextCursor: `page_${calls}`,
            };
          },
          delete: async (id: string) => {
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
    );

    const refusal = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    // Stopping is the easy half; the half that matters is that stopping is not answering. A ceiling
    // that returned the rows it had would be the page ceiling again, further out and harder to see.
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(deleted).toEqual([]);

    // The number of pages that happened, and the number the sentence states, are the same number.
    expect(calls).toBe(PAGES_BEFORE_REFUSING);
    expect(refusal.message).toMatch(
      new RegExp(`answered ${PAGES_BEFORE_REFUSING} pages`),
    );

    // And the sentence asserts no page size nobody measured. `at 1000 rows each` was the limit this
    // deployment ASKED for, stated as a fact about what Composio sent — these pages carry one row.
    expect(refusal.message).not.toMatch(new RegExp(`${WHOLE_LISTING} rows`));
    expect(refusal.message).toMatch(
      new RegExp(`${PAGES_BEFORE_REFUSING} rows in all`),
    );
  });
});

/**
 * The two vendor answers that are single objects, and what is actually in doubt about each.
 *
 * THE CONTAINER IS NOT, WHICH IS A CORRECTION TO WHAT THESE USED TO ASSERT. Both answers were once
 * fed a bare `null` on the argument that a single object read straight off an `await` has a declared
 * type that only looks settled. Running `@composio/core` 0.18.1 settles it for real, on both paths
 * and for different reasons: `getRawComposioToolBySlug` ends in a throwing `ToolSchema.parse`
 * (`src/models/Tools.ts:719`), and `connectedAccounts.link` builds its answer with
 * `createConnectionRequest(...)` inside a try that turns everything else into
 * `ComposioFailedToCreateConnectedAccountLink` (`src/models/ConnectedAccounts.ts:420-453`). So
 * neither can hand over something that is not an object, and the refusals that stood for that were
 * branches no answer could reach.
 *
 * WHAT IS IN DOUBT IS EACH ONE'S ONE COPIED FIELD. The tool's `toolkit.slug` is a required string
 * that `z.string()` lets be empty, and the request's `redirectUrl` is `response.redirect_url`
 * carried across untouched by a builder that validates nothing. Those are what these tests are
 * about now, and both are shapes Composio can actually send.
 */
describe("a vendor answer that is one object rather than a listing", () => {
  /** The call `execute` is made with in this section, which is a mismatch test's whole setup. */
  const GMAIL_CALL = {
    slug: "GMAIL_FETCH_EMAILS",
    toolkit: "gmail",
    userId: "user_1",
    version: "20260903_00",
  };

  /**
   * A RESOLVE THAT FAILED IS A CALL THAT MUST NOT RUN, WHICH IS THE HALF WORTH KEEPING.
   *
   * This test used to hand the resolve a bare `null` and assert that reading a field off it was
   * refused rather than crashed. `@composio/core` 0.18.1 cannot answer that: `getRawComposioToolBySlug`
   * ends in `transformToolCases`, whose last act is a throwing `ToolSchema.parse`
   * (`src/models/Tools.ts:719`, `:193`), so a null answer raises `TypeError: null is not an object
   * (evaluating 'tool.input_parameters')` and anything else that is not a tool raises a `ZodError` —
   * neither of which reaches a reader in the adapter. The guard it covered is gone; the property
   * underneath it is not, and this is that property asked of an input the vendor can actually
   * produce.
   */
  test("a resolve the SDK could not read refuses, and nothing is run", async () => {
    const ran: unknown[] = [];
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioToolBySlug: async () => {
            throw new TypeError(
              "null is not an object (evaluating 'tool.input_parameters')",
            );
          },
          execute: async (...call: unknown[]) => {
            ran.push(call);
            return { successful: true, data: {} };
          },
        },
      }),
    );

    const refusal = await failureOf(actions.execute(GMAIL_CALL, {}));

    // `./composio` puts whatever comes out of here into a model's context and an audit row, so the
    // crash is carried rather than quoted and the sentence names the one act that changes anything.
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/GMAIL_FETCH_EMAILS/);
    expect(refusal.message).toMatch(/@composio\/core/);
    expect(ran).toEqual([]);
  });

  test("an app the vendor named with nothing is not reported as no app at all", async () => {
    const ran: unknown[] = [];
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioToolBySlug: async () => ({
            slug: "GMAIL_FETCH_EMAILS",
            name: "Fetch emails",
            // The one toolkit fault a passing `ToolSchema.parse` still admits: `ToolkitSchema`
            // spells the slug required and `z.string()` is satisfied by the empty string. A bare
            // string where `{ slug }` belongs — what this fixture used to be — raises a `ZodError`
            // inside the SDK and never arrives.
            toolkit: { slug: "", name: "Gmail" },
          }),
          execute: async (...call: unknown[]) => {
            ran.push(call);
            return { successful: true, data: {} };
          },
        },
      }),
    );

    const refusal = await failureOf(actions.execute(GMAIL_CALL, {}));

    /*
     * THE TWO FACTS ARE NOT THE SAME AND THEIR REMEDIES ARE NOT EITHER. "Composio resolves that
     * action to no app at all" is a statement about the action, and the sentence carrying it tells
     * an administrator to refresh the app's tools — right for a slug recorded against a url that
     * has since changed, and useless for an SDK that has begun answering a different shape. The
     * toolkit here is PRESENT and its name is blank, which is neither of those.
     */
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).not.toMatch(/no app at all/);
    expect(ran).toEqual([]);
  });

  test("an action resolved with a null app is refused rather than crashed over", async () => {
    /*
     * THE SAME `undefined`-ONLY EXEMPTION AS THE THREE FIELD GUARDS IN {@link actionOf}, ONE CALL
     * OVER, AND IT FAILS HARDER. "Composio named no app for this action" is a state this block
     * already has a sentence for — `ran ?? "no app at all"` — so absence is an answer here; `null`
     * is the wire's other spelling of it, and `answeredApp !== undefined` read it as PRESENT and
     * then took `.slug` off it. That is a bare "null is not an object" thrown from outside every
     * vendor `try` in the adapter, which is the one outcome this file's sentences may never become:
     * `./composio` puts what comes out of `execute` into a model's context and an audit row.
     *
     * NOTHING IS RUN EITHER WAY, WHICH IS THE HALF THAT WAS NEVER IN DOUBT AND IS ASSERTED ANYWAY.
     * The refusal exists because the gate in `./access` cleared this run against the app the
     * connection names, and an action the vendor attributes to nothing cannot be shown to be that
     * app.
     */
    const ran: unknown[] = [];
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioToolBySlug: async () => ({
            slug: "GMAIL_FETCH_EMAILS",
            name: "Fetch emails",
            toolkit: null,
          }),
          execute: async (...call: unknown[]) => {
            ran.push(call);
            return { successful: true, data: {} };
          },
        },
      }),
    );

    const refusal = await failureOf(actions.execute(GMAIL_CALL, {}));

    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/no app at all/);
    expect(refusal.message).toMatch(/GMAIL_FETCH_EMAILS/);
    expect(ran).toEqual([]);
  });

  test("a redirect that is not a url is refused rather than handed to a browser", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: [OURS] }) },
        connectedAccounts: {
          link: async () => ({
            redirectUrl: { href: "https://backend.composio.dev/s/a-link" },
          }),
        },
      }),
    );

    /*
     * PRESENT, TRUTHY AND NOT A URL, which is the one shape the `if (!redirectUrl)` guard beside it
     * cannot see. What is on the other side of that return is a `Location` header and a person's
     * browser, so `[object Object]` would be a page nobody can visit, reported as the consent
     * screen they were sent to.
     */
    const refusal = await failureOf(
      broker.authorize({
        userId: "user_1",
        toolkit: "linear",
        returnUrl: RETURN_URL,
      }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    /*
     * AND IT IS THE SHAPE REFUSAL RATHER THAN THE ONE A LINE BELOW IT. `authorize` writes two
     * sentences one line apart — this one and the `!redirectUrl` "connected by entering a
     * credential rather than by visiting a page" — and a test asserting only "it refused, and not
     * in a crash's words" cannot tell them apart: replacing this sentence with that one verbatim
     * left this test green. The remedies are different acts by different people, so the sentence
     * is named.
     */
    expectOnlyRefusal(refusal.message, "redirectPage", "linear");
  });
});

/**
 * The field guards, held to the behaviour each was written for.
 *
 * EVERY TEST HERE COVERS A GUARD THAT WAS ALREADY IN THE FILE AND HAD NOTHING HOLDING IT. That is
 * worse than an untested new behaviour rather than better: a guard nothing reddens for is read by
 * the next person as ceremony over a field the SDK's own types already promise, and deleting it
 * leaves a green suite. Each one below was therefore checked by removing the guard it covers and
 * watching this test fail.
 */
describe("what a malformed field of a row actually costs", () => {
  const CATALOGUE_ROWS: {
    fault: string;
    row: unknown;
    /*
     * THE REFUSAL BY NAME, AND THE ROW IT WAS RAISED OVER, RATHER THAN A WORD OUT OF ITS PROSE.
     * This column held a bare `RegExp` and the loop asserted presence only, so the six patterns
     * were not mutually exclusive: `/slug/` matched the NAME fault's sentence ("gmail is a slug
     * rather than a title") and `/name/` matched the SLUG fault's ("the slug is the only name this
     * deployment has for an app"), and swapping which field the two guards read left all six green.
     * {@link expectOnlyRefusal} asserts the named sentence AND the absence of every sibling in the
     * registry, which is the cross-check this table was the one place in the file to go without.
     */
    says: RefusalName;
    at?: string;
  }[] = [
    {
      fault: "a slug that arrived as null",
      // The slug is the only name this deployment has for an app: it is what enabling one writes
      // into a url and what every later call names, so a row without one is an app whose Add button
      // records something nothing can act on. Deleting this guard left the suite green.
      row: { slug: null, name: "Gmail", meta: {} },
      /*
       * THE WHOLE CLAUSE RATHER THAN THE WORD, BECAUSE THE TWO SENTENCES EACH CARRY THE OTHER'S
       * WORD. This asked `/slug/` and its sibling two rows down asked `/name/`, and the slug's own
       * refusal says "The slug is the only NAME this deployment has for an app" while the name's
       * says "and gmail is a SLUG rather than a title" — so each matched the other's fault, and
       * swapping which field the two guards read left all six of these tests green. What
       * discriminates is the position the value was sent in, which is the phrase both refusals are
       * built on and the only part of either that a swap moves.
       */
      says: "catalogueSlug",
      at: "row 1 of Composio's app catalogue",
    },
    {
      fault: "a logo that is not an address",
      // This value is put in an image address on an administrator's picker. Deleting this guard
      // also left the suite green: the object went into `src` and the page showed a broken image.
      row: {
        slug: "gmail",
        name: "Gmail",
        meta: { logo: { url: "https://example.test/gmail.png" } },
      },
      says: "catalogueLogo",
      at: "gmail",
    },
    {
      fault: "a name that arrived as null",
      // `?? ""` here is an app in an administrator's picker with nothing written on it, and `gmail`
      // is a slug rather than a title.
      row: { slug: "gmail", name: null, meta: {} },
      // The position rather than the word, for the reason the slug row above gives at length.
      says: "catalogueName",
      at: "row 1 of Composio's app catalogue",
    },
    {
      fault: "a description that is not text",
      row: { slug: "gmail", name: "Gmail", meta: { description: 12 } },
      says: "catalogueDescription",
      at: "gmail",
    },
    {
      fault: "a category with no name",
      // The categories are the words a person chooses an app by, so a blank one is a filter nobody
      // can use rather than a cosmetic gap.
      row: {
        slug: "gmail",
        name: "Gmail",
        meta: { categories: [{ id: "productivity" }] },
      },
      says: "catalogueCategoryName",
      at: "gmail's category 1",
    },
    {
      fault: "an action count that arrived as a string",
      // `Number("63")` is the defect this whole sweep is about: a vendor change turned into a
      // plausible figure, shown BEFORE anybody enables an app, that nobody would think to question.
      row: { slug: "gmail", name: "Gmail", meta: { tools_count: "63" } },
      says: "catalogueActionCount",
      at: "gmail",
    },
  ];

  for (const { fault, row, says, at } of CATALOGUE_ROWS) {
    test(`a catalogue row with ${fault} stops the directory`, async () => {
      const { broker } = buildComposioClient(
        fakeVendor({ toolkits: { list: async () => ({ items: [row] }) } }),
        () => 1_000_000,
      );

      const refusal = await failureOf(broker.listApps());

      expect(refusal).toBeInstanceOf(BrokerRefusalError);
      expectOnlyRefusal(refusal.message, says, at);
    });
  }

  /**
   * THE ACTION ROW HAS ONE FAULT LEFT, AND FOUR TESTS HERE WERE ABOUT SHAPES IT CANNOT HAVE.
   *
   * A description that is not text, an `inputParameters` that is a string of JSON, tags that are
   * not all labels and a version that is a number each had a row in a table beside this one, and
   * each was answered by a refusal in the adapter. Running `@composio/core` 0.18.1 shows all four
   * dying one layer earlier: `transformToolCases` ends in `ToolSchema.parse(...)` — a throwing
   * parse, not the warn-only `transform()` the other three listings go through
   * (`src/models/Tools.ts:193`) — and both calls this adapter makes run through it (`:561`, `:719`).
   * Every one of those four fixtures produces a `ZodError` from inside the SDK, which `./composio`'s
   * `isSchemaMismatch` already recognises and answers with the same package remedy. So the tests
   * were green over guards nothing could reach, which is the worst of the three states: a reader
   * takes both the guard and the test as proof the path is watched.
   *
   * WHAT `ToolSchema` LEAVES OPEN IS THE ONE BELOW. `slug: z.string()` is satisfied by the empty
   * string, and this slug is not a label: it becomes `mcp_tools.name`, which is NOT NULL and half
   * that table's primary key, it is what a grant points at, and it is what a later call sends back
   * to Composio. That is the fault this listing still has to refuse, and it is the only one.
   */
  test("an action whose slug is blank stops the listing rather than being written", async () => {
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          list: async () => ({
            items: [
              { slug: "GMAIL_FETCH_EMAILS", name: "Fetch emails" },
              { slug: "   ", name: "Send mail" },
            ],
          }),
        },
      }),
    );

    const refusal = await failureOf(
      actions.listActions("gmail", { limit: WHOLE_LISTING }),
    );

    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/slug/);
    // Which row, because an administrator reading this off a Plugins page has a listing of sixty
    // actions and no other way to tell which of them Composio named with nothing.
    expect(refusal.message).toMatch(/row 2/);
    // And what it cost them, which is nothing: a refusal here leaves the actions already recorded
    // for the app in place rather than replacing them with a listing one row short.
    expect(refusal.message).toMatch(/tools already held are untouched/);
  });

  /**
   * A CATEGORY THAT IS NOT A CATEGORY IS DESCRIBED AS WHAT ARRIVED, NOT AS A MISSING NAME.
   *
   * The non-object guard here was deleted on the stated ground that the SDK dereferences a category
   * and dies before this file sees one. Running `@composio/core` 0.18.1 says otherwise: `("crm").id`
   * is `undefined` and not a throw, so a string, a number or a boolean in that list survives
   * `transformToolkitListResponse` — only null and undefined die there. What the refusal then said
   * was "Composio sent nothing where the name of gmail's category 1 belongs", about a value that
   * was the string "crm", which sends an operator looking in a dashboard for a category with a
   * missing name. There is no such category.
   *
   * THE ASSERTION IS ON THE TWO SENTENCES BEING DIFFERENT, because a test that only required a
   * refusal was green over the whole defect: the catalogue was refused either way, and what was
   * wrong was what the operator was told.
   */
  for (const { fault, entry, names } of [
    { fault: "a string", entry: "crm", names: /a string/ },
    { fault: "a number", entry: 7, names: /a number/ },
  ]) {
    test(`a category that arrived as ${fault} is named as one rather than as a missing name`, async () => {
      const { broker } = buildComposioClient(
        fakeVendor({
          toolkits: {
            list: async () => ({
              items: [
                { slug: "gmail", name: "Gmail", meta: { categories: [entry] } },
              ],
            }),
          },
        }),
        () => 1_000_000,
      );

      const refusal = await failureOf(broker.listApps());

      expect(refusal).toBeInstanceOf(BrokerRefusalError);
      expect(refusal.message).not.toMatch(A_CRASH);
      expect(refusal.message).toMatch(/gmail's category 1/);
      expect(refusal.message).toMatch(names);
      // And NOT the sentence for a category object whose name Composio omitted, which is the other
      // fault and the other thing to go looking at.
      expect(refusal.message).not.toMatch(/Composio sent nothing/);
    });
  }

  /**
   * A BLANK IDENTIFIER IS DESCRIBED AS BLANK RATHER THAN AS "A STRING".
   *
   * {@link textOf} decides emptiness on the TRIMMED value and `sent` tested `value === ""`, so the
   * two disagreed about exactly one shape — the padded blank, which is the one a wire value
   * actually arrives in. A config id of three spaces was refused for being empty and then described
   * as "a string", which is a sentence with no finding in it: a string is what an id IS, so the
   * reader is told the field was right and the call refused anyway.
   */
  test("a config id that is nothing but spaces is not reported as a string", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [{ id: "   ", name: "Linear (OpenBot)", status: "ENABLED" }],
          }),
        },
      }),
    );

    const refusal = await failureOf(broker.deleteAuthConfig("linear"));
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect((refusal.cause as Error).message).toMatch(/blank space/);
    expect((refusal.cause as Error).message).not.toMatch(
      /Composio sent a string where/,
    );
  });

  /**
   * THE THREE ACTION FIELDS THIS FILE HANDS ON, AND WHAT EACH BECOMES WHERE IT LANDS.
   *
   * The four deleted guards next door were deleted correctly — `ToolSchema.parse` really does raise
   * a `ZodError` for them — and the argument was then taken one step too far, past the fields
   * {@link ComposioAction} promises to `./composio` and `./store`. The parse is a fact about
   * `getRawComposioTools` in one version of one package; the declaration is what the seam a test
   * satisfies with a literal, and what the next version is read against, actually rest on.
   *
   * WHAT THAT COSTS IS NOT A REFUSAL, WHICH IS WHY IT BELONGS HERE. `storableTools` writes
   * `(tool.description ?? "").replaceAll(NUL, "")` and `tool.version?.replaceAll(NUL, "")`, so a
   * description or a version that is not a string is a bare "42.replaceAll is not a function"
   * thrown from outside every vendor `try` in the adapter — a crash where this file's whole
   * contract is a sentence. An `inputParameters` that is not an object is quieter: it is stored as
   * the action's input schema and shown to a model as Composio's own.
   *
   * EACH ASSERTS THE FIELD IT IS ABOUT, because a table of refusals that only required a refusal
   * would pass with one guard standing in for three.
   */
  for (const { fault, row, names } of [
    {
      fault: "a description that is not text",
      row: { slug: "GMAIL_FETCH_EMAILS", description: 42 },
      names: /description/,
    },
    {
      fault: "an input schema that is not an object",
      row: { slug: "GMAIL_FETCH_EMAILS", input_parameters: "not-a-schema" },
      names: /input schema/,
    },
    {
      fault: "a version that is not text",
      row: { slug: "GMAIL_FETCH_EMAILS", version: 20_260_903 },
      names: /version/,
    },
  ]) {
    test(`an action with ${fault} stops the listing rather than crossing the seam`, async () => {
      const { actions } = buildComposioClient(
        fakeVendor({ tools: { list: async () => ({ items: [row] }) } }),
      );

      const failure = await failureOf(
        actions.listActions("gmail", { limit: WHOLE_LISTING }),
      );

      expect(failure.message).not.toMatch(A_CRASH);
      expect(failure.message).toMatch(names);
      // The tools already recorded for the app are untouched, which is what makes refusing the
      // right answer rather than a worse outage than the one being avoided.
      expect(failure.message).toMatch(/tools already held are untouched/);
    });
  }

  /**
   * AND AN ACTION THAT PUBLISHES NONE OF THEM IS ORDINARY. Composio genuinely ships actions with no
   * description and no version, and one with no parameters at all arrives with none — the SDK
   * normalizes `{}` to absent before parsing. Absence is a fact about the action; present-and-wrong
   * is a fact about the answer. A guard that could not tell them apart would refuse most of the
   * catalogue.
   */
  test("an action that publishes no description, schema or version is still listed", async () => {
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          list: async () => ({ items: [{ slug: "GMAIL_FETCH_EMAILS" }] }),
        },
      }),
    );

    expect(
      await actions.listActions("gmail", { limit: WHOLE_LISTING }),
    ).toEqual([
      {
        slug: "GMAIL_FETCH_EMAILS",
        description: undefined,
        inputParameters: undefined,
        tags: undefined,
        version: undefined,
      },
    ]);
  });

  /**
   * AND `null` IS HOW THE WIRE SPELLS THAT ABSENCE, WHICH IS THE HALF THE THREE GUARDS ABOVE MISSED.
   *
   * `./composio` documents the exemption on the field beside these — "`null` IS NOT ONE OF THESE,
   * and that is deliberate": an action with no version is listed with none, JSON says so with a
   * null, and refusing it turns a healthy refresh into a total failure for every app that publishes
   * one. Nothing about a null description or a null input schema is different, and a refusal here
   * is the same total failure one layer lower down: the whole listing stops, so every OTHER action
   * on the app loses its effect, its version and the grants pointing at it, on every refresh,
   * permanently.
   *
   * WHAT EACH LANDS ON ALREADY READS A NULL. `./composio` maps `description ?? ""` and
   * `inputParameters ?? {}` and `version?.trim()`, so the value crossing this seam as absent is the
   * value those three lines were written for. So a null is normalized to absent HERE rather than
   * handed on, because {@link ComposioAction} spells all three optional-and-typed and a null
   * travelling under that declaration is the same untrue assertion the guards exist to stop.
   */
  test("an action whose description, schema or version is null is still listed", async () => {
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          list: async () => ({
            items: [
              {
                slug: "GMAIL_FETCH_EMAILS",
                description: null,
                input_parameters: null,
                version: null,
              },
            ],
          }),
        },
      }),
    );

    expect(
      await actions.listActions("gmail", { limit: WHOLE_LISTING }),
    ).toEqual([
      {
        slug: "GMAIL_FETCH_EMAILS",
        description: undefined,
        inputParameters: undefined,
        tags: undefined,
        version: undefined,
      },
    ]);
  });

  test("a nameless config stops the removal rather than being left standing", async () => {
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [OURS, { id: "ac_nameless", status: "ENABLED" }],
          }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
          },
        },
      }),
    );

    /*
     * WITHOUT THE GUARD THIS IS A REPORTED SUCCESS. A name read as "" fails the suffix test, so the
     * row is sorted into somebody else's dashboard work and left standing — and `deleteAuthConfig`
     * returns quietly, after which `removeServer` deletes the app's row. The config and every grant
     * made against it outlive the removal with nothing in this deployment naming them.
     */
    const refusal = await failureOf(broker.deleteAuthConfig("linear"));
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    /*
     * THE FIELD IS ASKED OF THE SENTENCE THAT ESTABLISHED IT, NOT OF THE ONE THAT SUMS BOTH UP.
     * This asked `/name/` of `message`, whose whole clause about the leftover rows is "with no id
     * or no name" — a phrase carrying both words, so this test and the one below it each passed on
     * the other's fault, and swapping the two guards in `readableConfigs` left the pair green. The
     * finding lives on `cause`, where one row's own reading is written down, so that is where it is
     * read from — and the other field's sentence is asserted absent, which is the half that makes
     * the assertion discriminating rather than merely more specific.
     */
    expectOnlyRefusal(
      everythingSaidBy(refusal).join("\n"),
      "configName",
      "row 2 of Composio's authorization configs for linear",
    );
    /*
     * AND THE CONFIG THAT WAS READABLE IS GONE, WHICH THIS ASSERTED THE OPPOSITE OF ON PURPOSE AND
     * IS CHANGED ON PURPOSE. It required `[]` — not even the row that WAS readable — on the ground
     * that a half-done removal reported as done is the state being avoided. The first half of that
     * is right and the second half does not describe this: the call still refuses, so `removeServer`
     * never deletes the app's row and nothing is reported as done. What the old shape actually
     * bought was a permanent block. The unreadable row is unreadable on every retry, so the app
     * could never be removed at all while a config of ours held live grants the whole time — which
     * is the defect the accounts path was corrected for one wave earlier, sitting one function
     * away. Every config this deployment CAN name goes, and the row it cannot is what the refusal
     * counts.
     */
    expect(deleted).toEqual([["ac_ours", { revoke_on_delete: true }]]);
    // And the remedy for the row that is left is the dashboard rather than the button just pressed,
    // because the next press meets exactly the same unreadable row.
    expect(refusal.message).toMatch(/Composio's own dashboard/);
  });

  test("a config with no id stops the removal, and no delete is sent", async () => {
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [{ name: "Linear (OpenBot)", status: "ENABLED" }],
          }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
          },
        },
      }),
    );

    /*
     * A DELETE WITHOUT AN ID IS A REQUEST COMPOSIO IS FREE TO READ AS ANYTHING, answered however it
     * likes, after which this deployment records that the app was withdrawn. The assertion is on
     * what went out rather than on what came back for exactly that reason.
     */
    const refusal = await failureOf(broker.deleteAuthConfig("linear"));
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    // Asked of the sentence that established it and not of the shared "with no id or no name"
    // clause, for the reason the test above gives: that phrase carries both words.
    expectOnlyRefusal(
      everythingSaidBy(refusal).join("\n"),
      "configId",
      "row 1 of Composio's authorization configs for linear",
      // Every row of this listing is one nothing could sort, so the top sentence is that state's
      // own and the id fault is what hangs off it. Named rather than tolerated, because a chain
      // carrying a sibling nobody declared is the shape this helper exists to redden.
      ["unreadableNothingRemoved"],
    );
    expect(deleted).toEqual([]);
  });

  /**
   * NOTHING READABLE AT ALL IS NOT A REMOVAL THAT WENT HALF WAY, AND THE COUNT SAID IT WAS.
   *
   * Every one of this listing's rows is one `readableConfigs` could not sort, so there is nothing of
   * this deployment's to delete and nothing of anybody else's to leave standing — `held` is empty,
   * which is the branch above this one, and `ours` is empty, which is the delete loop's. The loop
   * therefore ran over nothing and the partial-withdrawal sentence reported "Composio removed 0 of
   * this deployment's 0 authorization configs for linear": two figures measured off a set that was
   * never read, in the one sentence an operator is meant to act on. Its remedy is wrong with them —
   * "the app has not been FULLY withdrawn" says a part of it was — and the reachable half of the
   * finding is the rows themselves, which is a dashboard reading rather than a second press.
   */
  test("a listing whose only rows are unreadable is refused as that rather than as half a removal", async () => {
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { name: "Linear (OpenBot)", status: "ENABLED" },
              { id: "ac_b", status: "ENABLED" },
            ],
          }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
          },
        },
      }),
    );

    const refusal = await failureOf(broker.deleteAuthConfig("linear"));

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    // No count of a set nothing read, in either position.
    expect(refusal.message).not.toMatch(/removed \d+ of this deployment's \d+/);
    // What actually happened, and what was actually found.
    expect(refusal.message).toMatch(/nothing was deleted/);
    expect(refusal.message).toMatch(/2 of its authorization configs/);
    expect(deleted).toEqual([]);
    // And both readings travel, because the count is deliberately the whole of the sentence.
    const said = everythingSaidBy(refusal).join("\n");
    expect(said).toMatch(/where the id of row 1/);
    expect(said).toMatch(/where the name of row 2/);
  });

  test("an unreadable status names every config's own, not the first one's for all of them", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: "ac_a", name: "Linear (OpenBot)", status: "PENDING" },
              { id: "ac_b", name: "Linear (OpenBot)", status: "SUSPENDED" },
            ],
          }),
        },
      }),
      () => 1_000_000,
    );

    const refusal = await failureOf(
      broker.authorize({
        userId: "user_1",
        toolkit: "linear",
        returnUrl: RETURN_URL,
      }),
    );

    /*
     * TWO CONFIGS, TWO STATUSES, AND THE SENTENCE COUNTED BOTH AND QUOTED ONE — asserting of the
     * pair a fact it had established of the first. The status is quoted because it is the one
     * thing an operator can search a dashboard and a changelog for, and an operator given PENDING
     * would never find the config that says SUSPENDED.
     */
    expect(refusal.message).toMatch(/"PENDING"/);
    expect(refusal.message).toMatch(/"SUSPENDED"/);
    expect(refusal.message).toMatch(/2 of this deployment's 2/);
  });

  /**
   * THE ONE THAT DID NOT FIT IS ONE WORD, AND THE SENTENCE SAID "1 other words".
   *
   * `STATUSES_NAMED` bounds how many distinct statuses a refusal names, and the tail counting what
   * was left out is written as a bare plural — in a sentence whose very next clause conjugates its
   * own verb for the count. An operator reading a refusal that cannot get its own number right is
   * being asked to trust it about an authorization config.
   */
  test("the statuses that did not fit are counted in the number's own words", async () => {
    const WORDS = [
      "PENDING",
      "SUSPENDED",
      "EXPIRED",
      "REVOKED",
      "ARCHIVED",
      "DRAFT",
    ];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: WORDS.map((status, index) => ({
              id: `ac_${index}`,
              name: "Linear (OpenBot)",
              status,
            })),
          }),
        },
      }),
      () => 1_000_000,
    );

    const refusal = await failureOf(
      broker.authorize({
        userId: "user_1",
        toolkit: "linear",
        returnUrl: RETURN_URL,
      }),
    );

    // Five named and one left over, which is one WORD.
    expect(refusal.message).toMatch(/and 1 other word,/);
    expect(refusal.message).not.toMatch(/1 other words/);
  });

  /**
   * A ROW NOTHING COULD SORT IS THE THIRD FACT THIS SENTENCE HAS, AND A SHADOWED NAME TOOK IT AWAY.
   *
   * `configsFor` answers three things, and one of them is the refusals for rows it could sort into
   * neither pile. Inside the no-enabled-config branch of both `authorize` and `connectWithFields` a
   * local list of the configs whose status is neither word was ALSO called `unreadable`, so the
   * outer one was unreachable from the only place its clause could have been written — and an
   * administrator holding one disabled config beside one row Composio described with no name was
   * told to go and enable the disabled one, full stop. That instruction may not be the remedy at
   * all: the row that could not be sorted may be a config of this deployment's that Composio calls
   * ENABLED, in which case there was nothing to enable and the thing to read is the dashboard.
   *
   * THE DISABLED CLAUSE STAYS, WHICH IS THE POINT OF ASSERTING BOTH. These are two facts about two
   * different rows, and the file's own rule for that shape — stated at length one method up — is two
   * independent clauses rather than a chain, so that neither takes the other's turn.
   */
  test("a disabled config beside a row nothing could sort names both remedies", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: "ac_a", name: "Linear (OpenBot)", status: "DISABLED" },
              { id: "ac_b", status: "ENABLED" },
            ],
          }),
        },
      }),
      () => 1_000_000,
    );

    const refusal = await failureOf(
      broker.authorize({
        userId: "user_1",
        toolkit: "linear",
        returnUrl: RETURN_URL,
      }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(
      /calls 1 of this deployment's 1 authorization configs for linear disabled/,
    );
    expect(refusal.message).toMatch(
      /1 of its authorization configs for linear in a way this deployment cannot read/,
    );
  });

  /** The same block, one method over, because it is a copy of that one rather than a call to it. */
  test("the typed-secret path names the row nothing could sort too", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: "ac_a", name: "Linear (OpenBot)", status: "DISABLED" },
              { id: "ac_b", status: "ENABLED" },
            ],
          }),
        },
      }),
    );

    const refusal = await failureOf(
      broker.connectWithFields({
        userId: "user_1",
        toolkit: "linear",
        authScheme: "API_KEY",
        values: { generic_api_key: "pplx-secret" },
      }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(
      /calls 1 of this deployment's 1 authorization configs for linear disabled/,
    );
    expect(refusal.message).toMatch(
      /1 of its authorization configs for linear in a way this deployment cannot read/,
    );
    // And what they typed is nowhere in it, which is this method's own standing rule.
    expect(refusal.message).not.toMatch(/pplx-secret/);
  });

  test("a status that is not a vendor enum name is described rather than repeated", async () => {
    /*
     * THIS BRANCH IS REACHED PRECISELY BECAUSE THE VALUE IS NOT ONE OF THE WORDS THE CODE EXPECTS,
     * so "it is a closed set of enum names" — the whole argument for quoting it — is the one thing
     * that cannot be assumed here. What arrives is whatever came off the wire, and the refusal it
     * lands in is read off an admin page, written into an app's `lastError` and put in front of a
     * model.
     */
    const WIRE = `<!doctype html>\n<title>502 Bad Gateway</title>\n${"x".repeat(20_000)}`;
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [{ id: "ac_a", name: "Linear (OpenBot)", status: WIRE }],
          }),
        },
      }),
      () => 1_000_000,
    );

    const refusal = await failureOf(
      broker.authorize({
        userId: "user_1",
        toolkit: "linear",
        returnUrl: RETURN_URL,
      }),
    );

    expect(refusal.message).not.toContain("502 Bad Gateway");
    expect(refusal.message).not.toContain("x".repeat(64));
    expect(refusal.message.length).toBeLessThan(1000);
    // Still a refusal, and still one naming the state: what the value IS remains the finding even
    // where the value itself is not safe to repeat.
    expect(refusal.message).toMatch(/neither ENABLED nor DISABLED/);
    expect(refusal.message).toMatch(/a string/);
  });

  test("the config a connection is begun against is chosen in one order everywhere", async () => {
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: "ac_a", name: "Linear (OpenBot)", status: "ENABLED" },
              { id: "ac_B", name: "Linear (OpenBot)", status: "ENABLED" },
            ],
          }),
        },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
      () => 1_000_000,
    );

    await broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl: RETURN_URL,
    });

    /*
     * `ac_B` BECAUSE "B" IS 0x42 AND "a" IS 0x61, which is the same answer on every machine. Under
     * `localeCompare` with no locale it is the HOST that decides — an English collation puts
     * `ac_a` first — and the two callers this order exists to keep in step are a person pressing
     * Connect and an administrator pressing Remove, who need not be answered by the same process,
     * container or build of ICU. This pair is the one that tells the two orders apart.
     */
    expect(linked).toEqual([["user_1", "ac_B", { callbackUrl: RETURN_URL }]]);
  });

  test("a created config the answer does not name is reported as possibly standing", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [] }),
          // The create was accepted; what came back carries no id. The answer used to be awaited
          // and dropped, so this was a successful enable of an app whose config nothing here could
          // show existed.
          create: async () => ({}),
        },
      }),
      () => 1_000_000,
    );

    const refusal = await failureOf(
      broker.ensureAuthConfig({
        toolkit: "linear",
        name: "Linear",
        connection: { kind: "consent" },
      }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/may well be standing/);
    expect(refusal.message).toMatch(/enabling linear again finds it/);
  });

  test("a create whose reply the SDK could not read does not claim nothing was created", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [] }),
          /*
           * What `transformCreateAuthConfigResponse` does to an answer with no `auth_config`: it
           * reads `response.auth_config.id` (`@composio/core` 0.18.1,
           * `src/utils/transformers/authConfigs.ts:96-106`) and raises inside the vendor's own
           * package — AFTER the create has been sent and answered.
           */
          create: async (): Promise<never> => {
            throw new TypeError(
              "undefined is not an object (evaluating 'response.auth_config.id')",
            );
          },
        },
      }),
      () => 1_000_000,
    );

    const refusal = await failureOf(
      broker.ensureAuthConfig({
        toolkit: "linear",
        name: "Linear",
        connection: { kind: "consent" },
      }),
    );

    /*
     * THE ONE CONDITION MOST LIKELY TO MEAN THE CONFIG EXISTS WAS THE ONE SAYING IT DID NOT. The
     * `TypeError` row translates a fault raised inside `@composio/core` while it READ a reply, so
     * by the time this sentence is composed the request has gone out and Composio has answered it
     * — and the outcome clause read "no authorization config was created for linear".
     */
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(/no authorization config was created/);
    expect(refusal.message).toMatch(
      /whether an authorization config for linear now stands at Composio is not something this deployment can tell/,
    );
  });

  const UNSETTLED: { fault: string; status: unknown }[] = [
    { fault: "a status this deployment has never heard of", status: "PENDING" },
    { fault: "no status at all", status: undefined },
  ];

  for (const { fault, status } of UNSETTLED) {
    test(`a config of ours with ${fault} refuses in its own words`, async () => {
      const linked: unknown[] = [];
      const { broker } = buildComposioClient(
        fakeVendor({
          authConfigs: {
            list: async () => ({
              items: [{ id: "ac_ours", name: "Linear (OpenBot)", status }],
            }),
          },
          connectedAccounts: {
            link: async (...call: unknown[]) => {
              linked.push(call);
              return { redirectUrl: "https://backend.composio.dev/s/a-link" };
            },
          },
        }),
      );

      const refusal = await failureOf(
        broker.authorize({
          userId: "user_1",
          toolkit: "linear",
          returnUrl: RETURN_URL,
        }),
      );

      /*
       * NEITHER OF THE OTHER TWO REMEDIES, which is the whole of what this asserts. Telling an
       * operator the config is disabled sends them to a dashboard to enable something that may
       * already be enabled, and leaves them with a page insisting on a fact they can see is false;
       * telling them there is no config sends them to remove and re-add an app whose config is
       * sitting right there. The state is UNKNOWN, and only a sentence saying so is honest.
       */
      expect(refusal).toBeInstanceOf(BrokerRefusalError);
      expect(refusal.message).not.toMatch(DISABLED_REMEDY);
      expect(refusal.message).not.toMatch(NO_CONFIG_REMEDY);
      // And still a refusal: consent spent against a config this deployment cannot show is enabled
      // attaches nothing, and cannot be spent again without sending the person round a second time.
      expect(linked).toEqual([]);
    });
  }
});

/**
 * WHAT A FIELD COMPOSIO PADDED IS WORTH, WHICH IS THE FIELD AND NOT THE FIELD PLUS ITS PADDING.
 *
 * `textOf` decided emptiness on the TRIMMED string and answered the PADDED one — a guard that
 * checked one value and passed along another — so every identifier this adapter reads travelled
 * with whatever whitespace the wire wrapped it in. Not one of the four below is cosmetic: three of
 * them are what a later REQUEST names, and the fourth is both sides of the one comparison this
 * file refuses a call on.
 *
 * WHY A VENDOR WOULD SEND ONE AT ALL is the same reason `madeHere` tolerates a trailing space in a
 * config's name: these values pass through dashboards where people type, paste and edit them.
 */
describe("a field Composio padded with whitespace", () => {
  test("a padded slug and title reach the picker as the app's own name", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          list: async () => ({
            items: [
              { slug: "  gmail  ", name: " Gmail ", meta: { tools_count: 63 } },
            ],
          }),
        },
      }),
      () => 1_000_000,
    );

    const [app] = await broker.listApps();

    /*
     * THE SLUG IS THE ONE THAT COSTS SOMETHING. `addBrokeredApp` composes `composio://<slug>` from
     * exactly this value, and `toolkitOf` reads the app back out of that url through a character
     * class that admits no spaces — so a padded slug here is an enabled app whose url names no app
     * at all, and every later call through it refuses.
     */
    expect(app?.slug).toBe("gmail");
    expect(app?.name).toBe("Gmail");
  });

  test("a padded config id is what the delete names, without the padding", async () => {
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: " ac_ours ", name: "Linear (OpenBot)", status: "ENABLED" },
            ],
          }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
          },
        },
      }),
    );

    await broker.deleteAuthConfig("linear");

    // The id is the whole of what a deletion names, and this one was sent verbatim: Composio is
    // asked to remove an object with a name nobody holds, and this deployment records a withdrawal.
    expect(deleted).toEqual([["ac_ours", { revoke_on_delete: true }]]);
  });

  test("a padded account id is what the withdrawal names", async () => {
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({ items: [{ id: " ca_1 " }] }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
            return WITHDRAWN;
          },
        },
      }),
    );

    expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
      true,
    );
    expect(deleted).toEqual([["ca_1", { revoke_on_delete: true }]]);
  });

  test("a padded action slug is recorded as the action rather than as one nothing can call", async () => {
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          list: async () => ({
            items: [{ slug: " GMAIL_FETCH_EMAILS ", version: "20260903_00" }],
          }),
        },
      }),
    );

    const [action] = await actions.listActions("gmail", {
      limit: WHOLE_LISTING,
    });

    // This becomes `mcp_tools.name`, which is half that table's primary key, what a grant points at
    // and what the next call sends back to Composio.
    expect(action?.slug).toBe("GMAIL_FETCH_EMAILS");
  });

  test("a padded app slug on the vendor's answer is not a mismatch", async () => {
    const ran: unknown[] = [];
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioToolBySlug: async () => ({
            slug: "GMAIL_FETCH_EMAILS",
            toolkit: { slug: " gmail " },
          }),
          execute: async (...call: unknown[]) => {
            ran.push(call);
            return { successful: true, data: {}, error: null };
          },
        },
      }),
    );

    /*
     * THE MISMATCH REFUSAL IS THE ONE PLACE THIS FILE REFUSES TO RUN SOMETHING, and it exists for a
     * url edited between a refresh and a call. A padded slug is not that: it is the same app,
     * refused with a sentence naming a remedy — refresh this app's tools — that cannot change what
     * Composio pads.
     */
    await actions.execute(
      {
        toolkit: "gmail",
        slug: "GMAIL_FETCH_EMAILS",
        userId: "user_1",
        version: "20260903_00",
      },
      {},
    );

    expect(ran).toHaveLength(1);
  });

  /**
   * THE CONSENT PAGE IS THE ONE VENDOR VALUE THAT LEAVES THIS PROCESS IN A `Location` HEADER.
   *
   * Every other identifier on this path goes through the file's own trimming read; the url this
   * method answers did not, so a padded one was returned with its padding and put in front of a
   * browser. " https://… " is not an address — the space is percent-encoded or the redirect is
   * refused outright — so a person who pressed Connect lands on nothing, having been told they were
   * being sent to the app's own consent screen.
   */
  test("a padded consent page is the address this person is sent to, without the padding", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: [OURS] }) },
        connectedAccounts: {
          link: async () => ({
            redirectUrl: "  https://backend.composio.dev/s/a-link  ",
          }),
        },
      }),
      () => 1_000_000,
    );

    const begun = await broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl: RETURN_URL,
    });

    expect(begun).toEqual({
      redirectUrl: "https://backend.composio.dev/s/a-link",
    });
  });

  /**
   * AND A URL OF BLANK SPACE IS NO PAGE AT ALL, WHICH IS THE ONE SHAPE BOTH GUARDS LET THROUGH.
   *
   * The shape guard above it asks only whether the value is a string, and `!redirectUrl` is false
   * for "   " — so three spaces cleared both and were handed back as the address of a consent
   * screen. That is the same emptiness this file's own trimming read already calls absent
   * everywhere else: an identifier that reads as present at every glance and is unusable.
   */
  test("a consent page of blank space is no page to visit rather than a page", async () => {
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: [OURS] }) },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "   " };
          },
        },
      }),
      () => 1_000_000,
    );

    const refusal = await failureOf(
      broker.authorize({
        userId: "user_1",
        toolkit: "linear",
        returnUrl: RETURN_URL,
      }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    // The link WAS minted — this is the vendor's answer to it — so the assertion is about what
    // came back rather than about the call not having gone out.
    expect(linked).toHaveLength(1);
    expectOnlyRefusal(refusal.message, "noPageRemedy");
  });

  /**
   * A PADDED STATUS WAS REFUSED AND THEN QUOTED WITHOUT ITS PADDING, WHICH IS A SENTENCE THAT
   * CONTRADICTS ITSELF IN FRONT OF THE OPERATOR READING IT.
   *
   * `=== "ENABLED"` is the RAW status and `named` quotes the TRIMMED one, so " ENABLED " fell
   * through to the no-enabled-config branch and was reported there as `"ENABLED", which is neither
   * ENABLED nor DISABLED`. The remedy attached to it is a package upgrade, for a config that
   * Composio calls enabled and that this deployment made. The two readings of one field now agree,
   * and the config is what a connection is begun against.
   */
  test("a padded ENABLED is the config a connection is begun against", async () => {
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: "ac_ours", name: "Linear (OpenBot)", status: " ENABLED " },
            ],
          }),
        },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
      () => 1_000_000,
    );

    const begun = await broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl: RETURN_URL,
    });

    expect(begun).toEqual({
      redirectUrl: "https://backend.composio.dev/s/a-link",
    });
    expect(linked).toEqual([
      ["user_1", "ac_ours", { callbackUrl: RETURN_URL }],
    ]);
  });

  /** The same read, one method over, because that block is a copy of this one rather than a call. */
  test("a padded ENABLED is the config a typed secret is attached to", async () => {
    const created: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: "ac_ours", name: "Linear (OpenBot)", status: " ENABLED " },
            ],
          }),
        },
        connectedAccounts: {
          create: async (body: unknown) => {
            created.push(body);
            return { id: "ca_made" };
          },
        },
      }),
    );

    expect(
      await broker.connectWithFields({
        userId: "user_1",
        toolkit: "linear",
        authScheme: "API_KEY",
        values: { generic_api_key: "pplx-secret" },
      }),
    ).toEqual({ accountId: "ca_made" });
    expect(created).toHaveLength(1);
  });

  /**
   * AND A PADDED DISABLED IS DISABLED, which is the other half of the same disagreement.
   *
   * `!== "DISABLED"` over the raw value sorted " DISABLED " into the unsettled pile, so an operator
   * holding one disabled config was told their package was out of date and never told the one act
   * that would have got somebody connected: enabling it in Composio's own dashboard.
   */
  test("a padded DISABLED is told as disabled rather than as a word nothing knows", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: "ac_ours", name: "Linear (OpenBot)", status: " DISABLED " },
            ],
          }),
        },
      }),
      () => 1_000_000,
    );

    const refusal = await failureOf(
      broker.authorize({
        userId: "user_1",
        toolkit: "linear",
        returnUrl: RETURN_URL,
      }),
    );

    expect(refusal.message).toMatch(
      /calls 1 of this deployment's 1 authorization configs for linear disabled/,
    );
    expect(refusal.message).not.toMatch(/neither ENABLED nor DISABLED/);
    expectOnlyRefusal(refusal.message, "disabledRemedy");
  });

  /**
   * A PADDED CONNECTION MODE IS THE MODE THE APP WAS ENABLED AS, and it was read as one the app had
   * stopped publishing.
   *
   * `labelsOf` already trims every scheme this deployment records, on the stated ground that a
   * scheme is the NAME of a flow and a padded `" OAUTH2 "` is the app's own. The mode published
   * beside the form's fields is the same word compared against the same recorded one, and it was
   * the one read that skipped the trim — so an app whose vendor padded the mode told an
   * administrator to remove it and add it again, which records the same padded word and comes back
   * refusing identically.
   */
  test("a padded connection mode still draws the form the app publishes", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          retrieve: async () => ({
            auth_config_details: [
              {
                mode: " API_KEY ",
                fields: {
                  connected_account_initiation: {
                    required: [
                      {
                        name: "generic_api_key",
                        displayName: "API Key",
                        type: " string ",
                        required: true,
                        is_secret: true,
                      },
                    ],
                    optional: [],
                  },
                },
              },
            ],
          }),
        },
      }),
    );

    /*
     * AND THE TYPE OF THE BOX IS THE SAME READ ONE FIELD IN. `row.type !== "string"` was the raw
     * value while the name beside it went through the trim, so a padded `" string "` was refused
     * with "a box this deployment can draw is a string" — about a field whose type IS string.
     */
    expect(
      await broker.connectionFields({
        toolkit: "perplexityai",
        authScheme: "API_KEY",
      }),
    ).toEqual([
      {
        name: "generic_api_key",
        label: "API Key",
        help: "",
        required: true,
        secret: true,
      },
    ]);
  });
});

/**
 * WHICH `delete` THE VENDOR OBJECT ACTUALLY CARRIES, asserted without a network and without a key.
 *
 * THIS IS THE ONE DECISION IN {@link createComposioClient} AND NOTHING REACHED IT. That function is
 * described in its own comment as too thin to have a bug in, and it is — except for two lines.
 * `Composio`'s own `authConfigs.delete` and `connectedAccounts.delete` hard-code the request body
 * they send (`@composio/core` 0.18.1, `src/models/AuthConfigs.ts:303-311`,
 * `src/models/ConnectedAccounts.ts:532-540`), so through them `revoke_on_delete` cannot be passed at
 * all and every delete soft-deletes while the grant at Google or Slack stands. Both are therefore
 * satisfied from `composio.getClient()` instead, and that routing is the whole reason this
 * deployment's withdrawals withdraw anything.
 *
 * EVERY OTHER TEST IN THIS FILE DRIVES {@link buildComposioClient}, which takes the vendor object
 * already assembled — so the four that assert `revoke_on_delete` went out assert it about a double,
 * and none of them can see which function `createComposioClient` put behind it. Swapping those two
 * lines back to `composio.authConfigs.delete` and `composio.connectedAccounts.delete` type-checks
 * and leaves this suite green while restoring the exact defect the flag was added for. The only
 * thing that ever exercised the real wiring was `composio-live.test.ts`, which is skipped in every
 * run that has no key — which is every ordinary run.
 *
 * WHAT MAKES IT OBSERVABLE OFFLINE IS THAT BOTH CLIENTS ARE CONSTRUCTIBLE WITHOUT DIALLING
 * ANYTHING. `new Composio({ apiKey })` opens no socket once tracking and the npm version check are
 * off, `getClient()` hands back the underlying `@composio/client` it already holds, and the methods
 * of both live on their classes' prototypes. So a prototype replaced BEFORE `createComposioClient`
 * runs is what the client it builds will call: the SDK's telemetry wrapper copies each method off
 * the prototype at construction (`src/telemetry/Telemetry.ts:95-116`), and the raw client's
 * resources carry no own properties at all. Four recorders — one on each side of each delete — turn
 * "which function was reached" into a list, which is a fact about the wiring rather than about a
 * request that was never made.
 *
 * THE IMPORT OF `@composio/core` HERE DOES NOT BREAK THE ONE-IMPORT-SITE RULE. That rule is about
 * `server/src`, so that a version bump has exactly one FILE of product code to be read against;
 * this is a test, and the version it is written against is the whole of what it asserts.
 */
describe("the key becoming a vendor, and which delete that vendor carries", () => {
  /** One class's methods, as the object a replacement is written onto. */
  type Methods = Record<string, (...args: unknown[]) => Promise<unknown>>;

  const methodsOf = (instance: object): Methods =>
    Object.getPrototypeOf(instance) as Methods;

  test("both deletes are the raw client's, and neither is the SDK's own wrapper", async () => {
    /*
     * A SECOND CLIENT, BUILT ONLY TO REACH THE CLASSES. Nothing is called on it: it exists because
     * the prototypes are not exported, and the way to a prototype is an instance. The key is a
     * string nobody will ever send anywhere, which is the point of asserting this without one.
     */
    const seed = new Composio({
      apiKey: "never-dialled",
      allowTracking: false,
      disableVersionCheck: true,
    });
    const sdkAccounts = methodsOf(seed.connectedAccounts);
    const sdkConfigs = methodsOf(seed.authConfigs);
    const rawAccounts = methodsOf(seed.getClient().connectedAccounts);
    const rawConfigs = methodsOf(seed.getClient().authConfigs);

    const restore: { on: Methods; name: string; was: Methods[string] }[] = [];
    const replace = (on: Methods, name: string, answer: Methods[string]) => {
      restore.push({ on, name, was: on[name] });
      on[name] = answer;
    };

    const reached: string[] = [];
    const recorder =
      (whose: string): Methods[string] =>
      async (...call: unknown[]) => {
        reached.push(`${whose} ${JSON.stringify(call)}`);
        return { success: true };
      };

    try {
      /*
       * BOTH SIDES OF BOTH DELETES ARE RECORDED, which is what makes the list an assertion rather
       * than a spy. A recorder on the raw client alone would still fire if the SDK's wrapper were
       * used, because the wrapper calls straight through to it — so what tells the two wirings
       * apart is whose recorder answered, and the only way to see that is to have one on each.
       */
      replace(
        rawAccounts,
        "delete",
        recorder("the raw client's connectedAccounts.delete"),
      );
      replace(
        sdkAccounts,
        "delete",
        recorder("the SDK's own connectedAccounts.delete"),
      );
      replace(
        rawConfigs,
        "delete",
        recorder("the raw client's authConfigs.delete"),
      );
      replace(
        sdkConfigs,
        "delete",
        recorder("the SDK's own authConfigs.delete"),
      );

      // The two listings that carry each delete to its argument. Answered from memory, so this test
      // reaches the network exactly as often as it reaches the live Composio account: never.
      replace(sdkAccounts, "list", async () => ({
        items: [{ id: "ca_1" }],
        nextCursor: null,
      }));
      replace(sdkConfigs, "list", async () => ({
        items: [OUR_GMAIL],
        nextCursor: null,
      }));

      const { broker } = createComposioClient("never-dialled");
      expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
        true,
      );
      await broker.deleteAuthConfig("gmail");
    } finally {
      // Restored whatever happened above, because these are the SDK's own classes and every later
      // test in this process would otherwise be running against a patched vendor.
      for (const { on, name, was } of restore.reverse()) on[name] = was;
    }

    /*
     * THE WHOLE OF WHAT WAS REACHED, IN ORDER. An implementation that routed either delete through
     * the SDK's wrapper puts that wrapper's name in this list, and the equality says so; one that
     * dropped the flag puts a different argument list in it. Both are the same defect seen from
     * two sides, and neither is visible to any other test in this file.
     */
    expect(reached).toEqual([
      `the raw client's connectedAccounts.delete ["ca_1",{"revoke_on_delete":true}]`,
      `the raw client's authConfigs.delete ["${OUR_GMAIL.id}",{"revoke_on_delete":true}]`,
    ]);
  });

  /**
   * WHICH OF THE TWO IDENTIFIERS GOES FIRST WHEN A CONSENT LINK IS MINTED, asserted at the seam.
   *
   * `connectedAccounts.link(userId, authConfigId, options)` takes two strings in a row, so swapping
   * them is the one mistake a type checker is structurally unable to see — both arguments are
   * `string`, and the call compiles either way. What it produces is not an error either: Composio
   * is asked to link the account of a "person" named `ac_gmail_ours` against an auth config named
   * `user_1`, which is a request about two things that do not exist rather than a malformed one.
   *
   * AND EVERY OTHER TEST IN THIS FILE IS BLIND TO IT for the reason the deletes above are. They
   * drive {@link buildComposioClient} with a double whose `link` records positionally, so they
   * assert the order the ADAPTER passes — which is correct and stays correct — while the line that
   * re-spells those parameters on the way to the real SDK, inside {@link createComposioClient},
   * is reached by nothing. Swapping it there type-checks and leaves this suite green.
   *
   * So the order is asserted where it is actually spent: against the SDK's own prototype, with the
   * argument list recorded as it arrived.
   */
  test("the consent link names this person first and the auth config second", async () => {
    const seed = new Composio({
      apiKey: "never-dialled",
      allowTracking: false,
      disableVersionCheck: true,
    });
    const sdkAccounts = methodsOf(seed.connectedAccounts);
    const sdkConfigs = methodsOf(seed.authConfigs);

    const restore: { on: Methods; name: string; was: Methods[string] }[] = [];
    const replace = (on: Methods, name: string, answer: Methods[string]) => {
      restore.push({ on, name, was: on[name] });
      on[name] = answer;
    };

    const minted: unknown[][] = [];
    let begun: { redirectUrl: string } | null = null;
    try {
      // The config listing is what carries the auth config's id to the link, so it answers with the
      // one this deployment made — the id that must arrive SECOND.
      replace(sdkConfigs, "list", async () => ({
        items: [OUR_GMAIL],
        nextCursor: null,
      }));
      replace(sdkAccounts, "link", async (...call: unknown[]) => {
        minted.push(call);
        return { redirectUrl: "https://backend.composio.dev/s/a-link" };
      });

      const { broker } = createComposioClient("never-dialled");
      begun = await broker.authorize({
        userId: "user_1",
        toolkit: "gmail",
        returnUrl: RETURN_URL,
      });
    } finally {
      for (const { on, name, was } of restore.reverse()) on[name] = was;
    }

    // The person, then the config, then the callback — and the whole list rather than a field of
    // it, because the defect this is written for is an order and not a value.
    expect(minted).toEqual([
      ["user_1", OUR_GMAIL.id, { callbackUrl: RETURN_URL }],
    ]);
    expect(begun).toEqual({
      redirectUrl: "https://backend.composio.dev/s/a-link",
    });
  });
});

/**
 * WHAT CONSTRUCTING THE VENDOR IS ALLOWED TO DO TO THIS PROCESS, AND TO THE NETWORK, ON BOOT.
 *
 * `new Composio({ ... })` in {@link createComposioClient} carries three entries and every one of
 * them is load-bearing, but none of them was visible to a test: the suite above drives
 * {@link buildComposioClient}, which takes the vendor already assembled, so the construction
 * literal could have any of its lines deleted and stay green. This describe is the only thing in
 * the repository that reads that literal, and it reads it the way a deployment does — by watching
 * what leaves the process.
 *
 * THE TWO FLAGS BOTH DEFAULT THE WRONG WAY FOR A SELF-HOSTED PRODUCT, which is why both are said
 * rather than relied on. In `@composio/core` 0.18.1:
 *
 *   - `allowTracking` defaults to TRUE (`src/utils/config-defaults/ConfigDefaults.node.ts:5`), and
 *     a true value runs `telemetry.setup(...)` (`src/composio.ts:380-390`). That does two separate
 *     things in one call. It POSTs an `SDK_INITIALIZED` metric to
 *     `https://telemetry.composio.dev/v1/metrics/invocations`
 *     (`src/services/telemetry/TelemetryService.ts:4,38-46`) — a third party's analytics, which
 *     the operator of a self-hosted install never opted into. And, first,
 *     `registerExitHandlers()` (`src/telemetry/Telemetry.ts:66,315-356`) installs THREE
 *     process-level listeners — `beforeExit`, `SIGINT` and `SIGTERM` — whose signal handlers flush
 *     telemetry, then `process.removeListener` and `process.kill(process.pid, signal)` to re-raise.
 *     That is a vendor library taking a hand in how this server shuts down, which is the part of
 *     the consequence that no amount of firewalling would undo.
 *   - `disableVersionCheck` defaults to FALSE (`src/composio.ts:113-120`), and a falsy value runs
 *     `checkForLatestVersionFromNPM` (`src/composio.ts:399-402`), which `fetch`es
 *     `https://registry.npmjs.org/@composio/core/latest` (`src/utils/version.ts:41-43`). A boot
 *     that reaches npm is a boot that depends on the vendor's release feed and on egress to it.
 *
 * AND THE KEY IS THE THIRD ENTRY, pinned here for the same reason. `apiKey` is not merely
 * forwarded: dropping it does not fail, it FALLS BACK — `getSDKConfig` reads `COMPOSIO_API_KEY`
 * from the environment and then `api_key` out of `~/.composio/user_data.json`
 * (`src/utils/sdk.ts:42-52`), so a deployment could go on working against whichever account a
 * machine happened to be logged into, with `config.composioApiKey` silently unused. The same
 * request pins the absence of `baseURL`, because the host it goes to is the SDK's default
 * (`src/utils/constants.ts:7`) and a `baseURL` added to the literal would move it.
 *
 * HOW IT IS OBSERVED WITHOUT A NETWORK: `globalThis.fetch` is replaced for the duration by one
 * that records the request and rejects, and `process.on` by one that records the event name and
 * installs nothing. Both are restored in a `finally`. So the transport is the recorder, no socket
 * is opened either way, and the assertions are lists of what the vendor TRIED — which is the fact
 * worth pinning, since a flag flipped back would be a try that succeeded in production.
 *
 * THE HANDLER HALF WOULD HAVE BEEN A VACUOUS ASSERTION AND IS NOT, which is worth knowing before
 * anybody simplifies it. `registerExitHandlers` guards on an `exitHandlersRegistered` flag held by
 * a MODULE-LEVEL singleton (`src/telemetry/Telemetry.ts:46,315-321`), so it fires at most once per
 * process — and this file constructs more than one client, so under a dropped `allowTracking` an
 * EARLIER test is what would install the handlers and this one would see an empty list and pass.
 * That was observed, not theorised: with the flag deleted, the telemetry POST showed up here and
 * the handler list did not. The helper below therefore clears that memo for the duration, which is
 * what turns "no handler is installed" into "no handler was attempted".
 */
describe("what constructing the vendor is allowed to do on boot", () => {
  /** One request as the stubbed transport saw it, which is all a test needs of a request. */
  type Attempt = { url: string; apiKey: string | null };

  /**
   * Runs `body` with the network and the process's own listener registry replaced by recorders.
   *
   * `NODE_ENV` is forced away from `test` for the duration because the SDK's own
   * `shouldSendTelemetry()` short-circuits on `test` and `ci`
   * (`src/telemetry/Telemetry.ts:173-180`) — under `bun test` the telemetry POST would be
   * suppressed by the runner's environment rather than by the flag, and a test that cannot tell
   * those two apart is not pinning the flag.
   */
  async function withRecordedTransport(
    body: () => Promise<void> | void,
  ): Promise<{ attempts: Attempt[]; events: string[] }> {
    const attempts: Attempt[] = [];
    const events: string[] = [];
    const realFetch = globalThis.fetch;
    const realOn = process.on;
    const realNodeEnv = process.env.NODE_ENV;
    const memo = telemetry as unknown as { exitHandlersRegistered: boolean };
    const realMemo = memo.exitHandlersRegistered;

    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const request = input as { url?: string; headers?: HeadersInit };
      const headers = new Headers(init?.headers ?? request?.headers ?? {});
      attempts.push({
        url: String(request?.url ?? input),
        apiKey: headers.get("x-api-key"),
      });
      // Rejected rather than answered: every caller here treats the vendor call as one it is
      // allowed to fail, and an answer would only invite a test about a body nobody sent.
      return Promise.reject(new Error("no network in this test"));
    }) as typeof globalThis.fetch;

    process.on = ((event: string) => {
      events.push(event);
      return process;
    }) as typeof process.on;

    process.env.NODE_ENV = "production";

    /*
     * THE VENDOR'S ONCE-PER-PROCESS MEMO, CLEARED SO THE OBSERVATION IS AN OBSERVATION.
     * `registerExitHandlers` returns early forever after its first call
     * (`src/telemetry/Telemetry.ts:46,315-321`), and the flag lives on a module-level singleton
     * shared by every `Composio` in the process. So if any earlier test in this file had
     * constructed a tracking-enabled vendor, the handler list below would come back empty for a
     * reason that has nothing to do with the flag under test — the assertion would pass while the
     * defect it exists for was present. Reaching the private field is deliberate: it is the
     * difference between recording that nothing was installed and recording that nothing tried.
     */
    memo.exitHandlersRegistered = false;

    try {
      await body();
      // One turn of the macrotask queue, because the SDK defers its initialisation metric through
      // `queueMicrotask` (`src/telemetry/Telemetry.ts:241-257`) — a `setTimeout` lands after every
      // microtask that defer could have queued, so the recorder sees the POST before it is undone.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      globalThis.fetch = realFetch;
      process.on = realOn;
      process.env.NODE_ENV = realNodeEnv;
      memo.exitHandlersRegistered = realMemo;
    }

    return { attempts, events };
  }

  test("it reaches nothing and installs no process handler", async () => {
    const { attempts, events } = await withRecordedTransport(() => {
      createComposioClient("never-dialled");
    });

    /*
     * BOTH CONSEQUENCES IN ONE ASSERTION, so that a diff shows the whole of what a dropped flag
     * costs rather than whichever half happened to be checked first.
     *
     * `reached` is what the vendor tried to dial. Dropping `disableVersionCheck: true` puts
     * `https://registry.npmjs.org/@composio/core/latest` in it; dropping `allowTracking: false`
     * puts `https://telemetry.composio.dev/v1/metrics/invocations` in it. The whole list is
     * asserted rather than each absence, so a third endpoint a version bump added fails here too.
     *
     * `installed` is what the vendor attached to THIS process, and it is the half that no firewall
     * would undo. Dropping `allowTracking: false` puts `beforeExit`, `SIGINT` and `SIGTERM` in it;
     * the two signal handlers flush telemetry and then re-raise the signal themselves, so that
     * deployment would have a vendor library sitting between an operator's Ctrl-C, or a container
     * runtime's shutdown, and this server's exit.
     */
    expect({
      reached: attempts.map(({ url }) => url),
      installed: events,
    }).toEqual({
      reached: [],
      installed: [],
    });
  });

  test("the key it was given is the key the vendor sends, to Composio's own host", async () => {
    const { attempts } = await withRecordedTransport(async () => {
      const { broker } = createComposioClient("never-dialled");
      // It rejects because the transport above rejects; what is under test is the request that was
      // built before it did, not the refusal that comes back.
      await expect(broker.listApps()).rejects.toThrow();
    });

    /*
     * EVERY attempt, not the first one, because the claim worth making is about all of them. The
     * raw client retries a connection error, so there is more than one here and each carries the
     * same key to the same host; and a client that had acquired a second destination — the
     * telemetry endpoint being the one this SDK reaches for — would be a client for which this
     * sentence had stopped being true, which is the failure this shape catches and an assertion
     * about `attempts[0]` would not.
     */
    expect(attempts.length).toBeGreaterThan(0);
    for (const attempt of attempts) {
      expect(attempt.apiKey).toBe("never-dialled");
      expect(new URL(attempt.url).origin).toBe("https://backend.composio.dev");
    }
  });
});

/**
 * THE TWO LISTINGS THAT USED TO REFUSE A FULL PAGE, NOW READ TO THE END OF THEIR CURSORS.
 *
 * These were the last two places in this file where a request the vendor can answer was described
 * as one this deployment cannot express. It can: `@composio/client` 0.1.0-alpha.76 declares
 * `cursor` on both `ToolkitListParams` (`resources/toolkits.d.ts:467-478`) and `ToolListParams`
 * (`resources/tools.d.ts:421-432`), and `next_cursor` on both responses (`:322-326` and
 * `:200-204`). What had no cursor was the WRAPPER around them — `transformToolkitListResponse`
 * returns `response.items.map(...)`, a bare array with the cursor dropped, and
 * `ToolListParamsSchema` names no cursor field at all — and the two refusals blamed the vendor for
 * the wrapper's shape.
 *
 * IT MATTERED MOST WHERE IT COST MOST. Composio publishes more than {@link WHOLE_LISTING} toolkits,
 * so the catalogue refusal fired on the FIRST call every time and an operator opening the app
 * picker saw no apps at all — not a truncated directory, none. The tests below are about the rows
 * on the SECOND page, because a reader that stops at the first is exactly as wrong as the old
 * refusal was and answers far more plausibly.
 */
describe("listings Composio pages, read to the end", () => {
  /** One catalogue row, complete, so a test about paging is not also a test about a field. */
  const app = (slug: string) => ({
    slug,
    name: slug.toUpperCase(),
    meta: {
      description: `The ${slug} app.`,
      logo: `https://logo.test/${slug}.png`,
      categories: [{ id: "productivity", name: "Productivity" }],
      tools_count: 3,
    },
  });

  /** One action row as the raw client hands it over, which is snake_case and unparsed. */
  const action = (slug: string) => ({
    slug,
    description: `Does ${slug}.`,
    input_parameters: { type: "object", properties: {} },
    tags: ["readOnlyHint"],
    version: "20260903_00",
  });

  test("an app on the catalogue's second page is an app the picker can find", async () => {
    const asked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          list: async (query: unknown) => {
            asked.push(query);
            return (query as { cursor?: string }).cursor === undefined
              ? { items: [app("slack")], next_cursor: "page_2" }
              : { items: [app("gmail")], next_cursor: null };
          },
        },
      }),
      () => 1_000_000,
    );

    // `gmail` is the whole test, and it is the app the operator waiting on this actually typed.
    // Under the old refusal this call answered nothing at all; under a pager that stopped at page
    // one it answers an app short and says so nowhere.
    expect((await broker.listApps()).map((one) => one.slug)).toEqual([
      "slack",
      "gmail",
    ]);
    // The first request carries no cursor FIELD rather than an undefined one, and the second
    // carries the vendor's own word for where it left off.
    expect(asked).toEqual([
      { limit: WHOLE_LISTING, sort_by: "usage" },
      { limit: WHOLE_LISTING, sort_by: "usage", cursor: "page_2" },
    ]);
  });

  test("an action on the second page is an action the refresh records", async () => {
    const asked: unknown[] = [];
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          list: async (query: unknown) => {
            asked.push(query);
            return (query as { cursor?: string }).cursor === undefined
              ? { items: [action("GMAIL_FETCH_EMAILS")], next_cursor: "page_2" }
              : { items: [action("GMAIL_SEND_EMAIL")], next_cursor: null };
          },
        },
      }),
    );

    const listed = await actions.listActions("gmail", { limit: WHOLE_LISTING });

    expect(listed.map((one) => one.slug)).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GMAIL_SEND_EMAIL",
    ]);
    // `refreshTools` commits a listing as the complete truth about an app — the write is a delete
    // and an insert — so an action left on page two is an action DELETED from `mcp_tools` under a
    // refresh that reported success, taking every grant pointing at it.
    expect(listed[1]).toEqual({
      slug: "GMAIL_SEND_EMAIL",
      description: "Does GMAIL_SEND_EMAIL.",
      inputParameters: { type: "object", properties: {} },
      tags: ["readOnlyHint"],
      version: "20260903_00",
    });
    /*
     * THE QUERY IS ASSERTED BECAUSE THREE OF ITS FIELDS ARE THINGS THE WRAPPER USED TO DO FOR US.
     * `toolkit_versions` is the SDK's own default, forwarded on every listing it made
     * (`@composio/core` 0.18.1, `src/models/Tools.ts:548`), and it decides which `version` each
     * action comes back with — the value a later call sends back to Composio. `limit` is the page,
     * and its absence is what used to let the vendor apply twenty. And `important` is named
     * NOWHERE, deliberately: the wrapper set it to "true" whenever a toolkit query gave no limit
     * (`:505-515`), which narrows the answer to a featured subset that nothing in the answer
     * declares.
     */
    expect(asked).toEqual([
      {
        toolkit_slug: "gmail",
        limit: WHOLE_LISTING,
        toolkit_versions: "latest",
      },
      {
        toolkit_slug: "gmail",
        limit: WHOLE_LISTING,
        toolkit_versions: "latest",
        cursor: "page_2",
      },
    ]);
  });

  test("a catalogue cursor this deployment cannot follow refuses rather than truncates", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          list: async () => ({ items: [app("slack")], next_cursor: 7 }),
        },
      }),
      () => 1_000_000,
    );

    const refusal = await failureOf(broker.listApps());

    // A number is a position this deployment cannot express and cannot rule out being real, so it
    // is the fault it always was. Coercing it to "7" would be the fragment-read-as-whole mistake
    // the pager exists to prevent, wearing a default's clothes.
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(
      /sent a number where the cursor to the next page/,
    );
    expect(refusal.message).toMatch(/Composio's app catalogue/);
  });

  test("an action cursor this deployment cannot follow refuses rather than truncates", async () => {
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          list: async () => ({
            items: [action("GMAIL_FETCH_EMAILS")],
            next_cursor: { page: 2 },
          }),
        },
      }),
    );

    const refusal = await failureOf(
      actions.listActions("gmail", { limit: WHOLE_LISTING }),
    );

    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/an object/);
    expect(refusal.message).toMatch(/gmail's actions/);
  });

  test("a catalogue page that is not a page of rows refuses", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: { list: async () => ({ items: "gmail" }) },
      }),
      () => 1_000_000,
    );

    const refusal = await failureOf(broker.listApps());

    /*
     * THE CONTAINER IS THIS FILE'S TO CHECK NOW, WHICH IT WAS NOT BEFORE. The wrapper dereferenced
     * every answer on its way out — `response.items.map(...)` — so a malformed envelope died inside
     * the vendor's package and reached a reader as the translated `TypeError`. Reading the raw
     * client means nothing dereferences it before this file does, and `rows.push(...items)` over a
     * string is "string is not iterable" with nothing in it a person can act on.
     */
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/sent a string where the rows/);
    expect(refusal.message).toMatch(/Composio's app catalogue/);
  });

  /**
   * A BARE LIST IS NOT AN ENVELOPE WITH ITS ROWS MISSING, AND THE ENVELOPE GUARD LET IT THROUGH.
   *
   * `typeof [] === "object"` and `[] !== null`, so a page that arrived as a bare list satisfied the
   * test for being an envelope and fell to the one below it — which reads `answered.items`, finds
   * `undefined`, and says "Composio sent nothing where the rows of Composio's app catalogue
   * belong". That sentence sends an operator looking at a listing whose rows did not arrive, about
   * an answer that contained no listing at all: the shape Composio sent is the finding, and it was
   * the one part the refusal did not name. It is also the likeliest of the two shapes — the SDK's
   * transformers used to hand bare arrays back, which is exactly what a version drift here would
   * look like.
   */
  test("a catalogue page that arrived as a bare list is named as one rather than as missing rows", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({ toolkits: { list: async () => [] } }),
      () => 1_000_000,
    );

    const refusal = await failureOf(broker.listApps());

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/sent a list where a page of/);
    expect(refusal.message).not.toMatch(/where the rows of/);
    expect(refusal.message).toMatch(/Composio's app catalogue/);
  });

  /** The same shape on the other raw listing, whose consequence is a set of tools rather than a page. */
  test("an action page that arrived as a bare list is named as one rather than as missing rows", async () => {
    const { actions } = buildComposioClient(
      fakeVendor({ tools: { list: async () => [] } }),
    );

    const refusal = await failureOf(
      actions.listActions("gmail", { limit: WHOLE_LISTING }),
    );

    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/sent a list where a page of/);
    expect(refusal.message).not.toMatch(/where the rows of/);
    expect(refusal.message).toMatch(/gmail's actions/);
  });

  test("an action page that is not a page of rows refuses", async () => {
    const { actions } = buildComposioClient(
      fakeVendor({ tools: { list: async () => null } }),
    );

    const refusal = await failureOf(
      actions.listActions("gmail", { limit: WHOLE_LISTING }),
    );

    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/gmail's actions/);
  });

  test("the catalogue stops at the page ceiling rather than reading a listing that never ends", async () => {
    let pages = 0;
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          list: async () => {
            pages += 1;
            // THE TEST'S OWN STOP, which its sibling over the accounts listing has and this one did
            // not. The cursor here is different on every page, so nothing in the fixture ever ends
            // the listing — the adapter's ceiling is the only thing that does. Without this throw,
            // an adapter that LOST its ceiling does not redden this test: it hangs the whole file
            // for ever, which is a suite that never reports rather than a test that fails, and the
            // difference matters most in CI where a hang is read as an infrastructure fault.
            if (pages > PAGES_BEFORE_REFUSING) {
              throw new Error("The paging did not terminate.");
            }
            return {
              items: [app(`app_${pages}`)],
              next_cursor: `page_${pages}`,
            };
          },
        },
      }),
      () => 1_000_000,
    );

    const refusal = await failureOf(broker.listApps());

    // The number of pages READ and the number the refusal STATES, both against the literal.
    expect(pages).toBe(PAGES_BEFORE_REFUSING);
    expect(refusal.message).toMatch(
      new RegExp(`answered ${PAGES_BEFORE_REFUSING} pages`),
    );
    expect(refusal.message).toMatch(/Composio's app catalogue/);
  });

  test("a catalogue row whose metadata is not an object refuses", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          list: async () => ({
            items: [{ slug: "gmail", name: "Gmail", meta: "productivity" }],
          }),
        },
      }),
      () => 1_000_000,
    );

    const refusal = await failureOf(broker.listApps());

    /*
     * A GUARANTEE THAT CAME FROM THE WRAPPER AND LEAVES WITH IT. `transformToolkitListResponse`
     * built each row's meta itself, spreading it into a fresh literal, so every meta arriving here
     * was an object however the wire had spelled it. Nothing does that now, and `meta.description`
     * off a string is `undefined` rather than a throw — so the app would have shown no description,
     * no logo, no categories and no count, indistinguishable from an app that published none.
     */
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(
      /sent a string where gmail's description, logo, categories and action count belong/,
    );
  });

  test("a catalogue row whose categories are not a list refuses", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          list: async () => ({
            items: [
              {
                slug: "gmail",
                name: "Gmail",
                meta: { categories: "productivity" },
              },
            ],
          }),
        },
      }),
      () => 1_000_000,
    );

    const refusal = await failureOf(broker.listApps());

    // The wrapper's `item.meta.categories?.map(...)` died on this one; nothing maps it now, so a
    // string would be read as an app that publishes no categories at all.
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(
      /sent a string where gmail's categories belong/,
    );
  });
});

/**
 * What an app asks a person to type, read off the vendor rather than written down here.
 *
 * THE FIXTURES ARE MEASURED ANSWERS RATHER THAN INVENTED ONES. The first is `perplexityai`'s
 * `API_KEY` mode as Composio publishes it, down to the `legacy_template_name` this deployment does
 * not read — because the value of asking the vendor at all is that the form follows what the app
 * actually wants, and a fixture composed of the four fields the mapping happens to touch would
 * assert that mapping against a shape no app sends.
 */
describe("the fields an app asks a person to fill in", () => {
  test("the fields an app wants come back as the app describes them", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          retrieve: async () => ({
            auth_config_details: [
              {
                mode: "API_KEY",
                fields: {
                  connected_account_initiation: {
                    required: [
                      {
                        name: "generic_api_key",
                        displayName: "API Key",
                        description:
                          "Your secret Perplexity API key, starting with 'pplx-'.",
                        type: "string",
                        required: true,
                        is_secret: true,
                        user_visible: true,
                      },
                    ],
                    optional: [],
                  },
                },
              },
            ],
          }),
        },
      }),
    );

    expect(
      await broker.connectionFields({
        toolkit: "perplexityai",
        authScheme: "API_KEY",
      }),
    ).toEqual([
      {
        name: "generic_api_key",
        label: "API Key",
        help: "Your secret Perplexity API key, starting with 'pplx-'.",
        required: true,
        secret: true,
      },
    ]);
  });

  test("a field of a type this deployment cannot draw is refused rather than drawn blind", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          retrieve: async () => ({
            auth_config_details: [
              {
                mode: "API_KEY",
                fields: {
                  connected_account_initiation: {
                    required: [
                      {
                        name: "cert",
                        displayName: "Certificate",
                        type: "file",
                        required: true,
                        is_secret: true,
                        user_visible: true,
                      },
                    ],
                    optional: [],
                  },
                },
              },
            ],
          }),
        },
      }),
    );

    const refusal = await failureOf(
      broker.connectionFields({ toolkit: "mystery", authScheme: "API_KEY" }),
    );

    /*
     * A TEXT BOX DRAWN FOR A FILE IS THE FAILURE THIS PREVENTS: somebody types a path into a box
     * labelled Certificate, the connection is made, and the first tool call is what discovers it.
     * Every required field measured across the catalogue is a plain string, so this is a guard
     * against the vendor changing rather than a routine case.
     */
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    /*
     * AND IT IS THE TYPE FAULT RATHER THAN ITS TWIN. One guard raises this sentence for two faults
     * — a type that is not a string, and a name that did not arrive — and both tests over it
     * asserted the clause they SHARE, so neither could tell a correct classification from a wrong
     * one. What moves between them is the field position: the type fault names a box that has a
     * name, and its twin names one published "under the name nothing".
     */
    expectOnlyRefusal(refusal.message, "fieldTypeNotDrawable");
  });

  test("a field named for the word the connection state uses is refused, not drawn", async () => {
    /*
     * A BOX WHOSE ANSWER CANNOT BE SENT MUST NOT BE DRAWN, which is the same rule the nameless field
     * above is refused under. `connectWithFields` sends `{ status: "ACTIVE", ...values }` — the
     * shape the vendor's own `AuthScheme` builder assembles (`@composio/core` 0.18.1,
     * `src/models/AuthScheme.ts:84-94`) — so `status` is the protocol's word inside that object and
     * not a name a value may travel under. Either answer to a box named that is wrong: sent, it
     * replaces the state this deployment is asking Composio to create, and withheld, it is a box
     * somebody filled in whose value no app ever reads.
     *
     * SO THE APP IS REFUSED RATHER THAN PART OF ITS FORM, and the sentence names the field, which is
     * the vendor's own text and the only thing an administrator can act on.
     */
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          retrieve: async () => ({
            auth_config_details: [
              {
                mode: "API_KEY",
                fields: {
                  connected_account_initiation: {
                    required: [
                      {
                        name: "status",
                        displayName: "Account status",
                        type: "string",
                        required: true,
                        is_secret: false,
                        user_visible: true,
                      },
                    ],
                    optional: [],
                  },
                },
              },
            ],
          }),
        },
      }),
    );

    const refusal = await failureOf(
      broker.connectionFields({ toolkit: "drifted", authScheme: "API_KEY" }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/status/);
    expect(refusal.message).toMatch(/drifted/);
  });

  test("a name published in both lists is one box, and the required one", async () => {
    /*
     * THE TWO LISTS ARE JOINED AND A NAME IS NOT A SEAT. `required` and `optional` are published
     * separately and were concatenated as they arrived, so an app naming one field in both drew TWO
     * boxes labelled the same thing — and whichever the person typed in second is the one that won
     * in the submitted values, because a later key overwrites an earlier one in the object the form
     * builds. Nothing anywhere says which of the two they filled in.
     *
     * FIRST SIGHTING KEEPS ITS PLACE, which is the rule `readableConfigs` and `withdrawableAccounts`
     * already dedupe identifiers under, and required is read FIRST — so a name in both lists is
     * treated as the required one. That is the safe direction: read as optional, a credential the
     * app cannot do without becomes a box the connect route lets somebody leave blank.
     */
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          retrieve: async () => ({
            auth_config_details: [
              {
                mode: "API_KEY",
                fields: {
                  connected_account_initiation: {
                    required: [
                      {
                        name: "generic_api_key",
                        displayName: "API Key",
                        description: "Your secret key.",
                        type: "string",
                        required: true,
                        is_secret: true,
                        user_visible: true,
                      },
                    ],
                    optional: [
                      {
                        name: "generic_api_key",
                        displayName: "API Key (optional)",
                        description: "Leave this alone.",
                        type: "string",
                        required: false,
                        is_secret: false,
                        user_visible: true,
                        default: "pplx-",
                      },
                    ],
                  },
                },
              },
            ],
          }),
        },
      }),
    );

    expect(
      await broker.connectionFields({
        toolkit: "perplexityai",
        authScheme: "API_KEY",
      }),
    ).toEqual([
      {
        name: "generic_api_key",
        label: "API Key",
        help: "Your secret key.",
        required: true,
        secret: true,
      },
    ]);
  });

  /**
   * A ROW THAT IS NOT A ROW IS A VENDOR SHAPE, AND IT WAS WEARING THE SENTENCE FOR AN APP.
   *
   * Every other container this file opens is tested for being one before a field is read off it —
   * the catalogue row, its meta, each category, the action row, the toolkit detail, the mode. The
   * field rows were not, and `("generic_api_key").type` is `undefined` rather than a throw, so a row
   * that arrived as a string reached the type guard and was refused with "Connecting this app is not
   * something this deployment can offer yet" — a verdict about the APP, carrying no remedy at all,
   * for an answer whose only fault is a package that has changed shape. The two are not the same
   * finding and they are not the same person's to fix.
   */
  test("a field row that is not an object is refused as a vendor shape rather than as an app nobody can connect", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          retrieve: async () => ({
            auth_config_details: [
              {
                mode: "API_KEY",
                fields: {
                  connected_account_initiation: {
                    required: ["generic_api_key"],
                    optional: [],
                  },
                },
              },
            ],
          }),
        },
      }),
    );

    const refusal = await failureOf(
      broker.connectionFields({
        toolkit: "perplexityai",
        authScheme: "API_KEY",
      }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(
      /upgrading this deployment's @composio\/core/,
    );
    expect(refusal.message).toMatch(/sent a string where/);
    expect(refusal.message).not.toMatch(
      /not something this deployment can offer yet/,
    );
  });

  /** And the same guard under the row that a `user_visible` read would have reached first. */
  test("a field row that arrived as null is refused as a vendor shape too", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          retrieve: async () => ({
            auth_config_details: [
              {
                mode: "API_KEY",
                fields: {
                  connected_account_initiation: {
                    required: [],
                    optional: [null],
                  },
                },
              },
            ],
          }),
        },
      }),
    );

    const refusal = await failureOf(
      broker.connectionFields({
        toolkit: "perplexityai",
        authScheme: "API_KEY",
      }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/sent null where/);
    expect(refusal.message).toMatch(
      /upgrading this deployment's @composio\/core/,
    );
  });

  /**
   * "NO SUCH MODE" AND "THIS MODE ASKS FOR NOTHING" ARE TWO ANSWERS, AND THEY USED TO BE ONE `[]`.
   *
   * The scheme handed in is the RECORDED one and is never re-derived — that is the entire point of
   * the column — so a mode Composio has stopped publishing for this app is exactly the drift
   * recording it anticipates. As an empty form it is invisible: the person presses submit, a
   * connection is created carrying no credential at all, Composio answers `ACTIVE` because it does
   * not grade what it is given, and the later probe is the first thing that notices. From their end
   * it is a box they cannot fill in.
   */
  test("a mode this app no longer publishes is refused rather than drawn as an empty form", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          // The app publishes OAuth2 today; the row here was enabled as API_KEY and still says so.
          retrieve: async () => ({
            auth_config_details: [
              {
                mode: "OAUTH2",
                fields: {
                  connected_account_initiation: { required: [], optional: [] },
                },
              },
            ],
          }),
        },
      }),
    );

    const refusal = await failureOf(
      broker.connectionFields({ toolkit: "linear", authScheme: "API_KEY" }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    // The app and the RECORDED scheme, because those two are the whole of the finding — and the one
    // act that rewrites the recorded scheme, which is an administrator's rather than this person's.
    expect(refusal.message).toMatch(/linear/);
    expect(refusal.message).toMatch(/API_KEY/);
    expect(refusal.message).toMatch(/Plugins page/);
  });

  /**
   * AND "I COULD NOT READ WHAT IT ASKS FOR" IS A THIRD ANSWER, WHICH WAS THE SAME `[]` AS THE
   * SECOND.
   *
   * The recorded mode is found here, so the refusal above never fires. What hangs off that mode is
   * then read a step at a time off `unknown` — the mode's `fields`, the initiation block inside it,
   * and the two lists of rows inside that — and every one of those steps answered an empty list for
   * a shape it could not make sense of. An empty list is a sentence: this mode asks a person for
   * nothing, which is a true thing some modes say. A `fields` that is not an object is a different
   * sentence entirely — Composio moved the shape and the boxes are no longer visible from here —
   * and the two arrived at the browser as the same empty form. That form is the one this method's
   * own doc says must never be drawn: the person presses submit, `connectWithFields` creates a
   * connection carrying no credential at all, Composio answers `ACTIVE` because it does not grade
   * what it is given, and the first call made with the account is what discovers anything is wrong.
   *
   * EVERY STEP IS ITS OWN CASE BECAUSE EVERY STEP IS ITS OWN DRIFT, and a guard on one of them says
   * nothing whatever about the three beside it.
   */
  test("a published shape this deployment cannot read is refused rather than drawn as an empty form", async () => {
    const unreadable = [
      // The mode's fields, which stopped being an object at all.
      { mode: "API_KEY", fields: "generic_api_key" },
      // The initiation block, which arrived as the list of rows that used to live inside it.
      {
        mode: "API_KEY",
        fields: { connected_account_initiation: ["generic_api_key"] },
      },
      // And each list of rows on its own, because the required one is the one that stops a form.
      {
        mode: "API_KEY",
        fields: {
          connected_account_initiation: {
            required: "generic_api_key",
            optional: [],
          },
        },
      },
      {
        mode: "API_KEY",
        fields: {
          connected_account_initiation: { required: [], optional: "base_url" },
        },
      },
    ];

    for (const mode of unreadable) {
      const { broker } = buildComposioClient(
        fakeVendor({
          toolkits: {
            retrieve: async () => ({ auth_config_details: [mode] }),
          },
        }),
      );

      const refusal = await failureOf(
        broker.connectionFields({
          toolkit: "perplexityai",
          authScheme: "API_KEY",
        }),
      );

      expect(refusal).toBeInstanceOf(BrokerRefusalError);
      expect(refusal.message).not.toMatch(A_CRASH);
      expect(refusal.message).toMatch(/perplexityai/);
      /*
       * THE REMEDY IS THE WHOLE OF WHAT SEPARATES THIS FROM THE CASE ABOVE. A shape Composio
       * changed is nobody's setting, so what fixes it is an upgrade; a mode the app stopped
       * publishing is fixed by an administrator recording the scheme afresh on the Plugins page.
       * Handing the second sentence to somebody holding the first sends them to remove and re-add
       * an app whose publication never moved, after which the re-add reads the same unreadable
       * answer and records the same word.
       */
      expect(refusal.message).toMatch(/@composio\/core/);
      expect(refusal.message).not.toMatch(/Plugins page/);
    }
  });

  /**
   * AND THE SAME DISTINCTION ONE LAYER OUT, WHERE THE WRONG ANSWER WAS A REFUSAL RATHER THAN A FORM.
   *
   * An `auth_config_details` that is not a list became no modes at all, and no modes means the
   * recorded one is not among them — so an unreadable answer reached an administrator wearing the
   * sentence about a mode this app has stopped publishing. So did a retrieve that answered
   * something which is not a toolkit: `("perplexityai").auth_config_details` is `undefined` rather
   * than a throw. Both sent somebody to the Plugins page to remove and re-add an app that publishes
   * exactly what it always did.
   */
  test("an answer whose modes this deployment cannot read is refused as that rather than as a mode the app dropped", async () => {
    for (const answered of [
      "perplexityai",
      { auth_config_details: "API_KEY" },
    ]) {
      const { broker } = buildComposioClient(
        fakeVendor({ toolkits: { retrieve: async () => answered } }),
      );

      const refusal = await failureOf(
        broker.connectionFields({ toolkit: "linear", authScheme: "API_KEY" }),
      );

      expect(refusal).toBeInstanceOf(BrokerRefusalError);
      expect(refusal.message).not.toMatch(A_CRASH);
      expect(refusal.message).toMatch(/linear/);
      expect(refusal.message).toMatch(/@composio\/core/);
      expect(refusal.message).not.toMatch(/Plugins page/);
    }
  });

  /**
   * AND THE NAME IS THE ONE FIELD THAT TRAVELS, WHICH IS WHY IT IS GUARDED LIKE THE TYPE.
   *
   * `label`, `help` and `default` all pass through `textOf` and are read by a person. The name is
   * sent back to Composio verbatim and is the key `connectWithFields` spreads into the connection's
   * `val`. Coerced with `String(...)`, this row drew a box literally called "undefined" and then
   * submitted whatever was typed into it under that key: a value no app reads, inside a connection
   * Composio accepts.
   */
  test("a field with no name is refused rather than drawn as a box called undefined", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          retrieve: async () => ({
            auth_config_details: [
              {
                mode: "API_KEY",
                fields: {
                  connected_account_initiation: {
                    required: [
                      {
                        displayName: "API Key",
                        description: "",
                        type: "string",
                        required: true,
                        is_secret: true,
                        user_visible: true,
                      },
                    ],
                    optional: [],
                  },
                },
              },
            ],
          }),
        },
      }),
    );

    const refusal = await failureOf(
      broker.connectionFields({ toolkit: "nameless", authScheme: "API_KEY" }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    // The absence rather than the shared clause, for the reason the type fault above gives: this
    // is the half of that one guard that says the box could not be named at all.
    expectOnlyRefusal(refusal.message, "fieldNameMissing");
    // And never the coercion itself, which is what the form used to be handed.
    expect(refusal.message).not.toMatch(/"undefined"/);
  });

  test("a field Composio marks invisible is not shown", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          retrieve: async () => ({
            auth_config_details: [
              {
                mode: "API_KEY",
                fields: {
                  connected_account_initiation: {
                    required: [
                      {
                        name: "internal_tenant",
                        displayName: "Tenant",
                        description: "",
                        type: "string",
                        required: true,
                        is_secret: false,
                        user_visible: false,
                      },
                    ],
                    optional: [],
                  },
                },
              },
            ],
          }),
        },
      }),
    );

    expect(
      await broker.connectionFields({
        toolkit: "hidden",
        authScheme: "API_KEY",
      }),
    ).toEqual([]);
  });

  test("a default Composio padded arrives in the box without its padding", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          retrieve: async () => ({
            auth_config_details: [
              {
                mode: "API_KEY",
                fields: {
                  connected_account_initiation: {
                    required: [],
                    optional: [
                      {
                        name: "base_url",
                        displayName: "Base URL",
                        description: "",
                        default: "  https://api.example.com  ",
                        type: "string",
                        required: false,
                        is_secret: false,
                        user_visible: true,
                      },
                    ],
                  },
                },
              },
            ],
          }),
        },
      }),
    );

    /*
     * THE GUARD AND THE ANSWER READ THE SAME VALUE, which is what this is about rather than the
     * whitespace. The method tested `textOf(row.default)` — which trims — and emitted
     * `String(row.default)` — which does not — so a padded default passed a judgement made about
     * one string and reached the form as another. What a person then submits is whatever is in the
     * box, so the padding would travel on into the connection as part of the value.
     */
    expect(
      await broker.connectionFields({
        toolkit: "padded",
        authScheme: "API_KEY",
      }),
    ).toEqual([
      {
        name: "base_url",
        label: "Base URL",
        help: "",
        required: false,
        secret: false,
        default: "https://api.example.com",
      },
    ]);
  });

  /**
   * "COMPOSIO NO LONGER PUBLISHES THIS MODE" IS A VERDICT, AND AN UNREADABLE ANSWER DOES NOT
   * SUPPORT IT.
   *
   * The refusal above is a claim about the APP — the scheme recorded at enable time is one Composio
   * has since stopped offering — and its remedy is an administrator removing the app and adding it
   * again, which rewrites the recorded scheme from what the catalogue says today. Reached out of a
   * detail whose shape this deployment could not read, that claim is unfounded and the remedy is
   * work that changes nothing: the next answer is the same shape, so the app is removed, re-added,
   * and refuses identically. Every shape below is PRESENT and is not what it is declared to be, and
   * each one used to arrive as `modes = []`, `mode === undefined`, or an empty form.
   */
  const UNREADABLE_DETAILS: { what: string; detail: unknown }[] = [
    { what: "no detail document at all", detail: null },
    { what: "a detail that is not an object", detail: "API_KEY" },
    {
      what: "auth_config_details that is not a list",
      detail: { auth_config_details: "API_KEY" },
    },
    {
      what: "a mode that is not an object",
      detail: { auth_config_details: ["API_KEY"] },
    },
    /*
     * THE ONE THAT IS AN OBJECT AND IS STILL UNCLASSIFIABLE, which the shape test above does not
     * catch. `{ mode: null, fields: {…} }` is an object and not an array, so it passes that guard,
     * and `textOf` then answers null — which never equals a scheme name, so the walk moved on and
     * never collected the entry. With nothing in `unreadableModes`, the vendor-shape refusal was
     * skipped and the administrator's "Composio no longer publishes a connection of this scheme"
     * was reached — over an entry that MAY BE the mode, whose next reading is the same shape.
     */
    {
      what: "a mode name that is not a name",
      detail: {
        auth_config_details: [
          {
            mode: null,
            fields: {
              connected_account_initiation: { required: [], optional: [] },
            },
          },
        ],
      },
    },
    {
      what: "fields that are not an object",
      detail: { auth_config_details: [{ mode: "API_KEY", fields: "none" }] },
    },
    {
      what: "an initiation section that is not an object",
      detail: {
        auth_config_details: [
          { mode: "API_KEY", fields: { connected_account_initiation: 7 } },
        ],
      },
    },
    {
      what: "a required list that is not a list",
      detail: {
        auth_config_details: [
          {
            mode: "API_KEY",
            fields: {
              connected_account_initiation: {
                required: "generic_api_key",
                optional: [],
              },
            },
          },
        ],
      },
    },
    {
      what: "an optional list that is not a list",
      detail: {
        auth_config_details: [
          {
            mode: "API_KEY",
            fields: {
              connected_account_initiation: {
                required: [],
                optional: { base_url: "" },
              },
            },
          },
        ],
      },
    },
  ];

  for (const shape of UNREADABLE_DETAILS) {
    test(`${shape.what} is refused as a shape rather than as a withdrawn mode`, async () => {
      const { broker } = buildComposioClient(
        fakeVendor({
          toolkits: { retrieve: async () => shape.detail },
        }),
      );

      const refusal = await failureOf(
        broker.connectionFields({ toolkit: "drifted", authScheme: "API_KEY" }),
      );

      expect(refusal).toBeInstanceOf(BrokerRefusalError);
      expect(refusal.message).not.toMatch(A_CRASH);
      expect(refusal.message).toMatch(/drifted/);
      // The remedy is a package upgrade rather than an administrator re-adding the app, because
      // removing and adding it again meets the same shape and refuses the same way.
      expect(refusal.message).toMatch(/@composio\/core/);
      expect(refusal.message).not.toMatch(/no longer publishes/);
    });
  }

  /**
   * AND A DRIFTED MODE BESIDE A READABLE ONE TAKES DOWN NEITHER THE FORM NOR THE APP.
   *
   * CRITERION. Where the wanted mode is present and complete, an entry elsewhere in the list that
   * this deployment cannot read is ignored and the form is drawn exactly as it would have been.
   *
   * REASON. The walk over these entries was a `.map()` that threw, so EVERY entry was validated
   * before `.find()` ever selected the mode being asked for. One drifted entry anywhere in the list
   * therefore took down a mode that was perfectly readable: an app enabled as `API_KEY` whose
   * retrieve answers `[{ mode: "API_KEY", fields: {…complete…} }, "OAUTH2"]` has an intact mode at
   * index 0, and everybody pressing Connect on it was blocked permanently — "no form was drawn …
   * upgrading @composio/core is what fixes it" — over a mode nobody asked about. Nothing they can
   * reach changes the next reading, which is the same shape.
   *
   * THIS IS THE PARTITION-RATHER-THAN-THROW DISCIPLINE THE FILE ALREADY APPLIES at `readableConfigs`
   * and `withdrawableAccounts`, arriving at the one reader that was still eager. The table above is
   * the other half and still holds: a list with NO readable wanted mode is still refused as a shape.
   */
  test("a mode this deployment cannot read does not block a readable one beside it", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          retrieve: async () => ({
            auth_config_details: [
              {
                mode: "API_KEY",
                fields: {
                  connected_account_initiation: {
                    required: [
                      {
                        name: "generic_api_key",
                        displayName: "API key",
                        description: "The key.",
                        type: "string",
                        required: true,
                        is_secret: true,
                      },
                    ],
                    optional: [],
                  },
                },
              },
              // The drift, in a mode nobody on this path asked about.
              "OAUTH2",
            ],
          }),
        },
      }),
    );

    expect(
      await broker.connectionFields({
        toolkit: "drifted",
        authScheme: "API_KEY",
      }),
    ).toEqual([
      {
        name: "generic_api_key",
        label: "API key",
        help: "The key.",
        required: true,
        secret: true,
      },
    ]);
  });

  /**
   * AND WHERE THE WANTED MODE IS NOT FOUND, THE UNREADABLE ENTRIES DECIDE WHICH REFUSAL IT IS.
   *
   * "Composio no longer publishes this mode" is a claim about the APP, and its remedy is an
   * administrator removing it and adding it again. Beside an entry this deployment could not read,
   * that claim is unfounded — one of those entries may BE the mode — and the remedy is work that
   * changes nothing, because the next answer is the same shape. So the vendor's remedy wins.
   */
  test("a wanted mode missing beside an unreadable entry is a shape refusal, not a withdrawn mode", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          retrieve: async () => ({
            auth_config_details: [{ mode: "OAUTH2", fields: {} }, "API_KEY"],
          }),
        },
      }),
    );

    const refusal = await failureOf(
      broker.connectionFields({ toolkit: "drifted", authScheme: "API_KEY" }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).toMatch(/@composio\/core/);
    expect(refusal.message).not.toMatch(/no longer publishes/);
  });

  /**
   * A VENDOR BOOLEAN THAT IS NOT A BOOLEAN IS THE ONE STATE `=== true` CANNOT REPORT.
   *
   * `row.required === true` has three inputs and two answers. An ABSENT flag reading as "optional"
   * is the benign default this idiom was chosen for, and it stays. A PRESENT `"true"` reading as
   * "optional" is a different fact wearing the same answer: Composio said the field has to be
   * filled in, and the form drew a box a person may leave blank.
   *
   * WHICH IS LOAD-BEARING BECAUSE THE CONNECT ROUTE NOW READS THIS BOOLEAN. The guard that refuses
   * a submission omitting a required field asks this field and no other, so a vendor publishing
   * `"true"` makes the guard wave through the exact submission it was added to refuse: a
   * connection Composio answers `ACTIVE` for with the credential missing out of it.
   *
   * REFUSED RATHER THAN COERCED, AND THE STRING IS THE ARGUMENT. The drift that publishes `"true"`
   * publishes `"false"` on the fields beside it, and `"false"` is a truthy string — so a
   * `Boolean(...)` written to rescue this case turns every optional field into a required one and
   * stops a person connecting at all. There is no reading of a wrong-shaped flag that is right on
   * both halves, which is what every other reader in this file already says about a vendor value it
   * cannot read.
   */
  test("a required flag Composio sent as a string is refused rather than read as optional", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          retrieve: async () => ({
            auth_config_details: [
              {
                mode: "API_KEY",
                fields: {
                  connected_account_initiation: {
                    required: [
                      {
                        name: "generic_api_key",
                        displayName: "API Key",
                        description: "",
                        type: "string",
                        required: "true",
                        is_secret: true,
                        user_visible: true,
                      },
                    ],
                    optional: [],
                  },
                },
              },
            ],
          }),
        },
      }),
    );

    const refusal = await failureOf(
      broker.connectionFields({
        toolkit: "perplexityai",
        authScheme: "API_KEY",
      }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    // The shape and never the value, like every other vendor read here.
    expect(refusal.message).toMatch(/with a string where/);
    expect(refusal.message).toMatch(/has to be filled in/);
    expect(refusal.message).toMatch(/@composio\/core/);
  });

  /**
   * AND THE SAME SHAPE ON `is_secret` IS THE OTHER HALF OF ONE BOX'S DESCRIPTION.
   *
   * Read as a no — which is what `=== true` makes of `"true"` — the box for somebody's API key is
   * drawn as ordinary text: typed in plain sight, left on the screen, and offered to whatever the
   * browser fills fields with. That is not a smaller failure than the required one, it is a quieter
   * one, and it is the same vendor drift arriving one field along.
   */
  test("a secret flag Composio sent as a string is refused rather than drawn unmasked", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          retrieve: async () => ({
            auth_config_details: [
              {
                mode: "API_KEY",
                fields: {
                  connected_account_initiation: {
                    required: [
                      {
                        name: "generic_api_key",
                        displayName: "API Key",
                        description: "",
                        type: "string",
                        required: true,
                        is_secret: "true",
                        user_visible: true,
                      },
                    ],
                    optional: [],
                  },
                },
              },
            ],
          }),
        },
      }),
    );

    const refusal = await failureOf(
      broker.connectionFields({
        toolkit: "perplexityai",
        authScheme: "API_KEY",
      }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/with a string where/);
    expect(refusal.message).toMatch(/holds a secret/);
  });

  /**
   * AND THE VISIBILITY FLAG IS THE THIRD, WHOSE DEFAULT POINTS THE OTHER WAY AND WHOSE FAULT DOES
   * NOT.
   *
   * `user_visible !== false` is right about an absent flag — a field Composio says nothing about is
   * one to show — and it reads a present `"false"` as "show it" too, which is Composio saying the
   * opposite. What that draws is a box for a value Composio fills in itself: a person is asked for
   * a tenant id they have no way to know, and the field they leave blank is submitted as an empty
   * one.
   */
  test("a visibility flag Composio sent as a string is refused rather than read as visible", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          retrieve: async () => ({
            auth_config_details: [
              {
                mode: "API_KEY",
                fields: {
                  connected_account_initiation: {
                    required: [
                      {
                        name: "internal_tenant",
                        displayName: "Tenant",
                        description: "",
                        type: "string",
                        required: true,
                        is_secret: false,
                        user_visible: "false",
                      },
                    ],
                    optional: [],
                  },
                },
              },
            ],
          }),
        },
      }),
    );

    const refusal = await failureOf(
      broker.connectionFields({ toolkit: "hidden", authScheme: "API_KEY" }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/with a string where/);
    expect(refusal.message).toMatch(/shown to the person filling the form in/);
  });

  /**
   * THE ABSENCES STAY BENIGN, WHICH IS THE HALF THE FIX MUST NOT TAKE WITH IT.
   *
   * Composio genuinely publishes optional fields with no `required` key, ordinary fields with no
   * `is_secret` and visible ones with no `user_visible` — three states that are facts about the
   * field rather than faults in the answer. A guard that refused those would refuse most of the
   * catalogue, which is the opposite mistake and the reason `=== true` was reasonable to begin
   * with.
   */
  test("a field publishing none of the three flags is read at its defaults rather than refused", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          retrieve: async () => ({
            auth_config_details: [
              {
                mode: "API_KEY",
                fields: {
                  connected_account_initiation: {
                    required: [],
                    optional: [
                      {
                        name: "base_url",
                        displayName: "Base URL",
                        description: "",
                        type: "string",
                      },
                    ],
                  },
                },
              },
            ],
          }),
        },
      }),
    );

    expect(
      await broker.connectionFields({
        toolkit: "sparse",
        authScheme: "API_KEY",
      }),
    ).toEqual([
      {
        name: "base_url",
        label: "Base URL",
        help: "",
        required: false,
        secret: false,
      },
    ]);
  });
});

/**
 * THE ONE CALL IN THIS SEAM THAT DROPS THE VENDOR'S ERROR RATHER THAN CARRYING IT.
 *
 * Every other refusal below this adapter keeps the original as `cause`, deliberately, because the
 * object holds the request it was made for and whoever is reading a log rather than a page deserves
 * it. On every other call that request is a link mint or a delete. On this one it is somebody's API
 * key — so the rule reverses here, and the reversal is worth a test rather than a comment because
 * nothing about it is visible in a type or in a passing happy path.
 *
 * THE LEAK TEST ASKS THE WHOLE THROWN OBJECT AND NOT ITS MESSAGE. `JSON.stringify` of an `Error` is
 * `{}` — its fields are non-enumerable — so a check written against that would stay green over a
 * `cause` carrying the entire request body, which is exactly the defect this is about. What is
 * asserted is that a recognisable secret planted on the vendor's error reaches none of the message,
 * the `cause`, or any own property of what escapes, at any depth.
 */
describe("connecting one person with the secret they typed", () => {
  /** Shaped like the thing a person pastes into the form, and recognisable wherever it surfaces. */
  const TYPED_SECRET = "pplx-LEAK-CANARY-3f9a2c";

  /**
   * Every string the thrown object carries, its own property names included, at every depth.
   *
   * `JSON.stringify(error)` answers `{}` for an `Error`, because `message`, `stack` and `cause` are
   * all non-enumerable — so a leak test written against it would pass over a `cause` holding the
   * whole request. This asks for the own property names at each level and follows whatever hangs
   * off them, which is where the secret would be if this call ever carried the vendor's object out.
   */
  function everythingCarriedBy(value: unknown, depth = 0): string {
    // Deep enough to reach a typed value at the bottom of a request body hanging off a `cause`,
    // which is seven levels down from the thrown error and is the whole thing this is looking for.
    if (depth > 12) return "";
    if (typeof value === "string") return value;
    if (typeof value !== "object" || value === null) return String(value);
    const held = value as Record<string, unknown>;
    return Object.getOwnPropertyNames(held)
      .map((name) => `${name}=${everythingCarriedBy(held[name], depth + 1)}`)
      .join(" ");
  }

  /**
   * The thrown object as a handler further out would serialize it, hidden fields expanded.
   *
   * `JSON.stringify(error)` IS `{}` AND THE OBVIOUS FIX IS BARELY BETTER. An `Error`'s `message`,
   * `stack` and `cause` are all non-enumerable, so the first form sees none of them — and
   * `JSON.stringify(error, Object.getOwnPropertyNames(error))` passes a replacer ARRAY, which is a
   * key allow-list applied at EVERY depth: it names the top error's three fields and then filters
   * the request body out of the very `cause` it just let through. Measured against the version of
   * this adapter that attached the cause, that assertion passed while the key was two levels below
   * it. The replacer below expands each error into its own property names instead and lets the
   * plain objects under them through whole, which is the serialization this call has to survive.
   */
  function serializedWith(error: Error): string {
    return JSON.stringify(error, (_key, value: unknown) => {
      if (!(value instanceof Error)) return value;
      const own = value as unknown as Record<string, unknown>;
      return Object.fromEntries(
        Object.getOwnPropertyNames(own).map((name) => [name, own[name]]),
      );
    });
  }

  test("what the person typed is sent as this connection's state, and the account comes back", async () => {
    const asked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: [OURS] }) },
        connectedAccounts: {
          create: async (body: unknown) => {
            asked.push(body);
            return { id: "ca_new", status: "ACTIVE" };
          },
        },
      }),
    );

    expect(
      await broker.connectWithFields({
        userId: "user_1",
        toolkit: "linear",
        authScheme: "API_KEY",
        values: { generic_api_key: TYPED_SECRET, subdomain: "acme" },
      }),
    ).toEqual({ accountId: "ca_new" });

    /*
     * THE WHOLE BODY, because every part of it decides something. The config is this deployment's
     * own rather than whichever row the vendor listed first; the user id is what every later call
     * names the account by; and the state is the scheme the form was drawn for with the typed
     * values under it, which is the shape `AuthScheme.APIKey` builds (`@composio/core` 0.18.1,
     * `src/models/AuthScheme.ts:84-94`) and the one the raw create declares.
     */
    expect(asked).toEqual([
      {
        auth_config: { id: OURS.id },
        connection: {
          user_id: "user_1",
          state: {
            authScheme: "API_KEY",
            val: {
              status: "ACTIVE",
              generic_api_key: TYPED_SECRET,
              subdomain: "acme",
            },
          },
        },
      },
    ]);
  });

  test("a value named status cannot displace the state this call is making", async () => {
    /*
     * `status` IS THE PROTOCOL'S WORD AND THE VALUES ARE THE VENDOR'S, IN ONE OBJECT. The state this
     * call sends is `{ status: "ACTIVE", ...values }` — the shape `AuthScheme.APIKey` builds
     * (`@composio/core` 0.18.1, `src/models/AuthScheme.ts:84-94`) — so a value arriving under the
     * name `status` is spread OVER the one word in that object that says what is being created. What
     * Composio is then told is whatever that value says: an account asked for in a state nobody
     * chose, from a request that looks exactly like an ordinary connection.
     *
     * WHICH IS A GUARD AT THIS SEAM RATHER THAN ONLY AT THE ROUTE ABOVE IT. `connectionFields`
     * refuses to draw a box named `status` and the connect route sends only names that list
     * published, so nothing reaching here through a form can carry one. This method is callable
     * without either, and the word it protects is the one that cannot be re-derived afterwards.
     */
    const asked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: [OURS] }) },
        connectedAccounts: {
          create: async (body: unknown) => {
            asked.push(body);
            return { id: "ca_new", status: "ACTIVE" };
          },
        },
      }),
    );

    await broker.connectWithFields({
      userId: "user_1",
      toolkit: "linear",
      authScheme: "API_KEY",
      values: { generic_api_key: TYPED_SECRET, status: "INITIALIZING" },
    });

    expect(asked).toEqual([
      {
        auth_config: { id: OURS.id },
        connection: {
          user_id: "user_1",
          state: {
            authScheme: "API_KEY",
            // The word this deployment sets, whatever arrived beside it under the same name.
            val: { generic_api_key: TYPED_SECRET, status: "ACTIVE" },
          },
        },
      },
    ]);
  });

  test("a failure on that call carries no vendor object, because the object holds the key", async () => {
    /*
     * THE VENDOR'S ERROR AS IT ARRIVES FROM A CREATE THAT WAS REFUSED. `@composio/client` hangs the
     * response body on `.error` — which is the shallower of the two depths `vendorSentence` reads —
     * and the object also carries the request it was made for. On this one call that request is the
     * form somebody just filled in, which is why the secret below is planted there and nowhere in
     * the sentence: what must survive is Composio's own words, and what must not is everything else.
     */
    const raised = Object.assign(
      new Error(`400 {"error":{"message":"Invalid credential"}}`),
      {
        error: {
          error: {
            message:
              "Composio could not use that credential for linear (request req_9f3c).",
          },
        },
        request: {
          body: {
            auth_config: { id: OURS.id },
            connection: {
              user_id: "user_1",
              state: {
                authScheme: "API_KEY",
                val: { status: "ACTIVE", generic_api_key: TYPED_SECRET },
              },
            },
          },
        },
      },
    );

    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: [OURS] }) },
        connectedAccounts: {
          create: async () => {
            throw raised;
          },
        },
      }),
    );

    const refusal = await failureOf(
      broker.connectWithFields({
        userId: "user_1",
        toolkit: "linear",
        authScheme: "API_KEY",
        values: { generic_api_key: TYPED_SECRET },
      }),
    );

    // Composio's own sentence is what an operator is left with, request id and all, because that is
    // the string their dashboard searches on and the only diagnostic this call agrees to keep.
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).toMatch(/req_9f3c/);

    // And the object it came out of is gone: not rethrown, not attached, not reachable from what a
    // handler further out will serialize.
    expect(refusal).not.toBe(raised);
    expect(refusal.cause).toBeUndefined();
    expect(everythingCarriedBy(refusal)).not.toContain(TYPED_SECRET);
    expect(serializedWith(refusal)).not.toContain(TYPED_SECRET);
    expect(everythingSaidBy(refusal).join("\n")).not.toContain(TYPED_SECRET);
  });

  test("a reply with no account id is refused rather than answered as a connection", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: [OURS] }) },
        connectedAccounts: { create: async () => ({ status: "ACTIVE" }) },
      }),
    );

    const refusal = await failureOf(
      broker.connectWithFields({
        userId: "user_1",
        toolkit: "linear",
        authScheme: "API_KEY",
        values: { generic_api_key: TYPED_SECRET },
      }),
    );

    /*
     * AN ACCOUNT MAY BE STANDING AT COMPOSIO OVER A REFUSAL HERE, which is the one thing this
     * sentence has to carry: the id is what a caller undoes its own work with, so without one there
     * is a connection nothing on this deployment can name or take back. The dashboard is where it
     * can be seen and removed, and it is the only remedy there is.
     */
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).toMatch(/dashboard/);
    expect(refusal.message).not.toContain(TYPED_SECRET);
  });

  test("an app with no config of this deployment's is refused before anything is sent", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        // The create is left at `fakeVendor`'s refusal, which is what says the value typed in went
        // nowhere: a call that was made would name itself here rather than answering.
        authConfigs: { list: async () => ({ items: [BY_HAND] }) },
      }),
    );

    const refusal = await failureOf(
      broker.connectWithFields({
        userId: "user_1",
        toolkit: "linear",
        authScheme: "API_KEY",
        values: { generic_api_key: TYPED_SECRET },
      }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).toMatch(NO_CONFIG_REMEDY);
    expect(refusal.message).not.toContain(TYPED_SECRET);
  });

  /**
   * THE TWO BELOW ASSERT AN ORDER RATHER THAN A SENTENCE, AND THE ORDER IS THE WHOLE STANCE.
   *
   * A create that ANSWERS is what makes them able to fail. Left at {@link fakeVendor}'s refusal, an
   * implementation that sent the key would throw the double's own error, {@link failureOf} would
   * hand back a refusal, and a test asking only "did this refuse" would be green over the exact
   * defect — the secret having travelled. So the double here succeeds like the real vendor does on
   * a key it has not graded, and what is asserted is that it was never called: `created` empty is
   * the statement that the person's credential did not leave this process.
   */
  test("a config of ours that is disabled is refused before the key is sent", async () => {
    const created: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        /*
         * `configsFor` LISTS WITH `showDisabled: true`, so this row is one this read can meet and
         * `ours[0]` cannot tell it from a working config. Composio does not grade a submitted key,
         * so a create against it is a request that carries the secret out of this process and comes
         * back with an account that cannot work.
         */
        authConfigs: {
          list: async () => ({
            items: [
              { id: "ac_ours", name: "Linear (OpenBot)", status: "DISABLED" },
            ],
          }),
        },
        connectedAccounts: {
          create: async (body: unknown) => {
            created.push(body);
            return { id: "ca_new", status: "ACTIVE" };
          },
        },
      }),
    );

    const refusal = await failureOf(
      broker.connectWithFields({
        userId: "user_1",
        toolkit: "linear",
        authScheme: "API_KEY",
        values: { generic_api_key: TYPED_SECRET },
      }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(DISABLED_REMEDY);
    expect(refusal.message).not.toMatch(NO_CONFIG_REMEDY);
    expect(refusal.message).not.toContain(TYPED_SECRET);
    // The point of the test: the refusal arrived before the credential did, not after Composio had
    // been handed it and answered.
    expect(created).toEqual([]);
  });

  /**
   * AND THE SAME PAIR HERE, BECAUSE THIS METHOD WRITES THE SAME CHAIN AS `authorize`.
   *
   * The unsettled-status block is duplicated between the two methods rather than shared, so the
   * suppression is duplicated with it: a person typing their key into an app whose configs are one
   * DISABLED and one PENDING was told only to upgrade a package. Enabling the disabled config in
   * Composio's dashboard is what gets their key accepted, and it is not this person's act — which
   * is precisely why the sentence has to carry it rather than choose between the two.
   */
  test("a disabled config beside an unsettled one is told both remedies here too", async () => {
    const created: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: "ac_a", name: "Linear (OpenBot)", status: "DISABLED" },
              { id: "ac_b", name: "Linear (OpenBot)", status: "PENDING" },
            ],
          }),
        },
        connectedAccounts: {
          create: async (body: unknown) => {
            created.push(body);
            return { id: "ca_new", status: "ACTIVE" };
          },
        },
      }),
    );

    const refusal = await failureOf(
      broker.connectWithFields({
        userId: "user_1",
        toolkit: "linear",
        authScheme: "API_KEY",
        values: { generic_api_key: TYPED_SECRET },
      }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).toMatch(/neither ENABLED nor DISABLED/);
    expect(refusal.message).toMatch(DISABLED_REMEDY);
    // And neither clause is worth what it would cost to send the key first.
    expect(refusal.message).not.toContain(TYPED_SECRET);
    expect(created).toEqual([]);
  });

  test("a listing this deployment cannot read does not send an administrator round a loop", async () => {
    const created: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [{ id: "ac_nameless" }] }),
        },
        connectedAccounts: {
          create: async (body: unknown) => {
            created.push(body);
            return { id: "ca_new", status: "ACTIVE" };
          },
        },
      }),
    );

    const refusal = await failureOf(
      broker.connectWithFields({
        userId: "user_1",
        toolkit: "linear",
        authScheme: "API_KEY",
        values: { generic_api_key: TYPED_SECRET },
      }),
    );

    /*
     * NOT THE NO-CONFIG REMEDY, which is the finding. The unreadable row may itself BE ours, in
     * which case removing the app meets `deleteAuthConfig`'s refusal over the same row and adding
     * it again meets `ensureAuthConfig`'s — an administrator sent round a loop that cannot close.
     * `authorize` tells the two states apart against this same listing; this path handed out the
     * wrong one of the two.
     */
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).not.toMatch(NO_CONFIG_REMEDY);
    expect(refusal.message).not.toMatch(DISABLED_REMEDY);
    expect(refusal.message).toMatch(
      /upgrading this deployment's @composio\/core/,
    );
    expect(refusal.message).not.toContain(TYPED_SECRET);
    // And no `cause`, because this method's refusals carry none — see the describe above.
    expect(refusal.cause).toBeUndefined();
    expect(created).toEqual([]);
  });
});

/**
 * ENDING ONE ACCOUNT BY ID, WHICH IS A DIFFERENT QUESTION FROM ENDING A PERSON'S ACCESS.
 *
 * `revoke` above is asked "this person is done with this app" and has to go and find out what that
 * means: it lists, it matches, and it deletes everything it found. This one is asked "take back the
 * account you just made", and the id it is handed is the whole of the question — so the listing
 * that makes the other method correct is, here, both a call nothing needs and a set of accounts
 * nobody asked about. The two differ exactly where the local row and Composio have drifted apart,
 * which is the state a failed verification is standing in: a connection that works beside the
 * attempt that did not. The absence of the listing is therefore asserted rather than assumed.
 */
describe("taking back the one account a verification just made", () => {
  test("the delete names that account and asks for the grant behind it, with nothing listed first", async () => {
    const deleted: unknown[] = [];
    /*
     * THE LISTINGS ANSWER RATHER THAN REFUSE, deliberately, and that is what makes this an
     * assertion about the method instead of about {@link fakeVendor}. Left at the refusals, a
     * sweeping implementation would fail here on a thrown fixture and the failure would read like
     * an unrelated vendor error; answering means a sweep gets everything it needs and is caught by
     * the one thing that is actually wrong with it — that it went looking at all.
     */
    const listed: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => {
            listed.push("authConfigs.list");
            return { items: [OURS] };
          },
        },
        connectedAccounts: {
          list: async () => {
            listed.push("connectedAccounts.list");
            return { items: [{ id: "ca_new" }] };
          },
          delete: async (id: unknown, params: unknown) => {
            deleted.push([id, params]);
            return WITHDRAWN;
          },
        },
      }),
    );

    await broker.revokeAccount("ca_new");

    /*
     * THE ID AS IT WAS HANDED OVER, AND THE FLAG BESIDE IT. Without `revoke_on_delete` the account
     * stops being visible to this deployment and the credential at the far end stands — which is
     * worse here than anywhere else in this file, because the secret left live is one somebody
     * typed into a form minutes ago that then told them the connection had not been kept.
     */
    expect(deleted).toEqual([["ca_new", { revoke_on_delete: true }]]);
    expect(listed).toEqual([]);
  });

  /**
   * AND WHAT COMPOSIO ANSWERED IS READ, BECAUSE THE CALLER BRANCHES ON THIS CALL RETURNING CLEANLY.
   *
   * The await used to drop the reply, so a 200 carrying `success: false` — Composio saying it did
   * NOT delete the account and started no revocation — resolved like a withdrawal that happened.
   * The verification step above this reads exactly that: a key that fails verification has its
   * account withdrawn, and where the WITHDRAWAL fails the row is written unverified so the account
   * stays named on a screen and disconnectable. A `success: false` resolving normally takes the
   * other branch, writes no row, and leaves a live account holding a credential that nothing in
   * this deployment names and nobody can press disconnect on.
   *
   * THE SENTENCES ARE THIS METHOD'S OWN, which is why they are asserted rather than assumed from
   * {@link withdrawalDeclined}. That function's two are written around a toolkit and around
   * pressing disconnect again; this call was handed an id, and the second press it would invite is
   * a button on no page.
   */
  test("the one account's delete answered `success: false` is not a withdrawal", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        connectedAccounts: {
          // A 200 whose body says the account was not deleted: the flag went out, Composio read the
          // request and answered it. This is the vendor declining rather than failing.
          delete: async () => ({ success: false }),
        },
      }),
    );

    const refusal = await failureOf(broker.revokeAccount("ca_new"));

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/success: false/);
    // The two facts the caller has to be able to act on: the account stands, and the credential
    // behind it was never withdrawn.
    expect(refusal.message).toMatch(/still standing at Composio/);
    expect(refusal.message).not.toMatch(
      /upgrading this deployment's @composio\/core/,
    );
  });

  test("the one account's delete with no verdict in it is not counted as one either", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        connectedAccounts: {
          /*
           * A DOCUMENT THAT ARRIVED WITHOUT ITS VERDICT, which is not the same thing as no document
           * at all. `success` is required in the declaration and absent on this wire, and the
           * generated client parses the body and hands it over — so the schema's "required" is a
           * promise about what Composio means to send rather than a fact about what came.
           */
          delete: async () => ({}),
        },
      }),
    );

    const refusal = await failureOf(broker.revokeAccount("ca_new"));

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    /*
     * A DIFFERENT SENTENCE FROM THE ONE ABOVE. "Composio said no" is a fact about this account;
     * "Composio answered something where its verdict belongs" is a fact about the package, which
     * nobody holding an admin page can correct — so it carries the remedy that names the upgrade
     * and the other one must not.
     */
    expect(refusal.message).toMatch(
      /upgrading this deployment's @composio\/core/,
    );
    expect(refusal.message).not.toMatch(/success: false/);
  });

  /** The same distinction one method over: an answer that is no document is not a missing field. */
  test("the one account's withdrawal answered with something that is not a document names the answer", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        connectedAccounts: { delete: async () => "deleted" },
      }),
    );

    const refusal = await failureOf(broker.revokeAccount("ca_new"));

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(
      /sent a string where its reply to the withdrawal/,
    );
    expect(refusal.message).not.toMatch(/where its verdict/);
    expect(refusal.message).toMatch(
      /upgrading this deployment's @composio\/core/,
    );
  });

  /**
   * AND NO DOCUMENT AT ALL IS COMPOSIO SAYING IT DID DELETE, which is the opposite mistake and the
   * one {@link withdrawalDeclined} was corrected for once already. The installed client resolves a
   * 204 to `null` and a JSON reply carrying `content-length: 0` to `undefined`, and neither can be
   * a rejection: every `!response.ok` is thrown as an `APIError` before parsing, so an answer
   * arriving here at all is Composio having accepted the request. Reading those as "no verdict"
   * would turn a completed withdrawal into a failure — which, on this path, has the caller write
   * the account's row as unverified over an account that is already gone.
   */
  for (const { shape, answer } of [
    { shape: "a 204 carrying no content", answer: null },
    { shape: "a JSON reply of content-length zero", answer: undefined },
  ]) {
    test(`the one account's withdrawal answered with ${shape} is a withdrawal`, async () => {
      const deleted: unknown[] = [];
      const { broker } = buildComposioClient(
        fakeVendor({
          connectedAccounts: {
            delete: async (...call: unknown[]) => {
              deleted.push(call);
              return answer;
            },
          },
        }),
      );

      expect(await broker.revokeAccount("ca_new")).toBeUndefined();
      // And the flag still went out, so what resolved is a delete that asked for the grant behind
      // the account to be withdrawn rather than one that quietly filed the account away.
      expect(deleted).toEqual([["ca_new", { revoke_on_delete: true }]]);
    });
  }
});
