import { afterAll, describe, expect, test } from "bun:test";
import Arcade, { APIError } from "@arcadeai/arcadejs";
import { classify } from "../src/plugins/arcade";
import {
  createArcadeClient,
  normalizeArcadeError,
} from "../src/plugins/arcade-adapter";
import { mintDeploymentVendorUserId } from "../src/plugins/shared-accounts";

/**
 * The real Arcade, so the shapes this transport is written against are the shapes it gets.
 *
 * WRITTEN BLIND, AND SINCE RUN ONCE. Nothing in this branch had contacted Arcade when this file was
 * authored; one live run has happened since. It came back 9 passed / 3 failed, and not one was the
 * vendor's: `next_uri` died on bun's 5000ms default without measuring anything, GATE 4 asserted the
 * wrong spelling of `provider_id` (which is also how it hid a real product defect in the connection
 * filter, fixed separately), and GATE 2 asserted an assumption the wire does not support. All three
 * are corrected here: the gates now say what was measured, every dialling case carries an explicit
 * timeout, and each comment records the verbatim observation rather than the expectation it
 * replaced. A live run remains a separate, human-authorised step.
 *
 * WHY THIS EXISTS AT ALL. A stub asserts what its author believed; this asserts what the vendor does.
 * `composio-live.test.ts` is the pattern, and its argument carries over whole.
 *
 * WRITTEN AGAINST THE VENDOR'S TYPES, WITH NO `as never`. `server/tsconfig.json` does not include
 * `tests`, so nothing in the build type-checks this file, and a cast here would erase the only place
 * the real `@arcadeai/arcadejs` surface is named. Every call is typed by the SDK itself; where a
 * value is narrowed it is narrowed by a runtime check that says what was missing, never by a cast
 * asserting it was there.
 *
 * SKIPPED WITHOUT A KEY. Run it deliberately, through the package script, which refuses to exit 0
 * when the key is empty (a skipped suite would otherwise look like a passed one):
 *
 *   ARCADE_API_KEY=... bun run test:live-arcade
 *
 * WHAT YOU MUST SET UP FIRST (the consent cases need a person and a browser)
 * - The Arcade project's CUSTOM USER VERIFIER URL must point at this machine:
 *   `http://localhost:${ARCADE_LIVE_VERIFIER_PORT:-8765}/`. The suite listens there, as the stand-in
 *   for the product's own verifier route, and reads what Arcade sends it. Restore the setting after.
 * - You will be shown ONE authorization URL on stderr and must open it and consent. It is a bearer
 *   capability for a throwaway user id; it is printed to you, the caller, and goes nowhere else.
 * - Optional: ARCADE_LIVE_TOOLKIT (default `Github`; the toolkit whose blast radius is measured and
 *   whose action is consented to), ARCADE_LIVE_ACTION (the qualified action to mint for; default the
 *   first listed read-only action), ARCADE_LIVE_CONSENT_TIMEOUT_S (default 300).
 *
 * WHAT THIS CREATES AND MUTATES IN THE ARCADE PROJECT THE KEY BELONGS TO (this is PRODUCTION if the
 * key is)
 * - ONE authorization attempt (`ar_...`) per successful mint, for ONE throwaway user id of the shape
 *   `openbot-deployment:live-arcade:<random>`. Several mints are attempted: the `next_uri` cases are
 *   expected to be refused, and if one is ever accepted it creates an attempt too.
 * - ONE completed CONSENT by YOU, at the third party (Github by default), and so ONE user-connection
 *   (`ac_...`) under that throwaway user id in Arcade. It is the only durable write.
 * - Everything else is a read: tool listings, user-connection listings, `auth.status`.
 * - A deliberate wrong-user `confirm_user` (the `user_mismatch` case); it is expected to be refused.
 *
 * WHAT IT DELETES AFTERWARDS: every user-connection for that one throwaway user id, in the delete case
 * and again in `afterAll` if an earlier case failed first. It never lists or deletes anyone else's.
 *
 * WHAT IT CANNOT CLEAN UP, and you must:
 * - The grant at the third party. Deleting an Arcade connection does not necessarily revoke your
 *   consent there; remove the OAuth app authorization from the provider's own settings page.
 * - The `ar_...` attempt records. The SDK has no call to delete one; they expire on their own.
 * - If the run is killed before `afterAll`, the connection survives. Its user id is printed first so
 *   it can be found and deleted in the Arcade dashboard.
 *
 * NEVER PRINTED: anything from an `auth.status` response beyond `status`, `user_id` and `scopes`. The
 * response carries `context.token`, a live provider access token, and the person's profile. This file
 * reads three fields out of it and drops the object, as the adapter does.
 *
 * NEVER NORMALIZED: toolkit and action names keep Arcade's own case throughout.
 *
 * THE FOUR MERGE-GATE QUESTIONS are named cases, `GATE 1` to `GATE 4`. Each prints one line starting
 * `GATE n` and says in a comment what each outcome means. A human reads those lines.
 *
 * THREE FENCED FACTS THAT LOOK LIKE BUGS AND ARE MEASUREMENTS; this suite proves them, never "fixes"
 * them: (1) `next_uri` is never sent to `tools.authorize`; (2) `admin.userConnections.delete` takes
 * `connection_id` (`ac_...`), not the `id` (`at_...`) listed first; (3) `listTools` reads
 * `requirements.authorization.oauth2.scopes`, never `requirements.met`.
 */
const key = process.env.ARCADE_API_KEY?.trim();
const live = process.env.OPENBOT_LIVE_ARCADE === "1" && Boolean(key);

const PORT = Number(process.env.ARCADE_LIVE_VERIFIER_PORT ?? "8765");
const TOOLKIT = process.env.ARCADE_LIVE_TOOLKIT?.trim() || "Github";
const CONSENT_TIMEOUT_S = Number(
  process.env.ARCADE_LIVE_CONSENT_TIMEOUT_S ?? "300",
);

/**
 * EVERY CASE THAT DIALS ARCADE CARRIES AN EXPLICIT TIMEOUT, because bun's per-test default is 5000ms
 * and a vendor round-trip is nothing like a unit test's. This is measured, not defensive: the first
 * live run of this file failed `next_uri is refused for every value` on duration alone —
 * `[5001.03ms] ^ this test timed out after 5000ms` — five sequential refusals against a 5s budget,
 * so the case measured nothing it was written to measure. The consent case already carried its own
 * (it waits through a 300s consent); every other dialling case now does too, to the same pattern: a
 * trailing argument to `test`, and a trailing `options` argument to `afterAll`.
 *
 * Generous rather than tuned. A timeout here is a runaway guard, not a performance assertion — a
 * slow but correct vendor must not be reported as a wrong one.
 */
const VENDOR_TIMEOUT_MS = 60_000;

/** `auth.status` is POLLED, so its bound is the poll's own, not one round-trip's. */
const STATUS_POLLS = 6;
const STATUS_POLL_INTERVAL_MS = 2_000;
const STATUS_TIMEOUT_MS = STATUS_POLLS * (STATUS_POLL_INTERVAL_MS + 10_000);

/** The Google family: two toolkits that, on Arcade, are expected to share one auth provider. */
const GOOGLE_TOOLKITS = ["Gmail", "GoogleCalendar"];

/** One throwaway person, so nothing here can touch an account that belongs to somebody. */
const USER = mintDeploymentVendorUserId("live-arcade");
const ACCOUNT = { holder: "deployment" as const, vendorUserId: USER };
/** A user id that is not the attempt's, for the `user_mismatch` case. */
const OTHER_USER = mintDeploymentVendorUserId("live-arcade-other");

const say = (line: string) => process.stdout.write(`${line}\n`);

/** Constructed lazily: Bun evaluates a skipped describe's body, and the constructor throws keyless. */
const arcade = () => new Arcade({ apiKey: key });

/** A precondition that was not met is stated, not asserted into existence. */
function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined || value === "") {
    throw new Error(
      `Precondition not met: ${what}. Nothing after this point was exercised.`,
    );
  }
  return value;
}

/** Every item of a toolkit's listing, for one user, paged by the SDK. */
async function listToolkit(client: Arcade, toolkit: string, userId?: string) {
  const items: Arcade.ToolDefinition[] = [];
  for await (const item of client.tools.list({
    toolkit,
    user_id: userId,
    limit: 100,
  })) {
    items.push(item);
  }
  return items;
}

/** `met` ACROSS A WHOLE TOOLKIT: what was granted, as against what was asked for. */
const metCount = (items: Arcade.ToolDefinition[]) =>
  items.filter((item) => item.requirements?.met === true).length;

const providersOf = (items: Arcade.ToolDefinition[]) => [
  ...new Set(
    items
      .map((item) => item.requirements?.authorization?.provider_id)
      .filter((p): p is string => typeof p === "string"),
  ),
];

/** The one failure an SDK call is allowed to be expected to throw. */
async function failureOf(call: () => Promise<unknown>): Promise<APIError> {
  let thrown: unknown;
  try {
    await call();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(
      "The call was expected to be refused and it succeeded. Whatever it created now exists in the project.",
    );
  }
  if (!(thrown instanceof APIError)) {
    throw new Error(
      `The call failed, but not with an SDK APIError (${thrown instanceof Error ? thrown.name : typeof thrown}), so no wire answer was read.`,
    );
  }
  return thrown;
}

/** The state the consent sequence hands from one case to the next. */
const run: {
  action?: string;
  baselineMet?: number;
  total?: number;
  authorizationId?: string;
  url?: string;
  callbackKeys?: string[];
  flowId?: string;
  connectionId?: string;
  rowId?: string;
  grantedScopes?: string[];
} = {};

describe.skipIf(!live)("Arcade, for real", () => {
  afterAll(async () => {
    if (!live) return;
    // Best effort, and only ever this run's own user id.
    const client = arcade();
    for await (const row of client.admin.userConnections.list({
      user_id: USER,
    })) {
      if (row.connection_id) {
        await client.admin.userConnections
          .delete(row.connection_id)
          .catch(() => {});
      }
    }
  }, VENDOR_TIMEOUT_MS);

  /**
   * GATE 1 — WHAT `provider_id` ACTUALLY MEANS ON A GOOGLE-FAMILY TOOLKIT.
   *
   * Pure read; nothing created. Prints, for `Gmail` and `GoogleCalendar`, the distinct provider ids
   * their listings name.
   * - ONE shared id, DIFFERENT from both toolkit names (e.g. `google`): `provider_id` is an
   *   auth-provider configuration. D26's sibling set is non-empty in production: revoking Gmail also
   *   removes the Calendar connection.
   * - Each toolkit names a provider EQUAL to its own name: `provider_id` is effectively the toolkit.
   *   The sibling set is empty in production.
   * The design is safe under both readings (it reads the field, never derives it); the outcome only
   * decides whether D26's sibling code is ever exercised. No offline fixture names a toolkit's
   * provider differently from the toolkit, which is why only this can tell.
   */
  test(
    "GATE 1: what provider_id means on Gmail and GoogleCalendar",
    async () => {
      const client = arcade();
      const seen: Record<string, string[]> = {};
      for (const toolkit of GOOGLE_TOOLKITS) {
        const items = await listToolkit(client, toolkit);
        need(
          items.length > 0 ? items : null,
          `Arcade listed no ${toolkit} action, so its provider could not be read`,
        );
        seen[toolkit] = providersOf(items);
      }
      const all = new Set(Object.values(seen).flat());
      const sharedAndDistinct =
        all.size === 1 && !GOOGLE_TOOLKITS.some((name) => all.has(name));
      const equalToToolkit = GOOGLE_TOOLKITS.every((name) =>
        seen[name]?.every((p) => p === name),
      );
      say(
        `GATE 1  provider ids by toolkit: ${JSON.stringify(seen)}  ->  ` +
          (sharedAndDistinct
            ? "ONE shared provider, named differently from the toolkits: D26's sibling set IS non-empty in production"
            : equalToToolkit
              ? "each toolkit names a provider equal to itself: D26's sibling set is empty in production"
              : "MIXED: read the ids above and decide by hand"),
      );
      // Whichever reading holds, every toolkit must name exactly one provider, or authProviderOf
      // answers null and every connection under it reads as absent.
      for (const toolkit of GOOGLE_TOOLKITS) {
        expect(seen[toolkit]?.length).toBe(1);
      }
    },
    VENDOR_TIMEOUT_MS,
  );

  test(
    "the action to consent to is read from the listing, and the baseline is clean",
    async () => {
      const client = arcade();
      const items = await listToolkit(client, TOOLKIT, USER);
      run.total = items.length;
      need(
        items.length > 0 ? items : null,
        `Arcade listed no ${TOOLKIT} action`,
      );
      run.action =
        process.env.ARCADE_LIVE_ACTION?.trim() ||
        items.find((item) => {
          const verdict = classify(item.metadata);
          return verdict.effect === "read" && !verdict.destructive;
        })?.qualified_name;
      need(
        run.action,
        `${TOOLKIT} lists no read-only action and ARCADE_LIVE_ACTION is unset`,
      );
      // A fresh user id has granted nothing. If anything already reads `met`, the "before" is not a
      // baseline and the "after" would measure nothing.
      run.baselineMet = metCount(items);
      say(
        `BLAST RADIUS  baseline for ${TOOLKIT}: met ${run.baselineMet} of ${items.length}  (action to mint: ${run.action})`,
      );
      expect(run.baselineMet).toBe(0);
    },
    VENDOR_TIMEOUT_MS,
  );

  /**
   * FENCED FACT 1: `next_uri` IS REFUSED FOR EVERY VALUE, so the adapter never sends it.
   * Every value must answer 500 `invalid next URI`. If ANY is accepted, the fence is stale: report
   * it, do not start sending one.
   *
   * FIVE SEQUENTIAL ROUND-TRIPS, hence a timeout of five times the single-call budget. This case is
   * why {@link VENDOR_TIMEOUT_MS} exists: on the first live run it died at 5001ms against bun's
   * default, measuring none of the five.
   */
  test(
    "next_uri is refused for every value",
    async () => {
      const client = arcade();
      const action = need(run.action, "no action was chosen");
      const values = [
        "https://app.example.com/connections",
        `http://localhost:${PORT}/`,
        "https://cloud.arcade.dev",
        "http://localhost:3000/",
        "/relative/path",
      ];
      for (const next_uri of values) {
        const refusal = await failureOf(() =>
          client.tools.authorize({
            tool_name: action,
            user_id: USER,
            next_uri,
          }),
        );
        expect([next_uri, refusal.status]).toEqual([next_uri, 500]);
        expect(normalizeArcadeError(refusal)?.message ?? "").toMatch(
          /invalid next uri/i,
        );
      }
    },
    5 * VENDOR_TIMEOUT_MS,
  );

  /**
   * THE CONSENT: mint through OUR adapter, wait for the callback at a local stand-in for the
   * verifier, and keep only the flow id. A person is needed here.
   */
  test(
    "a mint through the adapter, and a callback carrying flow_id ONLY",
    async () => {
      const { broker } = createArcadeClient(need(key, "no ARCADE_API_KEY"));
      const action = need(run.action, "no action was chosen");

      let resolveCallback: (url: URL) => void = () => {};
      const callback = new Promise<URL>((resolve) => {
        resolveCallback = resolve;
      });
      const server = Bun.serve({
        port: PORT,
        fetch(request) {
          resolveCallback(new URL(request.url));
          return new Response("Consent received. You can close this tab.");
        },
      });
      try {
        const minted = await broker.authorize({
          account: ACCOUNT,
          toolkit: TOOLKIT,
          action,
          returnUrl: `http://localhost:${PORT}/`,
        });
        run.authorizationId = minted.authorizationId ?? undefined;
        expect(run.authorizationId).toMatch(/^ar_/);
        // To the caller, on stderr, once. Never to a log, an audit row or a `cause`.
        process.stderr.write(
          `\nOPEN THIS URL AND CONSENT (throwaway user ${USER}):\n${minted.redirectUrl}\n\n`,
        );

        const timeout = new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `No callback reached localhost:${PORT} in ${CONSENT_TIMEOUT_S}s. Is the project's custom verifier URL pointed at it, and was the consent completed?`,
                ),
              ),
            CONSENT_TIMEOUT_S * 1000,
          ),
        );
        const arrived = await Promise.race([callback, timeout]);
        run.callbackKeys = [...arrived.searchParams.keys()];
        run.flowId = arrived.searchParams.get("flow_id") ?? undefined;
        say(
          `CALLBACK  query parameters received: ${run.callbackKeys.join(",")}`,
        );
        // `flow_id` and nothing else: no user id, no auth id, no state to compare against.
        expect(run.callbackKeys).toEqual(["flow_id"]);
        need(run.flowId, "the callback carried no flow_id");
      } finally {
        server.stop(true);
      }
    },
    (CONSENT_TIMEOUT_S + 30) * 1000,
  );

  /**
   * GATE 2 — THE `user_mismatch` WIRE SHAPE. MEASURED, AND THE ANSWER IS THAT THERE ISN'T ONE.
   *
   * This case used to assert the ASSUMED shape, `{ mismatch: true }`. The first live run measured
   * what Arcade actually answers a wrong-user `confirm_user`, verbatim:
   *
   * ```
   * GATE 2  raw confirm_user as wrong user: status=400 name=coordinator_error message=Bad request
   * GATE 2  confirmReturn as wrong user: THREW Error
   * ```
   *
   * A GENERIC 400 CARRYING NOTHING THAT IDENTIFIES A MISMATCH. `coordinator_error` / "Bad request"
   * is the same answer a malformed flow id gets, so the `{ mismatch: true }` contract is UNREACHABLE
   * THROUGH THE LIVE API TODAY: `normalizeArcadeError` cannot match it without treating EVERY bad
   * request as "this handle belongs to somebody else", which is a worse failure than the
   * degradation. MEASURED-UNREACHABLE, NOT DEAD: the product keeps the `{ mismatch: true }` branch —
   * it costs nothing and starts working the day Arcade distinguishes the case, which is what would
   * make it reachable (a distinct error name, code or body field for a user mismatch).
   *
   * THIS IS A UX DEGRADATION AND NOT A HOLE, which is why the product is not being changed to chase
   * it. `confirmReturn` throws, the return-leg route's `catch` turns that into `vendor-unavailable`
   * rather than `not-your-authorization` — a vaguer sentence for the person, and nothing written
   * either way — and the leg stays bound by D24's `auth_id` comparison, which is an exact equality
   * over one id space and is unaffected by any of this.
   *
   * SO THIS CASE ASSERTS THE MEASUREMENT: the vendor refuses, and it refuses in a way that makes
   * `confirmReturn` throw. If it ever stops throwing, THAT is the news — either Arcade now names the
   * mismatch (make the branch reachable and assert it) or Arcade accepts any user for a flow, in
   * which case D24's `auth_id` comparison is the ONLY thing binding the callback to its attempt.
   * Both outcomes are printed below rather than hidden behind the assertion.
   *
   * Run BEFORE the correct confirm; if a mismatch burns the flow id the next case says so.
   */
  test(
    "GATE 2: the user_mismatch wire shape",
    async () => {
      const flowId = need(run.flowId, "no flow_id was captured");
      const client = arcade();
      let raw = "ACCEPTED (no refusal)";
      try {
        await client.auth.confirmUser({ flow_id: flowId, user_id: OTHER_USER });
      } catch (error) {
        const failure = normalizeArcadeError(error);
        raw = `status=${failure?.status} name=${failure?.name} message=${failure?.message}`;
      }
      const { broker } = createArcadeClient(need(key, "no ARCADE_API_KEY"));
      const flow = need(
        broker.authorizations,
        "the adapter has no authorizations",
      );
      let through = "";
      try {
        const answer = await flow.confirmReturn({
          handle: flowId,
          vendorUserId: OTHER_USER,
        });
        through =
          "authorizationId" in answer
            ? `ACCEPTED, authorization ${answer.authorizationId}`
            : "{ mismatch: true }";
      } catch (error) {
        through = `THREW ${error instanceof Error ? error.name : typeof error}`;
      }
      say(`GATE 2  raw confirm_user as wrong user: ${raw}`);
      say(`GATE 2  confirmReturn as wrong user: ${through}`);
      say(
        `GATE 2  ${
          through.startsWith("THREW")
            ? "the mismatch is NOT distinguishable on the wire: the product refuses the return leg with vendor-unavailable, and the auth_id comparison does the binding"
            : through === "{ mismatch: true }"
              ? "the mismatch IS distinguishable now: the { mismatch: true } branch is reachable, so assert it here instead"
              : "ARCADE ACCEPTED A WRONG USER FOR THIS FLOW: the auth_id comparison is the ONLY thing binding the callback to its attempt"
        }`,
      );
      // The vendor must refuse SOMEHOW; an acceptance is the one outcome that is news about the
      // binding rather than about the error shape.
      expect(raw).not.toBe("ACCEPTED (no refusal)");
      // And it refuses indistinguishably, so the adapter throws. See the docblock: measured, not assumed.
      expect(through.startsWith("THREW")).toBe(true);
    },
    VENDOR_TIMEOUT_MS,
  );

  test(
    "confirm_user returns the mint's own ar_ id as auth_id",
    async () => {
      const flowId = need(
        run.flowId,
        "no flow_id was captured (if GATE 2 ran, a mismatch may have consumed it)",
      );
      const answer = await arcade().auth.confirmUser({
        flow_id: flowId,
        user_id: USER,
      });
      expect(answer.auth_id).toBe(need(run.authorizationId, "no mint id"));
      expect(answer.auth_id).toMatch(/^ar_/);
    },
    VENDOR_TIMEOUT_MS,
  );

  test(
    "auth.status reaches completed and names the attempt's user_id",
    async () => {
      const id = need(run.authorizationId, "no mint id");
      const { broker } = createArcadeClient(need(key, "no ARCADE_API_KEY"));
      const flow = need(
        broker.authorizations,
        "the adapter has no authorizations",
      );
      let last = "";
      // Only the three narrowed fields are ever held; the token-carrying response never leaves the adapter.
      for (let i = 0; i < STATUS_POLLS; i += 1) {
        const seen = await flow.status(id);
        last = seen.status;
        if (seen.status === "completed") {
          expect(seen.userId).toBe(USER);
          run.grantedScopes = seen.scopes;
          say(
            `AUTH STATUS  completed; granted scopes: ${seen.scopes.join(" ") || "(none listed)"}`,
          );
          return;
        }
        await new Promise((r) => setTimeout(r, STATUS_POLL_INTERVAL_MS));
      }
      throw new Error(
        `auth.status never reached completed; last status was ${last}.`,
      );
    },
    STATUS_TIMEOUT_MS,
  );

  /**
   * THE BLAST-RADIUS MEASUREMENT. `met` across the WHOLE toolkit, from the clean baseline taken above.
   * Distinct REQUESTED scopes are NOT a substitute: they show what was asked for and never what was
   * granted. One read-only consent that flips every action to `met: true` means a single approval
   * granted the whole toolkit (Github measured 43 of 43). Prints `met before -> after of total`.
   */
  test(
    "blast radius: met across the whole toolkit, before and after one consent",
    async () => {
      const items = await listToolkit(arcade(), TOOLKIT, USER);
      const after = metCount(items);
      say(
        `BLAST RADIUS  ${TOOLKIT}: met ${run.baselineMet} -> ${after} of ${items.length} after consenting to ONE action (${run.action})`,
      );
      expect(after).toBeGreaterThan(need(run.baselineMet ?? 0, "no baseline"));
    },
    VENDOR_TIMEOUT_MS,
  );

  /**
   * GATE 3 — PER-ACTION ISOLATION THROUGH OUR VERIFIER, on a scoped provider (the spec's "Unproven").
   *
   * Reads what the adapter reports for every action of the toolkit after the one consent. An action
   * is a VIOLATION when it reports `authorized` although it asks for scopes the consent never granted.
   * - ZERO violations: per-action grants isolate; consenting to one action does not authorize a
   *   broader one.
   * - Any violation: the grant is wider than the action it was minted for. The consent screen
   *   under-describes it, and the per-action design needs the blast-radius wording instead.
   * On a toolkit whose actions carry no scopes (Github), isolation cannot be measured and this says
   * so, which is a result: use ARCADE_LIVE_TOOLKIT=Gmail for a scoped provider.
   */
  test(
    "GATE 3: per-action isolation through our verifier",
    async () => {
      const { broker } = createArcadeClient(need(key, "no ARCADE_API_KEY"));
      const grants = await broker.grantsFor({
        account: ACCOUNT,
        toolkit: TOOLKIT,
      });
      const granted = new Set(run.grantedScopes ?? []);
      const scoped = grants.filter(
        (g) => g.state === "authorized" || g.state === "needs-consent",
      );
      const violations = scoped.filter(
        (g) =>
          g.state === "authorized" &&
          g.scopes.length > 0 &&
          g.scopes.some((scope) => !granted.has(scope)),
      );
      const withScopes = scoped.filter((g) => g.scopes.length > 0).length;
      say(
        `GATE 3  ${TOOLKIT}: ${grants.filter((g) => g.state === "authorized").length} of ${grants.length} actions authorized; ${withScopes} carry scopes; ` +
          `${violations.length} authorized beyond the granted scopes` +
          (withScopes === 0
            ? "  ->  NOT MEASURABLE on this toolkit (no action carries scopes); rerun on a scoped one"
            : violations.length === 0
              ? "  ->  isolation HOLDS"
              : `  ->  isolation FAILS: ${violations.map((v) => v.action).join(", ")}`),
      );
      expect(violations).toEqual([]);
    },
    VENDOR_TIMEOUT_MS,
  );

  /**
   * GATE 4 — `provider_id` MEANS TWO DIFFERENT THINGS ON TWO OBJECTS, and the list filter takes the
   * second one. THIS CASE USED TO ASSERT THE WRONG THING, AND THAT IS WHY A PRODUCT DEFECT HID.
   *
   * It filtered this user's connections by the TOOLKIT'S PROVIDER TYPE, found nothing, and printed
   * `provider "google": exact 0, upper 0, lower 0  ->  filter does not take this provider id`. That
   * conclusion was wrong. The filter takes a provider id perfectly well; the type is simply not the
   * id a connection is filed under. Direct probing of the live API measured the two meanings:
   *
   * - on a TOOL LISTING, `requirements.authorization.provider_id` is the provider TYPE: `"google"`;
   * - on a USER CONNECTION ROW, `provider_id` is the provider INSTANCE id — an operator's
   *   configuration of a type: `"google-openbot"`, `"cpk-poc"`, `"arcade-google"`;
   * - on an AUTH-PROVIDER CONFIG (`admin.authProviders.list()`), `id` is the INSTANCE and
   *   `provider_id` is the TYPE, which is the only bridge between the two. Verbatim:
   *
   * ```
   * {"id":"cpk-poc",        "provider_id":"github", "type":"oauth2", "status":"active"}
   * {"id":"google-openbot", "provider_id":"google", "type":"oauth2", "status":"active"}
   * {"id":"arcade-google",  "provider_id":"google", "type":"oauth2", "status":"active"}
   * ```
   *
   * A connection row carries NO vendor-type field to compare against instead. Its full key set,
   * verbatim: `id`, `provider_type`, `connection_id`, `connection_status`, `scopes`, `user_id`,
   * `provider_id`, `provider_description`, `provider_user_info` — and `provider_type` is `"oauth2"`,
   * the auth SCHEME, not the vendor. The instance id is the only link there is.
   *
   * SO THE FIRST THING THIS PRINTS IS THE CONSENTED CONNECTION'S OWN `provider_id`, VERBATIM. It is
   * the single most valuable line in the run and its absence is what made today's result ambiguous
   * for an hour: `exact 0` reads as a broken filter until you can see what the row actually says.
   *
   * Then: resolve the toolkit's type to its configured INSTANCE ids, assert the connection is found
   * by instance, and measure the filter's case handling against the instance — the value a filter
   * would really be given — rather than against a value nothing is filed under.
   * - exact finds the row, the others do not: the server filter is CASE-SENSITIVE; the client-side
   *   fold is required and must stay.
   * - all three find it: case-INSENSITIVE; the fold is redundant but harmless.
   * - exact finds nothing even by instance: THEN the filter is not to be trusted, and that is a
   *   finding about the filter rather than about the spelling.
   */
  test(
    "GATE 4: provider_id is a TYPE on a listing and an INSTANCE on a connection",
    async () => {
      const client = arcade();
      const items = await listToolkit(client, TOOLKIT);
      const providerType = need(
        providersOf(items)[0],
        `${TOOLKIT} names no provider_id`,
      );

      const rows = [];
      for await (const row of client.admin.userConnections.list({
        user_id: USER,
      })) {
        rows.push(row);
      }
      const row = need(rows[0], "the throwaway user holds no connection");
      // VERBATIM, and nothing else off the row: this is the measurement.
      say(
        `GATE 4  connection provider_id VERBATIM: ${JSON.stringify(row.provider_id)}` +
          ` (provider_type ${JSON.stringify(row.provider_type)} — the auth scheme, not the vendor);` +
          ` ${TOOLKIT} tool listing names provider_id ${JSON.stringify(providerType)}`,
      );

      const configs = (await client.admin.authProviders.list()).items;
      if (!Array.isArray(configs)) {
        throw new Error(
          "admin.authProviders.list() answered without an `items` array, so the provider INSTANCE ids of the toolkit's type could not be resolved.",
        );
      }
      const instances = configs
        .filter(
          (config) =>
            config.provider_id?.toLowerCase() === providerType.toLowerCase(),
        )
        .map((config) => config.id)
        .filter((id): id is string => typeof id === "string" && id !== "");
      say(
        `GATE 4  instances configured for type "${providerType}": ${instances.join(", ") || "(none)"}`,
      );
      const instance = need(
        instances.find(
          (id) => id.toLowerCase() === row.provider_id?.toLowerCase(),
        ),
        `the connection's provider_id ${JSON.stringify(row.provider_id)} matches no configured instance of type ${providerType}`,
      );

      const count = async (provider_id: string) => {
        let n = 0;
        for await (const found of client.admin.userConnections.list({
          user_id: USER,
          provider_id,
        })) {
          void found;
          n += 1;
        }
        return n;
      };
      const exact = await count(instance);
      const upper = await count(instance.toUpperCase());
      const lower = await count(instance.toLowerCase());
      say(
        `GATE 4  instance "${instance}" (of type "${providerType}"): exact ${exact}, upper ${upper}, lower ${lower}  ->  ` +
          (exact === 0
            ? "the filter does not even take the INSTANCE id; do not trust it"
            : upper === exact && lower === exact
              ? "server filter is CASE-INSENSITIVE"
              : "server filter is CASE-SENSITIVE (keep the client-side fold)"),
      );
      expect(exact).toBeGreaterThan(0);

      const { broker } = createArcadeClient(need(key, "no ARCADE_API_KEY"));
      // The adapter's `authProviderOf` reads the TOOL LISTING, so its answer is the TYPE, and the
      // adapter expands that into the instance set before it touches a connection row.
      expect(await broker.authProviderOf?.(TOOLKIT)).toBe(providerType);
      expect(
        await broker.isConnected({ account: ACCOUNT, toolkit: TOOLKIT }),
      ).toBe(true);
    },
    VENDOR_TIMEOUT_MS,
  );

  /**
   * FENCED FACT 2: delete takes `connection_id` (`ac_...`); the `id` (`at_...`) listed first answers
   * 500. Run against this run's one throwaway connection, then it is really deleted.
   */
  test(
    "delete takes connection_id, and the at_ id answers 500",
    async () => {
      const client = arcade();
      const rows = [];
      for await (const row of client.admin.userConnections.list({
        user_id: USER,
      })) {
        rows.push(row);
      }
      const row = need(rows[0], "the throwaway user holds no connection");
      run.connectionId = need(
        row.connection_id,
        "the row carries no connection_id",
      );
      run.rowId = need(row.id, "the row carries no id");
      expect(run.connectionId).toMatch(/^ac_/);
      expect(run.rowId).toMatch(/^at_/);

      const refusal = await failureOf(() =>
        client.admin.userConnections.delete(need(run.rowId, "no id")),
      );
      expect(refusal.status).toBe(500);

      await client.admin.userConnections.delete(run.connectionId);
      const left = [];
      for await (const remaining of client.admin.userConnections.list({
        user_id: USER,
      })) {
        left.push(remaining);
      }
      expect(left).toEqual([]);

      const { broker } = createArcadeClient(need(key, "no ARCADE_API_KEY"));
      expect(
        await broker.isConnected({ account: ACCOUNT, toolkit: TOOLKIT }),
      ).toBe(false);
    },
    VENDOR_TIMEOUT_MS,
  );
});
