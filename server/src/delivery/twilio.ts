import { validateRequest } from "twilio";
import {
  DeliveryProviderError,
  type ProviderFetch,
  providerJson,
} from "./types";
export function verifyTwilioRequest(input: {
  url: string;
  params: URLSearchParams;
  signature: string | null;
  token: string;
}): boolean {
  if (!input.signature || !/^[A-Za-z0-9+/]{27}=$/.test(input.signature))
    return false;
  const keys = [...input.params.keys()];
  if (new Set(keys).size !== keys.length) return false;
  return validateRequest(
    input.token,
    input.signature,
    input.url,
    Object.fromEntries(input.params),
  );
}
/**
 * Twilio's default Advanced Opt-Out keywords. Twilio itself replies to them and blocks sends to an
 * opted-out number, so the application records the state and stays quiet (no second reply).
 * https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out
 */
const OPT_OUT = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "REVOKE",
  "OPTOUT",
]);
const OPT_IN = new Set(["START", "YES", "UNSTOP"]);
const HELP = new Set(["HELP", "INFO"]);
/** `OptOutType` when Twilio sent it, otherwise the default keyword the whole body matches. */
export function smsOptKeyword(
  optOutType: string | null,
  body: string | null,
): "STOP" | "START" | "HELP" | null {
  const typed = optOutType?.trim().toUpperCase();
  if (typed === "STOP" || typed === "START" || typed === "HELP") return typed;
  const word = body?.trim().toUpperCase() ?? "";
  if (OPT_OUT.has(word)) return "STOP";
  if (OPT_IN.has(word)) return "START";
  if (HELP.has(word)) return "HELP";
  return null;
}
export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  verifyServiceSid: string;
  from: string;
  webhookUrl: string;
  statusUrl?: string;
  fetch?: ProviderFetch;
};
export function createTwilioTransport(config: TwilioConfig) {
  const wire = config.fetch ?? fetch;
  async function post(url: string, values: Record<string, string>) {
    let response: Response;
    try {
      response = await wire(url, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(values).toString(),
      });
    } catch {
      throw new DeliveryProviderError("Twilio", "network_error", true);
    }
    if (!response.ok && response.status < 500) {
      // Twilio's error body names the refusal; 21610 (opted-out recipient) has to be told apart.
      let code: unknown;
      try {
        code = ((await response.clone().json()) as { code?: unknown }).code;
      } catch {}
      if (
        typeof code === "number" ||
        (typeof code === "string" && /^\d{5}$/.test(code))
      )
        throw new DeliveryProviderError("Twilio", String(code));
    }
    return providerJson("Twilio", response);
  }
  const verifyUrl = `https://verify.twilio.com/v2/Services/${encodeURIComponent(config.verifyServiceSid)}`;
  return {
    config,
    async startVerification(phone: string) {
      const result = await post(`${verifyUrl}/Verifications`, {
        To: phone,
        Channel: "sms",
      });
      if (result.status !== "pending")
        throw new DeliveryProviderError("Twilio", "verification_not_pending");
    },
    async checkVerification(phone: string, code: string) {
      const result = await post(`${verifyUrl}/VerificationCheck`, {
        To: phone,
        Code: code,
      });
      return result.status === "approved" && result.to === phone;
    },
    async send(input: { id: string; address: string; text: string }) {
      const result = await post(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`,
        {
          To: input.address,
          From: config.from,
          Body:
            input.text.length <= 1500
              ? input.text
              : `${input.text.slice(0, 1400)}…\nOpen OpenBot to read the full message.`,
          ...(config.statusUrl ? { StatusCallback: config.statusUrl } : {}),
        },
      );
      if (typeof result.sid !== "string")
        throw new DeliveryProviderError("Twilio", "missing_message_id", true);
      return { id: result.sid, status: "queued" as const };
    },
  };
}
export type TwilioTransport = ReturnType<typeof createTwilioTransport>;
