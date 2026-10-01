/**
 * The read-only boundary a proactive run is held to, enforced where tools are dispatched.
 *
 * A proactive run is a Bot looking through a person's apps while nobody is watching. It may read:
 * connected-app actions its catalogue marks `read` and not destructive, and the person's own memory.
 * It may not write to an app, send a message, hand work to another Bot or person, or drive a browser
 * or the computer. That is decided here, by the deployment, and never by telling the model.
 *
 * WHY THE INITIATOR. Every door a tool call arrives through already carries the run's initiator: the
 * in-process loader is built with it, and a remote Bot's callback carries it inside the run assertion
 * this deployment signed, which the Bot cannot edit. So one predicate over it covers the built-in,
 * remote AG-UI and remote framework doors alike, and a child run cannot inherit an escape because a
 * proactive run is given no way to start one.
 *
 * FAIL CLOSED. Anything not positively classified as a read is refused: an unknown ref, a catalogue
 * that could not be read, a tool with no recorded effect.
 */
import type { AuditInitiator } from "../audit";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";

export const PROACTIVE_INITIATOR_PREFIX = "proactive:";

/**
 * A proactive run's initiator. Recorded as an unattended routine-kind run, so every policy written
 * for unattended work applies to it too, with an id that names it as proactive.
 */
export function proactiveInitiator(runId: string): AuditInitiator {
  return { kind: "routine", id: `${PROACTIVE_INITIATOR_PREFIX}${runId}` };
}

export function isProactiveInitiator(
  initiator: AuditInitiator | undefined | null,
): boolean {
  return (
    !!initiator &&
    "id" in initiator &&
    typeof initiator.id === "string" &&
    initiator.id.startsWith(PROACTIVE_INITIATOR_PREFIX)
  );
}

export function proactiveRunIdOf(initiator: AuditInitiator | undefined) {
  return initiator && isProactiveInitiator(initiator) && "id" in initiator
    ? initiator.id.slice(PROACTIVE_INITIATOR_PREFIX.length)
    : null;
}

/** Memory tools a proactive run may call by name. Writing memory goes through the proactive tool. */
export const PROACTIVE_MEMORY_READS: ReadonlySet<string> = new Set([
  "recall_personal_memory",
  "memory/recall_personal_memory",
]);

type CatalogueReader = {
  listServers(): Promise<
    {
      id: string;
      title: string;
      tools: { ref: string; effect: string; destructive: boolean }[];
    }[]
  >;
};

/** Which refs are reads right now, read from the catalogue per question so a relabel applies at once. */
export function createReadOnlyClassifier(plugins: CatalogueReader) {
  return async (): Promise<ReadonlySet<string>> => {
    const servers = await plugins.listServers();
    const refs = new Set<string>(PROACTIVE_MEMORY_READS);
    for (const server of servers)
      for (const tool of server.tools)
        if (tool.effect === "read" && tool.destructive !== true)
          refs.add(tool.ref);
    return refs;
  };
}
export type ReadOnlyRefs = () => Promise<ReadonlySet<string>>;

function refused(name: string) {
  return `${REFUSAL_MARKER} ${name} is not available during background research, which can only read. Suggest it as a next step instead.`;
}

/**
 * The loader a run's granted tools come from, narrowed for a proactive run.
 *
 * Unchanged for every other initiator. For a proactive one, only reads are offered, and each is
 * checked again when it executes, so a grant relabelled mid-run is refused on its next call.
 */
export function restrictToolsForRun<A extends unknown[]>(
  initiator: AuditInitiator | undefined,
  load: (...args: A) => Promise<GrantedTool[]>,
  readOnlyRefs: ReadOnlyRefs,
): (...args: A) => Promise<GrantedTool[]> {
  if (!isProactiveInitiator(initiator)) return load;
  return async (...args: A) => {
    const [tools, allowed] = await Promise.all([load(...args), readOnlyRefs()]);
    return tools
      .filter((tool) => allowed.has(tool.ref) || allowed.has(tool.name))
      .map((tool) => ({
        ...tool,
        execute: async (input: unknown) => {
          const current = await readOnlyRefs();
          if (!current.has(tool.ref) && !current.has(tool.name))
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
 * and connector writes are all refused for a proactive run in one place.
 */
export async function guardProactiveCallback(
  input: {
    name: string;
    initiator?: AuditInitiator | null;
    run?: { initiator?: AuditInitiator | null } | null;
  },
  readOnlyRefs: ReadOnlyRefs,
): Promise<{ text: string; isError: true } | null> {
  const initiator = input.initiator ?? input.run?.initiator ?? undefined;
  if (!isProactiveInitiator(initiator)) return null;
  let allowed: ReadonlySet<string>;
  try {
    allowed = await readOnlyRefs();
  } catch {
    return { text: refused(input.name), isError: true };
  }
  return allowed.has(input.name)
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
