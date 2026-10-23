import { queryOptions } from "@tanstack/react-query";
import { desktopShell } from "./intelligence-dashboard";

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
  openbotRunning: boolean;
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

export const desktopKeys = {
  all: ["desktop"] as const,
  status: ["desktop", "status"] as const,
  intelligence: ["desktop", "intelligence"] as const,
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

/** Read every few seconds while the page shows: memory moves. */
export function desktopStatusQueryOptions() {
  return queryOptions({
    queryKey: desktopKeys.status,
    queryFn: (): Promise<DesktopStatus> => invokeDesktop("status"),
    refetchInterval: 5000,
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
      ? `Intelligence: ${status.intelligenceStack}, ${readiness ?? "not checked"}`
      : "Intelligence: no local stack",
    ...(status.intelligenceStack
      ? [`  containers: ${parts(status.intelligenceContainers)}`]
      : []),
  ].join("\n");
}
