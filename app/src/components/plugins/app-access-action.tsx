import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useConnectInNewTab } from "@/components/plugins/connect-in-new-tab";
import { Button } from "@/components/ui/button";
import {
  cancelAppAccessRequestMutationOptions,
  requestAppAccessMutationOptions,
} from "@/lib/app-access/mutations";
import { type AppAccess, appAccessKeys } from "@/lib/app-access/queries";
import { queryClient } from "@/query-client";

/**
 * One work app's state for the person looking, and the one thing they can do about it.
 *
 * ONE PIECE, DRAWN IN TWO PLACES. A Bot's page lists every app the Bot holds with a row each, and a
 * conversation draws a card when the Bot needed an app it could not use. Both say the same thing —
 * whether this person can use this app through this Bot, whose move it is if not, and the button
 * for that move — so both draw it from here, and a sentence corrected for one is corrected for both.
 *
 * WHO CAN FIX IT IS THE WHOLE SENTENCE. Seven states reduce to four answers: nothing to do, a step
 * that is yours (connect, reconnect), a step only an administrator can take (switch it on, finish
 * setting it up, grant it, connect or approve the team account), and on somebody else's Team Bot a
 * step only its owner can take (reconnect the account the Bot runs on). The copy names which,
 * because "Gmail is unavailable" sends somebody hunting through their own settings for a switch that
 * is not there.
 *
 * THE STATE IS THE SERVER'S. It arrives on `access` and is drawn as it is; nothing here works out
 * from `granted` or `accountMode` what the state ought to be. The one exception is the caller's: a
 * card may hand in an `access` whose state it overrode from the refusal it was drawn for — see
 * `AppAccessCard` — and that is the caller's decision, made where the refusal is in hand.
 */

/** What the person is told about one app, in words that say whose move it is. */
export function appAccessSentence(access: AppAccess): string {
  const name = access.displayName;
  const owners = access.accountHolder === "owner";
  switch (access.state) {
    case "ready":
      if (owners)
        return `Ready to use. This Bot uses its owner's ${name} account.`;
      if (access.asksFirst)
        return `Ready to use with your own ${name} account. You'll be asked to allow it the first time.`;
      return "Ready to use.";
    case "not_connected":
      return `You haven't connected your ${name} account yet.`;
    case "reconnect":
      return owners
        ? `This Bot uses its owner's ${name} account, which needs reconnecting. Only the Bot's owner can reconnect it.`
        : `Your ${name} connection needs reconnecting.`;
    case "shared_not_connected":
      return `Your organisation's ${name} account isn't connected yet. Only an admin can connect it.`;
    case "shared_not_approved":
      return `This Bot reaches more people than an admin approved for your organisation's ${name} account. Only an admin can approve it.`;
    case "disabled":
      return disabledSentence(access);
    case "not_granted":
      return `This Bot hasn't been given ${name}. Only an admin can give it.`;
  }
}

/**
 * Switched off, in the words for why. "Turned off by an admin" was true of one reason in five: an
 * app nobody switched on, and a set-up somebody has not finished, are not a decision anybody took.
 * The unconfigured-broker case says what the app's page under Connections says about the same app,
 * so the two screens never disagree about it.
 */
function disabledSentence(access: AppAccess): string {
  const name = access.displayName;
  switch (access.unavailable) {
    case "composio_unconfigured":
      return `${name} isn't set up yet. An admin has to turn it on.`;
    case "scheme_unreadable":
    case "oauth_client_missing":
    case "token_missing":
      return `${name} isn't fully set up yet. Only an admin can finish setting it up.`;
    default:
      return `${name} isn't turned on yet. Only an admin can turn it on.`;
  }
}

/**
 * The button for the person's next move, and what it says while it happens.
 *
 * - `ready` — nothing.
 * - `shared_not_approved` — nothing either: the call that was refused already filed the
 *   administrator's request, so there is no second one to make.
 * - `reconnect` on an account the Bot's owner holds — nothing. Only the owner can reconnect their
 *   own account, and nobody else's press could do it for them.
 * - `not_connected` / `reconnect` — the person's own connection. Connect starts it in a new tab
 *   with the connect route Settings presses; an app connected with a typed key, and a Composio app
 *   that already has a row (which the connect route refuses until it is disconnected), go to the
 *   app's own page in Settings instead, where the form and Disconnect are.
 * - the three an administrator fixes — Request access, which files the request the server decides
 *   the kind of, and then Requested with a way to withdraw it.
 */
export function AppAccessAction({
  agentId,
  access,
}: {
  agentId: string;
  access: AppAccess;
}) {
  if (access.state === "ready" || access.state === "shared_not_approved")
    return null;
  if (access.state === "reconnect" && access.accountHolder === "owner")
    return null;
  if (access.state === "not_connected" || access.state === "reconnect")
    return <ConnectAction access={access} />;
  return <RequestAction agentId={agentId} access={access} />;
}

/** The person's own account: connect it, or reconnect it. */
function ConnectAction({ access }: { access: AppAccess }) {
  const label = access.state === "reconnect" ? "Reconnect" : "Connect";
  const tab = useConnectInNewTab();
  const { waiting, stopWaiting } = tab;

  /*
   * WATCHING THE SERVER WHILE A CONSENT IS OPEN in the other tab, because the return trip proves
   * nothing. The whole app-access view is refreshed every two seconds until this app stops being
   * this person's to connect — which is what unmounts this component — and then everything once,
   * because the grants a Bot is offered are read per conversation and the turn after this has to
   * be asked against a store that knows about the new account.
   */
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: appAccessKeys.all });
    }, 2_000);
    return () => clearInterval(timer);
  }, [waiting]);
  const waited = useRef(false);
  waited.current ||= waiting;
  useEffect(
    () => () => {
      if (waited.current) void queryClient.invalidateQueries();
    },
    [],
  );

  /*
   * A FORM, OR A CONNECTION THAT ALREADY HAS A ROW, IS SETTINGS' JOB. A typed key has nowhere to be
   * typed but the app's page, and a Composio app whose row still stands — a refused key, an account
   * the vendor lost — is refused by the connect route until it is disconnected there. Only this
   * deployment's own OAuth flow takes a fresh consent over a withdrawn one.
   */
  const viaSettings =
    access.connect === "key" ||
    (access.state === "reconnect" && access.connect !== "oauth") ||
    tab.needsKey;
  if (viaSettings)
    return (
      <Button
        render={<Link params={{ key: access.key }} to="/connections/$key" />}
        aria-label={`${label} ${access.displayName}`}
        size="sm"
        variant="outline"
      >
        {label}
      </Button>
    );

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {tab.error ? (
        <p className="text-destructive text-xs" role="alert">
          {tab.error}
        </p>
      ) : null}
      {tab.blockedUrl ? (
        <p className="text-xs" role="status">
          This browser blocked the tab.{" "}
          <a
            className="underline underline-offset-2"
            href={tab.blockedUrl}
            rel="noreferrer"
            target="_blank"
          >
            Open {access.displayName}'s sign-in
          </a>
          .
        </p>
      ) : waiting ? (
        <p className="text-muted-foreground text-xs" role="status">
          Finish in the tab that opened.
        </p>
      ) : null}
      <Button
        // Named for the app while it is idle; while waiting, the visible words already name it.
        aria-label={waiting ? undefined : `${label} ${access.displayName}`}
        disabled={tab.pending}
        onClick={() => {
          stopWaiting();
          tab.open(access.key);
        }}
        size="sm"
        variant="outline"
      >
        {waiting ? `Waiting for ${access.displayName}…` : label}
      </Button>
    </div>
  );
}

/** A step only an administrator can take: ask for it, and withdraw the ask. */
function RequestAction({
  agentId,
  access,
}: {
  agentId: string;
  access: AppAccess;
}) {
  const request = useMutation(requestAppAccessMutationOptions(queryClient));
  const cancel = useMutation(
    cancelAppAccessRequestMutationOptions(queryClient),
  );
  const error = request.error ?? cancel.error;

  /*
   * FOCUS FOLLOWS THE PRESS. Request access and Withdraw replace each other, so the button somebody
   * pressed leaves the page the moment the server's answer is drawn, and the focus with it — onto
   * the body, where a keyboard user starts again from the top. The press is remembered, and when
   * the other button arrives in its place it takes the focus. A refused press leaves the same
   * button standing, which gets it back.
   */
  const control = useRef<HTMLButtonElement>(null);
  const pressed = useRef(false);
  const requested = access.request !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the swap between the two buttons.
  useEffect(() => {
    if (!pressed.current) return;
    pressed.current = false;
    control.current?.focus();
  }, [requested]);
  const refocus = {
    onError: () => {
      pressed.current = false;
      control.current?.focus();
    },
  };

  /*
   * Nothing to ask for where the server names no request: a state a caller overrode from a refusal
   * the server does not know about (the team account lost at the vendor), which the server would
   * answer 409 because as far as it knows nothing is wrong. The sentence still says whose move it is.
   */
  if (!access.request && !access.requestKind) return null;

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {error ? (
        <p className="text-destructive text-xs" role="alert">
          {error.message}
        </p>
      ) : null}
      {access.request ? (
        <>
          <span className="text-muted-foreground text-xs" role="status">
            Requested
          </span>
          <Button
            aria-label={
              cancel.isPending
                ? undefined
                : `Withdraw request for ${access.displayName}`
            }
            disabled={cancel.isPending}
            onClick={() => {
              request.reset();
              pressed.current = true;
              if (access.request) cancel.mutate(access.request.id, refocus);
            }}
            ref={control}
            size="sm"
            variant="ghost"
          >
            {cancel.isPending ? "Withdrawing…" : "Withdraw"}
          </Button>
        </>
      ) : (
        <Button
          aria-label={
            request.isPending
              ? undefined
              : `Request access to ${access.displayName}`
          }
          disabled={request.isPending}
          onClick={() => {
            cancel.reset();
            pressed.current = true;
            request.mutate({ agentId, app: access.key }, refocus);
          }}
          ref={control}
          size="sm"
          variant="outline"
        >
          {request.isPending ? "Requesting…" : "Request access"}
        </Button>
      )}
    </div>
  );
}
