/**
 * The web push API as the server answers it, for a test that serves it by hand: the key a browser
 * subscribes with, and saving and removing one browser's subscription
 * (api/openapi/web-push.yaml).
 */

/**
 * The Response a real `fetch` returns. Read before any test registers happy-dom, as each test file
 * that needs it does at its top.
 */
const NativeResponse = globalThis.Response;

const ORGANIZATION = "/api/v2/organizations/default";
export const WEB_PUSH_KEY_PATH = `${ORGANIZATION}/web-push-key`;
export const WEB_PUSH_SUBSCRIPTIONS_PATH = `${ORGANIZATION}/people/me/web-push-subscriptions`;

/** The spec's own example key: a P-256 point, URL-safe base64 without padding. */
export const WEB_PUSH_KEY =
  "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

export function webPushSubscriptionPath(id: string): string {
  return `${WEB_PUSH_SUBSCRIPTIONS_PATH}/${encodeURIComponent(id)}`;
}

/** What the server holds: each browser's saved subscription, by the id the app made for it. */
export type WebPushServer = {
  saved: Map<string, { endpoint: string; keys: Record<string, string> }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function problem(status: number, code: string, detail: string): Response {
  return NativeResponse.json(
    {
      type: `https://open.bot/errors/${code.toLowerCase().replaceAll("_", "-")}`,
      title: detail,
      status,
      detail,
      code,
      category: status === 404 ? "not_found" : "validation",
      retryable: false,
      requestId: "req_test",
      traceId: "trace_test",
    },
    {
      status,
      headers: { "content-type": "application/problem+json" },
    },
  );
}

/**
 * The API's answer to a web push request, keeping what is saved in `server`; undefined for any other
 * request. A save takes only what the spec allows (an `https://` address and the two keys, nothing
 * else) and a write without an Idempotency-Key is refused, as the server does.
 */
export function webPushResponse(
  method: string,
  path: string,
  server: WebPushServer,
  body: unknown,
  headers: Headers,
): Response | undefined {
  const pathname = path.split("?")[0] ?? "";
  if (method === "GET" && pathname === WEB_PUSH_KEY_PATH)
    return NativeResponse.json({ publicKey: WEB_PUSH_KEY });
  if (!pathname.startsWith(`${WEB_PUSH_SUBSCRIPTIONS_PATH}/`)) return undefined;
  const id = decodeURIComponent(
    pathname.slice(WEB_PUSH_SUBSCRIPTIONS_PATH.length + 1),
  );
  if (!UUID.test(id))
    return problem(400, "VALIDATION_ERROR", "Request validation failed.");
  if (!headers.get("idempotency-key"))
    return problem(400, "VALIDATION_ERROR", "Request validation failed.");
  if (method === "PUT") {
    const save = body as {
      endpoint?: unknown;
      keys?: { p256dh?: unknown; auth?: unknown };
    } | null;
    const fields = save ? Object.keys(save).sort().join(",") : "";
    const keyFields = save?.keys ? Object.keys(save.keys).sort().join(",") : "";
    if (
      fields !== "endpoint,keys" ||
      keyFields !== "auth,p256dh" ||
      typeof save?.endpoint !== "string" ||
      !save.endpoint.startsWith("https://") ||
      typeof save.keys?.p256dh !== "string" ||
      typeof save.keys?.auth !== "string"
    )
      return problem(400, "VALIDATION_ERROR", "Request validation failed.");
    server.saved.set(id, {
      endpoint: save.endpoint,
      keys: { p256dh: save.keys.p256dh, auth: save.keys.auth },
    });
    return NativeResponse.json({
      webPushSubscription: { id, createdAt: "2026-11-26T18:04:12.000Z" },
    });
  }
  if (method === "DELETE") {
    if (!server.saved.delete(id))
      return problem(
        404,
        "WEB_PUSH_SUBSCRIPTION_NOT_FOUND",
        "Subscription not found.",
      );
    return new NativeResponse(null, { status: 204 });
  }
  return undefined;
}
