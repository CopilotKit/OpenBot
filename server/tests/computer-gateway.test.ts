import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import {
  ActionRefusedError,
  createComputerGateway,
  WorkspaceRefusedError,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import type {
  ComputerLocation,
  ComputerProvider,
} from "../src/computer/provider";
import type { SnapshotResult } from "../src/computer/schema";
import {
  createInMemorySnapshotStore,
  type SnapshotStore,
} from "../src/computer/snapshot-store";

/**
 * What the gateway must guarantee, tested as properties rather than as call sequences.
 *
 * The four that matter, and none of them are visible from a green typecheck:
 *  - a refused action does NOT reach the computer
 *  - a row is written either way, so the trail cannot only contain successes
 *  - the policy decides on the element the SERVER resolved, never on a label the caller supplied
 *  - the text typed into a field never enters the audit payload
 */

const SNAPSHOT: SnapshotResult = {
  snapshotId: 7,
  url: "https://example.com/order",
  title: "Order",
  truncated: false,
  elements: [
    { ref: "e1", role: "input", name: "Customer name:", type: "text" },
    { ref: "e9", role: "button", name: "Submit order" },
  ],
};

/** A computer that records which HTTP actions reached it. */
function fakeComputer(options?: {
  stopResult?: { wasRunning: boolean };
  resetResult?: { cleared: boolean };
  locations?: ComputerLocation[];
  routes?: Record<string, (init?: RequestInit) => Response | Promise<Response>>;
}) {
  const calls: string[] = [];
  const addressedAs: string[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const stopResult = options?.stopResult ?? { wasRunning: true };
  const resetResult = options?.resetResult ?? { cleared: true };
  const locations = options?.locations ?? [];
  const result = (action: string) => ({
    action,
    url: SNAPSHOT.url,
    elapsedMs: 1,
  });
  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-bot",
    locate: async (botId) => {
      addressedAs.push(botId);
      return "http://agent-computer:4100";
    },
    status: async (botId) => ({ botId, state: "ready" }),
    stop: async (botId) => {
      calls.push(`stop:${botId}`);
      return stopResult;
    },
    reset: async (botId) => {
      calls.push(`reset:${botId}`);
      return resetResult;
    },
    list: async () => locations,
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    const path = new URL(url).pathname;
    if (options?.routes && path in options.routes) {
      return options.routes[path](init);
    }
    switch (path) {
      case "/snapshot":
        return Response.json(SNAPSHOT);
      case "/read":
        return Response.json({
          url: SNAPSHOT.url,
          title: "Order",
          text: "",
          truncated: false,
        });
      case "/screenshot":
        calls.push("screenshot");
        return Response.json({
          image: "aGVsbG8=",
          mimeType: "image/png",
        });
      case "/files/read":
        calls.push("readFile");
        return Response.json({
          path: "notes.md",
          text: "kept",
          truncated: false,
          bytes: 4,
        });
      case "/files/write":
        calls.push("writeFile");
        return Response.json({
          path: "notes.md",
          bytes: 4,
          appended: false,
        });
      case "/files/list":
        calls.push("listFiles");
        return Response.json({
          path: "notes",
          entries: [],
        });
      case "/exec":
        calls.push("runCommand");
        return Response.json({
          command: "cat secrets.txt",
          exitCode: 0,
          output: "the customer's card number is 4111-1111-1111-1111",
          truncated: false,
          timedOut: false,
        });
      case "/navigate":
        calls.push("navigate");
        return Response.json({
          url: "https://example.com/",
          title: "Example",
          elapsedMs: 1,
        });
      case "/click":
        calls.push("click");
        return Response.json(result("click"));
      case "/type":
        calls.push("type");
        return Response.json(result("type"));
      case "/key":
        calls.push("key");
        return Response.json(result("key"));
      case "/scroll":
        calls.push("scroll");
        return Response.json(result("scroll"));
      case "/control":
        calls.push("control");
        return Response.json({ mode: "bot" });
      case "/control/request":
        calls.push("requestHelp");
        return Response.json({ mode: "human", reason: "Sign in" });
      case "/control/take":
        calls.push("takeControl");
        return Response.json({ mode: "human" });
      case "/control/release":
        calls.push("releaseControl");
        return Response.json({ mode: "bot" });
      case "/control/secret":
        calls.push("requestSecret");
        return Response.json({ mode: "secret", ref: "e1" });
      case "/human/secret":
        calls.push("supplySecret");
        return Response.json({ supplied: true });
      case "/human/click":
      case "/human/move":
      case "/human/button":
      case "/human/wheel":
        calls.push(path.slice(1));
        return Response.json({ ok: true });
      default:
        return Response.json(
          { error: `Unknown endpoint: ${path}` },
          { status: 404 },
        );
    }
  }) as unknown as typeof fetch;
  return { provider, fetchImpl, calls, addressedAs, requests };
}

function fakeAudit() {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  return { store, rows };
}

const ACTOR = { id: "dev-local-user" };
const PERMISSIVE: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

async function gatewayWith(
  policy: ActionPolicy | undefined,
  options?: {
    stopResult?: { wasRunning: boolean };
    resetResult?: { cleared: boolean };
    locations?: ComputerLocation[];
    token?: string;
  },
) {
  const { provider, fetchImpl, calls, addressedAs, requests } =
    fakeComputer(options);
  const { store, rows } = fakeAudit();
  const gateway = createComputerGateway({
    provider,
    fetchImpl,
    auditStore: store,
    policy: () => policy,
    token: options?.token,
  });
  // Every test acts on refs, so the server must hold a snapshot first, exactly as the real flow does.
  await gateway.snapshot("bot-1");
  return { gateway, calls, rows, addressedAs, requests, provider };
}

describe("the computer gateway", () => {
  test("carries out an allowed action and records it", async () => {
    const { gateway, calls, rows } = await gatewayWith(PERMISSIVE);
    await gateway.click("bot-1", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });

    expect(calls).toEqual(["click"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("computer.action_allowed");
    expect(rows[0]?.targetId).toBe("bot-1");
  });

  test("a refused action never reaches the computer", async () => {
    const { gateway, calls, rows } = await gatewayWith({
      ...PERMISSIVE,
      deny: ['contains(element.name, "submit")'],
    });

    await expect(
      gateway.click("bot-1", ACTOR, { ref: "e9", snapshotId: 7 }),
    ).rejects.toThrow(ActionRefusedError);

    // The decision happens before the effect.
    expect(calls).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("computer.action_refused");
    expect(rows[0]?.targetId).toBe("bot-1");
  });

  test("the refusal names the rule, so an operator can find it", async () => {
    const { gateway } = await gatewayWith({
      ...PERMISSIVE,
      deny: ['contains(element.name, "submit")'],
    });

    const error = await gateway
      .click("bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ActionRefusedError);
    expect((error as ActionRefusedError).rule).toBe(
      'contains(element.name, "submit")',
    );
  });

  test("the policy sees the element the SERVER resolved, not what the caller claimed", async () => {
    // The evasion this prevents: calling the Submit button something harmless in the request. The
    // caller only ever sends a ref, and the gateway looks it up in the snapshot it fetched itself.
    const { gateway, calls } = await gatewayWith({
      ...PERMISSIVE,
      deny: ['contains(element.name, "submit")'],
    });

    await expect(
      gateway.click("bot-1", ACTOR, {
        ref: "e9",
        snapshotId: 7,
        // Not part of the input contract, and must not influence anything even when supplied.
        ...({ name: "Continue", element: { name: "Continue" } } as object),
      }),
    ).rejects.toThrow(ActionRefusedError);
    expect(calls).toEqual([]);
  });

  test("an allowed action reports the element's label for the transcript", async () => {
    const { gateway } = await gatewayWith(PERMISSIVE);
    const result = await gateway.type("bot-1", ACTOR, {
      ref: "e1",
      snapshotId: 7,
      text: "Grace Hopper",
    });
    expect(result.element?.name).toBe("Customer name:");
  });

  test("the typed text never enters the audit payload", async () => {
    const { gateway, rows } = await gatewayWith(PERMISSIVE);
    await gateway.type("bot-1", ACTOR, {
      ref: "e1",
      snapshotId: 7,
      text: "hunter2-not-a-real-password",
    });

    // Serialized and searched, rather than checking known keys: the guarantee is that the value is
    // nowhere in the row, not that one particular field omits it.
    expect(JSON.stringify(rows[0]?.payload)).not.toContain("hunter2");
    expect(rows[0]?.payload.element).toEqual({
      role: "input",
      name: "Customer name:",
      // The control's type is recorded too: knowing a value went into a `password` field rather than
      // a `text` one is exactly the distinction an investigator needs, and it is not the value.
      type: "text",
    });
  });

  test("an absent policy refuses every action", async () => {
    const { gateway, calls, rows } = await gatewayWith(undefined);
    await expect(
      gateway.click("bot-1", ACTOR, { ref: "e9", snapshotId: 7 }),
    ).rejects.toThrow(ActionRefusedError);
    expect(calls).toEqual([]);
    expect(rows[0]?.eventType).toBe("computer.action_refused");
  });

  test("dry-run records the refusal and still carries the action out", async () => {
    const { gateway, calls, rows } = await gatewayWith({
      mode: "dry-run",
      deny: ['contains(element.name, "submit")'],
      allow: ["true"],
    });

    await gateway.click("bot-1", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });

    expect(calls).toEqual(["click"]);
    const decision = rows[0]?.payload.decision as { carriedOut?: boolean };
    expect(rows[0]?.eventType).toBe("computer.action_refused");
    // Without this flag the row reads as a contradiction: refused, yet the work happened.
    expect(decision.carriedOut).toBe(true);
  });

  test("the local development actor is kept out of the audit foreign key", async () => {
    // Writing an id with no `users` row fails the constraint and loses the row entirely, so who it
    // was is carried in the payload instead. The route decides this; the gateway must honour it.
    const { gateway, rows } = await gatewayWith(PERMISSIVE);
    await gateway.click("bot-1", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });
    expect(rows[0]?.actorUserId).toBeUndefined();
    expect(rows[0]?.payload.actor).toBe("dev-local-user");
  });

  test("a file read is governed, not passed through", async () => {
    const { gateway, calls, rows } = await gatewayWith({
      ...PERMISSIVE,
      deny: ['contains(file.path, "credentials")'],
    });

    await expect(
      gateway.readFile("bot-1", ACTOR, {
        path: "credentials/aws.txt",
      }),
    ).rejects.toThrow(ActionRefusedError);
    expect(calls).toEqual([]);
    expect(rows[0]?.eventType).toBe("computer.action_refused");
    expect(rows[0]?.payload.file).toBe("credentials/aws.txt");
  });

  test("a rule can be written against a file's extension", async () => {
    const { gateway, calls } = await gatewayWith({
      ...PERMISSIVE,
      deny: ['file.extension == "env"'],
    });

    await expect(
      gateway.readFile("bot-1", ACTOR, { path: "config/prod.env" }),
    ).rejects.toThrow(ActionRefusedError);
    // A different extension in the same folder is untouched by that rule.
    await gateway.readFile("bot-1", ACTOR, {
      path: "config/prod.json",
    });
    expect(calls).toEqual(["readFile"]);
  });

  test("a permitted write happens and is recorded by path, never by contents", async () => {
    const { gateway, calls, rows } = await gatewayWith(PERMISSIVE);
    await gateway.writeFile("bot-1", ACTOR, {
      path: "notes.md",
      contents: "the customer's card number is 4111-1111-1111-1111",
    });

    expect(calls).toEqual(["writeFile"]);
    expect(rows[0]?.eventType).toBe("computer.action_allowed");
    expect(rows[0]?.payload.file).toBe("notes.md");
    // The same guarantee as typed text: a Bot writes down what it was told, so a file body is exactly
    // as sensitive and is never put in the row.
    expect(JSON.stringify(rows[0]?.payload)).not.toContain("4111");
  });

  test("a permitted command runs and is recorded by command, never by output", async () => {
    const { gateway, calls, rows } = await gatewayWith(PERMISSIVE);
    await gateway.runCommand("bot-1", ACTOR, { command: "cat secrets.txt" });

    expect(calls).toEqual(["runCommand"]);
    expect(rows[0]?.eventType).toBe("computer.action_allowed");
    expect(rows[0]?.payload.command).toBe("cat secrets.txt");
    // The command IS the action, so it is recorded in full. Its output is the file body of this
    // pair: whatever the command read off a page or out of a file, and never in the row.
    expect(JSON.stringify(rows[0]?.payload)).not.toContain("4111");
    // A command has no page element, so the row says nothing about a snapshot it was never part of.
    expect(rows[0]?.payload.element).toBeUndefined();
  });

  test("a command the policy refuses is recorded and never reaches the computer", async () => {
    const { gateway, calls, rows } = await gatewayWith({
      ...PERMISSIVE,
      deny: ['intent == "run_command"'],
    });

    await expect(
      gateway.runCommand("bot-1", ACTOR, { command: "cat secrets.txt" }),
    ).rejects.toThrow(ActionRefusedError);
    expect(calls).toEqual([]);
    expect(rows[0]?.eventType).toBe("computer.action_refused");
    expect(rows[0]?.payload.command).toBe("cat secrets.txt");
  });

  test("the computer is told WHICH Bot is asking", async () => {
    // Every per-Bot behaviour on the computer keys off this id: the profile it opens, the logins it
    // has, the proxy its traffic leaves through, and who holds its wheel.
    const { provider, fetchImpl, addressedAs } = fakeComputer();
    const { store } = fakeAudit();
    const gateway = createComputerGateway({
      provider,
      fetchImpl,
      auditStore: store,
      policy: () => PERMISSIVE,
    });

    await gateway.snapshot("sales-bot");
    await gateway.click("sales-bot", ACTOR, {
      ref: "e1",
      snapshotId: 7,
    });
    await gateway.read("research-bot");

    expect(addressedAs).toContain("sales-bot");
    expect(addressedAs).toContain("research-bot");
    // A call must never reach a different Bot's computer.
    expect(
      addressedAs.every((id) => id === "sales-bot" || id === "research-bot"),
    ).toBe(true);
  });

  test("a permitted action that FAILS gets its own row, not an allowed one", async () => {
    // A permitted read that later fails path confinement records both the decision and the failed
    // outcome, so the trail does not imply the Bot received the file.
    const { provider, fetchImpl, calls } = fakeComputer({
      routes: {
        "/files/read": () => {
          calls.push("readFile");
          return Response.json(
            { error: "that path is outside your workspace" },
            { status: 403 },
          );
        },
      },
    });
    const { store, rows } = fakeAudit();
    const gateway = createComputerGateway({
      provider,
      fetchImpl,
      auditStore: store,
      policy: () => PERMISSIVE,
    });

    await expect(
      gateway.readFile("bot-1", ACTOR, { path: "../../etc/passwd" }),
    ).rejects.toThrow(WorkspaceRefusedError);

    expect(rows).toHaveLength(2);
    // The decision, then the outcome. Both are needed: the first says it was permitted, the second
    // says it did not happen, and neither on its own is the truth.
    expect(rows[0]?.eventType).toBe("computer.action_allowed");
    expect(rows[1]?.eventType).toBe("computer.action_failed");
    expect(rows[1]?.payload.failure).toContain("outside your workspace");
  });

  test("opening a page is recorded, with the address it was opening", async () => {
    // The target guard refuses forbidden addresses before the request leaves.
    const { gateway, calls, rows } = await gatewayWith(PERMISSIVE);
    await gateway.navigate("bot-1", ACTOR, "https://example.com/");

    expect(calls).toEqual(["navigate"]);
    expect(rows[0]?.eventType).toBe("computer.action_allowed");
    expect(rows[0]?.payload.action).toBe("computer_navigate");
    expect(rows[0]?.payload.page).toBe("https://example.com/");
  });

  test("a rule can refuse a navigation by its DESTINATION host", async () => {
    // The destination, not the page already loaded. Deciding on the current URL would make a rule
    // about where a Bot may go structurally unable to say anything about where it is going.
    const { gateway, calls } = await gatewayWith({
      ...PERMISSIVE,
      deny: ['page.host == "intranet.example.com"'],
    });

    await expect(
      gateway.navigate("bot-1", ACTOR, "https://intranet.example.com/hr"),
    ).rejects.toThrow(ActionRefusedError);
    expect(calls).toEqual([]);

    await gateway.navigate("bot-1", ACTOR, "https://example.com/");
    expect(calls).toEqual(["navigate"]);
  });

  test("an action on an unresolvable ref is still decided and still recorded", async () => {
    const { gateway, rows } = await gatewayWith(PERMISSIVE);
    await gateway.click("bot-1", ACTOR, {
      ref: "e404",
      snapshotId: 7,
    });
    // Permitted here only because the shipped default permits; the row says plainly that the server
    // could not identify what was touched, rather than omitting the field.
    expect(rows[0]?.payload.element).toBe("not in the current snapshot");
  });

  test("stopComputer returns true when the computer was running and audits with the bot id as target", async () => {
    const { gateway, calls, rows } = await gatewayWith(PERMISSIVE, {
      stopResult: { wasRunning: true },
    });

    const result = await gateway.stopComputer("bot-1", ACTOR);

    expect(result).toEqual({ wasRunning: true });
    expect(calls).toContain("stop:bot-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("computer.stopped");
    expect(rows[0]?.targetId).toBe("bot-1");
    expect(rows[0]?.targetType).toBe("computer");
  });

  test("stopComputer preserves wasRunning=false when the computer was already stopped", async () => {
    const { gateway, calls, rows } = await gatewayWith(PERMISSIVE, {
      stopResult: { wasRunning: false },
    });

    const result = await gateway.stopComputer("bot-2", ACTOR);

    expect(result).toEqual({ wasRunning: false });
    expect(calls).toContain("stop:bot-2");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("computer.stopped");
    expect(rows[0]?.targetId).toBe("bot-2");
  });

  test("resetComputer returns true when state was cleared and audits with the bot id as target", async () => {
    const { gateway, calls, rows } = await gatewayWith(PERMISSIVE, {
      resetResult: { cleared: true },
    });

    const result = await gateway.resetComputer("bot-1", ACTOR);

    expect(result).toEqual({ cleared: true });
    expect(calls).toContain("reset:bot-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("computer.reset");
    expect(rows[0]?.targetId).toBe("bot-1");
    expect(rows[0]?.targetType).toBe("computer");
  });

  test("resetComputer preserves cleared=false when provider could not clear state and audits the bot id", async () => {
    const { gateway, calls, rows } = await gatewayWith(PERMISSIVE, {
      resetResult: { cleared: false },
    });

    const result = await gateway.resetComputer("bot-2", ACTOR);

    expect(result).toEqual({ cleared: false });
    expect(calls).toContain("reset:bot-2");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("computer.reset");
    expect(rows[0]?.targetId).toBe("bot-2");
  });

  test("computers maps provider status 'running' and 'stopped' directly and preserves egress distinctions", async () => {
    const locations: ComputerLocation[] = [
      {
        botId: "bot-proxied",
        status: "running",
        startedAt: "2026-08-20T12:00:00.000Z",
        egress: "198.51.100.42",
      },
      {
        botId: "bot-direct",
        status: "stopped",
        startedAt: "2026-08-20T11:00:00.000Z",
        egress: null,
      },
      {
        botId: "bot-unknown-egress",
        status: "stopped",
        startedAt: "2026-08-20T10:00:00.000Z",
        egress: undefined,
      },
    ];
    const { gateway } = await gatewayWith(PERMISSIVE, { locations });

    const result = await gateway.computers();

    expect(result).toEqual({
      isolation: "per-bot",
      computers: [
        {
          botId: "bot-proxied",
          running: true,
          startedAt: "2026-08-20T12:00:00.000Z",
          egress: "198.51.100.42",
        },
        {
          botId: "bot-direct",
          running: false,
          startedAt: "2026-08-20T11:00:00.000Z",
          egress: null,
        },
        {
          botId: "bot-unknown-egress",
          running: false,
          startedAt: "2026-08-20T10:00:00.000Z",
          egress: undefined,
        },
      ],
    });
  });

  test("takes a screenshot through the located computer with its identity and token", async () => {
    const { gateway, requests } = await gatewayWith(PERMISSIVE, {
      token: "computer-secret",
    });

    const result = await gateway.screenshot("bot-1");

    expect(result).toEqual({
      image: "aGVsbG8=",
      mimeType: "image/png",
    });
    const screenshotReq = requests.find((r) => r.url.endsWith("/screenshot"));
    expect(screenshotReq).toBeDefined();
    expect(screenshotReq?.url).toBe("http://agent-computer:4100/screenshot");
    expect(screenshotReq?.init?.headers).toMatchObject({
      "x-openbot-bot-id": "bot-1",
      "x-openbot-computer-token": "computer-secret",
    });
  });

  test("routes acting, control, file, secret, and human input calls to the correct endpoint paths", async () => {
    const { gateway, requests } = await gatewayWith(PERMISSIVE);

    await gateway.key("bot-1", ACTOR, { key: "Tab" });
    await gateway.scroll("bot-1", ACTOR, { deltaY: 400 });
    await gateway.listFiles("bot-1", ACTOR, { path: "notes" });
    await gateway.control("bot-1");
    await gateway.requestHelp("bot-1", ACTOR, "Sign in");
    await gateway.takeControl("bot-1", ACTOR);
    await gateway.releaseControl("bot-1", ACTOR);
    await gateway.requestSecret("bot-1", ACTOR, {
      label: "Password",
      ref: "e1",
      snapshotId: 7,
    });
    await gateway.supplySecret("bot-1", ACTOR, "secret");
    await gateway.humanInput("bot-1", { kind: "click", x: 10, y: 20 });

    const paths = requests.map(({ url }) => new URL(url).pathname);
    expect(paths).toEqual([
      "/snapshot",
      "/key",
      "/scroll",
      "/files/list",
      "/control",
      "/control/request",
      "/control/take",
      "/control/release",
      "/control/secret",
      "/human/secret",
      "/human/click",
    ]);
  });
  /*
   * Through `gatewayWith`, deliberately, rather than by handing `evaluateActionPolicy` a context
   * written here. The bug these cover was that the context the gateway builds and the context the
   * policy tests built were different shapes, so a policy test asserting a browser rule does not
   * refuse a command passed while production refused every click. A test that builds its own context
   * can only ever check the context it built.
   */
  describe("a deny rule that names a field this action does not have", () => {
    test("a command rule does not refuse a click", async () => {
      const { gateway, calls, rows } = await gatewayWith({
        ...PERMISSIVE,
        // The rule the documentation gives as the example.
        deny: ['contains(command, "rm -rf")'],
      });

      await gateway.click("bot-1", ACTOR, { ref: "e9", snapshotId: 7 });

      expect(calls).toEqual(["click"]);
      expect(rows[0]?.eventType).toBe("computer.action_allowed");
    });

    test("a key rule does not refuse a click", async () => {
      const { gateway, calls } = await gatewayWith({
        ...PERMISSIVE,
        deny: ['key == "Enter"'],
      });

      await gateway.click("bot-1", ACTOR, { ref: "e9", snapshotId: 7 });

      expect(calls).toEqual(["click"]);
    });

    test("a file rule does not refuse a click", async () => {
      const { gateway, calls } = await gatewayWith({
        ...PERMISSIVE,
        deny: ['contains(file.path, "secret")'],
      });

      await gateway.click("bot-1", ACTOR, { ref: "e9", snapshotId: 7 });

      expect(calls).toEqual(["click"]);
    });

    test("but the rule still refuses the action it is about", async () => {
      // The point is not that these rules stop working. A neutral value answers honestly; it does
      // not answer no.
      const { gateway, calls, rows } = await gatewayWith({
        ...PERMISSIVE,
        deny: ['key == "Enter"'],
      });

      await expect(
        gateway.key("bot-1", ACTOR, { ref: "e9", snapshotId: 7, key: "Enter" }),
      ).rejects.toThrow();
      expect(calls).toEqual([]);
      expect(rows[0]?.eventType).toBe("computer.action_refused");
    });
  });
});

describe("resolving a computer's address", () => {
  test("a foreign address is refused, so nothing is sent to it", async () => {
    /*
     * The guard exists because the address decides where the deployment's computer token goes. Every
     * acting path resolved through here already; the live-screen socket resolved through the provider
     * directly and skipped it, while putting the token in a query string.
     */
    const { provider, fetchImpl, requests } = fakeComputer();
    const { store } = fakeAudit();
    const gateway = createComputerGateway({
      // The cloud metadata address, which is the answer this guard was written for.
      provider: { ...provider, locate: async () => "http://169.254.169.254" },
      fetchImpl,
      auditStore: store,
      policy: () => PERMISSIVE,
      token: "deployment-token",
    });

    await expect(gateway.locate("bot-1")).rejects.toThrow();
    // Refused before anything was sent, so the token never left.
    expect(requests).toEqual([]);
  });

  test("an address the guard allows is returned", async () => {
    const { provider, fetchImpl } = fakeComputer();
    const { store } = fakeAudit();
    const gateway = createComputerGateway({
      provider,
      fetchImpl,
      auditStore: store,
      policy: () => PERMISSIVE,
    });

    await expect(gateway.locate("bot-1")).resolves.toContain("http");
  });
});

/**
 * The snapshot a ref resolves against is shared between servers, not held in one process.
 *
 * OpenBot runs several server processes behind a load balancer, and the process that answers a
 * snapshot is rarely the one that answers the click that uses its refs. If the mapping from ref to
 * element lives in a `Map`, it is missing on every replica but the one that snapshotted: the policy
 * decides with no element in front of it, and the deny rule the deployment is relying on does not
 * fire. These prove the resolution survives the hop to another replica, which is the whole point of
 * moving it to a store.
 *
 * Two gateways sharing one store stand in for two replicas sharing one database. The store is the
 * only thing they have in common, exactly as Postgres is the only thing two real replicas share.
 */
describe("resolving a ref across replicas", () => {
  function replica(policy: ActionPolicy, snapshots: SnapshotStore) {
    const { provider, fetchImpl, calls } = fakeComputer();
    const { store, rows } = fakeAudit();
    const gateway = createComputerGateway({
      provider,
      fetchImpl,
      auditStore: store,
      policy: () => policy,
      snapshots,
    });
    return { gateway, calls, rows };
  }

  const DENY_SUBMIT: ActionPolicy = {
    ...PERMISSIVE,
    deny: ['contains(element.name, "submit")'],
  };

  test("a click is resolved and refused on a replica that never took the snapshot", async () => {
    const snapshots = createInMemorySnapshotStore();
    const tookSnapshot = replica(DENY_SUBMIT, snapshots);
    const handlesClick = replica(DENY_SUBMIT, snapshots);

    await tookSnapshot.gateway.snapshot("bot-1");

    // e9 is the Submit button. The replica that never snapshotted still resolves it from the store and
    // refuses it. Held in a Map, this gateway's snapshot would be empty, the rule would have no element
    // to match, and the Submit click would go straight through: the boundary silently off on every
    // server but the one that happened to snapshot.
    await expect(
      handlesClick.gateway.click("bot-1", ACTOR, {
        ref: "e9",
        snapshotId: 7,
      }),
    ).rejects.toThrow(ActionRefusedError);
    expect(handlesClick.calls).toEqual([]);
    expect(handlesClick.rows[0]?.eventType).toBe("computer.action_refused");
  });

  test("the resolved element label comes from the store, so any replica can name it", async () => {
    const snapshots = createInMemorySnapshotStore();
    const tookSnapshot = replica(PERMISSIVE, snapshots);
    const handlesClick = replica(PERMISSIVE, snapshots);

    await tookSnapshot.gateway.snapshot("bot-1");
    const result = await handlesClick.gateway.type("bot-1", ACTOR, {
      ref: "e1",
      snapshotId: 7,
      text: "Grace Hopper",
    });

    // The label is resolved on the replica that never saw the page, so the transcript and the trail
    // say what was acted on instead of quoting a ref.
    expect(result.element?.name).toBe("Customer name:");
    expect(handlesClick.rows[0]?.payload.element).toEqual({
      role: "input",
      name: "Customer name:",
      type: "text",
    });
  });

  test("a ref only resolves against the generation it came from", async () => {
    // The store holds snapshot 7, where e9 is Submit. The same ref cited against snapshot 7 resolves;
    // cited against an older snapshot 6 it does not, because the caller is looking at a page that has
    // since moved on and its e9 may be a different control now. Resolving it anyway is the "decide on
    // fiction" a persisted snapshot is rightly warned about; matching the generation is the answer.
    // The computer makes the same check when the action reaches it and refuses a superseded ref there.
    const snapshots = createInMemorySnapshotStore();
    const tookSnapshot = replica(PERMISSIVE, snapshots);
    const handlesClick = replica(PERMISSIVE, snapshots);

    await tookSnapshot.gateway.snapshot("bot-1");

    const current = await handlesClick.gateway.click("bot-1", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });
    expect(current.element?.name).toBe("Submit order");

    const superseded = await handlesClick.gateway.click("bot-1", ACTOR, {
      ref: "e9",
      snapshotId: 6,
    });
    // Not resolved to snapshot 7's Submit button: the ref carried an older generation.
    expect(superseded.element).toBeUndefined();
    expect(handlesClick.rows[1]?.payload.element).toBe(
      "not in the current snapshot",
    );
  });

  test("wiping a computer forgets the snapshot, so a reused generation cannot resolve", async () => {
    // A fresh computer counts generations from one again. If a reset left the row behind, a ref the
    // model was still holding from the previous session would match the new session's first
    // generation and the policy would decide against an element from a page that no longer exists.
    const snapshots = createInMemorySnapshotStore();
    const tookSnapshot = replica(PERMISSIVE, snapshots);
    const handlesClick = replica(PERMISSIVE, snapshots);

    await tookSnapshot.gateway.snapshot("bot-1");
    await tookSnapshot.gateway.resetComputer("bot-1", ACTOR);

    const afterReset = await handlesClick.gateway.click("bot-1", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });
    expect(afterReset.element).toBeUndefined();
  });
});
