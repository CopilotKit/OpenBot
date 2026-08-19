/**
 * The public door. A separate Bun server, on a separate port, that serves exactly two things.
 *
 * Everything else in this product is behind a session. This is the one surface meant to be reachable
 * by a third party, and the way to keep the rest of the API away from it is for the rest of the API
 * not to be on it. Not a route with a different guard, not a middleware that turns authentication
 * off for one path: a different listener, so that a mistake in this file cannot expose
 * `/api/admin/credentials`, because that route does not exist here to be reached.
 *
 * It answers `/health` and `/hooks/:endpointId` and it 404s everything else, including anything that
 * looks like an API path. That is worth being deliberate about: an operator putting this behind a
 * reverse proxy or a tunnel is exposing this port on purpose, and what they are exposing should be
 * describable in one sentence.
 *
 * It binds to 127.0.0.1 unless told otherwise, the same posture as the rest of the product. A
 * webhook endpoint that is reachable from the internet the moment somebody sets a variable is a
 * decision, and it should be one somebody made rather than one they inherited.
 *
 * What it does NOT do is run the work. It decides, records and hands off; the run happens on the
 * scheduler's side of the fence. A request from a stranger holding a socket open for the length of a
 * browsing session is a way to be kept waiting by somebody else's timeout.
 */
import { serve } from "bun";
import type { RoutineStore } from "./store";
import { decideWebhookDelivery, eventTypeOf } from "./webhooks";

/** The most a delivery body may be. Somebody else's payload, so it needs a stated ceiling. */
export const MAX_DELIVERY_BYTES = 1_000_000;

export type WebhookReceiverOptions = {
  port: number;
  /** 127.0.0.1 unless a deployment says otherwise, on purpose. */
  hostname?: string;
  store: RoutineStore;
  /**
   * Start the work this delivery asks for.
   *
   * Handed the trigger and the delivery, not a finished prompt. Which instruction the Bot receives
   * depends on whether the trigger names a routine, and looking that routine up is a database read
   * that belongs on the side of the fence that already owns routines. This file's job is to decide
   * whether a request is allowed in.
   *
   * Returns whether anything was started, so the sender can be told "accepted" or "that routine is
   * already going" rather than a bare 202 that means neither.
   */
  dispatch: (work: {
    triggerId: string;
    routineId: string | null;
    agentId: string | null;
    prompt: string | null;
    ownerUserId: string;
    /** The delivery as it arrived, for the prompt the Bot is given. */
    body: unknown;
    eventType: string | null;
  }) => Promise<boolean>;
  log?: (entry: Record<string, unknown>) => void;
};

export type WebhookReceiver = {
  port: number;
  hostname: string;
  stop: () => Promise<void>;
};

export function startWebhookReceiver(
  options: WebhookReceiverOptions,
): WebhookReceiver {
  const hostname = options.hostname ?? "127.0.0.1";
  const log = options.log ?? ((entry) => console.info(JSON.stringify(entry)));

  const server = serve({
    port: options.port,
    hostname,
    fetch: (request) => handle(request, options, log),
  });

  log({
    type: "routine-webhook-receiver",
    url: `http://${hostname}:${server.port}`,
    serves: "/health and /hooks/:endpointId, and nothing else",
  });

  return {
    // The port the listener actually took. Bun types it as optional because port 0 asks the kernel
    // to pick one; it has picked by the time `serve` returns, and reporting the requested port
    // instead would be a lie in exactly the case somebody would be reading this to find out.
    port: server.port ?? options.port,
    hostname,
    stop: async () => {
      await server.stop(true);
    },
  };
}

/**
 * One request, from the top.
 *
 * Written as a flat sequence rather than as a router, because the routing table is two entries and a
 * reader of this file should be able to see the entire public surface without following anything.
 */
async function handle(
  request: Request,
  options: WebhookReceiverOptions,
  log: (entry: Record<string, unknown>) => void,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return Response.json({ status: "ok" });
  }

  const endpointId = url.pathname.startsWith("/hooks/")
    ? decodeURIComponent(url.pathname.slice("/hooks/".length))
    : null;
  // Anything with a further path segment is not an endpoint id. Rejected rather than trimmed, so
  // `/hooks/abc/../../whatever` cannot become a lookup for something else.
  if (!endpointId || endpointId.includes("/")) {
    return new Response("Not found.", { status: 404 });
  }
  if (request.method !== "POST") {
    return new Response("Deliveries are POSTed.", { status: 405 });
  }

  const raw = await request.text().catch(() => "");
  if (raw.length > MAX_DELIVERY_BYTES) {
    return Response.json(
      { error: "That delivery is larger than this endpoint accepts." },
      { status: 413 },
    );
  }
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    // Kept as text rather than refused. Plenty of systems send form encodings or plain strings, and
    // the Bot can read what arrived either way; what matters is that the shape is not guessed at.
    body = { text: raw };
  }

  const trigger = await options.store
    .triggerByEndpoint(endpointId)
    .catch(() => null);
  const eventType = eventTypeOf(request.headers, body);
  const decision = decideWebhookDelivery(
    trigger
      ? {
          enabled: trigger.enabled,
          verificationPending: trigger.verificationPending,
          secretHash: trigger.secretHash,
          eventTypes: trigger.eventTypes,
        }
      : null,
    { authorization: request.headers.get("authorization"), eventType },
  );

  if (decision.outcome === "reject") {
    /*
     * Recorded, including the ones that were nothing. An endpoint on the public internet is probed,
     * and "this endpoint was called forty times last night with the wrong secret" is exactly the
     * sort of thing the trail exists to be able to say. The endpoint id is recorded; the secret that
     * was presented is not, because a failed guess is still somebody's secret somewhere.
     */
    await options.store
      .recordDeliveryEvent({
        endpointId,
        ...(trigger ? { triggerId: trigger.id } : {}),
        accepted: false,
        reason: decision.reason,
        eventType,
      })
      .catch(() => undefined);
    return Response.json(
      { error: decision.reason },
      { status: decision.status },
    );
  }

  // Past the secret, so this is a real caller and the count is worth keeping either way.
  await options.store
    .recordDelivery({
      id: trigger?.id ?? "",
      body,
      captureSample: decision.outcome === "capture",
    })
    .catch(() => undefined);

  if (decision.outcome === "capture") {
    await options.store
      .recordDeliveryEvent({
        endpointId,
        ...(trigger ? { triggerId: trigger.id } : {}),
        accepted: false,
        reason: decision.reason,
        eventType,
      })
      .catch(() => undefined);
    // 202, not 200. Something was accepted and nothing was done, and the sender is told which in
    // words, because a hook that reports success while the Bot sits idle is how a misconfiguration
    // survives a week.
    return Response.json(
      { status: "captured", detail: decision.reason },
      { status: 202 },
    );
  }

  if (!trigger) {
    // Unreachable: `decideWebhookDelivery` refuses a null trigger. Stated rather than asserted, so
    // that a future change to the decision cannot silently turn this into a crash on a public port.
    return new Response("Not found.", { status: 404 });
  }

  const started = await options
    .dispatch({
      triggerId: trigger.id,
      routineId: trigger.routineId,
      agentId: trigger.agentId,
      prompt: trigger.prompt,
      ownerUserId: trigger.ownerUserId,
      body,
      eventType,
    })
    .catch((error: unknown) => {
      log({
        type: "routine-webhook-dispatch-failed",
        endpoint: endpointId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    });

  await options.store
    .recordDeliveryEvent({
      endpointId,
      triggerId: trigger.id,
      accepted: started,
      reason: started
        ? "The delivery started a run."
        : "The delivery arrived while a run of the same routine was already going, so nothing was started.",
      eventType,
    })
    .catch(() => undefined);

  // 409 rather than an error, because nothing is wrong: the work this delivery asks for is already
  // being done, and a sender that retries on a 5xx should not be encouraged to.
  return started
    ? Response.json({ status: "started" }, { status: 202 })
    : Response.json(
        { status: "busy", detail: "A run of this routine is already going." },
        { status: 409 },
      );
}
