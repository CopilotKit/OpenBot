import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createGithubResponsibilityRoutes } from "../src/responsibilities/github";
import type { ResponsibilityEvent } from "../src/responsibilities/types";

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
  expect(events[0]?.externalId).toBe("delivery-1");
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
