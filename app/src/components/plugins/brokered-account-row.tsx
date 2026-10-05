import { IconArrowUpRight } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ConnectionFields } from "@/components/plugins/connection-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  type BrokerField,
  brokeredConnectionFieldsMutationOptions,
  confirmBrokeredConnectionMutationOptions,
  connectAccountMutationOptions,
  connectBrokeredWithFieldsMutationOptions,
  disconnectBrokeredMutationOptions,
  recheckBrokeredConnectionMutationOptions,
} from "@/lib/plugins/mutations";

/**
 * One person's own brokered account, on whichever screen is asking.
 *
 * Two screens draw this — the connector's admin page, where an administrator checks the setup they
 * have just finished, and that person's own connected-accounts page — and they drew it twice, forty
 * lines apiece, comment for comment. The cost was not the duplication: it was that both copies held
 * the same two defects, a disconnect that went on reading "Connected" and a deployment with no
 * Composio key that said nothing about it, and both had to be found twice to be fixed once.
 *
 * What genuinely differs between the two stays an argument. An administrator is told their setup is
 * complete without this row; a person is told which Bots can read them as them. The consent flow
 * returns to whichever screen started it. Everything else — what the row says while there is no
 * key, what the dot means, what disconnecting ends — is one answer and lives here.
 */

/**
 * What this person actually does to connect: click through a consent screen, type a secret, or
 * nothing at all.
 *
 * A coarser question than the scheme the app's authorization config was created as. The recorded
 * `authScheme` is a vendor literal — `OAUTH2`, `DCR_OAUTH`, `API_KEY`, `NO_AUTH` and the rest — and
 * a row that branched on it would be re-asking the same three-way question at every branch, each
 * copy free to forget a literal the others remembered.
 */
export type BrokeredAccountKind = "consent" | "fields" | "no-auth";

/** The schemes whose secret a person types, which is the whole of what `fields` means here. */
const FIELD_SCHEMES = ["API_KEY", "BASIC", "BEARER_TOKEN", "BASIC_WITH_JWT"];

/**
 * Which of the three a recorded scheme is.
 *
 * Everything that is not `NO_AUTH` and not one of the typed schemes is consent, including a scheme
 * this file has never heard of: the catalogue is the vendor's and it may name a new one tomorrow,
 * and sending somebody to a consent screen that turns out not to exist is a refusal they can read,
 * where an empty form is a box they cannot fill in.
 */
function kindOf(authScheme: string | null): BrokeredAccountKind {
  if (authScheme === "NO_AUTH") return "no-auth";
  return authScheme !== null && FIELD_SCHEMES.includes(authScheme)
    ? "fields"
    : "consent";
}

/** The row's state and the things it can do, from {@link useBrokeredAccount}. */
export type BrokeredAccount = {
  /** Whether this person's account is live, as the vendor last answered. */
  connected: boolean;
  /**
   * Whether this deployment holds a verdict that the account works, which is a different fact for
   * each kind and is NOT "a real call was made with this key".
   *
   * A different fact from `connected`, and the reason both are here. Composio does not check a
   * submitted key: a connection created with an obviously wrong value comes back ACTIVE and stays
   * ACTIVE, so `connected` for a key app is only that the vendor accepted the row.
   *
   * ON A CONSENT APP THERE IS NO PROBE BEHIND THIS. The confirm writes it true off the vendor's own
   * answer that the account is attached — a consent screen somebody completed is the check — and
   * migration 0038 backfilled every consent row that came before. So nothing here may read `true`
   * as evidence that a call was spent, nor offer an act that needs one.
   *
   * AND `false` IS A PLACEHOLDER AS MUCH AS A VERDICT. The store writes it unconditionally on every
   * key connection, whether or not the app publishes anything to check a key against, so nothing
   * here may explain the `false` off this field. Three states share this one word — nothing to try,
   * tried and passed, tried and refused — and {@link BrokeredAccount.probe} is what tells them
   * apart. Read the two together or not at all.
   */
  verified: boolean;
  /**
   * When that call was made, as the recorded instant. Null where none ever has been.
   *
   * Carried beside `verified` rather than derived from it, because a verification is a past tense
   * and a screen that says so has to say when: "verified" on its own reads as a present-tense fact
   * about a key that may have been revoked at the vendor an hour ago.
   */
  verifiedAt: string | null;
  /**
   * The action that check was spent on, as the last answer named it.
   *
   * THE THREE STATES BEHIND `verified` ARE THIS FIELD'S DOING, and the sentences below are written
   * off it rather than off the flag:
   *
   *   `null`      — nothing was tried: at the time of the check this app published nothing safe to
   *                 spend a key on. A fact about the app and not about the key, and about the app
   *                 THEN — whether it has anything to spend one on now is `checkable`'s question.
   *   a name, verified — the action ran in this person's account and the vendor took the key.
   *   a name, NOT verified — it ran and the app answered with a failure, and the account it ran in
   *                 is still there: a connect leaves it standing deliberately, a re-check because it
   *                 never withdraws one. The row exists, the check did not come back clean, and
   *                 something of theirs is standing at Composio. This is the state an operator has
   *                 to act on — and it is NOT a verdict about the key, because the envelope it is
   *                 read out of carries no status and no error code. See `BrokeredProbe`.
   *   `undefined` — NOT A FOURTH VERDICT BUT THE ABSENCE OF ONE. Nothing has said anything about a
   *                 probe for this row: a held connection, whose rows carry none of this, or an app
   *                 nobody has connected. Nothing may read it as either of the two the server sends.
   *
   * CARRIED BY THE READ AS WELL AS BY THE ANSWERS, which is what keeps the three states apart after
   * a reload. A re-check and a key handed over both come back naming the action, and while this
   * came only from an answer a refresh collapsed the third state into the first and told the one
   * person whose check had failed that nothing had been tried. The connections read carries it now — as
   * the RECORD of what the last check spent, written down by the check itself and read back off the
   * row — and the freshest answer still wins over it, because an answer is a newer record of the
   * same thing.
   *
   * A PAST TENSE, WHICH IS THE WHOLE OF WHAT IT IS FOR. This is what the sentence is drawn from and
   * it is never what the Re-check button is gated on: what the check spent and what there is to
   * spend now are two questions, and {@link BrokeredAccount.checkable} is the second one. Asking
   * this field the second question is what deadlocked the button — see that field.
   */
  probe: string | null | undefined;
  /**
   * Whether the app has anything to check this key against today.
   *
   * THE BUTTON'S OWN QUESTION, AND NOT THE SENTENCE'S. It is asked of the APP — has it published an
   * action safe to spend a key on — where {@link BrokeredAccount.probe} is asked of the connection,
   * and answers what the last check actually spent. The two agreed while the probe was derived on
   * every read, and they part company exactly when they should: an app that publishes something now
   * and published nothing then.
   *
   * WITHOUT IT THE ROW DEADLOCKS. A key accepted against an app with nothing to try records no
   * action, permanently and correctly; a button gated on that record is withheld permanently too,
   * even once the app publishes something — and pressing that button is the only thing that could
   * ever write an action into the record. The one act that would end the state is the act being
   * withheld.
   *
   * FALSE WHERE NOTHING HAS SAID, which is not the hedge `probe` needs. There is no sentence to get
   * wrong here, only a button to offer or withhold, and withholding is the direction that cannot
   * mislead: a press with nothing to spend could only ask for the same answer again.
   */
  checkable: boolean;
  /**
   * Whether this deployment has a Composio key at all.
   *
   * Carried through the hook rather than passed to the row separately, so a caller wires the row up
   * once: with no key there is no broker to ask, nothing to confirm on arrival, and neither action
   * below can do anything but fail.
   */
  configured: boolean;
  /** See {@link BrokeredAccountKind}. Derived here so no branch below re-asks. */
  kind: BrokeredAccountKind;
  /** Leave for the vendor's consent screen. */
  connect: () => void;
  /** End the account at Composio, not only here. */
  disconnect: () => void;
  connecting: boolean;
  disconnecting: boolean;
  /**
   * Whether a disconnect from this screen landed, as opposed to an account that was never made.
   *
   * Both read as not connected and they are not the same sentence. For an app whose secret somebody
   * typed, what disconnecting did NOT do is the part worth saying — the key is still live at the
   * vendor — and there is nobody to say it to until they have actually pressed the button.
   */
  disconnected: boolean;
  /**
   * What the app wants typed in, as it last answered. Null until it has answered anything, and for
   * every app nobody types anything into.
   *
   * THE LAST ANSWER RATHER THAN THE PENDING REQUEST'S, which is what lets a reopened dialog draw a
   * form at all. Asking again is a fresh mutation and a mutation clears its own `data` as it fires,
   * so reading the request would make this null on every open — see the hook for what that cost.
   */
  fields: BrokerField[] | null;
  /** Ask the app what it needs, which is the first press on a `fields` app. */
  requestFields: () => void;
  /**
   * Why the app could not be asked what it needs, or null.
   *
   * THE TWIN OF {@link submissionError}, ON THE PRESS BEFORE IT AND FOR ITS EXACT REASON. This press
   * is what OPENS the modal, so its refusal always lands with the dialog already up and the screen's
   * banner already behind the backdrop — the one arrangement in which a sentence reported to the
   * screen reaches nobody at all.
   *
   * AND THERE IS NO GENERIC LINE THAT COULD STAND IN FOR IT. The route refuses this press four ways
   * and the four name four different remedies: an app that needs no account, so there is nothing to
   * connect and nothing is wrong; an account this person already holds, which has to be disconnected
   * before another can be made; a directory Composio would not answer with; and a deployment with no
   * broker key at all, which is an administrator's to set. A dialog saying "that app could not be
   * asked what it needs" is true of all four and useful about none.
   */
  fieldsError: string | null;
  /**
   * Finish the connection with what the person typed.
   *
   * The values are handed straight to the request and held nowhere else: they are somebody's own
   * key, and this hook keeps no copy a later render could read back.
   */
  submitFields: (values: Record<string, string>) => void;
  requestingFields: boolean;
  submittingFields: boolean;
  /**
   * Why the last attempt to hand over what somebody typed was refused, or null.
   *
   * Carried out of the hook as well as reported to the screen's banner, because the form is a
   * modal. The banner is behind its backdrop, so Composio's own sentence — the one this path spends
   * a dropped `cause` to preserve — arrived where the person could not read it, over a form still
   * holding the key it was about.
   */
  submissionError: string | null;
  /** Spend one read-only call at the vendor to find out whether the key still works. */
  recheck: () => void;
  rechecking: boolean;
};

export function useBrokeredAccount(input: {
  serverId: string;
  /** Whether this row is about a brokered app at all. Asked of the recorded row by the caller. */
  brokered: boolean;
  /** See {@link BrokeredAccount.configured}. */
  configured: boolean;
  /** What this deployment recorded, which is what stands until the vendor has answered anything. */
  recorded: boolean;
  /** See {@link BrokeredAccount.verified}, as this deployment last wrote it down. */
  verified: boolean;
  /** See {@link BrokeredAccount.verifiedAt}, as this deployment last wrote it down. */
  verifiedAt: string | null;
  /**
   * Which action the last check of this key SPENT, as the connections read has it recorded.
   *
   * The read's record and not an answer to anything pressed here, which is exactly what makes it
   * worth passing: it is all the row has on a page that has only loaded. Undefined where the
   * recorded row carries no such field — a held connection, or an app nobody has connected — and
   * null where the check spent nothing. See {@link BrokeredAccount.probe} for what each of those
   * means to the sentence the row draws.
   */
  probe: string | null | undefined;
  /**
   * Whether the app has anything to check this key against today, as the connections read answers.
   *
   * THE ONLY PLACE THIS CAN COME FROM. It is a fact about what the app publishes NOW, so the read
   * is what knows it, and — unlike the record above — no answer to anything pressed here improves
   * on it. See {@link BrokeredAccount.checkable}, and the return below for why no answer overrides
   * it. Flattened to false by the caller where the row carries nothing, because a missing gate and
   * a closed gate are the same gate.
   */
  checkable: boolean;
  /**
   * How the app's authorization config was CREATED, as the vendor's own scheme literal.
   *
   * Read off the recorded server row rather than off a connection row: the connections endpoint
   * answers two different row shapes, so the absence of a field there says which READ a row came
   * from and never how an app connects. Null where the app is not brokered at all.
   */
  authScheme: string | null;
  /** Which screen the vendor's callback puts somebody down on. */
  returnTo: "settings" | "admin";
  /**
   * Where this row's failures go: the screen's own banner.
   *
   * Called with null as an action starts, so the reason the last attempt failed is not left sitting
   * over the one now in flight.
   */
  report: (message: string | null) => void;
}): BrokeredAccount {
  const queryClient = useQueryClient();
  const {
    authScheme,
    brokered,
    checkable,
    configured,
    recorded,
    probe,
    report,
    returnTo,
    serverId,
    verified,
    verifiedAt,
  } = input;

  /*
   * Ask the vendor whether this person's brokered account is actually live, on arrival.
   *
   * The return trip from consent is an ordinary redirect with nothing signed in it, so being back
   * on the page proves nothing about what happened at the vendor. The row a screen would otherwise
   * read is written from that same unproven return, which is why the answer is asked for rather
   * than assumed.
   *
   * Deliberately not wired into the banner. Somebody who abandoned the consent screen — or who has
   * simply never connected — arrives with nothing at the vendor to confirm, and that is an ordinary
   * state of the page, not a failure of it. It reads as not connected, which is what it is; a red
   * sentence across the top would be the page reporting its own question as somebody's problem.
   *
   * Not asked at all where there is no key. The endpoint answers 503, the screen swallows it, and
   * the row falls back to whatever we recorded — so the question can only ever be a wasted request
   * that ends in the one state this row has a sentence for anyway.
   */
  const confirmation = useMutation(
    confirmBrokeredConnectionMutationOptions(queryClient),
  );
  const confirmAccount = confirmation.mutate;
  /*
   * The confirmed answer is thrown away whenever an action changes the account underneath it.
   *
   * A mutation's `data` is not query state: invalidating the queries refetches the recorded row and
   * leaves this answer exactly where it was, and the effect above does not run again because none
   * of its dependencies changed. So a successful disconnect kept its dot, its word and its
   * Disconnect button, the person read that as a failure and pressed again, and the second DELETE
   * wrote a second `mcp.account_disconnected` entry about an account that was already gone.
   *
   * Cleared on connect for the same reason in the other direction. That path ends in a full page
   * navigation, so the held answer is usually thrown away with the document — but a navigation the
   * browser declines to make, or one somebody comes back from, would otherwise leave a "not
   * connected" answer from before the consent deciding a row about the account it granted.
   */
  const forgetConfirmation = confirmation.reset;
  useEffect(() => {
    if (!(brokered && configured)) return;
    confirmAccount(serverId);
  }, [brokered, configured, serverId, confirmAccount]);

  /*
   * Find out whether the key still works, when somebody presses for it and at no other time.
   *
   * Deliberately not a second effect beside the confirm above. Composio never re-checks a key once
   * it has taken it, so the only way to learn whether one works is to spend a real read-only call at
   * the vendor with it — and a verify-on-render would spend the person's own rate limit there, on
   * every mount of every screen that draws this row, to redraw a word that was already written down.
   * So the row says when it last checked, and the person decides when to check again.
   */
  const recheck = useMutation({
    ...recheckBrokeredConnectionMutationOptions(queryClient),
    onError: (thrown: Error) => report(thrown.message),
  });
  /*
   * The check's answer is thrown away whenever an action changes the account it was about.
   *
   * THE SAME DEFECT `forgetConfirmation` ABOVE EXISTS FOR, in the same shape and for the same
   * reason: a mutation's `data` is not query state, so invalidating the queries refetches the
   * recorded row and leaves this verdict exactly where it was. Disconnecting would leave the row
   * saying a key was "last checked" an hour ago about an account that no longer exists, and
   * connecting a fresh key would inherit the old key's verdict — a row reading "last checked"
   * about a value nothing has ever tried.
   *
   * RESET RATHER THAN A GUARD AT THE DRAWING. Hiding it behind `connected` in the render would fix
   * the disconnect and not the reconnect, and would leave the hook handing `verified: true` to any
   * other reader — the honest thing is for the answer to stop existing when the thing it answered
   * about does.
   */
  const forgetRecheck = recheck.reset;

  const connect = useMutation({
    ...connectAccountMutationOptions(returnTo),
    onError: (thrown: Error) => report(thrown.message),
    /*
     * A full page navigation, not a fetch. The consent screen is the vendor's own and has to be
     * shown to this person in their own browser; there is deliberately nothing here that could
     * complete it for them, and nothing about being an administrator changes that.
     */
    onSuccess: (authorizationUrl) => {
      forgetConfirmation();
      forgetRecheck();
      /*
       * NO URL IS AN ANSWER, NOT A URL TO FOLLOW.
       *
       * The route this pressed serves both kinds of brokered app and answers a field list to the
       * kind whose key somebody types — so a 200 with nothing to leave for means this press went to
       * a key app that `kindOf` above read as consent, which is what happens the day Composio names
       * a typed scheme this app's copy of `FIELD_SCHEMES` does not carry. Assigning that nothing
       * navigated: the browser resolved the string `undefined` against the current document and
       * followed it, putting the person on a page of that name on this deployment's own origin,
       * with no sentence anywhere saying why.
       *
       * Reported rather than recovered from. This hook could press the other half of the route and
       * open the form, but a screen that quietly repaired a disagreement between the two lists
       * would leave nobody any reason to correct it — and the sentence names the one act that ends
       * the state, which is a reload against a deployment whose app has caught up.
       */
      if (authorizationUrl === null) {
        report(
          "This app is connected with a key you hold rather than through a consent screen, so there was no page to send you to and nothing was connected. Reload this page and press Connect again.",
        );
        return;
      }
      window.location.href = authorizationUrl;
    },
  });

  /*
   * The two held answers, dropped whenever an act has been MADE against this account — which is not
   * the same event as an act that succeeded.
   *
   * THE REFETCH ALONE CANNOT DO THIS, and that is why it is a function rather than a line in a
   * callback. `confirmation.data` and `recheck.data` are mutation state: invalidating the plugin
   * queries refetches the recorded row and leaves both of them exactly where they were, and they
   * both win over the row by design — an answer from the vendor beats our own record. So a write
   * that changed the account at Composio while these still hold what it said BEFORE leaves the row
   * drawn from a stale answer over a freshly-correct read, which is the same defect the refetch
   * fixes, one layer up and immune to it.
   *
   * ON BOTH OUTCOMES, FOR THE REASON `invalidatePlugins` SPELLS OUT: none of these endpoints is
   * atomic, so a refusal is not evidence that the account is as it was. A submission refused because
   * Composio would not take back the account it had just made is precisely a held "not connected"
   * answer that has stopped being true, and a disconnect that revoked at the vendor and then failed
   * is the same thing in the other direction.
   */
  const forgetAnswers = () => {
    forgetConfirmation();
    forgetRecheck();
  };

  /*
   * The refetch is the mutation's own and is NOT declared here, which is what the `onSettled` on it
   * buys this file.
   *
   * IT USED TO BE AN `onSuccess` AND THIS SPREAD HAD TO CHAIN IT BY HAND — `disconnectOptions
   * .onSuccess?.(...args)` at the end of a second `onSuccess`, because declaring one over a spread
   * silently replaces it. That is a refetch one careless edit away from being dropped, and it only
   * ever ran on the outcome that needed it least. `onSettled` sits in a different slot from both
   * callbacks below, so what this component declares cannot shadow it and cannot forget to call it —
   * which is also why the forgetting above is spelled into both of them rather than into a third
   * `onSettled` here, where it WOULD shadow the refetch.
   */
  const disconnect = useMutation({
    ...disconnectBrokeredMutationOptions(queryClient),
    onError: (thrown: Error) => {
      report(thrown.message);
      forgetAnswers();
    },
    onSuccess: forgetAnswers,
  });

  /*
   * The first press on an app nobody consents to: what does it want typed in?
   *
   * A question about the app rather than about anybody's account, which is why it writes nothing
   * and refetches nothing. Nothing anybody TYPES is held here — that lives in the form and in the
   * request that carries it, and leaving the screen forgets it — and what is kept below is the
   * vendor's published list, which is metadata about the app and nobody's secret.
   */
  const fieldsRequest = useMutation({
    ...brokeredConnectionFieldsMutationOptions(),
    onError: (thrown: Error) => report(thrown.message),
  });

  /*
   * The last list this app answered with, kept across the next time it is asked.
   *
   * NOT `fieldsRequest.data`, WHICH IS EMPTY AT EXACTLY THE MOMENT IT IS WANTED. A mutation clears
   * its own `data` as it fires — `query-core` dispatches `pending` with `data: void 0` — and the
   * press that opens this dialog is the same press that asks the app again. So the list was null on
   * every open, the dialog drew its waiting line, and `ConnectionFields` was mounted fresh on
   * whatever came back. That made the whole of that file's list-changed-under-the-form machinery —
   * the previous list it keeps, and the reconcile that carries typed values onto a new one —
   * unreachable from the product, and its docblock's account of a form "mounted on the old list and
   * handed the new one a moment later" a description of something that could not happen.
   *
   * ADJUSTED DURING RENDER RATHER THAN IN AN EFFECT, which is what React asks for when state has to
   * follow something else: the new list is drawn in this paint rather than one frame later, under
   * somebody's cursor. The same pattern, for the same reason, as `published` in `connection-fields
   * .tsx` — which this is what feeds.
   *
   * ONLY A SUCCESS WRITES HERE, AND A SUCCESS ANSWERING NOTHING CLEARS IT. `null` is a real answer
   * from this route — the app takes no typed fields at all — so it has to be able to take the held
   * list away, which a `??` could not. A REFUSAL leaves the list alone, because a refusal is not an
   * answer about the app; what the dialog does about it is decided where the dialog is drawn.
   */
  const [published, setPublished] = useState<BrokerField[] | null>(null);
  if (fieldsRequest.isSuccess && fieldsRequest.data !== published) {
    setPublished(fieldsRequest.data);
  }

  /*
   * The second press, with the values on it. The refetch rides on the mutation's own `onSettled`,
   * for the reason the disconnect above gives.
   *
   * The confirmed answer is dropped here too. A row that connects this way arrived with a "not
   * connected" answer from the mount, and nothing about typing a key changes the dependencies of
   * the effect that asked — so without this the account would go on reading as not connected
   * however well the vendor accepted it.
   *
   * AND ON THE REFUSAL AS WELL, WHICH IS THE STATE THAT MADE THAT ANSWER DANGEROUS RATHER THAN
   * MERELY STALE. Where the check this press makes does not come back clean, the store RECORDS the
   * connection — unverified, naming the action it spent — leaves the account standing, and then
   * raises with what the app said. Keeping the mount's "not connected" answer over that leaves the
   * row offering Connect for an app they now have a live account at, which is the one press
   * guaranteed to be refused, and withholds the Re-check and Disconnect buttons the sentence names.
   */
  const submission = useMutation({
    ...connectBrokeredWithFieldsMutationOptions(queryClient),
    onError: (thrown: Error) => {
      report(thrown.message);
      forgetAnswers();
    },
    onSuccess: forgetAnswers,
  });

  /*
   * The freshest thing either check has WRITTEN DOWN about this key, or nothing at all.
   *
   * Two answers name a probe — a re-check, and a key just handed over — and the newer of the two
   * wins for the reason `verified` below gives: an answer beats the record, and these two cannot
   * both be new. A submission clears the re-check's answer as it lands, and opening the form clears
   * the submission's, so whichever is present is the one that was actually last said.
   *
   * AND A RE-CHECK THAT SPENT NOTHING IS NOT ONE OF THEM, which is the whole of why this is a
   * branch rather than a `??`. `recheckBrokeredConnection` answers `probe: null` on exactly one
   * outcome — the app published nothing safe to spend the key on — and on that outcome it returns
   * BEFORE its writer, deliberately, so that a check which could try nothing writes nothing at all.
   * The row it read is untouched and `probe_action` still names whatever the last real check spent.
   *
   * SO THE TWO NULLS ARE NOT THE SAME NULL. The connections read's null is a record: the last check
   * spent nothing. This route's null is a press: THIS check spent nothing, about a record it did
   * not touch. Letting it through as though it were the first is a browser unwriting a verdict no
   * request ever unwrote — the row flips from "a check was made and did not come back clean, and
   * the account still stands at Composio", which names two ways out, to "accepted without being
   * checked … that is about the app, not about your key", which is an absolution nothing
   * established.
   *
   * AND THERE IS NO WAY BACK FROM IT, which is what makes it worse than a stale render. That
   * outcome arises exactly when `probeActionFor` answers null, and the connections listing draws
   * `checkable` from the same read — so the refetch this very press makes withdraws the Re-check
   * button. The one control that could ask again goes with the sentence it would have corrected.
   *
   * A SUBMISSION'S NULL IS KEPT, and the asymmetry is the server's rather than a preference:
   * `connectBrokeredWithFields` hands `probeAction: probe` to the writer on every path that answers
   * at all, null included. Its null IS the new record. The one path where it writes a name and then
   * raises never reaches here — a refusal clears both answers — so what is left is authoritative.
   */
  const answered =
    recheck.data && recheck.data.probe !== null
      ? recheck.data
      : submission.data;

  return {
    /*
     * What the vendor last answered, and only our own record until it has answered anything. The
     * answer wins once there is one, in both directions — an account ended at Composio by somebody
     * else reads as not connected here too. A confirm still in flight, or one that could not be
     * made at all, leaves the recorded row standing rather than inventing either answer.
     */
    connected: confirmation.data?.connected ?? recorded,
    /*
     * What the last re-check found, and only our own record until one has been made here — the same
     * rule `connected` follows above: the answer wins once there is one.
     *
     * Both read off the one `recheck.data` rather than each falling back on its own, because
     * `verifiedAt` is legitimately null in a fresh answer — a check that came back not verified
     * records no time — and a `??` on it would pair that answer with the time of the check before,
     * leaving the row saying a key failed as of an hour before it was asked.
     *
     * AND THESE TWO TAKE EVERY ANSWER, INCLUDING THE PRESS `probe` BELOW REFUSES, which is not an
     * inconsistency between neighbouring lines but the shape of what the route answers with. On the
     * outcome where nothing was tried, `recheckBrokeredConnection` RE-READS the row and echoes what
     * it holds — `verified: held.verified, verifiedAt: iso(held.verifiedAt)` — so the answer carries
     * the record on these two and is, if anything, fresher than what this render was passed. It is
     * only `probe` that the same branch answers a press with rather than a record.
     */
    verified: recheck.data ? recheck.data.verified : verified,
    verifiedAt: recheck.data ? recheck.data.verifiedAt : verifiedAt,
    /*
     * The name off whichever answer WROTE ONE DOWN, and THE READ'S OWN RECORD OTHERWISE — nearly
     * the rule `connected` and `verified` follow above, and narrowed at exactly one place: the
     * answers this reads are the ones that changed the record, and `answered` above is where a
     * press that changed nothing is dropped. See the argument there for why that is not the same
     * question as which answer is newest.
     *
     * BOTH SIDES OF THIS BRANCH ARE THEREFORE THE SAME KIND OF FACT, which is what makes it sound.
     * The connections read carries what the last check SPENT, written down by that check; an answer
     * that reached its writer carries what the check just made spent and wrote. A newer record of
     * one thing replacing an older record of the same thing — so its null is the server saying that
     * check spent nothing, exactly as the read's null is. That is why it is passed straight through
     * rather than flattened to undefined: undefined is the absence of any record at all, and it is
     * what remains for a row whose read carried no such field. See {@link BrokeredAccount.probe}.
     */
    probe: answered ? answered.probe : probe,
    /*
     * AND THE READ'S ANSWER ALONE, WITH NO ANSWER ALLOWED TO OVERRULE IT — deliberately not the
     * rule every field above follows, because this is not the same kind of fact as any of them.
     *
     * AN ANSWER REPORTS A CHECK; THIS IS A QUESTION ABOUT THE APP. What a re-check or a submitted
     * key comes back with is `probe`: the action that press SPENT. It is tempting to read a null
     * there as "so there was nothing to spend", and at the instant of the press that is even true —
     * the same chooser answered both. But a mutation's `data` is not query state. It persists until
     * something resets it, while the connections read behind it refetches on every one of these
     * mutations, so `answered.probe === null` winning here would PIN the gate shut against every
     * later read that learns the app has published something. That is this very deadlock rebuilt
     * one layer up, out of the same mistake: a record of a past check asked what is true now.
     *
     * AND NOTHING IS LOST BY REFUSING IT. Every mutation in this hook invalidates the plugin
     * queries, so the read that owns this field is refetched the moment any press lands; the most a
     * press can cost is one render on the previous read's answer, and a stale gate is a button
     * offered or withheld for an instant, not a sentence anybody is told.
     */
    checkable,
    recheck: () => {
      report(null);
      recheck.mutate(serverId);
    },
    rechecking: recheck.isPending,
    configured,
    connect: () => {
      report(null);
      connect.mutate(serverId);
    },
    connecting: connect.isPending,
    disconnect: () => {
      report(null);
      disconnect.mutate(serverId);
    },
    disconnecting: disconnect.isPending,
    /*
     * A disconnect this person made, rather than an account that was never there. Held by the
     * mutation because that is where the fact is: the recorded row says only that there is nothing,
     * which is equally true of an app nobody ever connected.
     */
    disconnected: disconnect.isSuccess,
    kind: kindOf(authScheme),
    fields: published,
    requestFields: () => {
      report(null);
      /*
       * A fresh attempt, so the last one's refusal goes with it. This press is also what opens the
       * form, and a mutation's error outlives the dialog that showed it: without this, reopening
       * would present the sentence the previous key was refused with, above an empty field.
       */
      submission.reset();
      fieldsRequest.mutate(serverId);
    },
    requestingFields: fieldsRequest.isPending,
    fieldsError: fieldsRequest.error?.message ?? null,
    submitFields: (values: Record<string, string>) => {
      report(null);
      submission.mutate({ serverId, values });
    },
    submittingFields: submission.isPending,
    submissionError: submission.error?.message ?? null,
  };
}

/**
 * The day a check was made, in the reader's own locale.
 *
 * A day rather than "2 hours ago": the point of the sentence is that the check is a past tense that
 * keeps receding, and a relative phrase recomputed on every render reads as a fact about now.
 */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/**
 * The line beneath the word, which is where the three kinds actually differ.
 *
 * THEY DO NOT DIFFER IN THE WORD. A consent screen and a key somebody typed both end in a live
 * account, and "Connected" is true of both; a second word for the second kind would invite a
 * distinction there is no fact behind. What differs is what that connection rests on, and how much
 * this deployment can honestly claim to know about it — which is a sentence, not a label.
 *
 * COMPOSIO NEVER RE-CHECKS A SUBMITTED KEY. It answers ACTIVE forever, so a key revoked at the
 * vendor last week still reads as connected here. The verification makes exactly one moment true,
 * so the row names that moment instead of asserting a present tense it does not hold.
 */
function accountSentence(input: {
  account: BrokeredAccount;
  /** The app's own name, as the screen drawing this row knows it. */
  title: string;
  connectedDescription: string;
  disconnectedDescription: string;
  disconnectedReassurance: string | undefined;
}): string {
  const {
    account,
    connectedDescription,
    disconnectedDescription,
    disconnectedReassurance,
    title,
  } = input;

  if (!account.configured) {
    return "Set COMPOSIO_API_KEY on this deployment. Without it there is no broker to reach, so this account can be neither connected nor ended from here. The app stays enabled and every grant on its tools still stands.";
  }

  if (account.kind === "no-auth") {
    /*
     * Neither screen's own sentence fits: both are about an account, and there is none to have.
     * Capitalised because this is the one position the name opens a sentence in.
     */
    return `${title.charAt(0).toUpperCase()}${title.slice(1)} needs no account. A Bot granted these tools can use it as it is.`;
  }

  if (account.kind === "fields") {
    if (account.connected) {
      if (account.verified && account.verifiedAt) {
        return `Connected with a key you provided, last checked ${formatDate(account.verifiedAt)}.`;
      }
      /*
       * A CHECK WAS SPENT AND DID NOT COME BACK CLEAN, and the account it was spent in is still
       * there — the one state where the sentence below was not vague but FALSE. Two facts are this
       * person's to act on and both go in: a check against this app failed, an account of theirs is
       * live at Composio, and the row says which button ends which.
       *
       * AND IT NO LONGER SAYS THE KEY WAS REJECTED, which is the half this line could not support.
       * The verdict behind it is read out of Composio's `{ data, error, successful }` envelope,
       * which carries no status and no error code — so a rate limit on the check, a scope the key
       * legitimately lacks for that one action, and a credential the vendor really did reject all
       * arrive identically. Telling somebody their key is bad on that evidence sends them to fetch
       * and re-enter a key that was very probably fine. See `BrokeredProbe` in the store.
       *
       * WHY THE ACCOUNT STANDS IS NOT ASSERTED EITHER, because two paths reach this state: a
       * connect whose check failed, which now deliberately leaves the account it made rather than
       * destroying a connection on evidence it does not have, and a re-check, which never withdraws
       * one because the account predates the press and is the person's own. The standing account is
       * the actionable half either way.
       *
       * BOTH WAYS OUT ARE NAMED, because neither is obvious from a row that says "Connected": the
       * account ends with the button beside this line, and a check that failed for a passing reason
       * is worth a second press rather than a second connection.
       */
      if (account.probe && !account.verified) {
        return `A check against ${title} was made with your key and did not come back clean — that may be the key, and it may be ${title} itself. The account still stands at Composio, so press Re-check to try again, or disconnect it here and connect again with a fresh key.`;
      }
      /*
       * NOTHING WAS SPENT ON IT, WHICH IS A FACT ABOUT THE CHECK AND ABOUT THE APP AT THE TIME. The
       * record names no action: when the key was taken this app published none safe to spend it on,
       * so the check was not skipped and could not be made. Said plainly because the alternative
       * reading — that this deployment doubts the key — is the one a person supplies for themselves
       * when a row goes quiet.
       *
       * ITS SECOND CLAUSE IS AS OF THE CHECK, NOT AS OF TODAY, AND SAYS SO IN ITS TENSE. The app
       * published nothing safe to try a key on when the key was taken; whether it publishes
       * something now is a question this sentence does not answer, and must not, because a sentence
       * drawn from today's listing is how a key nobody tried came to be accused of being rejected.
       * Where the app HAS since published something the present-tense half reaches the person as
       * the Re-check button beside this line, which `checkable` puts there in exactly that state —
       * so the row offers the act that would make this sentence current rather than asserting a
       * check it has not made. A past tense is what keeps the two from reading as a contradiction:
       * a button to check with, beside a line that never claimed there was nothing to check with
       * today.
       */
      if (account.probe === null) {
        return `Connected with a key you provided. It was accepted without being checked against ${title}, which published nothing safe to try a key on at the time — that is about the app, not about your key.`;
      }
      /*
       * AND NOTHING HAS SAID WHICH, which is no longer the page load: the connections read carries
       * the recorded probe now, so a reload lands on one of the two sentences above. What is left
       * here is a row nothing has told about a probe either way — a held connection, whose rows
       * carry none of this — and all it knows is that the key was taken. Those two sentences are the
       * two things a record can say; this is what stands where there is no record, and it must not
       * borrow either.
       */
      return `Connected with a key you provided. It was accepted without being checked against ${title}.`;
    }
    /*
     * WHAT DISCONNECTING DID NOT DO. The account ends at Composio and the key does not end
     * anywhere: it is still valid at the vendor and still works for anyone holding it. Saying
     * "disconnected" and stopping would leave somebody believing they had ended access they still
     * have live, so the row names the step this deployment cannot take for them.
     */
    if (account.disconnected) {
      return `Removed from Composio. Your key still works at ${title} — rotate it there if you meant to end its access.`;
    }
    /*
     * NOT THE SCREEN'S OWN SENTENCE, which is written for the kind that leaves: one of the two says
     * connecting takes you to Composio and then to the vendor to consent, and pressing Connect here
     * opens a form and asks for a secret instead. A sentence that promises a trip nobody is about to
     * take is a worse preparation for the dialog than no sentence at all.
     *
     * THE SCREEN'S REASSURANCE IS KEPT THOUGH ITS SENTENCE IS NOT. What an administrator needs to
     * read here — that finishing the connector does not wait on them connecting — is true whichever
     * way this app is connected, and a row that replaced the whole line took it away with the trip
     * it was right to drop.
     */
    const asked = `This app is connected with a key you already hold, not a trip to ${title}'s consent screen. Connect asks for it.`;
    return disconnectedReassurance
      ? `${asked} ${disconnectedReassurance}`
      : asked;
  }

  /*
   * A consent app keeps the screen's own sentence, prefixed by what the connection rests on. What
   * differs between an administrator checking their setup and a person checking who reads their
   * mail is an argument, not a branch — see this file's opening comment.
   */
  return account.connected
    ? `Connected through ${title}'s consent screen. ${connectedDescription}`
    : disconnectedDescription;
}

/**
 * The row itself, for a `PageRows` card on either screen.
 *
 * The `Item` and, for an app whose secret a person types, the dialog that takes it. Where the row
 * sits in the card, and whether a `Separator` precedes it, is the screen's business and differs
 * between the two; the dialog is portalled to the body and so sits nowhere at all.
 */
export function BrokeredAccountRow({
  account,
  connectedDescription,
  disconnectedDescription,
  disconnectedReassurance,
  title,
}: {
  account: BrokeredAccount;
  /** What being connected means on this screen, said beside the button rather than after it. */
  connectedDescription: string;
  /** What connecting would do, in the voice of whoever is reading. */
  disconnectedDescription: string;
  /**
   * What stays true whether or not this person ever connects, in that same voice.
   *
   * Separate from `disconnectedDescription` because only part of a screen's line survives the kind
   * that does not leave: the half describing the trip to a consent screen is wrong for an app whose
   * key somebody types, and the half telling an administrator their setup is already complete is
   * right for both. A screen with nothing of the second kind to say passes nothing.
   */
  disconnectedReassurance?: string;
  /**
   * The app's own name, for the sentences that name it.
   *
   * Required, because the sentences it appears in are the ones whose whole job is to name a place:
   * where a key still works after a disconnect, whose consent screen a connection rests on, which
   * app needs no account at all. "Your key still works at the app" tells somebody nothing they can
   * act on, so a screen that cannot name the app has no business drawing this row.
   */
  title: string;
}) {
  /*
   * Whether the form is on screen, which is the whole of what this row holds.
   *
   * An app nobody consents to is connected by typing a key rather than by leaving for a consent
   * screen, and the layout's answer to more than one value is a dialog rather than fields wedged
   * into the row. What goes in those fields is asked for when this opens and is held by the form
   * itself — see `connection-fields.tsx` — so closing this forgets it.
   */
  const [asking, setAsking] = useState(false);

  /*
   * A connection that landed takes its own form off the screen.
   *
   * The row behind redraws as connected on the refetch either way; without this the person is left
   * reading the form they just submitted, over a row that says it worked.
   */
  useEffect(() => {
    if (account.connected) setAsking(false);
  }, [account.connected]);

  return (
    <>
      <Item size="sm">
        <ItemContent>
          {/* Not "Connect your account": the row is also the connected state, and a title has to
              read for both. */}
          <ItemTitle>Your account</ItemTitle>
          {/* Unclamped where the key is missing: that sentence is the only place the setting is
              named, so it is the point rather than a hint. */}
          <ItemDescription
            className={account.configured ? undefined : "line-clamp-none"}
          >
            {accountSentence({
              account,
              connectedDescription,
              disconnectedDescription,
              disconnectedReassurance,
              title,
            })}
          </ItemDescription>
        </ItemContent>
        {/*
         * AN APP THAT NEEDS NO ACCOUNT HAS NOTHING HERE AT ALL — no Connect, and not a disabled one
         * either. There is no account to make and none to end, so a button would offer an act with
         * no effect and a greyed one would announce a step somebody is missing when they are not.
         * The sentence above already says the app works as it is.
         *
         * Still drawn where the key is missing, because then nothing works, this app included.
         */}
        {account.configured && account.kind === "no-auth" ? null : (
          <ItemActions>
            {!account.configured ? (
              /*
               * A value and nothing to press, which is the layout's read-only row: the deployment
               * has no key, so Connect could only fail at the broker and Disconnect could only fail
               * at it twice. A button that cannot work is worse than no button — it invites the
               * second press that files a record of an act that did not happen.
               */
              <span className="text-muted-foreground text-xs">Key missing</span>
            ) : account.connected ? (
              <>
                {/* Decorative: the word beside it already says which. */}
                <span
                  aria-hidden="true"
                  className="size-1.5 rounded-full bg-emerald-500"
                />
                {/* The same word for both kinds. The line beneath says what it rests on. */}
                <span className="text-muted-foreground text-xs">Connected</span>
                {/*
                 * OFFERED ONLY ON A KEY APP, BECAUSE THAT IS THE ONLY KIND A RE-CHECK IS AN ACT ON.
                 * A consent connection is written verified by the confirm, with no probe behind it,
                 * and migration 0038 backfilled every consent row that came before — see
                 * {@link BrokeredAccount.verified} — so a gate that asked only about a check would
                 * draw Re-check on every connected Gmail a deployment already had, where pressing it
                 * could only fail.
                 *
                 * AND THE SECOND HALF ASKS WHETHER THERE IS ANYTHING TO CHECK WITH, WHICH IS NOT
                 * "HAS A CHECK PASSED". Gating on `verified` withheld the button in the one state
                 * somebody reaches for it hardest: a key the vendor has just rejected, which they
                 * have gone and corrected and now want tried again. An app with nothing to spend
                 * the key on is the only state with nothing to press, because the button could only
                 * ask for the same answer again.
                 *
                 * AND IT ASKS `checkable`, NOT `probe`, WHICH IS THE WHOLE OF THE DIFFERENCE. This
                 * is a question about the app TODAY, and `probe` is the record of what the last
                 * check spent — a fact about the past that no later listing can move. The two
                 * agreed while the probe was derived on every read. Once it became a record they
                 * stopped: a key accepted against an app that published nothing records null for
                 * good, so a gate on that record withheld the button for good, even after a Refresh
                 * gave the app something to try — and pressing this button is the only thing in the
                 * product that could ever write an action into that record, so nothing could ever
                 * end the state from inside it. The sentence above still reads the record, because
                 * what to SAY is what happened; what to OFFER is what is possible now.
                 */}
                {account.kind === "fields" && account.checkable ? (
                  <Button
                    disabled={account.rechecking}
                    onClick={account.recheck}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {account.rechecking ? "Checking…" : "Re-check"}
                  </Button>
                ) : null}
                <Button
                  disabled={account.disconnecting}
                  onClick={account.disconnect}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Disconnect
                </Button>
              </>
            ) : (
              /* The arrow says this leaves OpenBot for the vendor's consent page. It does. */
              <Button
                disabled={account.connecting}
                onClick={() => {
                  /*
                   * A key app goes nowhere: it opens the form below and asks the app what belongs in
                   * it. The question is asked on every open rather than once, because what an app
                   * publishes is the vendor's and may differ from what it published last time.
                   */
                  if (account.kind === "fields") {
                    setAsking(true);
                    account.requestFields();
                    return;
                  }
                  account.connect();
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                Connect
                <IconArrowUpRight />
              </Button>
            )}
          </ItemActions>
        )}
      </Item>

      <Dialog onOpenChange={setAsking} open={asking}>
        <DialogContent>
          <DialogHeader>
            {/* The title the row above cannot have: this exists only while the account is not
                connected, so it is free to name the act rather than the subject. */}
            <DialogTitle>Connect your account</DialogTitle>
          </DialogHeader>
          <DialogBody className="mt-4">
            {/*
             * THE REFUSAL FIRST, AND IT IS FIRST BECAUSE THE LIST OUTLIVES THE PRESS THAT FETCHED IT.
             *
             * THE REFUSAL WHERE THE PERSON IS LOOKING, AND IT IS THE SERVER'S OWN SENTENCE. It
             * reaches the screen's banner too, and that banner is behind this dialog's backdrop —
             * so the four things the route can say here, each naming a different thing to do, all
             * arrived where nobody could read them, and what stood in their place was the waiting
             * line: true of every one of them and actionable about none. "This app needs no
             * account" and "you already have one, disconnect it first" are not "try again".
             *
             * AND IT WOULD BE UNREACHABLE ANYWHERE BELOW THE FORM. `account.fields` is the app's
             * LAST answer rather than this press's, so a second open that Composio refuses still
             * has a list to draw — and a form drawn over a swallowed refusal is worse than a stale
             * one: it invites the one act that cannot work, sending a list the app has just
             * declined to confirm, and the 400 that comes back names a field rather than the
             * outage. A refusal clears it from the screen instead, and the person still has the
             * sentence that says which act ends the state.
             *
             * A FRESH PRESS CLEARS THIS ON ITS OWN, so it cannot outlive its own retry: firing the
             * mutation dispatches `pending`, which sets `error: null`. That is the same fact about
             * mutation state the held list above exists to work around, working the other way.
             */}
            {account.fieldsError ? (
              // `role="alert"` and the destructive colour for the reason the submission refusal
              // has them: this is the server refusing, not the dialog waiting.
              <p className="text-destructive text-sm" role="alert">
                {account.fieldsError}
              </p>
            ) : account.fields ? (
              <ConnectionFields
                busy={account.submittingFields}
                fields={account.fields}
                onSubmit={account.submitFields}
              />
            ) : account.requestingFields ? (
              <p className="text-muted-foreground text-sm">
                Asking the app what it needs…
              </p>
            ) : (
              /*
               * AND THE LINE FOR A PRESS THAT ANSWERED NOTHING AT ALL, which is what is left once
               * the sentence above has its own branch: no fields, no request in flight and no
               * refusal — the route answered 200 with no `fields` on it, which is the drift between
               * this screen's copy of the typed-scheme list and the server's, seen from this side.
               * That answer also takes any held list away with it, which is why this is reachable
               * on a second open and not only on a first.
               */
              <p className="text-muted-foreground text-sm">
                That app could not be asked what it needs. Close this and try
                again.
              </p>
            )}
            {/*
             * THE REFUSAL WHERE THE PERSON IS LOOKING. It reaches the screen's banner too, and that
             * banner is behind this dialog's own backdrop: a key Composio would not take said so in
             * the vendor's words, at the top of a page nobody could see, while the form sat open as
             * though nothing had been answered.
             *
             * Under the form rather than over it, beside the button that was just pressed, and the
             * form stays up holding what was typed — a key is corrected, not retyped.
             */}
            {account.submissionError ? (
              <p className="mt-3 text-destructive text-sm" role="alert">
                {account.submissionError}
              </p>
            ) : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
