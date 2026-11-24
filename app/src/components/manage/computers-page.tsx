import { isPersonBrowserId } from "@openbot/shared/openbot-browser";
import {
  IconAlertTriangle,
  IconBolt,
  IconDeviceDesktop,
  IconDeviceDesktopOff,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { SharedComputersNotice } from "@/components/admin/shared-computers-notice";
import {
  ClearBrowserDialog,
  useClearBrowserData,
} from "@/components/browser/browser-bar";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Separator } from "@/components/ui/separator";
import { useBotNames } from "@/lib/agents/bot-names";
import { useBotListScope } from "@/lib/agents/list-scope";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import { clearBrowserMutationOptions } from "@/lib/browser/mutations";
import {
  type HostAccessPendingOperation,
  type HostFolderGrant,
  hostAccessQueryOptions,
  requestHostFolderGrantMutationOptions,
  revokeHostFolderGrantMutationOptions,
  stopHostAccessMutationOptions,
} from "@/lib/computers/host-access";
import { setComputerStateMutationOptions } from "@/lib/computers/mutations";
import {
  type ComputerProfile,
  computerFleetQueryOptions,
  workspaceSnapshotsQueryOptions,
} from "@/lib/computers/queries";
import {
  deploymentCapabilitiesQueryOptions,
  useNoBotComputers,
} from "@/lib/deployment/queries";
import { loadFailure } from "@/lib/load-failure";
import { useManagePaths } from "@/lib/manage-paths";
import {
  RestoreComputerDialog,
  WorkspaceSnapshotsSection,
} from "./workspace-snapshots-section";

/** One row's identity: the computer, and on a shared computer the Bot's seat on it. */
function rowId(computer: ComputerProfile): string {
  return `${computer.computer}|${computer.botId ?? ""}`;
}

/**
 * A person's own OpenBot browser, the one Teach a Bot records in. It is listed beside the Bots' browsers, under an id
 * that is no Bot's, so it read "A Bot no longer here" until it was named for what it is.
 */
function isOwnBrowser(computer: ComputerProfile): boolean {
  return computer.botId !== undefined && isPersonBrowserId(computer.botId);
}

/**
 * What a confirmation is about, kept while its dialog closes.
 *
 * The dialog fades out after Cancel or Reset it, and its words are drawn on every frame of that.
 * Cleared on close, the row went with it, and the title fell back to its words for no row: "Reset the
 * computer?" flashed up as the dialog left after "Reset Fernhill Guide's browser?" was answered. So
 * closing only closes, and what the dialog names is replaced the next time it asks.
 */
function useConfirmation() {
  const [asking, setAsking] = useState<{
    about: ComputerProfile;
    open: boolean;
  } | null>(null);
  return {
    /** The row asked about, still named while the dialog closes. */
    about: asking?.about ?? null,
    open: asking?.open === true,
    ask: (about: ComputerProfile) => setAsking({ about, open: true }),
    close: () =>
      setAsking((current) => (current ? { ...current, open: false } : null)),
  };
}

/**
 * `children` are sections only the team edition's Admin adds below the page's own (the admin's
 * controls for these). The personal edition's Settings renders this page with none.
 *
 * In the personal edition this is one person's one computer. What only a team can act on goes: the
 * notice about giving each person a computer of their own, whose seat a row is, and where its
 * traffic leaves. Each Bot's browser stays, with Stop and Reset, because this is the one place the
 * person can sign a Bot out of everything.
 */
export function ComputersPage({
  children,
  agentId,
  embedded = false,
}: {
  children?: ReactNode;
  /**
   * One Bot's part, for its own Computer page: its folders on this computer and its own computer or
   * browser, with no page frame (the Bot's page draws one). Absent, the whole page.
   */
  agentId?: string;
  /** The sections only, inside a page that draws its own frame (Settings → Computer). */
  embedded?: boolean;
} = {}) {
  const paths = useManagePaths();
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  /** The row currently running a stop/reset request. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Reset deletes the browser profiles, so it requires confirmation. */
  const reset = useConfirmation();
  const confirming = reset.about;
  /** Updating restarts a running computer mid-task, so it is confirmed too. */
  const update = useConfirmation();
  const confirmingUpdate = update.about;
  /** An admin looking at another person's computer's saved copies. */
  const restoreOther = useConfirmation();
  const queryClient = useQueryClient();
  const nameFor = useBotNames();
  /*
   * The person's own OpenBot browser is cleared the way Teach a Bot clears it: a recording in it ends first, and its
   * Recorder connection ends with the profile. A Bot's Reset does neither.
   */
  const clearOwnBrowser = useMutation(clearBrowserMutationOptions(queryClient));
  const clearing = useClearBrowserData(clearOwnBrowser);

  // Every computer is an admin's to list. On one Bot's page a person who isn't an admin has only folders.
  const admin = isOrganizationAdmin(
    useQuery(currentUserQueryOptions()).data?.role,
  );
  /*
   * An OpenBot with no computers for Bots has no list to read: the server refuses it, and "Couldn't
   * load the computers. Reload the page." sent a person to retry what can never work. So the list
   * waits until the deployment has said whether there are computers, and is not asked for where
   * there are none.
   */
  const noComputers = useNoBotComputers();
  const fleet = useQuery({
    ...computerFleetQueryOptions(),
    enabled: (agentId === undefined || admin) && noComputers === false,
  });
  /*
   * The copies of the computer this Bot runs on for the person reading: its own section draws them,
   * and its answer names that computer, so an admin's Restore is offered only on the others' rows.
   */
  const ownCopies = useQuery({
    ...workspaceSnapshotsQueryOptions(agentId ?? ""),
    enabled: agentId !== undefined && noComputers === false,
  });
  const restorable = (computer: ComputerProfile): boolean =>
    agentId !== undefined &&
    admin &&
    ownCopies.data?.available === true &&
    computer.computer !== ownCopies.data.computer &&
    !isOwnBrowser(computer);
  const hostAccess = useQuery(hostAccessQueryOptions());
  const hosted =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.hostedSignIn === true;
  // Under Admin, every Bot in the organization (lib/agents/list-scope.tsx).
  const agents = useQuery(agentListQueryOptions(false, useBotListScope()));
  const setState = useMutation(setComputerStateMutationOptions(queryClient));
  const requestGrant = useMutation(
    requestHostFolderGrantMutationOptions(queryClient),
  );
  const revokeGrant = useMutation(
    revokeHostFolderGrantMutationOptions(queryClient),
  );
  const stopHostAccess = useMutation(
    stopHostAccessMutationOptions(queryClient),
  );

  const computers =
    fleet.data?.computers.filter(
      (computer) => agentId === undefined || computer.botId === agentId,
    ) ?? null;
  const isolation = fleet.data?.isolation ?? null;
  /*
   * A list that could not be read. A refused stop, reset or update is said beside the buttons
   * instead, because the top of this page is a long scroll away from them.
   */
  const problem = fleet.error
    ? loadFailure(
        fleet.error,
        "Couldn't load the computers. Try again in a moment.",
      )
    : null;
  const hostProblem = hostAccess.error
    ? hostAccess.error.message
    : requestGrant.error
      ? requestGrant.error.message
      : revokeGrant.error
        ? revokeGrant.error.message
        : stopHostAccess.error
          ? stopHostAccess.error.message
          : null;

  const run = (
    computer: ComputerProfile,
    action: "stop" | "reset" | "update",
  ) => {
    setBusy(rowId(computer));
    reset.close();
    update.close();
    setState.mutate(
      {
        action,
        computer: computer.computer,
        ...(computer.botId ? { botId: computer.botId } : {}),
      },
      { onSettled: () => setBusy(null) },
    );
  };

  /**
   * Whose computer a row is, in the words the rest of Admin uses.
   *
   * A person's computer is named for the person. An isolated Bot's is named for the Bot. On a shared
   * computer a row is one person's seat on one Bot, so it names both.
   */
  const titleOf = (computer: ComputerProfile): string => {
    if (isOwnBrowser(computer)) {
      if (personal) return "Your OpenBot browser";
      const owner = computer.person?.name ?? computer.person?.email;
      return owner
        ? `${owner}'s OpenBot browser`
        : "A person's OpenBot browser";
    }
    // One person, so a row is one of their Bots.
    if (personal) return computer.botId ? nameFor(computer.botId) : "Computer";
    const person =
      computer.person?.name ?? computer.person?.email ?? computer.personId;
    if (computer.kind === "person") {
      return computer.botId
        ? `${person} · ${nameFor(computer.botId)}`
        : `${person}'s computer`;
    }
    return computer.botId ? nameFor(computer.botId) : computer.computer;
  };

  /** Whose computer a row is, for the dialog that lists its saved copies. */
  const ownerOf = (computer: ComputerProfile): string => {
    if (computer.kind === "bot")
      return computer.botId
        ? `${nameFor(computer.botId)}'s computer`
        : "This Bot's computer";
    const person =
      computer.person?.name ?? computer.person?.email ?? computer.personId;
    return person ? `${person}'s computer` : "A person's computer";
  };

  /** What a row carries, said once before its state. */
  const scopeOf = (computer: ComputerProfile): string => {
    if (isOwnBrowser(computer)) return "Their own browser for Teach a Bot";
    if (computer.kind === "person") {
      return computer.botId
        ? "This person's profile and folder for this Bot"
        : "Runs every Bot this person uses";
    }
    return isolation === "shared"
      ? "This Bot's profile from before each person had their own"
      : "Isolated: a computer of its own, shared by everyone who uses it";
  };

  /** Whether its browser runs, and when it starts again. */
  const stateOf = (computer: ComputerProfile): string => {
    const since = computer.running
      ? `Browser running since ${new Date(computer.startedAt ?? "").toLocaleTimeString()}`
      : "No browser running";
    if (!isOwnBrowser(computer))
      return computer.running
        ? since
        : `${since}. It starts when the Bot next needs it.`;
    // In the team edition the row already says it is that person's browser for Teach a Bot.
    if (!personal) return since;
    return computer.running
      ? `${since}. You record in it with Teach a Bot.`
      : `${since}. It opens when you record with Teach a Bot.`;
  };

  const body = (
    <>
      {problem ? (
        <p
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          role="alert"
        >
          {problem}
        </p>
      ) : null}

      {personal || agentId ? null : isolation === "shared" ? (
        // The server's own word on whether this is a shared install (one person's isn't).
        <SharedComputersNotice className="mt-4" />
      ) : isolation === "per-person" ? (
        <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
          Each person has their own computer, and every Bot they use runs on it,
          public Bots made by other people included. Each Bot keeps its own
          browser profile and folder there, but a command one Bot runs can reach
          anything else on that person's computer. An isolated Bot has a
          computer of its own.
        </p>
      ) : null}

      {/*
        On one Bot's page, folders only where they exist: inside OpenBot Desktop. On a hosted OpenBot never: only the
        OpenBot that OpenBot Desktop runs on the person's own computer can be given a folder there, so a hosted one
        never can, and "Needs OpenBot Desktop" would send them to something that can't help.
      */}
      {(agentId || hosted) && hostAccess.data?.desktop === false ? null : (
        <HostFoldersSection
          connected={hostAccess.data?.connected ?? false}
          desktop={hostAccess.data?.desktop !== false}
          grants={hostAccess.data?.grants ?? []}
          botIds={
            agentId ? [agentId] : (agents.data ?? []).map((agent) => agent.id)
          }
          loading={hostAccess.isPending || agents.isPending}
          nameFor={nameFor}
          onGrant={(botId) => requestGrant.mutate({ botId })}
          onRevoke={(grantId) => revokeGrant.mutate({ grantId })}
          onStop={() => stopHostAccess.mutate()}
          pending={hostAccess.data?.pending ?? []}
          personal={personal}
          problem={hostProblem}
          requestingBotId={
            requestGrant.isPending
              ? (requestGrant.variables?.botId ?? null)
              : null
          }
          revokingGrantId={
            revokeGrant.isPending
              ? (revokeGrant.variables?.grantId ?? null)
              : null
          }
          stopping={stopHostAccess.isPending}
        />
      )}

      {agentId && !admin ? null : (
        <PageSection
          title={
            agentId
              ? personal
                ? "Its browser"
                : "Its computer"
              : personal
                ? "Your Bots' browsers"
                : "Computers in this organization"
          }
        >
          {setState.error ? (
            <p
              className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
              role="alert"
            >
              {setState.error.message}
            </p>
          ) : null}
          {noComputers ? (
            <PageEmpty
              icon={IconDeviceDesktopOff}
              title="No computers for Bots"
            >
              Bots can't browse or run commands on this OpenBot. Set up
              computers for Bots, and they show up here.
            </PageEmpty>
          ) : computers === null && problem ? (
            <PageEmpty
              icon={IconAlertTriangle}
              title="Couldn't load the list"
            />
          ) : computers === null ? null : computers.length === 0 ? (
            <PageEmpty
              icon={IconDeviceDesktop}
              title={personal ? "No browsers yet" : "No computers yet"}
            >
              {personal
                ? "One starts the first time a Bot opens a page."
                : "One shows up the first time a Bot opens a page."}
            </PageEmpty>
          ) : (
            <PageRows>
              {computers.map((computer, index) => (
                <StaggerItem index={index} key={rowId(computer)}>
                  <Item size="sm">
                    {/*
                     * Up to three buttons sit beside the words. Held to a width a name can be read in,
                     * so on a narrow window the buttons wrap under the words on every row alike,
                     * instead of squeezing the name to one word a line.
                     */}
                    <ItemContent className="min-w-56">
                      <ItemTitle title={computer.computer}>
                        {titleOf(computer)}
                      </ItemTitle>
                      <ItemDescription>
                        {personal ? null : `${scopeOf(computer)} · `}
                        {stateOf(computer)}
                        {personal
                          ? null
                          : ` · ${
                              computer.egress === undefined
                                ? "Egress not reported"
                                : computer.egress === null
                                  ? "Leaves directly"
                                  : `Leaves through ${computer.egress}`
                            }`}
                        {computer.updateAvailable ? " · Update available" : ""}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {restorable(computer) ? (
                        <Button
                          onClick={() => restoreOther.ask(computer)}
                          size="sm"
                          variant="outline"
                        >
                          Restore…
                        </Button>
                      ) : null}
                      {computer.updateAvailable ? (
                        <Button
                          disabled={busy === rowId(computer)}
                          onClick={() => update.ask(computer)}
                          size="sm"
                          variant="outline"
                        >
                          Update computer
                        </Button>
                      ) : null}
                      <Button
                        disabled={busy === rowId(computer) || !computer.running}
                        onClick={() => void run(computer, "stop")}
                        size="sm"
                        variant="outline"
                      >
                        {busy === rowId(computer) ? "Working…" : "Stop browser"}
                      </Button>
                      {personal && isOwnBrowser(computer) ? (
                        <Button
                          disabled={
                            busy === rowId(computer) ||
                            clearOwnBrowser.isPending
                          }
                          onClick={clearing.ask}
                          size="sm"
                          variant="outline"
                        >
                          Clear browser data
                        </Button>
                      ) : (
                        <Button
                          disabled={busy === rowId(computer)}
                          onClick={() => reset.ask(computer)}
                          size="sm"
                          variant="outline"
                        >
                          Reset
                        </Button>
                      )}
                    </ItemActions>
                  </Item>
                  {index !== computers.length - 1 && <Separator />}
                </StaggerItem>
              ))}
            </PageRows>
          )}
        </PageSection>
      )}

      {agentId && restoreOther.about ? (
        <RestoreComputerDialog
          botId={agentId}
          computer={restoreOther.about.computer}
          name={ownerOf(restoreOther.about)}
          onOpenChange={(open) => {
            if (!open) restoreOther.close();
          }}
          open={restoreOther.open}
        />
      ) : null}

      {/*
       * A DIALOG RATHER THAN AN INLINE CONFIRM. Resetting signs a Bot out of everything it has ever
       * logged into and cannot be undone, and the row it was confirmed on was one of several
       * identical-looking rows. The dialog names whose computer it is, so the sentence somebody
       * agrees to says which computer it destroys.
       */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) reset.close();
        }}
        open={reset.open}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {personal
                ? confirming?.botId
                  ? `Reset ${nameFor(confirming.botId)}'s browser?`
                  : "Reset the computer?"
                : `Reset ${confirming ? titleOf(confirming) : ""}?`}
            </DialogTitle>
            <DialogDescription>
              {confirming?.kind === "person" && !confirming.botId
                ? "Every Bot's profile on this person's computer is deleted. Each is signed out of every service and starts clean."
                : confirming && isOwnBrowser(confirming)
                  ? "Its profile is deleted. The person is signed out of every site they signed in to in it."
                  : "Its profile is deleted. The Bot is signed out of every service and starts clean."}{" "}
              You can't undo this.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={reset.close} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={
                reset.open && confirming !== null && busy === rowId(confirming)
              }
              onClick={() => {
                if (confirming) void run(confirming, "reset");
              }}
              size="sm"
              variant="destructive"
            >
              {reset.open && confirming !== null && busy === rowId(confirming)
                ? "Resetting…"
                : "Reset it"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ClearBrowserDialog
        clear={clearOwnBrowser}
        onOpenChange={clearing.setAsking}
        open={clearing.asking}
      />

      <Dialog
        onOpenChange={(open) => {
          if (!open) update.close();
        }}
        open={update.open}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Update {confirmingUpdate ? titleOf(confirmingUpdate) : ""}?
            </DialogTitle>
            <DialogDescription>
              It moves to the computer image {paths.deploymentName} now runs.
              Its files and sign-ins are kept. If it's running, it restarts and
              stops what it's doing.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={update.close} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={
                update.open &&
                confirmingUpdate !== null &&
                busy === rowId(confirmingUpdate)
              }
              onClick={() => {
                if (confirmingUpdate) void run(confirmingUpdate, "update");
              }}
              size="sm"
            >
              {update.open &&
              confirmingUpdate !== null &&
              busy === rowId(confirmingUpdate)
                ? "Updating…"
                : "Update it"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* What Stop, Reset and Update do, which is about computers: not said where there are none. */}
      {(agentId && !admin) || noComputers ? null : personal ? (
        <p className="mt-4 text-muted-foreground text-sm">
          <strong>Stop browser</strong> closes a browser and keeps its sign-ins.
          It starts again the next time it's needed. <strong>Reset</strong>{" "}
          deletes a Bot's browser profile and signs it out of everything.{" "}
          {computers?.some(isOwnBrowser) ? (
            <>
              <strong>Clear browser data</strong> does the same for your OpenBot
              browser.{" "}
            </>
          ) : null}
          Each shows in{" "}
          <Link className="underline" {...paths.audit()}>
            {paths.auditLabel}
          </Link>
          .
        </p>
      ) : (
        <p className="mt-4 text-muted-foreground text-sm">
          <strong>Stop</strong> closes the computer's browsers and keeps their
          logins. It starts again the next time a Bot needs it.{" "}
          <strong>Reset</strong> deletes the profiles and signs every Bot on it
          out of everything. <strong>Update computer</strong> shows when a
          computer runs an older image. It moves the computer to the new one and
          keeps its files and sign-ins. All three show in{" "}
          <Link className="underline" {...paths.audit()}>
            {paths.auditLabel}
          </Link>
          .
        </p>
      )}
      {/* Below the words about the list's buttons, which are about the list above them. */}
      {agentId ? (
        <WorkspaceSnapshotsSection
          botId={agentId}
          enabled={noComputers === false}
        />
      ) : null}
      {children}
    </>
  );
  if (agentId || embedded) return body;
  return (
    <PageShell
      description={
        personal
          ? "Your Bots share one computer. Each Bot keeps its own browser profile there, which keeps it signed in. A command one Bot runs can still read another Bot's files."
          : "Each person's computer, and each isolated Bot's. Every Bot keeps its own browser profile on it, which keeps that Bot signed in. Resetting a computer signs every Bot on it out of everything."
      }
      title={personal ? "Computer" : "Computers"}
    >
      {body}
    </PageShell>
  );
}

type HostFoldersSectionProps = {
  botIds: string[];
  connected: boolean;
  /** This OpenBot runs in OpenBot Desktop. Without it no folder can ever be chosen here. */
  desktop: boolean;
  grants: HostFolderGrant[];
  loading: boolean;
  nameFor: (botId: string) => string;
  onGrant: (botId: string) => void;
  onRevoke: (grantId: string) => void;
  onStop: () => void;
  pending: HostAccessPendingOperation[];
  /**
   * The personal edition, where the person reading is the one OpenBot Desktop asks. In the team
   * edition the desktop's owner may be somebody else, so a waiting request names them instead.
   */
  personal: boolean;
  problem: string | null;
  requestingBotId: string | null;
  revokingGrantId: string | null;
  stopping: boolean;
};

function HostFoldersSection({
  botIds: knownBotIds,
  connected,
  desktop,
  grants,
  loading,
  nameFor,
  onGrant,
  onRevoke,
  onStop,
  pending,
  personal,
  problem,
  requestingBotId,
  revokingGrantId,
  stopping,
}: HostFoldersSectionProps) {
  const paths = useManagePaths();
  const botIds = Array.from(
    new Set([
      ...knownBotIds,
      ...grants.map((grant) => grant.botId),
      // Stop folder access is addressed to every Bot ("*"), not one: it is no Bot's row.
      ...pending.map((one) => one.botId).filter((botId) => botId !== ALL_BOTS),
    ]),
  ).sort((left, right) => nameFor(left).localeCompare(nameFor(right)));

  return (
    <PageSection
      description="Choose folders a Bot can read on this computer. The desktop app asks before each edit or command. Access ends when you stop OpenBot."
      title="Folders on this computer"
    >
      {problem ? (
        <p
          className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          role="alert"
        >
          {problem}
        </p>
      ) : null}

      {desktop && !connected && !loading ? (
        <p className="mb-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          The desktop app is offline. Open it to approve folders or run
          commands.
        </p>
      ) : null}

      {loading ? null : !desktop ? (
        <PageEmpty icon={IconDeviceDesktop} title="Needs OpenBot Desktop">
          This OpenBot isn't running in the desktop app. Use OpenBot Desktop to
          let Bots read folders on this computer.
        </PageEmpty>
      ) : botIds.length === 0 ? (
        <PageEmpty icon={IconBolt} title="No Bots yet">
          Create one, then choose its folders.
        </PageEmpty>
      ) : (
        <PageRows>
          {botIds.map((botId, index) => (
            <StaggerItem index={index} key={botId}>
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>{nameFor(botId)}</ItemTitle>
                  <ItemDescription>
                    {summaryFor(botId, grants, pending)}
                  </ItemDescription>
                  <FolderGrantList
                    botId={botId}
                    grants={grants}
                    onRevoke={onRevoke}
                    pending={pending}
                    personal={personal}
                    revokingGrantId={revokingGrantId}
                  />
                </ItemContent>
                <ItemActions>
                  <Button
                    disabled={!connected || requestingBotId === botId}
                    onClick={() => onGrant(botId)}
                    size="sm"
                    variant="outline"
                  >
                    {requestingBotId === botId ? "Waiting…" : "Choose folder"}
                  </Button>
                </ItemActions>
              </Item>
              {index !== botIds.length - 1 && <Separator />}
            </StaggerItem>
          ))}
        </PageRows>
      )}

      {desktop ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-muted-foreground text-sm">
          <p>
            Folders are read-only. When a Bot needs to write, the desktop app
            asks you first.
          </p>
          <div className="flex items-center gap-3">
            <Button
              disabled={!connected || stopping}
              onClick={onStop}
              size="sm"
              variant="outline"
            >
              {stopping ? "Stopping…" : "Stop folder access"}
            </Button>
            <Link className="underline" {...paths.audit()}>
              Open {paths.auditLabel}
            </Link>
          </div>
        </div>
      ) : null}
    </PageSection>
  );
}

function FolderGrantList({
  botId,
  grants,
  onRevoke,
  pending,
  personal,
  revokingGrantId,
}: {
  botId: string;
  grants: HostFolderGrant[];
  onRevoke: (grantId: string) => void;
  pending: HostAccessPendingOperation[];
  personal: boolean;
  revokingGrantId: string | null;
}) {
  const botGrants = grants.filter(
    (grant) => grant.botId === botId && !grant.revoked,
  );
  const botPending = pending.filter((request) => request.botId === botId);

  if (botGrants.length === 0 && botPending.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-2">
      {botGrants.map((grant) => (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2"
          key={grant.id}
        >
          <div className="min-w-0">
            <p className="truncate font-medium text-sm">{grant.displayName}</p>
            <p className="text-muted-foreground text-xs">
              {personal
                ? "Read-only"
                : `Approved by ${ownerLabel(grant)} · Read-only`}
            </p>
          </div>
          <Button
            disabled={revokingGrantId === grant.id}
            onClick={() => onRevoke(grant.id)}
            size="sm"
            variant="ghost"
          >
            {revokingGrantId === grant.id ? "Revoking…" : "Revoke"}
          </Button>
        </div>
      ))}
      {botPending.map((request) => (
        <div
          className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
          key={request.operationId}
        >
          {pendingSentence(request, personal)}
        </div>
      ))}
    </div>
  );
}

function summaryFor(
  botId: string,
  grants: HostFolderGrant[],
  pending: HostAccessPendingOperation[],
) {
  const active = grants.filter(
    (grant) => grant.botId === botId && !grant.revoked,
  ).length;
  const waiting = pending.filter((request) => request.botId === botId).length;
  const parts = [];
  if (active > 0)
    parts.push(`${active} read-only ${active === 1 ? "folder" : "folders"}`);
  if (waiting > 0)
    parts.push(`${waiting} pending ${waiting === 1 ? "request" : "requests"}`);
  return parts.length > 0 ? parts.join(" · ") : "No folders approved.";
}

/** The Bot id Stop folder access is addressed to: every Bot at once. */
const ALL_BOTS = "*";

function ownerLabel(grant: { ownerName?: string; ownerEmail?: string }) {
  return grant.ownerName ?? grant.ownerEmail ?? "the desktop owner";
}

/**
 * What a folder request still open is waiting on, as a sentence.
 *
 * Reading and listing need nobody's answer, so they say only what is happening. A folder, a file
 * change or a command waits for the person at the computer: in the personal edition that is the
 * person reading, so it says OpenBot Desktop is asking them, in a window. It used to say "waiting for
 * approval from the desktop owner" to the desktop's owner, and "Listing files from the desktop owner".
 */
function pendingSentence(
  request: HostAccessPendingOperation,
  personal: boolean,
): string {
  switch (request.kind) {
    case "list_files":
      return "Listing files.";
    case "read_file":
      return "Reading a file.";
    case "cancel":
    case "stop":
      return "Stopping folder work.";
  }
  if (personal) {
    switch (request.kind) {
      case "write_file":
        return "A file change is waiting for you. OpenBot Desktop is asking you in a window.";
      case "run_command":
        return "A command is waiting for you or still running. OpenBot Desktop asks you in a window.";
      default:
        return "Folder access is waiting for you. OpenBot Desktop is asking you in a window.";
    }
  }
  const owner = ownerLabel(request);
  switch (request.kind) {
    case "write_file":
      return `File change waiting for approval from ${owner}, or to finish.`;
    case "run_command":
      return `Command waiting for approval from ${owner}, or to finish.`;
    default:
      return `Folder access waiting for approval from ${owner}.`;
  }
}
