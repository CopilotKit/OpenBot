/**
 * Inbound email triggers: Amazon SES receipt rule -> SNS topic -> HTTPS subscription to
 * `POST /api/events/email/sns`.
 *
 * WHY THIS ROUTE. It is the one established inbound-mail path that works identically on AWS and on a
 * self-hosted deployment (SES receiving only needs an AWS account and an MX record, not AWS
 * hosting), needs no mailbox credentials, and is authenticated by AWS's own published signature
 * scheme rather than a secret we would have to distribute. OpenBot has no Gmail/Outlook push
 * connector to watch a mailbox with (the Workspace MCP servers are request/response only).
 *
 * Each email trigger gets its own address, `trigger-<triggerId>@<OPENBOT_INBOUND_EMAIL_DOMAIN>`; the
 * receipt rule covers the whole domain and routing happens here by the envelope recipients SES
 * reports. SNS messages are verified per AWS's documented procedure
 * (https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html): the signing
 * certificate is fetched only over HTTPS from an `sns.<region>.amazonaws.com` host, the canonical
 * string is rebuilt from the named fields, SignatureVersion 1 is RSA-SHA1 and 2 is RSA-SHA256, and a
 * message from any topic not in OPENBOT_INBOUND_EMAIL_SNS_TOPIC_ARNS is refused (a valid AWS
 * signature proves AWS sent it, not that it is our topic).
 */
import { createVerify, X509Certificate } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deliverToTrigger, type TriggerIngressDeps } from "./trigger-routes";
import { matchesFilter } from "./triggers";

export type InboundEmailConfig = { domain: string; topicArns: string[] };

/** Read from the environment by the assembly; absent means the email route is not mounted. */
export function inboundEmailConfigFromEnv(
  env: Record<string, string | undefined>,
): InboundEmailConfig | null {
  const domain = env.OPENBOT_INBOUND_EMAIL_DOMAIN?.trim().toLowerCase();
  const topicArns = (env.OPENBOT_INBOUND_EMAIL_SNS_TOPIC_ARNS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return domain && topicArns.length ? { domain, topicArns } : null;
}

export function inboundAddressFor(triggerId: string, domain: string) {
  return `trigger-${triggerId}@${domain}`;
}

export type SnsMessage = {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
};

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
export function isSnsUrl(value: string, pem = false) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      SNS_HOST.test(url.hostname) &&
      !url.username &&
      !url.port &&
      (!pem || url.pathname.endsWith(".pem"))
    );
  } catch {
    return false;
  }
}

/** The canonical string AWS signs: `Name\nValue\n` pairs in byte order of the names it lists. */
export function snsStringToSign(message: SnsMessage): string | null {
  const fields =
    message.Type === "Notification"
      ? [
          "Message",
          "MessageId",
          ...(message.Subject !== undefined ? ["Subject"] : []),
          "Timestamp",
          "TopicArn",
          "Type",
        ]
      : [
          "Message",
          "MessageId",
          "SubscribeURL",
          "Timestamp",
          "Token",
          "TopicArn",
          "Type",
        ];
  let out = "";
  for (const field of fields) {
    const value = (message as Record<string, unknown>)[field];
    if (typeof value !== "string") return null;
    out += `${field}\n${value}\n`;
  }
  return out;
}

export type CertificateFetcher = (url: string) => Promise<string>;
export function createSnsVerifier(fetchCertificate: CertificateFetcher) {
  const cache = new Map<string, Promise<string>>();
  return async function verify(message: SnsMessage): Promise<boolean> {
    if (!isSnsUrl(message.SigningCertURL, true)) return false;
    const algorithm =
      message.SignatureVersion === "1"
        ? "RSA-SHA1"
        : message.SignatureVersion === "2"
          ? "RSA-SHA256"
          : null;
    const canonical = snsStringToSign(message);
    if (!algorithm || !canonical || !message.Signature) return false;
    let pending = cache.get(message.SigningCertURL);
    if (!pending) {
      pending = fetchCertificate(message.SigningCertURL);
      cache.set(message.SigningCertURL, pending);
      pending.catch(() => cache.delete(message.SigningCertURL));
      if (cache.size > 32) cache.delete(cache.keys().next().value ?? "");
    }
    const pem = await pending;
    const certificate = new X509Certificate(pem);
    if (
      !certificate.subjectAltName?.includes("amazonaws.com") &&
      !certificate.subject.includes("amazonaws.com")
    )
      return false;
    const verifier = createVerify(algorithm);
    verifier.update(canonical, "utf8");
    return verifier.verify(certificate.publicKey, message.Signature, "base64");
  };
}

/** HTTPS GET used for the certificate and for confirming the subscription. */
export const fetchText = async (url: string) => {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`SNS request failed with ${response.status}.`);
  return response.text();
};

function unfoldHeaders(block: string) {
  const headers = new Map<string, string>();
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index > 0)
      headers.set(
        line.slice(0, index).trim().toLowerCase(),
        line.slice(index + 1).trim(),
      );
  }
  return headers;
}
function decodeBody(body: string, encoding: string | undefined) {
  const kind = encoding?.toLowerCase();
  if (kind === "base64")
    return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (kind === "quoted-printable")
    return Buffer.from(
      body
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-F]{2})/gi, (_, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        ),
      "latin1",
    ).toString("utf8");
  return body;
}
/** Minimal MIME walk: the first text/plain part, else text/html with tags stripped. */
export function extractEmailText(raw: string, depth = 0): string {
  const split = /\r?\n\r?\n/.exec(raw);
  const headers = unfoldHeaders(split ? raw.slice(0, split.index) : raw);
  const body = split ? raw.slice(split.index + split[0].length) : "";
  const type = headers.get("content-type") ?? "text/plain";
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (/^multipart\//i.test(type) && boundary && depth < 5) {
    const parts = body
      .split(`--${boundary}`)
      .slice(1)
      .filter((part) => !part.startsWith("--"));
    const texts = parts.map((part) => ({
      type:
        unfoldHeaders(
          part.replace(/^\r?\n/, "").split(/\r?\n\r?\n/)[0] ?? "",
        ).get("content-type") ?? "text/plain",
      part: part.replace(/^\r?\n/, ""),
    }));
    const plain = texts.find(
      (part) =>
        /^text\/plain/i.test(part.type) || /^multipart\//i.test(part.type),
    );
    const chosen =
      plain ?? texts.find((part) => /^text\/html/i.test(part.type));
    return chosen ? extractEmailText(chosen.part, depth + 1) : "";
  }
  const decoded = decodeBody(body, headers.get("content-transfer-encoding"));
  return /^text\/html/i.test(type)
    ? decoded
        .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : decoded.trim();
}

function addressOf(value: string | undefined) {
  const match = /<([^>]+)>/.exec(value ?? "");
  return (match?.[1] ?? value ?? "").trim().toLowerCase();
}
export function senderAllowed(sender: string, allowed: string[]) {
  if (allowed.length === 0) return true;
  const domain = sender.split("@")[1] ?? "";
  return allowed.some((entry) => {
    const wanted = entry.toLowerCase();
    return wanted.includes("@") ? wanted === sender : wanted === domain;
  });
}

type SesNotification = {
  notificationType?: string;
  content?: string;
  mail?: {
    messageId?: string;
    source?: string;
    timestamp?: string;
    destination?: string[];
    commonHeaders?: {
      from?: string[];
      to?: string[];
      subject?: string;
      date?: string;
    };
  };
  receipt?: {
    recipients?: string[];
    spamVerdict?: { status?: string };
    virusVerdict?: { status?: string };
    spfVerdict?: { status?: string };
    dkimVerdict?: { status?: string };
    dmarcVerdict?: { status?: string };
  };
};

export function createEmailTriggerRoutes(
  deps: TriggerIngressDeps & {
    config: InboundEmailConfig;
    verify: (message: SnsMessage) => Promise<boolean>;
    confirmSubscription: (url: string) => Promise<unknown>;
  },
) {
  const routes = new Hono();
  routes.use(
    "*",
    // SNS messages are at most 256 KiB; SES's SNS action carries mail up to 150 KB.
    bodyLimit({
      maxSize: 300 * 1024,
      onError: (context) => context.json({ error: "Too large." }, 413),
    }),
  );
  routes.onError((error, context) => {
    console.error(
      JSON.stringify({
        type: "email-trigger-error",
        errorType: error.name,
        error: error.message,
      }),
    );
    return context.json(
      { error: "The email could not be accepted. Try again." },
      503,
    );
  });
  routes.post("/sns", async (context) => {
    let message: SnsMessage;
    try {
      message = JSON.parse(await context.req.text()) as SnsMessage;
    } catch {
      return context.json({ error: "Not an SNS message." }, 400);
    }
    if (
      !message ||
      typeof message !== "object" ||
      typeof message.TopicArn !== "string"
    )
      return context.json({ error: "Not an SNS message." }, 400);
    if (!deps.config.topicArns.includes(message.TopicArn))
      return context.json({ error: "Unexpected SNS topic." }, 403);
    if (!(await deps.verify(message)))
      return context.json({ error: "Invalid SNS signature." }, 401);
    if (message.Type === "SubscriptionConfirmation") {
      if (!message.SubscribeURL || !isSnsUrl(message.SubscribeURL))
        return context.json({ error: "Unexpected SubscribeURL." }, 400);
      await deps.confirmSubscription(message.SubscribeURL);
      return context.json({ confirmed: true });
    }
    if (message.Type !== "Notification")
      return context.json({ accepted: true, queued: false });
    let notification: SesNotification;
    try {
      notification = JSON.parse(message.Message) as SesNotification;
    } catch {
      return context.json({
        accepted: true,
        queued: false,
        reason: "not an SES notification",
      });
    }
    const mail = notification.mail;
    const receipt = notification.receipt;
    if (notification.notificationType !== "Received" || !mail?.messageId)
      return context.json({
        accepted: true,
        queued: false,
        reason: "not a received email",
      });
    if (
      receipt?.virusVerdict?.status === "FAIL" ||
      receipt?.spamVerdict?.status === "FAIL"
    )
      return context.json({
        accepted: true,
        queued: false,
        reason: "spam or virus",
      });
    const pattern = new RegExp(
      `^trigger-([0-9a-f-]{36})@${deps.config.domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "i",
    );
    const triggerIds = [
      ...new Set(
        (receipt?.recipients ?? [])
          .map((recipient) =>
            pattern.exec(recipient.trim())?.[1]?.toLowerCase(),
          )
          .filter((id): id is string => !!id),
      ),
    ].slice(0, 10);
    const from = addressOf(mail.commonHeaders?.from?.[0] ?? mail.source);
    const authenticated =
      receipt?.dmarcVerdict?.status === "PASS" ||
      receipt?.dkimVerdict?.status === "PASS";
    const payload = {
      from,
      to: mail.commonHeaders?.to ?? mail.destination ?? [],
      subject: mail.commonHeaders?.subject ?? "",
      date: mail.commonHeaders?.date ?? mail.timestamp ?? "",
      messageId: mail.messageId,
      senderAuthenticated: authenticated,
      text: Array.from(extractEmailText(notification.content ?? ""))
        .slice(0, 16_000)
        .join(""),
    };
    const results = [];
    for (const id of triggerIds) {
      const trigger = await deps.directory.resolve(id);
      if (trigger?.config.kind !== "email") continue;
      const config = trigger.config;
      const allowed =
        config.allowedSenders.length === 0 ||
        (authenticated && senderAllowed(from, config.allowedSenders));
      results.push(
        await deliverToTrigger(
          deps,
          trigger,
          { deliveryId: mail.messageId, type: "received", payload },
          allowed && matchesFilter(config.filter, "received", payload),
        ),
      );
    }
    // SNS retries anything but 2xx, so an unrouted or filtered mail is still acknowledged.
    return context.json({ accepted: true, deliveries: results.length });
  });
  return routes;
}
