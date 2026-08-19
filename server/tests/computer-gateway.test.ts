import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ComputerClient } from "../src/computer/client";
import {
  ActionNeedsApprovalError,
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import type { SnapshotResult } from "../src/computer/schema";

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

/** A client that records what reached it, so "did not reach the computer" is checkable. */
function fakeClient() {
  const calls: string[] = [];
  /** Which Bot the gateway addressed the computer as, per call. */
  const addressedAs: string[] = [];
  const result = (action: string) => ({
    action,
    url: SNAPSHOT.url,
    elapsedMs: 1,
  });
  const client = {
    snapshot: async () => SNAPSHOT,
    read: async () => ({
      url: SNAPSHOT.url,
      title: "Order",
      text: "",
      truncated: false,
    }),
    click: async () => {
      calls.push("click");
      return result("click") as never;
    },
    type: async () => {
      calls.push("type");
      return result("type") as never;
    },
    key: async () => {
      calls.push("key");
      return result("key") as never;
    },
    scroll: async () => {
      calls.push("scroll");
      return result("scroll") as never;
    },
    readFile: async () => {
      calls.push("readFile");
      return {
        path: "notes.md",
        text: "kept",
        truncated: false,
        bytes: 4,
      } as never;
    },
    writeFile: async () => {
      calls.push("writeFile");
      return { path: "notes.md", bytes: 4, appended: false } as never;
    },
    status: async () => ({ botId: "b", state: "ready" as const }),
    navigate: async () => {
      calls.push("navigate");
      return { url: "https://example.com/", title: "Example" } as never;
    },
    screenshot: async () => ({}) as never,
    /**
     * The per-Bot view. Recorded rather than ignored, so a test can prove the gateway told the
     * computer which Bot is asking, the thing every per-Bot behaviour on the far side keys off.
     */
    forBot(botId: string) {
      addressedAs.push(botId);
      return client;
    },
  } as unknown as ComputerClient;
  return { client, calls, addressedAs };
}

function fakeAudit() {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  return { store, rows };
}

const ACTOR = { id: "dev-local-user" };
/** A second person, with a real users row, so the approval rows can be told apart by who wrote them. */
const MANAGER = { id: "manager-user", userId: "manager-user" };
const PERMISSIVE: ActionPolicy = {
  mode: "enforce",
  deny: [],
  ask: [],
  allow: ["true"],
};

async function gatewayWith(policy: ActionPolicy | undefined) {
  const { client, calls } = fakeClient();
  const { store, rows } = fakeAudit();
  // The registry the deployment shares between everything that can ask. Held here so these tests can
  // answer a question the way a person does, without going through the surface they answer it on;
  // that surface has its own tests.
  const approvals = createApprovalRegistry();
  const gateway = createComputerGateway({
    client,
    auditStore: store,
    policy: () => policy,
    approvals,
  });
  // Every test acts on refs, so the server must hold a snapshot first, exactly as the real flow does.
  await gateway.snapshot("default");
  return { gateway, approvals, calls, rows };
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
      ask: [],
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
    const { client, addressedAs } = fakeClient();
    const { store } = fakeAudit();
    const gateway = createComputerGateway({
      client,
      auditStore: store,
      policy: () => PERMISSIVE,
    });

    await gateway.snapshot("sales-bot");
    await gateway.click("sales-bot", "sales-bot", ACTOR, "e1");
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
    const { client, calls } = fakeClient();
    const { store, rows } = fakeAudit();
    const failing: ComputerClient = {
      ...client,
      readFile: async () => {
        calls.push("readFile");
        throw new Error("that path is outside your workspace");
      },
      forBot: () => failing,
    } as unknown as ComputerClient;
    const gateway = createComputerGateway({
      client: failing,
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
    // The target guard refuses a forbidden address inside the
    // client and nothing was written, so an attempt on the cloud metadata endpoint left no row while
    // ticking a radio button left one.
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
});

/**
 * The path where the boundary stops and asks.
 *
 * Everything above proves the gateway can say yes or no. These prove it can say "not yet", which is
 * a harder thing to get right: the action must not reach the computer, the trail must show the
 * question rather than a verdict nobody reached, and the answer must only work for the action it was
 * given for. That last one is why the error carries an id at all.
 */
describe("the gateway when the boundary asks a person", () => {
  const ASKING: ActionPolicy = {
    mode: "enforce",
    deny: [],
    ask: ['contains(element.name, "submit")'],
    allow: ["true"],
  };

  test("stops the action and asks, rather than refusing it", async () => {
    const { gateway, calls, rows } = await gatewayWith(ASKING);

    const error = await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ActionNeedsApprovalError);
    // Not a refusal. A Bot told it was blocked gives up and says so; this one is meant to wait.
    expect(error).not.toBeInstanceOf(ActionRefusedError);
    expect(calls).toEqual([]);

    // One row, and it is the question. Nothing was allowed and nothing was refused, so writing
    // either would put a verdict in the trail that the policy never reached.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("approval.requested");
    expect(rows[0]?.payload.rule).toBe('contains(element.name, "submit")');
    expect(rows[0]?.payload.action).toBe("computer_click");
    expect(rows[0]?.payload.approval).toBe(
      (error as ActionNeedsApprovalError).approvalId,
    );
  });

  test("carries the action out once a person has allowed it", async () => {
    const { gateway, approvals, calls, rows } = await gatewayWith(ASKING);
    const asked = (await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;

    approvals.answer(asked.approvalId, "bot-1", MANAGER.id, true);
    await gateway.click(
      "default",
      "bot-1",
      ACTOR,
      { ref: "e9", snapshotId: 7 },
      undefined,
      asked.approvalId,
    );

    expect(calls).toEqual(["click"]);
    // Two rows here, and the third is written where the answer was given: the question, and the
    // action it turned into. The action's own row says a person stood behind it and names them,
    // rather than reading as an ordinary permission nobody ever questioned.
    expect(rows.map((row) => row.eventType)).toEqual([
      "approval.requested",
      "computer.action_allowed",
    ]);
    const decision = rows[1]?.payload.decision as {
      source?: string;
      approvedBy?: string;
    };
    expect(decision.source).toBe("ask");
    expect(decision.approvedBy).toBe("manager-user");
  });

  test("an approval for one action does not carry to another", async () => {
    // The grant is bound to a fingerprint of the exact call. Pressing a different thing on the same
    // page with the same id in hand asks again rather than going through, which is the difference
    // between an approval and a token good for anything.
    const { gateway, approvals, calls } = await gatewayWith({
      ...ASKING,
      ask: ["true"],
    });
    const asked = (await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;
    approvals.answer(asked.approvalId, "bot-1", MANAGER.id, true);

    await expect(
      gateway.click(
        "default",
        "bot-1",
        ACTOR,
        { ref: "e1", snapshotId: 7 },
        undefined,
        asked.approvalId,
      ),
    ).rejects.toThrow(ActionNeedsApprovalError);
    expect(calls).toEqual([]);
  });

  test("a declined request asks again rather than acting", async () => {
    const { gateway, approvals, calls, rows } = await gatewayWith(ASKING);
    const asked = (await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;

    approvals.answer(asked.approvalId, "bot-1", MANAGER.id, false);
    await expect(
      gateway.click(
        "default",
        "bot-1",
        ACTOR,
        { ref: "e9", snapshotId: 7 },
        undefined,
        asked.approvalId,
      ),
    ).rejects.toThrow(ActionNeedsApprovalError);

    expect(calls).toEqual([]);
    // A No leaves a second question rather than a refusal row: nobody has agreed to this, and the
    // trail says so where it happened.
    expect(rows[1]?.eventType).toBe("approval.requested");
  });

  test("a type call that will press Enter is judged as one that submits", async () => {
    // The third door into a form. The computer presses Enter itself when the Bot asks it to, so no
    // keypress ever reaches the gateway as an action of its own, and a boundary written about
    // clicking and about `key` let the one call that submits a single-field form through.
    const { gateway, calls } = await gatewayWith({
      ...PERMISSIVE,
      ask: ["submit"],
    });

    await expect(
      gateway.type("default", "bot-1", ACTOR, {
        ref: "e1",
        snapshotId: 7,
        text: "SW1A 1AA",
        submit: true,
      }),
    ).rejects.toThrow(ActionNeedsApprovalError);
    expect(calls).toEqual([]);

    // Filling the same field in without submitting is not the same action and is not asked about.
    await gateway.type("default", "bot-1", ACTOR, {
      ref: "e1",
      snapshotId: 7,
      text: "SW1A 1AA",
    });
    expect(calls).toEqual(["type"]);
  });

  test("an answer given for typing is not spendable on typing and submitting", async () => {
    // Submitting is the escalation the binding has to cover: "yes, fill the postcode in" is not
    // "yes, fill it in and send the form".
    const { gateway, approvals, calls } = await gatewayWith({
      ...PERMISSIVE,
      ask: ["true"],
    });
    const asked = (await gateway
      .type("default", "bot-1", ACTOR, {
        ref: "e1",
        snapshotId: 7,
        text: "SW1A 1AA",
      })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;
    approvals.answer(asked.approvalId, "bot-1", MANAGER.id, true);

    await expect(
      gateway.type(
        "default",
        "bot-1",
        ACTOR,
        { ref: "e1", snapshotId: 7, text: "SW1A 1AA", submit: true },
        undefined,
        asked.approvalId,
      ),
    ).rejects.toThrow(ActionNeedsApprovalError);
    expect(calls).toEqual([]);
  });

  test("the question is visible to the surface while it is open", async () => {
    const { gateway, approvals } = await gatewayWith(ASKING);
    const asked = (await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;

    const waiting = approvals.pending("bot-1");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.id).toBe(asked.approvalId);
    expect(waiting[0]?.question).toContain("Submit order");
    // Another Bot's screen must not offer somebody a question about this one's computer.
    expect(approvals.pending("bot-2")).toEqual([]);
  });

  test("dry-run records the question and lets the action through", async () => {
    // Dry-run promises a policy that changes nothing, so an ask rule under it interrupts nobody. The
    // row is what an operator switched dry-run on to read.
    const { gateway, calls, rows } = await gatewayWith({
      ...ASKING,
      mode: "dry-run",
    });

    await gateway.click("default", "bot-1", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });

    expect(calls).toEqual(["click"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("computer.action_refused");
    const decision = rows[0]?.payload.decision as {
      source?: string;
      carriedOut?: boolean;
    };
    expect(decision.source).toBe("ask");
    expect(decision.carriedOut).toBe(true);
  });

  test("a deny beats an ask on the same action", async () => {
    // Precedence, through the gateway rather than only in the evaluator: a forbidden thing is refused
    // outright and is never put in front of a person as a question they could say yes to.
    const { gateway, calls, rows } = await gatewayWith({
      ...ASKING,
      deny: ['contains(element.name, "submit")'],
    });

    await expect(
      gateway.click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 }),
    ).rejects.toThrow(ActionRefusedError);
    expect(calls).toEqual([]);
    expect(rows[0]?.eventType).toBe("computer.action_refused");
  });

  test("a file write can be held back the same way a click can", async () => {
    const { gateway, calls, rows } = await gatewayWith({
      mode: "enforce",
      deny: [],
      ask: ['intent == "write_file" && !matches(file.path, "^notes/")'],
      allow: ["true"],
    });

    await expect(
      gateway.writeFile("default", "bot-1", ACTOR, {
        path: "reports/august.csv",
        contents: "anything",
      }),
    ).rejects.toThrow(ActionNeedsApprovalError);
    expect(calls).toEqual([]);
    expect(rows[0]?.payload.file).toBe("reports/august.csv");

    // A path the rule leaves alone still goes straight through, or the rule would be a deny wearing
    // a different name.
    await gateway.writeFile("default", "bot-1", ACTOR, {
      path: "notes/today.md",
      contents: "anything",
    });
    expect(calls).toEqual(["writeFile"]);
  });
});
