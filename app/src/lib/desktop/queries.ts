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
};

export const desktopKeys = {
  all: ["desktop"] as const,
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
    refetchInterval: (query) => (query.state.data?.installing ? 500 : 60_000),
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
      ? `Back end: ${status.intelligenceStack}, ${readiness ?? "not checked"}`
      : "Back end: not on this computer",
    ...(status.intelligenceStack
      ? [`  containers: ${parts(status.intelligenceContainers)}`]
      : []),
  ].join("\n");
}
