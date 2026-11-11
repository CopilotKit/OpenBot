/**
 * A Bot's goal tools in a conversation, served by the builtin Routines transport beside the routine
 * and trigger tools (`plugins/builtin-routines.ts`), so every Bot holds them as it holds Routines and
 * the write tools are classified as writes there.
 *
 * FOUND ON WINDOWS: asked in a conversation for a goal, the Personal Assistant said it had no goals
 * tool and set up a routine instead. A goal's tools were only ever handed to a goal's own run
 * (`tools.ts`), while the trigger tools a conversation does hold asked for a goal's id "from
 * list_goals", a tool no conversation had. A goal made from New goal on the Bot's page worked; one
 * asked for in words could not be made at all.
 *
 * Owner and Bot come from the signed run's connection, never from arguments, as for routines and
 * triggers, and each call runs through the same tool a goal's own run holds, so a goal made here is
 * held to the same rules. Not `report_goal_progress`: progress is recorded by the run working on a
 * goal, against that run.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { currentApprovalContext } from "@openbot/toolkit/continuation";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import type { AuditInitiator } from "../audit";
import type { ResponsibilityEngine } from "./engine";
import { repeatingAsItBegins, responsibilityTools } from "./tools";
import {
  type GoalRepeats,
  type ResponsibilityStore,
  responsibilitySources,
} from "./types";

type McpToolShape = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type GoalToolDeps = {
  store: ResponsibilityStore;
  engine: Pick<ResponsibilityEngine, "ingest">;
  /**
   * The conversation a new goal reports into: the one named, when the owner and this Bot share it;
   * else the one the request was made in; else the only one they share. Refuses with the choices
   * when that is not one conversation (`RoutineStore.conversationFor`, the rule a routine follows).
   */
  conversationFor(
    ownerUserId: string,
    agentId: string,
    wanted: { channelId?: string; threadId?: string },
  ): Promise<string>;
  /**
   * Record that a routine runs this goal, when the routine's firing ran it and it records none yet
   * (`RoutineStore.linkGoal`). Absent, nothing is recorded.
   */
  linkRoutine?(
    ownerUserId: string,
    agentId: string,
    routineId: string,
    goalId: string,
  ): Promise<boolean>;
};

let installed: GoalToolDeps | null = null;
/** Called once by the server assembly, like `useTriggerTools`. */
export function useGoalTools(deps: GoalToolDeps | null) {
  installed = deps;
}

/*
 * Written out rather than generated from the goal store's schemas, as the routine and trigger
 * schemas are, so a field the model leaves blank is not refused before it arrives. FOUND LIVE: a
 * model sent `channelId: ""` for "this conversation" three times, and each was refused by the run
 * for a minimum length before the tool was reached. A blank is dropped below, and what is left is
 * checked by the goal store's own schemas.
 */
const goalFields = {
  title: { type: "string", description: "A short name for the goal." },
  instruction: {
    type: "string",
    description: "What to do each time the goal runs, in the imperative.",
  },
  successCriteria: {
    type: "string",
    description: "When the goal is met, in terms that can be checked.",
  },
  subscriptions: {
    type: "array",
    description:
      "Events that wake the goal, such as GitHub's `issues.opened`. Usually empty.",
    items: {
      type: "object",
      properties: {
        source: { type: "string", enum: [...responsibilitySources] },
        eventType: { type: "string" },
      },
      required: ["source", "eventType"],
    },
  },
  recurring: {
    type: "boolean",
    description:
      "True when the person wants it done again and again, such as every morning or each time something happens. Its runs never complete it.",
  },
  endsWhenMet: {
    type: "boolean",
    description:
      "True when the goal has an outcome that ends it even though it runs on a schedule or on an event. A run that meets the success criteria may then complete it. Never with recurring.",
  },
} as const;
const goalId = {
  type: "object",
  properties: {
    id: { type: "string", description: "The goal's id, from list_goals." },
  },
  required: ["id"],
};

/** The tools as listed, in the words a conversation needs: what a goal is, beside a routine. */
export const GOAL_TOOLS: readonly McpToolShape[] = Object.freeze([
  {
    name: "create_goal",
    description: [
      "Set up a goal for the person you are talking to: lasting work toward an outcome they name, which",
      "you carry on with over time and report on in a conversation. Use it whenever they ask for a goal.",
      "",
      "A goal has no schedule of its own. It runs when somebody asks (Run now on its card on the Bot's",
      "Routines page, or `run_goal`) and when an event wakes it: a trigger you add with `create_trigger`, or",
      "one of its `subscriptions`. Work done at set times is a routine (`create_routine`); a goal and a",
      "routine can work together. Say which it is when you tell the person what you set up.",
      "",
      "Give a short `title`, the `instruction` for one run, and `successCriteria` that say when it is",
      "met. Leave `subscriptions` empty unless the person names an event.",
      "",
      "Set `recurring` when the person wants it done again and again: every morning, each time something",
      "happens. A goal that repeats, because it is `recurring`, a routine runs it or an event wakes it, is",
      "never completed by one of its runs. Each run reports its result, and only the person ends it. Set",
      "`endsWhenMet` instead when a goal a routine runs or an event wakes has an outcome that ends it: it",
      "doesn't repeat, and the run that meets its success criteria completes it.",
      "",
      "Its runs post into this conversation. Leave `channelId` out, or empty, for this conversation, and",
      "pass one only when the person asks for a different conversation you share. It takes no owner and",
      "no Bot: the goal is the person's, and you carry it out.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        ...goalFields,
        channelId: {
          type: "string",
          description:
            "The id of another conversation its runs post into. Empty, or left out, is this conversation.",
        },
      },
      required: ["title", "instruction", "successCriteria"],
    },
  },
  {
    name: "list_goals",
    description: [
      "List the person's goals that you carry out: each one's id, title, status, whether it is recurring,",
      "progress, last result and conversation. Take the id from here before changing, running, pausing,",
      "resuming or completing one, or adding a trigger to it.",
    ].join("\n"),
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "update_goal",
    description:
      "Change one of the person's goals that you carry out: its title, instruction, success criteria, event subscriptions, or whether it is `recurring` or `endsWhenMet`. Give the id from `list_goals` and, in `patch`, only what changes; an empty field is left as it is.",
    inputSchema: {
      type: "object",
      properties: {
        id: goalId.properties.id,
        patch: { type: "object", properties: goalFields },
      },
      required: ["id", "patch"],
    },
  },
  {
    name: "run_goal",
    description:
      "Start one of the person's active goals now. It runs on its own, without the person's browser, and posts what it did into the goal's conversation. A completed or paused goal doesn't run, and you are told so.",
    inputSchema: goalId,
  },
  {
    name: "pause_goal",
    description:
      "Pause one of the person's goals. It does not run, when asked or on an event, until it is resumed.",
    inputSchema: goalId,
  },
  {
    name: "resume_goal",
    description: "Resume one of the person's paused goals.",
    inputSchema: goalId,
  },
  {
    name: "complete_goal",
    description:
      "End one of the person's goals for good, when the person says it is done, or when the success criteria of a one-off goal, or of one made with endsWhenMet, are met. A goal that repeats (recurring, or run by a routine or woken by an event without endsWhenMet) ends only when the person asks: one good run doesn't finish it. A completed goal can't be resumed.",
    inputSchema: goalId,
  },
]);

export const GOAL_WRITE_TOOLS = [
  "create_goal",
  "update_goal",
  "run_goal",
  "pause_goal",
  "resume_goal",
  "complete_goal",
] as const;

export const isGoalTool = (name: string) =>
  GOAL_TOOLS.some((tool) => tool.name === name);

/** The key of OpenBot's own Routines app, which serves these (`ALWAYS_ON_APP`). */
const ROUTINES_APP = "routines";

/**
 * A Bot's tools for a run, less the Routines app's goal tools when the run is a goal's own.
 *
 * A goal's run is handed the goal's own tools (`tools.ts`: `create_goal` and the rest, bound to that
 * goal's conversation, and `report_goal_progress` for its run), and every Bot also holds these copies
 * through Routines. Both reached the model, so it saw `create_goal` beside
 * `mcp__routines__create_goal`: two tools for each job, under two names and two descriptions. The
 * run keeps its own, which are the ones its turn names, and these leave it. Every other run, a
 * conversation above all, keeps them: they are the only goal tools it has.
 */
export function withoutGoalCopiesInGoalRun(
  initiator: AuditInitiator | undefined,
  load: (botId: string) => Promise<GrantedTool[]>,
): (botId: string) => Promise<GrantedTool[]> {
  if (initiator?.kind !== "responsibility") return load;
  return async (botId) =>
    (await load(botId)).filter((tool) => !isRoutinesGoalTool(tool));
}

/** One of the goal tools the Routines app serves, by its ref (`routines/complete_goal`). */
function isRoutinesGoalTool(tool: GrantedTool) {
  const [app, name] = tool.ref.split("/");
  return app === ROUTINES_APP && name !== undefined && isGoalTool(name);
}

/**
 * Whether this turn was sent by somebody other than the person. A person's carries `person`, or
 * nothing on a remote Bot's run, which names no initiator for the person's own request. Every other
 * turn names what fired it (`run-turn.ts`, `handoffInitiator`, memory's ingestion), and only the
 * person ends a goal that repeats (`repeatsInRun`).
 */
const notSentByPerson = (initiator: AuditInitiator | undefined) =>
  initiator !== undefined && initiator.kind !== "person";

/** The Bot's goals that repeated as this turn began, for its goal tools' calls. */
const repeatedWhenTurnBegan = new AsyncLocalStorage<
  ReadonlyMap<string, GoalRepeats>
>();

/**
 * A Bot's tools for a turn the person did not send, with the goals that repeat read as the turn
 * begins, as a goal's run reads them (`goalRunTools`): this runs where the turn's tools are loaded
 * (`loadTools` in copilot.ts), before the model holds any tool. The turn's calls then carry that
 * reading to `callGoalTool`, so `complete_goal` refuses a goal that repeated then, whatever changed
 * since.
 *
 * FOUND IN REVIEW: read only when the turn asked, a routine's own turn could switch off or delete its
 * goal's routine or trigger with the Routines app (`update_routine`, `delete_routine`,
 * `pause_trigger`, `delete_trigger`), and then complete the goal. Held only in memory, for the turn.
 */
export function withRepeatingGoalsPinned(
  initiator: AuditInitiator | undefined,
  ownerUserId: string,
  load: (botId: string) => Promise<GrantedTool[]>,
): (botId: string) => Promise<GrantedTool[]> {
  if (!notSentByPerson(initiator)) return load;
  return async (botId) => {
    const tools = await load(botId);
    const deps = installed;
    if (!deps || !tools.some(isRoutinesGoalTool)) return tools;
    const pinned = await repeatingAsItBegins({
      store: deps.store,
      ownerUserId,
      agentId: botId,
    });
    /*
     * Every tool of the turn carries it, not only the goal tools: a turn's app calls wait in one
     * queue (`run-calls.ts`), and a call that waited there runs in the context of the call it waited
     * behind, which may be `update_routine`.
     */
    return tools.map((tool) => ({
      ...tool,
      execute: (args, execution) =>
        repeatedWhenTurnBegan.run(pinned, () => tool.execute(args, execution)),
    }));
  };
}

/** The fields that were given. A blank string is not a value, as for a routine's arguments. */
function given(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, field]) => !(typeof field === "string" && field.trim() === ""),
    ),
  );
}

/** A goal tool's answer for the model; a refusal starts "Refused.", as a goal's own run is told. */
export async function callGoalTool(
  connection: { ownerUserId: string; agentId: string; threadId?: string },
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const deps = installed;
  if (!deps) return "Refused. Goals are not available in this deployment.";
  const { ownerUserId, agentId } = connection;
  let input = given(args);
  if (name === "update_goal" && "patch" in input)
    input = { ...input, patch: given(input.patch) };
  let channelId = "";
  if (name === "create_goal") {
    const { channelId: wanted, ...rest } = input;
    channelId = await deps.conversationFor(ownerUserId, agentId, {
      ...(typeof wanted === "string" ? { channelId: wanted.trim() } : {}),
      ...(connection.threadId ? { threadId: connection.threadId } : {}),
    });
    input = rest;
  }
  const initiator = currentApprovalContext()?.initiator;
  const goal = {
    store: deps.store,
    engine: deps.engine,
    ownerUserId,
    agentId,
    channelId,
  };
  const tool = (
    notSentByPerson(initiator)
      ? responsibilityTools({
          ...goal,
          notByPerson: true,
          /*
           * As the turn began (`withRepeatingGoalsPinned`). A call with no turn begun in this process,
           * an approved action carried out later or a remote Bot's callback, is read as it asks.
           */
          repeatedWhenRunBegan:
            repeatedWhenTurnBegan.getStore() ??
            (await repeatingAsItBegins(goal)),
        })
      : responsibilityTools(goal)
  ).find((candidate) => candidate.name === name);
  if (!tool || name === "report_goal_progress")
    return `Refused. ${name} is not a goal tool here.`;
  const answer = String(await tool.execute(input));
  /*
   * A routine's firing that runs a goal is that goal's routine. One made before routines recorded
   * their goal, or made without `goalId`, is linked here the first time it runs one, unless it is an
   * older routine that names an open goal other than this one: it keeps running the goals it names
   * (`RoutineStore.linkGoal`).
   */
  if (
    name === "run_goal" &&
    !answer.startsWith("Refused.") &&
    initiator?.kind === "routine" &&
    initiator.id &&
    typeof input.id === "string"
  )
    await deps.linkRoutine?.(ownerUserId, agentId, initiator.id, input.id);
  if (name !== "create_goal" || answer.startsWith("Refused.")) return answer;
  return `That goal is set. It runs when asked, or when an event wakes it; it has no schedule of its own.\n${answer}`;
}
