import { randomUUID } from "node:crypto";
import { DECLINED_BY_PERSON } from "@openbot/shared/approval-outcomes";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { z } from "zod";
import {
  ApprovalAlreadyAnsweredError,
  ApprovalRefusedError,
} from "../approvals/types";
import {
  type AuditEventType,
  type AuditInitiator,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
import { currentEdition } from "../edition";
import { REFUSAL_MARKER } from "../plugins/tools";
import { type HostAccessBroker, HostAccessRefusedError } from "./broker";

const empty = z.object({});

const grantPath = z.object({
  grantId: z.string().min(1),
  path: z.string().optional(),
});

const readFile = z.object({
  grantId: z.string().min(1),
  path: z.string().min(1),
});

const writeFile = z.object({
  grantId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
});

const runCommand = z.object({
  grantId: z.string().min(1),
  path: z.string().optional(),
  command: z.string().min(1),
  writable: z.boolean().optional(),
});

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result ?? {});
}

/**
 * What the desktop answers when the person presses Deny on its own dialog (`DECLINED` in
 * `desktop_host_access.rs`). The sentence it used before is kept, for a desktop older than this
 * server. Exported for the test that holds the two sides together.
 */
export const DENIED_ON_DESKTOP: ReadonlySet<string> = new Set([
  "Declined in OpenBot Desktop.",
  "The local owner denied this operation.",
]);

type Outcome = "allowed" | "refused" | "failed" | "stopped";

/**
 * A folder action is an action on a computer, this one, and is recorded as one: the same event
 * types and payload a cloud computer's actions have, under the `host/` names Activity, Approvals and
 * Action Recording already read (`host/read_file` reads "Read a file"). Recorded as
 * `configuration.changed`, every file a Bot read and every command it ran read "Change a setting",
 * started by a person, and a person's Deny was missing from Blocked.
 */
const EVENT_FOR: Record<Outcome, AuditEventType> = {
  allowed: "computer.action_allowed",
  refused: "computer.action_refused",
  failed: "computer.action_failed",
  stopped: "computer.action_stopped",
};

type HostAudit = {
  auditStore?: AuditStore;
  initiator?: AuditInitiator;
  actorId: string;
  botId: string;
  operation: string;
  grantId?: string;
  /** The folder by the name Settings > Computer shows, never only the grant's id. */
  folder?: string;
  /** The file, relative to the folder granted. Never its contents. */
  file?: string;
  /** The command, in full, as a computer's is. Never its output. */
  command?: string;
};

async function auditHostAccess(
  options: HostAudit,
  input: {
    outcome: Outcome;
    /** One id for the row written as the action went to the desktop and the one that ends it. */
    attempt?: string;
    reason?: string;
  },
) {
  if (!options.auditStore) return;
  const reason = input.reason?.slice(0, 240);
  await recordAuditEvent(options.auditStore, {
    eventType: EVENT_FOR[input.outcome],
    targetType: "host_access",
    ...(options.grantId ? { targetId: options.grantId } : {}),
    actorUserId: options.actorId,
    ...(options.initiator ? { initiator: options.initiator } : {}),
    payload: {
      action: `host/${options.operation}`,
      bot: options.botId,
      actor: options.actorId,
      ...(options.grantId ? { grant: options.grantId } : {}),
      ...(options.folder ? { folder: options.folder } : {}),
      ...(options.file ? { file: options.file } : {}),
      ...(options.command ? { command: options.command } : {}),
      ...(input.attempt ? { attempt: input.attempt } : {}),
      // A person's Deny, on the desktop or in the conversation, reads as theirs.
      ...(input.outcome === "refused" &&
      ((input.reason !== undefined && DENIED_ON_DESKTOP.has(input.reason)) ||
        input.reason === DECLINED_BY_PERSON)
        ? { refusal: "person_declined" }
        : {}),
      ...(input.outcome === "refused" && reason ? { reason } : {}),
      ...((input.outcome === "failed" || input.outcome === "stopped") && reason
        ? { failure: reason }
        : {}),
    },
  });
}

/**
 * Runs one folder action and records it: a row as it goes to the desktop, after every check has
 * passed, and a second with the same `attempt` only when the desktop refused it, it failed or it was
 * stopped. A refusal before it reached the desktop is one refused row. A turn that stops to ask the
 * person writes nothing until it is answered.
 */
async function answer(
  audit: HostAudit,
  run: (hooks: { onDispatch: () => Promise<void> }) => Promise<unknown>,
): Promise<string> {
  let attempt: string | undefined;
  try {
    const result = await run({
      onDispatch: () => {
        attempt = randomUUID();
        return auditHostAccess(audit, { outcome: "allowed", attempt });
      },
    });
    return resultText(result);
  } catch (error) {
    if (error instanceof HeadlessToolSuspension) throw error;
    const reason =
      error instanceof Error ? error.message : "That host operation failed.";
    // Answered already, as it was then. Nothing new was turned away, so nothing new is recorded.
    if (!(error instanceof ApprovalAlreadyAnsweredError))
      await auditHostAccess(audit, {
        outcome:
          error instanceof HostAccessRefusedError
            ? reason.toLowerCase().includes("stop")
              ? "stopped"
              : "refused"
            : error instanceof ApprovalRefusedError
              ? "refused"
              : "failed",
        ...(attempt ? { attempt } : {}),
        reason,
      });
    if (error instanceof HostAccessRefusedError) {
      return `${REFUSAL_MARKER} ${error.message}`;
    }
    return `That host operation could not be completed: ${reason}`;
  }
}

/**
 * What "Check your folders" answers when this Bot has no folder: shown on the step as it is, and
 * read by the model, which repeats it. Folder access is session-only, so after OpenBot restarts every
 * Bot lands here. Found on Windows: "No host folders are granted to this Bot." read as jargon, and
 * the model, given no next step, told the person "an administrator can restore the folder grant",
 * when in the personal edition (the one OpenBot Desktop runs) nobody but the person chooses a folder.
 */
export function noFolders(): string {
  return currentEdition() === "personal"
    ? "This Bot has no folders it can read right now. Folder access ends when you stop OpenBot. To give it a folder, use Choose folder in Settings → Computer."
    : "This Bot has no folders it can read right now. Folder access ends when OpenBot stops. An admin gives a Bot a folder with Choose folder in Admin → Computers.";
}

export function hostAccessTools(options: {
  broker: HostAccessBroker;
  botId: string;
  actorId: string;
  auditStore?: AuditStore;
  initiator?: AuditInitiator;
}): GrantedTool[] {
  const { broker, botId, actorId } = options;
  const status = broker.statusFor(actorId);
  const grants = status.grants.filter(
    (grant) => grant.botId === botId && !grant.revoked,
  );
  const audit = (
    operation: string,
    grantId?: string,
    target: { file?: string; command?: string } = {},
  ): HostAudit => ({
    auditStore: options.auditStore,
    initiator: options.initiator,
    actorId,
    botId,
    operation,
    ...(grantId ? { grantId } : {}),
    ...(() => {
      const folder = grants.find((grant) => grant.id === grantId)?.displayName;
      return folder ? { folder } : {};
    })(),
    // The folder itself is no file to name.
    ...(target.file && target.file !== "." ? { file: target.file } : {}),
    ...(target.command ? { command: target.command } : {}),
  });

  const tools: GrantedTool[] = [
    {
      name: "host_list_folders",
      ref: "host-access/list_folders",
      description:
        "List the host folders this person has explicitly granted to this Bot, including the grantId to use with host file and command tools.",
      parameters: empty,
      execute: async () => {
        if (grants.length === 0) {
          const reason = noFolders();
          await auditHostAccess(audit("list_folders"), {
            outcome: "refused",
            reason,
          });
          return `${REFUSAL_MARKER} ${reason}`;
        }
        await auditHostAccess(audit("list_folders"), { outcome: "allowed" });
        return JSON.stringify({
          connected: status.connected,
          folders: grants.map((grant) => ({
            grantId: grant.id,
            displayName: grant.displayName,
          })),
        });
      },
    },
  ];

  if (!status.connected || grants.length === 0) return tools;

  tools.push(
    {
      name: "host_list_files",
      ref: "host-access/list_files",
      description:
        "List files in a host folder this person granted to this Bot. First call host_list_folders for grantId values.",
      parameters: grantPath,
      execute: async (args) => {
        const parsed = grantPath.parse(args ?? {});
        return answer(
          audit("list_files", parsed.grantId, { file: parsed.path }),
          (hooks) =>
            broker.callHost(
              {
                kind: "list_files",
                botId,
                actorId,
                grantId: parsed.grantId,
                relativePath: parsed.path ?? ".",
              },
              hooks,
            ),
        );
      },
    },
    {
      name: "host_read_file",
      ref: "host-access/read_file",
      description:
        "Read one file from a granted host folder. Use only paths relative to that folder.",
      parameters: readFile,
      execute: async (args) => {
        const parsed = readFile.parse(args ?? {});
        return answer(
          audit("read_file", parsed.grantId, { file: parsed.path }),
          (hooks) =>
            broker.callHost(
              {
                kind: "read_file",
                botId,
                actorId,
                grantId: parsed.grantId,
                relativePath: parsed.path,
              },
              hooks,
            ),
        );
      },
    },
    {
      name: "host_write_file",
      ref: "host-access/write_file",
      description:
        "Request an exact native-owner-confirmed file write in a granted host folder. The native app backs up the original and refuses unless the owner approves this operation.",
      parameters: writeFile,
      execute: async (args) => {
        const parsed = writeFile.parse(args ?? {});
        return answer(
          audit("write_file", parsed.grantId, { file: parsed.path }),
          (hooks) =>
            broker.callHost(
              {
                kind: "write_file",
                botId,
                actorId,
                grantId: parsed.grantId,
                relativePath: parsed.path,
                content: parsed.content,
              },
              hooks,
            ),
        );
      },
    },
    {
      name: "host_run_command",
      ref: "host-access/run_command",
      description:
        "Request an exact native-owner-confirmed shell command in the offline sandbox for a granted host folder. Set writable true only if the command needs write access; native still prompts before running.",
      parameters: runCommand,
      execute: async (args) => {
        const parsed = runCommand.parse(args ?? {});
        return answer(
          audit("run_command", parsed.grantId, { command: parsed.command }),
          (hooks) =>
            broker.callHost(
              {
                kind: "run_command",
                botId,
                actorId,
                grantId: parsed.grantId,
                relativePath: parsed.path,
                command: parsed.command,
                writable: parsed.writable === true,
              },
              hooks,
            ),
        );
      },
    },
  );

  return tools.map((tool) => ({ ...tool, initiator: options.initiator }));
}
