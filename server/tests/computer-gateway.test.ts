import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import {
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import type { SnapshotResult } from "../src/computer/schema";
import type { ComputerProvider } from "../src/computer/provider";

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
function fakeComputer() {
  const calls: string[] = [];
  const addressedAs: string[] = [];
  const result = (action: string) => ({
    action,
    url: SNAPSHOT.url,
    elapsedMs: 1,
  });
  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-bot",
    describeIsolation: () => ({
      isolation: "one computer per Bot",
      note: "Test provider.",
    }),
    locate: async (botId) => {
      addressedAs.push(botId);
      return "http://agent-computer:4100";
    },
    status: async (botId) => ({ botId, state: "ready" }),
    stop: async () => {},
    reset: async () => {},
    list: async () => [],
  };
  const fetchImpl = (async (url: string) => {
    const path = new URL(url).pathname;
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
      case "/navigate":
        calls.push("navigate");
        return Response.json({
          url: "https://example.com/",
          title: "Example",
          elapsedMs: 1,
        });
      default: {
        const action = path.slice(1);
        calls.push(action);
        return Response.json(result(action));
      }
    }
  }) as unknown as typeof fetch;
  return { provider, fetchImpl, calls, addressedAs };
}

function fakeAudit() {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  return { store, rows };
}

const ACTOR = { id: "dev-local-user" };
const PERMISSIVE: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

async function gatewayWith(policy: ActionPolicy | undefined) {
  const { provider, fetchImpl, calls } = fakeComputer();
  const { store, rows } = fakeAudit();
  const gateway = createComputerGateway({
    provider,
    fetchImpl,
    auditStore: store,
    policy: () => policy,
  });
  // Every test acts on refs, so the server must hold a snapshot first, exactly as the real flow does.
  await gateway.snapshot("bot-1");
  return { gateway, calls, rows };
}

describe("the computer gateway", () => {
  test("carries out an allowed action and records it", async () => {
    const { gateway, calls, rows } = await gatewayWith(PERMISSIVE);
    await gateway.click("default", "bot-1", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });

    expect(calls).toEqual(["click"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("computer.action_allowed");
  });

  test("a refused action never reaches the computer", async () => {
    const { gateway, calls, rows } = await gatewayWith({
      ...PERMISSIVE,
      deny: ['contains(element.name, "submit")'],
    });

    await expect(
      gateway.click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 }),
    ).rejects.toThrow(ActionRefusedError);

    // The decision happens before the effect.
    expect(calls).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("computer.action_refused");
  });

  test("the refusal names the rule, so an operator can find it", async () => {
    const { gateway } = await gatewayWith({
      ...PERMISSIVE,
      deny: ['contains(element.name, "submit")'],
    });

    const error = await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
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
      gateway.click("default", "bot-1", ACTOR, {
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
    const result = await gateway.type("default", "bot-1", ACTOR, {
      ref: "e1",
      snapshotId: 7,
      text: "Grace Hopper",
    });
    expect(result.element?.name).toBe("Customer name:");
  });

  test("the typed text never enters the audit payload", async () => {
    const { gateway, rows } = await gatewayWith(PERMISSIVE);
    await gateway.type("default", "bot-1", ACTOR, {
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
      gateway.click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 }),
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

    await gateway.click("default", "bot-1", ACTOR, {
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
    await gateway.click("default", "bot-1", ACTOR, {
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
      gateway.readFile("default", "bot-1", ACTOR, {
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
      gateway.readFile("default", "bot-1", ACTOR, { path: "config/prod.env" }),
    ).rejects.toThrow(ActionRefusedError);
    // A different extension in the same folder is untouched by that rule.
    await gateway.readFile("default", "bot-1", ACTOR, {
      path: "config/prod.json",
    });
    expect(calls).toEqual(["readFile"]);
  });

  test("a permitted write happens and is recorded by path, never by contents", async () => {
    const { gateway, calls, rows } = await gatewayWith(PERMISSIVE);
    await gateway.writeFile("default", "bot-1", ACTOR, {
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
    await gateway.click("sales-bot", "sales-bot", ACTOR, {
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
    const { provider, fetchImpl, calls } = fakeComputer();
    const { store, rows } = fakeAudit();
    const failingFetch = (async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === "/files/read") {
        calls.push("readFile");
        return Response.json(
          { error: "that path is outside your workspace" },
          { status: 403 },
        );
      }
      return fetchImpl(url, init);
    }) as typeof fetch;
    const gateway = createComputerGateway({
      provider,
      fetchImpl: failingFetch,
      auditStore: store,
      policy: () => PERMISSIVE,
    });

    await expect(
      gateway.readFile("default", "bot-1", ACTOR, { path: "../../etc/passwd" }),
    ).rejects.toThrow();

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
    await gateway.navigate("default", "bot-1", ACTOR, "https://example.com/");

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
      gateway.navigate(
        "default",
        "bot-1",
        ACTOR,
        "https://intranet.example.com/hr",
      ),
    ).rejects.toThrow(ActionRefusedError);
    expect(calls).toEqual([]);

    await gateway.navigate("default", "bot-1", ACTOR, "https://example.com/");
    expect(calls).toEqual(["navigate"]);
  });

  test("an action on an unresolvable ref is still decided and still recorded", async () => {
    const { gateway, rows } = await gatewayWith(PERMISSIVE);
    await gateway.click("default", "bot-1", ACTOR, {
      ref: "e404",
      snapshotId: 7,
    });
    // Permitted here only because the shipped default permits; the row says plainly that the server
    // could not identify what was touched, rather than omitting the field.
    expect(rows[0]?.payload.element).toBe("not in the current snapshot");
  });

  test("resolves an element from the Bot snapshot when the audit computer id differs", async () => {
    const { provider, fetchImpl } = fakeComputer();
    const { store, rows } = fakeAudit();
    const gateway = createComputerGateway({
      provider,
      fetchImpl,
      auditStore: store,
      policy: () => PERMISSIVE,
    });
    await gateway.snapshot("bot-1");

    await gateway.click("audit-computer-7", "bot-1", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });

    expect(rows[0]?.payload.element).toEqual({
      role: "button",
      name: "Submit order",
    });
  });

});
