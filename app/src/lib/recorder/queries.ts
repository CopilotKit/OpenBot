import type { RecorderConnectionsResponse } from "@openbot/shared/recorder-api";
import { recorderPaths } from "@openbot/shared/recorder-api";
import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export const recorderKeys = {
  all: ["recorder"] as const,
  connections: () => ["recorder", "connections"] as const,
};

/**
 * The browsers connected for this person, and the extension ids this OpenBot trusts.
 *
 * `awaiting` polls every 2 s while a "Connect this browser" request waits for the person to confirm
 * it in the Recorder's own tab.
 */
export const recorderConnectionsQueryOptions = (options?: {
  awaiting?: boolean;
}) =>
  queryOptions({
    queryKey: recorderKeys.connections(),
    // Two top-level keys, so no envelope key: without one, client() returns the Response.
    queryFn: async (): Promise<RecorderConnectionsResponse> =>
      (
        await client(recorderPaths.connections, {
          fallback: "Couldn't load your connected browsers.",
        })
      ).json(),
    refetchInterval: options?.awaiting ? 2000 : false,
  });
