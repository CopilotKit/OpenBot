/**
 * The notifications API as the server answers it, for a test that fakes `fetch` by hand.
 *
 * The app reads and changes a person's devices, destinations, deliveries and notification settings
 * through the client generated from api/openapi.yaml, at `/api/v2/organizations/default/...`. A test
 * gives what a person has the way `/api/delivery` and `/api/bots/routing` answered it, and gets each
 * request answered in the API's shape, every list on one page.
 */

/**
 * The Response a real `fetch` returns. Read before any test registers happy-dom, as each test file
 * that needs it does at its top.
 */
const NativeResponse = globalThis.Response;

const ORGANIZATION = "/api/v2/organizations/default";
const ME = `${ORGANIZATION}/people/me`;
export const DESTINATIONS_PATH = `${ME}/destinations`;
export const LINK_CHAT_PATH = `${DESTINATIONS_PATH}/link-chat`;
export const VERIFY_PHONE_PATH = `${DESTINATIONS_PATH}/verify-phone`;
export const CONFIRM_PHONE_PATH = `${DESTINATIONS_PATH}/confirm-phone`;
export const CONNECT_TELEGRAM_PATH = `${DESTINATIONS_PATH}/connect-telegram`;
export const DEVICES_PATH = `${ME}/devices`;
export const DELIVERIES_PATH = `${ME}/deliveries`;
export const NOTIFICATION_SETTINGS_PATH = `${ME}/notification-settings`;
export const TRANSPORTS_PATH = `${ORGANIZATION}/notification-transports`;

export function destinationPath(id: string): string {
  return `${DESTINATIONS_PATH}/${encodeURIComponent(id)}`;
}
export function devicePath(id: string): string {
  return `${DEVICES_PATH}/${encodeURIComponent(id)}`;
}
export function botNotificationSettingsPath(botId: string): string {
  return `${ME}/bot-notification-settings/${encodeURIComponent(botId)}`;
}

type Transport = "slack" | "teams" | "sms" | "telegram" | "push";

/** What a person has, as `GET /api/delivery` answered it; anything left out is none. */
export type TodayReachability = {
  bindings?: {
    id: string;
    transport: "slack" | "teams" | "sms" | "telegram";
    channelId: string;
    agentId: string;
    address?: string;
    enabled?: boolean;
    optedOutAt?: string | null;
  }[];
  devices?: { id: string; platform: "ios" | "android" }[];
  deliveries?: {
    id: string;
    transport: Transport;
    kind: "reply" | "question" | "approval" | "attention";
    state: string;
    error: string | null;
    createdAt: string;
  }[];
  available?: Partial<Record<Transport, boolean>>;
  routing?: Partial<Record<string, Transport[] | "all">>;
};

const KINDS = ["progress", "decision", "question", "attention"] as const;
const TRANSPORTS: Transport[] = ["push", "slack", "teams", "telegram", "sms"];
const TITLES: Record<Transport, string> = {
  push: "Push",
  slack: "Slack",
  teams: "Microsoft Teams",
  telegram: "Telegram",
  sms: "SMS",
};

/** Every kind of update's route, with a kind the person never chose for going everywhere. */
export function routingBody(today: TodayReachability = {}) {
  return {
    routing: Object.fromEntries(
      KINDS.map((kind) => [kind, today.routing?.[kind] ?? "all"]),
    ),
  };
}

/**
 * The API's answer to a request about a person's notifications, from what they have; undefined for
 * any other request. Writes answer as the server does and change nothing a later read sees, unless
 * the test passes the same `today` and changes it itself.
 */
export function notificationsResponse(
  method: string,
  path: string,
  today: TodayReachability = {},
  body?: unknown,
): Response | undefined {
  const pathname = path.split("?")[0] ?? "";
  if (method === "GET" && pathname === DESTINATIONS_PATH)
    return NativeResponse.json({
      destinations: (today.bindings ?? [])
        .filter((binding) => binding.enabled !== false)
        .map((binding) => ({
          id: binding.id,
          transport: binding.transport,
          conversationId: binding.channelId,
          botId: binding.agentId,
          address: binding.address ?? "D0001",
          optedOutAt: binding.optedOutAt ?? null,
          createdAt: "2026-11-01T09:00:00.000Z",
        })),
      nextCursor: null,
    });
  if (method === "GET" && pathname === DEVICES_PATH)
    return NativeResponse.json({
      devices: (today.devices ?? []).map((device) => ({
        ...device,
        createdAt: "2026-11-01T09:00:00.000Z",
      })),
      nextCursor: null,
    });
  if (method === "GET" && pathname === DELIVERIES_PATH)
    return NativeResponse.json({
      deliveries: (today.deliveries ?? []).map((delivery) => ({
        ...delivery,
        conversationId: "c1",
        botId: "b1",
      })),
      nextCursor: null,
    });
  if (method === "GET" && pathname === TRANSPORTS_PATH)
    return NativeResponse.json({
      notificationTransports: TRANSPORTS.filter(
        (transport) => today.available?.[transport],
      ).map((id) => ({ id, title: TITLES[id] })),
      nextCursor: null,
    });
  if (
    (method === "GET" || method === "PATCH") &&
    pathname === NOTIFICATION_SETTINGS_PATH
  ) {
    const changes =
      method === "PATCH"
        ? ((body as { routing?: Record<string, Transport[] | "all"> })
            ?.routing ?? {})
        : {};
    return NativeResponse.json(
      routingBody({ ...today, routing: { ...today.routing, ...changes } }),
    );
  }
  if (pathname.startsWith(`${ME}/bot-notification-settings/`)) {
    const botId = decodeURIComponent(pathname.split("/").at(-1) ?? "");
    const notify =
      method === "PATCH"
        ? ((body as { notify?: string })?.notify ?? "all")
        : "all";
    return NativeResponse.json({ botId, notify });
  }
  if (method === "POST" && pathname === LINK_CHAT_PATH) {
    const platform = (body as { platform?: string })?.platform ?? "slack";
    return NativeResponse.json({
      platform,
      code: "6f2b9d4e-1a3c-4e5f-8b7a-0c9d2e1f3a4b",
      command: "link 6f2b9d4e-1a3c-4e5f-8b7a-0c9d2e1f3a4b",
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
  }
  if (method === "POST" && pathname === VERIFY_PHONE_PATH)
    return NativeResponse.json({
      verificationId: "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
  if (method === "POST" && pathname === CONFIRM_PHONE_PATH)
    return NativeResponse.json(
      {
        destination: {
          id: "s1",
          transport: "sms",
          conversationId: "c1",
          botId: "b1",
          address: "+14155550123",
          optedOutAt: null,
          createdAt: "2026-11-01T09:00:00.000Z",
        },
      },
      { status: 201 },
    );
  if (method === "POST" && pathname === CONNECT_TELEGRAM_PATH)
    return NativeResponse.json({
      botUsername: "openbot_test_bot",
      code: "6f2b9d4e-1a3c-4e5f-8b7a-0c9d2e1f3a4b",
      command: "link 6f2b9d4e-1a3c-4e5f-8b7a-0c9d2e1f3a4b",
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
  if (
    method === "DELETE" &&
    (pathname.startsWith(`${DESTINATIONS_PATH}/`) ||
      pathname.startsWith(`${DEVICES_PATH}/`))
  )
    return new NativeResponse(null, { status: 204 });
  return undefined;
}
