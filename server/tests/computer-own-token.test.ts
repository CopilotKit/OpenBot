// A computer made for one person holds a token of its own, never the deployment's, and the server calls it with that
// token: over HTTP and on the live screen's socket.
//
// The hole this closes: the supervisor handed every computer the deployment's `COMPUTER_TOKEN` unchanged, and a Bot is
// root on its own person's computer, so it could read that token off its computer's process and use it on any other
// person's computer it could reach on the network (`GET /computers`, then `POST /exec` as root). Nothing of that went
// through the server, so nothing was audited.
//
// Real processes: each computer is the real `agent-computer`, started with the environment the real supervisor code
// gives it (`environmentFor`), and the server's calls go through the real gateway, the real supervisor provider and the
// real HTTP server's live-screen proxy. The one stand-in is the supervisor's answer to `/ensure`, which says where the
// computer is: the Docker half of the supervisor is tested against Docker in supervisor/tests.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { environmentFor } from "../../supervisor/src/environment";
import { reservePort } from "../../tests/support/reserved-port";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AuditEventInput } from "../src/audit";
import { withPersonBrowsers } from "../src/browser/host";
import { personBrowserId } from "../src/browser/person";
import { botSeat, personSeat } from "../src/computer/computer-key";
import { createComputerGateway } from "../src/computer/gateway";
import {
  pushEgressPolicies,
  withPolicyPushOnWake,
} from "../src/computer/policy-network";
import { createSharedComputerProvider } from "../src/computer/provider";
import { createDockerSupervisorProvider } from "../src/computer/supervisor";
import type { DeploymentConfig } from "../src/config";
import { startHttpServer } from "../src/http-server";

/** The deployment's computer token: what the server and the supervisor hold, and no computer may. */
const DEPLOYMENT_TOKEN = `deployment-${randomUUID()}`;
const BOT = "notes-bot";

/**
 * Each computer's own token, written out from the documented scheme (shared/computer-token.ts) rather than taken from
 * the code under test: `HMAC-SHA256(COMPUTER_TOKEN, "openbot computer token v1\n<kind>:<id>")`, in hex.
 */
function ownToken(kind: "person" | "bot", id: string): string {
  return createHmac("sha256", DEPLOYMENT_TOKEN)
    .update(`openbot computer token v1\n${kind}:${id}`)
    .digest("hex");
}

/** What the supervisor tells this computer, as the variables its container is started with. */
function supervisorEnvironment(
  kind: "person" | "bot",
  id: string,
): Record<string, string> {
  return Object.fromEntries(
    environmentFor({ kind, id }, { COMPUTER_TOKEN: DEPLOYMENT_TOKEN }).map(
      (line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      },
    ),
  );
}

type Computer = {
  base: string;
  child: ReturnType<typeof Bun.spawn>;
  dir: string;
};
const started: Computer[] = [];

/** One real computer, started with `environment` as a supervisor's container would be. */
async function startComputer(
  environment: Record<string, string>,
): Promise<Computer> {
  const dir = await mkdtemp(join(tmpdir(), "openbot-own-token-"));
  await Promise.all(
    ["profiles", "workspace", "recorder"].map((name) => mkdir(join(dir, name))),
  );
  const port = await reservePort();
  const child = Bun.spawn([process.execPath, "--no-env-file", "src/index.ts"], {
    cwd: fileURLToPath(new URL("../../agent-computer", import.meta.url)),
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      PORT: String(port),
      PROFILES_DIR: join(dir, "profiles"),
      WORKSPACE_DIR: join(dir, "workspace"),
      OPENBOT_RECORDER_DIR: join(dir, "recorder"),
      COMPUTER_BROWSER_BACKEND: "managed",
      COMPUTER_BROWSER_MODE: "headless",
      ...environment,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const computer = { base: `http://127.0.0.1:${port}`, child, dir };
  started.push(computer);
  const deadline = Date.now() + 20_000;
  while (
    !(await fetch(`${computer.base}/health`).then(
      (response) => response.ok,
      () => false,
    ))
  ) {
    if (Date.now() > deadline || child.exitCode !== null)
      throw new Error("The computer did not start.");
    await Bun.sleep(100);
  }
  return computer;
}

/** A call to a computer under `token`, as a caller that holds it would make one. */
function asking(
  computer: Computer,
  path: string,
  token: string,
  init: RequestInit = {},
) {
  return fetch(`${computer.base}${path}`, {
    ...init,
    headers: {
      "x-openbot-computer-token": token,
      "x-openbot-bot-id": BOT,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
}

const exec = (computer: Computer, token: string) =>
  asking(computer, "/exec", token, {
    method: "POST",
    body: JSON.stringify({ command: "echo reached" }),
  });

let ada: Computer;
let bo: Computer;
let cy: Computer;

beforeAll(async () => {
  [ada, bo, cy] = await Promise.all([
    startComputer(supervisorEnvironment("person", "ada")),
    startComputer(supervisorEnvironment("person", "bo")),
    // A computer holding the token a person's computer holds now, for the server's half: the call it makes has to carry
    // that token and not the deployment's, which this computer does not take.
    startComputer({
      COMPUTER_TOKEN: ownToken("person", "cy"),
      COMPUTER_PERSON_ID: "cy",
      COMPUTER_SEPARATE_WORKSPACES: "on",
    }),
  ]);
}, 60_000);

afterAll(async () => {
  for (const computer of started) {
    computer.child.kill();
    await computer.child.exited;
    await rm(computer.dir, { recursive: true, force: true });
  }
});

describe("the token the supervisor gives a computer", () => {
  test("is its own: two people's computers get different tokens, and neither gets the deployment's", () => {
    const tokens = {
      ada: supervisorEnvironment("person", "ada").COMPUTER_TOKEN,
      bo: supervisorEnvironment("person", "bo").COMPUTER_TOKEN,
      // An isolated Bot's computer, and a person's own browser's, are computers of one id too.
      isolated: supervisorEnvironment("bot", "invoice-collector")
        .COMPUTER_TOKEN,
      browser: supervisorEnvironment(
        "bot",
        "person-0123456789abcdef0123456789abcdef",
      ).COMPUTER_TOKEN,
    };
    for (const token of Object.values(tokens)) {
      expect(token).toBeDefined();
      expect(token).not.toBe(DEPLOYMENT_TOKEN);
      expect(token).not.toContain(DEPLOYMENT_TOKEN);
    }
    expect(new Set(Object.values(tokens)).size).toBe(4);
    // And it is the one the server derives to call that computer.
    expect(tokens).toEqual({
      ada: ownToken("person", "ada"),
      bo: ownToken("person", "bo"),
      isolated: ownToken("bot", "invoice-collector"),
      browser: ownToken("bot", "person-0123456789abcdef0123456789abcdef"),
    });
  });
});

describe("a person's computer, started as the supervisor starts it", () => {
  test("refuses the deployment's token on /computers and /exec", async () => {
    // What a Bot read off its own computer's process before: it opened every computer it could reach.
    expect((await asking(ada, "/computers", DEPLOYMENT_TOKEN)).status).toBe(
      401,
    );
    expect((await exec(ada, DEPLOYMENT_TOKEN)).status).toBe(401);
  });

  test("refuses another person's computer's token on /computers and /exec", async () => {
    // What Bo's Bot can read off Bo's computer now: it opens Bo's computer, and not Ada's.
    const bosToken = supervisorEnvironment("person", "bo").COMPUTER_TOKEN ?? "";
    expect((await asking(ada, "/computers", bosToken)).status).toBe(401);
    expect((await exec(ada, bosToken)).status).toBe(401);
    expect((await exec(bo, bosToken)).status).toBe(200);
  });

  test("answers its own token", async () => {
    const adasToken =
      supervisorEnvironment("person", "ada").COMPUTER_TOKEN ?? "";
    expect((await asking(ada, "/computers", adasToken)).status).toBe(200);
    const ran = await exec(ada, adasToken);
    expect(ran.status).toBe(200);
    expect(((await ran.json()) as { stdout?: string }).stdout).toContain(
      "reached",
    );
  });
});

describe("the server calling a person's computer", () => {
  /**
   * The supervisor's answers to `/ensure` and to its listing: where each person's computer is. Its token is not the
   * supervisor's to say.
   */
  function supervisorAt(computers: Record<string, Computer>) {
    return Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/computers")
          return Response.json({
            computers: Object.entries(computers).map(([id, computer]) => ({
              kind: "person",
              id,
              status: "running",
              url: computer.base,
            })),
          });
        const match = path.match(/^\/computers\/person\/([^/]+)\/ensure$/);
        const computer = match?.[1] ? computers[match[1]] : undefined;
        if (!computer) return Response.json({ error: "No." }, { status: 404 });
        return Response.json({
          kind: "person",
          id: match?.[1],
          status: "running",
          url: computer.base,
        });
      },
    });
  }

  function gatewayOn(supervisor: ReturnType<typeof supervisorAt>) {
    const rows: AuditEventInput[] = [];
    const gateway = createComputerGateway({
      provider: createDockerSupervisorProvider({
        baseUrl: `http://127.0.0.1:${supervisor.port}`,
        token: "supervisor-token",
      }),
      auditStore: { insert: async (event) => void rows.push(event) },
      policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
      token: DEPLOYMENT_TOKEN,
    });
    return { gateway, rows };
  }

  test("carries that computer's own token, and the command runs", async () => {
    const supervisor = supervisorAt({ cy });
    try {
      const { gateway } = gatewayOn(supervisor);
      const seat = personSeat("cy", BOT);
      expect(gateway.tokenFor(seat)).toBe(ownToken("person", "cy"));
      const result = await gateway.runCommand(
        seat,
        { id: "cy" },
        { command: "echo reached" },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("reached");
    } finally {
      supervisor.stop(true);
    }
  });

  test("pushes that computer its network policy under its own token, on the way to an action and on the interval", async () => {
    const supervisor = supervisorAt({ cy });
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (line: unknown) => void warned.push(String(line));
    try {
      const provider = createDockerSupervisorProvider({
        baseUrl: `http://127.0.0.1:${supervisor.port}`,
        token: "supervisor-token",
      });
      const policy = { mode: "allow_all" as const, rules: [] };
      // On the way to the action that woke it: a push the computer refused is logged, not thrown.
      await withPolicyPushOnWake(provider, {
        policyForBot: async () => policy,
        token: DEPLOYMENT_TOKEN,
      }).locate(personSeat("cy", BOT));
      expect(warned).toEqual([]);
      // And the periodic push to every running computer, which asks a person's computer which Bots it carries.
      const report = await pushEgressPolicies({
        provider,
        token: DEPLOYMENT_TOKEN,
        policyForBot: async () => policy,
      });
      expect(report.failed).toEqual([]);
    } finally {
      console.warn = warn;
      supervisor.stop(true);
    }
  });

  test("opens the live screen under that computer's own token", async () => {
    const supervisor = supervisorAt({ cy });
    const port = await reservePort();
    const { gateway } = gatewayOn(supervisor);
    const server = startHttpServer({
      port,
      config: { computer: {} } as unknown as DeploymentConfig,
      resolveRequestActor: async () => ({
        id: "cy",
        name: "Cy",
        role: "user",
      }),
      agentProfileStore: {
        get: async () => ({ visibility: "public", ownerUserId: null }),
      } as unknown as AgentProfileStore,
      computerGateway: gateway,
      app: { fetch: () => new Response("Not found.", { status: 404 }) },
    });
    try {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/api/computers/${BOT}/stream`,
      );
      /*
       * The server opens the person's side of the socket before it opens its own to the computer, and closes the
       * person's when the computer's closes. So a computer that refused the token is a socket that closes having said
       * nothing; one that took it says something on its own (a frame, or why it has none).
       */
      const heard = await new Promise<"message" | "closed">((resolve) => {
        const timer = setTimeout(() => resolve("closed"), 20_000);
        socket.onmessage = () => {
          clearTimeout(timer);
          resolve("message");
        };
        socket.onclose = () => {
          clearTimeout(timer);
          resolve("closed");
        };
      });
      socket.close();
      expect(heard).toBe("message");
    } finally {
      // Bounded: a server whose proxied socket never reached the computer can hold its stop open.
      await Promise.race([server.stop(true), Bun.sleep(2_000)]);
      supervisor.stop(true);
    }
  }, 30_000);
});

describe("the computers that keep the deployment's token", () => {
  test("the one shared computer, and OpenBot Desktop's host-side browser computer, are sent the deployment's token", () => {
    // Neither is a boundary between people: the shared computer is documented as one computer for everybody, and
    // Desktop's runs the person's own browsers, and no Bot, on their own machine. Both are started with it.
    const audit = { insert: async () => undefined };
    const policy = () => undefined;
    const shared = createComputerGateway({
      provider: createSharedComputerProvider({
        baseUrl: "http://127.0.0.1:4100",
        token: DEPLOYMENT_TOKEN,
      }),
      auditStore: audit,
      policy,
      token: DEPLOYMENT_TOKEN,
    });
    expect(shared.tokenFor(personSeat("ada", BOT))).toBe(DEPLOYMENT_TOKEN);

    const browser = personBrowserId("ada");
    const desktop = createComputerGateway({
      provider: withPersonBrowsers(
        createDockerSupervisorProvider({ baseUrl: "http://127.0.0.1:4500" }),
        "http://127.0.0.1:4101",
      ),
      auditStore: audit,
      policy,
      token: DEPLOYMENT_TOKEN,
    });
    expect(desktop.tokenFor(botSeat(browser))).toBe(DEPLOYMENT_TOKEN);
    // While a Bot's computer there is still its own.
    expect(desktop.tokenFor(personSeat("ada", BOT))).toBe(
      ownToken("person", "ada"),
    );
    // And without Desktop's computer, a person's browser is a computer of its own like any other.
    const hosted = createComputerGateway({
      provider: withPersonBrowsers(
        createDockerSupervisorProvider({ baseUrl: "http://127.0.0.1:4500" }),
        undefined,
      ),
      auditStore: audit,
      policy,
      token: DEPLOYMENT_TOKEN,
    });
    expect(hosted.tokenFor(botSeat(browser))).toBe(ownToken("bot", browser));
  });
});
