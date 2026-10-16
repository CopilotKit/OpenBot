import {
  type BrokerField,
  BrokerRefusalError,
  type ComposioBroker,
  flagOf,
} from "../broker";
import { vendorSentence } from "../composio";
import {
  askVendor,
  named,
  sent,
  statusOf,
  textOf,
  unreadableForm,
  VENDOR_SHAPE_REMEDY,
} from "../composio-vendor";
import type { ClientContext } from "./context";
import { STATUSES_NAMED } from "./model";

/** Apps connected by fields a person types in rather than by a redirect. */
export function fieldMethods(context: ClientContext) {
  const { vendor, configsFor } = context;
  return {
    /**
     * What the app itself says it wants typed in, mapped onto the boxes a form can draw.
     *
     * READ A STEP AT A TIME OFF `unknown`, for the reason every other vendor read here is: the
     * detail's `auth_config_details` is copied across verbatim, so a mode that is not a list and a
     * field row that is not an object are both shapes the wire can send.
     *
     * AND EVERY ONE OF THOSE STEPS REFUSES RATHER THAN ANSWERING `[]`, WHICH IS WHAT
     * {@link unreadableForm} IS FOR AND WHY IT IS ONE SENTENCE FOR ALL OF THEM. `[]` here says one
     * thing and one thing only: this app's scheme publishes nothing to fill in, which is a true
     * thing about a real app. Every step of this read used to answer it for a shape it could not
     * make sense of as well — a `fields` that is not an object, an initiation block that arrived as
     * the rows that used to sit inside it, a `required` that stopped being a list — so an app that
     * asks for nothing and an answer nothing here can open were the same empty form in the browser,
     * and the argument two paragraphs down for why that form must never be drawn applied to both.
     *
     * AND A SCHEME THIS APP NO LONGER PUBLISHES IS A THIRD ANSWER AGAIN, WITH A REMEDY OF ITS OWN.
     * The scheme is the RECORDED one and is never re-derived — that is the whole point of the
     * column, and the store's own column comment says so — so "Composio does not publish this mode
     * for this app" is exactly the drift between the row and the vendor that recording it
     * anticipates, and it used to surface as a form with no boxes in it. A person presses submit
     * on that form, {@link ComposioBroker.connectWithFields} creates a connection
     * carrying no credential at all, Composio answers `ACTIVE` because it does not grade what it is
     * given, and the first call made with the account is what discovers anything is wrong. An empty
     * form is also, from the person's end, a box they cannot fill in. So the two states are told
     * apart here: no such mode refuses and names the recorded one — an administrator's remedy,
     * because the recorded scheme is only theirs to rewrite — while a mode that exists and
     * publishes nothing visible still answers `[]`, and a mode whose published shape cannot be read
     * refuses with the upgrade that is the only thing which fixes a vendor changing shape.
     *
     * REQUIRED AND OPTIONAL IN THAT ORDER, because the order is what a person reads down. The
     * vendor publishes them as two lists and the required ones are the ones that stop the form; a
     * form that interleaved them, or put the optional base-url box above the key, would be asking
     * somebody to hunt for the field they came to fill in.
     */
    async connectionFields({ toolkit, authScheme }): Promise<BrokerField[]> {
      const detail = await askVendor(
        {
          outcome: `what ${toolkit} asks for could not be read, so there is nothing to show`,
          app: toolkit,
        },
        () => vendor.toolkits.retrieve(toolkit),
      );

      /*
       * THE ANSWER IS AN OBJECT BEFORE ANYTHING IS READ OFF IT, and the guard is not ceremony.
       * `("perplexityai").auth_config_details` is `undefined` rather than a throw, so a retrieve
       * that answered a bare string reached the refusal below wearing the sentence about a mode the
       * app has stopped publishing — about an answer that had no app in it at all.
       */
      if (
        typeof detail !== "object" ||
        detail === null ||
        Array.isArray(detail)
      ) {
        throw unreadableForm(
          detail,
          `Composio's own description of ${toolkit}`,
        );
      }

      /*
       * AND THE LIST OF MODES IS THE SAME TWO ANSWERS ONE FIELD IN. An `auth_config_details` that
       * is not a list became no modes at all, and no modes means the recorded one is not among
       * them — so an answer this deployment could not read arrived as the drift the refusal below
       * is written about, with a remedy that cannot work on it.
       */
      const listed = detail.auth_config_details ?? [];
      if (!Array.isArray(listed)) {
        throw unreadableForm(
          detail.auth_config_details,
          `the connection modes ${toolkit} publishes`,
        );
      }

      /*
       * AND A MODE THAT IS NOT A DOCUMENT IS THE SAME TWO ANSWERS ONE STEP FURTHER IN. `("API_KEY")
       * .mode` is `undefined` rather than a throw, so an entry that stopped being an object compared
       * unequal to the recorded scheme exactly as an app that had dropped it would, and the refusal
       * below sent an administrator to remove the app and add it again — against a list whose next
       * reading is the same unreadable shape, so the re-add records the same word and the app comes
       * back refusing identically.
       *
       * AN ENTRY THAT IS ABSENT IS NOT THAT AND IS NOT REFUSED: a hole in the list is a mode the
       * vendor left out, which is simply not the mode being looked for, and the sentence below is
       * the true one about it.
       *
       * AND THE UNREADABLE ONES ARE COLLECTED RATHER THAN THROWN, WHICH IS THE PARTITION-RATHER-
       * THAN-THROW DISCIPLINE THIS FILE ALREADY APPLIES AT {@link readableConfigs} AND
       * {@link withdrawableAccounts}, ARRIVING AT THE ONE READER THAT WAS STILL EAGER. This was a
       * `.map()` that threw, so EVERY entry was validated before `.find()` ever selected the mode
       * being asked for — and one drifted entry anywhere in the list took down a mode that was
       * perfectly readable. An app enabled as `API_KEY` whose retrieve answers
       * `[{ mode: "API_KEY", fields: {…complete…} }, "OAUTH2"]` has an intact mode at index 0 and a
       * bare string at index 1, and everybody pressing Connect on that app was blocked permanently
       * — "no form was drawn … upgrading @composio/core is what fixes it" — over a mode nobody
       * asked about. Nothing they can reach changes the next reading, which is the same shape.
       *
       * SO THE WANTED MODE IS LOOKED FOR FIRST AND THE REST ARE REPORTED ONLY IF IT IS NOT FOUND.
       * Where it is found, an entry this deployment could not read is a mode it was not asked to
       * draw. Where it is NOT found, the unreadable entries are the reason the refusal must not be
       * the drift sentence below: one of them may BE the mode, and telling an administrator the app
       * has dropped it would send them to re-add against a list that reads identically next time.
       */
      const unreadableModes: unknown[] = [];
      let mode: { mode?: unknown; fields?: unknown } | undefined;
      for (const [index, candidate] of listed.entries()) {
        if (candidate === undefined || candidate === null) continue;
        if (typeof candidate !== "object" || Array.isArray(candidate)) {
          unreadableModes.push({ index, candidate });
          continue;
        }
        const entry = candidate as { mode?: unknown; fields?: unknown };
        /*
         * AND AN ENTRY WHOSE OWN MODE CANNOT BE READ IS UNREADABLE TOO, WHICH THE SHAPE TEST ABOVE
         * DOES NOT CATCH. `{ mode: null, fields: {…} }` is an object and not an array, so it passes
         * that guard, and `textOf` then answers null — which never equals a scheme name, so the
         * loop simply moved on and the entry was never collected. With the wanted mode absent from
         * the rest of the list, `unreadableModes` was empty, the vendor-shape refusal below was
         * skipped, and control reached the ADMINISTRATOR'S refusal: Composio no longer publishes a
         * connection of this scheme for this app. That is precisely the sentence this walk exists
         * to keep off an entry that MAY BE the mode — it sends an administrator to remove and
         * re-add against a list that reads identically next time.
         *
         * THE NAME IS WHAT MAKES AN ENTRY CLASSIFIABLE, so an entry without a readable one sits
         * exactly where an entry that is not a document sits: this deployment cannot say whether it
         * is the mode being looked for. A mode the vendor genuinely left out is a HOLE in the list,
         * which is the `undefined`/`null` candidate skipped above, and is a different fact with a
         * different true sentence.
         */
        if (textOf(entry.mode) === null) {
          unreadableModes.push({ index, candidate });
          continue;
        }
        /*
         * THE MODE IS A SCHEME NAME, SO IT IS THE TRIMMED ONE — the rule {@link labelsOf} states
         * for every other scheme this file reads and the one site that was comparing the raw value.
         * A scheme is the NAME of a flow: it is matched against the word recorded on the app's row
         * when somebody enabled it, so a padded `" API_KEY "` is the app's own mode wearing whatever
         * the wire wrapped it in. Read raw it compared unequal to the recorded word exactly as a
         * mode the app had DROPPED would, and the refusal below then sent an administrator to remove
         * the app and add it again — which records the same padded word and comes back refusing
         * identically, which is a loop that cannot close.
         */
        if (textOf(entry.mode) === authScheme) {
          mode = entry;
          break;
        }
      }

      /*
       * AND A MODE THAT WAS NOT FOUND BESIDE ENTRIES THAT COULD NOT BE READ IS NOT "THE APP DROPPED
       * IT". This is the refusal an eager walk would have raised, reached only where it is the true
       * thing to say: the wanted mode is not among what this deployment CAN read, and what it cannot
       * read is where the answer may be. It is the vendor's shape that changed, so it carries the
       * vendor's remedy rather than the administrator's.
       */
      if (mode === undefined && unreadableModes.length > 0) {
        throw unreadableForm(
          unreadableModes[0],
          `${unreadableModes.length} of the ways of connecting ${toolkit}, one of which may be the ${authScheme} one`,
        );
      }
      /*
       * THE REMEDY IS AN ADMINISTRATOR'S BECAUSE THE RECORDED SCHEME IS ONLY THEIRS TO REWRITE.
       * Nothing a person pressing Connect can do changes which mode this app was enabled as, and
       * nothing on this path may quietly pick a different one — a form drawn for whatever Composio
       * publishes today, in front of an authorization config created for the word on the row, is
       * the same disagreement one layer further in. Removing the app and adding it again is the one
       * path that records the scheme afresh, so it is the one named.
       */
      if (mode === undefined || mode === null) {
        throw new BrokerRefusalError(
          `Composio no longer publishes a ${authScheme} connection for ${toolkit}, and ${toolkit}'s authorization config here was created as ${authScheme}, so there is nothing to ask this person for — and an empty form is a box they cannot fill in and a connection carrying no credential at all. An administrator removing the app on its Plugins page and adding it again is what records the scheme Composio publishes for it now.`,
        );
      }
      /*
       * EVERY REMAINING STEP TELLS AN ABSENCE FROM AN ANSWER IT CANNOT READ, which is the whole of
       * what {@link unreadableForm} is for. A mode that publishes no `fields`, no initiation block
       * or an empty list of rows is saying it asks a person for nothing, and `[]` is the true
       * reading of that. A `fields` that is not an object, an initiation block that arrived as the
       * list of rows that used to sit inside it, and a `required` that stopped being a list are
       * three different vendor changes, none of which is that sentence, and all three used to be
       * written down as it.
       */
      const asked = mode.fields ?? {};
      if (typeof asked !== "object" || asked === null || Array.isArray(asked)) {
        throw unreadableForm(
          mode.fields,
          `the fields ${toolkit}'s ${authScheme} connection publishes`,
        );
      }
      const initiation =
        (asked as { connected_account_initiation?: unknown })
          .connected_account_initiation ?? {};
      if (
        typeof initiation !== "object" ||
        initiation === null ||
        Array.isArray(initiation)
      ) {
        throw unreadableForm(
          (asked as { connected_account_initiation?: unknown })
            .connected_account_initiation,
          `what ${toolkit} asks for when a connection to it is made`,
        );
      }

      /*
       * THE REQUIRED LIST AND THE OPTIONAL ONE ARE ASKED SEPARATELY, because they are separately
       * published and a guard on one says nothing about the other — and the required one is the one
       * that stops a form, so a required list read as empty is a form a person can submit blank.
       */
      const published = initiation as {
        required?: unknown;
        optional?: unknown;
      };
      const rowsOf = (value: unknown, which: "required" | "optional") => {
        const asRows = value ?? [];
        if (!Array.isArray(asRows)) {
          throw unreadableForm(
            value,
            `the ${which} fields ${toolkit} asks a person to fill in`,
          );
        }
        return asRows;
      };
      /*
       * REQUIRED FIRST, WHICH IS AN ORDER RATHER THAN A CONVENIENCE — see the deduplication below,
       * where it is what decides which of two rows sharing a name survives.
       */
      const rows = [
        ...rowsOf(published.required, "required"),
        ...rowsOf(published.optional, "optional"),
      ];

      const drawn = rows
        .filter((row, index) => {
          /*
           * THE ROW IS AN OBJECT BEFORE A FIELD IS READ OFF IT, WHICH IS THE ONE CONTAINER IN THIS
           * FILE THAT WAS NOT ASKED.
           *
           * Every other one is: the catalogue row, its `meta`, each category, the action row, the
           * toolkit detail, the list of modes, the mode itself, the `fields` object and the
           * initiation block inside it. The rows hanging off that block were not, and nothing here
           * throws for it — `("generic_api_key").user_visible` is `undefined`, so a row that arrived
           * as a string passes the visibility read as an ordinary shown field and reaches the type
           * guard below, which refuses it with "Connecting this app is not something this deployment
           * can offer yet". That is a verdict about the APP, it carries no remedy at all, and the
           * thing it describes is a package whose shape moved. The remedy for that is the one
           * {@link unreadableForm} ends every other step of this read with.
           *
           * ABSENT IS NOT EXEMPTED HERE, WHICH IS WHERE THIS DIFFERS FROM THE MODE LIST ABOVE. A
           * hole in THAT list is simply a mode the vendor left out and the `find` below it says the
           * true thing about it; a hole in THIS one is a field the form would silently be one box
           * short of, and there is no reading of `null` under which a person is being asked for
           * nothing in particular.
           */
          if (typeof row !== "object" || row === null || Array.isArray(row)) {
            throw unreadableForm(
              row,
              `field ${index + 1} of what ${toolkit}'s ${authScheme} connection asks a person to fill in`,
            );
          }

          /*
           * A FIELD COMPOSIO HIDES IS ONE COMPOSIO FILLS IN, AND `!== false` HID THE WRONG STATE.
           * An absent `user_visible` means show it, which is most of the catalogue and stays. A
           * present `"false"` is Composio saying the opposite and reading as "show it" — a box
           * drawn for a tenant id or an instance name the person has no way to know, which they
           * then leave blank and submit as an empty value under a key the app does read.
           */
          const visible = flagOf(row?.user_visible, true);
          if (visible === null) {
            throw new BrokerRefusalError(
              `${toolkit} describes ${textOf(row?.displayName) ?? textOf(row?.name) ?? "one of the values it asks for"} with ${sent(row?.user_visible)} where the flag saying whether that field is shown to the person filling the form in belongs. A field Composio hides is one Composio fills in itself, so a flag this deployment cannot read is the difference between a form and a form with a box nobody can answer. ${VENDOR_SHAPE_REMEDY}`,
            );
          }
          return visible;
        })
        .map((row) => {
          /*
           * A TYPE THIS DEPLOYMENT CANNOT DRAW IS A REFUSAL RATHER THAN A TEXT BOX. Every required
           * field measured across the catalogue is a plain string, so this is a guard against the
           * vendor rather than a routine case — and the failure it prevents is somebody typing a
           * path into a box labelled Certificate and being told they are connected.
           *
           * AND THE NAME IS IN THE SAME GUARD, because it is the least guarded field here and the
           * only one that travels. `label`, `help` and `default` all pass through {@link textOf}
           * and are read by a person; the name is sent back to Composio verbatim and is the key
           * {@link ComposioBroker.connectWithFields} spreads into the connection's `val`. Coerced
           * with `String(...)`, a row carrying `type: "string"` and no name drew a box literally
           * called "undefined" and then submitted whatever was typed in it under that key — a value
           * no app reads, in a connection Composio accepts.
           */
          /*
           * AND THE TYPE IS READ THE WAY THE NAME BESIDE IT IS, which is the half this guard did
           * not have. `row.type !== "string"` was the RAW value while the name one line up goes
           * through {@link textOf}, so a padded `" string "` was refused with "a box this
           * deployment can draw is a string" — about a field whose type IS a string, in a sentence
           * whose own words say so. A type is a keyword and not prose: the value is the word, and
           * the padding is whatever the wire wrapped it in.
           */
          const name = textOf(row?.name);
          if (textOf(row?.type) !== "string" || name === null) {
            throw new BrokerRefusalError(
              `${toolkit} asks for ${textOf(row?.displayName) ?? "a value"} as ${sent(row?.type)} under the name ${sent(row?.name)}, which cannot be filled in here: a box this deployment can draw is a string, and a box whose answer can be sent back has a name. Connecting this app is not something this deployment can offer yet.`,
            );
          }

          /*
           * AND ONE NAME IS THE PROTOCOL'S RATHER THAN THE APP'S, WHICH IS THE SAME GUARD ONE STEP
           * FURTHER ON: a box whose answer cannot be sent must not be drawn.
           *
           * {@link ComposioBroker.connectWithFields} puts what somebody types into the `val` of the
           * connection state, beside the `status` that says what is being created — the shape the
           * vendor's own `AuthScheme` builder assembles (`@composio/core` 0.18.1,
           * `src/models/AuthScheme.ts:84-94`). `status` is therefore a word the call itself owns,
           * and BOTH answers to a field published under that name are wrong. Sent, it replaces the
           * state this deployment is asking Composio to create, from a request that looks like an
           * ordinary connection. Withheld — which is what that call now does, writing its own word
           * last — it is a box somebody filled in whose value no app will ever read, the very
           * failure the name guard directly above exists to prevent.
           *
           * SO THE APP IS REFUSED RATHER THAN PART OF ITS FORM, and the sentence names the field,
           * which is the vendor's own text read off the list just fetched and the only thing an
           * administrator can act on.
           */
          if (name === "status") {
            throw new BrokerRefusalError(
              `${toolkit} publishes a field called ${name}, which is the word this deployment uses to tell Composio what state a connection is being created in, so a value typed into it either overwrites that word or is never sent at all. Neither is a box worth drawing. ${VENDOR_SHAPE_REMEDY}`,
            );
          }
          /*
           * THE TRIMMED VALUE IS WHAT REACHES THE FORM, because the trimmed value is what was
           * judged. This tested `textOf(row.default)` and emitted `String(row.default)`, so a
           * default Composio padded passed the test on its trimmed form and arrived in the box with
           * its padding — the same disagreement between guard and return that {@link vendorSentence}
           * was corrected for, one field away from a value somebody then submits as typed.
           */
          const suggested = textOf(row.default);

          /*
           * THE TWO FLAGS THAT DESCRIBE THE BOX ARE READ THE SAME WAY THE TYPE AND THE NAME ARE,
           * AND FOR THE SAME REASON. `row.required === true` and `row.is_secret === true` answered
           * "no" to an absent flag, which is right and is most of the catalogue, and answered "no"
           * to a PRESENT `"true"` as well — the vendor's yes and the vendor's silence collapsed
           * into one value at the point either is acted on.
           *
           * `required` IS THE SHARPER OF THE TWO BECAUSE THE CONNECT ROUTE NOW ENFORCES IT. The
           * guard that refuses a submission omitting a required field reads this boolean and no
           * other, so a vendor publishing `"true"` would make that guard wave through the exact
           * submission it exists to refuse: an account created with the credential missing out of
           * it, which Composio answers `ACTIVE` for because it does not grade what it is given, and
           * which the first tool call is the first thing to notice.
           *
           * `is_secret` IS THE QUIETER ONE AND NOT THE SMALLER ONE. Read as a no, the box for
           * somebody's API key is drawn as ordinary text: typed in plain sight, left on the screen,
           * and offered to whatever fills fields in.
           */
          const required = flagOf(row.required, false);
          if (required === null) {
            throw new BrokerRefusalError(
              `${toolkit} describes ${name} with ${sent(row.required)} where the flag saying whether that field has to be filled in belongs. Read as a no — which is what a value this deployment cannot read would otherwise become — a field ${toolkit} requires is drawn as one a person may leave blank, and what they submit is an account Composio accepts with the credential missing out of it. ${VENDOR_SHAPE_REMEDY}`,
            );
          }

          const secret = flagOf(row.is_secret, false);
          if (secret === null) {
            throw new BrokerRefusalError(
              `${toolkit} describes ${name} with ${sent(row.is_secret)} where the flag saying whether that field holds a secret belongs. Read as a no, the box is drawn as ordinary text, so whatever goes in it — a key, a token — is typed in plain sight and left on the screen. ${VENDOR_SHAPE_REMEDY}`,
            );
          }

          return {
            name,
            label: textOf(row.displayName) ?? name,
            help: textOf(row.description) ?? "",
            required,
            secret,
            ...(suggested === null ? {} : { default: suggested }),
          };
        });

      /*
       * ONE NAME IS ONE BOX, HOWEVER MANY OF COMPOSIO'S LISTS PUBLISHED IT — the half
       * {@link readableConfigs} and {@link withdrawableAccounts} already carry, arriving here a
       * wave late and for a sharper reason than either.
       *
       * THE NAME IS A KEY AND NOT A LABEL. `required` and `optional` are published separately, so
       * nothing at Composio stops one field appearing in both, and concatenated as they arrive that
       * app draws TWO boxes carrying the same name — with different labels, different help and
       * different defaults, because the two rows are different rows. A person fills both in; the
       * form collects what they typed under the field's name; the second box silently overwrites
       * the first, and which of the two values reached the vendor is not recorded anywhere. The
       * same name twice also passes straight through the connect route's published-names check, so
       * nothing downstream is in a position to notice.
       *
       * THE FIRST SIGHTING KEEPS ITS PLACE, as it does for configs and accounts — and here that is
       * a decision as well as a convention, because required is spread first: a name published in
       * both lists is drawn as the REQUIRED one. That is the safe direction. Read as optional, a
       * credential the app cannot do without becomes a box the connect route lets somebody leave
       * blank, and what that makes is the credential-less account that route's required guard
       * exists to refuse.
       */
      /*
       * `drawnNames` RATHER THAN `named`, WHICH IS ONLY A RENAME AND IS WORTH ONE LINE — for the
       * second time in this file, and this one came back through a merge after the first had been
       * diagnosed. This binding shadowed the module helper {@link named} for the whole of this
       * method, so the function every refusal in the file quotes a vendor enum through was
       * unreachable from the one place a new refusal here would reach for it, and an edit that did
       * would have been calling a Set. `resolved.toolkit`'s reader says the same thing about the
       * same word one method up; nothing is wrong today, and the next change to this block is what
       * both renames are for.
       */
      const drawnNames = new Set<string>();
      return drawn.filter((field) => {
        if (drawnNames.has(field.name)) return false;
        drawnNames.add(field.name);
        return true;
      });
    },

    /**
     * One person's account made from what they typed, and the ONE call here that drops its error.
     *
     * THIS IS THE SINGLE PLACE THIS FILE'S CAUSE-CARRYING RULE REVERSES, AND IT SAYS SO ON PURPOSE.
     * The rule the module comment states and every other path keeps is that a vendor error is never
     * logged and always carried as `cause`, precisely because the object holds the request it was
     * made for and whoever is reading a log rather than a page deserves it. On every other call
     * that request is a link mint or a delete. On this one it is somebody's API key: the body below
     * carries the value they pasted into the form, and an `APIError` out of a create carries the
     * body. So the catch reads the vendor's sentence through the one door {@link vendorSentence}
     * owns and then drops the object entirely — not attached, not rethrown, nothing left for a
     * handler further out to serialize.
     *
     * WHAT THAT COSTS IS THE DIAGNOSTIC TRAIL ON THE FLOW PEOPLE MOST OFTEN MISTYPE, AND THE COST IS
     * ACCEPTED KNOWINGLY. A key pasted with a newline, a token from the wrong workspace, a secret
     * for the staging tenant — these are the ordinary failures here, and this leaves nothing behind
     * about any of them. What an operator gets instead is Composio's own sentence and the request
     * id inside it, which is what Composio's dashboard searches on: enough to ask the vendor about
     * that attempt, and not enough to rebuild it here. A `cause` that made the next mistyped key
     * easier to explain would put every correctly typed one in a log for as long as the log is kept.
     *
     * NOT {@link askVendor}, WHICH IS THE SAME DECISION SEEN FROM THE OTHER SIDE. That function is
     * what every other vendor call in this file goes through, and every refusal it builds attaches
     * the original — see {@link vendorRefusal}, where the `cause` is the point. Routing this call
     * through it would be the rule applying here by default, which is the one place it must not.
     *
     * NO VERIFICATION HERE, AND THE ABSENCE IS NOT AN OVERSIGHT. Composio does not grade a submitted
     * key: a connection created with an obviously wrong value comes back `ACTIVE`. Whether the
     * credential works is settled by making a call with it, which is why this answers the
     * `accountId` — so whoever does that can take back exactly the account it made and nothing else.
     * See {@link ComposioBroker.revokeAccount}.
     */
    async connectWithFields({
      account,
      toolkit,
      authScheme,
      values,
    }): Promise<{ accountId: string }> {
      const userId = account.vendorUserId;
      /*
       * THIS DEPLOYMENT'S OWN CONFIG, FOR THE REASON {@link ComposioBroker.authorize} READS ONE: an
       * account is a lasting attachment to whatever config it was made against, so attaching
       * somebody to an operator's hand-made config — scopes this deployment cannot see, tool
       * restrictions it cannot read, an object it must not delete — is not a guess that can be
       * corrected afterwards.
       */
      const { ours, unreadable } = await configsFor(toolkit);
      if (ours.length === 0) {
        /*
         * A ROW THIS FILE COULD NOT READ IS NOT AN APP WITH NO CONFIG, AND IT IS THE SAME TWO
         * REMEDIES {@link ComposioBroker.authorize} TELLS APART. "Remove the app and add it again"
         * is right where the listing was legible and said none of these is ours, and wrong here:
         * the row that could not be sorted may BE ours, in which case the removal meets
         * {@link ComposioBroker.deleteAuthConfig}'s own refusal and the re-enable meets
         * `ensureAuthConfig`'s. That is an administrator sent round a loop that cannot close, and
         * this method used to hand them exactly that sentence.
         *
         * NO `cause` ON ANY OF THE REFUSALS IN THIS METHOD, which is the local rule rather than the
         * file's. Not one of the four refusals this config read can raise carries a vendor object at
         * all — they are this file's own reading of a listing — but attaching
         * `everyRefusal(unreadable)` here, as `authorize` correctly does, would put an error chain
         * on the one method whose call frame holds somebody's API key, and the whole of this
         * method's doc comment is about not doing that. The count is the finding, and the count is
         * in the sentence.
         */
        if (unreadable.length > 0) {
          throw new BrokerRefusalError(
            `Composio described ${unreadable.length} of its authorization configs for ${toolkit} in a way this deployment cannot read and none of the rest is one it made, so there is nothing it can show is its own to connect an account against and what was typed into the form was not sent anywhere. ${VENDOR_SHAPE_REMEDY}`,
          );
        }
        throw new BrokerRefusalError(
          `This deployment has no authorization config at Composio for ${toolkit}, so there is nothing to connect an account against and nothing was sent. An administrator removing the app on its Plugins page and adding it again creates one.`,
        );
      }

      /*
       * THE ENABLED ONE, WHICH IS THE SAME CHOICE {@link ComposioBroker.authorize} MAKES AND FOR ONE
       * REASON MORE. `configsFor` lists with `showDisabled: true` — it has to, or `ensureAuthConfig`
       * creates a second config beside one it cannot see — so `ours[0]` could perfectly well be a
       * DISABLED config, and an account created against one cannot work. Reading that state only
       * after the create is the wrong order on this path more than on any other: the body of that
       * request is the key somebody just pasted in, so the refusal has to arrive BEFORE the
       * credential leaves this process rather than after Composio has been handed it and declined.
       *
       * AND IT IS THE SAME CONFIG THE CONSENT PATH WOULD HAVE PICKED, which is the other half.
       * Two configs from a lost enable race, the first of them disabled, and `ours[0]` against
       * `find(ENABLED)` attach one app's accounts to two different configs depending on which door
       * a person came through — after which removing "the" config drops half of them.
       */
      const config = ours.find((held) => statusOf(held) === "ENABLED");
      if (!config) {
        /*
         * "DISABLED" IS ONLY THIS DEPLOYMENT'S CLAIM TO MAKE WHEN COMPOSIO MADE IT, for the reason
         * spelled out at length in {@link ComposioBroker.authorize}: the test above is
         * `=== "ENABLED"`, so a config with no status and a config wearing a word this deployment's
         * `@composio/core` has never heard of both fall through here, and telling an operator those
         * are disabled sends them to enable something that may already be enabled.
         */
        /*
         * AND TWO INDEPENDENT CLAUSES FOR THE REASON {@link ComposioBroker.authorize} GIVES AT
         * LENGTH, which is worth repeating here only because this block is a COPY of that one rather
         * than a call to it: the chain lived in both methods, so the suppression did too. A person
         * typing their key into an app holding one DISABLED config beside one unsettled row was told
         * to upgrade a package — while the act that would have got the key accepted, enabling the
         * disabled config in Composio's dashboard, went unsaid. It is not even that person's act,
         * which is exactly why the sentence has to carry it rather than choose.
         */
        const unsettled = ours.filter((held) => statusOf(held) !== "DISABLED");
        const left: string[] = [];
        const disabled = ours.length - unsettled.length;
        if (disabled > 0) {
          left.push(
            `Composio calls ${disabled} of this deployment's ${ours.length} authorization configs for ${toolkit} disabled, and an administrator can enable it in Composio's dashboard, or remove the app on its Plugins page and add it again.`,
          );
        }
        if (unsettled.length > 0) {
          const words = [
            ...new Set(unsettled.map((held) => named(held.status))),
          ];
          /*
           * AND THE TAIL COUNTS IN THE NUMBER'S OWN WORDS. "and 1 other words" was the unpluralised
           * spelling, in a sentence whose very next clause conjugates its own verb on the same
           * count — so the one refusal that has to be trusted about an authorization config could
           * not get its own arithmetic to read. See {@link STATUSES_NAMED} for why there is a tail
           * at all.
           */
          const shown = words.slice(0, STATUSES_NAMED);
          const unnamed = words.length - shown.length;
          const said =
            unnamed > 0
              ? `${shown.join(", ")} and ${unnamed} other word${unnamed === 1 ? "" : "s"}`
              : shown.join(", ");
          left.push(
            `Composio describes ${unsettled.length} of this deployment's ${ours.length} authorization configs for ${toolkit} as ${said}, which ${words.length === 1 ? "is" : "are"} neither ENABLED nor DISABLED, so whether an account connected against one could work is not something this deployment can tell. ${VENDOR_SHAPE_REMEDY}`,
          );
        }
        /*
         * AND THE ROWS NOTHING COULD SORT ARE THE THIRD CLAUSE, for the reason
         * {@link ComposioBroker.authorize} gives beside the identical one: a row whose id or name
         * never arrived may be a config of this deployment's that Composio calls ENABLED, so the
         * dashboard reading is a finding this sentence has and the disabled clause does not carry.
         * No `cause`, which is this method's own standing rule — the count is the finding and the
         * count is in the sentence, because the call frame this refusal is raised in holds somebody's
         * API key.
         */
        if (unreadable.length > 0) {
          left.push(
            `Composio described ${unreadable.length} of its authorization configs for ${toolkit} in a way this deployment cannot read, so whether one of THOSE is a config of this deployment's that Composio calls enabled is outside what either reading settles: reading those rows in Composio's own dashboard is what says whether there is one here to connect against at all. ${VENDOR_SHAPE_REMEDY}`,
          );
        }
        throw new BrokerRefusalError(
          `No authorization config this deployment holds at Composio for ${toolkit} could be shown to be enabled, so nothing was sent and what was typed into the form did not leave this deployment. ${left.join(" ")}`,
        );
      }

      let created: { id?: unknown };
      try {
        created = await vendor.connectedAccounts.create({
          auth_config: { id: config.id },
          connection: {
            user_id: userId,
            /*
             * THE SCHEME AND THE TYPED VALUES, IN THE SHAPE THE VENDOR'S OWN BUILDER ASSEMBLES.
             * `AuthScheme.APIKey` and its siblings all return `{ authScheme, val: { status:
             * ACTIVE, ...fields } }` (`@composio/core` 0.18.1, `src/models/AuthScheme.ts:84-94`),
             * and the field NAMES are Composio's own — published per app by
             * {@link ComposioBroker.connectionFields} and sent back verbatim, because a name this
             * file renamed on the way through is a box somebody filled in that no app ever reads.
             *
             * AND `status` IS THE PROTOCOL'S WORD, SO IT IS WRITTEN LAST. The vendor's builder
             * spreads the fields OVER it, which is safe only while no field is called `status` —
             * and the names in `values` are the vendor's own, so that is a fact about somebody
             * else's catalogue rather than an invariant of this call. Spread first and set after,
             * the one word saying what this request is asking Composio to create cannot be
             * displaced by a value arriving under the same name, whatever published it.
             *
             * WHICH IS THE SECOND OF TWO GUARDS AND NOT THE ONLY ONE. {@link
             * ComposioBroker.connectionFields} refuses to draw a box named `status` at all, so a
             * value under that name cannot come from a form, and the connect route sends only names
             * that list published. This method is callable without either, and what it protects is
             * the one field here that cannot be recovered from anything else in the request.
             */
            state: {
              authScheme,
              val: { ...values, status: "ACTIVE" },
            },
          },
        });
      } catch (error) {
        /*
         * ONLY THE SENTENCE LEAVES THIS BLOCK. `vendorSentence` is the one door in this deployment
         * for reading a vendor's own words, and reading it is the whole of what `error` is used
         * for: it is not attached, not rethrown and not named below this line.
         */
        const said = vendorSentence(error);
        throw new BrokerRefusalError(
          said === null
            ? `Composio did not accept the connection to ${toolkit} and said nothing this deployment can pass on. The failure arrived through this deployment's @composio/core with no sentence of Composio's on it, which is what an outage, a cancelled request and a reply the package could not read all look like from here — and the failure itself was dropped rather than recorded, because on this one call the object carrying it also carries what was typed into the form. Nothing was attached. Composio's own dashboard logs the attempt, and asking again is what settles whether the request ever landed.`
            : `Composio refused the connection to ${toolkit}: ${said} Nothing was attached. Nothing further about this attempt is kept here, because what the failure carried was the value typed into the form — the request id in Composio's own words above is what their dashboard searches on.`,
        );
      }

      /*
       * NO ID IS NOT A CONNECTION, HOWEVER THE REPLY READS. The id is the whole of what this method
       * answers and the only thing a caller can undo its own work with, so handing back an
       * `undefined` cast to a string would leave an account standing at Composio that nothing on
       * this deployment can name, made from a credential somebody typed a moment ago. The dashboard
       * is named because it is the only place that account can now be seen and removed.
       */
      const accountId = textOf(created?.id);
      if (accountId === null) {
        throw new BrokerRefusalError(
          `Composio answered the connection to ${toolkit} with no account id, so this deployment cannot name the account it just asked for and cannot take it back. An account may be standing at Composio over this: ${toolkit} in Composio's own dashboard is where it can be seen and removed. ${VENDOR_SHAPE_REMEDY}`,
        );
      }

      return { accountId };
    },
  } satisfies Pick<ComposioBroker, "connectionFields" | "connectWithFields">;
}
