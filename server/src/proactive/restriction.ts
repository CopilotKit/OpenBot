/**
 * The read-only boundary a proactive run is held to, enforced where tools are dispatched.
 *
 * A proactive run is a Bot looking through a person's apps while nobody is watching. It may read:
 * the apps the person connected with their own account, through the tools that say they only read
 * (see `scope.ts`), and the person's own memory. It may not write to an app, send a message, hand
 * work to another Bot or person, or drive a browser or the computer. That is decided here, by the
 * deployment, and never by telling the model.
 *
 * WHY THE INITIATOR. Every door a tool call arrives through already carries the run's initiator: the
 * in-process loader is built with it, and a remote Bot's callback carries it inside the run assertion
 * this deployment signed, which the Bot cannot edit. So one predicate over it covers the built-in,
 * remote AG-UI and remote framework doors alike, and a child run cannot inherit an escape because a
 * proactive run is given no way to start one.
 *
 * FAIL CLOSED. Anything not positively in the person's check-in reads is refused: an unknown ref, a
 * catalogue that could not be read, a tool with no read-only label, an app an admin connected for
 * everybody.
 */

import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import type { AuditInitiator } from "../audit";
import { REFUSAL_MARKER } from "../plugins/tools";
import { isProactiveInitiator } from "./initiator";
import type { CheckInReads, CheckInScope } from "./scope";

export {
  isProactiveInitiator,
  PROACTIVE_INITIATOR_PREFIX,
  proactiveInitiator,
  proactiveRunIdOf,
} from "./initiator";

/**
 * OpenBot's own reads a proactive run may call, by the bare name OpenBot gives them. Writing memory
 * goes through the check-in's own tool.
 *
 * BY NAME AND NEVER BY REF. A connector tool's name is always `mcp__<server>__<tool>` and its ref
 * `<server>/<tool>`, so no connector can carry one of these names. The ref `memory/recall_personal_memory`
 * used to be on this list too, and a server added by URL under the id `memory` with a tool of that
 * name would have passed as the person's own memory. That id is reserved now as well.
 */
export const PROACTIVE_OWN_READS: ReadonlySet<string> = new Set([
  "recall_personal_memory",
]);

/** Whether a tool OpenBot built itself may be called by a check-in. Never true for a connector. */
const ownRead = (name: string) => PROACTIVE_OWN_READS.has(name);

function refused(name: string) {
  return `${REFUSAL_MARKER} ${name} is not available during a check-in, which can only read what the person connected. If something needs doing, raise it as a next step instead.`;
}

/**
 * The loader a run's granted tools come from, narrowed for a proactive run.
 *
 * Unchanged for every other initiator. For a proactive one, only the person's check-in reads (and
 * OpenBot's own) are offered, and each is checked again when it executes, so a connection withdrawn
 * or a tool relabelled mid-run is refused on its next call.
 */
export function restrictToolsForRun(
  initiator: AuditInitiator | undefined,
  actorId: string,
  load: (botId: string) => Promise<GrantedTool[]>,
  scope: CheckInScope,
): (botId: string) => Promise<GrantedTool[]> {
  if (!isProactiveInitiator(initiator)) return load;
  const allowedIn = (reads: CheckInReads, tool: GrantedTool) =>
    ownRead(tool.name) || reads.has(tool.ref);
  return async (botId) => {
    const [tools, reads] = await Promise.all([
      load(botId),
      scope(actorId, botId),
    ]);
    return tools
      .filter((tool) => allowedIn(reads, tool))
      .map((tool) => ({
        ...tool,
        execute: async (input: unknown) => {
          if (!allowedIn(await scope(actorId, botId), tool))
            return refused(tool.name);
          return tool.execute(input);
        },
      }));
  };
}

/** Handing work to a Bot or asking a person is a message; a proactive run is given neither. */
export function restrictCoordinationForRun<A extends unknown[], R>(
  initiator: AuditInitiator | undefined,
  coordination: (...args: A) => Promise<R[]>,
): (...args: A) => Promise<R[]> {
  if (!isProactiveInitiator(initiator)) return coordination;
  return async () => [];
}

/**
 * The remote Bot's callback door. Returns a refusal to answer with, or null to carry on.
 *
 * Called before anything else in the callback dispatch, so coordination, memory writes, host tools
 * and connector writes are all refused for a proactive run in one place. A check-in no longer calls
 * a remote Bot's endpoint at all (it runs on OpenBot's own runner), so this door is the second line.
 * A connector arrives here by its ref, and OpenBot's own tools by their bare name.
 */
export async function guardProactiveCallback(
  input: {
    name: string;
    botId: string;
    actorId: string;
    initiator?: AuditInitiator | null;
    run?: { initiator?: AuditInitiator | null } | null;
  },
  scope: CheckInScope,
): Promise<{ text: string; isError: true } | null> {
  const initiator = input.initiator ?? input.run?.initiator ?? undefined;
  if (!isProactiveInitiator(initiator)) return null;
  if (ownRead(input.name)) return null;
  let reads: CheckInReads;
  try {
    reads = await scope(input.actorId, input.botId);
  } catch {
    return { text: refused(input.name), isError: true };
  }
  return reads.has(input.name)
    ? null
    : { text: refused(input.name), isError: true };
}

/**
 * Hidden refusals for the tools a proactive run was not given, so a call the model makes anyway is
 * answered with a governed refusal rather than left dangling. Never offered; never executed as the
 * real tool.
 */
export function refusalsFor(names: readonly string[]) {
  return names.map((name) => ({
    hidden: true as const,
    definition: {
      name,
      description: "Not available during background research.",
      parameters: { type: "object", properties: {} },
    },
    execute: async () => refused(name),
  }));
}
