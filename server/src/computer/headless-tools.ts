import { z } from "zod";
import { currentApprovalContext } from "../approvals/types";
import { type AuditStore, recordAuditEvent } from "../audit";
import {
  type HeadlessTool,
  HeadlessToolSuspension,
} from "@openbot/toolkit/headless-tools";
import {
  type ActionActor,
  type ComputerGateway,
  HumanHasControlError,
} from "./gateway";
import type { ControlState } from "./schema";

/** What the headless sign-in tool needs from the passwords module. See passwords/service.ts. */
export type HeadlessSignInRequester = {
  request(input: {
    ownerUserId: string;
    botId: string;
    site: string;
    reason?: string;
    actor: ActionActor;
    threadId?: string;
    toolCallId?: string;
    continuation?: Record<string, unknown>;
    notify?: boolean;
  }): Promise<{ id: string; origin: string }>;
};

/** Shared by the headless tool and the browser's registration, so both promise the same thing. */
export const SIGN_IN_TOOL_DESCRIPTION =
  "Ask the person you work for to sign you in to a website. They get a private sign-in form outside this conversation (or take over the browser), and their login is typed straight into your browser by the computer. You never see the username, password or code, and must never ask for them any other way. Open the site's sign-in page first, then call this with the site's address. This turn pauses until they answer; you are then told only whether it worked.";

/** Shipped browser/file/command tools, with identity bound before the model supplies arguments. */
export function createHeadlessComputerTools(options: {
  gateway: ComputerGateway;
  botId: string;
  actor: ActionActor;
  auditStore?: AuditStore;
  /** The private sign-in request. Absent leaves the Bot with help and secret requests only. */
  signIn?: HeadlessSignInRequester;
}): HeadlessTool[] {
  const { gateway, botId, actor, auditStore, signIn } = options;
  const snapshotId = z.number().int().positive();
  const ref = z.string().min(1);
  const text = z.string().min(1);
  const noArgs = z.strictObject({});
  function tool<T extends z.ZodType>(
    name: string,
    description: string,
    schema: T,
    execute: (
      input: z.output<T>,
      context: { toolCallId: string; signal: AbortSignal },
    ) => Promise<unknown>,
  ): HeadlessTool {
    return {
      definition: { name, description, parameters: z.toJSONSchema(schema) },
      execute: async (args, context) => {
        const input = schema.parse(args);
        if (context.signal.aborted)
          throw new Error("The computer action was stopped.");
        try {
          return await execute(input, context);
        } catch (error) {
          if (error instanceof HumanHasControlError) {
            throw new HeadlessToolSuspension(error.message, {
              kind: "computer_handoff",
              botId,
              ...(error.requestId ? { requestId: error.requestId } : {}),
              ...(error.handoff ? { handoff: error.handoff } : {}),
            });
          }
          throw error;
        }
      },
    };
  }
  function waiting(
    state: ControlState,
    reason: string,
    kind = "computer_handoff",
  ): never {
    throw new HeadlessToolSuspension(reason, {
      kind,
      botId,
      ...(state.request
        ? { requestId: state.request.id, handoff: state.request }
        : {}),
    });
  }
  const tools = [
    tool(
      "computer_navigate",
      "Open a web page and return its title and readable text. Use the returned content to answer.",
      z.strictObject({ url: text }),
      async ({ url }, { toolCallId }) => {
        const result = await gateway.navigate(botId, actor, url, toolCallId);
        if (result.challenge)
          throw new HeadlessToolSuspension(result.challenge.reason, {
            kind: "computer_handoff",
            botId,
            requestId: result.challenge.requestId,
            source: result.challenge.kind,
          });
        return { ok: true, ...result };
      },
    ),
    tool(
      "computer_read",
      "Read the currently open browser page without navigating.",
      noArgs,
      async () => ({ ok: true, ...(await gateway.read(botId)) }),
    ),
    tool(
      "computer_snapshot",
      "List fields, buttons and links with refs. Call before clicking or typing and pass the returned snapshotId with every ref. If refs are stale take a fresh snapshot.",
      noArgs,
      async () => ({ ok: true, ...(await gateway.snapshot(botId)) }),
    ),
    tool(
      "computer_screenshot",
      "Return an image of the browser currently open on your computer.",
      noArgs,
      async () => ({ ok: true, ...(await gateway.screenshot(botId)) }),
    ),
    tool(
      "computer_click",
      "Click an element using its ref and snapshotId from the latest snapshot.",
      z.strictObject({ ref, snapshotId }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.click(botId, actor, input, signal)),
      }),
    ),
    tool(
      "computer_type",
      "Replace a field's contents using its ref and snapshotId. Set submit to press Enter afterwards.",
      z.strictObject({
        ref,
        snapshotId,
        text: z.string(),
        submit: z.boolean().optional(),
      }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.type(botId, actor, input, signal)),
      }),
    ),
    tool(
      "computer_key",
      "Press Enter, Tab, Escape or another key on the page. When a ref is given pass its snapshotId.",
      z
        .strictObject({
          key: text,
          ref: ref.optional(),
          snapshotId: snapshotId.optional(),
        })
        .refine((input) => !input.ref || input.snapshotId !== undefined, {
          message: "A snapshotId is required when a ref is given.",
        }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.key(botId, actor, input, signal)),
      }),
    ),
    tool(
      "computer_scroll",
      "Scroll down by pixels, or up with a negative deltaY. Defaults to 600.",
      z.strictObject({ deltaY: z.number().optional() }),
      async (input) => ({
        ok: true,
        ...(await gateway.scroll(botId, actor, input)),
      }),
    ),
    tool(
      "computer_list_files",
      "List files and folders in your workspace. Call first before reading an uncertain filename.",
      z.strictObject({ path: z.string().optional() }),
      async (input) => ({
        ok: true,
        ...(await gateway.listFiles(botId, actor, input)),
      }),
    ),
    tool(
      "computer_read_file",
      "Read a saved file relative to your persistent workspace, such as notes.md.",
      z.strictObject({ path: text }),
      async (input) => ({
        ok: true,
        ...(await gateway.readFile(botId, actor, input)),
      }),
    ),
    tool(
      "computer_write_file",
      "Save text in your workspace. Set append to add to the end of an existing file.",
      z.strictObject({
        path: text,
        contents: z.string(),
        append: z.boolean().optional(),
      }),
      async (input) => ({
        ok: true,
        ...(await gateway.writeFile(botId, actor, input)),
      }),
    ),
    tool(
      "computer_run_command",
      "Run a bash shell command in your workspace. Pipes and && work; long output is truncated and long commands are stopped. For package installation use sudo apt-get; if refused say so rather than retrying.",
      z.strictObject({ command: text }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.runCommand(botId, actor, input, signal)),
      }),
    ),
    tool(
      "computer_request_help",
      "Create a durable request for the person to take the browser and sign in or clear a challenge. This unattended turn pauses until a person helps; never ask them to send you a password.",
      z.strictObject({ reason: text }),
      async ({ reason }, { toolCallId }) =>
        waiting(
          await gateway.requestHelp(botId, actor, reason, toolCallId),
          reason,
        ),
    ),
    tool(
      "computer_request_secret",
      "Ask the person to enter one secret directly into the focused field. Click the field first. You must never receive the secret; this unattended turn pauses for the person.",
      z.strictObject({ label: text, ref, snapshotId }),
      async (input) =>
        waiting(
          await gateway.requestSecret(botId, actor, input),
          `The person must enter ${input.label} directly into the page.`,
          "computer_secret",
        ),
    ),
  ];
  if (signIn)
    tools.push(
      tool(
        "computer_request_sign_in",
        SIGN_IN_TOOL_DESCRIPTION,
        z.strictObject({ site: text, reason: z.string().optional() }),
        async ({ site, reason }, { toolCallId }) => {
          const continuation = currentApprovalContext();
          const request = await signIn.request({
            ownerUserId: actor.userId ?? actor.id,
            botId,
            site,
            ...(reason ? { reason } : {}),
            actor,
            ...(continuation?.threadId
              ? { threadId: continuation.threadId }
              : {}),
            toolCallId,
            ...(continuation
              ? {
                  continuation: continuation as unknown as Record<
                    string,
                    unknown
                  >,
                }
              : {}),
            notify: true,
          });
          throw new HeadlessToolSuspension(
            `Waiting for the person to sign in to ${request.origin} in a private form.`,
            {
              kind: "computer_sign_in",
              botId,
              requestId: request.id,
              signInRequestId: request.id,
              site: request.origin,
            },
          );
        },
      ),
    );
  if (auditStore)
    tools.push(
      tool(
        "report_refusal",
        "Record a request you chose to decline, and why. This records evidence and does not enforce a policy.",
        z.strictObject({ reason: text, request: z.string().optional() }),
        async ({ reason, request }) => {
          await recordAuditEvent(auditStore, {
            eventType: "bot.declined",
            targetType: "agent",
            targetId: botId,
            ...(actor.userId ? { actorUserId: actor.userId } : {}),
            initiator: actor.initiator,
            payload: {
              bot: botId,
              actor: actor.id,
              reason: reason.slice(0, 500),
              ...(request ? { request: request.slice(0, 500) } : {}),
              reportedBy: "the Bot itself",
            },
          });
          return { ok: true, recorded: true };
        },
      ),
    );
  return tools;
}
