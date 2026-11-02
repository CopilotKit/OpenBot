import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useConnectInNewTab } from "@/components/plugins/connect-in-new-tab";
import { Button } from "@/components/ui/button";
import { agentQueryOptions } from "@/lib/agents/queries";
import {
  approveBotAppMutationOptions,
  cancelAppAccessRequestMutationOptions,
  giveBotAppMutationOptions,
  requestAppAccessMutationOptions,
} from "@/lib/app-access/mutations";
import { type AppAccess, appAccessKeys } from "@/lib/app-access/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";

/**
 * One work app's state for the person looking, and the one thing they can do about it.
 *
 * ONE PIECE, DRAWN IN TWO PLACES. A Bot's page lists every app the Bot holds with a row each, and a
 * conversation draws a card when the Bot needed an app it could not use. Both say the same thing —
 * whether this person can use this app through this Bot, whose move it is if not, and the button
 * for that move — so both draw it from here, and a sentence corrected for one is corrected for both.
 *
 * WHO CAN FIX IT IS THE WHOLE SENTENCE. Eight states reduce to four answers: nothing to do, a step
 * that is yours (connect, reconnect, or giving your own app to your own Bot), a step only an
 * administrator can take (switch it on, finish
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

/**
 * What the person is told about one app, in words that say whose move it is. `bot` is the Bot's name,
 * for the one state that asks the person a question about it.
 */
export function appAccessSentence(access: AppAccess, bot?: string): string {
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
    case "owner_grantable": {
      const yours = access.account === "personal" ? `your ${name}` : name;
      const ask = `Let ${bot ?? "this Bot"} use ${yours}?`;
      return access.needsConnect ? `${ask} Connect it first.` : ask;
    }
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
 *   the kind of, and then Requested with a way to withdraw it. Pressed by an administrator, it would
 *   be a request to themselves, so they get the fix itself instead: see `AdminAction`.
 */
export function AppAccessAction({
  agentId,
  access,
}: {
  agentId: string;
  access: AppAccess;
}) {
  /*
   * WHO IS LOOKING decides only which button is drawn, never what is allowed: the server answers
   * the one press 403 for anybody else, and `SharedAppNotice` already reads the role the same way.
   */
  const me = useQuery(currentUserQueryOptions()).data;
  if (access.state === "ready" || access.state === "shared_not_approved")
    return null;
  if (access.state === "reconnect" && access.accountHolder === "owner")
    return null;
  if (access.state === "not_connected" || access.state === "reconnect")
    return <ConnectAction access={access} />;
  // Theirs to give, admin or not: an owner's grant keeps every call on the asker's own account.
  if (access.state === "owner_grantable")
    return <OwnerGiveAction access={access} agentId={agentId} />;
  if (me?.role === "admin")
    return <AdminAction agentId={agentId} access={access} />;
  return <RequestAction agentId={agentId} access={access} />;
}

/**
 * The step only an administrator can take, offered to the administrator as the step itself.
 *
 * ONE PRESS WHERE ONE PRESS CAN DO IT. An app nobody switched on, or one this Bot was never given,
 * is switched on and given here through the inbox's own approval (`approveBotAppMutationOptions`):
 * the same checks, the read-only actions only, and the same trail. Anything that sends or writes is
 * still chosen on the Bot's page.
 *
 * A LINK WHERE IT CANNOT. A broker with no key, a set-up somebody left unfinished and a team account
 * nobody connected all need something only typed or consented to on the app's admin page. That page
 * opens in a new tab so the conversation stays where it is, and the card reads the app again when
 * this tab has the focus back.
 */
function AdminAction({
  agentId,
  access,
}: {
  agentId: string;
  access: AppAccess;
}) {
  const bot = useQuery(agentQueryOptions(agentId)).data?.name ?? "this Bot";
  const approve = useMutation(approveBotAppMutationOptions(queryClient));
  const name = access.displayName;

  const oneClick =
    access.state === "not_granted" ||
    (access.state === "disabled" &&
      (access.unavailable === null || access.unavailable === "absent"));
  if (oneClick) {
    const disabled = access.state === "disabled";
    const label = disabled
      ? `Turn on and give it to ${bot}`
      : `Give it to ${bot}`;
    // The card names the app beside the button; on its own, the button has to.
    const spoken = disabled
      ? `Turn on ${name} and give it to ${bot}`
      : `Give ${name} to ${bot}`;
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {approve.error ? (
          <p className="text-destructive text-xs" role="alert">
            {approve.error.message}
          </p>
        ) : null}
        <Button
          aria-label={approve.isPending ? undefined : spoken}
          disabled={approve.isPending}
          onClick={() =>
            approve.mutate(
              { agentId, app: access.key },
              /*
               * The grants a Bot is offered are read per conversation, so the turn after this has
               * to be asked against a store that knows about them. See `ConnectAction`.
               */
              { onSuccess: () => void queryClient.invalidateQueries() },
            )
          }
          size="sm"
        >
          {approve.isPending ? (disabled ? "Turning on…" : "Giving…") : label}
        </Button>
      </div>
    );
  }

  const page =
    access.state === "disabled" &&
    access.unavailable === "composio_unconfigured"
      ? access.provider === "arcade"
        ? "arcade"
        : "composio"
      : access.key;
  const [label, spoken] =
    access.state !== "shared_not_connected"
      ? ["Set it up", `Set up ${name}`]
      : access.requestKind
        ? ["Connect the team account", `Connect the team ${name} account`]
        : ["Reconnect the team account", `Reconnect the team ${name} account`];
  return (
    <Button
      render={
        <Link
          params={{ key: page }}
          rel="noreferrer"
          target="_blank"
          to="/admin/plugins/$key"
        />
      }
      aria-label={spoken}
      size="sm"
    >
      {label}
    </Button>
  );
}

/**
 * The Bot's owner giving it one of their own apps, as one press: Allow, or Connect and allow where
 * the app runs on their own account and they have not connected it.
 *
 * CONNECT FIRST, THEN GIVE, ON THE SAME PRESS. The consent opens in a new tab the way `ConnectAction`
 * opens it, and this tab watches the server until the account is there — `needsConnect` turning false
 * — and then gives the app without a second press. Giving first would leave a Bot holding an app
 * nobody had connected if the person closed the consent screen, and would swap this button for a
 * Connect in the middle of the press.
 *
 * AN APP CONNECTED WITH A TYPED KEY is connected on its page in Settings, as `ConnectAction` sends it;
 * coming back, the app reads connected and the button says Allow.
 *
 * AND THEN THE TASK CARRIES ON. Every query is read again once the app is given, so the card sees the
 * app ready and carries the conversation on (`lib/copilot/carry-on.ts`).
 */
function OwnerGiveAction({
  agentId,
  access,
}: {
  agentId: string;
  access: AppAccess;
}) {
  const bot = useQuery(agentQueryOptions(agentId)).data?.name ?? "this Bot";
  const give = useMutation(giveBotAppMutationOptions(queryClient));
  const tab = useConnectInNewTab();
  const { waiting, stopWaiting } = tab;
  const name = access.displayName;
  /** Pressed while the account still had to be connected: give it as soon as it is. */
  const pending = useRef(false);

  const giveNow = () =>
    give.mutate(
      { agentId, app: access.key },
      { onSuccess: () => void queryClient.invalidateQueries() },
    );

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: appAccessKeys.all });
    }, 2_000);
    return () => clearInterval(timer);
  }, [waiting]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the account appears, once per press.
  useEffect(() => {
    if (!pending.current || access.needsConnect) return;
    pending.current = false;
    stopWaiting();
    giveNow();
  }, [access.needsConnect]);

  if (
    access.needsConnect &&
    (access.connect === "key" || access.connect === null || tab.needsKey)
  )
    return (
      <Button
        render={<Link params={{ key: access.key }} to="/connections/$key" />}
        aria-label={`Connect ${name}`}
        size="sm"
        variant="outline"
      >
        Connect
      </Button>
    );

  const error = give.error?.message ?? tab.error;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {error ? (
        <p className="text-destructive text-xs" role="alert">
          {error}
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
            Open {name}'s sign-in
          </a>
          .
        </p>
      ) : waiting ? (
        <p className="text-muted-foreground text-xs" role="status">
          Finish in the tab that opened.
        </p>
      ) : null}
      <Button
        aria-label={
          give.isPending || waiting
            ? undefined
            : `Let ${bot} use ${name}${access.needsConnect ? " after you connect it" : ""}`
        }
        disabled={give.isPending || tab.pending}
        onClick={() => {
          give.reset();
          if (access.needsConnect) {
            pending.current = true;
            stopWaiting();
            tab.open(access.key);
            return;
          }
          giveNow();
        }}
        size="sm"
      >
        {give.isPending
          ? "Allowing…"
          : waiting
            ? `Waiting for ${name}…`
            : access.needsConnect
              ? "Connect and allow"
              : "Allow"}
      </Button>
    </div>
  );
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
