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
 *
 * IT ALSO NEEDS A SESSION, AND SAYS SO RATHER THAN FINDING OUT THREE TIMES.
 *
 * Everything this journey exists to prove is behind `requireUser`: minting a thread id, acting on a
 * Bot's computer, reading the policy, reading the trail. This file sent no credentials, so on any
 * deployment with an identity provider configured -- which is every deployment this repository will
 * start -- three of its five tests answered `401 Authentication required`, and had since the guard
 * was added. A release checklist that asks whether the journey passed was therefore asking for a
 * result nobody could produce.
 *
 * So `OPENBOT_SMOKE_COOKIE` carries a signed-in session, sent verbatim as the `cookie` header. It is
 * a cookie rather than a token because that is what this deployment issues: Better Auth is
 * configured here with social and OIDC providers and no bearer plugin, so a session lives in a
 * cookie and nothing else opens these routes. Take it from a browser already signed in to the
 * deployment under test: DevTools, Application, Cookies, the `better-auth.session_token` entry, sent
 * as `better-auth.session_token=<value>`. It is a credential with that person's reach, so treat it
 * as one: it belongs in the environment of the run and not in a file, a log or a comment on a pull
 * request.
 *
 *   OPENBOT_SMOKE_COOKIE='better-auth.session_token=...' bun run test:smoke
 *
 * Without it the run stops before the first test with a sentence naming it, rather than skipping the
 * half that matters and reporting the other half as a pass. A journey that did not act on a computer
 * has not been run.
 */

const asked = process.env.OPENBOT_SMOKE === "1";
const API = process.env.OPENBOT_API_URL ?? "http://localhost:3001";
const BOT = process.env.OPENBOT_SMOKE_BOT ?? "risk-analyst";
const COOKIE = process.env.OPENBOT_SMOKE_COOKIE ?? "";

/** Long enough for a computer to be created and Chromium to answer on a cold deployment. */
const COMPUTER_TIMEOUT_MS = 180_000;

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(COOKIE ? { cookie: COOKIE } : {}),
      ...(init?.headers ?? {}),
    },
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

  if (!COOKIE) {
    throw new Error(
      "This journey acts as a person, and every route it proves is behind a session. Set " +
        "OPENBOT_SMOKE_COOKIE to the `better-auth.session_token=...` cookie of a browser signed in " +
        `to ${API}. See the comment at the top of this file.`,
    );
  }

  // Asked once, here, so a session that is missing, expired or from another deployment is one
  // sentence at the start rather than the same 401 read three different ways further down.
  const accepted = await api("/api/computers/policy");
  if (accepted.status === 401) {
    throw new Error(
      `The session in OPENBOT_SMOKE_COOKIE is not accepted by ${API}. It may have expired, or belong ` +
        "to a different deployment. Sign in again and take a fresh one.",
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
