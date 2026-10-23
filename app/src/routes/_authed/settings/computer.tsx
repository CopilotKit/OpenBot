import {
  IconBox,
  IconBrandDocker,
  IconCpu,
  IconFolder,
  IconInfoCircle,
  IconSparkles,
  IconTerminal2,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { desktopShell } from "@/lib/desktop/intelligence-dashboard";
import {
  intelligenceMutationOptions,
  restartOpenBotMutationOptions,
  stopOpenBotMutationOptions,
} from "@/lib/desktop/mutations";
import {
  type DesktopPart,
  type DesktopStatus,
  desktopStatusQueryOptions,
  diagnostics,
  formatBytes,
  type IntelligenceReadiness,
  intelligenceReadinessQueryOptions,
  totalMemory,
} from "@/lib/desktop/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/settings/computer")({
  component: ComputerPage,
});

const READINESS: Record<IntelligenceReadiness, string> = {
  ready: "Ready",
  starting: "Starting",
  stopped: "Stopped",
  degraded: "Not fully working",
  unknown: "Running",
};

/**
 * What OpenBot runs on this computer, what each part costs in memory, and Restart and Stop for each.
 *
 * Only inside OpenBot Desktop: the desktop app is what can see and control the containers, Docker and
 * the local Intelligence stack. In a browser there is nothing here to read.
 */
function ComputerPage() {
  const inDesktop = desktopShell() !== null;
  return (
    <PageShell
      description="What OpenBot runs on this computer and how much memory it uses. Restart a part when it gets stuck."
      title="This computer"
    >
      {inDesktop ? (
        <ComputerSections />
      ) : (
        <PageSection>
          <PageEmpty>This page is only in the OpenBot desktop app.</PageEmpty>
        </PageSection>
      )}
    </PageShell>
  );
}

function ComputerSections() {
  const status = useQuery(desktopStatusQueryOptions());
  const readiness = useQuery({
    ...intelligenceReadinessQueryOptions(),
    enabled: Boolean(status.data?.intelligenceStack),
  });

  if (status.isPending) return null;
  if (status.error)
    return (
      <p className="text-destructive text-sm" role="alert">
        Could not read what OpenBot runs on this computer.
      </p>
    );
  return (
    <>
      <OpenBotSection status={status.data} />
      {status.data.intelligenceStack && (
        <IntelligenceSection readiness={readiness.data} status={status.data} />
      )}
      <MachineSection readiness={readiness.data} status={status.data} />
    </>
  );
}

function OpenBotSection({ status }: { status: DesktopStatus }) {
  const restart = useMutation(restartOpenBotMutationOptions(queryClient));
  const stop = useMutation(stopOpenBotMutationOptions());
  const memory = totalMemory([...status.processes, ...status.containers]);
  const busy = restart.isPending || stop.isPending;
  return (
    <PageSection title="OpenBot">
      <PageRows>
        <Item size="sm">
          <RowMark>
            <IconCpu className="size-4" />
          </RowMark>
          <ItemContent>
            <ItemTitle>
              {status.openbotRunning ? "Running" : "Stopped"}
            </ItemTitle>
            <ItemDescription>
              {restart.isPending
                ? "Restarting…"
                : stop.isPending
                  ? "Stopping…"
                  : memory !== null
                    ? `${formatBytes(memory)} in use`
                    : "Memory could not be measured."}
            </ItemDescription>
          </ItemContent>
          {status.openbotRunning && (
            <ItemActions>
              <Button
                disabled={busy}
                onClick={() => restart.mutate()}
                size="sm"
                variant="outline"
              >
                Restart
              </Button>
              <Button
                disabled={busy}
                onClick={() => stop.mutate()}
                size="sm"
                variant="outline"
              >
                Stop
              </Button>
            </ItemActions>
          )}
        </Item>
        <PartRows
          icon={IconTerminal2}
          parts={status.processes}
          separatorFirst
        />
        <PartRows icon={IconBox} parts={status.containers} separatorFirst />
      </PageRows>
    </PageSection>
  );
}

function IntelligenceSection({
  readiness,
  status,
}: {
  readiness: IntelligenceReadiness | undefined;
  status: DesktopStatus;
}) {
  const intelligence = useMutation(intelligenceMutationOptions(queryClient));
  const running =
    status.intelligenceContainers.length > 0 && readiness !== "stopped";
  const memory = totalMemory(status.intelligenceContainers);
  return (
    <PageSection
      description="Keeps your Bots' conversations, memory and skills. OpenBot uses it while it runs."
      title="Intelligence"
    >
      <PageRows>
        <Item size="sm">
          <RowMark>
            <IconSparkles className="size-4" />
          </RowMark>
          <ItemContent>
            <ItemTitle>
              {running ? READINESS[readiness ?? "unknown"] : "Stopped"}
            </ItemTitle>
            <ItemDescription>
              {intelligence.isPending
                ? intelligence.variables === "start"
                  ? "Starting…"
                  : "Stopping…"
                : intelligence.error
                  ? intelligence.error.message
                  : running && memory !== null
                    ? `${formatBytes(memory)} in use`
                    : "Not using memory while stopped."}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            {running ? (
              <>
                <Button
                  disabled={intelligence.isPending}
                  onClick={async () => {
                    await intelligence.mutateAsync("stop");
                    intelligence.mutate("start");
                  }}
                  size="sm"
                  variant="outline"
                >
                  Restart
                </Button>
                <Button
                  disabled={intelligence.isPending}
                  onClick={() => intelligence.mutate("stop")}
                  size="sm"
                  variant="outline"
                >
                  Stop
                </Button>
              </>
            ) : (
              <Button
                disabled={intelligence.isPending}
                onClick={() => intelligence.mutate("start")}
                size="sm"
                variant="outline"
              >
                Start
              </Button>
            )}
          </ItemActions>
        </Item>
        <PartRows
          icon={IconBox}
          parts={status.intelligenceContainers}
          separatorFirst
        />
      </PageRows>
    </PageSection>
  );
}

function MachineSection({
  readiness,
  status,
}: {
  readiness: IntelligenceReadiness | undefined;
  status: DesktopStatus;
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <PageSection
      action={
        <Button
          onClick={async () => {
            await navigator.clipboard.writeText(diagnostics(status, readiness));
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          }}
          size="sm"
          variant="outline"
        >
          {copied ? "Copied" : "Copy diagnostics"}
        </Button>
      }
      title="Details"
    >
      <PageRows>
        <Item size="sm">
          <RowMark>
            <IconBrandDocker className="size-4" />
          </RowMark>
          <ItemContent>
            <ItemTitle>
              {status.engine === "podman" ? "Podman" : "Docker"}
            </ItemTitle>
          </ItemContent>
          <ItemActions>
            <span className="text-muted-foreground text-xs">
              {status.engine ? "Running" : "Not running"}
            </span>
          </ItemActions>
        </Item>
        <Separator />
        <Item size="sm">
          <RowMark>
            <IconFolder className="size-4" />
          </RowMark>
          <ItemContent>
            <ItemTitle>Installed in</ItemTitle>
            <ItemDescription className="line-clamp-none break-all">
              {status.root}
            </ItemDescription>
          </ItemContent>
        </Item>
        <Separator />
        <Item size="sm">
          <RowMark>
            <IconInfoCircle className="size-4" />
          </RowMark>
          <ItemContent>
            <ItemTitle>Version {status.version}</ItemTitle>
            <ItemDescription className="line-clamp-none">
              {status.build}
            </ItemDescription>
          </ItemContent>
        </Item>
      </PageRows>
    </PageSection>
  );
}

/** Each container or process as a read-only row: its name, and its memory as the value. */
function PartRows({
  icon: Icon,
  parts,
  separatorFirst = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  parts: DesktopPart[];
  separatorFirst?: boolean;
}) {
  return parts.map((part, index) => (
    <React.Fragment key={part.name}>
      {(separatorFirst || index > 0) && <Separator />}
      <Item size="sm">
        <RowMark>
          <Icon className="size-4" />
        </RowMark>
        <ItemContent>
          <ItemTitle className="font-normal">{part.name}</ItemTitle>
        </ItemContent>
        <ItemActions>
          <span className="text-muted-foreground text-xs tabular-nums">
            {part.memoryBytes === null ? "—" : formatBytes(part.memoryBytes)}
          </span>
        </ItemActions>
      </Item>
    </React.Fragment>
  ));
}
