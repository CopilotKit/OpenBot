import type { ConnectCodeResponse } from "@openbot/shared/recorder-api";
import { recorderPaths } from "@openbot/shared/recorder-api";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { recorderKeys } from "./queries";

export function revokeRecorderConnectionMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (connectionId: string): Promise<void> => {
      await client(recorderPaths.connection(connectionId), {
        method: "DELETE",
        fallback: "Couldn't disconnect this browser.",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: recorderKeys.all }),
  });
}

/** A step inside the connect flow: a code for the Recorder to exchange, not state anything caches. */
export async function mintRecorderConnectCode(): Promise<ConnectCodeResponse> {
  return (
    await client(recorderPaths.connectCodes, {
      method: "POST",
      body: { via: "web" },
      fallback: "Couldn't start connecting this browser.",
    })
  ).json();
}
