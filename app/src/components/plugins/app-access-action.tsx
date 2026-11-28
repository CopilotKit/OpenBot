import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
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
import { addDirectoryAppMutationOptions } from "@/lib/apps/mutations";
import {
  appSetupQueryOptions,
  directoryAppsQueryOptions,
} from "@/lib/apps/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import { appPageReads, useOpenAppPage } from "@/lib/connections/open-app-page";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useAppsOpen } from "@/lib/enterprise/apps-open";
import { failureSaid } from "@/lib/load-failure";
import { useManagePaths } from "@/lib/manage-paths";
import {
  type AdminName,
  sentTo,
  withAdmins,
} from "@/lib/organizations/admin-names";
import { useOrganizationAdmins } from "@/lib/organizations/queries";
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
 * Apps are open in this organization (its switch, `useAppsOpen`), and whether the person looking owns
 * this Bot (the Bot's `mine`). Null where apps are locked down: every sentence and button is then the
 * one a member has always had.
 */
export type OpenApps = { owner: boolean } | null;

/**
 * The steps open apps hand to a member: adding an app nobody has added (switched off only because
 * nobody switched it on), and giving one that is open to Bot owners. Locked down, both are an
 * admin's. Everything else an admin keeps either way: finishing a set-up, the shared account, an app
 * an admin kept to admins. A Bot nobody owns (`ownerless`) has no owner to give it one, so giving it
 * one stays an admin's even where the app is open to Bot owners.
 */
function openToMember(access: AppAccess, ownerless = false): boolean {
  if (access.state === "disabled")
    return access.unavailable === null || access.unavailable === "absent";
  return (
    access.state === "not_granted" && access.ownerGrants === "any" && !ownerless
  );
}

/**
 * Whether nobody owns this Bot (the Bot's `ownerless`, the server's verdict), as with a Bot OpenBot
 * made for everyone in the organization: only an admin can give it apps, and no sentence names its
 * owner. Undefined until the Bot is known. A server that never says reads as owned, and so does a Bot
 * that couldn't be read.
 *
 * FOUND IN DOGFOODING. A member asked the organization's shared General Assistant for Google
 * Calendar, connected it, and was told the Bot's owner could give it. Nobody owns that Bot.
 */
export function useOwnerless(agentId: string): boolean | undefined {
  const bot = useQuery(agentQueryOptions(agentId));
  if (bot.isPending) return undefined;
  return bot.data?.ownerless === true;
}

/**
 * Whether the sentence for this app tells the person looking that only an admin can take the step:
 * a member of the team edition, for the states an admin fixes. Where it does, the screen reads the
 * organization's admins (`useOrganizationAdmins`) and the sentence names them. With apps open, the
 * steps they hand to a member name nobody, except on a Bot nobody owns (`ownerless`), where giving it
 * the app is an admin's.
 */
export function namesAnAdmin(
  access: AppAccess,
  edition: "team" | "personal",
  admin: boolean,
  open: OpenApps = null,
  ownerless = false,
): boolean {
  if (admin || edition !== "team") return false;
  if (open && !ownerless && openToMember(access)) return false;
  return (
    access.state === "not_granted" ||
    access.state === "disabled" ||
    access.state === "shared_not_connected" ||
    access.state === "shared_not_approved"
  );
}

/**
 * What the person is told about one app, in words that say whose move it is. `bot` is the Bot's name,
 * for the one state that asks the person a question about it. `admin` is whether the person looking
 * is an admin, who is offered the step itself (`AdminAction`) and so is never told to ask one.
 * `admins` are who a member is told to go to where only an admin can take the step (`withAdmins`).
 * `open` is set where apps are open (`OpenApps`): a member is then told the step that is theirs, or
 * that the Bot's owner's, and never to ask an admin for it. `ownerless` is set for a Bot nobody owns
 * (`useOwnerless`): there is no owner to name, so a member is told only an admin can give it apps.
 */
export function appAccessSentence(
  access: AppAccess,
  bot?: string,
  edition: "team" | "personal" = "team",
  admin = false,
  admins: readonly AdminName[] = [],
  open: OpenApps = null,
  ownerless = false,
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
  /*
   * Apps open: the Bot's owner has the admin's button beside this (`AdminAction`), so is told what
   * is missing, as an admin is. Anybody else can't give it, and is told so first (`notYoursToGive`).
   */
  if (open && edition === "team" && !admin && openToMember(access, ownerless)) {
    const name = access.displayName;
    if (ownerless) return notYoursToGive(access, bot, admins);
    if (!open.owner) return notYoursToGive(access, bot);
    return access.state === "not_granted"
      ? `This Bot hasn't been given ${name} yet.`
      : `${name} isn't connected yet.`;
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
      return withAdmins(
        `Your organisation's ${name} account isn't connected yet. Only an admin can connect it.`,
        admins,
      );
    case "shared_not_approved":
      return withAdmins(
        `This Bot reaches more people than an admin approved for your organisation's ${name} account. Only an admin can approve it.`,
        admins,
      );
    case "disabled":
      return disabledSentence(access, edition, admins);
    case "not_granted":
      // Open to Bot owners unless an admin closed it: then the Bot's owner can give it too, where it has one.
      return access.ownerGrants === "any" && !ownerless
        ? withAdmins(
            `This Bot hasn't been given ${name}. Its owner can give it, or an admin.`,
            admins,
          )
        : withAdmins(
            `This Bot hasn't been given ${name}. Only an admin can give it.`,
            admins,
          );
    case "owner_grantable": {
      const yours = access.account === "personal" ? `your ${name}` : name;
      const ask = `Let ${bot ?? "this Bot"} use ${yours}?`;
      return access.needsConnect ? `${ask} Connect it first.` : ask;
    }
  }
}

/**
 * Somebody else's Bot, apps open, an app it wasn't given: who can give it, and that Request access
 * beside this asks for it.
 *
 * FOUND IN DOGFOODING. A member asked his organization's General Assistant, a shared Bot he could
 * only view, to hook up his Google Calendar. The card said "Connect it, and this Bot's owner can
 * give it to the Bot", so he connected it, which gave the Bot nothing; then it said "Its owner can
 * give it" with nothing to press. Now the first thing it says is who can give it, and the button
 * asks them. Connecting his own account, where it isn't, is offered beside it, and said to be his.
 *
 * AND NOBODY OWNS THAT BOT. Where a Bot has no owner (`ownerless`), only an admin can give it the
 * app, so the sentence says so and names them (`admins`, as `withAdmins` does), and leaves the owner
 * out. `admins` is given only for such a Bot.
 */
export function notYoursToGive(
  access: AppAccess,
  bot?: string,
  admins?: readonly AdminName[],
): string {
  const owner = bot ? `${bot}'s` : "this Bot's";
  const who = admins
    ? withAdmins(
        `Only an admin can give ${access.displayName} to ${bot ?? "this Bot"}.`,
        admins,
      )
    : `Only ${owner} owner or an admin can give it ${access.displayName}.`;
  const ask = access.request ? "" : " Request access to ask for it.";
  return `${who}${ask}${connectsOwnToo(access) ? " You can connect your own account now too." : ""}`;
}

/**
 * Whether, on somebody else's Bot that wasn't given an app, the person can connect their own
 * account to it now: it runs on each person's own account and theirs isn't connected. An app
 * nobody has added is added for everybody on the same press (`AddAndConnectAction`), unless they
 * already asked for it: approving that request adds it, and adding it first would leave the card
 * asking for it again.
 */
function connectsOwnToo(access: AppAccess): boolean {
  if (access.account !== "personal" || access.accountHolder === "owner")
    return false;
  if (access.state === "disabled")
    return (
      access.request === null &&
      access.source !== "address" &&
      (access.unavailable === null || access.unavailable === "absent")
    );
  return access.state === "not_granted" && access.connectedAt === null;
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
          // Said to the admin whose Connect beside it adds and connects it in one press.
          return `${name} isn't connected yet.`;
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
  admins: readonly AdminName[],
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
      return withAdmins(
        `${name} isn't set up yet. An admin has to turn it on.`,
        admins,
      );
    case "scheme_unreadable":
    case "oauth_client_missing":
    case "token_missing":
      return withAdmins(
        `${name} isn't fully set up yet. Only an admin can finish setting it up.`,
        admins,
      );
    default:
      return withAdmins(
        `${name} isn't turned on yet. Only an admin can turn it on.`,
        admins,
      );
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
 * - `not_connected` / `reconnect` — the person's own connection. Connect and Reconnect start the
 *   sign-in in a new tab with the connect route Settings presses, for every app that signs in; an
 *   app connected with a typed key goes to the app's own page with the key form open, Reconnect
 *   included.
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
  const open = useOpenApps(agentId) ?? null;
  const ownerless = useOwnerless(agentId) ?? false;
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
        open,
        ownerless,
        personal,
        role: me?.role,
        tab,
      })}
      {tab.consentStep}
    </>
  );
}

/**
 * `OpenApps` for the person looking at this Bot: whether apps are open, and whether the Bot is theirs
 * (`mine`, the server's verdict). Null wherever apps are locked down, and undefined until that and
 * the Bot are known, so nothing is drawn as open before it is known to be and a screen can wait to
 * read who the admins are. A Bot that couldn't be read is read as not theirs: they are offered what
 * anybody is, and the server decides the press. A Bot nobody owns (`ownerless`) is nobody's, so
 * nobody is offered an owner's button on it.
 */
export function useOpenApps(agentId: string): OpenApps | undefined {
  const open = useAppsOpen();
  const bot = useQuery(agentQueryOptions(agentId));
  if (open === undefined) return undefined;
  if (!open) return null;
  if (bot.isPending) return undefined;
  return { owner: (bot.data?.mine ?? false) && bot.data?.ownerless !== true };
}

/**
 * What a press says while it is on its way, once the app is on: an app that takes a key is going
 * to its key form, and anything else to its sign-in.
 */
function openingWord(access: AppAccess): string {
  return access.connect === "key" ? "Connecting…" : "Opening sign-in…";
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
    /*
     * Added, and not this person's to give (apps open, somebody else's Bot): their own key next,
     * as their own sign-in is next above. The Bot's owner gives it.
     */
    if (
      now.state === "not_granted" &&
      now.account === "personal" &&
      now.connect === "key" &&
      now.connectedAt === null
    )
      return { next: () => toKeyForm(now.key) };
    if (now.state !== "not_connected")
      return { next: () => queryClient.invalidateQueries() };
    if (now.connect === "key") return { next: () => toKeyForm(now.key) };
    return { signIn: now.key };
  };

  /*
   * The key form, on a page that has something to draw: the press stays pending until its reads
   * are in (`appPageReads`), so the card never reads as done while the page is still on its way.
   */
  const toKeyForm = async (app: string) => {
    void queryClient.invalidateQueries();
    await appPageReads(queryClient).catch(() => undefined);
    return navigate(keyForm(app));
  };

  return {
    /** Claim the tab on the click, turn the app on, then sign in there or close it unused. */
    claimingTab: (app: string, turnOn: () => Promise<unknown>) => {
      tab.stopWaiting();
      let instead: (() => Promise<unknown>) | null = null;
      void tab.during(
        tab
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
          .then(() => instead?.()),
      );
    },
    /** For an app known to take a key: turn it on, then the key form, with no tab. */
    withoutTab: (app: string, turnOn: () => Promise<unknown>) => {
      void tab.during(
        turnOn()
          .then(() => whatIsLeft(app))
          .then((left) => {
            if (!("signIn" in left)) return left.next();
            tab.stopWaiting();
            tab.open(left.signIn);
          })
          .catch(() => queryClient.invalidateQueries()),
      );
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
  open,
  ownerless,
  personal,
  role,
  tab,
}: {
  access: AppAccess;
  actions: string[] | undefined;
  agentId: string;
  open: OpenApps;
  ownerless: boolean;
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
  /*
   * APPS OPEN: what an admin's press did is the Bot's owner's press too, Connect and give it in one
   * go. Anybody else can't give it, so they ask for it (`notYoursToGive`), and connect their own
   * account beside that where it isn't connected yet. A Bot nobody owns has no owner to give it one,
   * so an app it wasn't given is asked of an admin with Request access below.
   */
  if (open && openToMember(access, ownerless)) {
    if (open.owner)
      return (
        <AdminAction
          access={access}
          actions={actions}
          agentId={agentId}
          tab={tab}
        />
      );
    const ask = (
      <RequestAction access={access} actions={actions} agentId={agentId} />
    );
    if (!connectsOwnToo(access)) return ask;
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <AddAndConnectAction access={access} agentId={agentId} tab={tab} />
        {ask}
      </div>
    );
  }
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
    /*
     * Connect, never Turn on: the press adds the app and goes on to the admin's own account, and
     * switching it on is only the first half of that.
     */
    const label = disabled
      ? `Connect and give it to ${bot}`
      : `Give it to ${bot}`;
    // The card names the app beside the button; on its own, the button has to.
    const spoken = disabled
      ? `Connect ${name} and give it to ${bot}`
      : `Give ${name} to ${bot}`;
    const error = approve.error ?? tab.error;
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {error ? (
          <p className="text-destructive text-xs" role="alert">
            {failureSaid(error)}
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
                ? "Connecting…"
                : "Giving…"
              : tab.pending
                ? openingWord(access)
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
  /*
   * THE SHARED ACCOUNT'S SIGN-IN STARTS AS ITS PAGE OPENS (`?connect=true`), so Connect or Reconnect
   * the shared account is one press, as the admin's own Connect is. It used to open the page, where
   * a second Connect began it.
   */
  const target =
    page === "composio" || page === "arcade"
      ? paths.brokerDirectory(page)
      : access.state === "shared_not_connected"
        ? { ...paths.plugin(page), search: { connect: true as const } }
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

  const error = give.error ?? tab.error;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {error ? (
        <p className="text-destructive text-xs" role="alert">
          {failureSaid(error)}
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

  const error = approve.error ?? tab.error;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {error ? (
        <p className="text-destructive text-xs" role="alert">
          {failureSaid(error)}
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
            ? "Connecting…"
            : tab.pending
              ? openingWord(access)
              : "Connect"}
      </Button>
    </div>
  );
}

/**
 * Apps open, on somebody else's Bot: the person adds the app nobody has added and connects their own
 * account to it, in one press, as Connections' tiles do. Giving it to this Bot stays its owner's (the
 * sentence beside this says so). An app already added only needs their own account, where they
 * haven't connected it yet; otherwise there is nothing here for them to press.
 *
 * Added from where the app comes from (OpenBot's catalogue, or the directory's entry by its name),
 * then the rest is `useConnectOnceOn`: the sign-in, the key form, or nothing.
 */
function AddAndConnectAction({
  agentId,
  access,
  tab,
}: {
  agentId: string;
  access: AppAccess;
  tab: ConnectInNewTab;
}) {
  const add = useMutation(addDirectoryAppMutationOptions(queryClient));
  const connectOnceOn = useConnectOnceOn(agentId, tab);
  const { waiting } = tab;
  const name = access.displayName;
  /** The directory had no entry by the app's name to add it from. */
  const [notFound, setNotFound] = useState<Error | null>(null);

  // Watched as `ConnectAction` watches: the card reads the app again until the account is there.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: appAccessKeys.all });
    }, 2_000);
    return () => clearInterval(timer);
  }, [waiting]);

  const adding = access.state === "disabled";
  if (adding && access.source === "address") return null;
  if (!adding && (access.account !== "personal" || access.connectedAt !== null))
    return null;

  /*
   * The entry it is added from. A catalogue app's id is its entry's key. A directory app's id is not
   * its entry's, so the directory is searched by the app's name for the entry nobody has added.
   */
  const entryId = async (): Promise<string> => {
    if (access.source === "catalogue") return `catalogue:${access.key}`;
    const found = await queryClient.fetchQuery(
      directoryAppsQueryOptions(access.displayName),
    );
    const entry = found.find(
      (candidate) =>
        candidate.appId === null &&
        candidate.title.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (!entry)
      throw new Error(`Couldn't find ${name} to add. Find it in Connections.`);
    return entry.id;
  };
  const turnOn = adding
    ? async () => {
        let directoryEntryId: string;
        try {
          directoryEntryId = await entryId();
        } catch (thrown) {
          setNotFound(thrown instanceof Error ? thrown : null);
          throw thrown;
        }
        return add.mutateAsync({ directoryEntryId });
      }
    : () => Promise.resolve();
  const error = add.error ?? notFound ?? tab.error;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {error ? (
        <p className="text-destructive text-xs" role="alert">
          {failureSaid(error)}
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
          waiting || add.isPending || tab.pending
            ? undefined
            : `Connect ${name}`
        }
        disabled={add.isPending || tab.pending}
        onClick={() => {
          add.reset();
          setNotFound(null);
          // Known to take a key: no tab. Otherwise the tab is claimed in case it signs in.
          if (access.connect === "key")
            connectOnceOn.withoutTab(access.key, turnOn);
          else connectOnceOn.claimingTab(access.key, turnOn);
        }}
        size="sm"
        variant={adding ? "default" : "outline"}
      >
        {waiting
          ? `Waiting for ${name}…`
          : add.isPending
            ? "Connecting…"
            : tab.pending
              ? openingWord(access)
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
  const appPage = useOpenAppPage();

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
   * A FORM IS SETTINGS' JOB: a typed key has nowhere to be typed but the app's page. A SIGN-IN IS
   * STARTED HERE, Connect and Reconnect alike, on every kind of app that signs in: this OpenBot's own
   * sign-in (`oauth`) and a directory's (`consent`, Composio's or Arcade's). The connect route takes
   * a fresh sign-in over a connection that stands: a new consent over a withdrawn grant, an Arcade
   * consent over the connection it adds to, and on Composio a new account beside one the call
   * found lost. Reconnect used to open a sign-in app's page as it was, where a second press began it.
   * Only an app that says nothing of how it connects still opens its page.
   */
  const viaSettings =
    access.connect === "key" ||
    (access.state === "reconnect" && access.connect === null) ||
    tab.needsKey;
  /*
   * A key to type opens the page with its form open, so Connect goes straight to the key, and so
   * does Reconnect on a key the app didn't take: the new key replaces it in the same form.
   */
  const typesKey = access.connect === "key" || tab.needsKey;
  /*
   * The page opens once it has something to draw (`useOpenAppPage`): until then this button says
   * it is working, and the screen it is on stays as it is.
   */
  if (viaSettings) {
    const opening = appPage.opening === access.key;
    return (
      <Button
        aria-label={opening ? undefined : `${label} ${access.displayName}`}
        disabled={opening}
        onClick={() => void appPage.open(access.key, typesKey)}
        size="sm"
        variant="outline"
      >
        {opening ? "Connecting…" : label}
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {tab.error ? (
        <p className="text-destructive text-xs" role="alert">
          {failureSaid(tab.error)}
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
   * WHO IT WENT TO, beside Requested: the organization's admins, any of whom can answer it, so the
   * person knows who to follow up with. Nothing more while they are read, or if they can't be.
   */
  const sent = sentTo(useOrganizationAdmins(access.request !== null));

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
          {failureSaid(error)}
        </p>
      ) : null}
      {access.request ? (
        <>
          {sent ? (
            /*
             * Requested, and under it who it went to, in a narrow column: on a Bot's Apps row the
             * names wrap beside Withdraw and the app's own sentence keeps the width it had.
             */
            <span
              className="flex max-w-56 flex-col items-end text-right text-muted-foreground text-xs"
              role="status"
            >
              <span>Requested</span>
              <span>{sent}</span>
            </span>
          ) : (
            <span className="text-muted-foreground text-xs" role="status">
              Requested
            </span>
          )}
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
