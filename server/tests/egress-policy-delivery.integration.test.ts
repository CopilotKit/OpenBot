import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  type EnterpriseControls,
  installEnterpriseControls,
} from "../src/admin/controls";
import { createEnterpriseAdminRoutes } from "../src/admin/routes";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { type ComputerSeat, personSeat } from "../src/computer/computer-key";
import * as network from "../src/computer/policy-network";
import {
  type ComputerProvider,
  createSharedComputerProvider,
  sharedSeatHeaders,
} from "../src/computer/provider";
import { createDatabase } from "../src/db/client";
import { networkPolicies } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A Bot's network policy reaching the computer it runs on, however the server and the computer start, and an
 * administrator's change reaching a Bot whose browser is closed.
 *
 * Against the real agent-computer process and PostgreSQL, wired as index.ts wires them: the shared computer's provider
 * with the push on the way to each action, and the enterprise controls pushing in the background. Each check reads the
 * policy where it is enforced: a shell command on the computer goes out through the computer's own filter, which
 * refuses everything until a policy has arrived.
 *
 * What a first install showed: the server came up a second before the computer's address resolved, its push failed
 * and was logged as an error, twice on each server, and nothing tried again but a 30-second timer that skipped every
 * Bot whose browser was closed. No success was ever logged.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const TOKEN = `egress-delivery-${suite}`;
const PERSON = `ada-${suite}`;
const admin = {
  id: `egress-admin-${suite}`,
  email: `egress-admin-${suite}@acme.test`,
  role: "admin" as const,
};

type Line = {
  level: "info" | "warn" | "error";
  entry: Record<string, unknown>;
};
const lines: Line[] = [];
const original = {
  info: console.info,
  warn: console.warn,
  error: console.error,
};
function capture(level: Line["level"]) {
  return (...args: unknown[]) => {
    const text = typeof args[0] === "string" ? args[0] : "";
    try {
      const entry = JSON.parse(text) as Record<string, unknown>;
      if (String(entry.type ?? "").startsWith("egress-policy")) {
        lines.push({ level, entry });
        return;
      }
    } catch {
      // Not one of ours.
    }
    original[level](...args);
  };
}
const egressLines = (from = 0) => lines.slice(from);
/** The push on the way to an action, apart from the background push, which keeps running beside these tests. */
const onWakeLines = (from: number) =>
  egressLines(from).filter((line) =>
    String(line.entry.type).startsWith("egress-policy-push-on-wake"),
  );

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("No port.");
  return address.port;
}

const COMPUTER_PORT = await freePort();
const BASE = `http://127.0.0.1:${COMPUTER_PORT}`;

/** The real agent-computer, started the way the chart's shared mode starts it: for nobody in particular. */
async function startComputer(options: { seats?: string[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "openbot-egress-delivery-"));
  await Promise.all(
    ["profiles", "workspace"].map((name) => mkdir(join(dir, name))),
  );
  // A seat the computer's disk already holds, as one does across an upgrade: listed, its browser closed.
  for (const seat of options.seats ?? [])
    await mkdir(join(dir, "profiles", seat));
  const process_ = Bun.spawn(
    [process.execPath, "--no-env-file", "src/index.ts"],
    {
      cwd: fileURLToPath(new URL("../../agent-computer", import.meta.url)),
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        TMPDIR: tmpdir(),
        COMPUTER_TOKEN: TOKEN,
        PORT: String(COMPUTER_PORT),
        PROFILES_DIR: join(dir, "profiles"),
        WORKSPACE_DIR: join(dir, "workspace"),
        OPENBOT_RECORDER_DIR: join(dir, "recorder"),
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  const deadline = Date.now() + 20_000;
  while (
    !(await fetch(`${BASE}/health`).then(
      (response) => response.ok,
      () => false,
    ))
  ) {
    if (Date.now() > deadline || process_.exitCode !== null)
      throw new Error("The computer did not start.");
    await Bun.sleep(100);
  }
  return {
    stop: async () => {
      process_.kill();
      await process_.exited;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Somewhere a Bot may go only when the administrator's policy allows it. */
const origin = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("reached"),
});
/** Somewhere the policy does not allow, on a port of its own. */
const elsewhere = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("reached elsewhere"),
});
function portOf(server: { port?: number }): number {
  if (server.port === undefined) throw new Error("The server has no port.");
  return server.port;
}
const ORIGIN_PORT = portOf(origin);
const ELSEWHERE_PORT = portOf(elsewhere);

/** A shell command of this seat's Bot on the computer, out through the computer's filter, as a Bot's command goes. */
async function fetchFromComputer(seat: ComputerSeat, port: number) {
  const response = await fetch(`${BASE}/exec`, {
    method: "POST",
    headers: {
      ...sharedSeatHeaders(seat),
      "x-openbot-computer-token": TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      // The filter, not NO_PROXY's loopback exception, which would skip it for 127.0.0.1.
      command: `curl -s --noproxy '' -x "$HTTP_PROXY" http://127.0.0.1:${port}/`,
    }),
  });
  const body = (await response.json()) as { stdout?: string; error?: string };
  if (!response.ok) throw new Error(body.error ?? `exec ${response.status}`);
  return (body.stdout ?? "").trim();
}

const NO_POLICY_YET =
  "No network policy has reached this computer yet, so nothing may leave it.";

/** The provider as index.ts builds it for the shared computer: the push on the way to every action. */
const provider: ComputerProvider = network.withPolicyPushOnWake(
  createSharedComputerProvider({ baseUrl: BASE, token: TOKEN }),
  {
    policyForBot: (botId) => controls.policyForBot(botId),
    token: TOKEN,
  },
);
let controls: EnterpriseControls;

const adminRoutes = new Hono<{ Variables: AppVariables }>();
adminRoutes.route(
  "/api/admin/enterprise",
  createEnterpriseAdminRoutes(async (context, next) => {
    context.set("actor", admin);
    await next();
  }),
);
const setOrganizationPolicy = async (body: unknown) => {
  const response = await adminRoutes.request("/api/admin/enterprise/network", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
};

const removeOrganizationPolicy = () =>
  database
    .delete(networkPolicies)
    .where(
      and(
        eq(networkPolicies.scopeKind, "organization"),
        eq(networkPolicies.scopeId, ""),
      ),
    );

beforeAll(async () => {
  console.info = capture("info");
  console.warn = capture("warn");
  console.error = capture("error");
  await removeOrganizationPolicy();
  // The administrator's policy: this one place, and nowhere else.
  await database.insert(networkPolicies).values({
    scopeKind: "organization",
    scopeId: "",
    mode: "allowlist_only",
    rules: {
      entries: [
        { type: "cidr", value: "127.0.0.1/32", ports: String(ORIGIN_PORT) },
      ],
    },
    locked: false,
    updatedBy: admin.email,
    updatedAt: new Date(),
  });
  // The server first, as on a first install: nothing answers at the computer's address yet.
  controls = await installEnterpriseControls({
    database,
    databaseUrl: testDatabaseUrl(),
    auditStore: createAuditStore(database),
    provider,
    computerToken: TOKEN,
    env: {},
  });
});

afterAll(async () => {
  await controls?.stop();
  await removeOrganizationPolicy();
  origin.stop(true);
  elsewhere.stop(true);
  console.info = original.info;
  console.warn = original.warn;
  console.error = original.error;
  await database.$client.end({ timeout: 5 });
});

describe("the network policy reaching the shared computer", () => {
  const sales = personSeat(PERSON, "sales");
  const writer = personSeat(PERSON, "writer");

  test("a computer that comes up after the server is pushed its policy within seconds, with no error on the way", async () => {
    // The server came up first (beforeAll), as on a first install, while nothing answered at the computer's address.
    await Bun.sleep(1_500);
    const computer = await startComputer({ seats: [`${PERSON}~sales`] });
    try {
      const up = Date.now();
      // Nothing acts on the computer: only the background push can deliver the policy.
      let answer = await fetchFromComputer(sales, ORIGIN_PORT);
      while (answer !== "reached" && Date.now() - up < 20_000) {
        await Bun.sleep(250);
        answer = await fetchFromComputer(sales, ORIGIN_PORT);
      }
      expect(answer).toBe("reached");
      // Well inside the 30-second timer that was the only retry.
      expect(Date.now() - up).toBeLessThan(20_000);
      // It is the administrator's policy, not an open door.
      expect(await fetchFromComputer(sales, ELSEWHERE_PORT)).toContain(
        "is not on this deployment's network allowlist",
      );

      const logged = egressLines();
      // Quiet while the computer was simply not up: no warning, no error.
      expect(logged.filter((line) => line.level !== "info")).toEqual([]);
      // One line saying it is waiting, and one saying the policy landed.
      expect(logged.map((line) => line.entry.type)).toEqual([
        "egress-policy-push-waiting",
        "egress-policy-delivered",
      ]);
      expect(logged[1]?.entry.pushed).toEqual(["sales"]);
    } finally {
      await computer.stop();
    }
  }, 60_000);

  test("before any policy arrives the computer refuses the Bot's connections", async () => {
    const computer = await startComputer();
    try {
      expect(await fetchFromComputer(writer, ORIGIN_PORT)).toBe(NO_POLICY_YET);
    } finally {
      await computer.stop();
    }
  }, 30_000);

  test("an administrator's change reaches a Bot whose browser is closed, on its next action", async () => {
    // A computer that holds only this Bot's policy, so nothing else on it narrows the shell's connections.
    const computer = await startComputer();
    try {
      // The Bot acts: its policy goes ahead of the action, and the command reaches what the policy allows.
      await provider.locate(writer);
      expect(await fetchFromComputer(writer, ORIGIN_PORT)).toBe("reached");

      // The administrator moves the allowlist elsewhere. This Bot has never opened a browser, so the computer does not
      // list it and the background push cannot reach it.
      await setOrganizationPolicy({
        scopeKind: "organization",
        mode: "allowlist_only",
        rules: [
          {
            type: "cidr",
            value: "127.0.0.1/32",
            ports: String(ELSEWHERE_PORT),
          },
        ],
      });

      // Its next action carries the new policy, in the same run of the computer.
      await provider.locate(writer);
      expect(await fetchFromComputer(writer, ORIGIN_PORT)).toContain(
        "is not on this deployment's network allowlist",
      );
      expect(await fetchFromComputer(writer, ELSEWHERE_PORT)).toBe(
        "reached elsewhere",
      );
    } finally {
      await computer.stop();
    }
  }, 30_000);
});

describe("logging a push that does not land", () => {
  test("a computer that is not answering is noted once, reported once it has failed for the quiet window, and its recovery is logged", async () => {
    const deliver = (
      network as {
        deliverEgressPolicies?: (options: {
          push: () => Promise<network.EgressPushReport>;
          quietMs?: number;
          now?: () => number;
          later?: (run: () => void, ms: number) => () => void;
          note?: (line: string) => void;
          report?: (line: string) => void;
        }) => { push: () => Promise<void>; stop: () => void };
      }
    ).deliverEgressPolicies;
    expect(deliver).toBeDefined();
    if (!deliver) return;

    const nobody = await freePort();
    const unanswered = createSharedComputerProvider({
      baseUrl: `http://127.0.0.1:${nobody}`,
      token: TOKEN,
    });
    let answering = false;
    const notes: Record<string, unknown>[] = [];
    const reports: Record<string, unknown>[] = [];
    const waits: number[] = [];
    let clock = 0;
    const delivery = deliver({
      push: () =>
        answering
          ? Promise.resolve({ pushed: [], failed: [] })
          : network.pushEgressPolicies({
              provider: unanswered,
              token: TOKEN,
              policyForBot: async () => ({ mode: "deny_all", rules: [] }),
            }),
      quietMs: 5 * 60_000,
      now: () => clock,
      later: (_run, ms) => {
        waits.push(ms);
        return () => {};
      },
      note: (line) => void notes.push(JSON.parse(line)),
      report: (line) => void reports.push(JSON.parse(line)),
    });

    await delivery.push();
    expect(notes.map((line) => line.type)).toEqual([
      "egress-policy-push-waiting",
    ]);
    expect(String(notes[0]?.error)).toContain("could not be reached");
    // Retried soon, and sooner than the regular push.
    expect(waits).toEqual([1_000]);

    // Still failing inside the window: nothing more is said.
    clock = 4 * 60_000;
    await delivery.push();
    expect(notes).toHaveLength(1);
    expect(reports).toEqual([]);

    // Failing past it: said loudly, once.
    clock = 6 * 60_000;
    await delivery.push();
    await delivery.push();
    expect(reports.map((line) => line.type)).toEqual([
      "egress-policy-push-failed",
    ]);

    answering = true;
    clock = 7 * 60_000;
    await delivery.push();
    expect(notes.map((line) => line.type)).toEqual([
      "egress-policy-push-waiting",
      "egress-policy-delivered",
    ]);
    expect(notes[1]?.waitedSeconds).toBe(7 * 60);
    delivery.stop();
  });

  test("the push on the way to an action is quiet while the computer is not answering, and warns when it refuses", async () => {
    const nobody = await freePort();
    const seat = personSeat(PERSON, "quiet");
    const before = lines.length;
    const unanswered = network.withPolicyPushOnWake(
      createSharedComputerProvider({
        baseUrl: `http://127.0.0.1:${nobody}`,
        token: TOKEN,
      }),
      {
        policyForBot: async () => ({ mode: "deny_all", rules: [] }),
        token: TOKEN,
      },
    );
    await unanswered.locate(seat);
    await unanswered.locate(seat);
    expect(
      onWakeLines(before).map((line) => [line.level, line.entry.type]),
    ).toEqual([["info", "egress-policy-push-on-wake-waiting"]]);

    // A computer that answers and does not take the push is a fault, said at once.
    const computer = await startComputer();
    try {
      const wrongToken = network.withPolicyPushOnWake(
        createSharedComputerProvider({ baseUrl: BASE, token: "not-the-token" }),
        {
          policyForBot: async () => ({ mode: "deny_all", rules: [] }),
          token: "not-the-token",
        },
      );
      const from = lines.length;
      await wrongToken.locate(seat);
      expect(
        onWakeLines(from).map((line) => [line.level, line.entry.type]),
      ).toEqual([["warn", "egress-policy-push-on-wake-failed"]]);
    } finally {
      await computer.stop();
    }
  }, 30_000);
});
