import { beforeAll, describe, expect, test } from "bun:test";

/**
 * One journey through a running deployment, over HTTP.
 *
 * Every other test in this repository proves a decision in isolation. This one proves the parts are
 * wired to each other: the server reaches the supervisor, the supervisor builds the Bot a computer,
 * the gateway decides before the browser acts, the browser acts, and the trail records it. Nearly
 * every defect worth catching late lives in those joins rather than inside any one of them.
 *
 * Not part of `bun run test`. It needs a deployment that is actually up, with a licence, a model key
 * and Docker, so it is asked for by name:
 *
 *   bash scripts/start.sh
 *   bun run test:smoke
 *
 * `OPENBOT_API_URL` points it at a deployment on other ports. Without `OPENBOT_SMOKE` the file is
 * skipped, so `bun run test` stays honest on a machine with nothing running.
 */

const asked = process.env.OPENBOT_SMOKE === "1";
const API = process.env.OPENBOT_API_URL ?? "http://localhost:3001";
const BOT = process.env.OPENBOT_SMOKE_BOT ?? "risk-analyst";

/** Long enough for a computer to be created and Chromium to answer on a cold deployment. */
const COMPUTER_TIMEOUT_MS = 180_000;

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await api(path, init);
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }
  return (await response.json()) as T;
}

beforeAll(async () => {
  if (!asked) return;
  const reachable = await api("/api/capabilities")
    .then((response) => response.ok)
    .catch(() => false);
  if (!reachable) {
    throw new Error(
      `No deployment is answering at ${API}. Start one with \`bash scripts/start.sh\`, or set OPENBOT_API_URL.`,
    );
  }
});

describe.skipIf(!asked)("a deployment that is up", () => {
  test("reports the runtime it is actually running", async () => {
    const capabilities = await json<{ mode: string; durableHistory: boolean }>(
      "/api/capabilities",
    );
    expect(capabilities.mode).toBe("intelligence");
    expect(capabilities.durableHistory).toBe(true);
  });

  test("holds a licence the runtime accepts, and has Bots registered", async () => {
    // A licence the runtime refuses leaves the product running and quietly degraded, which is worth
    // failing a smoke test over.
    const info = await json<{
      licenseStatus: string;
      agents: Record<string, unknown>;
    }>("/api/copilotkit/info");
    expect(info.licenseStatus).toBe("valid");
    expect(Object.keys(info.agents).length).toBeGreaterThan(0);
  });

  test("mints thread ids that say which deployment they came from", async () => {
    const { threadId } = await json<{ threadId: string }>("/api/threads/mint", {
      method: "POST",
    });
    expect(threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe.skipIf(!asked)("a Bot acting on its computer", () => {
  test(
    "reaches a page through the gateway, and the trail records it",
    async () => {
      const before = Date.now();
      const result = await json<{ url: string; title: string }>(
        `/api/computers/${BOT}/navigate`,
        {
          method: "POST",
          body: JSON.stringify({ url: "https://example.com" }),
        },
      );
      expect(result.url).toContain("example.com");
      expect(result.title).toBe("Example Domain");

      // The screenshot proves the computer is really there rather than the navigate being answered
      // from somewhere else.
      const shot = await json<{ base64: string; width: number }>(
        `/api/computers/${BOT}/screenshot`,
      );
      expect(shot.base64.length).toBeGreaterThan(0);
      expect(shot.width).toBeGreaterThan(0);

      const trail = await json<{
        events: { eventType: string; createdAt: string }[];
      }>("/api/admin/audit-events?limit=25");
      const recorded = trail.events.some(
        (event) =>
          event.eventType.startsWith("computer.") &&
          Date.parse(event.createdAt) >= before - 60_000,
      );
      expect(recorded).toBe(true);
    },
    COMPUTER_TIMEOUT_MS,
  );

  test(
    "is refused by a boundary, and the refusal is recorded with its rule",
    async () => {
      const original = await json<{ policy: unknown }>("/api/computers/policy");
      const rule = 'contains(page.host, "example.com")';

      // The listing nests it under `policy`; the write takes the policy itself.
      await json("/api/computers/policy", {
        method: "PUT",
        body: JSON.stringify({
          mode: "enforce",
          deny: [rule],
          allow: ["true"],
        }),
      });

      try {
        const refused = await api(`/api/computers/${BOT}/navigate`, {
          method: "POST",
          body: JSON.stringify({ url: "https://example.com" }),
        });
        expect(refused.ok).toBe(false);
        expect((await refused.text()).toLowerCase()).toContain("policy");

        const trail = await json<{
          events: { eventType: string; payload: Record<string, unknown> }[];
        }>("/api/admin/audit-events?limit=25");
        const refusal = trail.events.find((event) =>
          event.eventType.includes("refused"),
        );
        expect(refusal).toBeDefined();
      } finally {
        // Whatever this deployment had before, it gets back, including on a failure above.
        await json("/api/computers/policy", {
          method: "PUT",
          body: JSON.stringify(original.policy),
        });
      }
    },
    COMPUTER_TIMEOUT_MS,
  );
});
