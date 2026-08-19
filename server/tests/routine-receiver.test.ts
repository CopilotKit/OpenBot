import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  MAX_DELIVERY_BYTES,
  startWebhookReceiver,
  type WebhookReceiver,
} from "../src/routines/receiver";
import type {
  RoutineStore,
  WebhookTriggerWithSecret,
} from "../src/routines/store";
import { hashWebhookSecret } from "../src/routines/webhooks";

/**
 * The public surface, driven over a real socket.
 *
 * webhook-trigger.test.ts owns the decision — whether a delivery may run anything — and this owns
 * everything around it: what this port answers, what it refuses to answer, and what it will read
 * before it has any idea who is calling. Those are separate concerns and the second one is the
 * dangerous one, because it happens before authentication and therefore for everybody, including
 * whoever is scanning the internet for open ports this afternoon.
 *
 * A real listener rather than a call into `handle`, because two of the properties below are not
 * properties of the handler at all. The body ceiling is enforced by the server, before the handler
 * exists to be called; and the 404 for everything that is not one of the two paths is worth asserting
 * against something that has actually parsed a URL, since the whole design of this port is that a
 * mistake in it cannot reach the rest of the API.
 */

const secret = "obw_test_secret_value";

const trigger: WebhookTriggerWithSecret = {
  id: "trigger-1",
  endpointId: "endpoint-1",
  name: "Build finished",
  ownerUserId: "someone",
  routineId: "routine-1",
  agentId: null,
  prompt: null,
  enabled: true,
  verificationPending: false,
  verifiedAt: new Date(0).toISOString(),
  sample: null,
  eventTypes: [],
  deliveryCount: 0,
  lastReceivedAt: null,
  createdAt: new Date(0).toISOString(),
  secretHash: hashWebhookSecret(secret),
};

/** What the receiver asks of the store, and nothing else it happens to have. */
function fakeStore(overrides: Partial<WebhookTriggerWithSecret> = {}) {
  const deliveries: { id: string; captureSample: boolean }[] = [];
  const events: { outcome: string; endpointId: string }[] = [];
  const store = {
    triggerByEndpoint: async (endpointId: string) =>
      endpointId === trigger.endpointId ? { ...trigger, ...overrides } : null,
    recordDelivery: async (input: { id: string; captureSample: boolean }) => {
      deliveries.push({ id: input.id, captureSample: input.captureSample });
    },
    recordDeliveryEvent: async (input: {
      outcome: string;
      endpointId: string;
    }) => {
      events.push({ outcome: input.outcome, endpointId: input.endpointId });
    },
  } as unknown as RoutineStore;
  return { store, deliveries, events };
}

let receiver: WebhookReceiver;
let dispatched: { triggerId: string; body: unknown }[] = [];
let started = true;
const state = fakeStore();

beforeAll(() => {
  receiver = startWebhookReceiver({
    // The kernel picks, so this suite cannot collide with a deployment or with another test file.
    port: 0,
    store: state.store,
    dispatch: async (work) => {
      dispatched.push({ triggerId: work.triggerId, body: work.body });
      return started;
    },
    log: () => undefined,
  });
});

afterAll(async () => {
  await receiver.stop();
});

const url = (path: string) =>
  `http://${receiver.hostname}:${receiver.port}${path}`;

const post = (path: string, init: RequestInit = {}) =>
  fetch(url(path), { method: "POST", ...init });

describe("what this port serves", () => {
  test("answers health, and nothing else outside /hooks", async () => {
    expect((await fetch(url("/health"))).status).toBe(200);

    // The point of a separate listener: these routes are not merely guarded here, they are absent.
    for (const path of ["/", "/api/admin/credentials", "/api/routines"]) {
      expect((await fetch(url(path))).status).toBe(404);
    }
  });

  test("a further path segment is not an endpoint id", async () => {
    // Refused rather than trimmed, so `/hooks/abc/../../whatever` cannot become a lookup for
    // something else.
    expect((await post("/hooks/endpoint-1/extra")).status).toBe(404);
    expect((await post("/hooks/endpoint-1/../other")).status).toBe(404);
    expect((await post("/hooks/")).status).toBe(404);
  });

  test("deliveries are POSTed, and a GET is told so", async () => {
    expect((await fetch(url("/hooks/endpoint-1"))).status).toBe(405);
  });
});

/*
 * The check that happens before anybody has proved anything. Everything else on this port is behind
 * a secret; this is not, so it is the one thing a stranger can spend this deployment's memory on.
 */
describe("the delivery ceiling", () => {
  test("a body larger than the ceiling is refused", async () => {
    const response = await post("/hooks/endpoint-1", {
      body: "a".repeat(MAX_DELIVERY_BYTES + 1_000),
    });
    expect(response.status).toBe(413);
  });

  test("an unauthenticated caller cannot make this port hold megabytes", async () => {
    // No such endpoint, no secret, nothing: the request is refused on its size before the lookup
    // that would have refused it anyway. The failure this prevents is a handful of concurrent posts
    // of a hundred megabytes each, none of which has presented a secret.
    const response = await post("/hooks/whatever", {
      body: "a".repeat(4 * MAX_DELIVERY_BYTES),
    });
    expect(response.status).toBe(413);
  });

  test("the ceiling is bytes, not characters", async () => {
    /*
     * `"😀"` is one character to JavaScript's `length` and four bytes on the wire. A ceiling measured
     * in string length is one an emoji walks straight through, which is not a hypothetical: a
     * delivery is somebody else's payload and plenty of them are full of them.
     */
    const emoji = "😀".repeat(Math.ceil(MAX_DELIVERY_BYTES / 3));
    expect(emoji.length).toBeLessThan(MAX_DELIVERY_BYTES);
    expect((await post("/hooks/endpoint-1", { body: emoji })).status).toBe(413);
  });

  test("an ordinary delivery is not refused", async () => {
    const response = await post("/hooks/endpoint-1", {
      headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({ event: "build.finished" }),
    });
    expect(response.status).toBe(202);
  });
});

describe("what a sender is told", () => {
  test("a delivery with no secret is refused, and says nothing about the endpoint", async () => {
    const response = await post("/hooks/endpoint-1", {
      body: JSON.stringify({ event: "build.finished" }),
    });
    expect(response.status).toBe(401);
  });

  test("an endpoint nobody is listening on is a 404, not a 403", async () => {
    // 403 would confirm that this endpoint id exists and is merely switched off, which is more than
    // an unauthenticated caller has earned.
    const response = await post("/hooks/nothing-here", {
      headers: { authorization: `Bearer ${secret}` },
      body: "{}",
    });
    expect(response.status).toBe(404);
  });

  test("a delivery that started a run is accepted, and one that could not is not an error", async () => {
    dispatched = [];
    started = true;
    const accepted = await post("/hooks/endpoint-1", {
      headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({ branch: "main" }),
    });
    expect(accepted.status).toBe(202);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.body).toEqual({ branch: "main" });

    started = false;
    const busy = await post("/hooks/endpoint-1", {
      headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({ branch: "main" }),
    });
    // 409 rather than a 5xx, because nothing is wrong: the work is already being done, and a sender
    // that retries on a server error should not be encouraged to.
    expect(busy.status).toBe(409);
    started = true;
  });

  test("a body that is not JSON is kept as text rather than refused", async () => {
    dispatched = [];
    const response = await post("/hooks/endpoint-1", {
      headers: { authorization: `Bearer ${secret}` },
      body: "branch=main&status=green",
    });
    expect(response.status).toBe(202);
    expect(dispatched[0]?.body).toEqual({ text: "branch=main&status=green" });
  });
});

/*
 * The gate the whole feature is built around: a new trigger keeps a delivery and runs nothing until
 * a person has looked at what actually arrived.
 */
describe("a trigger nobody has confirmed yet", () => {
  test("keeps the delivery, starts nothing, and says which", async () => {
    const pending = fakeStore();
    const listener = startWebhookReceiver({
      port: 0,
      store: {
        ...pending.store,
        triggerByEndpoint: async () => ({
          ...trigger,
          verificationPending: true,
        }),
      } as unknown as RoutineStore,
      dispatch: async () => {
        throw new Error("an unconfirmed trigger must not reach the runner");
      },
      log: () => undefined,
    });

    const response = await fetch(
      `http://${listener.hostname}:${listener.port}/hooks/endpoint-1`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
        body: JSON.stringify({ event: "build.finished" }),
      },
    );

    // 202 with words, not 200. A hook that reports plain success while the Bot sits idle is how a
    // misconfiguration survives a week.
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "captured" });
    expect(pending.deliveries).toEqual([
      { id: trigger.id, captureSample: true },
    ]);
    // Its own outcome in the trail. A person looking for their sample must not read "refused".
    expect(pending.events.map((entry) => entry.outcome)).toEqual(["captured"]);

    await listener.stop();
  });
});
