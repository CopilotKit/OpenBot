import {
  IconAlertTriangle,
  IconCalendarTime,
  IconCircleCheck,
  IconClock,
  IconCloudCog,
  IconCloudOff,
  IconFingerprint,
  IconHeartbeat,
  IconInfoCircle,
  IconLock,
  IconTag,
  IconTool,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import {
  PageCard,
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
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
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { loadFailure } from "@/lib/load-failure";
import {
  helmLines,
  MANAGEMENT_SENTENCE,
  UPGRADES_SETUP_URL,
  windowText,
} from "@/lib/management/format";
import {
  cancelManagementMutationOptions,
  startManagementMutationOptions,
} from "@/lib/management/mutations";
import {
  asksForManagement,
  type ManagementStatus,
  managementQueryOptions,
} from "@/lib/management/queries";
import { relativeTime } from "@/lib/relative-time";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/management")({
  component: ManagementPage,
});

const TITLE = "Managed updates";
const DESCRIPTION = MANAGEMENT_SENTENCE;

/** What CopilotKit gets, said before Connect: the same words as the approval page. */
const CONSENT =
  "CopilotKit sees this install's version and health, and upgrades it during a maintenance window.";
/** Who sets the window and its default (the service's DEFAULT_WINDOW, set per install by its operators). */
const WINDOW_AGREED =
  "The window is agreed with CopilotKit; the default is Tuesdays, 14:00 to 18:00 UTC.";
/** Where to ask for managed updates: CopilotKit's own contact page, linked from copilotkit.ai. */
const CONTACT_URL = "https://www.copilotkit.ai/contact-us";
const NOT_ENTITLED = "Your licence doesn't include managed updates.";
const APPROVE_STEP =
  "Open the approval page and sign in to CopilotKit as an admin of the organization your licence belongs to. Check the code matches, then approve it. This page moves on by itself.";
const INSTALL_STEP =
  "Run this command where kubectl reaches OpenBot's cluster. It holds nothing secret. This page updates itself when the agent reports in.";
/** Where OpenBot's chart installs the agent and the last try failed: it tries again by itself. */
const TRIES_AGAIN = "OpenBot tries again every hour. Connect to try now.";
const CONNECTING =
  "OpenBot is connecting with its licence. This page updates itself.";
const TURNED_OFF =
  "Managed updates are off, so OpenBot doesn't connect by itself. Connect to turn them back on.";
const UPGRADES_NOT_SET_UP = "Needs a one-time setup in the cluster.";

const APPROVE_FLOW =
  "To connect, you approve a code with the CopilotKit account your licence is under, then install the management agent with one Helm command.";

type Confirming = "disconnect" | "stop-approved" | "stop-connecting";

/**
 * Admin, Managed updates: connecting a self-hosted OpenBot to CopilotKit's management service, in
 * four states the server decides (lib/management/queries.ts). Product copy never names CopilotKit
 * alone (openbot-copy), so the screen says managed updates and OpenBot by CopilotKit. Not connected
 * offers Connect. Waiting for approval shows the code and the page to confirm it on, where an admin
 * signs in with the account the licence is under (not their OpenBot sign-in). Waiting for the agent
 * shows the one Helm command, which holds nothing secret: the agent collects its one-time token from
 * OpenBot. Connected shows the agent's last heartbeat and version, says Not reporting when the server
 * says the agent has gone quiet, and offers Disconnect for after the agent is uninstalled. The page
 * asks again every few seconds while it waits on somebody, and every half minute while connected.
 *
 * Where management doesn't apply (the personal edition, OpenBot Cloud, another organization) the
 * server answers 404 and the page says so, with nothing to press; the rail doesn't list it there.
 */
export function ManagementPage() {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const asks = asksForManagement(capabilities);
  const management = useQuery({ ...managementQueryOptions(), enabled: asks });
  const start = useMutation(startManagementMutationOptions(queryClient));
  const cancel = useMutation(cancelManagementMutationOptions(queryClient));
  const failure = start.error ?? cancel.error;
  // Disconnect, and Stop once the code is approved or while connecting by itself, all ask first.
  const [confirming, setConfirming] = useState<Confirming | null>(null);

  // The personal edition has nothing to manage: said without asking the server.
  const personal = !capabilities.isPending && !asks;
  if (!personal && management.isPending)
    return <PageShell title={TITLE}>{null}</PageShell>;
  if (!personal && management.error)
    return (
      <PageShell description={DESCRIPTION} title={TITLE}>
        <Notice>
          {loadFailure(
            management.error,
            "Couldn't load managed updates. Try again in a moment.",
          )}
        </Notice>
      </PageShell>
    );
  if (personal || !management.data?.applies)
    return (
      <PageShell title={TITLE}>
        <PageEmpty icon={IconCloudCog} title="Not available here">
          Managed updates are for OpenBot that your company runs in its own
          cluster. Ask whoever runs OpenBot about them.
        </PageEmpty>
      </PageShell>
    );

  const status = management.data.status;
  const byChart = status.agentInstalledByChart === true;
  const connectButton = (
    <Button disabled={start.isPending} onClick={() => start.mutate()}>
      {start.isPending ? "Connecting…" : "Connect"}
    </Button>
  );
  const notEntitled =
    status.state === "not-connected" && status.lastErrorCode === "not-entitled";
  const cancelButton = (
    <Button
      disabled={cancel.isPending}
      onClick={() =>
        status.state === "waiting-for-agent"
          ? setConfirming("stop-approved")
          : cancel.mutate()
      }
      size="sm"
      variant="outline"
    >
      {cancel.isPending ? "Cancelling…" : "Cancel"}
    </Button>
  );
  // The not-entitled refusal is the state itself below, so it isn't said twice.
  const notice = notEntitled ? null : (failure?.message ?? status.lastError);

  return (
    <PageShell description={DESCRIPTION} title={TITLE}>
      {notice ? <Notice>{notice}</Notice> : null}
      {status.state === "connecting" ? (
        <PageEmpty
          action={
            <Button
              disabled={cancel.isPending}
              onClick={() => setConfirming("stop-connecting")}
              size="sm"
              variant="outline"
            >
              {cancel.isPending ? "Stopping…" : "Stop"}
            </Button>
          }
          icon={IconCloudCog}
          title="Connecting"
        >
          {CONSENT} {WINDOW_AGREED} {CONNECTING}
        </PageEmpty>
      ) : status.state === "opted-out" ? (
        <PageEmpty
          action={connectButton}
          icon={IconCloudOff}
          title="Turned off"
        >
          {TURNED_OFF} {CONSENT} {WINDOW_AGREED}
        </PageEmpty>
      ) : status.state === "waiting-for-approval" ? (
        <WaitingForApproval cancelButton={cancelButton} status={status} />
      ) : status.state === "waiting-for-agent" ? (
        <WaitingForAgent cancelButton={cancelButton} status={status} />
      ) : status.state === "connected" ? (
        <Connected
          disconnectButton={
            <Button
              disabled={cancel.isPending}
              onClick={() => setConfirming("disconnect")}
              size="sm"
              variant="outline"
            >
              {cancel.isPending ? "Disconnecting…" : "Disconnect"}
            </Button>
          }
          byChart={byChart}
          status={status}
        />
      ) : notEntitled ? (
        // No Connect: it would fail the same way until the licence includes managed updates.
        <PageEmpty icon={IconLock} title="Not in your licence">
          {NOT_ENTITLED} To add them, get in touch at{" "}
          <a
            className="underline underline-offset-2"
            href={CONTACT_URL}
            rel="noreferrer"
            target="_blank"
          >
            copilotkit.ai/contact-us
          </a>
          .
        </PageEmpty>
      ) : (
        <PageEmpty
          action={connectButton}
          icon={IconCloudCog}
          title="Not connected"
        >
          {CONSENT} {WINDOW_AGREED} {byChart ? TRIES_AGAIN : APPROVE_FLOW}
        </PageEmpty>
      )}
      <ConfirmDialog
        byChart={byChart}
        confirming={confirming}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          setConfirming(null);
          cancel.mutate();
        }}
      />
    </PageShell>
  );
}

/**
 * Disconnect, Stop once the code is approved, or Stop while OpenBot connects by itself. With the
 * agent OpenBot's chart installs, Connect turns managed updates back on with no code to approve.
 */
function ConfirmDialog({
  byChart,
  confirming,
  onClose,
  onConfirm,
}: {
  byChart: boolean;
  confirming: Confirming | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const disconnect = confirming === "disconnect";
  const again = byChart
    ? "Connect turns them back on."
    : "Connecting again needs a new code and a new approval.";
  const description = disconnect
    ? `OpenBot stops getting managed updates, and you upgrade it yourself. ${again}`
    : confirming === "stop-connecting"
      ? "OpenBot stops connecting and doesn't try again by itself. Connect turns managed updates back on."
      : "The code is already approved. Stopping forgets it, and connecting again needs a new code and a new approval.";
  return (
    <Dialog
      onOpenChange={(open) => (open ? undefined : onClose())}
      open={confirming !== null}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {disconnect ? "Disconnect managed updates?" : "Stop connecting?"}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4">
          <DialogDescription>{description}</DialogDescription>
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            {disconnect ? "Keep managed updates" : "Keep connecting"}
          </Button>
          <Button
            onClick={onConfirm}
            size="sm"
            type="button"
            variant="destructive"
          >
            {disconnect ? "Disconnect" : "Stop connecting"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Something went wrong, in the server's own sentence. */
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-destructive text-sm" role="alert">
      {children}
    </p>
  );
}

function WaitingForApproval({
  status,
  cancelButton,
}: {
  status: ManagementStatus;
  cancelButton: React.ReactNode;
}) {
  const page = status.verificationUriComplete ?? status.verificationUri;
  return (
    <PageSection
      description={APPROVE_STEP}
      title="Step 1 of 2: approve the code"
    >
      <PageCard
        className="mt-4"
        footer={
          <>
            {cancelButton}
            {page ? (
              <Button
                render={<a href={page} rel="noreferrer" target="_blank" />}
                size="sm"
              >
                Open the approval page
              </Button>
            ) : null}
          </>
        }
      >
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1">
            <span className="text-muted-foreground text-xs">Your code</span>
            <code
              className="font-mono font-semibold text-3xl tracking-widest"
              data-management-code=""
            >
              {status.userCode}
            </code>
          </div>
          {status.userCode ? (
            <CopyButton label="Copy the code" text={status.userCode} />
          ) : null}
        </div>
        {status.installName ? (
          <p className="mt-3 text-muted-foreground text-sm">
            Install name{" "}
            <span className="font-medium text-foreground">
              {status.installName}
            </span>
          </p>
        ) : null}
        {status.expiresAt ? (
          <p className="mt-3 flex items-center gap-1.5 text-muted-foreground text-sm">
            <IconClock className="size-4" />
            The code expires {relativeTime(status.expiresAt)}.
          </p>
        ) : null}
      </PageCard>
    </PageSection>
  );
}

function WaitingForAgent({
  status,
  cancelButton,
}: {
  status: ManagementStatus;
  cancelButton: React.ReactNode;
}) {
  return (
    <PageSection
      description={INSTALL_STEP}
      title="Step 2 of 2: install the management agent"
    >
      <PageCard className="mt-4" footer={cancelButton}>
        <div className="flex items-start gap-3">
          <pre
            className="min-w-0 flex-1 whitespace-pre-wrap break-words rounded bg-muted px-3 py-2 font-mono text-xs leading-relaxed"
            data-management-helm=""
          >
            {status.helmCommand ? helmLines(status.helmCommand) : null}
          </pre>
          {status.helmCommand ? (
            <CopyButton
              label="Copy the command"
              text={helmLines(status.helmCommand)}
            />
          ) : null}
        </div>
        {/* On a build that isn't a release, the server's sentence about which agent this installs. */}
        {status.helmCommandNote ? (
          <p className="mt-3 flex items-start gap-1.5 text-muted-foreground text-sm">
            <IconInfoCircle className="mt-0.5 size-4 shrink-0" />
            {status.helmCommandNote}
          </p>
        ) : null}
        {status.installId ? (
          <p className="mt-3 text-muted-foreground text-sm">
            Install ID <span className="font-mono">{status.installId}</span>
          </p>
        ) : null}
      </PageCard>
    </PageSection>
  );
}

function Connected({
  byChart,
  status,
  disconnectButton,
}: {
  byChart: boolean;
  status: ManagementStatus;
  disconnectButton: React.ReactNode;
}) {
  // In this state the server sets lastError only when the agent has stopped reporting in; the
  // notice at the top of the page carries its sentence.
  const reporting = !status.lastError;
  const rows: {
    title: string;
    value: string;
    icon: React.ComponentType;
    mono?: boolean;
    description?: React.ReactNode;
  }[] = [
    {
      title: "Status",
      value: reporting ? "Connected" : "Not reporting",
      icon: reporting ? IconCircleCheck : IconAlertTriangle,
    },
    {
      title: "Last heartbeat",
      value: status.lastHeartbeatAt
        ? relativeTime(status.lastHeartbeatAt)
        : "Not yet",
      icon: IconHeartbeat,
    },
    {
      title: "Agent version",
      value: status.agentVersion ?? "Not reported",
      icon: IconTag,
    },
    ...(status.upgrades === "on" || status.upgrades === "not-set-up"
      ? [
          {
            title: "Upgrades",
            value: status.upgrades === "on" ? "On" : "Not set up",
            icon: IconTool,
            description:
              status.upgrades === "not-set-up" ? (
                <>
                  {UPGRADES_NOT_SET_UP}{" "}
                  <a
                    className="underline underline-offset-2"
                    href={UPGRADES_SETUP_URL}
                    rel="noreferrer"
                    target="_blank"
                  >
                    How to set up upgrades
                  </a>
                </>
              ) : undefined,
          },
        ]
      : []),
    {
      title: "Maintenance window",
      value: status.window ? windowText(status.window) : "Not reported yet",
      icon: IconCalendarTime,
    },
    {
      title: "Install ID",
      value: status.installId ?? "",
      icon: IconFingerprint,
      mono: true,
    },
  ];
  return (
    <>
      <PageRows>
        {rows.map((row, index) => (
          <div key={row.title}>
            <Item size="sm">
              <ItemMedia variant="icon">
                <row.icon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{row.title}</ItemTitle>
                {row.description ? (
                  <ItemDescription>{row.description}</ItemDescription>
                ) : null}
              </ItemContent>
              <ItemActions>
                <span
                  className={
                    row.mono
                      ? "font-mono text-muted-foreground text-xs"
                      : "text-muted-foreground text-sm"
                  }
                >
                  {row.value}
                </span>
              </ItemActions>
            </Item>
            {index !== rows.length - 1 && <Separator />}
          </div>
        ))}
      </PageRows>
      {byChart ? (
        // The chart's agent: nothing to uninstall. Disconnect stops managed updates on its own.
        <PageSection
          action={disconnectButton}
          description="Managed updates stop, and you upgrade OpenBot yourself. Connect turns them back on."
          title="Turn off managed updates"
        />
      ) : status.agentRemovedWithChart === true ? (
        // The chart's agent, removed with OpenBot's release when management was turned off with
        // Helm: there is no openbot-agent release, so no uninstall command. Disconnect finishes.
        <PageSection
          action={disconnectButton}
          description={REMOVED_WITH_CHART}
          title="Disconnect"
        />
      ) : (
        <PageSection
          description="Uninstall the management agent with Helm, then choose Disconnect. OpenBot keeps running as it is, and you upgrade it yourself from then on."
          title="Disconnect"
        >
          <PageCard className="mt-4" footer={disconnectButton}>
            <div className="flex items-start gap-3">
              <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words rounded bg-muted px-3 py-2 font-mono text-xs leading-relaxed">
                {UNINSTALL}
              </pre>
              <CopyButton label="Copy the uninstall command" text={UNINSTALL} />
            </div>
          </PageCard>
        </PageSection>
      )}
    </>
  );
}

/** For an agent installed as its own Helm release (the Helm command, or the release that runs upgrades). */
const UNINSTALL = "helm uninstall openbot-agent --namespace openbot-system";
const REMOVED_WITH_CHART =
  "Turning management off with Helm removed the management agent along with OpenBot's own release, so there is nothing to uninstall. Choose Disconnect to finish. OpenBot keeps running as it is, and you upgrade it yourself from then on.";
