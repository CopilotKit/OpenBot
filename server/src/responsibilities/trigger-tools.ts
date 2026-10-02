/**
 * Chat tools for event triggers, served by the builtin Routines transport beside the routine tools
 * (`plugins/builtin-routines.ts`), so the same catalogue grant governs them and the write tools are
 * classified as writes there.
 *
 * Owner and Bot come from the signed run's connection, never from arguments: a Bot may only manage
 * triggers on its own person's responsibilities that it carries out. SECRETS NEVER REACH THE MODEL:
 * a generated key is dropped from the tool result, and there is no argument through which a
 * provider secret could be pasted into a chat. The answer gives the URL and sends the person to the
 * responsibility's card for the key.
 */
import { inboundAddressFor } from "./email";
import type { TriggerStore } from "./triggers";
import {
  ResponsibilityNotFoundError,
  ResponsibilityRefusedError,
  type ResponsibilityStore,
} from "./types";

type McpToolShape = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type TriggerToolDeps = {
  triggers: Pick<
    TriggerStore,
    "create" | "listForAgent" | "setEnabled" | "remove"
  >;
  responsibilities: Pick<ResponsibilityStore, "get">;
  /** Public origin for absolute URLs, e.g. https://openbot.example.com. */
  publicUrl?: string | null;
  emailDomain?: string | null;
};

let installed: TriggerToolDeps | null = null;
export function useTriggerTools(deps: TriggerToolDeps | null) {
  installed = deps;
}

const stringList = {
  type: "array",
  items: { type: "string" },
} as const;
const id = {
  type: "object",
  properties: {
    id: { type: "string", description: "The trigger id, from list_triggers." },
  },
  required: ["id"],
};

export const TRIGGER_TOOLS: readonly McpToolShape[] = Object.freeze([
  {
    name: "create_trigger",
    description: [
      "Add an event trigger to one of this person's responsibilities that you carry out, so an outside",
      "event starts a real run of it. Kinds: `webhook` (any system POSTs to a URL), `github`, `linear`,",
      "`sentry`, `pagerduty` (the vendor's signed webhook), `email` (mail to a dedicated address), `slack`",
      "(messages in Slack channels the person is in).",
      "",
      "Narrow it: `eventTypes` such as `issues.opened`, `Issue.create`, `issue.created`,",
      "`incident.triggered` (a prefix like `issues` matches every issues event), and optionally one",
      "`fieldPath`/`fieldEquals` pair such as `data.team.key` = `ENG`.",
      "",
      "You never see or handle a secret. The result gives the URL (or address); tell the person to open",
      "the responsibility's card on the Responsibilities page to copy the key, or to paste the vendor's",
      "signing secret there for Linear, Sentry and PagerDuty. Never ask them to paste a secret into chat.",
      "",
      "Slack needs `teamId` and `mode` (`mention`, `phrase` with `phrases`, `reaction` with optional",
      "`reactions`, or `message`), optional `channels` (Slack channel ids; empty is every channel the Bot",
      "is in). It is refused unless the person has linked their own Slack account in that workspace and",
      "is a member of each channel.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        responsibilityId: {
          type: "string",
          description: "The responsibility's id, from list_responsibilities.",
        },
        kind: {
          type: "string",
          enum: [
            "webhook",
            "github",
            "linear",
            "sentry",
            "pagerduty",
            "email",
            "slack",
          ],
        },
        eventTypes: { ...stringList, description: "Empty means every event." },
        fieldPath: { type: "string" },
        fieldEquals: { type: "string" },
        repository: {
          type: "string",
          description: "GitHub only: owner/name to lock to.",
        },
        allowedSenders: {
          ...stringList,
          description: "Email only: addresses or domains.",
        },
        teamId: { type: "string", description: "Slack only: T…" },
        mode: {
          type: "string",
          enum: ["mention", "phrase", "reaction", "message"],
        },
        phrases: stringList,
        reactions: stringList,
        channels: stringList,
      },
      required: ["responsibilityId", "kind"],
    },
  },
  {
    name: "list_triggers",
    description:
      "List the event triggers on this person's responsibilities that you carry out: id, kind, responsibility, what it listens for, whether it is paused, and its URL or address. Keys are never listed.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pause_trigger",
    description:
      "Pause one trigger: deliveries are acknowledged but start no run until it is resumed.",
    inputSchema: id,
  },
  {
    name: "resume_trigger",
    description: "Resume a paused trigger.",
    inputSchema: id,
  },
  {
    name: "delete_trigger",
    description:
      "Delete one trigger for good. Its URL stops working and its key is revoked.",
    inputSchema: id,
  },
]);
export const TRIGGER_WRITE_TOOLS = [
  "create_trigger",
  "pause_trigger",
  "resume_trigger",
  "delete_trigger",
] as const;
export const isTriggerTool = (name: string) =>
  TRIGGER_TOOLS.some((tool) => tool.name === name);

const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
const str = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function where(
  deps: TriggerToolDeps,
  trigger: { id: string; kind: string },
): string {
  if (trigger.kind === "slack") return "listens through the Slack pairing";
  if (trigger.kind === "email")
    return deps.emailDomain
      ? `address ${inboundAddressFor(trigger.id, deps.emailDomain)}`
      : "inbound email is not configured on this deployment yet";
  return `POST to ${deps.publicUrl ?? ""}/api/events/triggers/${trigger.id}`;
}

/** Returns the text for the model, or throws a refusal/not-found for the transport to phrase. */
export async function callTriggerTool(
  ownerUserId: string,
  agentId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const deps = installed;
  if (!deps)
    throw new ResponsibilityRefusedError(
      "Triggers are not available in this deployment.",
    );
  const mine = async (triggerId: string | undefined) => {
    const found = (await deps.triggers.listForAgent(ownerUserId, agentId)).find(
      (trigger) => trigger.id === triggerId,
    );
    if (!found) throw new ResponsibilityNotFoundError();
    return found;
  };
  if (name === "list_triggers") {
    const all = await deps.triggers.listForAgent(ownerUserId, agentId);
    if (all.length === 0)
      return "There are no triggers on your responsibilities for me.";
    return all
      .map(
        (trigger) =>
          `- ${trigger.kind} on "${trigger.title}" (responsibility ${trigger.responsibilityId}) · ${
            trigger.enabled ? "active" : "paused"
          } · ${where(deps, trigger)} · listens for ${JSON.stringify(
            trigger.config.kind === "slack"
              ? { mode: trigger.config.mode, channels: trigger.config.channels }
              : trigger.config.filter,
          )} · id: ${trigger.id}`,
      )
      .join("\n");
  }
  if (name === "create_trigger") {
    const responsibilityId = str(args.responsibilityId);
    if (!responsibilityId)
      throw new ResponsibilityRefusedError(
        "Say which responsibility, by its id.",
      );
    const goal = await deps.responsibilities.get(ownerUserId, responsibilityId);
    if (goal.agentId !== agentId) throw new ResponsibilityNotFoundError();
    const kind = str(args.kind);
    const fieldPath = str(args.fieldPath);
    const fieldEquals = str(args.fieldEquals);
    const filter = {
      eventTypes: strings(args.eventTypes),
      ...(fieldPath && fieldEquals
        ? { field: { path: fieldPath, equals: fieldEquals } }
        : {}),
    };
    const config =
      kind === "slack"
        ? {
            kind,
            teamId: str(args.teamId),
            mode: str(args.mode),
            phrases: strings(args.phrases),
            reactions: strings(args.reactions),
            channels: strings(args.channels),
          }
        : kind === "github"
          ? {
              kind,
              filter,
              ...(str(args.repository)
                ? { repository: str(args.repository) }
                : {}),
            }
          : kind === "email"
            ? { kind, filter, allowedSenders: strings(args.allowedSenders) }
            : { kind, filter };
    // No secret argument exists, and the generated key in the result is deliberately discarded.
    const { trigger } = await deps.triggers.create(
      ownerUserId,
      responsibilityId,
      { config },
    );
    const next =
      trigger.kind === "webhook" || trigger.kind === "github"
        ? "Ask the person to open this responsibility's card on the Responsibilities page to copy the key (and, for a webhook, the Authorization header). Do not ask for the key in chat."
        : trigger.kind === "email" || trigger.kind === "slack"
          ? "It is ready."
          : "Ask the person to paste the provider's signing secret on this responsibility's card on the Responsibilities page. Until then deliveries are refused. Do not ask for the secret in chat.";
    return `Added a ${trigger.kind} trigger to "${goal.title}" (id: ${trigger.id}). ${where(deps, trigger)}. ${next}`;
  }
  if (name === "pause_trigger" || name === "resume_trigger") {
    const trigger = await mine(str(args.id));
    await deps.triggers.setEnabled(
      ownerUserId,
      trigger.id,
      name === "resume_trigger",
    );
    return name === "resume_trigger"
      ? "That trigger is active again."
      : "That trigger is paused. Deliveries are acknowledged but start no run.";
  }
  if (name === "delete_trigger") {
    const trigger = await mine(str(args.id));
    await deps.triggers.remove(ownerUserId, trigger.id);
    return "That trigger is deleted. Its URL no longer works and its key is revoked.";
  }
  throw new ResponsibilityRefusedError(`${name} is not a trigger tool.`);
}
