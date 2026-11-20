import {
  IconCircleCheck,
  IconClock,
  IconCloudCog,
  IconFingerprint,
  IconHeartbeat,
  IconTag,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageCard,
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { copyText } from "@/components/settings/linked-accounts";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  cancelManagementMutationOptions,
  startManagementMutationOptions,
} from "@/lib/management/mutations";
import {
  type ManagementStatus,
  managementQueryOptions,
} from "@/lib/management/queries";
import { relativeTime } from "@/lib/relative-time";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/management")({
  component: ManagementPage,
});

const TITLE = "CopilotKit management";
const DESCRIPTION =
  "Connect OpenBot to CopilotKit so CopilotKit can keep it up to date in your own cluster.";

/**
 * Admin, CopilotKit management: connecting a self-hosted OpenBot to CopilotKit's management
 * service, in four states the server decides (lib/management/queries.ts). Not connected offers
 * Connect. Waiting for approval shows the code somebody signed in to CopilotKit confirms, and the
 * page to confirm it on. Waiting for the agent shows the one Helm command, which holds nothing
 * secret: the agent collects its one-time token from OpenBot. Connected shows the agent's last
 * heartbeat and version. The page asks again every few seconds while it waits on somebody.
 *
 * Where management doesn't apply (the personal edition, OpenBot Cloud, another organization) the
 * server answers 404 and the page says so, with nothing to press; the rail doesn't list it there.
 */
export function ManagementPage() {
  const management = useQuery(managementQueryOptions());
  const start = useMutation(startManagementMutationOptions(queryClient));
  const cancel = useMutation(cancelManagementMutationOptions(queryClient));
  const failure = start.error ?? cancel.error;

  if (management.isPending) return <PageShell title={TITLE}>{null}</PageShell>;
  if (management.error)
    return (
      <PageShell description={DESCRIPTION} title={TITLE}>
        <Notice>Couldn't load CopilotKit management. Reload the page.</Notice>
      </PageShell>
    );
  if (!management.data.applies)
    return (
      <PageShell title={TITLE}>
        <PageEmpty icon={IconCloudCog} title="Not available here">
          CopilotKit management is for OpenBot that your company runs in its own
          cluster. Ask whoever runs OpenBot about it.
        </PageEmpty>
      </PageShell>
    );

  const status = management.data.status;
  const cancelButton = (
    <Button
      disabled={cancel.isPending}
      onClick={() => cancel.mutate()}
      size="sm"
      variant="outline"
    >
      {cancel.isPending ? "Cancelling…" : "Cancel"}
    </Button>
  );

  return (
    <PageShell description={DESCRIPTION} title={TITLE}>
      {failure ? <Notice>{failure.message}</Notice> : null}
      {status.lastError && !failure ? (
        <Notice>{status.lastError}</Notice>
      ) : null}
      {status.state === "waiting-for-approval" ? (
        <WaitingForApproval cancelButton={cancelButton} status={status} />
      ) : status.state === "waiting-for-agent" ? (
        <WaitingForAgent cancelButton={cancelButton} status={status} />
      ) : status.state === "connected" ? (
        <Connected status={status} />
      ) : (
        <PageEmpty
          action={
            <Button disabled={start.isPending} onClick={() => start.mutate()}>
              {start.isPending ? "Connecting…" : "Connect"}
            </Button>
          }
          icon={IconCloudCog}
          title="Not connected"
        >
          Someone signed in to CopilotKit approves a code, then you install the
          management agent with one Helm command.
        </PageEmpty>
      )}
    </PageShell>
  );
}

/** Something went wrong, in the server's own sentence. */
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-sm"
      role="alert"
    >
      {children}
    </p>
  );
}

/** A Copy button that says whether the text landed on the clipboard. */
function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <Button
        aria-label={label}
        onClick={async () =>
          setCopied(await copyText(text, navigator.clipboard))
        }
        size="sm"
        variant="outline"
      >
        {copied ? "Copied" : "Copy"}
      </Button>
      {copied === false ? (
        <span className="text-destructive text-xs" role="alert">
          Couldn't copy. Select it and copy it yourself.
        </span>
      ) : null}
    </div>
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
      description="Sign in to CopilotKit as an admin of the organization your licence is for, and confirm this code. OpenBot carries on by itself once it's approved."
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
      description="Run this command where kubectl reaches OpenBot's cluster. It holds nothing secret. The agent collects its one-time token from OpenBot and reports in."
      title="Step 2 of 2: install the management agent"
    >
      <PageCard className="mt-4" footer={cancelButton}>
        <div className="flex items-start gap-3">
          <pre
            className="min-w-0 flex-1 whitespace-pre-wrap break-words rounded bg-muted px-3 py-2 font-mono text-xs leading-relaxed"
            data-management-helm=""
          >
            {status.helmCommand}
          </pre>
          {status.helmCommand ? (
            <CopyButton label="Copy the command" text={status.helmCommand} />
          ) : null}
        </div>
        {status.installId ? (
          <p className="mt-3 text-muted-foreground text-sm">
            Install ID <span className="font-mono">{status.installId}</span>
          </p>
        ) : null}
      </PageCard>
    </PageSection>
  );
}

function Connected({ status }: { status: ManagementStatus }) {
  const rows: {
    title: string;
    value: string;
    icon: React.ComponentType;
    mono?: boolean;
  }[] = [
    { title: "Status", value: "Connected", icon: IconCircleCheck },
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
      <PageSection
        description="Uninstall the management agent with Helm. OpenBot keeps running as it is, and you upgrade it yourself from then on."
        title="Disconnect"
      >
        <PageCard className="mt-4">
          <div className="flex items-start gap-3">
            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words rounded bg-muted px-3 py-2 font-mono text-xs leading-relaxed">
              {UNINSTALL}
            </pre>
            <CopyButton label="Copy the uninstall command" text={UNINSTALL} />
          </div>
        </PageCard>
      </PageSection>
    </>
  );
}

const UNINSTALL = "helm uninstall openbot-agent --namespace openbot-system";
