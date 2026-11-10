import type { UpdateReadiness } from "@openbot/shared/desktop-updates";
import { queryOptions } from "@tanstack/react-query";
import { desktopShell } from "./shell";

/**
 * Settings → This computer, read from the OpenBot Desktop app rather than the server.
 *
 * Inside Desktop the page is loaded in the desktop app's own window, which lets exactly this app's
 * origin call the commands of one plugin (`openbot-desktop`). In a plain browser there is no
 * desktop app, `desktopShell()` is null, and the page says so instead of asking.
 */

/** One container or host process, and its memory where it could be measured. */
export type DesktopPart = { name: string; memoryBytes: number | null };

/** What the desktop app reports about what it runs here. */
export type DesktopStatus = {
  /** OpenBot answers on its own address, whoever started it. */
  openbotRunning: boolean;
  /**
   * The desktop app holds OpenBot's processes, so Restart can bring them back. False for an OpenBot
   * left running by an earlier session of the desktop app that ended without quitting.
   */
  openbotHeld: boolean;
  processes: DesktopPart[];
  containers: DesktopPart[];
  /** The local Intelligence stack recorded for this installation; null when there is none. */
  intelligenceStack: string | null;
  intelligenceContainers: DesktopPart[];
  /** "docker" or "podman", answering now; null when no container engine answers. */
  engine: "docker" | "podman" | null;
  root: string;
  appPort: number | null;
  version: string;
  build: string;
  /**
   * The folder the desktop app writes its log file to. Absent from a desktop app older than the
   * log, which has no Open log folder to offer.
   */
  logFolder?: string | null;
};

/** The Intelligence CLI's own end-to-end readiness. */
export type IntelligenceReadiness =
  | "ready"
  | "starting"
  | "stopped"
  | "degraded"
  | "unknown";

/**
 * A newer OpenBot Desktop, as the desktop app last read it from its update feed. The app reads the
 * feed itself, at launch and every six hours; this page only asks the app, so a browser showing a
 * self-hosted OpenBot (no desktop app around it) never asks anybody.
 */
export type DesktopAppUpdate = {
  /** The version to offer; null when there is none, or this person closed the banner on it. */
  version: string | null;
  /** The desktop app's own version. */
  current: string;
  /** Set from the click on Update and restart until the app restarts. */
  installing: {
    downloaded: number;
    total: number | null;
    restarting: boolean;
  } | null;
  /**
   * False on a build that never updates itself: an internal or candidate build, or one without the
   * updater. Absent from a desktop app older than the field, which still answers a check.
   */
  updatesItself?: boolean;
  /**
   * How ready the newer version is to install: downloading in the background, or all here. Null
   * before the app starts on it, and absent from a desktop app older than the field.
   */
  ready?: UpdateReadiness | null;
};

/**
 * What the desktop app found when asked to check for updates now: it reads its update feed at once.
 * A newer version is named even if this person closed the banner on it, because they asked.
 */
export type DesktopAppUpdateCheck =
  | {
      found: "available";
      version: string;
      current: string;
      ready?: UpdateReadiness | null;
    }
  | { found: "upToDate"; current: string }
  | { found: "installing"; version: string; current: string }
  /** This build never updates itself: an internal or candidate build. */
  | { found: "notOffered"; current: string };

/**
 * Which AI provider and sign-in OpenBot starts with, as the desktop app last saved it. Never a key
 * or a token: the setup window holds those, and changing the connection happens there.
 */
export type DesktopAiConnection = {
  /** The connection chosen in setup; null before one was. */
  kind:
    | "open-ai-api-key"
    | "anthropic-api-key"
    | "claude-plan"
    | "chat-gpt-plan"
    | "compatible-endpoint"
    | "google-oauth"
    | "xai-oauth"
    | null;
  /** The model named in setup. Only an address or a provider sign-in names one. */
  model: string | null;
  /** A custom address's host, and nothing else of the address. */
  endpointHost: string | null;
};

/**
 * Settings' Share usage data, as the desktop app keeps it. Off is the same opt-out as
 * `COPILOTKIT_TELEMETRY_DISABLED`; when that variable (or `DO_NOT_TRACK`) is set where the app was
 * launched, sharing is off and Settings cannot turn it on.
 */
export type DesktopUsageData = {
  shared: boolean;
  offByEnvironment: boolean;
};

export const desktopKeys = {
  all: ["desktop"] as const,
  aiConnection: ["desktop", "ai-connection"] as const,
  usageData: ["desktop", "usage-data"] as const,
  status: (memory: boolean) => ["desktop", "status", { memory }] as const,
  intelligence: ["desktop", "intelligence"] as const,
  appUpdate: ["desktop", "app-update"] as const,
};

const PLUGIN = "plugin:openbot-desktop";

/** One command of the desktop app's plugin. Rejects outside Desktop, which no caller reaches. */
export async function invokeDesktop<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const shell = desktopShell();
  if (!shell) throw new Error("This page needs the OpenBot desktop app.");
  return (await shell.invoke(`${PLUGIN}|${command}`, args)) as T;
}

/**
 * What runs here, in two reads. Without `memory` it answers in milliseconds, with every container
 * listed and none measured, so the page draws at once. With `memory` it takes about two seconds,
 * because Docker samples before it reports, and fills the figures in; that one repeats while the page
 * shows, since memory moves.
 */
export function desktopStatusQueryOptions({ memory }: { memory: boolean }) {
  return queryOptions({
    queryKey: desktopKeys.status(memory),
    queryFn: (): Promise<DesktopStatus> => invokeDesktop("status", { memory }),
    refetchInterval: memory ? 5000 : false,
  });
}

/**
 * Intelligence's readiness, asked on arrival and after an action here, never on a timer: the
 * desktop app's own Intelligence calls take the same lock, and polling it would make them fail as
 * busy.
 */
export function intelligenceReadinessQueryOptions() {
  return queryOptions({
    queryKey: desktopKeys.intelligence,
    queryFn: async (): Promise<IntelligenceReadiness> =>
      (
        await invokeDesktop<{ readiness: IntelligenceReadiness }>(
          "intelligence",
          { action: "status" },
        )
      ).readiness,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * The update banner's offer. Asked only inside the Desktop window; anywhere else it is never asked.
 * A read of the app's memory, so asking every minute costs nothing, and twice a second while an
 * update downloads, for its progress. An older desktop app has no such command and refuses it the
 * same way every time, so a refusal is not retried: there is just no banner.
 */
export function desktopAppUpdateQueryOptions() {
  return queryOptions({
    queryKey: desktopKeys.appUpdate,
    queryFn: (): Promise<DesktopAppUpdate> => invokeDesktop("update_offer"),
    enabled: desktopShell() !== null,
    retry: false,
    // Every five seconds while it downloads in the background, so its share moves on screen.
    refetchInterval: (query) =>
      query.state.data?.installing
        ? 500
        : query.state.data?.ready?.state === "preparing"
          ? 5_000
          : 60_000,
  });
}

/**
 * Settings' AI model row. Asked only inside the Desktop window. An older desktop app has no such
 * command and refuses it every time, so a refusal is not retried: there is just no row.
 */
export function desktopAiConnectionQueryOptions() {
  return queryOptions({
    queryKey: desktopKeys.aiConnection,
    queryFn: (): Promise<DesktopAiConnection> => invokeDesktop("ai_connection"),
    enabled: desktopShell() !== null,
    retry: false,
  });
}

/**
 * Settings' Share usage data row. Asked only inside the Desktop window; an older desktop app has
 * no such command and refuses it every time, so a refusal is not retried and there is no row.
 */
export function desktopUsageDataQueryOptions() {
  return queryOptions({
    queryKey: desktopKeys.usageData,
    queryFn: (): Promise<DesktopUsageData> => invokeDesktop("usage_data"),
    enabled: desktopShell() !== null,
    retry: false,
  });
}

/** "1.2 GB", "340 MB": decimal, as macOS reports memory. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** What a list of parts uses together, or null when none of them could be measured. */
export function totalMemory(parts: DesktopPart[]): number | null {
  const measured = parts.filter((part) => part.memoryBytes !== null);
  if (measured.length === 0) return null;
  return measured.reduce((sum, part) => sum + (part.memoryBytes ?? 0), 0);
}

/** Everything a support person needs, and nothing secret: no keys, tokens or addresses with them. */
export function diagnostics(
  status: DesktopStatus,
  readiness: IntelligenceReadiness | undefined,
): string {
  const parts = (list: DesktopPart[]) =>
    list.length === 0
      ? "none"
      : list
          .map(
            (part) =>
              `${part.name} ${part.memoryBytes === null ? "?" : formatBytes(part.memoryBytes)}`,
          )
          .join(", ");
  return [
    `OpenBot Desktop ${status.version} (${status.build})`,
    `Installed in ${status.root}${status.appPort ? `, app on port ${status.appPort}` : ""}`,
    `Container engine: ${status.engine ?? "not answering"}`,
    `OpenBot: ${status.openbotRunning ? "running" : "stopped"}`,
    `  processes: ${parts(status.processes)}`,
    `  containers: ${parts(status.containers)}`,
    status.intelligenceStack
      ? `Backend: ${status.intelligenceStack}, ${readiness ?? "not checked"}`
      : "Backend: not on this computer",
    ...(status.intelligenceStack
      ? [`  containers: ${parts(status.intelligenceContainers)}`]
      : []),
  ].join("\n");
}
