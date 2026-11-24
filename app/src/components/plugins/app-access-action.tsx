import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import {
  type ConnectInNewTab,
  useConnectInNewTab,
} from "@/components/plugins/connect-in-new-tab";
import { Button } from "@/components/ui/button";
import { agentQueryOptions } from "@/lib/agents/queries";
import {
  approveBotAppMutationOptions,
  cancelAppAccessRequestMutationOptions,
  giveBotAppMutationOptions,
  requestAppAccessMutationOptions,
} from "@/lib/app-access/mutations";
import {
  type AppAccess,
  appAccessKeys,
  botAppQueryOptions,
} from "@/lib/app-access/queries";
import { appSetupQueryOptions } from "@/lib/apps/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useManagePaths } from "@/lib/manage-paths";
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
 * for the one state that asks the person a question about it. `admin` is whether the person looking
 * is an admin, who is offered the step itself (`AdminAction`) and so is never told to ask one.
 */
export function appAccessSentence(
  access: AppAccess,
  bot?: string,
  edition: "team" | "personal" = "team",
  admin = false,
): string {
  const name = access.displayName;
  const owners = access.accountHolder === "owner";
  /*
   * No admin in the personal edition: the button beside this turns the app on and connects it
   * (`PersonalConnectAction`), so the sentence says what is missing, not who to ask.
   */
  if (
    edition === "personal" &&
    (access.state === "not_granted" ||
      (access.state === "disabled" &&
        (access.unavailable === null || access.unavailable === "absent")))
  )
    return `${name} isn't connected yet.`;
  /*
   * An admin's own step: the button beside this takes it (`AdminAction`), so the sentence says what
   * is missing. "Only an admin can give it" told the admin of their own organization to ask an admin.
   */
  if (admin && edition === "team") {
    const missing = adminSentence(access);
    if (missing) return missing;
  }
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
      return disabledSentence(access, edition);
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
 * What is missing, said to the admin whose button beside it fixes it, for the states `AdminAction`
 * offers the step for. Null for every other state, which reads the same for everybody.
 */
function adminSentence(access: AppAccess): string | null {
  const name = access.displayName;
  switch (access.state) {
    case "not_granted":
      return `This Bot hasn't been given ${name} yet.`;
    case "shared_not_connected":
      return `Your organization's ${name} account isn't connected yet.`;
    case "disabled":
      switch (access.unavailable) {
        case "directory_unavailable":
          return `${name} isn't set up yet.`;
        case "scheme_unreadable":
        case "oauth_client_missing":
        case "token_missing":
          return `${name} isn't fully set up yet.`;
        default:
          return `${name} isn't turned on yet.`;
      }
    default:
      return null;
  }
}

/**
 * Switched off, in the words for why. "Turned off by an admin" was true of one reason in five: an
 * app nobody switched on, and a set-up somebody has not finished, are not a decision anybody took.
 * The unconfigured-broker case says what the app's page under Connections says about the same app,
 * so the two screens never disagree about it.
 */
function disabledSentence(
  access: AppAccess,
  edition: "team" | "personal",
): string {
  const name = access.displayName;
  // Nobody else to ask in the personal edition: the person is told what is missing, and Set it up
  // beside the sentence goes to where it is fixed.
  if (edition === "personal")
    return access.unavailable === "directory_unavailable"
      ? `${name} isn't set up yet. Set it up to connect it.`
      : `${name} isn't fully set up yet. Set it up to finish.`;
  switch (access.unavailable) {
    case "directory_unavailable":
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
 *   with the connect route Settings presses; an app connected with a typed key goes to the app's own
 *   page with the key form open, and a Composio app that already has a row (which the connect route
 *   refuses until it is disconnected) goes to that page as it is, where Disconnect is.
 * - the three an administrator fixes — Request access, which files the request the server decides
 *   the kind of, and then Requested with a way to withdraw it. Pressed by an administrator, it would
 *   be a request to themselves, so they get the fix itself instead: see `AdminAction`.
 *
 * `actions` are the actions of the app a Bot that holds it needs and wasn't given, from a card the
 * Bot put up for them (`AppAccessCard`, a `tools` prompt). Every press below then gives, or asks
 * for, exactly those, where without them it gives the app's read-only actions.
 */
export function AppAccessAction({
  agentId,
  access,
  actions,
}: {
  agentId: string;
  access: AppAccess;
  actions?: string[];
}) {
  /*
   * WHO IS LOOKING decides only which button is drawn, never what is allowed: the server answers
   * the one press 403 for anybody else, and `SharedAppNotice` already reads the role the same way.
   */
  const me = useQuery(currentUserQueryOptions()).data;
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  /*
   * ONE TAB FOR EVERY BUTTON BELOW. The personal edition's Connect turns the app on and then asks
   * for the sign-in; turning it on refetches this app, which swaps `PersonalConnectAction` for
   * `ConnectAction` while the sign-in is still being asked for. Held here, the tab survives the
   * swap: it is navigated, and the button that replaced the first one goes on waiting for it.
   */
  const tab = useConnectInNewTab();
  /*
   * A PRESS THAT TURNED OUT TO NEED A KEY goes to where the key is typed, with the form open. The
   * connect route answers a key app with the fields to fill in rather than a sign-in, and the
   * button that pressed it may have been swapped by then, so the tab's answer is watched here.
   */
  const navigate = useNavigate();
  useEffect(() => {
    if (tab.needsKey) void navigate(keyForm(access.key));
  }, [tab.needsKey, navigate, access.key]);
  /*
   * OpenBot's step before a sign-in, in OpenBot Desktop's window. Drawn whichever button is: the
   * one that pressed Connect can be swapped for another while the step is on screen.
   */
  return (
    <>
      {appAccessButton({
        access,
        actions,
        agentId,
        personal,
        role: me?.role,
        tab,
      })}
      {tab.consentStep}
    </>
  );
}

/** An app's page with its key form open (`?connect=true`), which is where a key is typed. */
function keyForm(app: string) {
  return {
    to: "/connections/$key" as const,
    params: { key: app },
    search: { connect: true as const },
  };
}

/**
 * THE REST OF CONNECTING, ON THE PRESS THAT TURNED THE APP ON OR GAVE IT.
 *
 * An app nobody has turned on may not say how it connects yet (its directory listing was not
 * available), so once the press has turned it on the app is read again and the person is taken to
 * whatever is left: the key form for an app that takes a key, the sign-in for one that signs in,
 * and nothing for one that is ready. These presses used to stop at on, and the card swapped to a
 * second Connect the person had to find and press: for a key app like Fireflies, and for a sign-in
 * app the directory had not described yet, like Slack.
 *
 * THE SIGN-IN TAB IS CLAIMED ON THE CLICK whenever the press might end in a sign-in, because a
 * browser only opens a tab while the click is recent, and turning the app on and reading it again
 * can take longer than that. The claimed tab is pointed at the sign-in once the app says it signs
 * in, and closed if it turns out to take a key or need nothing. A press known to end at a key form
 * claims no tab (`withoutTab`).
 */
function useConnectOnceOn(agentId: string, tab: ConnectInNewTab) {
  const navigate = useNavigate();

  /**
   * What is left once the app is on: the app to sign in to, or the step that takes the sign-in's
   * place. The grants a Bot is offered are read per conversation, so every query is read again.
   */
  const whatIsLeft = async (
    app: string,
  ): Promise<{ signIn: string } | { next: () => Promise<unknown> }> => {
    const now = await queryClient.fetchQuery({
      ...botAppQueryOptions(agentId, app),
      staleTime: 0,
    });
    // On, and nothing given yet because its tools come with the sign-in: Notion's case.
    if (now.state === "not_granted" && signsInFirst(now))
      return { signIn: now.key };
    if (now.state !== "not_connected")
      return { next: () => queryClient.invalidateQueries() };
    if (now.connect === "key")
      return {
        next: () => {
          void queryClient.invalidateQueries();
          return navigate(keyForm(now.key));
        },
      };
    return { signIn: now.key };
  };

  return {
    /** Claim the tab on the click, turn the app on, then sign in there or close it unused. */
    claimingTab: (app: string, turnOn: () => Promise<unknown>) => {
      tab.stopWaiting();
      let instead: (() => Promise<unknown>) | null = null;
      void tab
        .openAfter(async () => {
          try {
            await turnOn();
            const left = await whatIsLeft(app);
            if ("signIn" in left) return left.signIn;
            instead = left.next;
            return null;
          } catch (thrown) {
            // A refusal is drawn from the mutation's error; a failed read leaves the card's state.
            void queryClient.invalidateQueries();
            throw thrown;
          }
        })
        // Once the unused tab is closed: the key form, or the card reads the app as ready.
        .then(() => instead?.());
    },
    /** For an app known to take a key: turn it on, then the key form, with no tab. */
    withoutTab: (app: string, turnOn: () => Promise<unknown>) => {
      turnOn()
        .then(() => whatIsLeft(app))
        .then((left) => {
          if (!("signIn" in left)) return left.next();
          tab.stopWaiting();
          tab.open(left.signIn);
        })
        .catch(() => queryClient.invalidateQueries());
    },
  };
}

/**
 * Whether the app runs on the person's own account, signs in, and they haven't signed in. Notion
 * lists its tools only once somebody has, so a Bot can't be given it before then: an admin's press
 * signs them in first and gives it after (`AdminAction`).
 */
function signsInFirst(access: AppAccess): boolean {
  return (
    access.account === "personal" &&
    access.accountHolder !== "owner" &&
    (access.connect === "oauth" || access.connect === "consent") &&
    access.connectedAt === null
  );
}

/** Which of the buttons below an app's state calls for, or nothing where it is ready. */
function appAccessButton({
  access,
  actions,
  agentId,
  personal,
  role,
  tab,
}: {
  access: AppAccess;
  actions: string[] | undefined;
  agentId: string;
  personal: boolean;
  role: string | null | undefined;
  tab: ConnectInNewTab;
}) {
  if (access.state === "ready" || access.state === "shared_not_approved")
    return null;
  /*
   * The personal edition's Connect is for an app not turned on yet. Actions not given, of an app the
   * Bot already holds, are the give itself, which the one person takes as an admin does.
   */
  if (
    personal &&
    !(actions && access.state === "not_granted") &&
    (access.state === "not_granted" ||
      (access.state === "disabled" &&
        (access.unavailable === null || access.unavailable === "absent")))
  )
    return (
      <PersonalConnectAction access={access} agentId={agentId} tab={tab} />
    );
  if (access.state === "reconnect" && access.accountHolder === "owner")
    return null;
  if (access.state === "not_connected" || access.state === "reconnect")
    return <ConnectAction access={access} tab={tab} />;
  // Theirs to give, admin or not: an owner's grant keeps every call on the asker's own account.
  if (access.state === "owner_grantable")
    return (
      <OwnerGiveAction
        access={access}
        actions={actions}
        agentId={agentId}
        tab={tab}
      />
    );
  if (isOrganizationAdmin(role))
    return (
      <AdminAction
        access={access}
        actions={actions}
        agentId={agentId}
        tab={tab}
      />
    );
  return <RequestAction access={access} actions={actions} agentId={agentId} />;
}

/**
 * The step only an administrator can take, offered to the administrator as the step itself.
 *
 * ONE PRESS WHERE ONE PRESS CAN DO IT. An app nobody switched on, or one this Bot was never given,
 * is switched on and given here through the inbox's own approval (`approveBotAppMutationOptions`):
 * the same checks, the read-only actions only, and the same trail. Anything that sends or writes is
 * still chosen on the Bot's page.
 *
 * AND THEN THE ADMIN'S OWN ACCOUNT, ON THE SAME PRESS. Once it is on and given, an app the admin
 * still has to connect goes straight on to its key form or its sign-in (`useConnectOnceOn`). The
 * card asked because the admin's own task needed the app, so connecting it is the next step.
 *
 * SIGNED IN FIRST WHERE THE TOOLS COME WITH THE SIGN-IN. Notion lists its tools only for somebody
 * who has signed in, so there is nothing to give a Bot before the admin has. The press turns it on
 * with nothing given, opens the admin's sign-in, and once their account is connected gives it on
 * the same press, the way `OwnerGiveAction` connects first and gives after.
 *
 * A LINK WHERE IT CANNOT. A broker with no key, a set-up somebody left unfinished and a team account
 * nobody connected all need something only typed or consented to on the app's admin page. That page
 * opens in a new tab so the conversation stays where it is, and the card reads the app again when
 * this tab has the focus back.
 *
 * NAMED ACTIONS ARE GIVEN AS NAMED. With `actions` the press gives exactly those, and never waits
 * for a sign-in first: the actions are already known, so there is no list to wait for. A sign-in
 * the admin still owes comes after, as above, and an app they have already connected is given with
 * no tab opened at all.
 */
function AdminAction({
  agentId,
  access,
  actions,
  tab,
}: {
  agentId: string;
  access: AppAccess;
  actions: string[] | undefined;
  tab: ConnectInNewTab;
}) {
  const paths = useManagePaths();
  const bot = useQuery(agentQueryOptions(agentId)).data?.name ?? "this Bot";
  const approve = useMutation(approveBotAppMutationOptions(queryClient));
  const setup = useQuery(appSetupQueryOptions()).data;
  const connectOnceOn = useConnectOnceOn(agentId, tab);
  const name = access.displayName;
  const { waiting, stopWaiting } = tab;
  /** Pressed before the admin had signed in: give it as soon as they have. */
  const pending = useRef(false);

  // Watched as `ConnectAction` watches: the card reads the app again until the account is there.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: appAccessKeys.all });
    }, 2_000);
    return () => clearInterval(timer);
  }, [waiting]);

  const signedIn = access.connectedAt !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the admin's account appears, once per press.
  useEffect(() => {
    if (!pending.current || !signedIn || access.state !== "not_granted") return;
    pending.current = false;
    stopWaiting();
    // Its tools are listed now, so this press gives them. A refusal is drawn from `approve.error`.
    approve
      .mutateAsync({ agentId, app: access.key, actions })
      .then(() => queryClient.invalidateQueries())
      .catch(() => queryClient.invalidateQueries());
  }, [signedIn, access.state]);

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
    const error = approve.error?.message ?? tab.error;
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
            approve.isPending || waiting || tab.pending ? undefined : spoken
          }
          disabled={approve.isPending || tab.pending}
          onClick={() => {
            approve.reset();
            pending.current = !actions && signsInFirst(access);
            /*
             * Awaited, not given callbacks: turning it on refetches this app and can swap this
             * button for another, and TanStack Query drops a `mutate()` callback once nothing is
             * listening. A refusal is drawn from `approve.error`.
             */
            const turnOn = () =>
              approve.mutateAsync({ agentId, app: access.key, actions });
            // Named actions with no sign-in owed: given, and no tab is claimed only to be closed.
            if (access.connect === "key" || (actions && !signsInFirst(access)))
              connectOnceOn.withoutTab(access.key, turnOn);
            else connectOnceOn.claimingTab(access.key, turnOn);
          }}
          size="sm"
        >
          {waiting
            ? `Waiting for ${name}…`
            : approve.isPending
              ? disabled
                ? "Turning on…"
                : "Giving…"
              : tab.pending
                ? "Opening sign-in…"
                : label}
        </Button>
      </div>
    );
  }

  // The directory's own page: Composio's unless this OpenBot's directory is Arcade's.
  const page =
    access.state === "disabled" &&
    access.unavailable === "directory_unavailable"
      ? setup?.directoryProvider === "arcade"
        ? "arcade"
        : "composio"
      : access.key;
  const [label, spoken] =
    access.state !== "shared_not_connected"
      ? ["Set it up", `Set up ${name}`]
      : access.requestKind
        ? ["Connect the shared account", `Connect the shared ${name} account`]
        : [
            "Reconnect the shared account",
            `Reconnect the shared ${name} account`,
          ];
  /*
   * A broker with no key is set up on its directory, which is a page of its own in the personal
   * edition. There `/connections/composio` would read as an app called "composio" and say there is
   * none; the team edition's `/admin/plugins/composio` happens to be that directory already.
   */
  const target =
    page === "composio" || page === "arcade"
      ? paths.brokerDirectory(page)
      : paths.plugin(page);
  return (
    <Button
      render={<Link {...target} rel="noreferrer" target="_blank" />}
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
 *
 * With `actions`, the press gives exactly those, for a Bot that holds the app and needs them too.
 */
function OwnerGiveAction({
  agentId,
  access,
  actions,
  tab,
}: {
  agentId: string;
  access: AppAccess;
  actions: string[] | undefined;
  tab: ConnectInNewTab;
}) {
  const bot = useQuery(agentQueryOptions(agentId)).data?.name ?? "this Bot";
  const give = useMutation(giveBotAppMutationOptions(queryClient));
  const { waiting, stopWaiting } = tab;
  const name = access.displayName;
  /** Pressed while the account still had to be connected: give it as soon as it is. */
  const pending = useRef(false);

  const giveNow = () =>
    give.mutate(
      { agentId, app: access.key, actions },
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
          give.isPending || waiting || tab.pending
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
            : tab.pending
              ? "Opening sign-in…"
              : access.needsConnect
                ? "Connect and allow"
                : "Allow"}
      </Button>
    </div>
  );
}

/**
 * The personal edition's one press, for an app the one person hasn't turned on yet: Connect turns it
 * on and goes straight on to what is left, all on the same press. An app that signs in opens its
 * sign-in in a new tab; an app that takes a key opens its page with the key form, in this tab; an
 * app that needs nothing is ready. Turning it on goes through the same approval an administrator's
 * "Turn on and give it" does, catalogue and broker apps alike, and the server then gives every Bot
 * every tool (`personal-defaults.ts`).
 *
 * ALWAYS CONNECT, never Turn on: the press is for using the app, and switching it on is only the
 * first half of that. It said Turn on where the app did not yet say how it connects, and then a
 * second Connect was what took the person to their key.
 */
function PersonalConnectAction({
  agentId,
  access,
  tab,
}: {
  agentId: string;
  access: AppAccess;
  tab: ConnectInNewTab;
}) {
  const approve = useMutation(approveBotAppMutationOptions(queryClient));
  const { waiting } = tab;
  const name = access.displayName;
  const signsIn = access.connect === "oauth" || access.connect === "consent";

  // Watched as `ConnectAction` watches: the card reads the app again until it is ready.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: appAccessKeys.all });
    }, 2_000);
    return () => clearInterval(timer);
  }, [waiting]);

  const turnOn = () => approve.mutateAsync({ agentId, app: access.key });
  const connectOnceOn = useConnectOnceOn(agentId, tab);

  /*
   * Turned on, and the connect route then asked for a key: `AppAccessAction` has already gone to
   * the key form. Left here, this is the way back to it.
   */
  if (tab.needsKey)
    return (
      <Button
        render={<Link {...keyForm(access.key)} />}
        aria-label={`Connect ${name}`}
        size="sm"
      >
        Connect
      </Button>
    );

  const error = approve.error?.message ?? tab.error;
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
          waiting || approve.isPending || tab.pending
            ? undefined
            : `Connect ${name}`
        }
        disabled={approve.isPending || tab.pending}
        onClick={() => {
          approve.reset();
          // Known to sign in: the tab is claimed on the click, before turning it on.
          if (signsIn) {
            tab.stopWaiting();
            tab.open(access.key, turnOn);
            return;
          }
          // Known to take a key: no tab. Not known yet: the tab is claimed in case it signs in.
          if (access.connect === "key")
            connectOnceOn.withoutTab(access.key, turnOn);
          else connectOnceOn.claimingTab(access.key, turnOn);
        }}
        size="sm"
      >
        {waiting
          ? `Waiting for ${name}…`
          : approve.isPending
            ? "Turning on…"
            : tab.pending
              ? "Opening sign-in…"
              : "Connect"}
      </Button>
    </div>
  );
}

/** The person's own account: connect it, or reconnect it. */
function ConnectAction({
  access,
  tab,
}: {
  access: AppAccess;
  tab: ConnectInNewTab;
}) {
  const label = access.state === "reconnect" ? "Reconnect" : "Connect";
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
  /*
   * A key to type opens the page with its form open, so Connect goes straight to the key. A
   * connection to repair opens the page as it is, where Disconnect is.
   */
  const typesKey =
    access.state === "not_connected" &&
    (access.connect === "key" || tab.needsKey);
  if (viaSettings)
    return (
      <Button
        render={
          typesKey ? (
            <Link {...keyForm(access.key)} />
          ) : (
            <Link params={{ key: access.key }} to="/connections/$key" />
          )
        }
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
        // Named for the app while it is idle; otherwise the visible words say what is happening.
        aria-label={
          waiting || tab.pending ? undefined : `${label} ${access.displayName}`
        }
        disabled={tab.pending}
        onClick={() => {
          stopWaiting();
          tab.open(access.key);
        }}
        size="sm"
        variant="outline"
      >
        {waiting
          ? `Waiting for ${access.displayName}…`
          : tab.pending
            ? "Opening sign-in…"
            : label}
      </Button>
    </div>
  );
}

/**
 * A step only an administrator can take: ask for it, and withdraw the ask. With `actions`, the
 * request asks for exactly those, and approving it gives them.
 */
function RequestAction({
  agentId,
  access,
  actions,
}: {
  agentId: string;
  access: AppAccess;
  actions: string[] | undefined;
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
            request.mutate({ agentId, app: access.key, actions }, refocus);
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
