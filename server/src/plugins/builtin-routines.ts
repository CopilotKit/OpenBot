import {
  RoutineNotFoundError,
  RoutineRefusedError,
  type Routine,
  type RoutinePatch,
  type RoutineSummary,
} from "../routines/store";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

/**
 * The builtin transport for Routines: a Bot keeping, changing and dropping a person's standing
 * instructions, without leaving the building.
 *
 * WHAT MAKES THIS DIFFERENT FROM EVERY OTHER TRANSPORT. There is no vendor. `mcp` dials somebody
 * else's server and `google-drive-rest` dials Google; both answer to a credential, and who holds it
 * is settled before the connection is built. Here there is no credential at all — the call runs
 * against this deployment's own tables — so the ACTOR is not context, it is the authorization. That
 * is why {@link callTool} refuses a run that is not attributed to a person, and why the owner and
 * the Bot are read off the connection and never out of the arguments.
 *
 * It implements the same interface as the other two, as module-level exports, because that is the
 * shape {@link ./transport} resolves: a `TransportKind` maps to a MODULE. Which is also why the store
 * arrives through {@link useRoutineTools} rather than through a constructor — see the comment there.
 */

/** No fetch, no vendor, no third party: the store's own refusal cap, in code points. */
const MAX_FAILURE_CODE_POINTS = 400;

/**
 * What the tools act on.
 *
 * A narrow projection of `RoutineStore` — the five sweep methods and `setEnabled` are deliberately
 * absent, because nothing a model calls has any business advancing a clock or opening a run row. A
 * store satisfies this structurally, so wiring it is one call and no adapter.
 */
export type RoutineTools = {
  create(input: {
    ownerUserId: string;
    agentId: string;
    channelId?: string;
    instruction: string;
    cron: string;
    timezone?: string;
  }): Promise<Routine>;
  listFor(ownerUserId: string): Promise<RoutineSummary[]>;
  update(
    ownerUserId: string,
    id: string,
    patch: RoutinePatch,
  ): Promise<Routine>;
  remove(ownerUserId: string, id: string): Promise<void>;
};

let installed: RoutineTools | null = null;

/**
 * Hand this module the store, once, from the place that builds stores.
 *
 * A module-level binding rather than a constructor argument, because `transportFor` resolves a kind
 * to a MODULE and there is no seam to pass anything through: the registry is built at import time,
 * long before `index.ts` has a database. Mutable and set once, so a test can install a recording
 * stub and the real boot can install the store, and neither has to know about the other.
 *
 * `null` is a supported argument, and not only for symmetry: the suite is one process, so a test
 * that installs a stub has to be able to take it back out again.
 */
export function useRoutineTools(tools: RoutineTools | null): void {
  installed = tools;
}

/**
 * The four tools, as the same shape a server would have answered `tools/list` with.
 *
 * THE DESCRIPTIONS ARE THE PRODUCT HERE. Every other field is mechanical; these are the only thing
 * standing between "remind me at nine" and a routine that fires at nine UTC for ever, or every
 * minute, or into somebody else's channel. A tool a model misuses is not a failed call — it is a
 * wrong schedule that keeps being wrong on a timer. So the cron contract is written out in full,
 * with worked examples, rather than left to a field named `cron`.
 */
const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "create_routine",
    description: [
      "Set up a standing instruction that you carry out on a schedule for the person you are talking to.",
      "",
      "The schedule is a five-field cron expression, in the order `minute hour day-of-month month day-of-week`.",
      "`0 9 * * 1-5` is weekdays at nine in the morning. `30 18 * * *` is every day at half past six in the",
      "evening. `0 9 1 * *` is the first of the month at nine. A routine may run at most every 15 minutes;",
      "anything more frequent is refused.",
      "",
      "Pass the person's IANA timezone (`America/New_York`, `Europe/Madrid`) whenever they speak in local",
      "time — the default is UTC and there is no deployment timezone to inherit, so a schedule set without",
      "one fires at a UTC hour rather than at theirs.",
      "",
      "The routine posts its reply into a channel. Leave `channelId` out and it goes to the one channel you",
      "share with this person; when you share more than one you will be told so and asked to pick, and the",
      "answer to that is to ask them which.",
      "",
      "It takes no owner and no Bot. The routine belongs to the person you are talking to and runs as you;",
      "both are taken from the run itself, and there is no field for either.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        instruction: {
          type: "string",
          description:
            "What to do each time it runs, written as an instruction to yourself.",
        },
        cron: {
          type: "string",
          description:
            "Five fields: `minute hour day-of-month month day-of-week`. At most every 15 minutes.",
        },
        timezone: {
          type: "string",
          description:
            "The person's IANA timezone, such as `Europe/Madrid`. Omit only when they meant UTC; the default is UTC.",
        },
        channelId: {
          type: "string",
          description:
            "Where the reply is posted. Omit for the one channel you share with this person.",
        },
      },
      required: ["instruction", "cron"],
    },
  },
  {
    name: "list_routines",
    description: [
      "List the standing instructions this person has: each one's id, its schedule in words, its timezone,",
      "the channel it posts into, when it next runs and how the last run went.",
      "",
      "Take the id from here before changing or deleting one. It lists only this person's own routines.",
    ].join("\n"),
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "update_routine",
    description: [
      "Change one of this person's routines: its instruction, its schedule, its timezone, the channel it",
      "posts into, or whether it is switched on.",
      "",
      "Give the id from `list_routines` and only the fields that change; anything left out stays as it is. A",
      "new `cron` follows exactly the same five-field rules as `create_routine`, and a routine switched back",
      "on is scheduled from now rather than from wherever it left off.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The routine's id, from `list_routines`.",
        },
        instruction: {
          type: "string",
          description: "A new instruction, replacing the old one entirely.",
        },
        cron: {
          type: "string",
          description:
            "A new schedule. Five fields: `minute hour day-of-month month day-of-week`. At most every 15 minutes.",
        },
        timezone: {
          type: "string",
          description: "A new IANA timezone, such as `America/New_York`.",
        },
        channelId: {
          type: "string",
          description:
            "A different channel to post into. Must be one you and this person share.",
        },
        enabled: {
          type: "boolean",
          description:
            "False switches it off without deleting it; true switches it back on.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_routine",
    description: [
      "Delete one of this person's routines, by the id from `list_routines`. It stops for good and there is",
      "nothing to undo. When they might want it back, switch it off with `update_routine` instead.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The routine's id, from `list_routines`.",
        },
      },
      required: ["id"],
    },
  },
]);

/**
 * Who this call is for, and which Bot is making it.
 *
 * `url` and `token` are the shared connection shape and are both unused here: there is no host to
 * dial and no credential to send. The two that matter are the two a model never supplies.
 */
type Connection = {
  url: string;
  token?: string;
  actorId?: string;
  botId?: string;
};

/**
 * The list is static, actor-free and needs no store.
 *
 * The four definitions are schemas in this file: nothing to discover, nobody to ask, no credential to
 * hold. It takes no argument at all, which is honest about that — and load-bearing, because the only
 * call site is `refreshTools`, which passes `{url, token}` and never an actor. A list that insisted
 * on one would store zero tools and Routines would advertise nothing to anybody. The refusal that
 * belongs to the actor is {@link callTool}'s, where the actor is what authorizes the change.
 */
export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

export const listNeedsCredential = false;

const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

/** Success as a result, with the same visible cap the vendor transports use. */
function asResult(text: string): McpCallResult {
  if (text.length <= MAX_RESULT_CHARS) {
    return { text, isError: false, truncated: false };
  }
  return {
    text: `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: the answer was ${text.length} characters]`,
    isError: false,
    truncated: true,
  };
}

/** A string argument that was actually given, or nothing. Blank is not a value. */
function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** The target channel as something a person would recognise. A broken one is named as broken. */
function channelOf(summary: RoutineSummary): string {
  if (summary.channelDeleted) {
    return `${summary.channelName ?? "a channel"} (which no longer exists, so it cannot post)`;
  }
  return summary.channelName ?? summary.channelId;
}

/** The last firing, in the plainest true words. Null status with a null finish means in flight. */
function lastRunOf(summary: RoutineSummary): string {
  const run = summary.lastRun;
  if (!run) return "never run";
  if (!run.finishedAt) return "running now";
  return `last ran ${run.finishedAt.toISOString()}${run.status ? ` (${run.status})` : ""}`;
}

/**
 * One routine in words.
 *
 * `schedule` is OPAQUE DISPLAY TEXT from the store — prose for the shapes it can render, the raw
 * expression otherwise. Shown verbatim either way, never parsed and never used to work out a time:
 * `nextRunAt` is the authoritative firing, and it comes from the store too. The whole point of
 * answering in words is that the model confirms a schedule in language a person can check, rather
 * than reading five fields back to somebody who did not write them.
 */
function inWords(summary: RoutineSummary): string {
  const parts = [
    `${summary.schedule} (${summary.timezone})`,
    `in ${channelOf(summary)}`,
    `next ${summary.nextRunAt.toISOString()}`,
    lastRunOf(summary),
    // The model needs this to change or delete the routine later, and it cannot derive it.
    `id: ${summary.id}`,
  ];
  if (!summary.enabled) parts.push("switched off");
  return `"${summary.instruction}" — ${parts.join(" · ")}`;
}

/**
 * The routine that was just written, read back as a summary so it can be described.
 *
 * `create` and `update` return a `Routine`, which carries a cron expression and a channel id: the
 * two things this answer must not be. The summary carries the words and the channel's name, so the
 * confirmation is a sentence rather than a row. Absent only if it vanished between the two calls,
 * where naming the id is the whole of what is still true.
 */
async function describeWritten(
  tools: RoutineTools,
  routine: Routine,
  opening: string,
): Promise<McpCallResult> {
  const summaries = await tools.listFor(routine.ownerUserId);
  const summary = summaries.find((candidate) => candidate.id === routine.id);
  return asResult(
    summary
      ? `${opening} ${inWords(summary)}`
      : `${opening} Its id is ${routine.id}.`,
  );
}

/**
 * Call one tool.
 *
 * WHOSE ROUTINE IT IS COMES FROM THE CONNECTION, NEVER FROM `args`. A model that could name another
 * Bot's id could schedule work as another Bot; a model that could name another owner could schedule
 * work as another person, into a channel it was never in, on a timer nobody else can see. So
 * `ownerUserId` is `connection.actorId` and `agentId` is `connection.botId`, and an `ownerUserId` or
 * `agentId` in the arguments is simply never read — there is no field for either in the schemas
 * above, and a model that invents one is ignored rather than trusted.
 *
 * Nothing thrown escapes: a refusal from the store is carried through verbatim, because its sentence
 * is the one a model can act on ("at most every 15 minutes" proposes a fix; "invalid cron" does
 * not). These come back as `isError` results rather than as throws, which is what the vendor
 * transports do and what `plugins/tools.ts` expects — it prefixes them with "The vendor reported an
 * error: " and the sentence survives intact, which is the part that matters.
 */
export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const ownerUserId = connection.actorId?.trim();
  if (!ownerUserId) {
    return failure(
      "A routine belongs to somebody, and this run is not attributed to anybody.",
    );
  }
  const agentId = connection.botId?.trim();
  if (!agentId) {
    return failure("A routine runs as a Bot, and this run does not name one.");
  }
  const tools = installed;
  if (!tools) {
    return failure("Routines is not available in this deployment.");
  }

  try {
    if (toolName === "create_routine") {
      const instruction = stringArg(args, "instruction");
      if (!instruction) {
        return failure("A routine needs an instruction to carry out.");
      }
      const cron = stringArg(args, "cron");
      if (!cron) {
        return failure(
          "A routine needs a schedule: five cron fields, `minute hour day-of-month month day-of-week`.",
        );
      }
      const routine = await tools.create({
        ownerUserId,
        agentId,
        instruction,
        cron,
        // Absent means absent. The store owns the UTC default, so guessing a zone here would put a
        // zone nobody chose on a routine that then fires at the wrong hour for ever.
        timezone: stringArg(args, "timezone"),
        channelId: stringArg(args, "channelId"),
      });
      return await describeWritten(tools, routine, "That routine is set:");
    }

    if (toolName === "list_routines") {
      const summaries = await tools.listFor(ownerUserId);
      if (summaries.length === 0) {
        // Said in words, not returned as an empty string: an empty result reads to a model as "the
        // tool had nothing to say" and gets filled in from memory.
        return asResult("You have no routines set up.");
      }
      return asResult(summaries.map((one) => `- ${inWords(one)}`).join("\n"));
    }

    if (toolName === "update_routine") {
      const id = stringArg(args, "id");
      if (!id) {
        return failure(
          "Say which routine to change, by the id from list_routines.",
        );
      }
      const patch: RoutinePatch = {};
      const instruction = stringArg(args, "instruction");
      if (instruction !== undefined) patch.instruction = instruction;
      const cron = stringArg(args, "cron");
      if (cron !== undefined) patch.cron = cron;
      const timezone = stringArg(args, "timezone");
      if (timezone !== undefined) patch.timezone = timezone;
      const channelId = stringArg(args, "channelId");
      if (channelId !== undefined) patch.channelId = channelId;
      if (typeof args.enabled === "boolean") patch.enabled = args.enabled;

      // An empty patch is not a change, and sending it would answer "changed" having changed
      // nothing — which a model will report to somebody as done.
      if (Object.keys(patch).length === 0) {
        return failure("Say what to change about that routine.");
      }

      const routine = await tools.update(ownerUserId, id, patch);
      return await describeWritten(tools, routine, "That routine now reads:");
    }

    if (toolName === "delete_routine") {
      const id = stringArg(args, "id");
      if (!id) {
        return failure(
          "Say which routine to delete, by the id from list_routines.",
        );
      }
      await tools.remove(ownerUserId, id);
      return asResult("That routine is deleted. It will not run again.");
    }

    return failure(
      `${toolName} is not a tool Routines implements. The stored tool list is out of date; refresh it on the Plugins page.`,
    );
  } catch (error) {
    /*
     * The store's sentence, unchanged and unprefixed. It is written for a model to act on — the
     * frequency floor, the channel it is not in, the several channels it must choose between — and
     * rewording it here would turn an actionable refusal into a vague one.
     */
    if (error instanceof RoutineRefusedError) return failure(error.message);
    // A routine that is not yours is a routine that does not exist, which is the store's rule; this
    // is the same fact said to somebody who is holding an id.
    if (error instanceof RoutineNotFoundError) {
      return failure("There is no routine of yours with that id.");
    }
    // Anything else is a bug or a broken database, and it still has to come back as a sentence
    // rather than as a thrown error mid-turn. Capped in code points, like the store caps a run's
    // error, so a message carrying an emoji cannot be cut mid-surrogate-pair.
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      Array.from(message).slice(0, MAX_FAILURE_CODE_POINTS).join(""),
    );
  }
}
