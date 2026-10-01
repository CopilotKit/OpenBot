import { expect, test } from "bun:test";
import {
  type ApprovedActionDependencies,
  createApprovedActionExecutor,
} from "../src/approvals/execute";
import { createApprovalService } from "../src/approvals/service";
import { approvalAction } from "../src/approvals/types";

const PERSON = { kind: "person" as const, id: "" };

function continuation(toolName: string, args: Record<string, unknown>) {
  return {
    runId: "run",
    threadId: "thread",
    toolCallId: "call",
    toolName,
    args,
    messages: [],
    state: {},
    context: [],
    forwardedProps: {},
  };
}

function harness(overrides: Partial<ApprovedActionDependencies> = {}) {
  const calls: unknown[] = [];
  const coordination: unknown[] = [];
  const deps = {
    sourceFor: async () => ({ channelId: "channel" }),
    gate: async () => undefined,
    computerTools: async () => [],
    hostTools: () => [],
    callTool: async (input: unknown) => {
      calls.push(input);
      return { text: "sent", isError: false };
    },
    answer: (result: { text: string }) => result.text,
    privateShareToolRef: "openbot/private_share",
    refusalMarker: "REFUSED:",
    personInitiator: PERSON,
    coordinationCall: async (input: unknown) => {
      coordination.push(input);
      return { text: "Handed over to Research Desk.", isError: false };
    },
    credentialActorFor: async () => "owner-of-team-bot",
    ...overrides,
  } as ApprovedActionDependencies;
  return { execute: createApprovedActionExecutor(deps), calls, coordination };
}

test("an approved hand-off is carried out by the coordination tool, not as a connector call", async () => {
  const args = { bot: "research-desk", task: "Define AG-UI" };
  const action = approvalAction({
    actorId: "person",
    botId: "general",
    toolRef: "bot/message_bot",
    effect: "delegate",
    scope: "research-desk",
    args,
    target: { bot: "research-desk" },
    continuation: continuation("message_bot", args),
  });
  const { execute, calls, coordination } = harness();
  await expect(execute(action)).resolves.toBe("Handed over to Research Desk.");
  expect(calls).toHaveLength(0);
  expect(coordination).toEqual([
    {
      name: "message_bot",
      args,
      run: {
        actorId: "person",
        botId: "general",
        runId: "run",
        threadId: "thread",
        depth: 0,
        initiator: PERSON,
      },
    },
  ]);
});

test("an approved connector call goes out on the account the Team Bot's credential rules choose", async () => {
  const args = { to: "a@example.test", body: "hello" };
  const action = approvalAction({
    actorId: "teammate",
    botId: "team-bot",
    toolRef: "gmail/send_email",
    effect: "write",
    scope: "gmail",
    args,
    target: { serverId: "gmail", toolName: "send_email" },
    continuation: continuation("gmail_send_email", args),
  });
  const { execute, calls } = harness();
  await execute(action);
  expect(calls).toEqual([
    expect.objectContaining({
      ref: "gmail/send_email",
      actorId: "teammate",
      credentialActorId: "owner-of-team-bot",
    }),
  ]);
});

test("a connector refusal during an approved action's re-check is a refusal the Bot is told, not a retryable failure", async () => {
  const { PluginRefusedError } = await import("../src/plugins/store");
  const { ApprovalRefusedError } = await import("../src/approvals/types");
  const args = { to: "a@example.test" };
  const action = approvalAction({
    actorId: "person",
    botId: "bot",
    toolRef: "gmail/send_email",
    effect: "write",
    scope: "gmail",
    args,
    continuation: continuation("gmail_send_email", args),
  });
  const { execute } = harness({
    callTool: async () => {
      throw new PluginRefusedError(
        "This Bot is not granted gmail/send_email.",
        null,
      );
    },
  });
  await expect(execute(action)).rejects.toBeInstanceOf(ApprovalRefusedError);
});

test("re-checking an approved Team Bot call does not spend the teammate's one-time consent", async () => {
  const service = createApprovalService({} as never);
  const args = { to: "a@example.test", body: "hello" };
  const candidate = {
    actorId: "teammate",
    botId: "team-bot",
    toolRef: "gmail/send_email",
    effect: "write" as const,
    scope: "gmail",
    args,
    target: { serverId: "gmail", toolName: "send_email" },
    continuation: continuation("gmail_send_email", args),
  };
  const action = approvalAction(candidate);
  // A one-time consent: the first resolution spends it, any later one is refused.
  let consents = 1;
  const { execute, calls } = harness({
    credentialActorFor: async () => {
      if (consents-- <= 0)
        throw new Error("This Team Bot wants to use your own gmail account.");
      return "teammate";
    },
    // As the plugin store does: the approval gate first, then the call. Under the re-check the gate
    // reports the action instead of letting it act.
    callTool: async (input: unknown) => {
      await service.gate(candidate).catch((error: Error) => {
        if (error.constructor.name === "ApprovalValidated") throw error;
      });
      calls.push(input);
      return { text: "sent", isError: false };
    },
  });
  await service.validateReentry(action, () => execute(action));
  await execute(action);
  // One call went out, on the teammate's own account, and the consent was spent by it alone.
  expect(calls).toEqual([
    expect.objectContaining({ ref: "gmail/send_email", actorId: "teammate" }),
  ]);
  expect(consents).toBe(0);
});
