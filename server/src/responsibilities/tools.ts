import { randomUUID } from "node:crypto";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
import type { ResponsibilityEngine } from "./engine";
import {
  type GoalRepeats,
  type Responsibility,
  ResponsibilityNotFoundError,
  type ResponsibilityPatch,
  ResponsibilityRefusedError,
  type ResponsibilityStore,
  type ResponsibilitySubscription,
  responsibilityInputSchema,
  responsibilityPatchSchema,
  whyItRepeats,
} from "./types";

/**
 * A goal's own tools, for the run that works on it. Identities come from the signed run, never model
 * arguments.
 *
 * Named and described as a goal, the word every screen uses: the model repeats the words its tools
 * give it, and a run's reply is what the person reads in the conversation and in Activity. When they
 * were `*_responsibility`, a goal's run told the person "I've marked the responsibility complete".
 * The code, the routes and the database keep the old word.
 *
 * A RUN OF A GOAL THAT REPEATS IS ONE OF MANY (`GoalRepeats`). It records its result with
 * `report_goal_progress` and the goal stays active: `complete_goal` refuses, in a sentence the model
 * can pass on, and `complete` is not acted on. FOUND ON WINDOWS: the first run of a goal a daily
 * routine runs met its success criteria, as every run of it would, and completed the goal; the Bot
 * then made a second goal to repoint the routine at. Ending a goal that repeats is the person's, from
 * a conversation or the goal's card. Checked when the run asks, so a routine made while the run works
 * counts, and as the run began (`repeatedWhenRunBegan`), so a goal that repeated then is not
 * completed by it, whatever changed since. Nor can a run's `update_goal` change what makes a goal
 * repeat or what ends it (`loosensWhatEndsIt`), which would let it complete the goal after. A
 * conversation turn the person did not send (`notByPerson`) is held to both rules too, with what
 * repeated as its turn began.
 */
export function responsibilityTools(
  options: {
    store: ResponsibilityStore;
    engine: Pick<ResponsibilityEngine, "ingest">;
    ownerUserId: string;
    agentId: string;
    channelId: string;
  } & (
    | {
        /** A conversation turn the person sent. */
        responsibilityRunId?: undefined;
        notByPerson?: false;
        repeatedWhenRunBegan?: undefined;
      }
    | {
        responsibilityRunId?: undefined;
        /**
         * The conversation's turn was not sent by the person: a routine's firing, a memory run, a
         * handoff (`chat-tools.ts`), or the turn that resumes a goal with no run (`answerTurnTools`).
         * It has no goal run of its own, and is held to a run's rules all the same (`repeatsInRun`,
         * `loosensWhatEndsIt`).
         */
        notByPerson: true;
        /**
         * The Bot's goals that repeated as this turn began (`withRepeatingGoalsPinned`,
         * `answerTurnTools`), as a run's are.
         */
        repeatedWhenRunBegan: ReadonlyMap<string, GoalRepeats>;
      }
    | {
        responsibilityRunId: string;
        notByPerson?: undefined;
        /** The Bot's goals that repeated as this run began (`goalRunTools`). */
        repeatedWhenRunBegan: ReadonlyMap<string, GoalRepeats>;
      }
  ),
): GrantedTool[] {
  const { store, engine, ownerUserId, agentId, channelId } = options;
  const responsibilityRunId = options.responsibilityRunId;
  const repeatedWhenRunBegan = options.repeatedWhenRunBegan;
  /** A goal's run, or a conversation turn the person did not send: both held to a run's rules. */
  const heldAsRun =
    responsibilityRunId !== undefined || options.notByPerson === true;
  const identity = z.object({ id: z.string().trim().min(1).max(128) });
  async function owned(id: string) {
    const goal = await store.get(ownerUserId, id);
    if (goal.agentId !== agentId) throw new ResponsibilityNotFoundError();
    return goal;
  }
  /**
   * Why a run may not end this goal: it repeats, or it repeated when this run began. Null in a
   * conversation turn the person sent, and for a goal that is done once. A conversation turn a
   * routine, memory or a handoff started is checked as a run is, by what repeats when it asks and as
   * its turn began: FOUND IN REVIEW, a routine's own turn could complete the goal it runs, and
   * completing a goal switches its routines off, so the routine switched itself off with it.
   *
   * FOUND IN REVIEW: read only when the run asked, a run could switch off or delete what makes its
   * goal repeat with the Routines app (`update_routine`, `delete_routine`, `pause_trigger`,
   * `delete_trigger`), and then complete it. As the run began is read before it holds any tool. So
   * could a routine's own conversation turn, until its reading was taken as its turn began too.
   */
  async function repeatsInRun(id: string) {
    if (!heldAsRun) return null;
    const repeats = await store.repeats(ownerUserId, id);
    if (repeats)
      return `This goal repeats because ${whyItRepeats(repeats)}, so a run can't complete it. It stays active. Only the person ends it.`;
    return repeatedWhenRunBegan?.has(id)
      ? "This goal repeated when this run began, so this run can't complete it, whatever changed since. It stays active. Only the person ends it."
      : null;
  }
  function tool<T>(
    name: string,
    description: string,
    parameters: z.ZodType<T>,
    execute: (value: T) => Promise<unknown>,
  ): GrantedTool {
    return {
      name,
      ref: `responsibility/${name}`,
      description,
      parameters,
      async execute(args) {
        const value = parameters.safeParse(args);
        if (!value.success)
          return `Refused. ${value.error.issues[0]?.message ?? "Invalid goal arguments."}`;
        try {
          return JSON.stringify(await execute(value.data));
        } catch (error) {
          if (
            error instanceof ResponsibilityNotFoundError ||
            error instanceof ResponsibilityRefusedError
          )
            return `Refused. ${error.message}`;
          throw error;
        }
      },
    };
  }
  const tools = [
    tool(
      "create_goal",
      "Create a lasting goal for this Bot in this conversation. State the instruction and measurable success criteria; optional event subscriptions trigger future runs. Set recurring when the person wants it done again and again, every morning or each time something happens: a recurring goal is never completed by one of its runs. Set endsWhenMet instead when a goal a routine runs or an event wakes has an outcome that ends it: the run that meets its success criteria completes it.",
      responsibilityInputSchema
        .omit({ agentId: true, channelId: true })
        .extend({ successCriteria: z.string().trim().min(1).max(3000) }),
      (input) => store.create(ownerUserId, { ...input, agentId, channelId }),
    ),
    tool(
      "list_goals",
      "List this person's goals for this Bot, with their progress.",
      z.object({}).strict(),
      async () =>
        (await store.list(ownerUserId)).filter(
          (goal) => goal.agentId === agentId,
        ),
    ),
    tool(
      "update_goal",
      "Edit a goal's instruction, success criteria, title, event subscriptions, recurring or endsWhenMet. A run changes only the first three, and not the success criteria of a goal made with endsWhenMet or the title of a goal a routine names by its title; the rest are the person's.",
      identity.extend({ patch: responsibilityPatchSchema }),
      async ({ id, patch }) => {
        const goal = await owned(id);
        if (
          heldAsRun &&
          (await loosensWhatEndsIt(goal, patch, (title) =>
            store.renameUnlinksRoutine(ownerUserId, id, title),
          ))
        )
          throw new ResponsibilityRefusedError(
            "A run can't change whether a goal repeats or what ends it. Leave recurring, endsWhenMet and subscriptions as they are, don't clear the success criteria, and keep the success criteria of a goal made with endsWhenMet and the title of a goal a routine names by its title. Only the person changes them.",
          );
        return store.update(ownerUserId, id, patch);
      },
    ),
    tool(
      "report_goal_progress",
      "Record this run's result for a goal: what it found or did, with evidence. Set complete only for a goal that is done once, when its success criteria are met and nothing is left to do: it ends the goal for good. A goal made with endsWhenMet is done once, even when a routine runs it or an event wakes it. A goal that repeats stays active after every run, and only the person ends it.",
      identity.extend({
        summary: z.string().trim().min(1).max(6000),
        complete: z.boolean().optional(),
      }),
      async ({ id, summary, complete }) => {
        await owned(id);
        const repeats = complete ? await repeatsInRun(id) : null;
        const goal = await store.recordProgress(
          ownerUserId,
          id,
          {
            summary,
            complete: complete && !repeats,
            sourceRunId: responsibilityRunId,
          },
          agentId,
        );
        // The result is kept; only the ending is not acted on, and the run is told why.
        return repeats ? { ...goal, note: `Recorded. ${repeats}` } : goal;
      },
    ),
    tool(
      "run_goal",
      "Queue one of this Bot's active goals to be worked on without the person's browser open.",
      identity,
      async ({ id }) => {
        const goal = await owned(id);
        /*
         * A goal that is not active never runs, so asking says so. Before, it answered with no run at
         * all, and a routine that runs a goal the person ended said nothing each time it fired.
         */
        if (goal.status === "completed")
          throw new ResponsibilityRefusedError(
            `"${goal.title}" is complete, so it no longer runs and nothing was done. Tell the person, and ask whether to set it up again as a new goal or switch off what runs it.`,
          );
        if (goal.status === "paused")
          throw new ResponsibilityRefusedError(
            `"${goal.title}" is paused, so it didn't run. Resume it first, if the person wants it to run.`,
          );
        return engine.ingest({
          ownerUserId,
          responsibilityId: id,
          source: "manual",
          externalId: randomUUID(),
          type: "requested",
          payload: {},
        });
      },
    ),
  ];
  for (const [action, status, description] of [
    ["pause", "paused", "Pause one of this Bot's goals."],
    ["resume", "active", "Resume one of this Bot's paused goals."],
    [
      "complete",
      "completed",
      "End one of this Bot's goals for good: it never runs again and can't be resumed. Only for a goal that is done once, when its success criteria are met, or when the person says it is done. A goal made with endsWhenMet is done once, even when a routine runs it or an event wakes it. A goal that repeats is never completed by one of its runs.",
    ],
  ] as const) {
    tools.push(
      tool(`${action}_goal`, description, identity, async ({ id }) => {
        await owned(id);
        const repeats = action === "complete" ? await repeatsInRun(id) : null;
        if (repeats) throw new ResponsibilityRefusedError(repeats);
        return store.transition(ownerUserId, id, status);
      }),
    );
  }
  return tools;
}

/**
 * The tools a goal's run is handed: `responsibilityTools`, with the Bot's goals that repeat read
 * first. Awaited where the run's turn asks for its tools (`toolsForTurn`), before the model is
 * called, so nothing the run does can change what is read.
 */
export async function goalRunTools(options: {
  store: ResponsibilityStore;
  engine: Pick<ResponsibilityEngine, "ingest">;
  ownerUserId: string;
  agentId: string;
  channelId: string;
  responsibilityRunId: string;
}): Promise<GrantedTool[]> {
  return responsibilityTools({
    ...options,
    repeatedWhenRunBegan: await repeatingAsItBegins(options),
  });
}

/**
 * The Bot's goals that repeat, read as a run or a turn the person did not send begins, before the
 * model holds any tool: a goal in it is not completed by that run or turn (`repeatsInRun`). Held in
 * memory for the run or turn, never stored.
 */
export function repeatingAsItBegins(options: {
  store: Pick<ResponsibilityStore, "repeatingGoals">;
  ownerUserId: string;
  agentId: string;
}): Promise<ReadonlyMap<string, GoalRepeats>> {
  return options.store.repeatingGoals(options.ownerUserId, options.agentId);
}

/**
 * The tools of the turn that resumes a goal after the person answers its question. The goal started
 * that turn (its initiator is the responsibility), not the person: with its run it is held as the
 * run is, and with none it is held as a turn the person did not send.
 */
export async function answerTurnTools(options: {
  store: ResponsibilityStore;
  engine: Pick<ResponsibilityEngine, "ingest">;
  ownerUserId: string;
  agentId: string;
  channelId: string;
  responsibilityRunId: string | undefined;
}): Promise<GrantedTool[]> {
  const { responsibilityRunId, ...goal } = options;
  return responsibilityRunId
    ? goalRunTools({ ...goal, responsibilityRunId })
    : responsibilityTools({
        ...goal,
        notByPerson: true,
        repeatedWhenRunBegan: await repeatingAsItBegins(goal),
      });
}

/**
 * Whether this patch changes what decides that a goal repeats or is done: `recurring`, `endsWhenMet`,
 * its subscriptions, its success criteria cleared, the success criteria of a goal that ends when met,
 * or the title an older routine names it by (`renameUnlinksRoutine`). A run may not (`update_goal`),
 * for any goal of its Bot, nor may a conversation turn the person did not send (`notByPerson`).
 *
 * FOUND IN REVIEW: a run's `update_goal` took any patch, so a run of a goal a routine runs could set
 * `endsWhenMet` and then `complete_goal`: the goal ended and its routine was switched off, though a
 * run never ends a goal that repeats (`repeatsInRun`). Clearing `recurring` or the subscriptions did
 * the same, and clearing the success criteria undid `create_goal`'s rule that a Bot gives them. A
 * value sent back as it already is changes nothing, so a run may echo the goal it read. The person's
 * own edit (`PATCH /api/responsibilities/:id`) is not a run, and changes any of them, as does a
 * conversation turn the person sends.
 *
 * FOUND IN REVIEW: a routine's own conversation turn was held to the run's rule on `complete_goal`
 * but not here, so it could set `endsWhenMet` on the goal its routine runs, and then complete it.
 *
 * FOUND IN REVIEW: the title and the success criteria were left out. Renaming a goal an older routine
 * runs by its quoted title (`routineRunsGoal`) unlinks that routine, so the goal stopped repeating and
 * the turn could complete it. And the success criteria are what end a goal made with `endsWhenMet`,
 * so a run could rewrite them to something already true, and then complete it.
 */
async function loosensWhatEndsIt(
  goal: Responsibility,
  patch: ResponsibilityPatch,
  renameUnlinksRoutine: (title: string) => Promise<boolean>,
): Promise<boolean> {
  const events = (subscriptions: ResponsibilitySubscription[]) =>
    subscriptions
      .map(({ source, eventType }) => `${source}\n${eventType}`)
      .sort()
      .join("\n\n");
  const criteriaChanged =
    patch.successCriteria !== undefined &&
    patch.successCriteria !== goal.successCriteria;
  if (
    (patch.recurring !== undefined && patch.recurring !== goal.recurring) ||
    (patch.endsWhenMet !== undefined &&
      patch.endsWhenMet !== goal.endsWhenMet) ||
    (patch.subscriptions !== undefined &&
      events(patch.subscriptions) !== events(goal.subscriptions)) ||
    (criteriaChanged && (patch.successCriteria === "" || goal.endsWhenMet))
  )
    return true;
  return (
    patch.title !== undefined &&
    patch.title !== goal.title &&
    renameUnlinksRoutine(patch.title)
  );
}
