import {
  DOESNT_UPDATE_ITSELF,
  type UpdateReadiness,
  updateOffered,
} from "@openbot/shared/desktop-updates";
import {
  IconBox,
  IconCpu,
  IconFileText,
  IconFolder,
  IconInfoCircle,
  IconServer,
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
import { describe } from "@/components/layout/update-banner";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  checkAppUpdateMutationOptions,
  installAppUpdateMutationOptions,
  intelligenceMutationOptions,
  openLogFolderMutationOptions,
  restartOpenBotMutationOptions,
  stopOpenBotMutationOptions,
} from "@/lib/desktop/mutations";
import { type PartGroup, partLabel } from "@/lib/desktop/part-names";
import {
  type DesktopAppUpdateCheck,
  type DesktopPart,
  type DesktopStatus,
  desktopAppUpdateQueryOptions,
  desktopStatusQueryOptions,
  diagnostics,
  formatBytes,
  type IntelligenceReadiness,
  intelligenceReadinessQueryOptions,
  totalMemory,
} from "@/lib/desktop/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/settings/this-computer")({
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
 * In the words the desktop app's Status window uses for the same parts: the local Intelligence is
 * "OpenBot's services", and Docker or Podman is "Software OpenBot runs on". Their technical names,
 * the stack id and the build are in Copy diagnostics, for support.
 *
 * Only inside OpenBot Desktop: the desktop app is what can see and control the containers, Docker and
 * the local Intelligence stack. In a browser there is nothing here to read.
 */
function ComputerPage() {
  const inDesktop = desktopShell() !== null;
  return (
    <PageShell
      description="See what OpenBot runs on this computer and how much memory it uses. Restart a part when it gets stuck."
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
  // The quick read draws the page at once; the measured one fills the memory figures in after.
  const listed = useQuery(desktopStatusQueryOptions({ memory: false }));
  const measured = useQuery(desktopStatusQueryOptions({ memory: true }));
  const data = measured.data ?? listed.data;
  const readiness = useQuery({
    ...intelligenceReadinessQueryOptions(),
    enabled: Boolean(data?.intelligenceStack),
  });

  if (!data && (listed.isPending || measured.isPending)) return null;
  if (!data)
    return (
      <p className="text-destructive text-sm" role="alert">
        Could not read what OpenBot runs on this computer.
      </p>
    );
  const isMeasured = measured.data !== undefined;
  return (
    <>
      <OpenBotSection measured={isMeasured} status={data} />
      {data.intelligenceStack && (
        <IntelligenceSection
          measured={isMeasured}
          readiness={readiness.data}
          status={data}
        />
      )}
      <MachineSection readiness={readiness.data} status={data} />
    </>
  );
}

function OpenBotSection({
  measured,
  status,
}: {
  /** Container memory has been read; before that a total would count the processes alone. */
  measured: boolean;
  status: DesktopStatus;
}) {
  const restart = useMutation(restartOpenBotMutationOptions(queryClient));
  const stop = useMutation(stopOpenBotMutationOptions());
  const memory = totalMemory([...status.processes, ...status.containers]);
  const busy = restart.isPending || stop.isPending;
  return (
    <PageSection title="App">
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
                  : [
                      // Nothing until the containers are measured: a total of the processes alone
                      // would be a smaller number that then jumps.
                      !status.openbotRunning
                        ? "Not using memory while stopped."
                        : !measured
                          ? null
                          : memory !== null
                            ? `${formatBytes(memory)} in use`
                            : "Memory could not be measured.",
                      // Restart is the desktop app's supervisor bringing its own processes back.
                      status.openbotRunning && !status.openbotHeld
                        ? "Started before the desktop app last opened; Stop it and start again to restart."
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" ")}
            </ItemDescription>
          </ItemContent>
          {status.openbotRunning && (
            <ItemActions>
              {status.openbotHeld && (
                <Button
                  disabled={busy}
                  onClick={() => restart.mutate()}
                  size="sm"
                  variant="outline"
                >
                  Restart
                </Button>
              )}
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
          group="bots"
          icon={IconTerminal2}
          parts={status.processes}
          separatorFirst
        />
        <PartRows
          group="bots"
          icon={IconBox}
          parts={status.containers}
          separatorFirst
        />
      </PageRows>
    </PageSection>
  );
}

function IntelligenceSection({
  measured,
  readiness,
  status,
}: {
  /** Container memory has been read. */
  measured: boolean;
  readiness: IntelligenceReadiness | undefined;
  status: DesktopStatus;
}) {
  const intelligence = useMutation(intelligenceMutationOptions(queryClient));
  const running =
    status.intelligenceContainers.length > 0 && readiness !== "stopped";
  const memory = totalMemory(status.intelligenceContainers);
  return (
    <PageSection
      description="These keep your Bots' conversations and skills. OpenBot needs them while it runs."
      title="OpenBot's services"
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
                  : !running
                    ? "Not using memory while stopped."
                    : !measured
                      ? null
                      : memory !== null
                        ? `${formatBytes(memory)} in use`
                        : "Memory could not be measured."}
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
          group="back-end"
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
            <IconServer className="size-4" />
          </RowMark>
          <ItemContent>
            {/* Docker or Podman, said as setup says it. Which one is in Copy diagnostics. */}
            <ItemTitle>Software OpenBot runs on</ItemTitle>
            {!status.engine && (
              <ItemDescription className="line-clamp-none">
                OpenBot needs this to run. If you use Docker Desktop, open it
                and wait for it to start.
              </ItemDescription>
            )}
          </ItemContent>
          <ItemActions>
            <span className="text-muted-foreground text-sm">
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
        {status.logFolder && (
          <>
            <Separator />
            <LogsRow folder={status.logFolder} />
          </>
        )}
        <Separator />
        <VersionRow status={status} />
      </PageRows>
    </PageSection>
  );
}

/**
 * Where the desktop app keeps its log, with Open log folder, so a person can share the file when
 * they ask for help. The desktop app opens its own folder; nothing here names a path to open.
 */
function LogsRow({ folder }: { folder: string }) {
  const open = useMutation(openLogFolderMutationOptions());
  return (
    <Item size="sm">
      <RowMark>
        <IconFileText className="size-4" />
      </RowMark>
      <ItemContent>
        <ItemTitle>Logs</ItemTitle>
        <ItemDescription className="line-clamp-none">
          Logs stay on this computer and leave out your keys and messages. Share
          them when you ask for help.
        </ItemDescription>
        <ItemDescription className="line-clamp-none break-all">
          {folder}
        </ItemDescription>
        {open.error && (
          <ItemDescription
            className="line-clamp-none text-destructive"
            role="alert"
          >
            Couldn't open the log folder. Find it at the path above.
          </ItemDescription>
        )}
      </ItemContent>
      <ItemActions>
        <Button
          disabled={open.isPending}
          onClick={() => open.mutate()}
          size="sm"
          variant="outline"
        >
          Open log folder
        </Button>
      </ItemActions>
    </Item>
  );
}

/**
 * The desktop app's version, with Check for updates. The same check as Check for Updates… in the
 * tray: the app reads its update feed at once and says what it found. On Windows, which has no menu
 * bar, this and the tray are the places to ask.
 *
 * A build that never updates itself (internal, candidate, or without the updater) says so up front
 * in the setup window's words, with no button: the tray and the menus don't offer the check either.
 *
 * A newer version found says how ready it is, as the banner does: downloading in the background
 * while this version keeps running, then ready to install in a few minutes.
 */
function VersionRow({ status }: { status: DesktopStatus }) {
  const check = useMutation(checkAppUpdateMutationOptions(queryClient));
  const install = useMutation(installAppUpdateMutationOptions(queryClient));
  // The download's progress, asked twice a second from the click on, as the banner asks once it
  // sees an install under way; and every five seconds while the new version downloads in the
  // background, so its share moves.
  const offer = useQuery({
    ...desktopAppUpdateQueryOptions(),
    refetchInterval: (query) =>
      install.isPending
        ? 500
        : query.state.data?.ready?.state === "preparing"
          ? 5_000
          : false,
  });
  const progress = offer.data?.installing ?? null;
  const installing = install.isPending || progress !== null;
  const found = check.data;
  // An older desktop app doesn't say, and its check answers for itself. No button until the first
  // answer, so a build that doesn't update itself never shows one for a moment.
  const updatesItself = offer.data?.updatesItself !== false;
  return (
    <Item size="sm">
      <RowMark>
        <IconInfoCircle className="size-4" />
      </RowMark>
      <ItemContent>
        {/* The build it was made from is for support, in Copy diagnostics. */}
        <ItemTitle>Version {status.version}</ItemTitle>
        {!updatesItself && (
          <ItemDescription className="line-clamp-none text-foreground">
            {DOESNT_UPDATE_ITSELF}
          </ItemDescription>
        )}
        {found && !check.isPending && (
          <ItemDescription
            className="line-clamp-none text-foreground"
            role="status"
          >
            {checked(found, offer.data?.ready)}
          </ItemDescription>
        )}
        {check.error && (
          <ItemDescription
            className="line-clamp-none text-destructive"
            role="alert"
          >
            {reason(check.error)}
          </ItemDescription>
        )}
        {install.error && !installing && (
          <ItemDescription
            className="line-clamp-none text-destructive"
            role="alert"
          >
            Couldn't install the update: {reason(install.error)}
          </ItemDescription>
        )}
      </ItemContent>
      {updatesItself && !offer.isLoading && (
        <ItemActions>
          {found?.found === "available" ? (
            <Button
              disabled={installing}
              onClick={() => install.mutate()}
              size="sm"
            >
              {installing ? describe(progress) : "Update and restart"}
            </Button>
          ) : (
            <Button
              disabled={check.isPending}
              onClick={() => check.mutate()}
              size="sm"
              variant="outline"
            >
              {check.isPending ? "Checking…" : "Check for updates"}
            </Button>
          )}
        </ItemActions>
      )}
    </Item>
  );
}

/**
 * What a check found, in a sentence. A newer version says how ready it is now (`ready`, from the
 * app's offer, which moves on after the check), or as the check found it.
 */
function checked(
  found: DesktopAppUpdateCheck,
  ready?: UpdateReadiness | null,
): string {
  switch (found.found) {
    case "available":
      return updateOffered(found.version, ready ?? found.ready);
    case "upToDate":
      return `OpenBot ${found.current} is up to date.`;
    case "installing":
      return `OpenBot is downloading ${found.version} and restarts when it's done.`;
    case "notOffered":
      return DOESNT_UPDATE_ITSELF;
  }
}

/** The desktop app refuses with its own sentence, as a plain string. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Each container or process as a read-only row: what it is for, and its memory as the value. */
function PartRows({
  icon: Icon,
  parts,
  group,
  separatorFirst = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  parts: DesktopPart[];
  group: PartGroup;
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
          <ItemTitle className="font-normal">
            {partLabel(part.name, group)}
          </ItemTitle>
        </ItemContent>
        <ItemActions>
          <span className="text-muted-foreground text-sm tabular-nums">
            {part.memoryBytes === null
              ? "Not measured"
              : formatBytes(part.memoryBytes)}
          </span>
        </ItemActions>
      </Item>
    </React.Fragment>
  ));
}
