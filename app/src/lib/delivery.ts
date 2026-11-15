import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { listDeliveries } from "@/lib/api/generated/deliveries/deliveries";
import {
  confirmPhoneDestination,
  deleteDestination,
  linkChatDestination,
  listDestinations,
  verifyPhoneDestination,
} from "@/lib/api/generated/destinations/destinations";
import { deleteDevice, listDevices } from "@/lib/api/generated/devices/devices";
import type { Delivery, Destination, Device } from "@/lib/api/generated/model";
import { listNotificationTransports } from "@/lib/api/generated/notification-settings/notification-settings";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import type { UpdateTransport } from "@/lib/bot-lifecycle/queries";
import { ClientError } from "@/lib/client";

/**
 * How a person's Bots reach them outside OpenBot, through the API: their phones for push
 * notifications, the Slack, Teams and phone destinations their conversations continue in, what was
 * sent to them, and which of those ways this deployment has. Each is the person's own (`me`).
 */

export type { Delivery, Destination, Device };

/** Whether each way of reaching a person is set up on this deployment. */
export type Transports = Record<UpdateTransport, boolean>;

export const deliveryKeys = {
  all: ["delivery"] as const,
  destinations: ["delivery", "destinations"] as const,
  devices: ["delivery", "devices"] as const,
  deliveries: ["delivery", "deliveries"] as const,
  transports: ["delivery", "transports"] as const,
};

const ME = "me";
const FALLBACK = "Could not load reachability";

/** Every page of a list that holds a handful at most, so a screen reads it whole. */
async function everyPage<T>(
  page: (cursor: string | undefined) => Promise<{
    items: T[];
    nextCursor: string | null;
  }>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  do {
    const next = await page(cursor);
    all.push(...next.items);
    cursor = next.nextCursor ?? undefined;
  } while (cursor);
  return all;
}

const paging = (cursor: string | undefined) => ({
  limit: 100,
  ...(cursor ? { cursor } : {}),
});

/** Where the person's conversations continue now, the first connected first. */
export function destinationsQueryOptions() {
  return queryOptions({
    queryKey: deliveryKeys.destinations,
    queryFn: ({ signal }): Promise<Destination[]> =>
      everyPage(async (cursor) => {
        const page = await listDestinations(
          organizationId(),
          ME,
          paging(cursor),
          { signal, fallback: FALLBACK },
        );
        return { items: page.destinations, nextCursor: page.nextCursor };
      }),
    // A Slack or Teams link is finished from the chat app, so the list is read again until it shows.
    refetchInterval: 10_000,
  });
}

/** The person's phones that get push notifications. */
export function devicesQueryOptions() {
  return queryOptions({
    queryKey: deliveryKeys.devices,
    queryFn: ({ signal }): Promise<Device[]> =>
      everyPage(async (cursor) => {
        const page = await listDevices(organizationId(), ME, paging(cursor), {
          signal,
          fallback: FALLBACK,
        });
        return { items: page.devices, nextCursor: page.nextCursor };
      }),
    refetchInterval: 10_000,
  });
}

/** The hundred newest things sent to the person outside OpenBot. */
export function deliveriesQueryOptions() {
  return queryOptions({
    queryKey: deliveryKeys.deliveries,
    queryFn: async ({ signal }): Promise<Delivery[]> =>
      (
        await listDeliveries(
          organizationId(),
          ME,
          { limit: 100 },
          { signal, fallback: FALLBACK },
        )
      ).deliveries,
    refetchInterval: 10_000,
  });
}

/** Which of push, Slack, Teams and text messages this deployment has set up. */
export function transportsQueryOptions() {
  return queryOptions({
    queryKey: deliveryKeys.transports,
    queryFn: async ({ signal }): Promise<Transports> => {
      const offered = await everyPage(async (cursor) => {
        const page = await listNotificationTransports(
          organizationId(),
          paging(cursor),
          { signal, fallback: FALLBACK },
        );
        return {
          items: page.notificationTransports,
          nextCursor: page.nextCursor,
        };
      });
      const set = new Set(offered.map((transport) => transport.id));
      return {
        push: set.has("push"),
        slack: set.has("slack"),
        teams: set.has("teams"),
        sms: set.has("sms"),
      };
    },
    // Set where OpenBot runs and read at its start, so it doesn't change while a screen is open.
    staleTime: 60_000,
  });
}

/** A one-time `link <code>` message for the OpenBot app in Slack or Teams. */
export type ChatLink = {
  platform: "slack" | "teams";
  code: string;
  command: string;
  /** When the code stops working, in milliseconds since the epoch. */
  expiresAt: number;
};

export async function startChatLink(target: {
  channelId: string;
  agentId: string;
  platform: "slack" | "teams";
}): Promise<ChatLink> {
  const link = await linkChatDestination(
    organizationId(),
    ME,
    {
      platform: target.platform,
      conversationId: target.channelId,
      botId: target.agentId,
    },
    { "Idempotency-Key": idempotencyKey() },
    {
      fallback: `Could not start linking ${target.platform === "teams" ? "Teams" : "Slack"}`,
    },
  );
  return { ...link, expiresAt: Date.parse(link.expiresAt) };
}

/** Text a verification code to a phone. The verification's id is what confirms it. */
export async function startSms(target: {
  channelId: string;
  agentId: string;
  phone: string;
}): Promise<string> {
  const verification = await verifyPhoneDestination(
    organizationId(),
    ME,
    {
      phone: target.phone,
      conversationId: target.channelId,
      botId: target.agentId,
    },
    { "Idempotency-Key": idempotencyKey() },
    { fallback: "Could not verify this phone" },
  );
  return verification.verificationId;
}

export function confirmSms(challengeId: string, code: string) {
  return confirmPhoneDestination(
    organizationId(),
    ME,
    { verificationId: challengeId, code },
    { "Idempotency-Key": idempotencyKey() },
    { fallback: "Could not confirm this phone" },
  );
}

/** Something already gone is done: the API answers it as not found. */
async function gone(remove: () => Promise<unknown>) {
  try {
    await remove();
  } catch (error) {
    if (error instanceof ClientError && error.status === 404) return;
    throw error;
  }
}

export function removeDeliveryBinding(id: string) {
  return gone(() =>
    deleteDestination(
      organizationId(),
      ME,
      id,
      { "Idempotency-Key": idempotencyKey() },
      { fallback: "Could not disconnect" },
    ),
  );
}

export function removePushDevice(id: string) {
  return gone(() =>
    deleteDevice(
      organizationId(),
      ME,
      id,
      { "Idempotency-Key": idempotencyKey() },
      { fallback: "Could not remove this device" },
    ),
  );
}

export function removePushDeviceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: removePushDevice,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: deliveryKeys.devices }),
  });
}

export function removeDeliveryBindingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: removeDeliveryBinding,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: deliveryKeys.destinations }),
  });
}

/**
 * Ask for a one-time `link <code>` message. No `queryClient`: nothing is linked until the code is
 * sent from Slack or Teams, so nothing cached has changed yet and there is nothing to invalidate.
 */
export function startChatLinkMutationOptions() {
  return mutationOptions({ mutationFn: startChatLink });
}

/**
 * Text a verification code to a phone. No `queryClient`, for the same reason as a link message: the
 * phone is not connected until the code comes back through `confirmSms`.
 */
export function startSmsMutationOptions() {
  return mutationOptions({ mutationFn: startSms });
}

export function confirmSmsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      challengeId,
      code,
    }: {
      challengeId: string;
      code: string;
    }) => confirmSms(challengeId, code),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: deliveryKeys.destinations }),
  });
}
