import { beforeAll, describe, expect, test } from "bun:test";

/**
 * One journey through a running deployment, over HTTP.
 *
 * Every other test in this repository proves a decision in isolation. This one proves the parts are
 * wired to each other: the server reaches the supervisor, the supervisor builds the Bot a computer,
 * the boundary decides before the browser acts, the browser acts, and the trail records it. Nearly
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
 * EVERY ADDRESS IT CALLS IS ONE THAT STAYS. The API's own operations, under
 * `/api/v2/organizations/<organization>/` (api/openapi.yaml), and the runtime's
 * `/api/copilotkit/info`. `OPENBOT_SMOKE_ORGANIZATION` names the organization; every install has
 * one today, addressed as `default`.
 *
 * IT ALSO NEEDS A SESSION, AND SAYS SO RATHER THAN FINDING OUT THREE TIMES.
 *
 * Everything this journey exists to prove is behind a signed-in person: making a thread id, acting
 * on a Bot's computer, reading the boundaries, reading the trail. Sent with no credentials to a
 * deployment that has sign-in, three of its five tests answer 401, and a release checklist that asks
 * whether the journey passed is then asking for a result nobody could produce.
 *
 * So `OPENBOT_SMOKE_COOKIE` carries a signed-in administrator's session, sent verbatim as the
 * `cookie` header. It is a cookie rather than a token because that is what this deployment issues to
 * a browser. Take it from a browser already signed in to the deployment under test: DevTools,
 * Application, Cookies, the `better-auth.session_token` entry, sent as
 * `better-auth.session_token=<value>`. It is a credential with that person's reach, so treat it as
 * one: it belongs in the environment of the run and not in a file, a log or a comment on a pull
 * request.
 *
 *   OPENBOT_SMOKE_COOKIE='better-auth.session_token=...' bun run test:smoke
 *
 * A deployment with no sign-in (`OPENBOT_SINGLE_USER`) answers without one, and the journey runs as
 * its one person. It only admits requests carrying its install's token, so `OPENBOT_INSTALL_TOKEN`
 * (the value `scripts/start.sh` wrote into `.env`) is sent as `X-OpenBot-Install-Token` when it is set.
 * Otherwise, without the cookie the run stops before the first test with a sentence
 * naming it, rather than skipping the half that matters and reporting the other half as a pass. A
 * journey that did not act on a computer has not been run.
 */

const asked = process.env.OPENBOT_SMOKE === "1";
const API = process.env.OPENBOT_API_URL ?? "http://localhost:3001";
const BOT = process.env.OPENBOT_SMOKE_BOT ?? "risk-analyst";
const COOKIE = process.env.OPENBOT_SMOKE_COOKIE ?? "";
const INSTALL_TOKEN = process.env.OPENBOT_INSTALL_TOKEN ?? "";
const ORGANIZATION = `/api/v2/organizations/${process.env.OPENBOT_SMOKE_ORGANIZATION ?? "default"}`;

/** Long enough for a computer to be created and Chromium to answer on a cold deployment. */
const COMPUTER_TIMEOUT_MS = 180_000;

async function api(path: string, init?: RequestInit): Promise<Response> {
  const write = init?.method !== undefined && init.method !== "GET";
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      // Every write is one this journey means to make once.
      ...(write ? { "idempotency-key": crypto.randomUUID() } : {}),
      ...(COOKIE ? { cookie: COOKIE } : {}),
      ...(INSTALL_TOKEN ? { "x-openbot-install-token": INSTALL_TOKEN } : {}),
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

interface Boundaries {
  mode: "enforce" | "dry-run";
  deny: string[];
  allow: string[];
  labels: Record<string, { name: string; description: string }>;
}
interface AuditEventPage {
  auditEvents: {
    eventType: string;
    createdAt: string;
    payload: Record<string, unknown>;
  }[];
}

beforeAll(async () => {
  if (!asked) return;
  // What this OpenBot offers, which anybody may read before signing in.
  const reachable = await api(`${ORGANIZATION}/deployment`)
    .then((response) => response.ok)
    .catch(() => false);
  if (!reachable) {
    throw new Error(
      `No deployment is answering at ${API}. Start one with \`bash scripts/start.sh\`, or set OPENBOT_API_URL.`,
    );
  }

  // Asked once, here, so a session that is missing, expired or from another deployment is one
  // sentence at the start rather than the same 401 read three different ways further down. The
  // boundaries are an administrator's to read, and the journey sets them.
  const accepted = await api(`${ORGANIZATION}/boundaries`);
  if (accepted.status === 401 && !COOKIE) {
    throw new Error(
      "This journey acts as a person, and everything it proves is behind a session. Set " +
        "OPENBOT_SMOKE_COOKIE to the `better-auth.session_token=...` cookie of a browser signed in " +
        `to ${API} as an administrator. See the comment at the top of this file.`,
    );
  }
  if (accepted.status === 401) {
    throw new Error(
      `The session in OPENBOT_SMOKE_COOKIE is not accepted by ${API}. It may have expired, or belong ` +
        "to a different deployment. Sign in again and take a fresh one.",
    );
  }
  if (accepted.status === 403) {
    throw new Error(
      `The session in OPENBOT_SMOKE_COOKIE is not an administrator's at ${API}, and the journey ` +
        "sets a boundary and reads the audit trail. Sign in as an administrator.",
    );
  }
});

describe.skipIf(!asked)("a deployment that is up", () => {
  test("keeps conversations between restarts", async () => {
    const deployment = await json<{
      edition: string;
      durableHistory: boolean;
    }>(`${ORGANIZATION}/deployment`);
    expect(["team", "personal"]).toContain(deployment.edition);
    expect(deployment.durableHistory).toBe(true);
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

  test("makes thread ids that say which deployment they came from", async () => {
    const created = await api(`${ORGANIZATION}/conversation-threads`, {
      method: "POST",
    });
    expect(created.status).toBe(201);
    const { threadId } = (await created.json()) as { threadId: string };
    expect(threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe.skipIf(!asked)("a Bot acting on its computer", () => {
  test(
    "reaches a page through the boundary, and the trail records it",
    async () => {
      const before = Date.now();
      const result = await json<{ url: string; title: string }>(
        `${ORGANIZATION}/computers/${BOT}/navigate`,
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
        `${ORGANIZATION}/computers/${BOT}/screenshot`,
      );
      expect(shot.base64.length).toBeGreaterThan(0);
      expect(shot.width).toBeGreaterThan(0);

      const trail = await json<AuditEventPage>(
        `${ORGANIZATION}/audit-events?limit=25`,
      );
      const recorded = trail.auditEvents.some(
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
      const original = await json<Boundaries>(`${ORGANIZATION}/boundaries`);
      const rule = 'contains(page.host, "example.com")';
      const before = Date.now();

      await json(`${ORGANIZATION}/boundaries`, {
        method: "PUT",
        body: JSON.stringify({
          mode: "enforce",
          deny: [rule],
          allow: ["true"],
        }),
      });

      try {
        const refused = await api(`${ORGANIZATION}/computers/${BOT}/navigate`, {
          method: "POST",
          body: JSON.stringify({ url: "https://example.com" }),
        });
        expect(refused.status).toBe(403);
        const problem = (await refused.json()) as {
          code: string;
          rule?: string;
        };
        expect(problem.code).toBe("COMPUTER_ACTION_REFUSED");
        expect(problem.rule ?? "").toContain("example.com");

        const trail = await json<AuditEventPage>(
          `${ORGANIZATION}/audit-events?limit=25&eventType=computer.action_refused`,
        );
        const refusal = trail.auditEvents.find(
          (event) => Date.parse(event.createdAt) >= before - 60_000,
        );
        expect(refusal).toBeDefined();
        expect(JSON.stringify(refusal?.payload)).toContain("example.com");
      } finally {
        // Whatever this deployment had before, it gets back, including on a failure above.
        await json(`${ORGANIZATION}/boundaries`, {
          method: "PUT",
          body: JSON.stringify(original),
        });
      }
    },
    COMPUTER_TIMEOUT_MS,
  );
});
