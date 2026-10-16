import type { AppVariables } from "../../auth/guards";
import {
  type BrokerField,
  BrokerUnconfiguredError,
  brokerReturnUrl,
  type Decides,
  isFieldScheme,
  type SchemeKind,
  schemeKind,
} from "../broker";
import { catalogueEntry } from "../catalogue";
import { toolkitOf } from "../composio";
import {
  authorizationUrlFor,
  type ConnectOrigin,
  challengeFor,
  connectedAccountsUrlFor,
  createVerifier,
  redirectUriFor,
  sealConnectState,
} from "../oauth";
import type { AccountRef } from "../shared-accounts";
import {
  CatalogueEntryUnknownError,
  type OAuthClient,
  PluginRefusedError,
} from "../store";
import { brokerRefusal, type PluginRouteContext } from "./context";

/** A person's connections: listing them, connecting an app (OAuth or brokered) and disconnecting. */
export function mountConnectionRoutes({
  routes,
  store,
  requireUser,
  connect,
  composio,
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
     * The app comes off the row's url via `toolkitOf` rather than off its id, for the reason the
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
    const toolkit = row ? toolkitOf(row.url) : null;
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
            error: `${row.title} needs no account, so there is nothing to connect. A Bot granted its tools can use it as it is.`,
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
          { error: new BrokerUnconfiguredError().message },
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
          published = await composio.broker.connectionFields({
            toolkit,
            authScheme,
          });
        } catch (error) {
          const refusal = brokerRefusal(
            error,
            `Composio would not say what ${row.title} asks for, and said nothing about why. Try again, and ask an administrator to check this deployment's Composio key if it persists.`,
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
              error: `${row.title} publishes no boxes to fill in, so there is nothing you could type that would reach it and no account was made. An administrator has to look at how ${row.title} is set up at Composio; removing it on the Plugins page and adding it again is what records the way Composio connects it now.`,
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
              error: `${row.title} publishes no box it says has to be filled in — only ${optional} — so nothing you could type would be a credential it insists on, and no account was made. An app that genuinely needs none is one Composio publishes as needing no authentication, and ${row.title} is recorded here as an app whose secret you type. An administrator has to look at how ${row.title} is set up at Composio; removing it on the Plugins page and adding it again is what records the way Composio connects it now.`,
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
                error: `That is not the form ${row.title} publishes, so nothing was sent to Composio. Press Connect again to draw it from what the app asks for now, and fill in the boxes it shows; each one holds text.`,
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
              error: `${row.title} cannot be connected without ${missing.join(", ")}, so nothing was sent to Composio. Fill in every box the form marks required — a box holding only spaces is an empty one — and press Connect again.`,
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
            `${row.title} could not be connected with what you entered, and Composio said nothing about why. Try again, and ask an administrator to check this deployment's Composio key if it persists.`,
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
            error: `This deployment cannot tell how ${row.title} connects, so nothing was sent to Composio and no account was made. An administrator has to remove it on the Plugins page and add it again, which records the way Composio connects it now.`,
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
              "This deployment has no app URL configured, so Composio would have nowhere to send you back to. Set OPENBOT_APP_URL.",
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
        ({ redirectUrl } = await composio.broker.authorize({
          account,
          toolkit,
          /*
           * THE REFUSAL ABOVE CHECKS THAT A SETTING IS SET; THIS CHECKS THAT IT IS AN ADDRESS.
           * `appUrl` is an environment string — `OPENBOT_APP_URL`, or the first `TRUSTED_ORIGINS`
           * entry — and nothing between there and Composio has ever looked at it, so
           * `openbot.example.com` with the scheme left off builds a callback that is not a
           * callback. That failure lands after somebody has consented, on the vendor's page, where
           * this deployment cannot tell them anything; the guard moves it to before the link is
           * minted, where the sentence reaches an operator who can set the variable.
           */
          returnUrl: brokerReturnUrl(
            connectedAccountsUrlFor(connect.appUrl, { serverId }, returnTo),
          ),
        }));
      } catch (error) {
        const refusal = brokerRefusal(
          error,
          `Composio would not begin a connection to ${row.title}, and said nothing about why. Try again, and ask an administrator to check this deployment's Composio key if it persists.`,
        );
        return context.json({ error: refusal.error }, refusal.status);
      }
      return context.json({ authorizationUrl: redirectUrl });
    }

    if (!connect?.publicUrl) {
      return context.json(
        {
          error:
            "This deployment has no public URL configured, so it cannot complete a consent flow. Set OPENBOT_PUBLIC_URL.",
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
            error: `${entry.title} has not been added to this deployment yet. An administrator has to add it first.`,
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
            error: `${entry.title} would not register this deployment, or could not be reached. Try again, and check the vendor's status if it persists.`,
          },
          502,
        );
      }
      return context.json(
        {
          error: `${entry.title} has no OAuth client registered yet. An administrator has to add one first.`,
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
   * there is nothing for either route to confirm or to end. `null` from `toolkitOf` also covers an
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
   * BRANCH IS TAKEN. That route still asks `toolkitOf` itself before this function is ever reached
   * — a row that is not brokered has an OAuth flow below it to fall through to, and refusing it
   * here, where there is no such flow to fall through to, would be wrong. Once that question is
   * settled and the answer is yes, whose account the connection is for is exactly the question
   * this function exists to answer once, rather than a fourth place a Shared app's account could
   * be decided differently from the other three.
   */
  const brokeredAccountFor = async (
    context: { var: AppVariables },
    serverId: string,
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
    const toolkit = row ? toolkitOf(row.url) : null;
    if (!toolkit) {
      return {
        refusal: {
          error: "That app is not reached through a broker.",
          status: 400,
        },
      };
    }
    if (!composio) {
      return {
        refusal: { error: new BrokerUnconfiguredError().message, status: 503 },
      };
    }
    const resolved = await store.accountRefFor(serverId, context.var.actor.id);
    if ("refusal" in resolved) {
      return { refusal: { error: resolved.refusal, status: 400 } };
    }
    if (
      resolved.ref.holder === "deployment" &&
      context.var.actor.role !== "admin"
    ) {
      return {
        refusal: {
          error: "An administrator connects shared apps.",
          status: 403,
        },
      };
    }
    return { toolkit, account: resolved.ref, title: resolved.title };
  };

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
          "Composio would not say whether this account is connected, and gave no reason, so what is shown here is the last answer it gave rather than a fresh one. Try again, and ask an administrator to check this deployment's Composio key if it persists.",
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
          "Composio would not say whether this connection still works, and gave no reason, so what is shown here is the last answer it gave rather than a fresh one. Press Re-check again, and ask an administrator to check this deployment's Composio key if it persists.",
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
        "Composio would not end this account, and gave no reason. Press Disconnect again: the revoke at Composio runs before anything here is deleted, so repeating it is safe and is the whole recovery. Ask an administrator to check this deployment's Composio key if it persists.",
      );
      return context.json({ error: refusal.error }, refusal.status);
    }
  });
}
