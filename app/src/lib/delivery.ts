import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "./client";
export type Reachability = {
  bindings: {
    id: string;
    transport: "slack" | "teams" | "sms";
    channelId: string;
    agentId: string;
    address: string;
    mentionId?: string | null;
    enabled: boolean;
    /** SMS only: the number replied STOP; texts resume after START. */
    optedOutAt?: string | null;
  }[];
  devices: { id: string; platform: "ios" | "android"; enabled: boolean }[];
  deliveries: {
    id: string;
    transport: string;
    kind: string;
    state: string;
    error: string | null;
    createdAt: string;
  }[];
  available: { slack: boolean; teams: boolean; sms: boolean; push: boolean };
};
export const deliveryKey = ["delivery"] as const;
export function deliveryQueryOptions() {
  return queryOptions({
    queryKey: deliveryKey,
    queryFn: async (): Promise<Reachability> => {
      const response = await client("/api/delivery", {
        fallback: "Could not load reachability",
      });
      return response.json();
    },
    refetchInterval: 10_000,
  });
}
/** A one-time `link <code>` message for the OpenTag app in Slack or Teams. */
export type ChatLink = {
  platform: "slack" | "teams";
  code: string;
  command: string;
  expiresInMinutes: number;
};
export async function startChatLink(target: {
  channelId: string;
  agentId: string;
  platform: "slack" | "teams";
}): Promise<ChatLink> {
  const response = await client("/api/delivery/opentag/start", {
    method: "POST",
    body: target,
    fallback: `Could not start linking ${target.platform === "teams" ? "Teams" : "Slack"}`,
  });
  return response.json();
}
export function startSms(target: {
  channelId: string;
  agentId: string;
  phone: string;
}) {
  return client<string>("/api/delivery/sms/start", "challengeId", {
    method: "POST",
    body: target,
    fallback: "Could not verify this phone",
  });
}
export function confirmSms(challengeId: string, code: string) {
  return client("/api/delivery/sms/confirm", {
    method: "POST",
    body: { challengeId, code },
    fallback: "Could not confirm this phone",
  });
}
export function removeDeliveryBinding(id: string) {
  return client(`/api/delivery/bindings/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "Could not disconnect",
  });
}
export function removePushDevice(id: string) {
  return client(`/api/delivery/devices/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "Could not remove this device",
  });
}

export function removePushDeviceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: removePushDevice,
    onSettled: () => queryClient.invalidateQueries({ queryKey: deliveryKey }),
  });
}
