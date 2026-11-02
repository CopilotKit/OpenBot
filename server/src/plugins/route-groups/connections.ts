import type { AppVariables } from "../../auth/guards";
import { reasonWithoutStatement } from "../../db/query-failure";
import { normalizeArcadeError } from "../arcade-adapter";
import {
  BrokerAccountHeldError,
  type BrokerField,
  BrokerUnconfiguredError,
  brokerReturnUrl,
  brokerSentence,
  type Decides,
  type GrantState,
  isFieldScheme,
  type SchemeKind,
  schemeKind,
} from "../broker";
import { catalogueEntry } from "../catalogue";
import {
  authorizationUrlFor,
  type ConnectOrigin,
  challengeFor,
  connectedAccountsUrlFor,
  createVerifier,
  redirectUriFor,
  sealConnectState,
} from "../oauth";
import { type AccountRef, asAccountRef } from "../shared-accounts";
import {
  CatalogueEntryUnknownError,
  type OAuthClient,
  PluginRefusedError,
} from "../store";
import {
  type AuthorizationRefusal,
  brokerRefusal,
  logReturnUrlRefusal,
  type PluginRouteContext,
  STATUS_CALL_TIMEOUT_MS,
  sameAccount,
  settledStatus,
  signInUrlFor,
  withVendorDeadline,
} from "./context";

/** A person's connections: listing them, connecting an app (OAuth or brokered) and disconnecting. */
export function mountConnectionRoutes({
  routes,
  store,
  requireUser,
  connect,
  composio,
  activeProvider,
  appOfUrl,
  actorEmail,
}: PluginRouteContext) {
  /**
   * Where a person's own connections are, and how to start a new one.
   *
   * Not admin-only, and that is the point: an administrator registers the connector once, and then
   * everybody connects their own account. Somebody can only ever see or start their own.
   */
  routes.get("/connections", requireUser, async (context) => {
    /*
     * BOTH TABLES, ONE LIST, because the person asking has one question.
     *
     * "Am I connected to this?" is the same question whether the grant is a refresh token in this
     * deployment's vault or an account Composio holds on our behalf. Which table a connection lives
     * in is a fact about how the vendor is reached — the transport, the credential, who keeps the
     * secret — and none of that is something a settings page should have to know in order to draw a
     * word beside a row. Answering out of `connectionsFor` alone left the brokered half invisible,
     * so the page could only either say "Not connected" over a live account or say nothing at all,
     * and it chose to say nothing.
     *
     * CONCATENATED WITHOUT REWRITING, because the fields a settings page draws from — the server
     * id, the scope, the date — line up across the two reads, and one row template can draw either
     * kind. What does not line up is what `brokeredConnectionsFor` adds — `verified`, `verifiedAt`,
     * `probe` and `checkable` — so the list that leaves here is not uniform. Those travel because a
     * brokered row is the only one with anything to re-check: this deployment holds no secret for
     * it, only a note that Composio said yes, and that note can drift when somebody ends the
     * connection in Composio's own dashboard. `probe` rides with the first two because the flag
     * cannot be read alone — three situations share one `verified: false`, and which action the
     * check actually SPENT is what separates them on a page that has done nothing but load.
     *
     * `probe` AND `checkable` ARE TWO ANSWERS AND NOT ONE SENT TWICE, and a caller that treats them
     * as interchangeable breaks the page in one of two opposite ways. `probe` is a record of the
     * check that was made; `checkable` is whether the app has anything to check with NOW. They
     * agreed while the first was derived, and an administrator's press of Refresh moved what the
     * app publishes without touching what the check spent — so the page accused a key nobody had
     * tried. Recording the first fixed that and deadlocked the other half: a key nothing was spent
     * on reads null for good, and the button that is the only way to ever spend one was gated on
     * that null. So the sentence is drawn off `probe` and the button off `checkable`; see
     * `brokeredConnectionsFor`, which sets both failures out in full. A held connection has no
     * equivalent question, so its rows carry none of these fields, and their absence is what tells
     * the two READS apart. It is not how a reader learns how an app connects: that is the app's
     * recorded `authScheme`, and a page asking this list instead would be deriving a second answer
     * to a question the row already carries.
     *
     * SORTED, so two requests answer in the same order. Each read is ordered by server id within
     * its own table, and concatenating two sorted lists is not a sorted list. Compared as plain
     * strings rather than by `localeCompare`, because the order only has to be the SAME one every
     * time, and a collation that varies with the deployment's locale is not that.
     */
    const [held, brokered, shared] = await Promise.all([
      store.connectionsFor(context.var.actor.id),
      store.brokeredConnectionsFor(context.var.actor.id),
      store.sharedConnections(),
    ]);
    const connections = [
      ...held.map((row) => ({ ...row, holder: "person" as const })),
      ...brokered.map((row) => ({ ...row, holder: "person" as const })),
      ...shared,
    ].sort((left, right) => {
      if (left.serverId < right.serverId) return -1;
      return left.serverId > right.serverId ? 1 : 0;
    });

    return context.json({
      connections,
      // Shown to an administrator so they can register the client at the vendor with the exact value
      // this deployment will send. Null means the deployment has no public URL and cannot connect.
      redirectUri: connect?.publicUrl
        ? redirectUriFor(connect.publicUrl)
        : null,
    });
  });

  /**
   * Begin connecting an account: a person's own, or, for a Shared app, the deployment's team
   * account.
   *
   * Answers with a URL rather than redirecting, so the browser decides when to leave the page. The
   * state is minted here, from the session and the row's mode, and never from anything the request
   * carries.
   *
   * A brokered app can answer two other ways: `{ fields }` for an app whose key somebody types, and
   * `{ connected: true }` where the vendor already holds this account and this deployment had no
   * row for it, which is recorded here exactly as the confirm route records it.
   */
  routes.post("/servers/:id/connect", requireUser, async (context) => {
    const serverId = context.req.param("id");

    /*
     * A BROKERED APP IS ANSWERED HERE AND GOES NO FURTHER DOWN THIS HANDLER.
     *
     * Everything below this branch belongs to the consent flow THIS deployment runs: a public URL
     * to build a redirect URI out of, a catalogue entry naming the vendor's authorization
     * endpoint, an OAuth client an administrator registered, a sealed state the callback reads
     * back. A brokered app has none of it. Composio holds the consent, so no authorization code
     * ever comes back to us, no refresh token is stored here, and no redirect URI of ours is
     * registered with anybody — there is nothing for those checks to be about.
     *
     * WHICH IS WHY THE ORDER IS THE WHOLE POINT AND NOT A TIDINESS. Falling through, a brokered
     * row met `catalogueEntry`, which has never heard of `composio-linear`, and the person
     * pressing Connect was told the app "is not connected as an individual person" — the exact
     * opposite of true about the one kind of row that is ONLY ever connected as an individual
     * person. On a deployment with no `OPENBOT_PUBLIC_URL` it failed one step earlier still,
     * refusing for want of a setting that has no bearing on a flow it does not enter.
     *
     * The app comes off the row's url via `appOfUrl` rather than off its id, for the reason the
     * directory route says: the url is where the transport reads which app a call is against, and
     * the id is a row name that happens to look similar.
     *
     * ONE ROW, BY ID. Every request to this route pays for this read, including the ones that fall
     * through to the OAuth flow below, because the branch cannot be taken until the row is in hand
     * — so what it costs has to be a lookup of three columns rather than the whole plugin surface.
     * `serverAddress` answering `undefined` is an id naming no row, which falls through exactly as
     * a missing row did when this was a `.find`.
     */
    const row = await store.serverAddress(serverId);
    const toolkit = row ? appOfUrl(row.url) : null;
    if (row && toolkit) {
      /*
       * AN APP THAT NEEDS NO CREDENTIAL IS ANSWERED HERE, BEFORE `brokeredAccountFor` IS EVER
       * ASKED WHOSE ACCOUNT THIS IS.
       *
       * `accountRefFor` — which that resolver calls — refuses a `none` scheme too, but in the one
       * sentence it can write for all three routes that share it: "needs no account", with nothing
       * about what that means or what the app can still do. That function speaks for confirm,
       * re-check and end as well as connect, so it cannot know which of them is asking or reach for
       * this route's fuller wording. Asked first and answered here instead, the sentence this route
       * has always had for a no-auth app — naming what the app is and that a Bot can use it as it
       * is — stays the one a person pressing Connect reads, rather than going dead code behind the
       * resolver's terser refusal.
       */
      if (schemeKind(row.authScheme) === "none") {
        return context.json(
          {
            error: `${row.title} needs no account, so there's nothing to connect. Bots that can use it already work.`,
          },
          400,
        );
      }

      /*
       * WHOSE ACCOUNT THIS IS COMES FROM `brokeredAccountFor`, THE SAME RESOLVER THE OTHER THREE
       * BROKERED ROUTES CALL, AND FIRST IN THIS BRANCH SO NOTHING BELOW CAN ACT BEFORE IT HAS
       * ANSWERED. A Personal app's account is the actor's own; a Shared app's is the deployment's,
       * and only an administrator may reach that one — both decided there, once, rather than
       * re-derived here. Its refusal already covers no broker being configured and a row that
       * `accountRefFor` cannot resolve, in the same words this branch used to write itself. The
       * `none` scheme is the one member of that refusal's vocabulary this branch now answers
       * itself, for the reason just given — everything `accountRefFor` can still be asked about a
       * row that reaches this call is never `none`.
       */
      const resolved = await brokeredAccountFor(context, serverId);
      if (resolved.refusal) {
        return context.json(
          { error: resolved.refusal.error },
          resolved.refusal.status,
        );
      }
      const { account } = resolved;

      /*
       * `composio` IS CHECKED AGAIN HERE FOR `tsc`'S BENEFIT AND NOT FOR THE REFUSAL. The function
       * above closes over the same binding and has already returned for everybody it is unset for
       * — this can only be reached once it answered — but that is a fact about the function's
       * body and not one the type checker can see across the call above. Without this, every
       * `composio.broker` read below the field and consent branches would be a `possibly
       * undefined` it cannot actually be.
       */
      if (!composio) {
        return context.json(
          {
            error: new BrokerUnconfiguredError(activeProvider, "person")
              .message,
          },
          503,
        );
      }

      /*
       * THE ACCOUNT IS `brokeredAccountFor`'S, HERE AND IN THE READ ABOVE IT.
       *
       * Nothing in this branch reads a user id out of the body or the query, and that is the
       * property rather than an implementation detail: the link minted below attaches an account
       * to whichever one is passed in, so a user id a caller could choose would let one POST hang
       * somebody else's mailbox off this deployment. It is the defect the prior art this design
       * follows shipped three separate times, and it is structural here — there is no line that
       * could break it. For a Shared app the account is the deployment's rather than whoever is
       * signed in, decided above and never by anything the request carries.
       */
      const existing = await store.brokeredConnection({ toolkit, account });
      if (existing) {
        /*
         * Named with the step to take rather than only refused: a second link would attach a
         * second account behind a row that already says connected, and the way to a new one is
         * through the connection they have.
         *
         * THE APP'S TITLE, NOT THE ROW'S ID. `composio-linear` is this deployment's name for a
         * table row; "Linear" is the name of the thing the person connected and the only one of
         * the two they have ever seen on a screen. An internal key in a sentence addressed to a
         * person is both unhelpful and a small leak of how the rows are keyed.
         *
         * WHOSE ALREADY, SAID PLAINLY FOR A SHARED APP. "You already have an account" is true for
         * a Personal app and false for a Shared one — nobody signed in holds that account, the
         * deployment does — so a deployment account's refusal names the deployment's connection
         * rather than putting the actor's own claim on it.
         */
        return context.json(
          {
            error:
              account.holder === "deployment"
                ? `${row.title} already has a shared account connected. Disconnect it first if you want to connect a different one.`
                : `You already have an account connected to ${row.title}. Disconnect it first if you want to connect a different one.`,
          },
          409,
        );
      }

      /*
       * AN APP WHOSE SECRET THE PERSON HOLDS IS ANSWERED HERE AND NEVER SENT AT A CONSENT SCREEN.
       *
       * Most of Composio's catalogue connects this way rather than through a consent screen: the
       * person already holds an API key, so there is nothing to consent to, no url to mint and no
       * return leg to build — the press that opens a vendor page for a consent app has to answer
       * with a form instead, and the press after it carries what was typed into it. One route
       * serves all three arms because the browser asks the same question every time: connect me to
       * this app. The third is below: an app that needs no credential at all, which is answered
       * with the fact rather than with either flow.
       *
       * THE FORK IS THE SCHEME RECORDED ON THE ROW AT ENABLE TIME, which is what this deployment's
       * authorization config was actually created as — never a fresh catalogue read and never
       * anything the request said. {@link isFieldScheme} is asked rather than the string compared,
       * for the reason that function exists: one list, read by the guard and by the type, so the
       * schemes admitted here cannot come apart from the ones the broker's signature takes.
       *
       * AFTER THE ONE-ACCOUNT GUARD RATHER THAN BESIDE IT, and the order is a decision. Somebody
       * who already has an account attached has no business in front of a form: drawing one invites
       * them to type a key that would be refused once they had entered it, and even the first press
       * would spend a call at Composio on behalf of a request that is going to be refused anyway.
       * The refusal above names the step to take, and it is the same step for every kind of app.
       *
       * THE PERSON IS STILL THE SESSION'S, as everywhere else in this branch. Nothing below reads
       * a user id out of the body — and nothing below logs the body either, which matters more
       * here than anywhere else in this file: it is the one request this deployment handles that
       * carries somebody's own credential.
       */
      const authScheme = row.authScheme;

      /**
       * WHAT THIS FORK ANSWERS FOR EACH KIND OF APP STILL REACHABLE HERE, AND EVERY ARM IS REACHED
       * BY DECIDING.
       *
       * Type-only and erased; see {@link Decides} in `./broker`. A member of this three-name
       * vocabulary left unanswered fails `tsc` here by name, which is what this roster is for: the
       * fork below reads it with a chain of `if`s, and an `if` chain has no opinion about the
       * answers it was not written for.
       *
       * `none` IS NOT A MEMBER OF IT, AND IS EXCLUDED RATHER THAN ANSWERED `unreachable`. The
       * branch above — before `brokeredAccountFor` is ever called — already refused a `none`
       * scheme in the route's own words, so `authScheme` read here can never be one: this fork is
       * about the three kinds of app that branch does not already dispose of.
       *
       * CRITERION. Every arm below is entered because {@link schemeKind} said so. No arm is the
       * fall-through of the others.
       *
       * REASON. This file used to import {@link isFieldScheme} and not `schemeKind`, and compare one
       * raw literal beside it — so the fork was two tests and a fall-through, and the fall-through
       * was the consent arm. A scheme this deployment cannot read — a null, or a literal nothing
       * here writes, which the row that ANSWERS for an app is free to carry because
       * `mcp_servers.url` has no unique index — therefore landed in the arm that mints an
       * authorization link at Composio for an app with no consent config behind it. That is a real
       * act performed at the vendor on behalf of an answer nobody decided, and its only possible end
       * is a link the person cannot complete. The three readers of this column in `./store` already
       * fail closed on that value; this one was the last that did not.
       */
      type _ConnectForkDecides = Decides<
        Exclude<SchemeKind, "none">,
        {
          key: "answers with the form the app publishes, and connects what is typed into it";
          consent: "mints a link at Composio for the person to finish at the vendor's own screen";
          unreadable: "refuses, and asks Composio nothing — it is not a consent app and there is no link to mint";
        }
      >;
      const kind = schemeKind(authScheme);

      if (isFieldScheme(authScheme)) {
        /*
         * A SUBMISSION IS AN OBJECT OF VALUES, AND ANYTHING ELSE IS THE FIRST PRESS. The browser
         * sends no body at all when it is asking what the app wants, so an absent, empty or
         * unparseable one is that question rather than a malformed answer to it, and the worst a
         * caller gets for sending something stranger is the form back.
         */
        const body = (await context.req.json().catch(() => null)) as {
          values?: unknown;
        } | null;
        const submitted =
          typeof body?.values === "object" &&
          body.values !== null &&
          !Array.isArray(body.values)
            ? (body.values as Record<string, unknown>)
            : null;

        /*
         * ASKED OF THE VENDOR ON BOTH PRESSES, because it is the answer to both questions. On the
         * first it is the form itself; on the second it is the list the submission is checked
         * against, and reading it from anywhere else — a cached copy, the fields the form was drawn
         * from — would be checking a body against what the app used to ask for.
         */
        let published: BrokerField[];
        try {
          published = await withVendorDeadline(() =>
            composio.broker.connectionFields({
              toolkit,
              authScheme,
            }),
          );
        } catch (error) {
          const refusal = brokerRefusal(
            error,
            `Couldn't find out what ${row.title} needs to connect. Try again, or ask an admin if it keeps happening.`,
          );
          return context.json({ error: refusal.error }, refusal.status);
        }

        if (submitted === null) return context.json({ fields: published });

        /*
         * AN APP WITH NO BOXES CANNOT BE CONNECTED BY SOMEBODY TYPING, WHICH IS THE ONLY WAY THIS
         * BRANCH CONNECTS ANYBODY.
         *
         * {@link isFieldScheme} admits exactly the schemes whose secret a PERSON holds, so an
         * empty published list is not a short form — it is a form with nowhere to put the one
         * thing the scheme is for. Every check below passes such a submission for want of anything
         * to check, and what it makes is an account Composio marks `ACTIVE` because Composio does
         * not grade what it is handed. An app with no probeable action then has that row written
         * and drawn as connected on every screen here.
         *
         * ON THE SUBMISSION AND NOT ON THE PRESS ABOVE IT. The empty list is a true answer to
         * "what does this app ask for" — {@link ComposioBroker.connectionFields} says so, and
         * distinguishes it there from the scheme the app no longer publishes at all, which refuses.
         * What is false is the account the next press would make, so that is the press that is
         * refused.
         *
         * THE REMEDY IS AN ADMINISTRATOR'S, because nothing the person pressing Connect can do
         * changes what the app publishes or which scheme this deployment recorded for it.
         */
        if (published.length === 0) {
          return context.json(
            {
              error: `${row.title} doesn't ask for anything to connect with, so no account was made. Ask an admin to remove it under Plugins and add it again.`,
            },
            400,
          );
        }

        /*
         * AND AN APP THAT PUBLISHES BOXES BUT REQUIRES NONE OF THEM IS THE SAME ACCOUNT WITH A FORM
         * IN FRONT OF IT.
         *
         * THE GUARD BELOW READS `required` ON THE NAMES THAT ARRIVED; THIS ONE READS THE LIST. A
         * published list with no required field in it leaves that guard nothing to be about, so
         * `{"values":{}}` passes it vacuously — and so does a box holding spaces, and so does the
         * default the form seeded itself from. What each of the three makes is an account carrying
         * no credential, which Composio answers `ACTIVE` for because it does not grade what it is
         * handed, and which an app with no probeable action leaves recorded and drawn as connected:
         * the very end state the required guard exists to prevent, reached down the one path that
         * guard cannot see.
         *
         * THE CLAIM THIS RESTS ON, STATED RATHER THAN ASSUMED: EVERY FIELD SCHEME IN COMPOSIO'S
         * CATALOGUE PUBLISHES AT LEAST ONE REQUIRED FIELD, BECAUSE A FIELD SCHEME IS COMPOSIO'S OWN
         * STATEMENT THAT THE PERSON HOLDS A CREDENTIAL. What makes it a claim about the catalogue
         * rather than a guess is that "this app needs nothing" already has its own name there:
         * `NO_AUTH` sits beside `API_KEY`, `BASIC`, `BEARER_TOKEN` and `BASIC_WITH_JWT` in the
         * vendor's own scheme enum (`@composio/core` 0.18.1, `src/types/authConfigs.types.ts:9-24`),
         * and this route answers it in its own branch a few lines above — so an app that reached
         * HERE has told Composio it needs SOMETHING, and a field list requiring nothing is not that
         * app saying it needs nothing after all.
         *
         * AND THE SDK SAYS WHAT THE SOMETHING IS, PER SCHEME. `connectedAccountAuthStates.types.ts`
         * declares the shape of an ACTIVE account one scheme at a time: `BASIC` and `BASIC_WITH_JWT`
         * require `username` and `password`, `BEARER_TOKEN` requires `token`, and `NO_AUTH` requires
         * nothing at all — an ACTIVE no-auth account is the base row and no credential beside it.
         * `API_KEY` is the one that marks `api_key` and `generic_api_key` optional, and it does so
         * because the NAME of the box varies across the catalogue and both spellings occur in it,
         * not because an API_KEY account may hold no key: the same declaration keeps a `catchall`
         * for the third spelling. Three of the four field schemes therefore say in the vendor's own
         * types that an account of theirs carries a credential, and the fourth says which credential
         * it cannot name.
         *
         * WHAT WAS NOT DONE, AND IT IS THE HONEST LIMIT OF THE CLAIM: the live catalogue was not
         * enumerated. There is no network and no Composio key on this path, so "no toolkit publishes
         * a field scheme with an empty required list" is ARGUED from the vendor's own package rather
         * than counted across its apps. The guard is written to fail in the safe direction for that
         * reason. If such an app does exist, it becomes an app this deployment will not connect and
         * SAYS SO, with a remedy addressed to the one person who could change it — which is the
         * direction the empty-list guard directly above already chose, and the opposite of the
         * silent credential-less account that is the alternative.
         *
         * THE STATE UNDER THIS GUARD IS ONE STATE AND NOT TWO, WHICH IS WHAT MAKES IT DECIDABLE AT
         * ALL. "An app whose required flags we could not read" used to be indistinguishable from
         * "an app that requires nothing", and it is no longer: {@link ComposioBroker.connectionFields}
         * reads each flag through `flagOf`, which answers the caller's default for an ABSENT flag
         * and refuses one that is PRESENT and not a boolean. So a list arriving here with every
         * `required` false is the vendor's own no on every row — never a shape this deployment
         * failed to read, because that shape never gets past the adapter.
         *
         * ON THE APP AND NOT ON THE SUBMISSION, AND THE SEEDED DEFAULT IS WHY. A guard that demanded
         * one non-blank value would be satisfied by the form's own work: the form draws each box
         * holding the default the app published and posts every published name back whether or not
         * anybody touched it, so a person who types nothing at an app publishing an optional
         * `base_url` submits that default — non-blank, unchosen, and a credential in no sense. The
         * thing that is false here is the app's field list, so the app is what is refused.
         *
         * ON THE SUBMISSION AND NOT ON THE PRESS ABOVE IT, for the empty-list guard's reason: the
         * list is a true answer to "what does this app ask for", and what is false is the account
         * the next press would make.
         *
         * THE SENTENCE NAMES THE BOXES THE APP DOES PUBLISH AND NO VALUE OF ANY KIND. These names
         * are the VENDOR's, read off the list just fetched rather than off the request, and they are
         * the whole of what an administrator needs to see what the app is publishing now. Nothing
         * submitted appears — not even a value that merely matches a published default, because on
         * this request that value is the caller's text rather than the vendor's.
         */
        if (published.every((field) => !field.required)) {
          const optional = published.map((field) => field.name).join(", ");
          return context.json(
            {
              error: `${row.title} marks nothing as required (only ${optional}), so no account was made. Ask an admin to remove it under Plugins and add it again.`,
            },
            400,
          );
        }

        /*
         * WHAT THE APP PUBLISHED, AND A NAME IT DID NOT IS REFUSED RATHER THAN QUIETLY DROPPED.
         *
         * ONE GUARD, THREE HOLES. What is submitted is spread into the field object the adapter
         * hands Composio, beside the literal `status: "ACTIVE"` that call sets — so an unfiltered
         * body lets a caller write over it. Anything else invented travels to the vendor
         * unexamined. And a field this deployment recorded that the app has stopped publishing
         * shows up here, at the request, rather than as a connection made without the value nobody
         * was asked for and a first tool call that discovers it.
         *
         * REFUSED, BECAUSE A PERSON CANNOT TYPE A NAME THE FORM DID NOT DRAW. The form is drawn
         * from this same list a moment earlier, so every name in an ordinary submission is one of
         * these; a name that is not leaves exactly two readings, and dropping it silently is the
         * wrong answer to both. If the app's published fields have moved, the person is holding a
         * stale form and the honest thing is to send them back for the current one — connecting
         * them with the part that still matches makes a credential-less account that every screen
         * here draws as connected. And if it is a caller reaching past the form on purpose,
         * "connected" is the one answer they must not get for a request this deployment edited
         * behind their back. Pressing Connect again costs a person one press and redraws the form
         * from what the app asks for now.
         *
         * THE VALUES ARE BUILT FROM THE NAMES THAT PASSED rather than the request object forwarded
         * once the check is done, so what reaches the store is the published subset by
         * construction and not on the strength of the loop above having run.
         *
         * A VALUE THAT IS NOT TEXT IS THE SAME REFUSAL. The store's signature promises strings, and
         * a number or an object under a published name is a lie told to that signature that reaches
         * Composio as whatever JSON makes of it.
         *
         * AND THE BAG HOLDS ONLY WHAT WAS PUT IN IT, WHICH `{}` DOES NOT. Every name here is the
         * VENDOR's — chosen by whoever publishes the app at Composio and never by this deployment —
         * and a plain object literal answers for names nobody submitted: `values.constructor` and
         * `values.toString` come back as functions off `Object.prototype`, so the required guard
         * below calls `.trim()` on a function and answers a person who typed nothing wrong with a
         * 500. A prototype value that happened to be TEXT would be worse still, because that guard
         * would count a credential nobody supplied and connect the account anyway. The other
         * direction fails silently: `values["__proto__"] = "acme"` on a literal reaches the
         * prototype setter, which ignores a string, so a value somebody typed is dropped between
         * the check that admitted it and the store that was meant to receive it — an account made
         * at Composio without one of the values the app publishes, marked `ACTIVE` because Composio
         * does not grade what it is handed, and drawn as connected on every screen here.
         *
         * A NULL-PROTOTYPE BAG IS THE WHOLE FIX AND IT IS THE SAME ONE THE FORM USES. Nothing is
         * inherited, so a read answers `undefined` exactly when nobody submitted that name and a
         * write stores what it was given under whatever name it was given. `Object.keys` — which is
         * what the audit row is built from one layer down — reads the same either way, and the
         * names are all this object's contents may ever appear as.
         */
        const names = new Set(published.map((field) => field.name));
        const values: Record<string, string> = Object.create(null);
        for (const [name, value] of Object.entries(submitted)) {
          if (!names.has(name) || typeof value !== "string") {
            /*
             * THE SENTENCE CARRIES NOTHING THAT WAS SUBMITTED — not the value, which is somebody's
             * own credential and belongs in no message, and not the name either, which on this
             * request is the caller's own text rather than the vendor's. It names the app and the
             * press that fixes it, which is the whole of what the person needs.
             */
            return context.json(
              {
                error: `That isn't the form ${row.title} asks for, so nothing was sent. Press Connect again and fill in the form it shows.`,
              },
              400,
            );
          }
          values[name] = value;
        }

        /*
         * AND WHAT THE APP SAID IT CANNOT DO WITHOUT HAS TO BE THERE, WHICH THE LOOP ABOVE NEVER
         * ASKED. That loop checks every name that ARRIVED; `required` is a fact about a name that
         * did not. A body of `{"values":{}}` passes it vacuously — no name is unpublished, no value
         * is not text — and what that connects is an account carrying no credential at all, which
         * Composio accepts because it does not grade what it is handed and which an app with
         * nothing safe to probe leaves recorded and drawn as connected.
         *
         * `required` HAD ONE READER AND IT WAS THE BROWSER. It rode the field out to the form and
         * became an HTML attribute, which is a courtesy to somebody filling boxes in and no kind of
         * guard: this route is reachable without that form, and the form itself accepts a space.
         *
         * BLANK IS ABSENT, AND WHITESPACE IS BLANK. The person's claim is that they filled the box
         * in, and a box holding spaces is one they did not — no vendor reads a key made of
         * whitespace, so admitting it buys exactly the account this guard exists to refuse, with a
         * value in it that makes the state harder to read rather than easier. The JUDGEMENT is made
         * on the trimmed text; what travels is what was typed, because trimming somebody's
         * credential on its way out is editing it, and a key that really does carry padding is the
         * vendor's to reject in its own words.
         *
         * OPTIONAL BOXES ARE UNTOUCHED BY THIS, and the distinction is the whole of why it reads
         * `required` rather than counting values. The form seeds each box from the default the app
         * published and posts every published name back whether or not anybody touched it, so a
         * blank optional value is what an ordinary submission carries.
         *
         * THE SENTENCE NAMES THE FIELDS AND NOTHING ELSE. These names are the VENDOR's, read off
         * the list this deployment just fetched rather than off the request — which is what sets
         * them apart from the refusal above, where the offending name is the caller's own text —
         * and no value of any kind appears here, for the reason the whole of this branch is built
         * around: a submitted value is somebody's own credential and belongs in no message, no log
         * and no row.
         */
        const missing = published
          .filter(
            (field) => field.required && !(values[field.name] ?? "").trim(),
          )
          .map((field) => field.name);
        if (missing.length > 0) {
          return context.json(
            {
              error: `${row.title} needs ${missing.join(", ")}, so nothing was sent. Fill in every required box and press Connect again.`,
            },
            400,
          );
        }

        try {
          /*
           * THE STORE'S ANSWER, WHOLE. `connected`, `verified` and `probe` are three facts and not
           * one dressed up: a null probe with `verified: false` is an app that publishes nothing
           * safe to check a key against, and a named probe with the same flag is a key the vendor
           * rejected on an account this deployment could not take back. A route that forwarded the
           * boolean alone would leave the row to infer which of those two it was, and it would tell
           * the second person that nothing had ever been tried.
           */
          return context.json(
            await store.connectBrokeredWithFields({
              toolkit,
              account,
              by: context.var.actor.id,
              values,
            }),
          );
        } catch (error) {
          /*
           * A REFUSAL THE STORE AUTHORED IS PASSED THROUGH AS ITSELF, BEFORE THE BROKER MAPPING.
           *
           * A mistyped key is the ordinary failure on this path — a token from the wrong workspace,
           * a key pasted with a newline — and the store's sentence for it already carries the
           * vendor's own words and the step to take. `brokerRefusal` cannot see that: a
           * {@link PluginRefusedError} is neither an authored broker refusal nor a vendor object,
           * so it would come back as "Composio said nothing about why", sending somebody whose key
           * was rejected to ask an administrator about this deployment's Composio key. 400 for the
           * reason the skills route gives its own refusal one: it is something the person who made
           * the request can fix, and the message says what to fix.
           */
          if (error instanceof PluginRefusedError) {
            return context.json({ error: error.message }, 400);
          }
          const refusal = brokerRefusal(
            error,
            `Couldn't connect ${row.title} with what you entered. Try again, or ask an admin if it keeps happening.`,
          );
          return context.json({ error: refusal.error }, refusal.status);
        }
      }

      /*
       * A SCHEME THIS DEPLOYMENT CANNOT READ IS REFUSED, AND IS NOT WALKED INTO THE CONSENT FLOW.
       *
       * `unreadable` is a null column or a literal nothing here writes — which is an ordinary row
       * rather than a corrupt one: `mcp_servers.url` carries no unique index, so the row that
       * answers for an app is not always the row an enable wrote a scheme onto, and a row may have
       * been inserted by hand or restored from a deployment that knew other names. Reached by
       * elimination, it arrived at the arm below and minted an authorization link at Composio for an
       * app this deployment holds no consent config for — a call spent at the vendor, and a link
       * whose only possible end is the person failing to complete it at a screen that has nothing
       * to ask them.
       *
       * THE REMEDY IS AN ADMINISTRATOR'S, because nothing the person pressing Connect can do
       * changes which scheme this deployment recorded for the app. Re-adding it is what writes the
       * column again, which is the same remedy the field branch above names for its own two
       * unreadable-app states. 400 rather than 503: it is a fact about this one app's row and not
       * about the deployment's settings.
       */
      if (kind === "unreadable") {
        return context.json(
          {
            error: `OpenBot can't tell how ${row.title} connects, so no account was made. Ask an admin to remove it under Plugins and add it again.`,
          },
          400,
        );
      }

      /*
       * NO APP URL IS A REFUSAL, NOT A LINK WITH NO WAY BACK.
       *
       * The address below is where Composio sends this person once they have consented, and it has
       * to be absolute: the consent screen is on another company's origin, so a relative path
       * resolves against theirs. A deployment that cannot say where its own pages are cannot
       * produce one — and minting the link anyway would leave somebody stranded on Composio's
       * hosted page having just granted access, with no route back to the deployment that asked
       * for it and nothing here knowing it happened.
       *
       * The OAuth flow below refuses for its missing `OPENBOT_PUBLIC_URL` in these same terms and
       * for this same reason. `OPENBOT_APP_URL` is the setting here because the two addresses are
       * genuinely different: the API is one origin and the browser app is another, and it is a
       * page this person is coming back to rather than an endpoint.
       *
       * BELOW BOTH BRANCHES ABOVE AND NOT IN FRONT OF THEM, FOR THE REASON THIS BRANCH'S OWN HEADER
       * GIVES ONE GUARD EARLIER. Neither an app whose secret the person types nor one that needs no
       * credential at all mints a link or has a return leg, so this setting has no bearing on either
       * flow — and standing before the fork, this guard meant no key app and no no-auth app could be
       * connected on a deployment without `OPENBOT_APP_URL`, refused in the name of a remedy that
       * would not have helped. It stays after the one-account guard for
       * the reason that guard's own comment gives: somebody who already has an account attached is
       * told the step to take, rather than handed an operator's configuration complaint about a
       * link that was never going to be minted for them.
       */
      if (!connect?.appUrl) {
        return context.json(
          {
            error:
              "Connecting apps isn't set up yet. Ask an admin to set OPENBOT_APP_URL.",
          },
          503,
        );
      }

      /*
       * WHERE THE CONSENT COMES BACK TO, BUILT HERE AND NEVER READ OFF THE REQUEST.
       *
       * Composio sends the person to this address when they are done, so whoever chooses it
       * chooses where somebody lands holding a just-completed consent. A url taken from the body,
       * the query or a header would therefore be an open redirect with a consent screen in front
       * of it — the exact thing {@link ConnectOrigin} exists to stop on the OAuth flow below, and
       * it is narrowed here in the same way: the caller may name one of two PAGES, and the origin
       * underneath them is this deployment's configured app URL in both cases.
       *
       * Both pages confirm on load, which is what makes either of them a correct destination: the
       * return trip carries nothing signed, so arriving proves nothing, and the page asks Composio
       * whether the account is really attached before anything here says it is.
       *
       * FORCED TO "admin" FOR A DEPLOYMENT ACCOUNT, AND NOT LEFT TO THE QUERY. A Shared app's
       * settings page shows nobody's own connection — the account the consent is about belongs to
       * the deployment — so "settings" would land an administrator who just granted it back on a
       * page with nothing of theirs to confirm. The admin screen is the one that reads a Shared
       * app's row, and it is where this consent began.
       */
      const returnTo: ConnectOrigin =
        account.holder === "deployment"
          ? "admin"
          : context.req.query("returnTo") === "admin"
            ? "admin"
            : "settings";

      /*
       * THE URL IS A BEARER CAPABILITY. Whoever opens it attaches an account to the connection
       * resolved above — this person's own for a Personal app, or the deployment's for a Shared
       * one — so it is answered to the browser that asked and to nothing else: not logged, not
       * audited, not put in an error body. A redirect url in a log line is somebody else's mailbox,
       * or the deployment's shared one, for as long as it stays valid — which is why the failure
       * below answers with the vendor's sentence and never with what was being minted when it
       * failed.
       */
      let redirectUrl: string;
      try {
        ({ redirectUrl } = await withVendorDeadline(() =>
          composio.broker.authorize({
            account,
            toolkit,
            /*
             * THE REFUSAL ABOVE CHECKS THAT A SETTING IS SET; THIS CHECKS THAT IT IS AN ADDRESS.
             * `appUrl` is an environment string — `OPENBOT_APP_URL`, or the first `TRUSTED_ORIGINS`
             * entry — and nothing between there and Composio has ever looked at it, so
             * `openbot.example.com` with the scheme left off builds a callback that is not a
             * callback. That failure lands after somebody has consented, on the vendor's page, where
             * this deployment cannot tell them anything; the guard moves it to before the link is
             * minted, where nobody has spent a consent on it yet.
             *
             * WHO IS READING DECIDES WHAT IS SAID, AND HERE THAT IS A PERSON. This route is
             * `requireUser`: whoever pressed Connect gets the refusal's own sentence, which names no
             * vendor and no variable because they can act on neither. The operator's half of it is
             * logged below instead, where an operator looks and a person does not.
             */
            returnUrl: brokerReturnUrl(
              connectedAccountsUrlFor(connect.appUrl, { serverId }, returnTo),
              activeProvider,
            ),
          }),
        ));
      } catch (error) {
        /*
         * THE VENDOR ALREADY HOLDS THIS ACCOUNT, AND THIS DEPLOYMENT HAS NO ROW FOR IT: RECORD IT,
         * DON'T REFUSE IT.
         *
         * The one-account guard above already refused wherever a row stands here, so this can
         * only be the other half of that rule: an account the vendor holds that this deployment
         * lost track of. A fresh or upgraded install meets it, and so does every local install in
         * single-user mode, because they all sign in as the same person against one vendor key.
         * Refused, the person read a sentence telling them to disconnect an account on a page
         * that drew the app as not connected and offered no Disconnect. Nothing they could press
         * would ever end it.
         *
         * WHAT IS DONE INSTEAD IS EXACTLY WHAT CONFIRM DOES, THROUGH THE SAME STORE CALL. The
         * vendor is asked whether this account is connected, and a yes writes the row and files
         * `mcp.account_connected` for it, once, as a confirm on page load would have. The account
         * is the one `brokeredAccountFor` resolved at the top of this branch and the actor is the
         * session's, so a Shared app's account is still only ever adopted by an administrator,
         * and nothing the request carries can name whose account is recorded.
         *
         * `{ connected: true }` IS THE STORE'S ANSWER, PASSED BACK WHOLE, which is the shape
         * confirm answers with and the one the browser already reads as connected. No link was
         * minted, so there is no url to hand back and nothing for the person to finish anywhere.
         *
         * A NO IS STILL A REFUSAL, AND IT SAYS WHAT HAPPENED. The vendor refused a second link
         * and then answered that it holds no active account, which is a race with somebody
         * ending it or a vendor that disagrees with itself. The row confirm deletes on a no was
         * never here, so the person is not sent to disconnect anything; asking again is the step
         * that settles it. 409, the status of the one-account guard above, because it is that
         * guard's conflict seen from the vendor's side.
         *
         * A CONFIRM THAT THROWS IS ANSWERED AS CONFIRM ANSWERS IT, with the vendor's or this
         * deployment's sentence and never with a guess about the account in either direction.
         *
         * ARCADE NEVER RAISES THIS CLASS, so this is a no-op there. Only Composio's adapter
         * translates a held account into it.
         */
        if (error instanceof BrokerAccountHeldError) {
          let confirmed: { connected: boolean };
          try {
            confirmed = await store.confirmBrokeredConnection({
              toolkit,
              account,
              by: context.var.actor.id,
            });
          } catch (confirmFailure) {
            const refusal = brokerRefusal(
              confirmFailure,
              `Couldn't check whether ${row.title} is already connected. Try again, or ask an admin if it keeps happening.`,
            );
            return context.json({ error: refusal.error }, refusal.status);
          }
          if (confirmed.connected) return context.json(confirmed);
          return context.json(
            {
              error: `OpenBot was told an account for ${row.title} is already connected, but found none when it checked. Nothing was connected. Press Connect again, or ask an admin if it keeps happening.`,
            },
            409,
          );
        }
        logReturnUrlRefusal(error, serverId);
        const refusal = brokerRefusal(
          error,
          `Couldn't start connecting ${row.title}. Try again, or ask an admin if it keeps happening.`,
        );
        return context.json({ error: refusal.error }, refusal.status);
      }
      return context.json({ authorizationUrl: redirectUrl });
    }

    if (!connect?.publicUrl) {
      return context.json(
        {
          error:
            "Connecting apps isn't set up yet. Ask an admin to set OPENBOT_PUBLIC_URL.",
        },
        503,
      );
    }

    const entry = catalogueEntry(serverId);
    if (entry?.auth.kind !== "user-oauth") {
      return context.json(
        { error: `${serverId} is not connected as an individual person.` },
        400,
      );
    }

    /*
     * A dynamic entry introduces the deployment itself on first use; a manual one still waits
     * for an administrator. Registration lives here, on the one handler that already refuses
     * without OPENBOT_PUBLIC_URL — the redirect URI it registers is guaranteed to exist.
     */
    /*
     * A vendor in the catalogue that nobody has added to this deployment reaches here, gets past
     * every check above — the entry is real — and then asks the store for a client it cannot have,
     * because there is no server row to hold one. `ensureOAuthClient` says so by throwing, and
     * unhandled that was a 500 on the one path where a person is trying to connect their account.
     *
     * The same 409 as a vendor whose client an administrator has not pasted in yet, because it is
     * the same situation: the person pressing Connect has no step to take, and an administrator has
     * one. The sentence names the step rather than the exception.
     */
    let client: OAuthClient | null;
    try {
      client =
        (await store.oauthClientFor(serverId)) ??
        (entry.auth.clientRegistration === "dynamic"
          ? await store.ensureOAuthClient(serverId, actorEmail(context))
          : null);
    } catch (error) {
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json(
          {
            error: `${entry.title} hasn't been added yet. Ask an admin to add it.`,
          },
          409,
        );
      }
      throw error;
    }
    if (!client) {
      if (entry.auth.clientRegistration === "dynamic") {
        return context.json(
          {
            error: `Couldn't set up ${entry.title}. Try again, or check ${entry.title}'s status if it keeps happening.`,
          },
          502,
        );
      }
      return context.json(
        {
          error: `${entry.title} isn't set up yet. Ask an admin to finish setting it up.`,
        },
        409,
      );
    }

    /*
     * Where to come back to, as one of two names rather than a URL the caller chose.
     *
     * Read from the query and narrowed immediately, so an unrecognised value is the default rather
     * than something carried into a sealed state. See {@link ConnectOrigin}: a destination that could
     * name another origin is an open redirect with a consent screen in front of it.
     */
    const returnTo =
      context.req.query("returnTo") === "admin" ? "admin" : "settings";

    const verifier = createVerifier();
    return context.json({
      authorizationUrl: authorizationUrlFor({
        auth: entry.auth,
        clientId: client.clientId,
        redirectUri: redirectUriFor(connect.publicUrl),
        state: await sealConnectState(
          { userId: context.var.actor.id, serverId, verifier, returnTo },
          connect.encryptionKey,
        ),
        codeChallenge: challengeFor(verifier),
      }),
    });
  });

  /**
   * Which app, and whose account in it, one of the four routes below is about, or the refusal that
   * ends it — decided by the row's mode and the signed-in person, never by anything in the request.
   *
   * Each of them acts on a brokered connection and on nothing else, so each asks the same questions
   * in the same order and answers them in the same words. It is one function because the sentence
   * somebody reads when they aim any of those routes at an ordinary OAuth row, or at a Shared app
   * they have no business touching, should not be able to drift into four sentences.
   *
   * THE APP COMES OFF THE ROW'S URL AND NEVER OFF ITS ID, for the reason the directory route and
   * the connect branch above both give: the url is where the transport reads which app a call is
   * against, and the id is a row name that happens to look similar.
   *
   * ONE ROW, BY ID, AND CONFIRM IS WHY. Both brokered account screens call that route from an
   * effect when they mount, so this read runs on every page load — and it used to be
   * `listServers`, which materialises every tool and every grant in the deployment to answer
   * whether one row is brokered.
   *
   * A ROW THAT IS NOT BROKERED IS REFUSED IN SO MANY WORDS. The id may well name a server this
   * deployment really has — what is wrong is that its connection does not live at Composio, and
   * there is nothing for either route to confirm or to end. `null` from `appOfUrl` also covers an
   * id naming no row at all, which is the same answer from the caller's side.
   *
   * NO BROKER IS A 503 NAMING THE SETTING, as it is on the directory and on connect, and it is
   * {@link BrokerUnconfiguredError}'s own message rather than a sentence written here.
   *
   * THE ACCOUNT ITSELF COMES FROM `store.accountRefFor`, WHICH READS THE ROW AND THE ACTOR AND
   * NEVER THE REQUEST. A Personal app answers with the actor's own identity; a Shared app answers
   * with the deployment's — one account, decided here, rather than whatever a caller could name in
   * a body. A Shared app's account belongs to the deployment and not to whoever is signed in, so an
   * actor who is not an administrator is refused here, once, instead of in four routes below.
   *
   * THE CONNECT ROUTE'S BROKERED BRANCH IS THE FOURTH, CALLED ONLY ONCE IT ALREADY KNOWS THE
   * BRANCH IS TAKEN. That route still asks `appOfUrl` itself before this function is ever reached
   * — a row that is not brokered has an OAuth flow below it to fall through to, and refusing it
   * here, where there is no such flow to fall through to, would be wrong. Once that question is
   * settled and the answer is yes, whose account the connection is for is exactly the question
   * this function exists to answer once, rather than a fourth place a Shared app's account could
   * be decided differently from the other three.
   */
  const brokeredAccountFor = async (
    context: { var: AppVariables },
    serverId: string,
    /**
     * `readOnly` is true for a question about the account's STATE, which anybody working with the
     * app benefits from, and false for every act done in it. It lifts exactly one refusal — the
     * administrator requirement on a Shared app's account — and nothing else: the account
     * resolved is the same one either way, so a reader is told about the identity calls use.
     */
    options: { readOnly?: boolean } = {},
  ): Promise<
    | {
        toolkit: string;
        account: AccountRef;
        title: string;
        refusal?: undefined;
      }
    | {
        toolkit?: undefined;
        account?: undefined;
        title?: undefined;
        refusal: { error: string; status: 400 | 403 | 503 };
      }
  > => {
    const row = await store.serverAddress(serverId);
    const toolkit = row ? appOfUrl(row.url) : null;
    if (!toolkit) {
      return {
        refusal: {
          error: "That app doesn't connect this way.",
          status: 400,
        },
      };
    }
    if (!composio) {
      return {
        refusal: {
          error: new BrokerUnconfiguredError(activeProvider, "person").message,
          status: 503,
        },
      };
    }
    const resolved = await store.accountRefFor(serverId, context.var.actor.id);
    if ("refusal" in resolved) {
      return { refusal: { error: resolved.refusal, status: 400 } };
    }
    if (
      !options.readOnly &&
      resolved.ref.holder === "deployment" &&
      context.var.actor.role !== "admin"
    ) {
      return {
        refusal: {
          error: "Only an admin can connect shared apps.",
          status: 403,
        },
      };
    }
    return { toolkit, account: resolved.ref, title: resolved.title };
  };

  /**
   * What the account behind this app holds, action by action: `{ actions: GrantState[] }`.
   *
   * A BOOLEAN WOULD NOT DO. An action can be blocked by consent, which Authorize moves, or by a
   * deployment secret an operator sets once for everybody, which no amount of consenting moves; and
   * a listing nobody could read is `unknown` rather than a pessimistic `needs-consent`, because
   * telling somebody to authorize what they already authorized sends them round twice. The states
   * are the broker's, passed through as it answered them.
   *
   * WHOSE IDENTITY IS ASKED ABOUT COMES FROM `brokeredAccountFor`: a Personal app's is the
   * viewer's, a Shared app's is the app's own `shared_vendor_user_id`. Asking about the viewer for
   * a Shared app would report a state no call ever uses.
   *
   * BEHIND `requireUser` AND NOT ADMIN-GATED: the status is a fact about the team's account that
   * anybody working with the app benefits from. Minting is the privileged act, and the authorize
   * route still refuses it with 403 through the same resolver.
   *
   * NO PRESENCE TEST ON THE BROKER AND NO REFUSAL PATH: every broker answers `grantsFor`, a
   * degenerate answer being a real one, so this works on both deployments. A throw from the broker
   * is answered as `unknown` carrying our own sentence, never the vendor's words, which could
   * carry a credential.
   */
  routes.get("/servers/:id/grants", requireUser, async (context) => {
    const resolved = await brokeredAccountFor(
      context,
      context.req.param("id"),
      { readOnly: true },
    );
    if (resolved.refusal) {
      return context.json(
        { error: resolved.refusal.error },
        resolved.refusal.status,
      );
    }
    const { toolkit, account } = resolved;
    // `composio` is non-null here: the resolver refuses 503 before it returns an account.
    const broker = composio?.broker;
    if (!broker) {
      return context.json(
        {
          error: new BrokerUnconfiguredError(activeProvider, "person").message,
        },
        503,
      );
    }
    let actions: GrantState[];
    try {
      actions = await withVendorDeadline(() =>
        broker.grantsFor({ toolkit, account }),
      );
    } catch {
      actions = [
        {
          action: toolkit,
          state: "unknown",
          reason:
            "Couldn't read what this account allows right now. Try again in a moment.",
        },
      ];
    }
    return context.json({ actions });
  });

  /**
   * Ask Composio whether this person's account is really attached, and write the answer down.
   *
   * THE ROUTE EXISTS SO THAT THE VENDOR IS ASKED. The return trip from a consent screen is an
   * ordinary redirect with nothing signed in it, so a browser landing back on the settings page
   * proves nothing: not that the flow finished, and not that it finished with the account a row
   * would go on to claim. Composio tells this deployment nothing by itself — there is no callback
   * of ours in that flow — so unless something asks, all that stands behind the gate every later
   * brokered call passes through is a guess about what a redirect meant.
   *
   * AND IT IS MEANT TO BE CALLED AGAIN, on any page load, which is the other half of why it is
   * here. The row is only a cache of the vendor's last answer, so it drifts by construction — an
   * account ended in Composio's own dashboard, a consent this deployment never saw finish — and
   * calling this heals it in whichever direction it went: written where the vendor says yes,
   * deleted where it says no. Repeating it files no trail rows and moves no timestamps; the store
   * is where that is settled.
   *
   * THE CONNECT ROUTE MAKES THE SAME CALL, for one case: the vendor refusing a new link because it
   * already holds this account. That is a drift this route would heal on the next page load, met
   * at the moment somebody pressed Connect, so it is healed there by the same store method rather
   * than by a second writer of the row.
   *
   * BEHIND `requireUser` AND NOT ADMIN-GATED AT THE ROUTE — `brokeredAccountFor` is where that
   * happens instead. A Personal app's confirm is not an administrative act, so the route itself
   * stays open to anybody signed in; a Shared app's is, and it is the resolver that tells the two
   * apart by the account it resolves rather than this route carrying `requireAdmin` unconditionally.
   */
  routes.post(
    "/servers/:id/connection/confirm",
    requireUser,
    async (context) => {
      const resolved = await brokeredAccountFor(
        context,
        context.req.param("id"),
      );
      if (resolved.refusal) {
        return context.json(
          { error: resolved.refusal.error },
          resolved.refusal.status,
        );
      }

      /*
       * WHOSE ACCOUNT THIS IS COMES FROM `brokeredAccountFor`, AND THERE IS NO SECOND SOURCE FOR IT.
       * Nothing here reads a user id out of the body or the query, and that is the property rather
       * than an implementation detail: a confirm writes the row every later brokered call is gated
       * on, so a caller who could name somebody else would be one POST away from recording a
       * connection under a person who never made one — or, the same defect turned around, from
       * deleting the row of a person the vendor answers no for. `by` is the session's actor, for the
       * trail, and is the same id for a Personal app's own account and an administrator confirming a
       * Shared app's.
       *
       * The store's answer is passed straight back rather than restated here. `connected` is what
       * Composio said, and a shape invented at this layer would be a second opinion about a fact
       * only the vendor holds.
       */
      try {
        return context.json(
          await store.confirmBrokeredConnection({
            toolkit: resolved.toolkit,
            account: resolved.account,
            by: context.var.actor.id,
          }),
        );
      } catch (error) {
        /*
         * A BROKER THAT WOULD NOT ANSWER IS NOT A CONNECTION THAT IS ABSENT.
         *
         * This route is called on every page load, so the tempting answer to a failure is
         * `{ connected: false }` — and that would be this deployment inventing a fact only Composio
         * holds, drawing "Not connected" over a live account and, one step on, deleting the row
         * that says otherwise. The store deletes on a NO from the vendor, and a failure is not a
         * no. So the page is told the ask failed, and what it goes on showing is the last answer
         * Composio gave rather than a guess about this one.
         */
        const refusal = brokerRefusal(
          error,
          "Couldn't check whether this account is connected. This shows the last answer. Try again, or ask an admin if it keeps happening.",
        );
        return context.json({ error: refusal.error }, refusal.status);
      }
    },
  );

  /**
   * Try this person's key against the app, because they pressed the button that asks.
   *
   * A BUTTON, AND NEVER A PAGE-LOAD EFFECT, which is the one thing a caller of this route has to
   * know. Composio never re-checks a key — it accepts one when it is typed and says nothing about it
   * again — so this is the only thing in the product that can correct a row whose key was rotated,
   * revoked or left to expire. That is also the argument somebody will make for calling it from an
   * effect on mount, and it is wrong: the call goes out to the app on the person's OWN account and
   * against their own rate limit at the vendor, so verifying on every render would spend somebody's
   * quota at Linear to redraw one word on a settings page. The confirm route above is the one that
   * runs on mount; it asks Composio about its own records and costs the person nothing.
   *
   * AND IT IS NOT A CONNECT. The store's argument is made there in full: the account already exists,
   * so nothing here creates one, nothing withdraws one when the key turns out to be bad — their
   * account stays, it is their key that is wrong — and nothing changes but the verification and its
   * date.
   *
   * A PROBE THAT RAN AND FAILED COMES BACK AS A FAILURE, never as a 200 saying `verified: false`.
   * That flag is also what an app publishing nothing safe to call produces, and the row drawing this
   * answer cannot tell the two apart — so an answer would quietly drop the Re-check button in
   * exactly the state somebody needs it, having just fixed their key, while telling them nothing had
   * ever been checked. The store raises with Composio's own sentence in it, and this passes that
   * through as a refusal the browser surfaces. The only `verified: false` that arrives as an answer
   * is the one carrying `probe: null`, which says there was nothing to check with.
   *
   * WHOSE ACCOUNT THIS IS COMES FROM `brokeredAccountFor`, as on the two routes around it and for
   * the sharper reason this one adds: an account a caller could name would let one POST spend a
   * stranger's rate limit at the vendor and rewrite the verification on their row. Nothing here
   * reads a user id out of the body or the query.
   *
   * BEHIND `requireUser` AND NOT ADMIN-GATED AT THE ROUTE, for confirm's reason: `brokeredAccountFor`
   * is where a Shared app's account is told apart from a Personal one's, and only the former needs
   * an administrator.
   */
  routes.post(
    "/servers/:id/connection/recheck",
    requireUser,
    async (context) => {
      const resolved = await brokeredAccountFor(
        context,
        context.req.param("id"),
      );
      if (resolved.refusal) {
        return context.json(
          { error: resolved.refusal.error },
          resolved.refusal.status,
        );
      }

      try {
        // The store's answer, whole. `verified` is the flag, `verifiedAt` is the date the row's
        // sentence is drawn from, and `probe` is what says a call was really made — three facts,
        // and a route that forwarded the boolean alone would leave the row to guess the other two.
        return context.json(
          await store.recheckBrokeredConnection({
            toolkit: resolved.toolkit,
            account: resolved.account,
            by: context.var.actor.id,
          }),
        );
      } catch (error) {
        /*
         * A REFUSAL THE STORE AUTHORED IS PASSED THROUGH AS ITSELF, BEFORE THE BROKER MAPPING, for
         * the reason the connect route's field branch gives: a key the vendor rejected is the
         * ordinary failure on this path, and the store's sentence for it already carries Composio's
         * own words and the step to take. `brokerRefusal` cannot see that — a
         * {@link PluginRefusedError} is neither an authored broker refusal nor a vendor object — so
         * it would answer somebody whose key is wrong with "Composio said nothing about why" and
         * send them to an administrator about this deployment's key. 400 because it is theirs to
         * fix and the message says what to fix.
         */
        if (error instanceof PluginRefusedError) {
          return context.json({ error: error.message }, 400);
        }
        /*
         * And a failure this deployment cannot explain says what is on the screen instead of
         * guessing. Nothing was written on the way out of the store here, so the row still carries
         * the last answer anybody earned rather than a verdict invented by a call that failed.
         */
        const refusal = brokerRefusal(
          error,
          "Couldn't check whether this connection still works. This shows the last check. Press Re-check again, or ask an admin if it keeps happening.",
        );
        return context.json({ error: refusal.error }, refusal.status);
      }
    },
  );

  /**
   * End this account — this person's own, or the deployment's for a Shared app — at the vendor
   * first and here after.
   *
   * The order is the store's and the argument for it is made there: the row is the only thing that
   * says which account this app held, so a delete that ran before the revoke could leave a live
   * grant on somebody's mailbox that nothing here can reach. What comes back is what was asked for
   * — `vendorRevocationRequested` false is a grant that was already gone — and it is passed through
   * rather than rewritten, because telling those two apart is the whole value of the field.
   *
   * `reason` IS "self" OR "admin" BECAUSE OF WHOSE ACCOUNT `brokeredAccountFor` RESOLVED, not
   * because of who is asking in general: a Personal app's account is always the actor's own, so it
   * ends as "self"; a Shared app's account is the deployment's, and only an administrator reaches
   * this route for one, so it ends as "admin". The other word the store takes is `person_removed`,
   * which belongs to an administrator offboarding somebody from the People screen, and
   * `mode_switched`, filed when an app moves between Personal and Shared. The trail tells these
   * apart by this word and by whether `by` and the account's own id differ.
   *
   * BEHIND `requireUser` AND NOT ADMIN-GATED AT THE ROUTE, for confirm's reason:
   * `brokeredAccountFor` is where a Shared app's account is told apart from a Personal one's and
   * refused to anybody but an administrator.
   */
  routes.delete("/servers/:id/connection", requireUser, async (context) => {
    const resolved = await brokeredAccountFor(context, context.req.param("id"));
    if (resolved.refusal) {
      return context.json(
        { error: resolved.refusal.error },
        resolved.refusal.status,
      );
    }

    /*
     * WHOSE ACCOUNT THIS IS COMES FROM `brokeredAccountFor`, here as on confirm and for a sharper
     * reason: an account a caller could name would be a DELETE that revokes somebody else's grant
     * at the vendor. `by` is read once, from `context.var.actor`, and is the acting administrator
     * for a Shared app's account rather than the account's own id — nothing in the body or the
     * query is looked at at all.
     */
    try {
      return context.json(
        await store.disconnectBrokered({
          toolkit: resolved.toolkit,
          account: resolved.account,
          by: context.var.actor.id,
          reason: resolved.account.holder === "deployment" ? "admin" : "self",
        }),
      );
    } catch (error) {
      /*
       * REPEATING IT IS THE RECOVERY, AND THE SENTENCE SAYS SO RATHER THAN GUESSING HOW FAR IT GOT.
       *
       * The revoke runs before anything here is deleted, which is what makes a second press safe:
       * whatever this failed at, the state it leaves is access dead or access untouched, never
       * access live with nothing here able to reach it. Claiming "nothing was changed" would be a
       * guess — a delete that succeeded and an audit write that did not is the same throw — and the
       * one thing a person needs is the button to press, not this deployment's theory of where it
       * stopped.
       */
      const refusal = brokerRefusal(
        error,
        "Couldn't disconnect this account. Press Disconnect again. It's safe to repeat. Ask an admin if it keeps happening.",
      );
      return context.json({ error: refusal.error }, refusal.status);
    }
  });

  /**
   * WHAT DISCONNECTING THIS APP WOULD END BESIDES IT, for the confirmation to show before the
   * press. Answers `{ siblings, unanswered }`: the other apps' toolkits, sorted, and how many apps
   * on the same vendor identity could not be asked about and so are left out (a count, never
   * names). It acts on nothing: no revoke, no delete, no audit row.
   *
   * THE SET IS THE STORE'S, KEYED ON THE PAIR `(vendor identity, auth provider)` AND NEVER ON THE
   * PROVIDER ALONE — see `siblingApps`. Nothing is derived here, so this route and the cascade
   * `DELETE /servers/:id/connection` runs cannot disagree about which apps are named. On Composio
   * an app is its own auth provider, so the answer is always empty.
   *
   * THE ACCOUNT COMES FROM `brokeredAccountFor`, exactly as on the DELETE it previews: the list is
   * about the account that press would end, so it is asked of the same resolution and is refused
   * to the same callers.
   */
  routes.get(
    "/servers/:id/connection/siblings",
    requireUser,
    async (context) => {
      const resolved = await brokeredAccountFor(
        context,
        context.req.param("id"),
      );
      if (resolved.refusal) {
        return context.json(
          { error: resolved.refusal.error },
          resolved.refusal.status,
        );
      }
      try {
        return context.json(
          await store.siblingApps({
            toolkit: resolved.toolkit,
            account: resolved.account,
          }),
        );
      } catch (error) {
        const refusal = brokerRefusal(
          error,
          "Couldn't work out which other apps share this connection. Try again.",
        );
        return context.json({ error: refusal.error }, refusal.status);
      }
    },
  );

  /**
   * Begin authorizing ONE ACTION of a brokered app, for a provider that grants action by action.
   * Answers `{ authorizationUrl }` and nothing else.
   *
   * ORDERING PRINCIPLE: EVERYTHING THAT CAN FAIL WITHOUT THE VENDOR RUNS BEFORE THE CLAIM; THE
   * CLAIM IS THE LAST THING BEFORE THE MINT. A bad `OPENBOT_APP_URL` must not leave a live attempt
   * with no mint behind it, and the mint runs after the insert so a mint can never exist without a
   * row to correlate it.
   *
   * THE CAPABILITY GATE IS FIRST, BEFORE `brokeredAccountFor` AND BEFORE ANYTHING IS WRITTEN. A
   * broker that declares no authorization flow cannot complete one, so claiming a row for it would
   * block the actor for the full attempt lifetime over a flow that was never possible; a gate after
   * the claim does not prevent that. It is a presence test on a declared capability and never a
   * vendor name. 503 and not 404 or 400: the route exists, so 404 would lie, and the request is not
   * what is wrong; 503 is this file's vocabulary for a capability this deployment does not have.
   *
   * `actorId` IS THE SESSION SUBJECT (`users.id`) AND NEVER A CREDENTIAL ACTOR: the verifier finds
   * the attempt from the returning browser's session.
   *
   * THE URL IS A BEARER CAPABILITY — answered to this browser and to nothing else. It is never
   * logged, audited or put in an error body. No `next_uri` is sent: the vendor refuses every value,
   * and the landing page comes from the attempt row instead.
   *
   * A FAILED MINT'S ATTEMPT is handled at the mint's `catch`. NOT HERE: cancelling one.
   */
  routes.post("/servers/:id/authorize", requireUser, async (context) => {
    const serverId = context.req.param("id");

    if (!composio) {
      return context.json(
        {
          error: new BrokerUnconfiguredError(activeProvider, "person").message,
        },
        503,
      );
    }
    const flow = composio.broker.authorizations;
    if (!flow) {
      return context.json(
        {
          error:
            "Apps here connect once, with Connect on the app's page. They aren't authorized one action at a time.",
        },
        503,
      );
    }

    const resolved = await brokeredAccountFor(context, serverId);
    if (resolved.refusal) {
      return context.json(
        { error: resolved.refusal.error },
        resolved.refusal.status,
      );
    }
    const { account, toolkit, title } = resolved;

    const body = await context.req.json().catch(() => null);
    const action =
      body && typeof body === "object" && "action" in body
        ? (body as { action: unknown }).action
        : undefined;
    // Exact `===` against the stored names: Arcade's are case-sensitive and never normalized.
    if (
      typeof action !== "string" ||
      !(await store.serverPublishesAction(serverId, action))
    ) {
      return context.json(
        { error: `${title} has no action by that name.` },
        400,
      );
    }

    if (!connect?.appUrl) {
      return context.json(
        {
          error:
            "Connecting apps isn't set up yet. Ask an admin to set OPENBOT_APP_URL.",
        },
        503,
      );
    }
    const returnTo: ConnectOrigin =
      context.req.query("returnTo") === "admin" ? "admin" : "settings";
    let returnUrl: string;
    try {
      returnUrl = brokerReturnUrl(
        connectedAccountsUrlFor(connect.appUrl, { serverId }, returnTo),
        activeProvider,
      );
    } catch (error) {
      logReturnUrlRefusal(error, serverId);
      const refusal = brokerRefusal(
        error,
        "Couldn't build the address to bring you back to, so nothing was started.",
      );
      return context.json({ error: refusal.error }, refusal.status);
    }

    const claim = await store.claimAuthorizationAttempt({
      actorId: context.var.actor.id,
      serverId,
      action,
      account,
    });
    if (!claim.claimed) {
      return context.json(
        {
          error: claim.live
            ? `An authorization for ${claim.live.action} is already in progress. Finish it, or wait for it to expire, before starting another.`
            : "An authorization is already in progress. Finish it, or wait for it to expire, before starting another.",
        },
        409,
      );
    }

    let minted: Awaited<ReturnType<typeof composio.broker.authorize>>;
    try {
      minted = await withVendorDeadline(() =>
        composio.broker.authorize({
          account,
          toolkit,
          action,
          returnUrl,
        }),
      );
    } catch (error) {
      /*
       * WHAT A FAILED MINT DOES TO ITS ATTEMPT. THREE OUTCOMES, KEYED ON WHAT WAS ANSWERED.
       *
       * DEFINITE: the broker refused before asking (an authored `BrokerRefusalError`), or the
       * vendor ANSWERED with an HTTP status. Nothing is live upstream, so the attempt is discarded
       * and the actor is free to try again. Matched on `(actor_id, created_at)`, never `auth_id`: an
       * attempt whose mint never completed has none, and `created_at` is what stops a late cleanup
       * from deleting a NEWER attempt by the same actor.
       *
       * UNCERTAIN, AND THE ATTEMPT IS LEFT STANDING: `status === undefined` on a normalized SDK
       * error. `APIConnectionError` and `APIUserAbortError` EXTEND `APIError`, so the normalizer
       * answers `{ status: undefined, ... }` for them, NOT `null`; a dropped connection or an
       * aborted socket means Arcade may well have created a flow. Keying this on `null` would class
       * a timeout as a refusal and delete an attempt whose flow may be live, which frees the actor
       * to start a second flow beside it. An attempt holding a null `auth_id` can never complete,
       * so leaving it to expire is safe, and it is the point.
       *
       * THE NORMALIZER ANSWERING `null` IS UNCERTAIN TOO. That is "not an SDK error at all", and
       * the adapter throws exactly such an `Error` ("Arcade answered an authorization with no id.")
       * for a mint that answered SUCCESSFULLY without an `ar_...`: Arcade very likely did create a
       * flow. Do not tidy this case into the definite branch.
       *
       * AND {@link VendorTimeoutError} LANDS IN THAT SAME UNCERTAIN BRANCH, which is why the mint's
       * deadline is safe to add: it is neither authored nor an SDK error, so it is read as "we
       * stopped waiting and do not know", the attempt is left standing, and a flow the vendor may
       * have created behind the deadline is not orphaned beside a second one.
       *
       * NOTHING FROM THE VENDOR'S ANSWER IS LOGGED, AUDITED OR RETURNED: its body can carry the
       * authorization url, a bearer capability.
       */
      const authored = brokerSentence(error) !== null;
      const failure = normalizeArcadeError(error);
      const definite =
        authored || (failure !== null && failure.status !== undefined);
      if (definite) {
        /*
         * THE CLEAN-UP IS GUARDED, FOR THE SAME REASON THE RECORD-FAILURE CLEAN-UP BELOW IS.
         *
         * This discard is a tidy-up for a refusal the handler has ALREADY WORKED OUT — which vendor
         * sentence to pass on, and whether it is a 502 or an authored 503. Unguarded, a fault on the
         * delete threw past the handler and the person got a BODYLESS 500 instead: the least
         * informative answer possible, in exactly the case where this route had something specific
         * and true to tell them, and the failure of a clean-up destroyed the error it was cleaning
         * up after. The refusal is the answer; whether the row went with it is not the person's
         * problem to be given a blank page over.
         *
         * WHAT A FAILED DISCARD COSTS THEM IS SAID RATHER THAN GUESSED AT. The attempt stands with a
         * null `auth_id`, so it can never complete and `claimAuthorizationAttempt` refuses a second
         * start until it is fifteen minutes old — which makes the generic sentence's "try again in a
         * moment" false. The extra clause is the same one the record-failure branch answers with for
         * the same condition, and it is added rather than substituted: the vendor's own sentence is
         * the half that says WHY, and it is not thrown away to make room for ours.
         *
         * The error is read through {@link reasonWithoutStatement}, as every database failure logged
         * on this route is: a `DrizzleQueryError`'s own message is the statement and every value
         * bound to it.
         */
        let freed = false;
        try {
          freed = await store.discardAuthorizationAttempt({
            actorId: context.var.actor.id,
            createdAt: claim.attempt.createdAt,
          });
        } catch (cleanup) {
          console.error(
            JSON.stringify({
              type: "arcade-refused-attempt-not-cleared",
              server: serverId,
              action,
              note: "A mint was refused and its attempt could not be deleted. The person was told why the vendor refused, and the row holds them until it expires.",
              error: reasonWithoutStatement(cleanup),
            }),
          );
          freed = false;
        }
        const refusal = brokerRefusal(
          error,
          "The app refused to start that authorization. Try again in a moment.",
        );
        return context.json(
          {
            error: freed
              ? refusal.error
              : `${refusal.error} This attempt expires within fifteen minutes. You can start over after that.`,
          },
          refusal.status,
        );
      }
      /*
       * THE UNCERTAIN MINT: THE CLAIM STANDS, AND IT DOES NOT STAND IN SILENCE.
       *
       * WHY THE CLAIM STANDS. Nobody can read the vendor's answer here, so nobody knows whether a
       * flow exists at the vendor. Ending the attempt on that guess is the irreversible mistake in
       * one direction: a deleted claim frees this actor to start a second flow beside one that may
       * be live. A settled verdict is no better: `closeAuthorizationAttempt` matches on `auth_id`,
       * which is NULL here, so there is no verdict this row could take, and a settled row frees the
       * actor just as a deleted one does. Left standing with a NULL `auth_id`, the row can never
       * complete and holds the actor until it is fifteen minutes old. That cost is bounded. A
       * second live flow is not.
       *
       * WHY IT IS NOT LEFT SILENT. Before this line the branch wrote nothing anywhere. The row says
       * "a claim with no mint", which is also what a mint still in flight looks like. The person got
       * a 502 sentence and the deployment kept no trace. So a flow this deployment may have
       * started, and will never see completed, was invisible to everybody who could end it. This
       * is B6a's shape one seam earlier: `arcade-context-withdrawal-unknown` is the same unknown
       * on the revoke, and it is answered the same way.
       *
       * WHAT AN OPERATOR CAN NOW SEE, AND DO WITH IT. One line, `arcade-mint-outcome-unknown`,
       * naming the server, the action and `attemptStartedAt`. The attempt row is
       * `pending_authorizations` at that `(server_id, action, created_at)`, holding NULL `auth_id`.
       * The vendor-side flow, if one exists, is a pending authorization for this action on this
       * account started at that instant. Nobody was given its url, so nobody can complete it. An
       * operator who needs it gone ends it at the vendor; otherwise it lapses there and the claim
       * lapses here. A run of these lines is the vendor not answering, not one person's problem.
       *
       * WHAT IS NOT IN THE LINE. No authorization id: none was read, and that is the point. No
       * redirect url, the bearer capability; on the "answered with no id" path it existed and was
       * dropped inside the adapter. No account or vendor user id, as on every sibling line. The
       * reason goes through {@link reasonWithoutStatement}. Every error that reaches this branch
       * carries this deployment's own sentence: `ArcadeFailureError` drops the vendor's prose by
       * construction, the adapter's own refusals are ours, and {@link VendorTimeoutError} is ours.
       *
       * NOT AN AUDIT ROW. Nothing here writes to `pending_authorizations`, and the attempt's
       * missing trail rows are tracked in https://github.com/CopilotKit/OpenBot/issues/876, under
       * the claim and the expiry overwrite (B5e). Filing an event for this one branch while the
       * claim it follows files none would put half a lifecycle on the trail.
       */
      console.error(
        JSON.stringify({
          type: "arcade-mint-outcome-unknown",
          server: serverId,
          action,
          attemptStartedAt: claim.attempt.createdAt,
          note: "The vendor did not answer an authorization clearly, so whether it started a flow is unknown. The attempt was left standing with no authorization id: it cannot complete, it holds this person until it is fifteen minutes old, and nobody was sent to a consent screen. If the vendor shows a pending authorization for this action begun at attemptStartedAt, nobody here can finish it; end it there if it must not linger.",
          error: reasonWithoutStatement(error),
        }),
      );
      /*
       * L4a-b: THE SENTENCE NAMED A STEP THIS BRANCH MAKES IMPOSSIBLE.
       *
       * It used to end "finish it if you were sent to a consent screen" — and the line logged
       * immediately above says, of the very same branch, that NOBODY WAS SENT TO ONE. Both cannot
       * be true, and the log is the one that is: this branch is reached when the MINT did not
       * answer clearly, so there is no authorization url to hand back and the browser never left
       * this page. An instruction nobody can follow is worse than no instruction — somebody goes
       * looking through their tabs and their mail for a consent screen that was never opened, and
       * concludes they lost it.
       *
       * WHAT REPLACES IT IS WHAT THEY CAN ACTUALLY DO, in the register the two sibling refusals on
       * this route already use for the same predicament (the uncertain-mint and unrecorded-mint
       * sentences below): nothing opened, nothing connected, whether a flow started at the vendor
       * is unknown, one that did cannot be finished from here, and the wait is bounded and named.
       *
       * THE WAIT IS NOT A SUGGESTION AND IS NOT DROPPED. The attempt is deliberately left standing
       * precisely because a flow MAY be live, so "cancel it and start again" would be the wrong
       * advice however much friendlier it reads — it is the hold that keeps a second authorization
       * from being minted beside a first nobody can see.
       */
      return context.json(
        {
          error:
            "The app didn't answer clearly, so nobody was sent to a consent screen and nothing was connected. This attempt expires within fifteen minutes. You can start over after that.",
        },
        502,
      );
    }
    // A null id is recorded as NULL: an attempt holding none can never complete and simply expires.
    let bound: boolean;
    try {
      bound = await store.recordAuthorizationMint({
        actorId: context.var.actor.id,
        createdAt: claim.attempt.createdAt,
        authId: minted.authorizationId,
      });
    } catch (error) {
      /*
       * THE ONE WRITE ON THIS ROUTE THAT RUNS AFTER SOMETHING IRREVERSIBLE, AND IT USED TO BE THE
       * ONLY CALL HERE WITH NO GUARD AT ALL.
       *
       * The mint SUCCEEDED: a flow is live at the vendor. Unhandled, a transient fault on this one
       * local UPDATE — a statement timeout, a pool exhausted, a failover — threw past the handler
       * into a BODYLESS 500, and left the claim standing with a NULL `auth_id`. That row is the
       * worst of both halves. It can never complete, because the return leg matches the attempt on
       * `auth_id` and a null matches no `flow_id` the browser can bring back; and it still HOLDS
       * THE ACTOR, because `claimAuthorizationAttempt` refuses a second start until the row is
       * fifteen minutes old. So one local hiccup turned a successful authorization into a person
       * locked out of retrying, told nothing, with a live flow at Arcade that this deployment has
       * no record of.
       *
       * THE ATTEMPT IS DISCARDED RATHER THAN LEFT TO EXPIRE, and this is NOT the uncertain-mint
       * branch above turned around. There, the row is left standing because it may yet be the
       * record of a live flow and deleting it would free the actor to run a second flow beside one
       * that could still complete. Here the row provably records NOTHING: the id that would let it
       * complete is exactly the value that failed to be written. Keeping it buys no safety and
       * costs the person a quarter of an hour of refusals. Matched on `(actor_id, created_at)`, so
       * a slow arrival here can never delete a newer attempt, and wrapped in its own `try` because
       * the fault that broke the write above is likely to break this one too — a failed cleanup
       * must not replace this refusal with the bodyless 500 it exists to prevent.
       *
       * AND THE MINT IS NOT LOST. The console line is what is left to carry it once the database
       * has refused the row, and it holds the `ar_...` the vendor answered — the plain-text value
       * this route was about to store — so an operator can find that flow at the vendor and end it.
       * THE REDIRECT URL IS NOT LOGGED AND NEVER WILL BE: that is the bearer capability, and
       * whoever opens it attaches the account. The error goes through
       * {@link reasonWithoutStatement} for the reason `oauth-connection-not-recorded` gives: a
       * `DrizzleQueryError`'s own message is the statement and every value bound to it.
       */
      let freed = false;
      try {
        freed = await store.discardAuthorizationAttempt({
          actorId: context.var.actor.id,
          createdAt: claim.attempt.createdAt,
        });
      } catch {
        freed = false;
      }
      console.error(
        JSON.stringify({
          type: "arcade-mint-not-recorded",
          server: serverId,
          action,
          authorizationId: minted.authorizationId,
          attemptCleared: freed,
          note: "An authorization was minted at the vendor and could not be written to its attempt. The person was told, was not sent to the consent screen, and the flow named here is live at the vendor with nothing here recording it.",
          error: reasonWithoutStatement(error),
        }),
      );
      return context.json(
        {
          error: freed
            ? "The app started that authorization, but OpenBot couldn't record it, so nothing was connected. Press Authorize again. It's safe to start over."
            : "The app started that authorization, but OpenBot couldn't record it, so nothing was connected. This attempt expires within fifteen minutes. You can start over after that.",
        },
        500,
      );
    }
    if (!bound) {
      /*
       * THE MINT WROTE NOTHING, SO THE CONSENT URL IS NOT HANDED OUT.
       *
       * `recordAuthorizationMint` answers false when no unminted, unsettled attempt stands under
       * `(actor_id, created_at)`. On this route that is a cancel that landed while the vendor was
       * minting: `DELETE /servers/:id/authorize` discarded the attempt (and filed
       * `mcp.authorization_cancelled` for it), and only then did the vendor answer. The url it
       * answered is a bearer capability for a flow with NO ATTEMPT BEHIND IT. Handing it out sent
       * the person to grant access at the vendor against a record that does not exist, and the
       * return leg then refused that consent as `no-attempt`, after the grant had been made. The
       * person asked for nothing to be started, so nothing is.
       *
       * 409, THE STATUS THE CANCEL ROUTE ANSWERS WHEN IT AND A COMPLETION CROSS, because this is
       * that kind of race seen from the other request: two acts on one attempt, and the one that
       * lost is told so in an error a client cannot mistake for a url to follow. Nothing is
       * discarded here: false means no attempt of this request's is left to discard, and a newer
       * or settled row by the same actor is not this request's to touch.
       *
       * NOTHING IS LOGGED. The flow at the vendor is unreachable: its url was given to nobody and
       * is written nowhere, so it expires there. The person's cancel is already on the trail.
       * Neither the url nor the `ar_...` reaches this body.
       */
      return context.json(
        {
          error:
            "That authorization was cancelled before it started, so nothing was connected. Press Authorize to start again.",
        },
        409,
      );
    }
    return context.json({ authorizationUrl: minted.redirectUrl });
  });

  /**
   * Cancel THIS actor's authorization attempt, so somebody who closed the consent tab need not wait
   * out the fifteen-minute TTL. Answers `{ cancelled }`: whether an attempt was removed.
   *
   * CANCELLING WHEN NO ATTEMPT EXISTS IS NOT AN ERROR — the attempt may have expired, failed or
   * been cancelled already, and the person's intent (nothing in flight, nothing connected) is met.
   *
   * A CONSENT THAT COMPLETED UNDER THE CANCEL IS THE ONE CASE WHERE THAT INTENT IS NOT MET, AND IT
   * IS ANSWERED 409 RATHER THAN `{ cancelled: true }` OR `{ cancelled: false }`. The attempt is read
   * and then discarded, and a completion can commit between the two. `discardAuthorizationAttempt`
   * refuses a settled row, so the record of that consent survives; but the account IS connected
   * now, and neither boolean says so — `true` would be a lie and `false` reads as "there was nothing
   * to cancel". The person asked for nothing to be connected and something was, so they are told
   * which, in an error a client cannot mistake for success, and pointed at the one thing that undoes
   * it: disconnecting. Any other settled outcome (failed, unreconciled, withdrawn) connected nothing,
   * so it is the ordinary `{ cancelled: false }`.
   *
   * MATCHED ON `(actor_id, created_at)`, NEVER ON `auth_id`: an attempt whose mint never completed
   * has no `auth_id` and is exactly the one most worth cancelling, and `created_at` is what stops
   * this from deleting a NEWER attempt by the same actor that replaced the one resolved here. It
   * goes through `discardAuthorizationAttempt`, the same deletion the mint's definite-failure
   * discard uses.
   *
   * `actorId` IS THE SESSION SUBJECT (`users.id`), NEVER A CREDENTIAL ACTOR. BEHIND `requireUser`
   * AND NOT ADMIN-GATED AT THE ROUTE, as the disconnect route above: `brokeredAccountFor` is where
   * a Shared app is refused to anybody but an administrator.
   *
   * THE ATTEMPT IS RESOLVED BEFORE THE APP IS, AND THAT ORDER IS THE WHOLE POINT. Cancelling is an
   * operation on the ATTEMPT ROW, and this route reads NOTHING off `brokeredAccountFor`'s success
   * branch — not the toolkit, not the account, not the title. The deletion is keyed
   * `(actor_id, created_at)` off the row itself. So resolving the app first bought no fact this
   * route uses and cost the one case that needs cancelling most: AN ATTEMPT OUTLIVES ITS APP. Once
   * an administrator removes the row, `brokeredAccountFor` answers `appOfUrl(null)` → "That app is
   * not reached through a broker", 400, and a person holding a live pending authorization on an app
   * that is gone could never retract it — while `claimAuthorizationAttempt` went on refusing them a
   * new one for the full fifteen minutes. A not-found about the app, in answer to a request about
   * their own attempt.
   *
   * DROPPING THE GATE FOR THAT CASE GIVES NOBODY ANYTHING THEY DID NOT ALREADY HAVE. The row
   * reached here is the signed-in person's OWN attempt, by the only key the table has, and the act
   * is its deletion; the administrator requirement on a Shared app guards that app's deployment
   * account, which this route never touches. The one actor it newly admits is somebody whose
   * authority changed while their own consent was in flight — and letting them retract what they
   * started is the right answer, not a hole.
   *
   * THE REFUSALS SURVIVE WHERE THEY STILL MEAN SOMETHING, which is the branch with nothing of this
   * actor's to cancel. A DELETE aimed at an ordinary OAuth row, or at no row at all, is then still
   * told so in the words every sibling route uses, rather than being flattened into a cheerful
   * `{ cancelled: false }` that claims the request was understood.
   *
   * AND IT CANCELS THE ATTEMPT THE PATH NAMES, NEVER MERELY "WHATEVER THIS ACTOR IS HOLDING". The
   * attempt key is the actor alone, so the lookup can only answer that one row — but the request
   * names an app, and an attempt standing on a DIFFERENT app is not the thing being cancelled.
   * Deleting it anyway killed an in-flight consent begun from another screen and answered
   * `{ cancelled: true }` as though it had done what was asked, which is the same broken
   * correlation the mint/claim/complete path exists to hold from the other end. A standing attempt
   * on another app is therefore the `{ cancelled: false }` of "no attempt for THIS app", which is
   * the same answer, and the same non-error, as there being no attempt at all.
   *
   * THE SERVER IS COMPARED AGAINST THE RAW PATH PARAMETER, which is exactly what
   * `POST /servers/:id/authorize` writes into `server_id` when it claims the row. Comparing against
   * anything derived — the toolkit, the resolved title — would be two spellings of one fact and a
   * place for them to drift apart.
   */
  routes.delete("/servers/:id/authorize", requireUser, async (context) => {
    const serverId = context.req.param("id");
    const actorId = context.var.actor.id;
    const attempt = await store.authorizationAttemptFor(actorId);
    if (attempt && attempt.serverId === serverId) {
      const cancelled = await store.discardAuthorizationAttempt({
        actorId,
        createdAt: attempt.createdAt,
      });
      /*
       * A RETRACTION IS ON THE TRAIL, AND ONLY ONE THAT HAPPENED. The person withdrawing their own
       * pending consent is the other deliberate ending of this lifecycle besides completing it, and
       * it is filed for the same reason `mcp.account_connected` is. Only when the deletion removed
       * a row: a cancel that lost a race to a newer attempt removed nothing and withdrew nothing.
       * After the deletion and not around it, as the disconnect route files its row, so a failed
       * audit write fails the request rather than passing silently.
       */
      if (cancelled) {
        await store.recordAuthorizationCancelled({ actorId, attempt });
      } else if (
        /*
         * AND A CANCEL THAT LOST TO THE COMPLETION SAYS SO. The discard refuses a settled attempt,
         * so `cancelled` is false here for two different reasons; only one of them is "nothing was
         * standing". Answering `{ cancelled: false }` to a person whose consent completed would
         * leave them believing they had retracted an account that is now connected.
         */
        (await store.settledAuthorizationOutcome({
          actorId,
          createdAt: attempt.createdAt,
        })) === "completed"
      ) {
        return context.json(
          {
            error:
              "That authorization finished before it could be cancelled, so the account is connected. Disconnect it if you didn't mean to connect it.",
          },
          409,
        );
      }
      return context.json({ cancelled });
    }
    const resolved = await brokeredAccountFor(context, serverId);
    if (resolved.refusal) {
      return context.json(
        { error: resolved.refusal.error },
        resolved.refusal.status,
      );
    }
    return context.json({ cancelled: false });
  });

  /**
   * Where a person's BROWSER lands after a brokered per-action consent: the verifier.
   *
   * THIS ROUTE BREAKS THIS FILE'S JSON/401 CONVENTION DELIBERATELY, AND THE REASON IS WRITTEN HERE
   * SO NOBODY "FIXES" IT TO MATCH ITS NEIGHBOURS. Every other route in this file answers `fetch`
   * from OpenBot's own pages, so JSON is what the caller can read and 401 is what an unauthenticated
   * one deserves. Here the caller is a PERSON'S BROWSER, arriving on a top-level navigation from the
   * broker's own screen with a just-completed consent behind it — so an unauthenticated arrival is
   * sent to sign-in with a 303 and a `Location` CARRYING ITS `flow_id`, never answered 401. A 401
   * here is somebody who has just granted a third party access to their mailbox being shown a raw
   * error object on an API origin that serves no pages.
   *
   * WHICH IS WHY `requireUser` IS RUN BY HAND RATHER THAN MOUNTED IN FRONT OF THE HANDLER. The guard
   * answers 401 JSON, and the whole point of this route is that it must not. It is still the same
   * guard — the session is read, the role is resolved and `actor` is set by it, so nothing here
   * re-implements authentication — and only its REFUSAL is translated into the redirect. The
   * composition is the one `admin/gate.ts` already uses: call it with a `next` that records that it
   * ran.
   *
   * SIGNING BACK IN AS THE SAME PERSON THEN COMPLETES NORMALLY, because the attempt is keyed on the
   * signed-in person. Signing in as somebody else finds no attempt and refuses, which is correct and
   * occasionally annoying.
   *
   * CRITERION: NO REQUEST TO THIS ENDPOINT ENDS WITHOUT A `Location`, WITH ONE STATED EXCEPTION.
   * That is the criterion `/oauth/callback` below already holds itself to in as many words, and this
   * is the file's second browser-navigation return leg — so a refusal here ends the same way that
   * one does: back at the connected-accounts LIST, with a word about what happened and nothing
   * written. The reason travels as an opaque code on `?authorized=`
   * ({@link AUTHORIZATION_REFUSALS}); the sentence belongs to the app, which is the only place it is
   * written down. THE LIST AND NOT AN APP PAGE, uniformly: three of the refusals have no attempt row
   * to build an app address from, and {@link connectedAccountsUrlFor} already argues that picking
   * one would be a guess about what somebody had been doing.
   *
   * THE EXCEPTION IS THE 403, AND IT IS STATED RATHER THAN INHERITED. The guard that refuses a
   * session with no role is the same guard `/api/me` answers from, so such a session cannot reliably
   * load the landing page either — it is sent to `/sign` or into an error boundary, which is the
   * dead end that branch exists to avoid. It keeps its JSON body.
   */
  routes.get("/arcade/verify", async (context) => {
    /**
     * Where a refusal lands, which is the LIST screen with the reason beside it.
     *
     * Built from {@link connectedAccountsUrlFor}'s failure address with its query dropped, so the
     * one place that knows how to address the app's origin stays the one place that knows — and so
     * that `?connected=failed`, which belongs to the Composio callback, is NOT carried along beside
     * `?authorized=` and drawn as a second notice about something that did not happen.
     */
    const refusedWith = (reason: AuthorizationRefusal) => {
      const [screen] = connectedAccountsUrlFor(connect?.appUrl, {
        failed: true,
      }).split("?");
      return context.redirect(`${screen}?authorized=${reason}`, 303);
    };

    /*
     * Read, not yet judged. The redirect below has to carry it, and that redirect happens before
     * the value is validated — reading a query string calls nobody and writes nothing.
     */
    const flowId = (context.req.query("flow_id") ?? "").trim();

    /**
     * WHETHER THE COMPLETION TRANSACTION IS KNOWN TO HAVE COMMITTED, and the one thing the two
     * `catch`es below have to agree about. Declared out here, ahead of the `try`, because the
     * blanket `catch` has to be able to tell a throw over a live, recorded grant from a throw over
     * nothing at all — which is the distinction it used to answer `not-recorded` for both halves
     * of. Set in exactly one place: the completion's own `catch` below.
     */
    let recorded = false;

    /*
     * EVERYTHING FROM HERE IS IN ONE `try`, FOR THE REASON `/oauth/callback` BELOW GIVES FOR ITS
     * OWN: so it is the whole body rather than each call. A blanket `catch` is a promise about the
     * route; a per-call one is a promise about the calls somebody remembered. The criterion is
     * that no request to this endpoint ends without a `Location`, and a call that throws would
     * otherwise put somebody who has just consented at another company on a bodyless 500 — there
     * is no `app.onError` on this app to turn that into anything else, and this is an origin that
     * serves no pages.
     *
     * IT OPENS HERE AND NOT AT THE COMPLETION, which is where it used to open and where it was a
     * promise about the calls somebody remembered. Two awaited reads happen first and both reach a
     * store: `requireUser` reads the session and then this actor's roles, and
     * `authorizationAttemptFor` is the one query on the happy path. A database blip or an
     * exhausted pool during the attempt read is the ordinary way to reach either.
     *
     * THE STATED EXCEPTION IS UNTOUCHED BY THIS. The 403 for a session with no role RETURNS, and a
     * `catch` sees throws and not returns, so it keeps its JSON body.
     *
     * The inner `try`s below take the vendor's throws first, so no refusal code changes here. AND
     * THE COMPLETION NOW HAS ONE OF ITS OWN, which is not a hedge against this `catch` but the
     * thing this `catch` cannot do: it is the only step on this leg that can leave a grant RECORDED
     * on the way out, so it is the only one that can say whether `not-recorded` is true. See it.
     */
    try {
      let signedIn = false;
      const refusal = await requireUser(context, async () => {
        signedIn = true;
      });
      if (!signedIn) {
        /*
         * ONLY A MISSING SESSION GOES TO SIGN-IN. The guard also refuses 403 for a session with no
         * role, and sending that person to sign-in is a dead end: the sign-in screen's own load hits
         * the same guard, gets the same 403, and they sign in as themselves again with nothing
         * changed and never told their access was removed.
         */
        if (refusal instanceof Response && refusal.status === 401) {
          return context.redirect(signInUrlFor(connect?.appUrl, flowId), 303);
        }
        return context.json(
          {
            error:
              "OpenBot doesn't recognise you anymore, so nothing was recorded. Ask an admin to restore your access, then authorize again from the app's page.",
          },
          403,
        );
      }

      /*
       * THE CAPABILITY GATE, AND IT IS A PRESENCE TEST ON A VALUE THE BROKER DECLARED. Never a
       * `provider === "arcade"` comparison: see {@link ConnectedAppBroker.authorizations}, and
       * `store.ts`'s gate comment, which records a defect where a gate and its exemption keyed on
       * different things and the exemption failed OPEN. A deployment whose broker runs no correlated
       * authorization flow has no return leg for this route to verify.
       */
      if (!composio) return refusedWith("no-broker");
      const flow = composio.broker.authorizations;
      if (!flow) return refusedWith("not-supported");

      /*
       * A HANDLE THIS DEPLOYMENT CANNOT USE IS REFUSED WITHOUT ASKING THE VENDOR ANYTHING. Empty,
       * missing or whitespace-only are one fact — the browser arrived without the one thing the
       * return leg carries — and spending a vendor call on it would be an unauthenticated-shaped
       * request reaching another company's API.
       */
      if (!flowId) return refusedWith("missing-handle");

      /*
       * THE ATTEMPT COMES FROM THE SIGNED-IN ACTOR AND NEVER FROM THE HANDLE. The vendor's return-leg
       * id and the id its mint answered with are different id spaces with no endpoint between them,
       * and nothing here may try to bridge them; trying identities until one is accepted would be an
       * oracle reporting which of this deployment's identities have flows outstanding. The session
       * names exactly one candidate, which is what makes the correlation exact rather than probable.
       *
       * {@link PluginStore.authorizationAttemptFor} already excludes a completed attempt and one past
       * the fifteen-minute TTL, so all three absences arrive here as `null` and are refused in one
       * sentence. A NULL `auth_id` is the fourth: its mint never completed, so there is nothing for
       * the binding below to be checked against and the attempt can only ever expire.
       *
       * A ROW THAT CANNOT SAY WHOSE ACCOUNT IT IS FOR IS THE FIFTH, AND IT IS REFUSED HERE RATHER
       * THAN READ AS THE DEPLOYMENT'S. `(holder, user_id)` is held by
       * `pending_authorizations_holder_check`, so a `person` row with no user id cannot be written
       * and this branch is unreachable through the table — which is exactly why it must be a
       * refusal: the reading it replaces rebuilt that row as `{ holder: "deployment" }` and then
       * aimed the withdrawal below at the DEPLOYMENT's account, ending a connection nobody asked
       * about while the person's stayed live. Refused BEFORE the vendor is asked anything, like the
       * null `auth_id` above and for the same reason: the attempt can never complete, so no call is
       * worth spending on it, and nothing is written — the row stands until its TTL.
       */
      const actorId = context.var.actor.id;
      const attempt = await store.authorizationAttemptFor(actorId);
      if (!attempt || attempt.authId === null) return refusedWith("no-attempt");
      const attemptAccount = asAccountRef(attempt);
      if (!attemptAccount) return refusedWith("no-attempt");
      const authId = attempt.authId;

      /*
       * THE BINDING. `handle` IS AN OPAQUE STRING THE SEAM DOES NOT INTERPRET — the vendor's word for
       * it stops at the adapter, and nothing here parses it, compares it to a scheme or reads a
       * provider out of it.
       *
       * THE MISMATCH BRANCH IS ASSUMPTION-BACKED AND IS MOCKED-ONLY UNTIL A LIVE PROBE RUNS. The SDK
       * declares no error shape for a handle belonging to somebody else; the adapter detects one by
       * normalizing the thrown error and reading `user_mismatch`, and RETHROWS anything else. If the
       * vendor's real shape differs, `confirmReturn` does not quietly answer `{ mismatch: true }` —
       * it throws, and the branch below surfaces an outage instead of a clean refusal. That is UX
       * degradation and not a hole: nothing is written and the attempt row is left alone either way,
       * and the `auth_id` comparison underneath independently covers a `confirm` that SUCCEEDS
       * against the wrong identity. Do not read a passing mocked test as proof this path works.
       */
      let confirmed: Awaited<ReturnType<typeof flow.confirmReturn>>;
      try {
        confirmed = await withVendorDeadline(
          (signal) =>
            flow.confirmReturn(
              {
                handle: flowId,
                vendorUserId: attempt.vendorUserId,
              },
              { signal },
            ),
          STATUS_CALL_TIMEOUT_MS,
        );
      } catch {
        /*
         * NOTHING FROM THE VENDOR'S ANSWER TRAVELS WITH THIS — not its sentence, not its body, not
         * the error. A reply on this leg can carry an authorization url, which is a bearer capability,
         * and an outage is not worth a person's consent being quotable out of an error body.
         *
         * LOGGED, THOUGH, WHICH IT WAS NOT. This refusal and the status one below are the two ways a
         * return leg ends with the vendor unreachable, and they reach the person as the SAME
         * sentence — so without a line an operator cannot tell which call failed, and the two are
         * not equally serious: this one ran BEFORE anything was confirmed, so no completion is
         * implied by reaching it. Said plainly here rather than left to be inferred from the absence
         * of the other line.
         *
         * AND NO REASON TRAVELS WITH IT, for the reason the paragraph above already gives about the
         * redirect: a reply on this leg can carry an authorization url, which is a bearer
         * capability. That hazard does not stop at the response — it was measured reaching this
         * line — and a log is not a lesser destination. Both vendor calls on this route therefore
         * log what happened and where to look, and nothing derived from what the vendor said. See
         * `arcade-completion-status-unknown` below, which drops its reason for the same reason and
         * over a worse secret.
         */
        console.error(
          JSON.stringify({
            type: "arcade-return-confirmation-unknown",
            server: attempt.serverId,
            action: attempt.action,
            authorizationId: authId,
            attemptStartedAt: attempt.createdAt,
            note: "A person returned from a consent screen and the vendor could not be asked whether this return belongs to their authorization, so nothing was read and nothing was written. The attempt was left standing and returning to the link can still settle it. Unlike arcade-completion-status-unknown this implies no completed consent: the status was never reached. No reason is carried here on purpose: a reply on this leg can hold an authorization url, which is a bearer capability.",
          }),
        );
        return refusedWith("vendor-unavailable");
      }

      /*
       * TWO REFUSALS, ONE SENTENCE, AND THE ATTEMPT ROW IS LEFT UNTOUCHED BY BOTH. A handle the vendor
       * says belongs to somebody else, and a confirmation naming a DIFFERENT authorization than the
       * one this deployment minted, are both "this return leg is not for the attempt you are holding".
       *
       * THE `auth_id` COMPARISON IS NOT OPTIONAL AND IT IS NOT HOPEFUL: the confirmation's id was
       * measured IDENTICAL to the mint's through a completed consent, so this is an exact equality
       * over one id space. Identity alone is not correlation — an expired read attempt, a fresh send
       * attempt under the same identity, and then the read's callback arriving late matches on
       * identity at every step, and a check stopping there would attribute a read consent to a send
       * request. Local expiry does not cancel a vendor flow, so late callbacks are ordinary.
       *
       * NOTHING IS WRITTEN AND NOTHING IS CLOSED. A late callback must never consume or ALTER the
       * replacement it arrived behind, so the row is not deleted, not completed and not marked.
       */
      if ("mismatch" in confirmed || confirmed.authorizationId !== authId) {
        return refusedWith("not-your-authorization");
      }

      /*
       * THE BOUNDED WAIT. `pending` is polled a few times over a few seconds and never with the SDK's
       * unbounded `waitForCompletion`: a browser is held open on this request, and a vendor that has
       * stopped answering must not hold it open forever. See {@link settledStatus}.
       *
       * NOTHING FROM THAT ANSWER TRAVELS ANYWHERE (D31). The vendor's own status reply carries a LIVE
       * PROVIDER ACCESS TOKEN and the person's full profile; the seam narrows it to three fields
       * inside the adapter, and the three are read here into a decision, a comparison and the scope
       * list the completion writes. Not one of them is logged, attached as a `cause` or put in an
       * error body, and the status object itself reaches none of those either. A status response
       * LOOKS LIKE METADATA, which is how the throwaway harness that proved this flow came to write
       * the token to a file on its first run.
       */
      let settled: Awaited<ReturnType<typeof flow.status>>;
      try {
        settled = await settledStatus(flow, authId);
      } catch {
        /*
         * THE ONE UNKNOWN ON THIS LEG THAT CAN SIT OVER A LIVE GRANT, AND IT USED TO BE SILENT.
         *
         * Everything above has already passed: the handle was confirmed, it named THIS mint, and the
         * person is standing here because a consent screen sent them. So the likeliest state behind
         * this throw is a consent that COMPLETED AT THE VENDOR — and the only thing that failed is
         * this deployment reading the status that would let it record one. Nothing is written, so the
         * grant is live at Arcade and no row here names it.
         *
         * THE ROW IS LEFT STANDING, DELIBERATELY, AND THAT IS WHY A LINE IS THE WHOLE FIX. A status
         * this deployment could not read is not a verdict: closing the attempt would take away the
         * link the person can come back to, and writing a connection would record a completion
         * nothing here has evidence of. The attempt stands until its TTL and a return can still
         * settle it — so the recovery already exists, and what was missing was anybody knowing to
         * look. See `arcade-mint-outcome-unknown`, which is this shape on the opening leg.
         *
         * AND THIS LINE CARRIES NO REASON, WHICH IS THE ONE PLACE IT DEPARTS FROM ITS SIBLINGS.
         *
         * `arcade-mint-outcome-unknown` and `arcade-context-withdrawal-unknown` both log the error
         * through {@link reasonWithoutStatement}, on the argument that everything reaching them
         * carries this deployment's own sentence. THAT ARGUMENT DOES NOT HOLD HERE and it was
         * MEASURED not holding: this is the status leg, whose reply carries a LIVE PROVIDER ACCESS
         * TOKEN and the person's profile (D31) — the adapter already inverts the carry-the-vendor-
         * error-as-`cause` convention for exactly that reason — and a failure injected on this seam
         * put the token straight into the line. A log is not a lesser destination than a redirect,
         * and this leg's whole discipline is that nothing of that answer travels anywhere.
         *
         * So the line names WHAT HAPPENED AND WHERE TO LOOK, and nothing derived from the vendor:
         * the authorization id an operator finds the flow by, the app, the action, and when the
         * attempt began. The reason is the one thing that cannot be included without reopening the
         * hole this leg exists to keep shut, and an operator holding the id can ask the vendor
         * directly — which is the thing the missing reason would only have described.
         *
         * Held by `arcade-verify.test.ts`, which asserts the token reaches neither the response nor
         * this line.
         */
        console.error(
          JSON.stringify({
            type: "arcade-completion-status-unknown",
            server: attempt.serverId,
            action: attempt.action,
            authorizationId: authId,
            attemptStartedAt: attempt.createdAt,
            note: "A person returned from a consent screen and this deployment could not read whether the authorization completed, so nothing was recorded. The consent may well be LIVE at the vendor with no row here naming it. The attempt was left standing rather than closed, so returning to the link can still settle it; if it expires first, check the authorization at the vendor before assuming nothing was granted. No reason is carried here on purpose: the vendor's status answer holds a live access token.",
          }),
        );
        return refusedWith("vendor-unavailable");
      }

      /*
       * WHAT EACH OUTCOME DOES TO THE ATTEMPT ROW, AND THE TIMEOUT IS THE ONE THAT LEAVES IT ALONE.
       * `failed` and an identity that is not the attempt's are verdicts, so the row is consumed and
       * marked. STILL `pending` AT THE BOUND IS NEITHER A SUCCESS NOR A FAILURE: the consent may be
       * finished a second later, and a row closed here would mean a person who came back to the
       * link found nothing to finish. It stands until its TTL.
       */
      if (settled.status === "failed") {
        await store.failAuthorizationAttempt({ actorId, authId });
        return refusedWith("authorization-failed");
      }
      if (settled.status !== "completed") return refusedWith("not-finished");
      if (settled.userId !== attempt.vendorUserId) {
        await store.failAuthorizationAttempt({ actorId, authId });
        return refusedWith("not-your-authorization");
      }

      /*
       * FRESHNESS (D28): A CONSENT WHOSE CONTEXT HAS MOVED ON IS NOT COMPLETED INTO THE PRESENT.
       *
       * The app's CURRENT account, its mode, the active provider and this actor's current authority
       * are all re-resolved through the same resolver the mint used, and all of them have to still
       * be the attempt's. The window is one consent's TTL and it needs an administrator to switch an
       * app's mode twice inside it — which is rare, and silent: writing it would create a live grant
       * bound to a retired identity that nothing will ever call with, and on an app somebody
       * disconnected in between it would quietly resurrect the account.
       *
       * AND THE GRANT MAY ALREADY BE LIVE AT THE VENDOR, because the person completed it there
       * before this deployment looked. So where the account REALLY MOVED, the RETIRED identity's
       * connection is withdrawn — keyed on that identity and on this app, which CANNOT TOUCH THE
       * CURRENT ACCOUNT: a connection is keyed `(user_id, provider_id)` and the retired identity is
       * not the current one. Where that withdrawal succeeds the attempt is marked `withdrawn`; where
       * it fails, is not attempted or answers `false` it is kept as `unreconciled` rather than
       * closed, because a grant we know about and could not end is worth a row somebody can act on.
       */
      /*
       * THE RETIRED IDENTITY IS THE ATTEMPT'S OWN, READ ONCE AT THE TOP AND NOT REBUILT HERE. A
       * reference built a second time from the row's columns is a second chance to build it wrong,
       * and the one this replaced defaulted a pair it did not recognise to the deployment's.
       */
      const retired: AccountRef = attemptAccount;
      const fresh = await brokeredAccountFor(context, attempt.serverId);
      /*
       * A REFUSAL IS NOT A MOVE, AND ONLY A MOVE WITHDRAWS ANYTHING.
       *
       * `brokeredAccountFor` refusing says this person may not act on the app's account NOW. That
       * is two different facts. One is that the account moved AND this person is not an
       * administrator — a Personal app switched to Shared under a person's open consent — and there
       * the retired account is theirs and is withdrawn below as for any move. The other is that the
       * account is exactly where it was and only the PERSON changed: an administrator who started a
       * Shared app's consent and lost the role before finishing it. This branch used to read both
       * as a move and withdraw `retired` — which in the second case IS the deployment's LIVE
       * account, so one demoted administrator's late return ended the team's grant at the vendor
       * and cleared every sibling app's row with it.
       *
       * So they are told apart by asking again with `readOnly`, which lifts the administrator
       * requirement and nothing else: the account it answers is the app's current one whoever
       * asks. A different account is a move. The same account, or none at all (the app stopped
       * resolving to one), is not, and nothing is withdrawn on the strength of it.
       *
       * THE ATTEMPT IS THEN CLOSED, because no return can ever complete it — the person cannot pass
       * this check again — and it is closed `unreconciled`, the existing verdict for "the vendor
       * answered and this deployment could not settle it", which is exactly true: the consent is
       * live at the vendor on an account nothing here will record it against. Not `withdrawn`,
       * which would claim a withdrawal, and not `failed`, which would say the person declined. The
       * line says the rest, which the row cannot.
       */
      const current = fresh.refusal
        ? await brokeredAccountFor(context, attempt.serverId, {
            readOnly: true,
          })
        : fresh;
      const moved = !current.refusal && !sameAccount(current.account, retired);
      if (fresh.refusal && !moved) {
        console.error(
          JSON.stringify({
            type: "arcade-completion-not-permitted",
            server: attempt.serverId,
            action: attempt.action,
            authorizationId: authId,
            holder: retired.holder,
            note: "A person returned from a consent screen who may no longer act on this app's account, so nothing was recorded and nothing was withdrawn. The consent is live at the vendor on the account the attempt was for; the attempt was closed unreconciled. Nothing needs undoing unless that grant should not stand.",
          }),
        );
        await store.markAuthorizationUnreconciled({ actorId, authId });
        return refusedWith("not-permitted");
      }
      if (fresh.refusal || moved) {
        const row = await store.serverAddress(attempt.serverId);
        const retiredApp = row ? appOfUrl(row.url) : null;
        let withdrawn = false;
        /*
         * WHAT THIS WITHDRAWAL ENDS BESIDES THE APP IT NAMES, RESOLVED BEFORE THE REVOKE GOES OUT.
         *
         * Where a connection is keyed `(identity, auth provider)` — Arcade — the one revoke below
         * ends the whole connection and so every app on the retired identity that shares it. Their
         * rows here would be left standing, which makes this deployment's own records claim live
         * connections for apps the vendor has already disconnected: a person sees apps listed as
         * connected that fail on first use, and nothing here knows to tell them otherwise. The set
         * is the store's, keyed on the pair and never on the provider alone, and BEFORE rather than
         * after, which is the ordering `disconnectBrokered` and `removeServer` both keep: once the
         * revoke has run, a sibling's auth provider is a question asked of a connection that is
         * already gone. On Composio an app is its own auth provider, so it is always empty and
         * nothing below differs from what this refusal always did.
         *
         * AND A SET THIS COULD NOT RESOLVE STOPS THE REVOKE RATHER THAN WIDENING IT. The ask is a
         * live vendor call per app on a request a browser is held open on, so it is bounded — on
         * the WHOLE resolution rather than on each call inside it, because the store's method takes
         * no signal, which is the bound that matters to the browser. A timeout or a refusal leaves
         * `collateral` null and nothing is then asked of the vendor at all. Ending apps this
         * deployment cannot then name is the failure this whole branch is about, and the
         * alternative is not silence: the attempt is kept `unreconciled` below, which is a row an
         * operator can act on over a grant that is merely still live.
         */
        let collateral: { siblings: string[]; unanswered: number } | null =
          null;
        if (retiredApp) {
          try {
            collateral = await withVendorDeadline(() =>
              store.siblingApps({ toolkit: retiredApp, account: retired }),
            );
          } catch (error) {
            /*
             * Nothing from the vendor's answer travels with this, here as everywhere on this leg.
             *
             * AND THE FIX THAT LOGGED THE REVOKE THROW DID NOT REACH ITS OWN SIBLING. `arcade-
             * context-withdrawal-unknown` below covers the revoke raising; this call sits one step
             * in front of it and decides whether that revoke is attempted AT ALL. Unresolved, the
             * revoke is skipped entirely and the attempt is closed `unreconciled` — the same outcome
             * the branch below writes a line for, reached by a different road and, until now,
             * without one. An operator reading the trail saw `unreconciled` and nothing saying why.
             */
            collateral = null;
            console.error(
              JSON.stringify({
                type: "arcade-sibling-resolution-unknown",
                server: attempt.serverId,
                app: retiredApp,
                action: attempt.action,
                authorizationId: authId,
                note: "A consent completed at the vendor after this app's account changed, and which apps the retired identity's grant also covers could not be resolved. No withdrawal was attempted, so the retired identity's grant is still live at the vendor and this deployment's rows for it were left alone. The attempt was closed unreconciled. Disconnect the app here to settle it.",
                error: reasonWithoutStatement(error),
              }),
            );
          }
        }
        if (retiredApp && collateral) {
          try {
            /*
             * THE BOOLEAN IS READ, NOT DROPPED. `false` means "nothing there" — on Arcade a
             * toolkit whose auth provider could NOT be resolved now refuses rather than answering
             * it, so an unattributable app arrives here as the throw below. Both land on the
             * not-withdrawn branch, which is the safe reading over a possibly-live grant.
             */
            withdrawn = await withVendorDeadline(() =>
              composio.broker.revoke({
                account: retired,
                toolkit: retiredApp,
              }),
            );
          } catch (error) {
            /*
             * A THROW HERE IS NOT AN ANSWER OF `false`, AND IT IS NOT READ AS ONE.
             *
             * `false` is the broker saying "there was nothing to withdraw", off a listing it read
             * whole. A throw says nothing of the kind: the seam deletes EVERY connection it found
             * and only then throws if any delete failed, so "revoke failed for 1 of 3" arrives
             * here with two of three already gone; and a deadline that fires is this deployment
             * giving up on a call the vendor may finish a moment later. Either way the vendor side
             * may already be withdrawn — the commit-then-throw shape `/arcade/verify`'s completion
             * catch below was fixed for, one call earlier on the same leg.
             *
             * SO THE OUTCOME IS NEITHER CLAIM. `withdrawn` stays false, which is the conservative
             * half: no local row is cleared and no collateral is put on the trail on the strength
             * of a withdrawal nobody saw, because the alternative — clearing on a guess — is
             * this deployment forgetting a grant that may still be live, and that is the
             * irreversible mistake. The attempt is closed `unreconciled`, which is the existing
             * verdict for "we do not know what happened" and is exactly true here.
             *
             * WHAT `unreconciled` DOES NOT COVER, AND THIS LINE DOES. The row holds an outcome and
             * a timestamp and nothing else: no reason, nothing reads it back, and it reads the same
             * for a vendor that said "nothing there" as for a call whose outcome is unknown. It
             * cannot say the one thing an operator needs here — that the vendor may ALREADY have
             * ended this connection, so the rows this deployment still holds for the app and for
             * every sibling on the same connection may be claiming live connections that are gone,
             * or that the grant is live and needs ending by hand. That is a disagreement between
             * this deployment and the vendor that nobody would otherwise find out about, and
             * leaving no trace of it was half of the defect. A third outcome on the row would need
             * a schema change to say what this line says, and the line is where every sibling on
             * this route already reports a failure it swallowed.
             *
             * WHAT IS IN THE LINE is what `arcade-completion-not-recorded` allows itself and the
             * names of this deployment's own apps: the authorization id an operator finds the flow
             * by, the app, the sibling apps whose rows may now be stale, and the reason through
             * {@link reasonWithoutStatement}. Errors out of the broker seam carry this deployment's
             * own sentence — `ArcadeFailureError` (`arcade.ts`) drops the vendor's prose by construction
             * and {@link VendorTimeoutError} is ours — so nothing of the vendor's answer travels
             * with this, here as everywhere on this leg. No account id, no vendor user id.
             */
            withdrawn = false;
            console.error(
              JSON.stringify({
                type: "arcade-context-withdrawal-unknown",
                server: attempt.serverId,
                app: retiredApp,
                action: attempt.action,
                authorizationId: authId,
                siblings: collateral.siblings,
                note: "A consent completed at the vendor after this app's account changed, and withdrawing the retired identity's grant raised instead of answering. Whether the vendor withdrew it is unknown: the attempt was closed unreconciled and no row here was cleared, so either the grant is still live at the vendor or this deployment's rows for the app and the siblings named here claim connections the vendor has already ended. Check the connection at the vendor and disconnect the app here to settle it.",
                error: reasonWithoutStatement(error),
              }),
            );
          }
        }
        /*
         * AND THE ROWS FOR WHAT IT ENDED GO WITH IT, ONLY ON AN ANSWER OF TRUE. `false` is "nothing
         * found, or we could not work out what to withdraw", and no local row may be cleared — nor
         * any collateral claimed on the trail — on the strength of an answer nobody got. The trail
         * rows this writes are what tell a person why an app they never touched stopped being
         * connected here, and tell an operator that one withdrawal took several apps with it.
         */
        if (withdrawn && retiredApp && collateral) {
          await store.clearWithdrawnAccount({
            toolkit: retiredApp,
            account: retired,
            siblings: collateral.siblings,
            unanswered: collateral.unanswered,
            // The actor this attempt is keyed on, read once at the top like everything else here.
            by: actorId,
            reason: "context_changed",
          });
        }
        if (withdrawn)
          await store.markAuthorizationWithdrawn({ actorId, authId });
        else await store.markAuthorizationUnreconciled({ actorId, authId });
        return refusedWith("context-changed");
      }

      /*
       * ONE TRANSACTION, AND A REPLAY IS A NO-OP RATHER THAN AN ERROR. The attempt row is the
       * serialization point: zero rows updated writes nothing and answers `{ claimed: false }`,
       * which is either somebody else having completed this attempt first or the attempt having
       * ended underneath this request — see the branch after the completion, which tells the two
       * apart. See {@link PluginStore.completeAuthorizationAttempt}.
       *
       * `authProvider` IS ASKED OF THE BROKER AND NEVER DERIVED FROM THE TOOLKIT NAME. The two
       * coincide only where an operator happened to name their provider configuration after the
       * app, which {@link ConnectedAppBroker.authProviderOf} sets out at length — so a derivation
       * would pass every test in this tree and be wrong about the deployment it shipped to. A
       * vendor that does not say is recorded as not saying, and a vendor that cannot be reached for
       * it costs nobody their completed consent: this is an audit label, and the grant is already
       * live. It is never read back out of a status reply, which D31's narrowing makes
       * structurally impossible anyway.
       */
      const authProvider = await withVendorDeadline(() =>
        composio.broker.authProviderOf(fresh.toolkit),
      ).catch(() => null);

      /*
       * AND THE LANDING COMES FROM THE ATTEMPT ROW (D18), NEVER FROM `next_uri`. The vendor refuses
       * every `next_uri` at mint, and what `confirm_user` answers is the vendor's OWN success page
       * rather than ours. The row holds the app and the action this consent was for, and it cannot
       * be missing here — this handler refused long before it needed an address — so there is no
       * fallback to specify.
       *
       * AND BOTH HOLDERS LAND ON THE SAME SCREEN, which is the only one that reads `?action=`. An
       * account the deployment holds used to be sent to `/admin/plugins/:key`, but that route has no
       * `validateSearch` for `action`, no landing notice and no grant list, so the whole Shared-app
       * flow completed a consent at the vendor and landed somewhere that said nothing about it. The
       * settings page draws the Shared app's grant list and the landing notice for either holder,
       * so this is where the action somebody just authorized is actually named and marked.
       *
       * `connectedAccountsUrlFor` with `{ serverId }` answers a query-less path, so appending
       * `?action=` here cannot produce a second `?`.
       *
       * BUILT BEFORE THE WRITE RATHER THAN AFTER IT, so that the only thing standing between a
       * committed grant and the person's browser is the redirect itself. Both reads are off the
       * attempt row and neither calls anybody.
       */
      const landing = `${connectedAccountsUrlFor(connect?.appUrl, {
        serverId: attempt.serverId,
      })}?action=${encodeURIComponent(attempt.action)}`;

      /*
       * THE COMPLETION HAS ITS OWN `catch`, AND IT IS THE ONLY PLACE ON THIS LEG THAT MAY ANSWER
       * `not-recorded`.
       *
       * THE DEFECT IT CLOSES, FIRST HALF: the blanket `catch` below used to answer `not-recorded`
       * for every throw in this handler INCLUDING ONE RAISED AFTER THIS TRANSACTION HAD COMMITTED.
       * The grant is live at the vendor and the row is written here, and the person was told it was
       * not recorded — so they start over, mint a second consent against a connection they already
       * have, and the one sentence this leg exists to get right is the one it got backwards.
       *
       * THE TWO ARE NOT TOLD APART BY WHETHER THE CALL THREW. The transaction is all-or-nothing
       * ({@link PluginStore.completeAuthorizationAttempt}), but "the call rejected" and "the work
       * rolled back" are different facts: a connection lost on the way back from a COMMIT the
       * server already applied rejects here over a grant that IS written down. So the row the
       * transaction serializes on is ASKED
       * ({@link PluginStore.authorizationAttemptCompleted}) rather than inferred from the throw,
       * and that answer — not the throw — decides which sentence the person gets. A probe that
       * cannot be reached either reads as not recorded, which is the reading that sends somebody
       * back to try again rather than away believing in a grant that is not there; the completion
       * is idempotent on `completed_at IS NULL`, so a retry over a grant that did land writes
       * nothing twice.
       *
       * SECOND HALF: IT IS LOGGED, which the blanket `catch` did not do at all. This is the one leg
       * where a vendor grant can be LIVE with nothing here recording it, and it was also the one
       * leg that left an operator no trace of that happening — every sibling on this route logs,
       * and this is the same line `arcade-mint-not-recorded` writes at the other end of the same
       * lifecycle, for the same reason: the `ar_…` is what lets an operator find that flow at the
       * vendor and end it.
       *
       * WHAT IS IN THE LINE IS EXACTLY WHAT IS SAFE TO PUT THERE. The authorization id, the app and
       * the action: the first is the handle the mint log already carries, and the other two are
       * this deployment's own catalogue names. NOT the `authorization.url`, which is the bearer
       * capability whoever opens it attaches the account with and which this handler never holds a
       * copy of anyway; NOT the status reply, which carries a LIVE PROVIDER ACCESS TOKEN and the
       * person's profile behind D31's narrowing; NOT the granted scopes and NOT the vendor user id,
       * which name the person and buy an operator nothing the id does not. The error goes through
       * {@link reasonWithoutStatement}, because a `DrizzleQueryError`'s own message is the failed
       * statement and every value bound to it — which here includes the scope list and the account.
       */
      let claimed: boolean;
      try {
        ({ claimed } = await store.completeAuthorizationAttempt({
          actorId,
          authId,
          toolkit: fresh.toolkit,
          account: fresh.account,
          action: attempt.action,
          scopes: settled.scopes,
          authProvider: authProvider ?? "",
        }));
        recorded = claimed;
      } catch (error) {
        recorded = await store
          .authorizationAttemptCompleted({ actorId, authId })
          .catch(() => false);
        console.error(
          JSON.stringify({
            type: recorded
              ? "arcade-completion-unacknowledged"
              : "arcade-completion-not-recorded",
            server: attempt.serverId,
            action: attempt.action,
            authorizationId: authId,
            note: recorded
              ? "A per-action consent was written down and the write then failed to report itself. The attempt row says it committed, so the person was sent on to the page that says so and nothing needs redoing."
              : "A person completed a per-action consent at the vendor and this deployment could not write it down. The authorization named here is LIVE at the vendor with nothing here recording it; the person was told so, and the attempt row stands until its TTL.",
            error: reasonWithoutStatement(error),
          }),
        );
        if (!recorded) return refusedWith("not-recorded");
        claimed = true;
      }

      /*
       * THE COMPLETION CLAIMED NOTHING, AND THAT IS NOT ALWAYS SOMEBODY ELSE'S SUCCESS.
       *
       * Zero rows used to be answered with the landing, on the reading that a rival callback had
       * completed this attempt first. That is one way to get here. The other is the person's own
       * Cancel: its DELETE can land after the vendor confirmed this return and before the UPDATE
       * above, and then the person was told they were connected while the trail said cancelled
       * and the grant stood live at the vendor. So the row is ASKED, as the `catch` above asks it,
       * and only `completed` earns the landing.
       *
       * ANYTHING ELSE IS REFUSED, AND THE GRANT THIS RETURN CARRIED IS WITHDRAWN — but only where
       * withdrawing ends nothing besides it. On Arcade a revoke ends the whole `(identity, auth
       * provider)` connection, so if this account already held the app, or holds a sibling on the
       * same connection, or a sibling could not be ruled out, the revoke would take away a
       * connection nobody asked to end — for a Shared app, the team's. Those are left live and the
       * line says so; disconnecting the app here is what ends them on purpose. The siblings are
       * resolved and bounded exactly as the freshness branch above resolves them.
       *
       * THE ATTEMPT ROW IS NOT TOUCHED. Whatever ended it — the cancel's deletion, or a verdict on
       * another leg — already settled it, and the cancel filed `mcp.authorization_cancelled` for
       * itself. A probe that cannot be reached withdraws nothing and refuses as `not-recorded`, the
       * reading the `catch` above gives an unreachable probe, for the same reason.
       */
      if (!claimed) {
        let probeFailure: unknown = null;
        const completedElsewhere = await store
          .authorizationAttemptCompleted({ actorId, authId })
          .catch((error: unknown) => {
            probeFailure = error;
            return null;
          });
        /*
         * A PROBE THAT COULD NOT BE READ WITHDRAWS NOTHING, AND SAYS SO. Whether the attempt was
         * cancelled or completed by a rival is unknown, so the grant this return carried is left
         * where it is — which may be live at the vendor with nothing here recording it. That is
         * the same disagreement the line below reports, and it was the one branch that left none.
         */
        if (completedElsewhere === null) {
          console.error(
            JSON.stringify({
              type: "arcade-cancelled-grant-left-live",
              server: attempt.serverId,
              app: fresh.toolkit,
              action: attempt.action,
              authorizationId: authId,
              why: "whether the attempt was cancelled could not be read, so nothing was withdrawn",
              siblings: [],
              note: "A consent completed at the vendor and its attempt had already ended here, and reading how it ended raised. Nothing was recorded and nothing was withdrawn, so the grant may be live at the vendor. Disconnect the app here to end it if it should not stand.",
              error: reasonWithoutStatement(probeFailure),
            }),
          );
          return refusedWith("not-recorded");
        }
        if (!completedElsewhere) {
          const account = fresh.account;
          const app = fresh.toolkit;
          let leftLive: string | null = null;
          let failure: unknown = null;
          let collateral: { siblings: string[]; unanswered: number } | null =
            null;
          if (await store.brokeredConnection({ toolkit: app, account })) {
            leftLive = "the account already held this app's connection";
          } else {
            try {
              collateral = await withVendorDeadline(() =>
                store.siblingApps({ toolkit: app, account }),
              );
            } catch (error) {
              leftLive =
                "the apps sharing this connection could not be resolved";
              failure = error;
            }
          }
          if (
            collateral &&
            (collateral.siblings.length > 0 || collateral.unanswered > 0)
          ) {
            leftLive = "other apps share this connection";
          }
          if (!leftLive) {
            try {
              // Read, not dropped: `false` is "nothing there", which is not a withdrawal either.
              if (
                !(await withVendorDeadline(() =>
                  composio.broker.revoke({ account, toolkit: app }),
                ))
              ) {
                leftLive = "the vendor found nothing to withdraw";
              }
            } catch (error) {
              leftLive =
                "the withdrawal raised, so whether it happened is unknown";
              failure = error;
            }
          }
          if (leftLive) {
            console.error(
              JSON.stringify({
                type: "arcade-cancelled-grant-left-live",
                server: attempt.serverId,
                app,
                action: attempt.action,
                authorizationId: authId,
                why: leftLive,
                siblings: collateral?.siblings ?? [],
                note: "A person's consent completed at the vendor after their attempt was cancelled, so nothing was recorded. The grant was not withdrawn, so it may still be live at the vendor. Disconnect the app here to end it if it should not stand.",
                ...(failure ? { error: reasonWithoutStatement(failure) } : {}),
              }),
            );
            /*
             * AND THE TRAIL SAYS IT TOO, not only an operator's log. `mcp.authorization_cancelled`
             * on its own reads as "the person withdrew this", and here the vendor may still allow
             * the very action they cancelled — for a Shared app, as the team. A failure to file it
             * costs the person nothing more than the line above already says.
             */
            await store
              .recordCancelledGrantLeftLive({
                actorId,
                attempt,
                toolkit: app,
                why: leftLive,
                siblings: collateral?.siblings ?? [],
              })
              .catch((error: unknown) =>
                console.error(
                  JSON.stringify({
                    type: "arcade-cancelled-grant-left-live-not-filed",
                    server: attempt.serverId,
                    authorizationId: authId,
                    error: reasonWithoutStatement(error),
                  }),
                ),
              );
            // Its own code, so the person is told the action may still be allowed and how to end it.
            return refusedWith("cancelled-left-live");
          }
          return refusedWith("cancelled");
        }
        recorded = true;
      }

      return context.redirect(landing, 303);
    } catch (error) {
      /*
       * AND THE BLANKET `catch` IS NO LONGER WHERE A LOST COMPLETION GOES QUIET. It stands over the
       * reads that happen BEFORE the completion — the guard's session and role reads, the attempt
       * read, and the refusals' own string building — and over the reads after a completion that
       * claimed nothing, which wrote nothing either — so `not-recorded` is true of everything that
       * reaches it: the completion above answers for itself, under its own `catch`, and never falls
       * through to here still thinking it might have landed.
       *
       * `recorded` IS LOGGED RATHER THAN ASSUMED FALSE. The only step left after a completion that
       * claimed its row is the redirect, and the sole way it can throw is a `Location` this deployment's own `appUrl`
       * made unencodable — which would equally defeat the refusal built below, so there is no
       * honest second answer to give here and the flag is what makes the claim checkable in a
       * deployment rather than only in this comment.
       *
       * LOGGED AT ALL, which is the second half of what this leg was missing: every sibling on this
       * route reports a failure it swallowed, and this one reported nothing. With the same
       * restraint as the completion's own line above and nothing of the vendor's in it, through
       * {@link reasonWithoutStatement} for the reason given there.
       */
      console.error(
        JSON.stringify({
          type: "arcade-verify-failed",
          recorded,
          note: "A check on the verifier raised instead of answering. The person was sent back to the list with a failure.",
          error: reasonWithoutStatement(error),
        }),
      );
      return refusedWith("not-recorded");
    }
  });
}
