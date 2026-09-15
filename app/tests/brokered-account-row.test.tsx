import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type BrokeredAccount,
  BrokeredAccountRow,
  useBrokeredAccount,
} from "@/components/plugins/brokered-account-row";
import type { BrokerField } from "@/lib/plugins/mutations";
import type { PluginServer, PluginsPage } from "@/lib/plugins/queries";
import { Route as AdminAppRoute } from "@/routes/_authed/admin/plugins/$key";
import { Route as ConnectedAccountRoute } from "@/routes/_authed/settings/connected-accounts/$key";
import { BROKERED_PROBE_OUTCOMES } from "../../server/src/plugins/store";

/**
 * The brokered account row, on both screens that draw it.
 *
 * Neither screen had a test, which is how two defects survived a wave review and a final one.
 *
 * THE FIRST is that a successful disconnect went on reading "Connected". The row's state is
 * `confirmBrokered.data?.connected ?? <the recorded row>`, and a mutation's `data` is not query
 * state: disconnecting invalidated the queries, the recorded row went away, and the vendor's old
 * answer — set by the confirm-on-mount, whose dependencies had not changed — kept winning. The
 * person read that as a failure and pressed Disconnect again, and the second DELETE reached a store
 * method with no row-existence check, which revoked nothing and filed a second
 * `mcp.account_disconnected` entry about an account that was already gone.
 *
 * THE SECOND is a deployment with no Composio key. The confirm answers 503, both screens swallow
 * it by design, and the state fell back to the stale local row — so every reader was told
 * "Connected" on a deployment that cannot reach the broker at all, with no sign anything was wrong
 * until a Bot call refused. `docs/plugins/composio.md` has always claimed the page says the key is
 * missing; nothing implemented it.
 *
 * THE HARNESS IS THIS REPOSITORY'S, from `agent-roster-error.test.tsx` and
 * `bot-app-grants-screen.test.tsx`: `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in
 * `afterEach`, queries off `render()`'s own return, a `QueryClient` with `retry: false`, and the
 * capture-and-restore of each exported `Route` singleton those files document at length — bun walks
 * every file into one process, and `.update()` merges into the live object rather than replacing it.
 *
 * What is NOT copied from them is the always-failing `fetch`. What is under test here is a sequence
 * — confirmed live, then disconnected, then read again — so the stub below is a small in-memory
 * deployment that answers each endpoint from state a test can set and a DELETE can change, rather
 * than one canned response. It also counts the DELETEs, which is the only way to assert the second
 * press cannot happen rather than merely that the word changed.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const APP_KEY = "gmail";

/** When the key was last known to work, as this deployment wrote it down. */
const CHECKED_AT = "2026-09-10T09:00:00.000Z";

/** When a re-check pressed during a test finds out again. A different day, so the two read apart. */
const RECHECKED_AT = "2026-09-13T09:00:00.000Z";

/**
 * The action Composio publishes for this app, as the server names it in an answer.
 *
 * A real name rather than a flag, because the name is the whole of what separates the two things
 * `verified: false` means: a null probe is an app with nothing safe to spend a key on, and this
 * beside the same false is a key the vendor looked at and refused.
 */
const PROBE = "GMAIL_FETCH_EMAILS";

/**
 * What a re-check the vendor refused comes back as, in the store's own words.
 *
 * NOT A 200 SAYING `verified: false`, which is the shape this file used to pin and the server has
 * never been able to produce. `recheckBrokeredConnection` writes the verdict and the action it
 * spent, files the trail row, and then raises this; the route answers it as a 400. The row above the
 * banner has to be redrawn from what that write left behind, because the refusal itself carries no
 * verdict for the screen to read.
 */
const REFUSED_RECHECK =
  "The check this deployment ran against gmail did not come back clean: rate limit exceeded, retry in 60s. That may be the key and it may be the app — what came back does not say which — so your connection here is recorded as unchecked until a check does come back clean. Nothing was disconnected: press Re-check again in a few minutes, and fix the key at gmail if it keeps answering the same way.";

/**
 * The schemes the SERVER answers a form for, which is the list `isFieldScheme` holds.
 *
 * The screen holds its own copy of this — `FIELD_SCHEMES` in `brokered-account-row.tsx` — because
 * the two processes share no module, and the copy is what decides which of the two presses a
 * Connect becomes. Kept here rather than imported from the screen so a test can make them disagree,
 * which is the one thing an imported copy could never express.
 */
const SERVER_FIELD_SCHEMES = [
  "API_KEY",
  "BASIC",
  "BEARER_TOKEN",
  "BASIC_WITH_JWT",
  /*
   * AND ONE THE SCREEN HAS NEVER HEARD OF. Composio's catalogue is the vendor's, so it may name a
   * typed scheme tomorrow that this app's copy of the list does not carry — and the screen's own
   * comment says an unknown scheme is read as consent on purpose. That is the drift: the server
   * answers a form and the screen asked for a URL.
   */
  "API_KEY_HEADER",
];

/**
 * A typed scheme the server knows and the screen does not. See {@link SERVER_FIELD_SCHEMES}.
 *
 * Not a made-up string for its own sake: it stands for any scheme added at the vendor between one
 * deployment of the server and the next of the app, which is a state this product reaches by doing
 * nothing at all.
 */
const DRIFTED_FIELD_SCHEME = "API_KEY_HEADER";

/** Where a real consent app's connect route sends somebody, as the vendor's own page. */
const CONSENT_URL = "https://accounts.google.com/o/oauth2/v2/auth?state=sealed";

/**
 * Watch what gets assigned to `window.location.href` without letting it be assigned.
 *
 * happy-dom does not navigate, and silently keeps `about:blank` whatever is written here — so the
 * one act this row performs on the consent path leaves no trace a test could read. The property is
 * replaced on the instance, over the `Location` prototype's own accessor, and deleted again by the
 * returned restore so the next test in this bun process gets the real one back.
 */
function watchNavigation(): {
  navigations: string[];
  restore: () => void;
} {
  const navigations: string[] = [];
  Object.defineProperty(window.location, "href", {
    configurable: true,
    get: () => "about:blank",
    set: (value: string) => {
      navigations.push(String(value));
    },
  });
  return {
    navigations,
    restore: () => {
      delete (window.location as unknown as Record<string, unknown>).href;
    },
  };
}

/** The same day, spelled the way the row spells it — the reader's own locale, not this file's. */
function asDay(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/** A minimal but complete brokered `PluginServer` — the row shape only Composio produces. */
function brokeredServer(authScheme: string): PluginServer {
  return {
    authScheme,
    id: APP_KEY,
    title: "Gmail",
    vendor: "Google",
    url: "https://example.invalid/composio",
    summary: "Mail.",
    docsUrl: "",
    provenance: "composio",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: null,
    dynamicClient: false,
    tools: [],
    withdrawn: [],
  };
}

function pluginsPage(
  composioConfigured: boolean,
  authScheme: string,
): PluginsPage {
  return {
    catalogue: [],
    servers: [brokeredServer(authScheme)],
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured,
  };
}

/**
 * The deployment these tests render against, as a handful of facts a test sets up front.
 *
 * `recorded` is this deployment's own row — written from the unproven return trip from consent —
 * and `confirms` is what the broker answers when asked about the account behind it. They are
 * separate on purpose: every case worth testing here is one where the two disagree.
 */
type Deployment = {
  composioConfigured: boolean;
  recorded: boolean;
  confirms: boolean;
  /**
   * How this app's authorization config was created, as the vendor's own scheme literal. Defaults
   * to the consent scheme, which is what every test written before there was a second kind meant.
   */
  authScheme?: string;
  /** What the app publishes as the things a person types in, for the `API_KEY` schemes. */
  fields?: BrokerField[];
  /** Whether a real call was ever made with this key and worked, as this deployment recorded it. */
  verified?: boolean;
  /** When that happened. Null wherever `verified` is false — a check that failed records no time. */
  verifiedAt?: string | null;
  /**
   * Which action this deployment WOULD check the key with, as the connections read now derives it.
   *
   * Left off by default, because that is what a row out of the held-connection half of that
   * endpoint looks like and what every test written before the field existed meant: the key was
   * taken and nothing here knows what, if anything, tried it. A name or a null is the read saying
   * which of the three states the row is really in, and it survives a reload where an answer to a
   * mutation cannot.
   */
  probe?: string | null;
  /**
   * Whether the app has anything to check a key against today, as the connections read answers.
   *
   * A SECOND FIELD BECAUSE IT IS A SECOND QUESTION. `probe` above is the record of what the last
   * check SPENT; this is what the app publishes NOW, and it is what the Re-check button is drawn
   * from. They agree until an app starts publishing something it did not publish when the key was
   * taken — which is the state a deployment reaches by an administrator pressing Refresh, and the
   * one the button was unreachable in while it read the record.
   *
   * Left off by default for the same reason `probe` is, and false where it is left off: a held row
   * carries neither, and a closed gate is what a row nothing has said about should draw.
   */
  checkable?: boolean;
  /**
   * What a re-check answers when somebody presses for one, as the route's whole body.
   *
   * `probe` travels with the verdict because the verdict alone is not an answer: the only
   * `verified: false` that arrives here as a 200 is the one carrying a null probe, and a re-check
   * the vendor refused is raised rather than answered.
   *
   * A NAMED PROBE BESIDE `verified: false` IS THEREFORE NOT A 200 AND THIS STUB NO LONGER MAKES ONE.
   * `recheckBrokeredConnection` writes the row and then RAISES with Composio's own sentence in it,
   * which `POST /servers/:id/connection/recheck` passes through as a 400 — so the shape a stub
   * answering 200 here pinned is one no deployment can produce, and the screen defect underneath it
   * could not be seen. See {@link REFUSED_RECHECK}.
   */
  recheckAnswer?: {
    verified: boolean;
    verifiedAt: string | null;
    probe: string | null;
  };
  /**
   * What Composio refuses a submitted key with, where nothing was saved.
   *
   * The clean undo: the probe failed, the account this call made was withdrawn at the vendor, and
   * `connectBrokeredWithFields` raises with no row behind it. 400, because the store authored the
   * sentence and the route passes a store-authored refusal through as one.
   */
  rejects?: string;
  /**
   * And what it refuses one with where the account it made COULD NOT be taken back.
   *
   * THE THIRD STATE, AND THE ONE WITH A ROW BEHIND THE REFUSAL. Composio would not revoke the
   * account this press created, so the store records it — unverified, with the action it spent — and
   * files a trail row, and only then raises. The route answers that 400 over a deployment that now
   * holds a live connection the person did not have a moment ago, which is why the screens this row
   * is drawn on may not go on offering Connect for it.
   */
  rejectsAndKeeps?: string;
  /**
   * What the first press is refused with, where the app cannot be asked what it wants at all.
   *
   * A question about the app rather than about anybody's account, so nothing is written either way
   * — but the sentence is the whole of what the person can act on, and it is the one the dialog used
   * to replace with a line of its own. 502 is what the route answers a `connectionFields` failure it
   * cannot explain; the authored refusals on that same press are 400, 409 and 503.
   */
  refusesFields?: { error: string; status: 400 | 409 | 502 | 503 };
  /**
   * Whether `/api/plugins/connections` answers 500, with `/api/plugins` answering perfectly.
   *
   * THE ONE STATE BOTH SCREENS DEFAULTED THROUGH. Every fact a brokered row draws — `recorded`,
   * `verified`, `verifiedAt`, `probe`, `checkable` — comes off that read, and both screens gated
   * their render on the PLUGINS query and read neither `connections.isPending` nor
   * `connections.error`. So a failed connections read handed the row "you have never connected
   * this", which for an account whose last check did not come back clean is the exact state this
   * feature exists to keep visible.
   */
  connectionsFail?: boolean;
};

type Server = {
  /** How many DELETEs reached the connection endpoint. */
  deletes: number;
  /**
   * What the app publishes as its fields from now on.
   *
   * The catalogue is the vendor's, not ours, so what an app asks for is free to change between two
   * presses of Connect — which is why the row asks again on every open. A test that could not move
   * this could only ever check the list a form was born with.
   */
  publish: (fields: BrokerField[]) => void;
  /**
   * Hold the next answer to "what does this app want typed in?", and hand back its release.
   *
   * THE ONLY WAY TO READ THE RENDER A DIALOG OPENS ON. That press asks the app again and the answer
   * lands a moment later; with nothing holding it, the two are one turn as far as a test is
   * concerned, and what the form was mounted on is unobservable. Holding it separates the open from
   * the answer, which is the whole of the sequence `connection-fields.tsx` is written for.
   */
  holdFields: () => () => void;
  /**
   * Refuse every later field request, the way a directory this deployment cannot reach does.
   *
   * A second press being refused where the first was answered is the state the dialog has to be
   * right about once it holds the previous answer, and it is not reachable from
   * {@link Deployment.refusesFields}, which is set before anything is pressed.
   */
  refuseFields: (refusal: NonNullable<Deployment["refusesFields"]>) => void;
  /**
   * The values of each submission that reached the connect route, in order.
   *
   * The body rather than the form, because the body is what the server refuses: a name the app no
   * longer publishes is a 400 on the whole connection, however tidy the screen looked.
   */
  submitted: Record<string, string>[];
};

/**
 * A stub `fetch` answering the four endpoints these two screens read and write, from state the
 * DELETE actually changes.
 *
 * A canned response per endpoint would not do: the defect under test is a screen that keeps
 * rendering an answer the vendor gave BEFORE an act that invalidated it, so the disconnect has to
 * really take effect somewhere for a later read to be able to disagree with it.
 */
function installDeployment(deployment: Deployment): Server {
  const state = {
    authScheme: "OAUTH2",
    fields: [] as BrokerField[],
    verified: false,
    verifiedAt: null as string | null,
    rejects: undefined as string | undefined,
    rejectsAndKeeps: undefined as string | undefined,
    refusesFields: undefined as Deployment["refusesFields"],
    probe: undefined as string | null | undefined,
    checkable: false,
    recheckAnswer: { verified: true, verifiedAt: RECHECKED_AT, probe: PROBE },
    connectionsFail: false,
    ...deployment,
  };
  /** What the next field request waits on, or null where it answers straight away. */
  let held: Promise<void> | null = null;

  const server: Server = {
    deletes: 0,
    publish: (fields) => {
      state.fields = fields;
    },
    holdFields: () => {
      let release: () => void = () => undefined;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        held = null;
        release();
      };
    },
    refuseFields: (refusal) => {
      state.refusesFields = refusal;
    },
    submitted: [],
  };

  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requested = typeof input === "string" ? input : String(input);
    /*
     * The route, with any query taken off it.
     *
     * The consent press carries `?returnTo=` and the field press carries nothing, so a stub
     * matching on the whole string answered only one of the two — `endsWith("/connect")` is false
     * for `/connect?returnTo=settings`, and the consent press fell through to the plugins-page
     * branch and was answered a page. That is a stub disagreeing with the server, which serves one
     * route for both presses and forks on the row rather than on the query.
     */
    const path = requested.split("?")[0] ?? requested;
    const method = init?.method ?? "GET";
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });

    if (path.startsWith("/api/plugins/connections")) {
      if (state.connectionsFail) {
        return new Response(
          JSON.stringify({ error: "the connections could not be read" }),
          {
            headers: { "content-type": "application/json" },
            status: 500,
          },
        );
      }
      return json({
        connections: state.recorded
          ? [
              {
                serverId: APP_KEY,
                scope: "",
                connectedAt: "2026-09-10T00:00:00.000Z",
                verified: state.verified,
                verifiedAt: state.verifiedAt,
                /*
                 * The action the last check recorded, so it is on every brokered row a page load
                 * reads and not only on the answer to a write. Undefined here is the field being
                 * absent from the JSON, which is what a held connection's row looks like.
                 */
                probe: state.probe,
                /*
                 * And what the app publishes today, which is the other question and the one the
                 * Re-check button asks. A read that sent only the record left the button gated on
                 * what a past check spent, so a key nothing was spent on could never have anything
                 * spent on it.
                 */
                checkable: state.checkable,
              },
            ]
          : [],
        redirectUri: null,
      });
    }
    if (path.endsWith("/connection/confirm") && method === "POST") {
      // What the route answers with no key at all: nothing to ask, and no answer invented.
      if (!state.composioConfigured) {
        return new Response(
          JSON.stringify({ error: "Composio is not set up" }),
          {
            headers: { "content-type": "application/json" },
            status: 503,
          },
        );
      }
      return json({ connected: state.confirms });
    }
    /*
     * The first press on an app nobody consents to: what does it want typed in? The consent half of
     * this same route carries `?returnTo=`, so the two are told apart by the query rather than by
     * the method they share.
     */
    if (path.endsWith("/connect") && method === "POST") {
      /*
       * The second press carries the values on it, and is the one that writes. Told apart by the
       * body rather than by a second path, because the route itself is one route: the first press
       * asks the app what it wants and the second hands it over.
       */
      if (typeof init?.body === "string" && init.body.includes("values")) {
        server.submitted.push(
          (JSON.parse(init.body) as { values: Record<string, string> }).values,
        );
        /*
         * The vendor's own refusal, carried on the envelope `client` unwraps. It is the sentence
         * this whole path exists to preserve, and the only thing that tells somebody their key was
         * mistyped rather than their deployment broken.
         */
        if (state.rejects) {
          return new Response(JSON.stringify({ error: state.rejects }), {
            headers: { "content-type": "application/json" },
            status: 400,
          });
        }
        /*
         * AND THE REFUSAL THAT LEAVES A ROW BEHIND IT, which is the same 400 over a deployment that
         * is no longer in the state the caller was in when they pressed.
         *
         * `connectBrokeredWithFields` tries to withdraw the account its own probe just condemned,
         * and where Composio will not take it back it writes the connection anyway — unverified,
         * carrying the action it spent — files the trail row, and only then raises. So the write
         * below happens BEFORE the response, exactly as it does on the server, and a stub that
         * refused without it could only ever test the half of this path that changes nothing.
         */
        if (state.rejectsAndKeeps) {
          state.recorded = true;
          state.confirms = true;
          state.verified = false;
          state.verifiedAt = null;
          // The action that ran and that the vendor answered no to, which is the whole of what
          // separates this row on a later read from a key nobody ever tried.
          state.probe = PROBE;
          return new Response(
            JSON.stringify({ error: state.rejectsAndKeeps }),
            {
              headers: { "content-type": "application/json" },
              status: 400,
            },
          );
        }
        state.recorded = true;
        state.confirms = true;
        // A fresh key, and the store writes every one of those unverified: nothing has been spent
        // on it, whatever the app does or does not publish to spend.
        state.verified = false;
        state.verifiedAt = null;
        /*
         * AND THE PROBE IS WRITTEN DOWN, not merely answered. `connectBrokeredWithFields` hands
         * `probeAction: probe` to the single writer with the verdict it derived from that same
         * value, so the row the NEXT connections read answers out of carries the name, or the null,
         * that this press spent. Leaving `state.probe` alone here left the later read answering the
         * field's absence — `undefined`, which is a held connection's row and a thing this endpoint
         * has no way to produce for an app somebody just handed a key to. Every assertion about
         * what a row says after a connect was then reading a state off the mutation's answer that
         * the read behind it could never have agreed with.
         */
        state.probe = null;
        return json({ connected: true, verified: false, probe: state.probe });
      }
      /*
       * THE FIRST PRESS FORKS ON THE RECORDED SCHEME, exactly as the route does: a typed scheme is
       * answered the form, and everything else is answered the vendor's URL. A stub that answered a
       * form to every bodyless press would agree with the screen by construction, and the whole
       * question here is what the screen does when the two disagree.
       */
      /*
       * AND THE PRESS THAT CANNOT BE ANSWERED AT ALL. Asking the app what it wants is a call to
       * Composio like any other, and the route has four refusals for it — an app that needs no
       * account (400), an account this person already holds (409), a directory this deployment
       * cannot reach (502) and a broker it is not configured for (503). None of them is a field
       * list, and each one is a sentence naming what to do about it.
       */
      // Held only on this half of the route: the press that asks the app what it wants. See
      // {@link Server.holdFields}.
      if (held) await held;
      if (state.refusesFields) {
        return new Response(
          JSON.stringify({ error: state.refusesFields.error }),
          {
            headers: { "content-type": "application/json" },
            status: state.refusesFields.status,
          },
        );
      }
      if (SERVER_FIELD_SCHEMES.includes(state.authScheme)) {
        return json({ fields: state.fields });
      }
      return json({ authorizationUrl: CONSENT_URL });
    }
    if (path.endsWith("/connection/recheck") && method === "POST") {
      /*
       * A CHECK THAT SPENT SOMETHING WRITES; A CHECK THAT SPENT NOTHING WRITES NOTHING, which is
       * the fork `recheckBrokeredConnection` makes and the reason the verdict cannot be recorded on
       * its own. A null probe means the app published nothing safe to try, so the store returns
       * early and the row keeps whatever it already held — its old verdict, its old date and its
       * old record. Writing the verdict here regardless would let a press that tried nothing
       * overwrite the answer of the last press that did.
       *
       * AND `probe` IS RECORDED BESIDE THEM, WHICH IS WHAT THIS BRANCH USED TO LEAVE OUT. The
       * verdict and its date were written and the name of what was spent was not, so the row a
       * reload read back was the one shape the server cannot hold: a `verified: false` under an app
       * nothing had ever said anything about. That is the third of the three states this field
       * exists to separate, standing in for the second, on the render where somebody is deciding
       * whether their key is bad.
       */
      if (state.recheckAnswer.probe !== null) {
        state.verified = state.recheckAnswer.verified;
        state.verifiedAt = state.recheckAnswer.verifiedAt;
        state.probe = state.recheckAnswer.probe;
      } else {
        /*
         * AND THE GATE CLOSES BEHIND A PRESS THAT FOUND NOTHING, which is not this stub inventing a
         * consequence: the two answers come from ONE read on the server. `probeBrokeredConnection`
         * returns `outcome: "nothing"` exactly when `probeActionFor` answers null for this app, and
         * the connections listing answers `checkable: probeActionFor(...) !== null` off that same
         * function — so a re-check that could try nothing is, by construction, a later read that
         * says there is nothing to try. The refetch every one of these mutations makes is what
         * carries it to the row.
         *
         * WHICH IS WHY A NULL PROBE MAY NOT BE ALLOWED TO REWRITE THE RECORD. This press takes the
         * Re-check button off the row with it, so whatever the row is left saying is what it goes
         * on saying, with nothing left in the interface to ask again with.
         */
        state.checkable = false;
      }
      /*
       * AND A CHECK THE VENDOR REFUSED IS A REFUSAL, NOT AN ANSWER — the correction that let the
       * screen defect beneath it be seen at all.
       *
       * The store writes the row, files the trail and THEN raises with Composio's own sentence in
       * it, and the route passes that through as a 400. This stub used to answer the same body as a
       * 200, which is a shape no deployment can produce: `recheckBrokeredConnection` returns only
       * `{ verified: true, … }` or the untouched row beside a null probe. Every assertion about a
       * refused check was therefore made against a success the browser was never going to see, and
       * a mutation that refetched only on success looked correct because nothing it was tested with
       * ever failed.
       */
      if (!state.recheckAnswer.verified && state.recheckAnswer.probe !== null) {
        return new Response(JSON.stringify({ error: REFUSED_RECHECK }), {
          headers: { "content-type": "application/json" },
          status: 400,
        });
      }
      return json(state.recheckAnswer);
    }
    if (path.endsWith("/connection") && method === "DELETE") {
      server.deletes += 1;
      state.recorded = false;
      state.confirms = false;
      // The row is gone, and so is everything that was ever checked about it — the record of what
      // the last check spent included. `retireConnectionsFor` deletes the row rather than blanking
      // three of its four columns, so a probe left standing here is a column no deployment can hold.
      state.verified = false;
      state.verifiedAt = null;
      state.probe = undefined;
      return json({ ok: true });
    }
    if (path.startsWith("/api/agents")) return json({ agents: [] });
    if (path.startsWith("/api/plugins")) {
      return json(pluginsPage(state.composioConfigured, state.authScheme));
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  return server;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

/** A client that settles in one attempt, so no test waits on a retry. */
function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/*
 * Capture and restore of each exported `Route` singleton, verbatim from
 * `agent-roster-error.test.tsx` and for the reason recorded there: `.update()` merges into the live
 * object, `createRouter()` derives `_id`/`parentRoute` off it, and nothing re-runs `init()` on a
 * replay — so a render here would otherwise leave the real router (`router.test.ts` builds one in
 * this same bun process) pointed at a decoy parent.
 */
function captureRouteState(route: object): Record<string, unknown> {
  return { ...route, options: { ...(route as { options: object }).options } };
}

function restoreRouteState(
  route: object,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(route)) {
    if (!(key in snapshot)) {
      delete (route as Record<string, unknown>)[key];
    }
  }
  Object.assign(route, snapshot);
}

/** Captured once, at module scope, before any `test()` body here has run — the state this file must
 *  hand back, whatever it happens to be. See `agent-roster-error.test.tsx`. */
const pristineAccountRouteState = captureRouteState(ConnectedAccountRoute);
const pristineAdminRouteState = captureRouteState(AdminAppRoute);

let accountRouteSnapshot: Record<string, unknown>;
let adminRouteSnapshot: Record<string, unknown>;

beforeEach(() => {
  accountRouteSnapshot = captureRouteState(pristineAccountRouteState);
  adminRouteSnapshot = captureRouteState(pristineAdminRouteState);
});

afterEach(() => {
  restoreRouteState(ConnectedAccountRoute, accountRouteSnapshot);
  restoreRouteState(AdminAppRoute, adminRouteSnapshot);
});

/**
 * The personal screen, at its real id.
 *
 * `routeTree.gen.ts` fixes both halves: id `/connected-accounts/$key` under `/_authed/settings`,
 * path `/connected-accounts/$key`. Decoy pathless/static parents are enough to make the join land
 * on the id `useParams({ from: … })` resolves against; the real ancestors check a session and mount
 * the settings shell, neither of which this file is about. The index route is registered only so
 * the Back link has something to build an href from.
 */
function renderAccountScreen(client: QueryClient) {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const settingsRoute = createRoute({
    path: "/settings",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const indexRoute = createRoute({
    path: "/connected-accounts/",
    getParentRoute: () => settingsRoute,
    component: () => null,
  });
  const wired = (
    ConnectedAccountRoute as unknown as {
      update: (options: unknown) => typeof ConnectedAccountRoute;
    }
  ).update({
    id: "/connected-accounts/$key",
    path: "/connected-accounts/$key",
    getParentRoute: () => settingsRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([settingsRoute.addChildren([indexRoute, wired])]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({
      initialEntries: [`/settings/connected-accounts/${APP_KEY}`],
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** The administrator's connector page, the same way: id `/plugins/$key` under `/_authed/admin`. */
function renderAdminScreen(client: QueryClient) {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const adminRoute = createRoute({
    path: "/admin",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const pluginsRoute = createRoute({
    path: "/plugins/",
    getParentRoute: () => adminRoute,
    component: () => null,
  });
  const wired = (
    AdminAppRoute as unknown as {
      update: (options: unknown) => typeof AdminAppRoute;
    }
  ).update({
    id: "/plugins/$key",
    path: "/plugins/$key",
    getParentRoute: () => adminRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([adminRoute.addChildren([pluginsRoute, wired])]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({
      initialEntries: [`/admin/plugins/${APP_KEY}`],
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** The sentence the row carries where the deployment has no Composio key, matched on the part that
 *  names the setting — the whole point of the row in that state. */
const NAMES_THE_SETTING = /Set COMPOSIO_API_KEY on this deployment/;

test("a disconnect that lands stops reading Connected and offers Connect again", async () => {
  const server = installDeployment({
    composioConfigured: true,
    recorded: true,
    confirms: true,
  });

  const view = renderAccountScreen(queryClient());

  // Connected first, on the vendor's own answer — otherwise the assertion below proves nothing.
  const disconnect = await view.findByRole("button", { name: "Disconnect" });
  expect(view.queryByText("Connected")).toBeTruthy();

  await userEvent.click(disconnect);

  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Connect" })).toBeTruthy(),
  );
  expect(view.queryByText("Connected")).toBeNull();
  expect(view.queryByRole("button", { name: "Disconnect" })).toBeNull();
  // The whole reason this matters: with Disconnect still on screen the person presses it again,
  // and the second DELETE files a row claiming an account was disconnected when there was none.
  expect(server.deletes).toBe(1);
});

test("a deployment with no Composio key names the setting and offers neither action", async () => {
  installDeployment({
    composioConfigured: false,
    // A row left over from when a key WAS set: the app keeps its row and its grants, which is the
    // exact state that used to read "Connected" on a deployment that cannot reach the broker.
    recorded: true,
    confirms: true,
  });

  const view = renderAccountScreen(queryClient());

  expect(await view.findByText(NAMES_THE_SETTING)).toBeTruthy();
  expect(view.queryByText("Key missing")).toBeTruthy();
  expect(view.queryByText("Connected")).toBeNull();
  expect(view.queryByRole("button", { name: "Disconnect" })).toBeNull();
  expect(view.queryByRole("button", { name: "Connect" })).toBeNull();
});

test("somebody who abandoned consent reads as not connected, not as an error", async () => {
  installDeployment({
    composioConfigured: true,
    // The callback wrote our row on an ordinary redirect with nothing signed in it. The vendor is
    // the only thing that knows the consent was never finished, and it says so.
    recorded: true,
    confirms: false,
  });

  const view = renderAccountScreen(queryClient());

  expect(await view.findByRole("button", { name: "Connect" })).toBeTruthy();
  expect(view.queryByText("Connected")).toBeNull();
  // Not a failure of this page: it asked a question and got an answer. A red sentence across the
  // top would report the page's own question as this person's problem.
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByText(NAMES_THE_SETTING)).toBeNull();
});

test("the connector's admin page draws the same row, and its disconnect clears too", async () => {
  const server = installDeployment({
    composioConfigured: true,
    recorded: true,
    confirms: true,
  });

  const view = renderAdminScreen(queryClient());

  const disconnect = await view.findByRole("button", { name: "Disconnect" });
  expect(view.queryByText("Connected")).toBeTruthy();

  await userEvent.click(disconnect);

  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Connect" })).toBeTruthy(),
  );
  expect(view.queryByText("Connected")).toBeNull();
  expect(view.queryByRole("button", { name: "Disconnect" })).toBeNull();
  expect(server.deletes).toBe(1);
});

test("the admin page says the key is missing too, rather than offering an action", async () => {
  installDeployment({
    composioConfigured: false,
    recorded: true,
    confirms: true,
  });

  const view = renderAdminScreen(queryClient());

  expect(await view.findByText(NAMES_THE_SETTING)).toBeTruthy();
  expect(view.queryByText("Key missing")).toBeTruthy();
  expect(view.queryByText("Connected")).toBeNull();
  expect(view.queryByRole("button", { name: "Disconnect" })).toBeNull();
  // The app is still enabled and still says how it is reached — the row is honest about what is
  // still true, rather than reading as a connector that has gone away.
  expect(view.queryByText("How this is reached")).toBeTruthy();
});

/**
 * One real field, as Composio publishes it for Perplexity.
 *
 * Kept verbatim rather than trimmed to a label: the help sentence is the app's own, and the point of
 * the test below is that this deployment reproduces a sentence it has never been taught.
 */
const PERPLEXITY_KEY: BrokerField = {
  name: "generic_api_key",
  label: "API Key",
  help: "Your secret Perplexity API key, starting with 'pplx-'. Create one at console.perplexity.ai under API Keys — it's shown only once, so copy it immediately.",
  required: true,
  secret: true,
};

test("a key app asks for what the app asked for, with its own help text", async () => {
  installDeployment({
    authScheme: "API_KEY",
    composioConfigured: true,
    confirms: false,
    fields: [PERPLEXITY_KEY],
    recorded: false,
  });

  const view = renderAccountScreen(queryClient());

  await userEvent.click(await view.findByRole("button", { name: "Connect" }));

  // Labelled by what the app called it, which is how a person finds the box the vendor's own
  // instructions are about.
  const input = await view.findByLabelText("API Key");
  // The app said which value is the secret. Nothing here guessed it from the name.
  expect(input.getAttribute("type")).toBe("password");
  expect(view.queryByText(/starting with 'pplx-'/)).toBeTruthy();
});

test("a key app nobody has connected says it will ask for a key, not send you off", async () => {
  installDeployment({
    authScheme: "API_KEY",
    composioConfigured: true,
    confirms: false,
    fields: [PERPLEXITY_KEY],
    recorded: false,
  });

  const view = renderAccountScreen(queryClient());

  expect(
    await view.findByText(
      /connected with a key you already hold, not a trip to Gmail's consent screen/,
    ),
  ).toBeTruthy();
  /*
   * The screen's own not-connected sentence is written for the kind that leaves, and pressing
   * Connect on this app opens a form instead. Promising a trip to the vendor here is not a vaguer
   * sentence than the truth; it is a different act from the one about to happen.
   */
  expect(
    view.queryByText(/takes you to Composio and then to the vendor to consent/),
  ).toBeNull();
});

test("a key app nobody has connected keeps the screen's own reassurance", async () => {
  installDeployment({
    authScheme: "API_KEY",
    composioConfigured: true,
    confirms: false,
    fields: [PERPLEXITY_KEY],
    recorded: false,
  });

  const view = renderAdminScreen(queryClient());

  // The row's own sentence, which is the one the screen's cannot be: pressing Connect here opens a
  // form rather than leaving for a consent screen.
  expect(await view.findByText(/Connect asks for it\./)).toBeTruthy();
  /*
   * And the half of the screen's line that survives it. Replacing the whole line took away the one
   * thing an administrator reading this row needs to know — that the connector is finished whether
   * or not they ever connect themselves — and left them looking at a step they do not have to take.
   */
  expect(
    view.getByText(
      /Setup is complete without it, and it reaches your documents only/,
    ),
  ).toBeTruthy();
});

/** Composio's own words for a key it would not take, which is the sentence worth carrying. */
const REFUSED = "Composio rejected that key: invalid API key for perplexityai.";

/**
 * And its words for the same key where the account it made could not be withdrawn.
 *
 * THE REFUSAL WITH A ROW BEHIND IT, which is what separates it from {@link REFUSED} and is the whole
 * reason the screens may not treat the two alike. Nothing was saved on that one; on this one a live
 * connection exists that did not exist before the press, and the sentence names the button that ends
 * it — on a page that has to be redrawn before that button is there to press.
 */
const STRANDED =
  "What you entered for gmail did not work — Composio rejected that key: invalid API key for perplexityai. — and Composio would not take the account back either, so it is recorded here as unchecked rather than left somewhere nothing could name it. Disconnect it on the Plugins page and try again.";

test("a key the broker refuses says so inside the dialog, not only behind it", async () => {
  installDeployment({
    authScheme: "API_KEY",
    composioConfigured: true,
    confirms: false,
    fields: [PERPLEXITY_KEY],
    recorded: false,
    rejects: REFUSED,
  });

  const view = renderAccountScreen(queryClient());

  await userEvent.click(await view.findByRole("button", { name: "Connect" }));
  const dialog = await view.findByRole("dialog");
  await userEvent.type(await view.findByLabelText("API Key"), "pplx-mistyped");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Connect" }),
  );

  /*
   * WHERE THE PERSON IS LOOKING. The screen's banner is behind this dialog's backdrop, so a
   * refusal that lands only there lands nowhere: the form sits open over it as though nothing had
   * been answered, and the one sentence that says "you mistyped it" rather than "we are broken" is
   * unreadable until somebody closes the thing they were trying to finish.
   */
  await waitFor(() => expect(within(dialog).queryByText(REFUSED)).toBeTruthy());
  // Reported to the screen as well, not instead: the dialog is closable and the reason outlives it.
  expect(view.getAllByText(REFUSED).length).toBe(2);
  // And the form stays up holding what was typed. A mistyped key is corrected, not retyped.
  expect(within(dialog).queryByLabelText("API Key")).toBeTruthy();
});

/**
 * What Composio would not say when it was asked what the app wants typed in.
 *
 * The route's own generic sentence for a `connectionFields` call it cannot explain, which is one of
 * the four refusals that press has — the others being an app that needs no account, an account this
 * person already holds, and a deployment with no broker key. Each of them names a different thing to
 * do about it, which is the whole reason none of them may be replaced by a line of the dialog's own.
 */
const UNASKABLE =
  "Composio would not say what Gmail asks for, and said nothing about why. Try again, and ask an administrator to check this deployment's Composio key if it persists.";

test("an app that could not be asked what it needs says why, inside the dialog", async () => {
  /*
   * THE TWIN OF THE TEST ABOVE, ON THE PRESS BEFORE IT.
   *
   * CRITERION. A first press the server refuses puts the SERVER's sentence in front of the person,
   * in the dialog that press opened.
   *
   * REASON. The dialog opens on the press and the question goes out under it, so a refusal lands
   * while the form's own placeholder is on screen — and that placeholder said "That app could not be
   * asked what it needs. Close this and try again." to every one of the four refusals this route
   * has. Each of those names a different remedy and three of them name one this line cannot: an app
   * that needs no account at all, an account already attached that has to be disconnected first, a
   * deployment whose Composio key an administrator has to look at. The real sentence went to the
   * screen's banner, which is behind this dialog's backdrop — the identical defect the submission
   * refusal above was fixed for, on the press a few lines earlier.
   */
  installDeployment({
    authScheme: "API_KEY",
    composioConfigured: true,
    confirms: false,
    fields: [PERPLEXITY_KEY],
    recorded: false,
    refusesFields: { error: UNASKABLE, status: 502 },
  });

  const view = renderAccountScreen(queryClient());

  await userEvent.click(await view.findByRole("button", { name: "Connect" }));
  const dialog = await view.findByRole("dialog");

  await waitFor(() =>
    expect(within(dialog).queryByText(UNASKABLE)).toBeTruthy(),
  );
  // Reported to the screen as well, not instead, exactly as a refused submission is.
  expect(view.getAllByText(UNASKABLE).length).toBe(2);
  // And never the line that stands in for a sentence nobody sent.
  expect(
    view.queryByText(/That app could not be asked what it needs/),
  ).toBeNull();
});

test("a consent app's Connect leaves for the vendor's own page", async () => {
  installDeployment({
    authScheme: "OAUTH2",
    composioConfigured: true,
    confirms: false,
    recorded: false,
  });
  const watched = watchNavigation();

  try {
    const view = renderAccountScreen(queryClient());

    await userEvent.click(await view.findByRole("button", { name: "Connect" }));

    /*
     * The whole of what this press does, and the reason the case below is worth having: the row
     * hands the browser whatever the route answered with, and there is nothing between the two.
     */
    await waitFor(() => expect(watched.navigations).toEqual([CONSENT_URL]));
  } finally {
    watched.restore();
  }
});

test("a typed scheme this screen does not know is refused, not navigated to undefined", async () => {
  installDeployment({
    /*
     * The server knows this one and the screen does not. So the screen reads it as consent, presses
     * the consent half of the route, and the route answers the form a typed scheme gets — a body
     * with no `authorizationUrl` in it at all.
     */
    authScheme: DRIFTED_FIELD_SCHEME,
    composioConfigured: true,
    confirms: false,
    fields: [PERPLEXITY_KEY],
    recorded: false,
  });
  const watched = watchNavigation();

  try {
    const view = renderAccountScreen(queryClient());

    await userEvent.click(await view.findByRole("button", { name: "Connect" }));

    /*
     * THE DEFECT THIS IS ABOUT. The mutation was declared to answer a `string`, the unwrapped key
     * was missing, and what reached the assignment was `undefined` — which the browser resolves
     * against the current document and follows, landing the person on a page called `undefined` on
     * this deployment's own origin, having been told nothing.
     */
    await waitFor(() =>
      expect(view.queryByText(/no page to send you to/)).toBeTruthy(),
    );
    // The defect in its plainest form: before the fix this array held the one string "undefined".
    expect(watched.navigations).toEqual([]);
  } finally {
    watched.restore();
  }
});

test("the row names the app rather than calling it the app", async () => {
  installDeployment({
    authScheme: "API_KEY",
    composioConfigured: true,
    confirms: true,
    fields: [PERPLEXITY_KEY],
    recorded: true,
  });

  const view = renderAdminScreen(queryClient());

  /*
   * The point of every sentence that names the vendor is that it names a place somebody has to go:
   * the console where a key is rotated, the consent screen a connection rests on. A screen that
   * drew this row without handing over the title left them all saying "the app", which names
   * nowhere at all.
   */
  expect(
    await view.findByText(/accepted without being checked against Gmail/),
  ).toBeTruthy();
  expect(
    view.queryByText(/accepted without being checked against the app/),
  ).toBeNull();
});

/**
 * A `BrokeredAccount` standing on its own, for the cases that are about what the row SAYS.
 *
 * The hook is exercised through the two screens above, which is where its own defects live. These
 * cases differ only in the three facts the row branches on — `kind`, `connected`, `verified` — and
 * a deployment built for each would be testing the stub rather than the sentence.
 *
 * Every field of `BrokeredAccount` has to be kept here by hand: `app/tsconfig.json` covers `src`
 * and not `app/tests`, and `bun test` does not typecheck, so a field added to the type and missed
 * here is `undefined` at render time and nothing says so.
 */
function accountState(overrides: Partial<BrokeredAccount>): BrokeredAccount {
  return {
    configured: true,
    connect: () => {},
    connected: false,
    connecting: false,
    disconnect: () => {},
    disconnected: false,
    disconnecting: false,
    fields: null,
    /*
     * NULL BESIDE THE NULL `submissionError` BELOW, because these cases are about the sentences the
     * ROW carries and neither refusal is one of them: both belong to the dialog, which is drawn only
     * where a key app is not connected and is exercised against the stub above.
     */
    fieldsError: null,
    kind: "consent",
    /*
     * UNDEFINED IS THE DEFAULT BECAUSE IT IS THE COMMON STATE, not because the field is optional to
     * fill in: a row drawn from a page load has been told nothing about a probe, and the cases below
     * that are about the three the server DOES send say `null` or a name for themselves.
     */
    probe: undefined,
    /*
     * FALSE IS THE DEFAULT BECAUSE IT IS THE CLOSED GATE, and the cases below that are about the
     * Re-check button say so for themselves. It is the app's own question — is there anything to
     * check a key against today — and not the record `probe` above carries.
     */
    checkable: false,
    recheck: () => {},
    rechecking: false,
    requestFields: () => {},
    requestingFields: false,
    submissionError: null,
    submitFields: () => {},
    submittingFields: false,
    verified: false,
    verifiedAt: null,
    ...overrides,
  };
}

/** The row with both screens' arguments filled in, so only the account differs between cases. */
function renderRow(account: BrokeredAccount) {
  return render(
    <BrokeredAccountRow
      account={account}
      connectedDescription="A Bot granted its tools reads your Gmail as you."
      disconnectedDescription="No Bot can read this as you."
      title="Gmail"
    />,
  );
}

test("both kinds say Connected, and the line beneath says how", () => {
  const consent = renderRow(accountState({ connected: true, kind: "consent" }));

  expect(consent.getByText("Connected")).toBeTruthy();
  expect(consent.getByText(/through Gmail's consent screen/)).toBeTruthy();

  cleanup();

  const key = renderRow(
    accountState({
      connected: true,
      kind: "fields",
      verified: true,
      verifiedAt: CHECKED_AT,
    }),
  );

  // The same word, deliberately: what differs between a consent screen and a key somebody typed is
  // not whether the account is live, and a second word for it would invite a distinction there is
  // no fact behind.
  expect(key.getByText("Connected")).toBeTruthy();
  expect(
    key.getByText(
      `Connected with a key you provided, last checked ${asDay(CHECKED_AT)}.`,
    ),
  ).toBeTruthy();
});

test("an app needing no account offers nothing to press", () => {
  const view = renderRow(accountState({ kind: "no-auth" }));

  // Not a disabled Connect, and not a Connect that would make an account nobody needs: there is no
  // account here to make, so there is no control.
  expect(view.queryByRole("button")).toBeNull();
  expect(view.getByText(/Gmail needs no account/)).toBeTruthy();
});

test("Re-check appears only where a check is possible, and asks when pressed", async () => {
  let checks = 0;
  const checkable = renderRow(
    accountState({
      // The app has something to spend the key on, which is the button's whole condition and is
      // asked of the app rather than of anything a past check recorded.
      checkable: true,
      connected: true,
      kind: "fields",
      recheck: () => {
        checks += 1;
      },
      verified: true,
      verifiedAt: CHECKED_AT,
    }),
  );

  await userEvent.click(checkable.getByRole("button", { name: "Re-check" }));
  expect(checks).toBe(1);

  cleanup();

  /*
   * AN APP WITH NOTHING TO CHECK A KEY AGAINST, which is what the server answers `checkable: false`
   * for: no action it could safely spend the key on, so there is no check to make and nothing to
   * offer. Not the same as a key nothing has checked YET — a null RECORD keeps its button, because
   * the person who has just fixed their key is exactly who reaches for it, and because the record
   * is the only place an action can come from.
   */
  const unchecked = renderRow(
    accountState({
      checkable: false,
      connected: true,
      kind: "fields",
      probe: null,
    }),
  );

  expect(unchecked.queryByRole("button", { name: "Re-check" })).toBeNull();
  expect(
    unchecked.getByText(/accepted without being checked against Gmail/),
  ).toBeTruthy();
});

test("a connected consent app offers no Re-check at all", () => {
  /*
   * WHAT A CONSENT ROW ACTUALLY LOOKS LIKE, and what every one of them was backfilled to by
   * migration 0030: connected and verified, with no probe anywhere behind the flag. Gating the
   * button on `verified` alone drew Re-check on all of them, and pressing it reached an endpoint
   * this deployment does not serve — a red banner, guaranteed, on the one kind that works today.
   */
  const view = renderRow(
    accountState({
      /*
       * TRUE, AND THE ONLY REASON THIS CASE PINS ANYTHING. `checkable` is the app's own question —
       * has it published a read a key could be spent on — and `brokeredConnectionsFor` answers it
       * per APP, off `probeActionFor(serverId)`, with no idea which scheme the asker connected by.
       * So a consent row on a Gmail that publishes reads is listed `checkable: true` by the server
       * exactly like a key row is, and `kind` is the only thing left that can withhold the button.
       * Left false, this case is satisfied by the other half of the gate and the `kind` half could
       * be deleted without a word from anybody — which is the whole regression, since a consent
       * connection has no key to spend and the press could only reach a refusal.
       */
      checkable: true,
      connected: true,
      kind: "consent",
      verified: true,
      verifiedAt: CHECKED_AT,
    }),
  );

  expect(view.queryByRole("button", { name: "Re-check" })).toBeNull();
  // The row is otherwise itself: a live account somebody can still end.
  expect(view.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  expect(view.getByText(/through Gmail's consent screen/)).toBeTruthy();
});

/**
 * THE THREE THINGS A KEY CONNECTION'S VERIFICATION CAN MEAN, one test apiece.
 *
 * The row used to collapse all three into "It was accepted without being checked against Gmail",
 * which is vague for two of them and FALSE for the third: there the key was checked, the vendor
 * refused it, and the account that check ran in is still standing — so the one person whose key is
 * definitely bad, and whose account is definitely live at Composio, was told nothing had ever been
 * tried. `probe` is what tells them apart, and these are the three shapes it arrives in.
 */

test("an app with nothing to check a key against says that about the app", () => {
  /*
   * STATE ONE: a null probe beside an unverified key. When the key was taken the app published no
   * action this deployment could safely spend it on, so nothing was tried — a fact about what the
   * app published then, which is why the sentence has to say so, in that tense, rather than leave a
   * person reading suspicion of their own key into it.
   */
  const view = renderRow(
    accountState({ connected: true, kind: "fields", probe: null }),
  );

  expect(
    view.getByText(/accepted without being checked against Gmail/),
  ).toBeTruthy();
  expect(
    view.getByText(/published nothing safe to try a key on at the time/),
  ).toBeTruthy();
  expect(view.getByText(/about the app, not about your key/)).toBeTruthy();
  // The one thing this state must never read as: a verdict on the key.
  expect(view.queryByText(/rejected/)).toBeNull();
});

test("a key that passed its check says when it passed", () => {
  /*
   * STATE TWO: a named probe and a verdict that it answered. The action ran in this person's own
   * account and the vendor took the key — and because Composio never re-checks a key once it has
   * taken it, the sentence names the moment rather than asserting a present tense.
   */
  const view = renderRow(
    accountState({
      connected: true,
      kind: "fields",
      probe: PROBE,
      verified: true,
      verifiedAt: CHECKED_AT,
    }),
  );

  expect(
    view.getByText(
      `Connected with a key you provided, last checked ${asDay(CHECKED_AT)}.`,
    ),
  ).toBeTruthy();
  expect(
    view.queryByText(/accepted without being checked against Gmail/),
  ).toBeNull();
});

test("a check that did not come back clean says so, without ruling on the key", () => {
  /*
   * STATE THREE, AND THE WHOLE REASON `probe` TRAVELS. It is reachable from either producer: the
   * check ran, the app answered with a failure, and the account it ran in is still standing — a
   * connect that now leaves the account it made, or a re-check that never withdraws one. Two facts
   * are the person's to act on: a check failed, an account of theirs is live at Composio, and the
   * row says which button ends which. WHY it stands is the one thing the sentence must not assert,
   * because the two paths stand for different reasons.
   */
  const view = renderRow(
    accountState({
      connected: true,
      kind: "fields",
      probe: PROBE,
      verified: false,
      verifiedAt: null,
    }),
  );

  expect(
    view.getByText(
      /did not come back clean — that may be the key, and it may be Gmail itself/,
    ),
  ).toBeTruthy();
  expect(view.getByText(/The account still stands at Composio/)).toBeTruthy();
  /*
   * AND NEVER A VERDICT ABOUT THE CREDENTIAL. The pair behind this sentence is written off
   * Composio's `{ data, error, successful }` envelope, which carries no status and no error code —
   * so a rate limit on the check reaches this row identically to a key the vendor rejected. Telling
   * somebody their key is bad on that evidence sends them to fetch and re-enter one that was fine.
   */
  expect(
    view.queryByText(/rejected|your key is wrong|did not work/i),
  ).toBeNull();
  // And never a cause for the account standing: a failed re-check leaves it without trying to take
  // it back, so a sentence blaming a failed withdrawal would be false on that path.
  expect(view.queryByText(/could not withdraw it/)).toBeNull();
  /*
   * AND NOT THE OTHER SENTENCE. This is the state that sentence was false in: saying nothing had
   * been checked, to the one person whose key has definitely been checked.
   */
  expect(
    view.queryByText(/accepted without being checked against Gmail/),
  ).toBeNull();
});

/**
 * EVERY OUTCOME ONE CHECK OF A BROKERED ACCOUNT CAN HAVE, as the SERVER names them — `BrokeredProbe`
 * in `server/src/plugins/store.ts` — beside the row each one leaves for this screen to read.
 *
 * THE MAPPING IS THIS FILE'S; THE LIST OF OUTCOMES IS THE SERVER'S. The server added a fourth
 * outcome (`unreachable`) after this screen was written, and nothing in either process was in a
 * position to notice: the two share no module, the outcome never travels as a word, and what
 * reaches the browser is the PAIR `{ verified, probe }` the writers leave on `composio_connections`.
 * So this roster is the mapping itself — server outcomes onto the row shapes a page load reads —
 * and the test below drives the real row through each of them.
 *
 * WHICH IS WHY THE COMPLETENESS TEST NO LONGER COUNTS THIS AGAINST A LIST OF ITS OWN. For two
 * rounds it did: `["nothing", "answered", "complained", "unreachable"]` written out at the assertion,
 * in this file, compared to the `outcome` fields above it — a fifth member on the server's real
 * `BrokeredProbe` passed that, which is exactly the drift the test was added to catch. It now
 * counts against `BROKERED_PROBE_OUTCOMES`, imported from `server/src/plugins/store.ts`, which that
 * module pins to the union in both directions with `satisfies` and a `Decides<…>` witness.
 *
 * `SERVER_FIELD_SCHEMES` ABOVE IS STILL A COPY AND STILL SHOULD BE, which is not the same case: it
 * earns its copy by carrying a scheme the screen has never heard of, and a disagreement is the one
 * thing an import cannot state. This roster claimed that defence and never used it.
 *
 * THE ROW SHAPES ARE THE WRITERS' OWN. `connectBrokeredWithFields` derives `verified` from
 * `outcome === "answered"` and records `probed.probe`, which `BrokeredProbe` withholds on both
 * outcomes where nothing can be shown to have been spent; `recheckBrokeredConnection` writes the
 * same pair for the two outcomes that reach its writer.
 *
 * A FIFTH CLIENT READING EXISTS AND IS NOT A SERVER OUTCOME: `probe: undefined` is the field being
 * absent, which is a held connection's row and no check at all. It is covered by its own case above
 * and is deliberately not in this roster, because nothing on this list can produce it.
 */
const SERVER_PROBE_OUTCOMES = [
  {
    outcome: "nothing",
    /** The app published nothing safe to call, so no name and no verdict earned. */
    row: { probe: null, verified: false, verifiedAt: null },
    says: /published nothing safe to try a key on at the time/,
    sharesItsSentenceWith: null,
  },
  {
    outcome: "answered",
    /** It ran in this person's account and the vendor took the key. */
    row: { probe: PROBE, verified: true, verifiedAt: CHECKED_AT },
    says: /last checked/,
    sharesItsSentenceWith: null,
  },
  {
    outcome: "complained",
    /** It ran and the app answered with a failure, and the account it ran in still stands. */
    row: { probe: PROBE, verified: false, verifiedAt: null },
    says: /was made with your key and did not come back clean/,
    sharesItsSentenceWith: null,
  },
  {
    /**
     * THE OUTAGE, AND THE CELL THIS ROSTER DECLARES RATHER THAN ENDORSES.
     *
     * The vendor was not reached, so nothing was learned — about the key, and about whether the
     * action ran at all. `BrokeredProbe` withholds the name from this outcome on purpose, which is
     * right: a name beside `verified: false` is the accusation "the vendor refused your key", and
     * an outage may not make it. But the row it leaves is then the SAME pair the first outcome
     * leaves, and this screen draws that pair as a sentence written for the first outcome only:
     * "which published nothing safe to try a key on at the time — that is about the app, not about
     * your key." Both clauses are false of a Composio outage.
     *
     * IT IS NOT FIXED HERE AND IT IS NOT ASSERTED AWAY. The remedy is a behavioural change on this
     * screen (round 3 finding 1-5 #1), so the roster carries the collision by name and the
     * completeness test below counts it — and the moment the client learns the outage state, this
     * entry stops being true and has to be rewritten, which is the point of declaring it.
     */
    outcome: "unreachable",
    row: { probe: null, verified: false, verifiedAt: null },
    says: /published nothing safe to try a key on at the time/,
    sharesItsSentenceWith: "nothing",
  },
] as const;

/** The line under the row's title, whole, so two shapes can be compared rather than matched. */
function descriptionOf(view: { container: HTMLElement }): string {
  const drawn = view.container.querySelector("[data-slot='item-description']");
  if (drawn === null) throw new Error("the row drew no description");
  return drawn.textContent ?? "";
}

for (const probed of SERVER_PROBE_OUTCOMES) {
  test(`a check the server ended as ${probed.outcome} draws the sentence this roster names`, () => {
    const view = renderRow(
      accountState({ connected: true, kind: "fields", ...probed.row }),
    );

    expect(view.getByText(probed.says)).toBeTruthy();

    /*
     * AND NONE OF ITS SIBLINGS' SENTENCES, which is what keeps each row of this table answering for
     * itself. An entry sharing another's sentence skips its twin and is measured against the rest —
     * so the declared collision costs this table one comparison rather than its whole discipline.
     */
    for (const other of SERVER_PROBE_OUTCOMES) {
      if (other.says.source === probed.says.source) continue;
      expect(view.queryByText(other.says)).toBeNull();
    }
  });
}

test("the probe roster covers every outcome the server has, and names the one that shares another's sentence", () => {
  /*
   * THE COUNT, which is the lever, AND IT IS AGAINST THE SERVER'S OWN VALUE. A fifth outcome added
   * to `BrokeredProbe` is an outcome with no row here, and this is where that is said — rather than
   * in a review of the screen that was never asked to change. Written out as a literal here, as it
   * was for two rounds, it said nothing at all: the list and the roster were both this file's, so
   * the only drift it could detect was drift between two things one edit changes together.
   *
   * ORDER INCLUDED, DELIBERATELY. `BROKERED_PROBE_OUTCOMES` is declared in the order the union
   * declares its members, this table is written in that order, and the entries below index into it
   * by position — so a `toEqual` that tolerated reordering would let those indices drift silently.
   */
  expect(SERVER_PROBE_OUTCOMES.map((probed) => probed.outcome)).toEqual([
    ...BROKERED_PROBE_OUTCOMES,
  ]);

  // Exactly one cell is declared rather than endorsed, and it is named beside what it collides with.
  const declared = SERVER_PROBE_OUTCOMES.filter(
    (probed) => probed.sharesItsSentenceWith !== null,
  );
  expect(
    declared.map((probed) => [probed.outcome, probed.sharesItsSentenceWith]),
  ).toEqual([["unreachable", "nothing"]]);

  /*
   * AND THE COLLISION IS PROVED RATHER THAN ASSERTED. Both outcomes leave `{ verified: false,
   * probe: null }`, and the row draws one sentence for the pair — the same string, character for
   * character. When this screen learns the outage state these two part company and this line fails,
   * which is the fix telling this roster to catch up.
   */
  const outage = renderRow(
    accountState({
      connected: true,
      kind: "fields",
      ...SERVER_PROBE_OUTCOMES[3].row,
    }),
  );
  const outageSentence = descriptionOf(outage);
  cleanup();

  const nothingTried = renderRow(
    accountState({
      connected: true,
      kind: "fields",
      ...SERVER_PROBE_OUTCOMES[0].row,
    }),
  );

  expect(outageSentence).toBe(descriptionOf(nothingTried));
  expect(outageSentence).toMatch(/published nothing safe to try a key on/);
});

test("Re-check is offered where the key is bad and withheld where there is nothing to check", async () => {
  /*
   * THE BUTTON BELONGS TO THE APP'S PROBE, NOT TO A CHECK THAT HAS ALREADY PASSED. Gating it on
   * `verified` hid it in state three, which is precisely where somebody stands after correcting the
   * key at the vendor and wanting to try it again — and the row that hid it also told them nothing
   * had ever been tried.
   */
  let checks = 0;
  const rejected = renderRow(
    accountState({
      // The app still publishes what the refused check was spent on, which is the ordinary shape of
      // this state and what puts the button within reach of somebody who has fixed their key.
      checkable: true,
      connected: true,
      kind: "fields",
      probe: PROBE,
      recheck: () => {
        checks += 1;
      },
      verified: false,
      verifiedAt: null,
    }),
  );

  await userEvent.click(rejected.getByRole("button", { name: "Re-check" }));
  expect(checks).toBe(1);

  cleanup();

  /*
   * And withheld where the app has nothing to check with. Pressing it there could only spend a
   * request to be told the same nothing again.
   */
  const nothingToCheck = renderRow(
    accountState({
      checkable: false,
      connected: true,
      kind: "fields",
      probe: null,
    }),
  );

  expect(nothingToCheck.queryByRole("button", { name: "Re-check" })).toBeNull();
  // Still a live account somebody can end: the missing button is about checking, not about acting.
  expect(
    nothingToCheck.getByRole("button", { name: "Disconnect" }),
  ).toBeTruthy();
});

test("disconnecting a key names the step this deployment cannot take", () => {
  const view = renderRow(
    accountState({ connected: false, disconnected: true, kind: "fields" }),
  );

  // The account ends at Composio and the key does not end anywhere. Saying "disconnected" and
  // stopping would leave somebody believing they had ended access they still have live.
  expect(view.getByText(/Removed from Composio/)).toBeTruthy();
  expect(
    view.getByText(/Your key still works at Gmail — rotate it there/),
  ).toBeTruthy();
});

test("a key re-checked and then disconnected stops claiming it was checked", async () => {
  installDeployment({
    authScheme: "API_KEY",
    // The app publishes something to check the key against, so the button this test presses exists.
    checkable: true,
    composioConfigured: true,
    confirms: true,
    fields: [PERPLEXITY_KEY],
    recorded: true,
    verified: true,
    verifiedAt: CHECKED_AT,
  });

  const view = renderAccountScreen(queryClient());

  expect(
    await view.findByText(
      new RegExp(`last checked ${asDay(CHECKED_AT)}`.replace(/\//g, "\\/")),
    ),
  ).toBeTruthy();

  await userEvent.click(view.getByRole("button", { name: "Re-check" }));
  await waitFor(() =>
    expect(
      view.queryByText(
        new RegExp(`last checked ${asDay(RECHECKED_AT)}`.replace(/\//g, "\\/")),
      ),
    ).toBeTruthy(),
  );

  await userEvent.click(view.getByRole("button", { name: "Disconnect" }));

  await waitFor(() =>
    expect(view.queryByText(/Removed from Composio/)).toBeTruthy(),
  );
  // The account is gone; the answer the re-check gave was about it and must go with it.
  expect(view.queryByText(/last checked/)).toBeNull();
  expect(view.queryByRole("button", { name: "Re-check" })).toBeNull();

  /*
   * AND THE ANSWER MUST NOT COME BACK WITH THE NEXT KEY. A mutation's `data` is not query state:
   * without it being thrown away, connecting again leaves the re-check's old verdict standing, and
   * the row reads "last checked" about a key entered seconds ago that nothing has ever tried.
   */
  await userEvent.click(view.getByRole("button", { name: "Connect" }));
  const dialog = await view.findByRole("dialog");
  await userEvent.type(
    await view.findByLabelText("API Key"),
    "pplx-a-fresh-one",
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Connect" }),
  );

  await waitFor(() => expect(view.queryByText("Connected")).toBeTruthy());
  expect(
    view.queryByText(/accepted without being checked against Gmail/),
  ).toBeTruthy();
  expect(view.queryByText(/last checked/)).toBeNull();
});

test("a re-check's verdict is still there after a reload, because the server wrote down what it spent", async () => {
  /*
   * THE ROUND TRIP, WHICH IS THE HALF NEITHER SIDE'S TESTS COVER ON THEIR OWN.
   *
   * CRITERION. A re-check that spends an action and comes back refused leaves a row that STILL
   * reads as refused on a page mounted fresh afterwards, with nothing in hand but the connections
   * read.
   *
   * REASON. Every other re-check here asserts against the mutation's own answer, which the hook
   * holds until something resets it — so they all pass on a deployment that answers a verdict and
   * writes nothing down. That deployment is the defect `probe` was added to close: the person
   * presses Re-check, reads that their key was refused, reloads the page, and is told the key was
   * "accepted without being checked", with the button that would tell them otherwise withheld. The
   * sibling test below pins the reading of a recorded probe; this one pins that a press is what
   * records one, which is the only part of the sequence that crosses the mutation-to-read boundary.
   *
   * THE ROW STARTS ON THE OTHER SIDE OF THE FIELD IT IS ABOUT, and it has to. The recorded probe
   * below is NULL — the key was taken when this app published nothing safe to spend it on — so the
   * only way the reload can read as refused is if the press wrote a name where a null was. Starting
   * from a row that already named a probe would let a deployment that answers and forgets satisfy
   * every assertion here, which is exactly what the harness used to do.
   *
   * AND IT IS THE STATE THE PRODUCT REALLY REACHES. `checkable` true beside a null record is an app
   * that has begun publishing something since the key was taken — an administrator pressed Refresh
   * — which is the one state where a person can press Re-check on a key nothing has ever tried.
   */
  installDeployment({
    authScheme: "API_KEY",
    checkable: true,
    composioConfigured: true,
    confirms: true,
    fields: [PERPLEXITY_KEY],
    recorded: true,
    verified: false,
    verifiedAt: null,
    probe: null,
    // The action the app now publishes, spent by the press below, and the vendor refuses the key.
    // A named probe is what makes this a press the store writes rather than returns early from.
    recheckAnswer: { verified: false, verifiedAt: null, probe: PROBE },
  });

  const view = renderAccountScreen(queryClient());

  expect(
    await view.findByText(/accepted without being checked against Gmail/),
  ).toBeTruthy();

  await userEvent.click(view.getByRole("button", { name: "Re-check" }));
  await waitFor(() =>
    expect(
      view.queryByText(/was made with your key and did not come back clean/),
    ).toBeTruthy(),
  );

  /*
   * AND NOW THE RELOAD. A fresh mount with a fresh client keeps nothing: no mutation answer, no
   * cached read, only whatever the deployment now holds. `installDeployment` is deliberately NOT
   * called again — the state this screen reads is the one the press above left behind.
   */
  cleanup();
  const reloaded = renderAccountScreen(queryClient());

  expect(
    await reloaded.findByText(
      /was made with your key and did not come back clean/,
    ),
  ).toBeTruthy();
  // And never either sentence that would be false about a key the vendor has just refused.
  expect(
    reloaded.queryByText(/accepted without being checked against Gmail/),
  ).toBeNull();
  expect(reloaded.queryByText(/last checked/)).toBeNull();
  // The way back out, which is withheld on exactly the render somebody would look for it.
  expect(
    await reloaded.findByRole("button", { name: "Re-check" }),
  ).toBeTruthy();
});

test("a re-check the vendor refused stops saying when the key was last checked", async () => {
  /*
   * THE REFUSED CHECK, WITHOUT A RELOAD, WHICH IS THE RENDER THE PERSON IS ACTUALLY STANDING ON.
   *
   * CRITERION. The press lands, the banner carries Composio's refusal, and the row above it stops
   * claiming a date that the same request has already taken away.
   *
   * REASON. `recheckBrokeredConnection` writes the verdict and the action it spent, files the trail
   * row, and THEN raises — so by the time the 400 reaches the browser the connection this page is
   * drawing no longer holds the date on screen. The mutation refetched only on success, so nothing
   * re-read it: the banner said the key had just been refused while the line above went on reading
   * "Connected with a key you provided, last checked 10/09/2026", which is a sentence about a
   * verification the deployment had already withdrawn. Two readings of one row, both drawn in the
   * same paint, and the false one is the one that looks reassuring.
   *
   * THE ROW STARTS VERIFIED AND DATED, because that is the state the stale sentence comes out of. A
   * row that was already unverified would go on reading correctly by accident and prove nothing.
   */
  installDeployment({
    authScheme: "API_KEY",
    checkable: true,
    composioConfigured: true,
    confirms: true,
    fields: [PERPLEXITY_KEY],
    recorded: true,
    verified: true,
    verifiedAt: CHECKED_AT,
    probe: PROBE,
    // The check runs, the vendor says no, and the route answers 400 over a row it has just rewritten.
    recheckAnswer: { verified: false, verifiedAt: null, probe: PROBE },
  });

  const view = renderAccountScreen(queryClient());

  expect(
    await view.findByText(
      new RegExp(`last checked ${asDay(CHECKED_AT)}`.replace(/\//g, "\\/")),
    ),
  ).toBeTruthy();

  await userEvent.click(view.getByRole("button", { name: "Re-check" }));

  // Composio's own words, which is the half that was never in doubt.
  await waitFor(() => expect(view.queryByText(REFUSED_RECHECK)).toBeTruthy());

  // And the row, which is the half that was.
  await waitFor(() =>
    expect(
      view.queryByText(/was made with your key and did not come back clean/),
    ).toBeTruthy(),
  );
  expect(view.queryByText(/last checked/)).toBeNull();
  // Still theirs to press again, because the key is what is wrong and it is fixable at the vendor.
  expect(view.getByRole("button", { name: "Re-check" })).toBeTruthy();
});

test("a key refused with its account left standing stops offering Connect", async () => {
  /*
   * THE SAME DEFECT ON THE OTHER WRITE, WHERE WHAT IS STALE IS THE BUTTON RATHER THAN A DATE.
   *
   * CRITERION. A submission the server refuses AFTER recording the connection leaves a row that
   * offers Disconnect, because there is now something to disconnect.
   *
   * REASON. `connectBrokeredWithFields` probes the key it was just handed, and where the probe
   * fails it tries to withdraw the account it made. Where Composio will not take that account back,
   * the store writes the connection anyway — unverified, carrying the action it spent — so that a
   * live grant on somebody's mailbox is not left with nothing on any screen able to name it. Then it
   * raises, and the sentence it raises with says "Disconnect it on the Plugins page".
   *
   * WHICH IS AN INSTRUCTION THE PAGE MADE IMPOSSIBLE TO FOLLOW. Refetching only on success left both
   * screens reading the connections list they held before the press: no connection, so no Disconnect
   * button, so the one act the refusal names is not on the page the refusal names. What was offered
   * instead was Connect — for an app this person now has a live account at, where a second press is
   * the 409 that says they already have one.
   */
  installDeployment({
    authScheme: "API_KEY",
    checkable: true,
    composioConfigured: true,
    confirms: false,
    fields: [PERPLEXITY_KEY],
    recorded: false,
    rejectsAndKeeps: STRANDED,
  });

  const view = renderAccountScreen(queryClient());

  await userEvent.click(await view.findByRole("button", { name: "Connect" }));
  const dialog = await view.findByRole("dialog");
  await userEvent.type(await view.findByLabelText("API Key"), "pplx-mistyped");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Connect" }),
  );

  // In the dialog and in the banner both, which the press above already has its own test for.
  await waitFor(() =>
    expect(view.queryAllByText(STRANDED).length).toBeGreaterThan(0),
  );

  // The act the sentence names, on the page the sentence names.
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Disconnect" })).toBeTruthy(),
  );
  // And never the press that would only be refused again for an account that already exists.
  expect(view.queryByRole("button", { name: "Connect" })).toBeNull();
  // The row says which of the three states it is in, too: the key was tried and refused.
  expect(
    view.queryByText(/was made with your key and did not come back clean/),
  ).toBeTruthy();
});

/**
 * A CONNECTIONS READ THAT FAILED IS SAID, NOT DEFAULTED TO "YOU HAVE NEVER CONNECTED THIS".
 *
 * CRITERION. With `/api/plugins` answering perfectly and `/api/plugins/connections` answering 500,
 * neither screen draws the brokered row, neither offers Connect, and each says the state could not
 * be read.
 *
 * REASON. Every fact the row draws — `recorded`, `verified`, `verifiedAt`, `probe`, `checkable` —
 * comes off the connections read, and both screens gated their render on the PLUGINS query and
 * consulted neither `connections.isPending` nor `connections.error`. So a 500 there left
 * `connection` undefined and the row was handed `recorded: false, verified: false, probe: undefined,
 * checkable: false` — a connection nobody has made. For a key app whose last check did not come back
 * clean that is the exact state this feature exists to keep visible: the page dropped the sentence,
 * withdrew Disconnect AND Re-check, and drew Connect instead. Pressing it opens the form and the
 * route refuses the submission — "you already have an account, disconnect it first" — so the only
 * two controls that could end the state are the two the page had just taken away, and no error text
 * appeared anywhere, because the connect mutation's `onError` was each route's only error branch.
 *
 * NOT DRAWN AT ALL RATHER THAN DRAWN EMPTY, because a row whose entire content is connection state
 * has nothing honest to say when that state could not be read.
 *
 * THE DEPLOYMENT BELOW IS THE REFUSED-KEY ONE, deliberately: it is the state whose loss costs the
 * most, and an assertion made in the "nothing connected" state would pass against a screen that
 * simply draws nothing ever.
 */
for (const [screen, renderScreen] of [
  ["the personal accounts screen", renderAccountScreen],
  ["the administrator's connector screen", renderAdminScreen],
] as const) {
  test(`${screen} says so when the connections read fails, rather than drawing a row it cannot fill`, async () => {
    installDeployment({
      authScheme: "API_KEY",
      checkable: true,
      composioConfigured: true,
      confirms: true,
      fields: [PERPLEXITY_KEY],
      recorded: true,
      verified: false,
      verifiedAt: null,
      probe: PROBE,
      connectionsFail: true,
    });

    const view = renderScreen(queryClient());

    expect(await view.findByRole("alert")).toBeTruthy();
    expect(view.getByRole("alert").textContent).toMatch(/could not be loaded/);

    // AND NO ROW, WHICH IS THE HALF THAT MATTERS. Connect is the press the route would refuse; the
    // other two are the only ways out of the state, and drawing none of them beside a silent page
    // was the defect.
    expect(view.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(view.queryByRole("button", { name: "Re-check" })).toBeNull();
    expect(view.queryByRole("button", { name: "Disconnect" })).toBeNull();
    // And never a sentence about the account, in either direction.
    expect(
      view.queryByText(/was made with your key and did not come back clean/),
    ).toBeNull();
    expect(
      view.queryByText(/accepted without being checked against Gmail/),
    ).toBeNull();
  });
}

test("a rejected key still says so on a page that has only read, and still offers Re-check", async () => {
  /*
   * THE RELOAD, WHICH IS THE STATE THIS WHOLE FIELD WAS MISSING FROM. Nothing has been pressed
   * here: no key has just been handed over and no re-check has been made, so the hook holds no
   * mutation answer at all and everything the row knows came out of the connections read. That read
   * now carries `probe` as the record of what the check spent, written down when it was spent, which
   * is what lets the three states behind one `verified: false` survive a refresh.
   *
   * Before it did, this exact page said "accepted without being checked" — to the one person whose
   * key HAS been checked and refused, and whose account is standing at Composio. The button they
   * would reach for was withheld at the same time, on the only render where they would look for it.
   */
  installDeployment({
    authScheme: "API_KEY",
    // Still publishing what the refused check was spent on, which is what offers the way back.
    checkable: true,
    composioConfigured: true,
    confirms: true,
    fields: [PERPLEXITY_KEY],
    recorded: true,
    verified: false,
    verifiedAt: null,
    probe: PROBE,
  });

  const view = renderAccountScreen(queryClient());

  expect(
    await view.findByText(/was made with your key and did not come back clean/),
  ).toBeTruthy();
  expect(view.getByText(/still stands at Composio/)).toBeTruthy();
  // And never the sentence that is false here.
  expect(
    view.queryByText(/accepted without being checked against Gmail/),
  ).toBeNull();
  // The way back: a key corrected at the vendor is worth a second check, not a second connection.
  expect(await view.findByRole("button", { name: "Re-check" })).toBeTruthy();

  cleanup();

  /*
   * AND THE SAME ON THE ADMINISTRATOR'S PAGE, which draws the same row from its own call. The two
   * screens wire the hook up separately, so a field carried into one of them and not the other is a
   * defect neither screen's other tests can see.
   */
  installDeployment({
    authScheme: "API_KEY",
    // Still publishing what the refused check was spent on, which is what offers the way back.
    checkable: true,
    composioConfigured: true,
    confirms: true,
    fields: [PERPLEXITY_KEY],
    recorded: true,
    verified: false,
    verifiedAt: null,
    probe: PROBE,
  });

  const admin = renderAdminScreen(queryClient());

  expect(
    await admin.findByText(
      /was made with your key and did not come back clean/,
    ),
  ).toBeTruthy();
  expect(await admin.findByRole("button", { name: "Re-check" })).toBeTruthy();
});

test("a key nothing was tried on offers Re-check once the app has something to try, and still says nothing was tried", async () => {
  /*
   * THE DEADLOCK, AND ITS GUARD, IN ONE ROW. The server records what a check SPENT and answers
   * separately whether the app has anything to spend TODAY, and this row is the state where those
   * two part company: a key accepted against an app that published nothing, under an app that
   * publishes something now.
   *
   * While the button read the record, this row had no way out. The check spent nothing, so the
   * record is null for good; the button was withheld on a null; and pressing that button is the
   * only thing in the product that could ever put an action in the record. Withholding it was the
   * safe direction for a question about the app and the wrong answer to it.
   *
   * AND THE SENTENCE MUST NOT MOVE WITH IT. What the row SAYS is drawn from the record, so it goes
   * on saying the key was taken and never tried — which is what happened, and stays what happened
   * however much the app has published since. A screen that let the button's question write the
   * sentence would be the accusation this record exists to prevent, arriving by the other door.
   */
  const row = renderRow(
    accountState({
      checkable: true,
      connected: true,
      kind: "fields",
      probe: null,
    }),
  );

  expect(row.getByRole("button", { name: "Re-check" })).toBeTruthy();
  expect(
    row.getByText(/accepted without being checked against Gmail/),
  ).toBeTruthy();
  /*
   * AND IN THE PAST TENSE, which is what keeps the line and the button from contradicting each
   * other. The app publishes something NOW — that is why the button is there — so a clause claiming
   * it publishes nothing would be read off the same row as the offer to check, and one of the two
   * would have to be wrong. The clause is about the moment of the check, and says so.
   */
  expect(
    row.getByText(/published nothing safe to try a key on at the time/),
  ).toBeTruthy();
  // And never the sentence written for a key the vendor refused: nothing was refused here.
  expect(
    row.queryByText(/was made with your key and did not come back clean/),
  ).toBeNull();

  cleanup();

  /*
   * AND THE SAME OFF A PAGE THAT HAS ONLY READ, on both screens. Nothing is pressed here, so every
   * field the row branches on came out of the connections read — which is the only place the second
   * answer can come from, and the two screens wire the hook up separately.
   */
  installDeployment({
    authScheme: "API_KEY",
    checkable: true,
    composioConfigured: true,
    confirms: true,
    fields: [PERPLEXITY_KEY],
    recorded: true,
    verified: false,
    verifiedAt: null,
    probe: null,
  });

  const view = renderAccountScreen(queryClient());

  expect(
    await view.findByText(/accepted without being checked against Gmail/),
  ).toBeTruthy();
  expect(await view.findByRole("button", { name: "Re-check" })).toBeTruthy();

  cleanup();

  installDeployment({
    authScheme: "API_KEY",
    checkable: true,
    composioConfigured: true,
    confirms: true,
    fields: [PERPLEXITY_KEY],
    recorded: true,
    verified: false,
    verifiedAt: null,
    probe: null,
  });

  const admin = renderAdminScreen(queryClient());

  expect(
    await admin.findByText(/accepted without being checked against Gmail/),
  ).toBeTruthy();
  expect(await admin.findByRole("button", { name: "Re-check" })).toBeTruthy();
});

/**
 * A field with a default most people keep, as Firecrawl publishes its base URL.
 *
 * The point of a published default is that nobody should have to type it: a form drawing this row
 * empty is asking for a value the app has already answered.
 */
const FIRECRAWL_BASE_URL: BrokerField = {
  name: "base_url",
  label: "Base URL",
  help: "Where your Firecrawl lives. The hosted one is already filled in.",
  required: true,
  secret: false,
  default: "https://api.firecrawl.dev",
};

/** A field the app published once and publishes no longer, which is a 400 if it is still sent. */
const RETIRED_FIELD: BrokerField = {
  name: "account_subdomain",
  label: "Subdomain",
  help: "The subdomain this app used to be reached at.",
  required: false,
  secret: false,
};

test("a form reopened after the app changed its fields draws today's fields, and sends only those", async () => {
  /*
   * THE LIST THE FORM IS BORN WITH IS THE PREVIOUS ONE. The row asks the app again on every open —
   * deliberately, because the catalogue is the vendor's — but it is still holding the last answer
   * as the dialog opens, so the form mounts on the old list and the new one arrives a moment later
   * as a changed prop.
   *
   * A form seeded once at mount never hears that. It draws today's rows, because those come off the
   * prop, and fills them from yesterday's list: a field the app has started publishing has no
   * default in it, and a field the app has stopped publishing is still in it — and that name goes
   * up with the submission, which is the 400 telling somebody their current form is not the current
   * form.
   */
  const server = installDeployment({
    authScheme: "API_KEY",
    composioConfigured: true,
    confirms: false,
    fields: [RETIRED_FIELD],
    recorded: false,
  });

  const view = renderAccountScreen(queryClient());

  await userEvent.click(await view.findByRole("button", { name: "Connect" }));
  const first = await view.findByRole("dialog");
  await userEvent.type(
    await within(first).findByLabelText("Subdomain"),
    "acme",
  );
  await userEvent.click(within(first).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());

  // What the vendor publishes for this app now, which is not what it published above.
  server.publish([PERPLEXITY_KEY, FIRECRAWL_BASE_URL]);

  await userEvent.click(view.getByRole("button", { name: "Connect" }));
  const second = await view.findByRole("dialog");
  const baseUrl = (await within(second).findByLabelText(
    "Base URL",
  )) as HTMLInputElement;

  // The app answered this one itself, and a form ignoring the answer is asking for it again.
  expect(baseUrl.value).toBe("https://api.firecrawl.dev");

  await userEvent.type(
    within(second).getByLabelText("API Key"),
    "pplx-typed-today",
  );
  await userEvent.click(
    within(second).getByRole("button", { name: "Connect" }),
  );

  await waitFor(() => expect(server.submitted.length).toBe(1));
  /*
   * Exactly what the app asks for today: the key just typed, the default it published, and no
   * trace of the field it retired — which is the name the server refuses the whole connection over.
   */
  expect(server.submitted[0]).toEqual({
    generic_api_key: "pplx-typed-today",
    base_url: "https://api.firecrawl.dev",
  });
});

/**
 * THE FORM OPENS ON THE PREVIOUS LIST, WHICH IS WHAT MAKES ITS RECONCILE A REAL PATH.
 *
 * CRITERION. Reopening the dialog for an app that has since changed its fields draws the list this
 * deployment already had, while the new one is still being asked for; the answer then arrives at a
 * form that is already mounted, and what somebody typed into it in the meantime survives.
 *
 * WHY THIS NEEDED A TEST OF ITS OWN, beside the one above it. That test asserts the same submitted
 * body and passed while the reconcile it describes could never run: the mutation clears its own
 * `data` the instant it is fired — `query-core` dispatches `pending` with `data: void 0` — so the
 * list was null as the dialog opened, `ConnectionFields` was not mounted at all, and the form was
 * built fresh on the new list every time. Right answer, path never taken. The docblock on that file
 * describing a form "mounted on the old list and handed the new one a moment later" was a
 * description of code that could not happen, and the two protections it argues for — the values
 * following the list, and the reads going through maps rather than a prototype — were reachable
 * only from `connection-fields.tsx`'s own unit tests, which drive the prop directly.
 *
 * THE GATE IS WHAT MAKES THE OPENING RENDER OBSERVABLE. Without it the ask and its answer are one
 * turn, and a form that opened empty for a moment is indistinguishable from one that never did.
 */
test("a form reopened while the app is being asked again opens on the list it already had", async () => {
  const server = installDeployment({
    authScheme: "API_KEY",
    composioConfigured: true,
    confirms: false,
    fields: [PERPLEXITY_KEY, RETIRED_FIELD],
    recorded: false,
  });

  const view = renderAccountScreen(queryClient());

  /*
   * The first open, which genuinely has nothing to open on: this deployment has never asked this
   * app anything. That is the state the waiting line is written for, and it is still drawn here.
   */
  await userEvent.click(await view.findByRole("button", { name: "Connect" }));
  await within(await view.findByRole("dialog")).findByLabelText("Subdomain");
  await userEvent.click(
    within(view.getByRole("dialog")).getByRole("button", { name: "Close" }),
  );
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());

  // The second open, with the app's answer held so the render it opens on can be read.
  const release = server.holdFields();
  await userEvent.click(view.getByRole("button", { name: "Connect" }));
  const opened = within(await view.findByRole("dialog"));

  // THE CLAIM ITSELF: the list this deployment already had, drawn while the new one is in flight.
  const key = (await opened.findByLabelText("API Key")) as HTMLInputElement;
  expect(opened.getByLabelText("Subdomain")).toBeTruthy();
  expect(view.queryByText(/Asking the app what it needs/)).toBeNull();

  /*
   * And somebody starts typing, which is what makes the arrival below a reconcile rather than a
   * remount. A form rebuilt on the new list would have no way to keep this.
   */
  await userEvent.type(key, "pplx-typed-while-waiting");

  // What the vendor publishes for this app now, which is not what it published above.
  server.publish([PERPLEXITY_KEY, FIRECRAWL_BASE_URL]);
  release();

  const dialog = within(view.getByRole("dialog"));
  const baseUrl = (await dialog.findByLabelText(
    "Base URL",
  )) as HTMLInputElement;
  // The app answered this one itself, and a form ignoring the answer is asking for it again.
  expect(baseUrl.value).toBe("https://api.firecrawl.dev");
  // The form was not rebuilt: what was typed a moment ago is still in it.
  expect((dialog.getByLabelText("API Key") as HTMLInputElement).value).toBe(
    "pplx-typed-while-waiting",
  );
  // And the name the app has stopped publishing is gone, rather than left to go up with the rest.
  expect(dialog.queryByLabelText("Subdomain")).toBeNull();

  await userEvent.click(dialog.getByRole("button", { name: "Connect" }));

  await waitFor(() => expect(server.submitted.length).toBe(1));
  expect(server.submitted[0]).toEqual({
    generic_api_key: "pplx-typed-while-waiting",
    base_url: "https://api.firecrawl.dev",
  });
});

/**
 * AND A RE-ASK THAT IS REFUSED SAYS SO, RATHER THAN LEAVING THE OLD FORM UP TO BE SUBMITTED.
 *
 * THE COST OF THE TEST ABOVE, PAID HERE. Holding the previous list means the dialog has something
 * to draw on a press that then fails — and the four things this route can say each name a different
 * act, while a stale form invites the one act that cannot work: sending a list the app has just
 * refused to confirm. The refusal is what the person gets, on the press that asked.
 */
test("a form reopened against an app that cannot be asked shows the refusal, not the old list", async () => {
  const server = installDeployment({
    authScheme: "API_KEY",
    composioConfigured: true,
    confirms: false,
    fields: [PERPLEXITY_KEY, RETIRED_FIELD],
    recorded: false,
  });

  const view = renderAccountScreen(queryClient());

  await userEvent.click(await view.findByRole("button", { name: "Connect" }));
  await within(await view.findByRole("dialog")).findByLabelText("Subdomain");
  await userEvent.click(
    within(view.getByRole("dialog")).getByRole("button", { name: "Close" }),
  );
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());

  // The app is gone from the directory between the two presses, which is a 502 and a sentence.
  server.refuseFields({
    error: "Composio would not say what Gmail asks for.",
    status: 502,
  });

  await userEvent.click(view.getByRole("button", { name: "Connect" }));
  const dialog = within(await view.findByRole("dialog"));

  expect(
    await dialog.findByText("Composio would not say what Gmail asks for."),
  ).toBeTruthy();
  // And nothing left over to type a key into and press Connect on.
  expect(dialog.queryByLabelText("API Key")).toBeNull();
  expect(dialog.queryByLabelText("Subdomain")).toBeNull();
});

/** A key worth being careful with, spelled distinctly so a search of held state cannot miss it. */
const TYPED_SECRET = "pplx-0nly-ever-forwarded";

/** Everything a mutation is still holding as its input, which is where a key was outliving its use. */
function retainedInputs(client: QueryClient): string {
  return JSON.stringify(
    client
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.variables),
  );
}

test("a typed key is gone from the mutation's own state once the request has settled", async () => {
  /*
   * WHAT THE FORM'S DOCBLOCK PROMISES, CHECKED WHERE IT WAS UNTRUE. The values are the component's
   * and nowhere else — except that handing them to a mutation is not the same as sending them. A
   * mutation keeps the input it was called with for as long as its observer lives, so the key stayed
   * legible in mutation state long after the request it was typed for had finished, to anything
   * reading that state, devtools included.
   *
   * The request body is the whole of its life here, so the retained input is cleared as the request
   * settles — which is what this asserts, on both endings a submission has.
   */
  installDeployment({
    authScheme: "API_KEY",
    composioConfigured: true,
    confirms: false,
    fields: [PERPLEXITY_KEY],
    recorded: false,
  });

  const accepted = queryClient();
  const view = renderAccountScreen(accepted);

  await userEvent.click(await view.findByRole("button", { name: "Connect" }));
  const dialog = await view.findByRole("dialog");
  await userEvent.type(await view.findByLabelText("API Key"), TYPED_SECRET);
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Connect" }),
  );

  await waitFor(() => expect(view.queryByText("Connected")).toBeTruthy());
  expect(retainedInputs(accepted)).not.toContain(TYPED_SECRET);

  cleanup();

  /*
   * AND ON THE REFUSAL, WHICH IS THE LONGER-LIVED HALF. A key the vendor would not take leaves the
   * form open over the sentence saying why, so the mutation sits settled-and-failed with its input
   * held for as long as somebody spends correcting a key — and correcting it is what the form is
   * for, so the form's own copy has to survive the clearing untouched.
   */
  installDeployment({
    authScheme: "API_KEY",
    composioConfigured: true,
    confirms: false,
    fields: [PERPLEXITY_KEY],
    recorded: false,
    rejects: REFUSED,
  });

  const refused = queryClient();
  const second = renderAccountScreen(refused);

  await userEvent.click(await second.findByRole("button", { name: "Connect" }));
  const refusedDialog = await second.findByRole("dialog");
  const input = (await second.findByLabelText("API Key")) as HTMLInputElement;
  await userEvent.type(input, TYPED_SECRET);
  await userEvent.click(
    within(refusedDialog).getByRole("button", { name: "Connect" }),
  );

  await waitFor(() =>
    expect(within(refusedDialog).queryByText(REFUSED)).toBeTruthy(),
  );
  expect(retainedInputs(refused)).not.toContain(TYPED_SECRET);
  // And the form still holds what was typed, because a mistyped key is corrected, not retyped.
  expect(input.value).toBe(TYPED_SECRET);
});

/**
 * The three fields the hook answers about a check, read from the hook rather than off a row.
 *
 * WHY A PROBE AND NOT THE SCREEN. `useBrokeredAccount` hands `verified`, `verifiedAt` and `probe` to
 * ANY reader, and the row is one reader that happens to hide all three the moment `connected` goes
 * false. So a stale answer surviving a disconnect is invisible on the screen and perfectly visible
 * here — which is the distinction the hook's own comment draws when it says the reset is "rather
 * than a guard at the drawing", because a guard in the render "would leave the hook handing
 * `verified: true` to any other reader".
 *
 * ITS INPUTS ARE FIXED, which is what makes the assertion sharp. They stand for the connections
 * read, and they never move: everything that changes between the two assertions below is the
 * mutation state the hook holds, so a difference can only be the hook's own doing.
 */
function AccountProbe() {
  const account = useBrokeredAccount({
    serverId: APP_KEY,
    brokered: true,
    configured: true,
    // Recorded connected, unverified, and with nothing ever spent on the key — the row a press of
    // Re-check below is made against, and the row it must fall back to once that press is undone.
    recorded: true,
    verified: false,
    verifiedAt: null,
    probe: null,
    checkable: true,
    authScheme: "API_KEY",
    returnTo: "settings",
    report: () => {},
  });

  return (
    <div>
      <span data-testid="verified">{String(account.verified)}</span>
      <span data-testid="verified-at">{String(account.verifiedAt)}</span>
      <span data-testid="probe">{String(account.probe)}</span>
      <button onClick={account.recheck} type="button">
        Re-check
      </button>
      <button onClick={account.disconnect} type="button">
        Disconnect
      </button>
    </div>
  );
}

/**
 * A DISCONNECT THROWS THE RE-CHECK'S VERDICT AWAY, AND NOT ONLY WHERE THE ROW WOULD HAVE DRAWN IT.
 *
 * CRITERION. After a re-check answers and the account is then disconnected, the hook reports the
 * read's own record again — unverified, undated, nothing spent — rather than the answer to a press
 * about an account that no longer exists.
 *
 * REASON. `forgetRecheck()` is called from three places and the screen tests can only see two of
 * them: the connect and the submission clear the same answer on their way past, so deleting the
 * line in the DISCONNECT left all twenty-seven of them green. That line is not redundant. The
 * verdict it drops is about an account that has just been ended, and the hook goes on handing it to
 * whoever asks — the row hides all three fields behind `connected`, so what the deletion costs is
 * invisible exactly where it is cheapest to look and real everywhere else.
 *
 * READ THROUGH {@link AccountProbe} FOR THAT REASON, which is the hook's own argument for resetting
 * rather than guarding at the drawing: an answer about a thing that no longer exists should stop
 * existing, not merely stop being painted.
 */
test("a disconnect drops the re-check's verdict for every reader, not just the row", async () => {
  installDeployment({
    authScheme: "API_KEY",
    checkable: true,
    composioConfigured: true,
    confirms: true,
    recorded: true,
  });

  const view = render(
    <QueryClientProvider client={queryClient()}>
      <AccountProbe />
    </QueryClientProvider>,
  );

  // The record, before anything has been pressed: the three fields as the read carries them.
  expect(view.getByTestId("verified").textContent).toBe("false");
  expect(view.getByTestId("verified-at").textContent).toBe("null");
  expect(view.getByTestId("probe").textContent).toBe("null");

  await userEvent.click(view.getByRole("button", { name: "Re-check" }));
  await waitFor(() =>
    expect(view.getByTestId("verified").textContent).toBe("true"),
  );
  expect(view.getByTestId("verified-at").textContent).toBe(RECHECKED_AT);
  expect(view.getByTestId("probe").textContent).toBe(PROBE);

  await userEvent.click(view.getByRole("button", { name: "Disconnect" }));

  // And back to the record, because the account the verdict was about has been ended.
  await waitFor(() =>
    expect(view.getByTestId("verified").textContent).toBe("false"),
  );
  expect(view.getByTestId("verified-at").textContent).toBe("null");
  expect(view.getByTestId("probe").textContent).toBe("null");
});

/**
 * A RE-CHECK THAT SPENT NOTHING LEAVES THE RECORDED VERDICT EXACTLY WHERE IT FOUND IT.
 *
 * CRITERION. On a row recording a key the vendor checked and refused, a re-check answering a null
 * probe leaves the row still saying so. The press wrote nothing, so it may unwrite nothing.
 *
 * THIS FILE USED TO PIN THE OPPOSITE, under `a re-check that spent nothing overrules the action the
 * record still names`, on the reading that "an answer beats the record" and that the answer's null
 * is the server saying this check spent nothing. The first half is right and the second is the
 * mistake: `probe` on THIS route is what the PRESS spent, and `probe` on the connections read is
 * what the last check that spent anything WROTE DOWN. They are not two records of one thing, so the
 * newer of the two does not win — the newer one is not a record at all.
 *
 * AND `recheckBrokeredConnection` SAYS SO IN THE ONLY WAY THAT MATTERS: on this outcome it returns
 * before the writer, deliberately, so that "a check which could try nothing writes nothing at all".
 * The row it read is untouched, `probe_action` still names the action the vendor refused, and the
 * very next connections read answers with that name again.
 *
 * WHAT THE OLD RULE COST, WHICH IS WHY IT IS WORTH A TEST RATHER THAN A COMMENT. The row flipped
 * from the worst state this feature has — your key was rejected and the account still stands at
 * Composio, with two named ways out — to "accepted without being checked … that is about the app,
 * not about your key", which is an absolution. AND THE PRESS TOOK THE BUTTON WITH IT: the outcome
 * is `nothing` precisely when `probeActionFor` answers null, which is the same read the listing
 * draws `checkable` from, so the refetch that follows withdraws Re-check. Nothing in the interface
 * could then put the true sentence back.
 */
test("a re-check that spent nothing leaves the rejection the record still names", async () => {
  installDeployment({
    authScheme: "API_KEY",
    // The app still publishes something, which is what puts the button on the row at all.
    checkable: true,
    composioConfigured: true,
    confirms: true,
    fields: [PERPLEXITY_KEY],
    recorded: true,
    verified: false,
    verifiedAt: null,
    // What the LAST check spent, and the vendor refused it. This is the record the press below
    // arrives at, and the one the deployment leaves standing.
    probe: PROBE,
    // And what THIS press finds: the action it would have spent is no longer callable — a version
    // the listing recorded has gone, or the app stopped publishing it — so nothing was tried.
    recheckAnswer: { verified: false, verifiedAt: null, probe: null },
  });

  const view = renderAccountScreen(queryClient());

  // The accusation, as the record leaves it.
  expect(
    await view.findByText(/was made with your key and did not come back clean/),
  ).toBeTruthy();

  await userEvent.click(view.getByRole("button", { name: "Re-check" }));

  /*
   * THE BUTTON GOING IS WHAT SAYS THE PRESS LANDED, and it is asserted first for that reason: the
   * sentence below is what the row said before the press as well, so a test that only read it
   * would pass against a click that never reached the deployment at all.
   */
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Re-check" })).toBeNull(),
  );

  // And the three facts this person can act on are all still on the row.
  expect(
    view.getByText(/was made with your key and did not come back clean/),
  ).toBeTruthy();
  expect(view.getByText(/still stands at Composio/)).toBeTruthy();
  // Never the absolution, which is the other app's state and not this one's.
  expect(
    view.queryByText(/accepted without being checked against Gmail/),
  ).toBeNull();
});
