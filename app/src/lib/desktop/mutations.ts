import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  type DesktopAppUpdateCheck,
  type DesktopUsageData,
  desktopKeys,
  invokeDesktop,
} from "./queries";

/**
 * Turn Share usage data on or off. The desktop app keeps the choice for the next launch, stops its
 * own events and the CLI's at once, and starts the server with it the next time OpenBot starts.
 * It answers with the setting as it now stands.
 */
export function setUsageDataMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (share: boolean): Promise<DesktopUsageData> =>
      invokeDesktop("set_usage_data", { share }),
    onSuccess: (usageData) =>
      queryClient.setQueryData(desktopKeys.usageData, usageData),
  });
}

function invalidateDesktop(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: desktopKeys.all });
}

/**
 * Restart OpenBot's processes. The desktop app ends each one and its supervisor starts it again;
 * the containers, the database among them, keep running. This page's requests fail for the few
 * seconds that takes.
 */
export function restartOpenBotMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (): Promise<void> => invokeDesktop("restart"),
    onSuccess: () => invalidateDesktop(queryClient),
  });
}

/**
 * Stop everything OpenBot started. This page goes with it: the window shows setup, where Start is.
 * Nothing to invalidate, since nothing here will be read again.
 */
export function stopOpenBotMutationOptions() {
  return mutationOptions({
    mutationFn: (): Promise<void> => invokeDesktop("stop"),
  });
}

/**
 * Change the AI connection. The desktop app stops OpenBot and its window shows setup at the AI
 * screen, where the new choice starts OpenBot again. Like Stop, this page goes with it.
 */
export function changeAiConnectionMutationOptions() {
  return mutationOptions({
    mutationFn: (): Promise<void> => invokeDesktop("change_ai_connection"),
  });
}

/**
 * Check for updates now. The desktop app reads its update feed and keeps the answer, so the banner
 * reads it too. Rejects with the app's own sentence when the feed couldn't be read.
 */
export function checkAppUpdateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (): Promise<DesktopAppUpdateCheck> =>
      invokeDesktop("check_update"),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: desktopKeys.appUpdate }),
  });
}

/** Close the update banner on `version`, until a newer version comes out. */
export function dismissAppUpdateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (version: string): Promise<void> =>
      invokeDesktop("dismiss_update", { version }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: desktopKeys.appUpdate }),
  });
}

/**
 * Update and restart. The desktop app downloads the update and checks its signature while OpenBot
 * keeps running, installs it, stops OpenBot and restarts. It answers only when that failed: on
 * success this page goes away with the app, and the next Start moves OpenBot to the new release.
 */
export function installAppUpdateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (): Promise<void> => invokeDesktop("install_update"),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: desktopKeys.appUpdate }),
  });
}

/**
 * Open the desktop app's log folder in the system's file manager. The desktop app opens its own
 * folder; the page never names a path. Rejects with the app's reason as a plain string.
 */
export function openLogFolderMutationOptions() {
  return mutationOptions({
    mutationFn: (): Promise<void> => invokeDesktop("open_logs"),
  });
}

/** Start or stop the local Intelligence stack. */
export function intelligenceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (action: "start" | "stop"): Promise<void> => {
      const report = await invokeDesktop<{ outcome: string }>("intelligence", {
        action,
      });
      if (report.outcome !== "completed")
        throw new Error(
          action === "start"
            ? "OpenBot's services didn't start. Try again."
            : "OpenBot's services didn't stop. Try again.",
        );
    },
    onSettled: () => invalidateDesktop(queryClient),
  });
}
