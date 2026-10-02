export type DeliveryScope = {
  ownerUserId: string;
  channelId: string;
  agentId: string;
  threadId: string;
};
/** Chat platforms reached through the OpenTag pairing (Channels SDK front for Slack and Teams). */
export type ChatTransport = "slack" | "teams";
export type BindingTransport = ChatTransport | "sms";
export type DeliveryBinding = DeliveryScope & {
  id: string;
  transport: BindingTransport;
  identity: string;
  realm: string;
  address: string;
  enabled: boolean;
  mentionId?: string | null;
  /** SMS only: the recipient replied STOP. Outbound is recorded `opted_out`, never sent. */
  optedOutAt?: Date | null;
};
export type PushDevice = {
  id: string;
  ownerUserId: string;
  token: string;
  projectId: string;
  platform: "ios" | "android";
  enabled: boolean;
};
export type DeliveryState =
  | "queued"
  | "running"
  | "accepted"
  | "sent"
  | "delivered"
  | "failed"
  | "unknown"
  /** The SMS recipient replied STOP (Twilio Advanced Opt-Out); nothing was sent. */
  | "opted_out";
export type DeliveryInbox = DeliveryScope & {
  id: string;
  bindingId: string | null;
  source: BindingTransport | "native";
  externalId: string;
  text: string;
  state: DeliveryState;
  error: string | null;
};
export type DeliveryOutbox = DeliveryScope & {
  id: string;
  bindingId: string | null;
  deviceId: string | null;
  transport: BindingTransport | "push";
  text: string;
  kind: "reply" | "question" | "approval";
  requestId: string | null;
  state: DeliveryState;
  providerId: string | null;
  error: string | null;
};
export type ProviderFetch = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
/** The Bot a message speaks for, so a chat surface can post under that Bot's own name. */
export type DeliverySender = {
  agentId: string;
  name: string;
  avatarSeed?: string;
};
export type TextTransport = {
  send(input: {
    id: string;
    address: string;
    text: string;
    transport?: BindingTransport;
    sender?: DeliverySender;
  }): Promise<{ id: string; status: "queued" | "sent" }>;
};
export class DeliveryRefusedError extends Error {
  override name = "DeliveryRefusedError";
}
export class DeliveryNotFoundError extends Error {
  override name = "DeliveryNotFoundError";
}
export class DeliveryProviderError extends Error {
  override name = "DeliveryProviderError";
  constructor(
    readonly provider: string,
    readonly code: string,
    readonly uncertain = false,
  ) {
    super(`${provider} delivery failed (${code}).`);
  }
}
export async function providerJson(
  provider: string,
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.ok)
    throw new DeliveryProviderError(
      provider,
      `HTTP_${response.status}`,
      response.status >= 500,
    );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DeliveryProviderError(provider, "invalid_response", true);
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new DeliveryProviderError(provider, "invalid_response", true);
  return body as Record<string, unknown>;
}
