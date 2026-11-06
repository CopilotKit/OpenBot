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
            ? "Intelligence did not start."
            : "Intelligence did not stop.",
        );
    },
    onSettled: () => invalidateDesktop(queryClient),
  });
}
