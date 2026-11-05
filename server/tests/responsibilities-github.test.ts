import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createGithubResponsibilityRoutes } from "../src/responsibilities/github";
import {
  type ResponsibilityEvent,
  responsibilityEventSchema,
} from "../src/responsibilities/types";

const secret = "fixture-only-github-secret";
function request(
  body: string,
  signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
) {
  return new Request("https://openbot.test/binding-1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": signature,
    },
    body,
  });
}
function fixture() {
  const events: ResponsibilityEvent[] = [];
  const routes = createGithubResponsibilityRoutes({
    async bindingFor(id) {
      return id === "binding-1"
        ? { ownerUserId: "owner-1", repository: "openbot/demo", secret }
        : null;
    },
    async ingest(event) {
      events.push(event);
      return { eventId: "event-1", duplicate: false, runIds: ["run-1"] };
    },
  });
  return { routes, events };
}

test("signed GitHub event binds actor from owned repository registration", async () => {
  const { routes, events } = fixture();
  const response = await routes.fetch(
    request(
      JSON.stringify({
        action: "opened",
        ownerUserId: "attacker",
        repository: { full_name: "openbot/demo" },
        issue: { number: 6 },
      }),
    ),
  );
  expect(response.status).toBe(202);
  expect(events[0]?.ownerUserId).toBe("owner-1");
  expect(events[0]?.type).toBe("issues.opened");
  expect(events[0]?.externalId).toMatch(/^body-[0-9a-f]{64}$/);
});
test("wrong signature cannot enqueue GitHub work", async () => {
  const { routes, events } = fixture();
  expect(
    (
      await routes.fetch(
        request(
          JSON.stringify({ repository: { full_name: "openbot/demo" } }),
          "sha256=0000",
        ),
      )
    ).status,
  ).toBe(401);
  expect(events).toHaveLength(0);
});
test("valid signature for another repository cannot route to bound owner", async () => {
  const { routes, events } = fixture();
  expect(
    (
      await routes.fetch(
        request(JSON.stringify({ repository: { full_name: "other/repo" } })),
      )
    ).status,
  ).toBe(403);
  expect(events).toHaveLength(0);
});
test("the same signed event replayed with a fresh X-GitHub-Delivery dedupes", async () => {
  const { routes, events } = fixture();
  const body = JSON.stringify({
    action: "opened",
    repository: { full_name: "openbot/demo" },
  });
  for (const delivery of ["delivery-1", "delivery-2"]) {
    const replay = request(body);
    replay.headers.set("x-github-delivery", delivery);
    expect((await routes.fetch(replay)).status).toBe(202);
  }
  expect(events).toHaveLength(2);
  expect(events[0]?.externalId).toBe(events[1]?.externalId as string);
});
test("a pull request event larger than 32 KiB is accepted and fitted to the ledger cap", async () => {
  const { routes, events } = fixture();
  // A real `pull_request` delivery for an OpenBot PR is 26–57 KB: the PR object alone repeats the
  // repository under `head` and `base`. Before, every one over 32 KiB was answered 503.
  const body = JSON.stringify({
    action: "synchronize",
    number: 949,
    pull_request: { title: "A change", body: "x".repeat(40_000) },
    repository: { full_name: "openbot/demo" },
  });
  expect(body.length).toBeGreaterThan(32_768);
  const delivery = request(body);
  delivery.headers.set("x-github-event", "pull_request");
  const response = await routes.fetch(delivery);
  expect(response.status).toBe(202);
  const event = events[0];
  expect(event?.type).toBe("pull_request.synchronize");
  expect(event?.payload).toMatchObject({ truncated: true, number: 949 });
  // What the Bot is handed still names the pull request.
  expect(String(event?.payload.excerpt)).toContain('"title":"A change"');
  // The engine refuses a payload over 32 KiB; what the route hands it must pass that check.
  expect(responsibilityEventSchema.safeParse(event).success).toBe(true);
});
test("a body over the route limit is refused as too large, not as an outage", async () => {
  const { routes, events } = fixture();
  const body = JSON.stringify({
    repository: { full_name: "openbot/demo" },
    pull_request: { body: "x".repeat(300 * 1024) },
  });
  expect((await routes.fetch(request(body))).status).toBe(413);
  expect(events).toHaveLength(0);
});
test("a pull request event under 32 KiB is handed on whole", async () => {
  const { routes, events } = fixture();
  const payload = {
    action: "opened",
    number: 7,
    pull_request: { title: "Small", body: "x".repeat(20_000) },
    repository: { full_name: "openbot/demo" },
  };
  expect((await routes.fetch(request(JSON.stringify(payload)))).status).toBe(
    202,
  );
  expect(events[0]?.payload).toEqual(payload);
});
