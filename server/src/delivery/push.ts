import { DELIVERY_REQUEST_TIMEOUT_MS } from "../timeouts";
import {
  type DeliveryKind,
  DeliveryProviderError,
  type ProviderFetch,
  providerJson,
} from "./types";

/**
 * What a tap on a notification opens in the mobile app, and the data it carries there. A reply opens
 * its conversation and a question or an approval the inbox, both by conversation. A ping opens the
 * person's Needs you list: it folds several Bots' items, so no one conversation is where it leads.
 */
function pushData(input: {
  channelId: string;
  kind: DeliveryKind;
  requestId?: string | null;
}): Record<string, string> {
  if (input.kind === "attention")
    return { kind: input.kind, url: "openbotmobile://needs-you" };
  const path = input.kind === "reply" ? "conversation" : "approvals";
  const query = new URLSearchParams({
    channelId: input.channelId,
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
  return {
    channelId: input.channelId,
    kind: input.kind,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    url: `openbotmobile://${path}?${query}`,
  };
}
export function createExpoPushTransport(
  config: {
    accessToken?: string;
    projectId?: string;
    fetch?: ProviderFetch;
  } = {},
) {
  const wire = config.fetch ?? fetch;
  async function call(method: "send" | "getReceipts", body: unknown) {
    let response: Response;
    try {
      response = await wire(`https://exp.host/--/api/v2/push/${method}`, {
        method: "POST",
        signal: AbortSignal.timeout(DELIVERY_REQUEST_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          ...(config.accessToken
            ? { authorization: `Bearer ${config.accessToken}` }
            : {}),
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new DeliveryProviderError("Expo", "network_error", true);
    }
    return providerJson("Expo", response);
  }
  return {
    async send(input: {
      token: string;
      title: string;
      body: string;
      channelId: string;
      kind: DeliveryKind;
      requestId?: string | null;
    }) {
      const result = await call("send", {
        to: input.token,
        title: input.title,
        body: Array.from(input.body).slice(0, 200).join(""),
        sound: "default",
        data: pushData(input),
      });
      const ticket = result.data;
      if (
        !ticket ||
        typeof ticket !== "object" ||
        Array.isArray(ticket) ||
        !("status" in ticket)
      )
        throw new DeliveryProviderError("Expo", "invalid_ticket");
      if (ticket.status === "error")
        throw new DeliveryProviderError(
          "Expo",
          "details" in ticket &&
            ticket.details &&
            typeof ticket.details === "object" &&
            "error" in ticket.details
            ? String(ticket.details.error)
            : "push_error",
        );
      if (!("id" in ticket) || typeof ticket.id !== "string")
        throw new DeliveryProviderError("Expo", "missing_ticket");
      return { id: ticket.id, status: "accepted" as const };
    },
    async receipt(id: string): Promise<{
      status: "delivered" | "failed" | "pending";
      error?: string;
      revokeDevice?: boolean;
    }> {
      const result = await call("getReceipts", { ids: [id] });
      const data = result.data;
      if (!data || typeof data !== "object" || !(id in data))
        return { status: "pending" };
      const receipt = (data as Record<string, unknown>)[id];
      if (!receipt || typeof receipt !== "object" || !("status" in receipt))
        throw new DeliveryProviderError("Expo", "invalid_receipt");
      if (receipt.status === "ok") return { status: "delivered" };
      const error =
        "details" in receipt &&
        receipt.details &&
        typeof receipt.details === "object" &&
        "error" in receipt.details
          ? String(receipt.details.error)
          : "receipt_error";
      return {
        status: "failed",
        error,
        revokeDevice: error === "DeviceNotRegistered",
      };
    },
  };
}
export type ExpoPushTransport = ReturnType<typeof createExpoPushTransport>;
