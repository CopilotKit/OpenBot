import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { desktopKeys, invokeDesktop } from "./queries";

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
            ? "The back end did not start."
            : "The back end did not stop.",
        );
    },
    onSettled: () => invalidateDesktop(queryClient),
  });
}
