import {
  type AuthConfigOutcome,
  type BrokerApp,
  BrokerRefusalError,
  type ComposioBroker,
} from "../broker";
import {
  askVendor,
  everyRefusal,
  sent,
  textOf,
  VENDOR_SHAPE_REMEDY,
} from "../composio-vendor";
import type { ClientContext } from "./context";
import { CONFIG_SUFFIX, copyOf, DIRECTORY_TTL_MS } from "./model";

/** Composio's app directory, and the authorization configs this deployment keeps there. */
export function directoryMethods(context: ClientContext) {
  const { vendor, now, configsFor, askForEach, fetchDirectory } = context;

  /**
   * The catalogue answer this process is currently serving, and the moment it was asked for.
   *
   * A PROMISE RATHER THAN THE ROWS, WHICH IS THE WHOLE ANSWER TO CONCURRENCY. The entry is written
   * before the request is answered, so a second caller arriving while the first is still in flight
   * finds it and awaits the same request. Holding the resolved rows instead would leave the window
   * this cache exists to close wide open: three people opening the picker together, or one person's
   * debounce firing twice, are exactly the case where nothing is cached yet, and each of them would
   * start their own catalogue fetch and then overwrite each other's answer.
   *
   * IT IS PER BUILT CLIENT, not per module. This adapter is built once per deployment key, so in
   * this process that is one cache; in a test it is one cache per {@link buildComposioClient}, which
   * is what lets each test below start from nothing without an API for emptying it.
   */
  let heldDirectory: { at: number; apps: Promise<BrokerApp[]> } | null = null;
  return {
    /**
     * The catalogue, from memory where this process asked for it less than ten minutes ago.
     *
     * BOTH CALLERS READ THE SAME HELD ANSWER, AND THE SECOND OF THEM IS THE INTERESTING ONE. The
     * search route filters the directory in this process, so caching it is what stops a debounced
     * search field from pulling a few hundred rows once per term. The enable route then reads the
     * directory again to check that the slug it was handed is one Composio lists, and that read
     * comes out of the same cache — which is the right answer rather than a concession, because
     * the slug being checked is one this deployment handed the browser out of THIS cache moments
     * earlier. The check exists to refuse a slug the catalogue never published — a request composed
     * by hand, or a row left over from a url somebody edited — and a ten-minute-old catalogue
     * settles that question exactly as well as a fresh one. The case it gives up is an app Composio
     * withdrew within the window, whose cost is one `mcp_servers` row for an app that answers
     * nothing, removable on the page that added it; the case it buys is that pressing Add does not
     * re-read a catalogue the picker just read.
     *
     * A FAILURE IS NEVER HELD. The entry is dropped when its request rejects, so a vendor that
     * refused once is asked again by the next caller rather than refusing from memory for ten
     * minutes — the failures here are an unset or wrong API key and Composio being down, and the
     * first two are fixed by an operator who then presses the button again, which must be allowed
     * to work. The callers already sharing that one in-flight request do share its failure, which
     * is the truth about their request: they asked while it was being answered.
     *
     * THERE IS NO INVALIDATION, AND THE DESIGN ASKED FOR ONE. It wanted the directory "refreshable
     * by an explicit reload", and that is not built: the lifetime above is the whole of the
     * freshness story. Nothing in this deployment reloads a catalogue today — no page, route or job
     * has such a control — so the method would have no caller, and an invalidation API with no
     * caller is an untested path that reads like a guarantee. The moment a reload button exists,
     * this is where it attaches.
     */
    async listApps(): Promise<BrokerApp[]> {
      const held = heldDirectory;
      if (held && now() - held.at < DIRECTORY_TTL_MS) return copyOf(held.apps);

      /*
       * Stamped when the request goes out rather than when it comes back, so a slow catalogue is
       * held for slightly less than the full window rather than for the window plus its own
       * latency. Written into the slot before it is awaited, which is what a concurrent caller
       * finds.
       */
      const entry = { at: now(), apps: fetchDirectory() };
      heldDirectory = entry;
      /*
       * The drop on failure, registered here rather than written as a try/catch around an await so
       * that this method hands every caller the one shared promise. `heldDirectory === entry`
       * because a later request may already have replaced this one, and clearing that would throw
       * away a good answer over an old failure.
       */
      entry.apps.catch(() => {
        if (heldDirectory === entry) heldDirectory = null;
      });
      return copyOf(entry.apps);
    },

    async ensureAuthConfig({
      toolkit,
      name,
      connection,
    }): Promise<AuthConfigOutcome> {
      /*
       * NOTHING AT ALL FOR AN APP THAT NEEDS NO AUTHENTICATION, AND THAT IS THE VENDOR'S RULE
       * RATHER THAN A SHORTCUT. Composio refuses an auth config for such a toolkit — "Cannot
       * create an auth config for toolkit hackernews because it does not require authentication.
       * You can use its tools directly without creating a connected account." — so the listing
       * below is not even worth making: there is nothing to find and nothing to create.
       */
      if (connection.kind === "no-auth") return "not-needed";

      /*
       * AND A REFUSAL BEFORE ANY WRITE for the one kind this deployment cannot drive. The sentence
       * is the derivation's own, which named the scheme and what it wants; a refusal here that
       * invented a second sentence would drift from the one the picker filters on.
       */
      if (connection.kind === "unsupported") {
        throw new BrokerRefusalError(
          `${toolkit} was not enabled: ${connection.reason}`,
        );
      }

      /*
       * IDEMPOTENT BY LOOKING FIRST, because a second config is not a duplicate — it is a split.
       * A person's existing connection is created against one particular auth config, so creating
       * another and connecting the next person to that leaves two populations of connections for
       * one app, and removing "the" config later drops half of them.
       *
       * THE LOOK IS FOR ONE THIS DEPLOYMENT MADE, WHICH IS NARROWER THAN "ANY". It used to be any,
       * and the two ways that was wrong pull in opposite directions. A disabled config of ours was
       * invisible to the listing, so this created the very second config it exists to prevent — and
       * then `authorize` refused, because it looked with the same blind listing and found the app
       * had no config at all. A config an operator made by hand, meanwhile, satisfied the check and
       * this created nothing, leaving every later decision here pointed at an object nobody here
       * chose. Asking for our own answers both: the disabled one counts, and somebody else's does
       * not.
       *
       * WHICH MEANS AN APP CAN END UP WITH TWO CONFIGS, ONE OF THEM SOMEBODY ELSE'S, and that is
       * the intended outcome rather than a tolerated one. Adopting a hand-made config would have
       * this deployment mint people's connections against scopes and tool restrictions it cannot
       * see, and delete it when the app is removed. A config of our own, named, is the thing every
       * decision in this file can actually reason about.
       *
       * This is a read followed by a write and therefore not atomic: two administrators pressing
       * enable at the same instant can both find nothing and both create. Composio offers no
       * create-if-absent, so the window is the vendor's rather than this deployment's, and the
       * cost of losing that race is a spare config rather than a lost connection — spare rather
       * than orphaned, because both carry the suffix and `deleteAuthConfig` takes every one of
       * ours.
       */
      const { ours, unreadable } = await configsFor(toolkit);
      /*
       * AND THE ANSWER SAYS THE CONFIG WAS REUSED RATHER THAN SAYING NOTHING, which is what stops
       * the caller recording a scheme this branch did not establish. What stands here was created
       * as whatever it was created as, possibly by an enable months ago against a catalogue answer
       * the vendor has since changed — see {@link ComposioBroker.ensureAuthConfig}.
       */
      if (ours.length > 0) return "standing";

      /*
       * AND A ROW THAT COULD NOT BE READ IS NOT A ROW THAT IS NOT OURS. This is the one of the four
       * callers that must NOT act on what it can name and report the rest — see
       * {@link readableConfigs} for why the other three do. What it would be acting on is a
       * CREATION, and a config created beside a row that is in fact ours under a name Composio sent
       * unreadably is the second config this whole method exists to prevent: two populations of
       * connections for one app, and a removal later that drops half of them. Finding nothing of
       * ours in a listing this deployment could not read is not the same as finding nothing.
       */
      if (unreadable.length > 0) {
        throw new BrokerRefusalError(
          `Composio described ${unreadable.length} of its authorization configs for ${toolkit} in a way this deployment cannot read, so whether one of them is already its own is not something it can tell — and the app was not enabled, rather than a second config being created beside one that may already be there. ${VENDOR_SHAPE_REMEDY}`,
          { cause: everyRefusal(unreadable) },
        );
      }

      /*
       * THE OUTCOME NO LONGER CLAIMS NOTHING WAS CREATED, BECAUSE THIS CALL CANNOT KNOW THAT.
       *
       * It said "no authorization config was created for gmail", and {@link vendorRefusal} reads
       * every condition out through that clause — including the `TypeError` row, which is reached
       * exactly when the vendor's own transformer could not read a reply it had already received.
       * So the one condition most likely to mean the config EXISTS was the one telling an
       * administrator it did not, and nothing in this deployment then named the object standing at
       * Composio. What is true of every condition here is the half that is said now: the app is not
       * enabled, and what is at Composio is not something this call can report.
       */
      const configName = `${name} ${CONFIG_SUFFIX}`;

      /*
       * WHICH TYPE OF CONFIG, AND THE MANAGED ONE IS RIGHT FOR EXACTLY ONE OF THE THREE KINDS THAT
       * REACH HERE. It was sent for all of them, and only one of the failures announced itself:
       * Composio has no OAuth client of its own for a self-registering app, so the managed path
       * answers 404 and the app is simply unconnectable — which is what made Linear's MCP app
       * impossible to attach. A key app's was quiet and worse: the config was accepted, and every
       * person enabled onto it was then sent to a consent screen that had nothing to ask them for.
       *
       * AND NEITHER CUSTOM BRANCH CARRIES A CREDENTIAL, which is the point rather than an omission.
       * A self-registering app needs none by definition — the vendor registers a client of its own
       * at connect time. A key app needs none HERE because the key is one person's: it belongs to
       * each connection made against this config, which is per-deployment, and a key written onto
       * it would be one person's secret shared by everybody the app is enabled for.
       */
      const options =
        connection.kind === "consent"
          ? ({ type: "use_composio_managed_auth", name: configName } as const)
          : ({
              type: "use_custom_auth",
              authScheme:
                connection.kind === "self-registering"
                  ? ("DCR_OAUTH" as const)
                  : connection.authScheme,
              name: configName,
              /*
               * THE EMPTY RECORD IS THE VENDOR'S PRICE FOR SENDING NOTHING — see the field's own
               * comment on {@link ComposioVendor}. Omitting it is a `ValidationError` raised before
               * any request, which reads as a refusal to enable rather than as the secret-free
               * config this branch is for.
               */
              credentials: {},
            } as const);

      const created = await askVendor(
        {
          outcome: `the app is not enabled, and whether an authorization config for ${toolkit} now stands at Composio is not something this deployment can tell`,
          app: toolkit,
        },
        () => vendor.authConfigs.create(toolkit, options),
      );

      /*
       * THE REPLY IS READ, WHICH IS THE HALF THAT WAS MISSING. Composio names the config it just
       * made, and the answer was awaited and dropped — so an answer carrying no id at all was a
       * successful enable of an app whose config this deployment could not show existed. It is not
       * an id anything here needs: the next listing finds the config by its name. It is the only
       * evidence in the reply that the creation this method reports actually happened, and a method
       * that returns nothing has no other way to have checked.
       *
       * AND THE REFUSAL SAYS WHAT IS PROBABLY TRUE RATHER THAN WHAT WOULD BE TIDY. The request went
       * out and Composio replied to it, so a config very likely IS standing there — saying "none
       * was created" would be the same lie the outcome above stopped telling. The remedy is the
       * button they just pressed, because {@link ComposioBroker.ensureAuthConfig} is idempotent
       * through the name: a second enable finds the suffix and adopts what is there.
       */
      if (textOf(created?.id) === null) {
        throw new BrokerRefusalError(
          `Composio answered the creation of an authorization config for ${toolkit} with ${sent(created?.id)} where the new config's id belongs, so this deployment cannot show that the config it just asked for exists and the app is not enabled. The request went out and Composio replied to it, so one may well be standing there: enabling ${toolkit} again finds it rather than making a second, because a config whose name ends with ${CONFIG_SUFFIX} is one this deployment claims. ${VENDOR_SHAPE_REMEDY}`,
        );
      }

      // Made here, as `connection`'s scheme, which is what lets the caller record that scheme.
      return "created";
    },

    async deleteAuthConfig(toolkit): Promise<void> {
      /*
       * EVERY CONFIG OF OURS, AND NOTHING THAT IS NOT OURS.
       *
       * This used to delete whichever row the vendor happened to return first, on the reasoning
       * that {@link ComposioBroker.ensureAuthConfig} creates at most one, so a second one must be
       * somebody's dashboard work and must be left alone. The reasoning was right and the code did
       * the opposite of it: with no test of the name, "the first row" is as likely to BE the
       * hand-made config — deleting it, and with it every account anybody had connected against it.
       * Reading the name inverts that. Anything without the suffix is untouched whatever order it
       * arrives in, and everything with it goes, which is also the only way the spare config from a
       * lost enable race is ever cleaned up.
       *
       * QUIET WHERE THERE IS NOTHING OF OURS TO DELETE, because removing an app has to be able to
       * happen twice. An app can be removed, re-enabled and removed again, two administrators can
       * press the button together, and an app enabled before this deployment created configs at all
       * has none to drop. In every one of those the end state is the one that was asked for, so a
       * throw would report a failure while the caller got exactly what they wanted.
       *
       * AND QUIET USED TO MEAN QUIET OVER A CONFIG THAT WAS STILL STANDING, which is the failure
       * being closed here. "Nothing of ours" and "nothing at all" are not the same state, and the
       * listing could not tell a caller which one it was in: rename a config in Composio's
       * dashboard — drop the suffix, or edit the app's title past it — and every decision in this
       * file stops recognising the object it made. `ensureAuthConfig` would create a second beside
       * it, `authorize` would refuse against it, and this returned normally, after which
       * `removeServer` deleted the app's row. The config and every grant made against it outlive
       * the removal with nothing in this deployment naming them, and an administrator is told the
       * app was withdrawn.
       */
      const { held, ours, unreadable } = await configsFor(toolkit);
      if (ours.length === 0 && held.length > 0) {
        /*
         * REPORTED, NOT DELETED AND NOT SWALLOWED, AND THE THIRD OPTION IS THE ONLY HONEST ONE.
         *
         * Deleting anyway is the worse half of the same guess {@link madeHere} exists to stop: a
         * row with a readable name that does not carry the suffix is as likely to be an operator's
         * own dashboard work — their scopes, their tool restrictions, and every account anybody
         * connected against it — as it is to be ours under a new name. Nothing in the row tells
         * them apart, which is why nothing here chooses.
         *
         * WHICH IS THE SAME REASONING AS THE UNREADABLE NAME IN {@link readableConfigs} AND NOT THE SAME
         * CASE. There the ambiguity is about ADDRESSING: the field that decides ownership did not
         * arrive, so no row can be sorted and the removal cannot begin. Here every name arrived and
         * every row is legible; what is in doubt is whether this deployment's own config is among
         * them under a title somebody edited. So the refusal is narrower than that one — it fires
         * only where the removal found nothing it could claim, and stays quiet where a config of
         * ours was found and dropped beside somebody else's, which is the contract
         * {@link ComposioBroker.deleteAuthConfig} states.
         *
         * IT IS A BLOCK, AND THE BLOCK IS THE POINT. The app's row survives this throw —
         * `removeServer` deletes it only after this returns — so the app stays on its Plugins page
         * and stays removable, which is the one thing a silent success took away. The remedy is an
         * operator's and it is one act in a dashboard: rename the config back so it ends with the
         * suffix and remove the app again, which finishes the withdrawal, or satisfy yourself that
         * it is your own and delete it there, which is the only way anything can tell this
         * deployment that the config it made is genuinely gone.
         *
         * A COUNT AND THE SUFFIX, because together they are the whole of what an operator has to
         * look at: how many objects are standing, and the exact string that would have claimed
         * them. The names are not quoted — a config's title is an app name an administrator typed
         * and this file's refusals quote no vendor field it does not have to.
         *
         * AND IT CLAIMS NOTHING ABOUT WHAT THIS DEPLOYMENT ONCE MADE. An app enabled before this
         * deployment created configs at all never had one, which the quiet case above names, so a
         * sentence opening "the config this deployment made" would be a guess in the one place a
         * guess is what is being refused. What is said is only what was just read.
         */
        /*
         * AND AN UNREADABLE ROW IS ITS OWN CLAUSE HERE FOR THE REASON IT IS ONE BELOW, which is the
         * half this refusal was missing. `readableConfigs` sorts EVERY row into one of two piles, so
         * "legible and carrying nobody's suffix" and "not legible at all" are two facts about one
         * listing and arrive together as readily as either arrives alone. Written as a throw that
         * names only the first, the sentence closed by promising that taking the unclaimed config
         * out of the dashboard leaves this app with nothing standing "after which the removal goes
         * through" — and with a row in the other pile that is false: the next press meets the
         * refusal at the end of this method, raised over exactly those rows. An operator sent to do
         * one act and told it finishes the job is the one thing a refusal must not do, and the
         * clause that would have said otherwise was suppressed by a branch about different rows.
         */
        const alsoUnreadable =
          unreadable.length > 0
            ? ` Composio also described ${unreadable.length} more of its ${toolkit} authorization configs with no id or no name, so one of those may be this deployment's own under an answer it could not read: until those are read in Composio's own dashboard too, neither reading settles what is standing and the removal does not go through on the strength of the one above alone.`
            : "";
        throw new BrokerRefusalError(
          `Removing ${toolkit} found none of this deployment's own authorization configs at Composio, and Composio holds ${held.length} for ${toolkit} whose name does not carry ${CONFIG_SUFFIX} — so nothing was deleted and the app has not been withdrawn, rather than a config this deployment cannot show is its own being deleted along with every account connected against it. Nothing here can tell one of ours, renamed in Composio's dashboard, from an operator's own work. If it is this deployment's, the grants made against it are still live, and renaming it to end with ${CONFIG_SUFFIX} lets removing the app again withdraw them. If it is an operator's, only taking it out of that dashboard leaves this app with nothing standing, after which the removal goes through.${alsoUnreadable}`,
          unreadable.length > 0
            ? { cause: everyRefusal(unreadable) }
            : undefined,
        );
      }

      /*
       * AND A LISTING WHOSE ONLY ROWS ARE UNREADABLE IS ITS OWN STATE, WHICH IS THE BRANCH THE
       * OTHER THREE CALLERS HAVE AND THIS ONE DID NOT.
       *
       * `readableConfigs` sorts every row into one of two piles, so "nothing legible at all" is a
       * listing where `held` is empty and `unreadable` is not — which the branch above cannot reach,
       * because it requires `held.length > 0`. What was left to answer it was the partial-withdrawal
       * throw at the end of this method, reached with an empty `ours`: "Composio removed 0 of this
       * deployment's 0 authorization configs for linear and the app has not been fully withdrawn."
       * Both figures are counts of a set nothing read, and "fully" asserts that some of it was
       * withdrawn. Nothing was. The only finding is the rows, and their remedy is a reading in
       * Composio's dashboard rather than the button that was just pressed — it will be exactly as
       * unreadable next time.
       *
       * STILL A REFUSAL, WHICH IS THE HALF THAT DOES NOT MOVE. `removeServer` deletes the app's row
       * only after this returns, so the app stays on its Plugins page and stays removable; a quiet
       * return here would file the app away over rows that may be this deployment's own configs,
       * holding live grants, under an answer it could not read.
       */
      if (ours.length === 0 && unreadable.length > 0) {
        throw new BrokerRefusalError(
          `Composio described ${unreadable.length} of its authorization configs for ${toolkit} in a way this deployment cannot read and none of the rest is one it made, so whether any of them is this deployment's own is not something it can tell and nothing was deleted. The app has not been withdrawn, rather than a config this deployment cannot show is its own being deleted along with every account connected against it: reading those rows in Composio's own dashboard is what says whether anything this deployment made is still standing. ${VENDOR_SHAPE_REMEDY}`,
          { cause: everyRefusal(unreadable) },
        );
      }

      /*
       * THE REPLY IS AWAITED AND DROPPED, AND THAT IS NOT THE ASKED-VS-DONE GAP IT LOOKS LIKE.
       * `AuthConfigDeleteResponse` has no `success` field to read — see the declaration on
       * {@link ComposioVendor} for the citation and for what its one optional field means. A throw
       * is the whole of what this call can report, which is why `askForEach` collecting throws is
       * the whole of what is checked.
       */
      const refused = await askForEach(ours, (config) =>
        askVendor(
          {
            outcome: `one of this deployment's authorization configs for ${toolkit} was not removed`,
            app: toolkit,
          },
          () =>
            vendor.authConfigs.delete(config.id, { revoke_on_delete: true }),
        ),
      );
      if (refused.length > 0 || unreadable.length > 0) {
        /*
         * LOUD, because the caller is `removeServer` and the thing it is in the middle of is taking
         * an app away from everybody. A config left standing is a live grant that the removal was
         * supposed to end, and the app's row is deleted after this returns — so a swallowed failure
         * here is the one state nothing in this deployment can find again. The count is the whole
         * message: an operator who can see that one of two configs went knows that pressing remove
         * again finishes the job rather than repeating it. Every refusal the loop met travels as
         * `cause` — see {@link everyRefusal} — because the count is deliberately all the sentence
         * says, which leaves the reasons nowhere else to live.
         *
         * AND AN UNREADABLE ROW LANDS HERE RATHER THAN AHEAD OF THE DELETES, which is the half that
         * moved. Every config of ours is dropped first and the rows that could not be sorted are
         * reported after — {@link readableConfigs} says why at length: refusing before the first
         * delete meant one unreadable row made an app permanently unremovable, with the readable
         * configs of ours standing the whole time. It is still a refusal, so `removeServer` does
         * not delete the app's row and the app stays on its Plugins page.
         *
         * TWO CLAUSES BECAUSE THEY ARE TWO REMEDIES. A config Composio refused is one a second press
         * reaches. A row it described with no id or no name is not — it will be exactly as
         * unreadable next time — so the only instruction that helps names the dashboard rather than
         * the button the operator just pressed.
         */
        const removed = ours.length - refused.length;
        const left: string[] = [];
        if (refused.length > 0) {
          left.push("Removing it again asks only for what is left.");
        }
        if (unreadable.length > 0) {
          left.push(
            `Composio described ${unreadable.length} more of its ${toolkit} authorization configs with no id or no name, so nothing here can tell whether one of those is this deployment's own under an answer it could not read: reading them in Composio's own dashboard is what says whether anything this deployment made is still standing.`,
          );
        }
        throw new BrokerRefusalError(
          `Composio removed ${removed} of this deployment's ${ours.length} authorization configs for ${toolkit} and the app has not been fully withdrawn. ${left.join(" ")}`,
          { cause: everyRefusal([...refused, ...unreadable]) },
        );
      }
    },
  } satisfies Pick<
    ComposioBroker,
    "listApps" | "ensureAuthConfig" | "deleteAuthConfig"
  >;
}
