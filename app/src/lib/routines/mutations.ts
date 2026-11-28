import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  createConversation,
  deleteConversation,
  updateConversation,
} from "@/lib/api/generated/conversations/conversations";
import type {
  CreateRoutineRequest,
  RoutineReading,
  RoutineSentence,
  UpdateRoutineRequest,
} from "@/lib/api/generated/model";
import {
  createRoutine as createRoutineRequest,
  deleteRoutine,
  pauseRoutine,
  readRoutineSentence,
  resumeRoutine,
  runRoutine,
  updateRoutine,
} from "@/lib/api/generated/routines/routines";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { channelKeys } from "@/lib/channels/queries";
import { ClientError } from "@/lib/client";
import { unavailableSaid } from "@/lib/load-failure";
import {
  createProactiveSetting,
  proactiveKeys,
  removeProactiveSetting,
} from "@/lib/proactive";
import {
  createResponsibility,
  deleteResponsibility,
  GOAL_ACTION_FALLBACK,
  responsibilityAction,
  responsibilityKeys,
} from "@/lib/responsibilities";
import { NEW_CONVERSATION } from "./form";
import { intervalLabel } from "./merged";
import { type RoutinePlan, runGoalInstruction } from "./plan";
import { routineKeys } from "./queries";
import { scheduleWords } from "./words";

/**
 * Writes against a person's own standing instructions.
 *
 * Create is here, as a plan the form made, through the same store calls a Bot's tools make. So is
 * Edit routine, which changes one in place: it keeps its id, its conversation and its runs.
 */

const FALLBACK = "That routine could not be changed.";

function invalidateRoutines(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: routineKeys.all });
}

/**
 * What a new routine is made from: the API's `CreateRoutineRequest`, less the goal it runs. The
 * owner is whoever is signed in, never a field. `cron` is five cron fields, built by `cronFrom` in
 * `form.ts`, and `conversationId` a conversation the person and the Bot share, or
 * `NEW_CONVERSATION` to start one for it.
 */
export type RoutineInput = Omit<CreateRoutineRequest, "goalId" | "timezone"> & {
  timezone: string;
};

/**
 * A fresh key for each write a person asks for. TanStack does not retry a mutation, so each attempt
 * is a new write; a retry of the same write would reuse its key.
 */
const once = () => ({ "Idempotency-Key": idempotencyKey() });

/** What a person reads when the box could not take back what it made and the server said nothing of its own. */
const UNDO_FALLBACK = "Couldn't remove that. Try again.";

/** What a person reads when a routine could not be made and the server said nothing of its own. */
const CREATE_FALLBACK = "Couldn't set up that routine. Try again.";

/** `createRoutine`: a routine, or with `goalId` the routine that runs that goal on a schedule. */
function createRoutine(body: CreateRoutineRequest) {
  return createRoutineRequest(organizationId(), body, once(), {
    fallback: CREATE_FALLBACK,
  });
}

/**
 * Read a sentence as New routine's answers, for the Routines page's box. It writes nothing, so it
 * invalidates nothing; each call is its own request with its own key.
 */
export function readRoutineSentenceMutationOptions() {
  return mutationOptions({
    mutationFn: (variables: RoutineSentence): Promise<RoutineReading> =>
      readRoutineSentence(organizationId(), variables, once(), {
        fallback: "Couldn't read that. Try again.",
      }),
  });
}

/**
 * What a create made, for a screen that wants to show, open or take it back: the kind of thing, its
 * id, and `when` it starts in the words a row says it, read from what the server made (a schedule
 * with its time zone where that isn't the reader's, or how often a check-in looks). `when` is empty
 * for a goal that nothing starts on its own. A goal also names `routineId`, the routine that runs
 * it, when one was made.
 */
export type MadeRoutine = {
  when: string;
  /** The conversation started for it, which Undo takes back too; null when it posts in one already there. */
  startedConversationId: string | null;
} & (
  | { kind: "routine"; id: string }
  | { kind: "goal"; id: string; routineId: string | null }
  | { kind: "check-in"; id: string }
);

/** A write was saved or may have been saved: the screen must not offer to create it again. */
export class SavedButRefused extends Error {}

/**
 * Starts a new conversation when asked, and takes it back if nothing was saved in it.
 *
 * With `NEW_CONVERSATION`, the conversation is started first, as the person and the Bot, and named
 * after `name`. `write` gets the conversation to use and a `saved` callback it calls once the write has
 * landed. If the server refuses `write` before `saved` was called, the started conversation is removed (best
 * effort) and the error is rethrown: an empty conversation nobody asked for is not what a refused
 * form should leave behind. It resolves to whatever `write` resolves to.
 */
async function withConversation<T>(
  botId: string,
  conversationId: string,
  name: string,
  write: (conversationId: string, saved: () => void) => Promise<T>,
): Promise<T> {
  let started: string | null = null;
  if (conversationId === NEW_CONVERSATION) {
    started = (
      await createConversation(
        organizationId(),
        { botIds: [botId] },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't start a conversation for this routine." },
      )
    ).conversation.id;
    // Best effort: a conversation that keeps its default name still works.
    await updateConversation(
      organizationId(),
      started,
      { title: Array.from(name.trim()).slice(0, 60).join("") },
      { "Idempotency-Key": idempotencyKey() },
      { fallback: "Couldn't name the conversation." },
    ).catch(() => undefined);
  }
  let kept = false;
  try {
    return await write(started ?? conversationId, () => {
      kept = true;
    });
  } catch (error) {
    // An uncertain create may already have committed. Keep its conversation and prevent a retry,
    // even with an existing conversation: retrying could duplicate the saved work. OpenBot holding
    // off (a move, or the organization's database out of reach) is a refusal too: it answers
    // before anything is written, so the form stays open to press again once it is back.
    const refused =
      (error instanceof ClientError &&
        error.status >= 400 &&
        error.status < 500) ||
      unavailableSaid(error) !== undefined;
    if (!kept && !refused)
      throw new SavedButRefused(
        "It may have been saved on the Routines page. Open it there to check before creating another one.",
      );
    if (started && !kept) {
      await deleteConversation(
        organizationId(),
        started,
        { "Idempotency-Key": idempotencyKey() },
        undefined,
        { fallback: "Couldn't remove the conversation." },
      ).catch(() => undefined);
    }
    throw error;
  }
}

/** The conversation `withConversation` started, given what was asked for and what was used. */
function startedFor(asked: string, used: string): string | null {
  return asked === NEW_CONVERSATION ? used : null;
}

/** The lists a create or an undo changes, so each shows what is now there. */
function settleMade(queryClient: QueryClient) {
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: routineKeys.all }),
      queryClient.invalidateQueries({ queryKey: responsibilityKeys.all }),
      queryClient.invalidateQueries({ queryKey: proactiveKeys.settings }),
      queryClient.invalidateQueries({ queryKey: channelKeys.all }),
    ]);
}

/**
 * Carries out what the form's answers made, in one mutation.
 *
 * A routine is one write, a check-in is one write, and a goal is up to three: the goal, the routine
 * that runs it on a schedule, and a first run. The conversation is started once and every write
 * uses it.
 *
 * A goal whose schedule is refused is deleted again, with the conversation started for it, and the
 * refusal is rethrown: the form stays as it was, saying what the server said, and Create can be
 * pressed again. Only if that delete fails is the goal kept, paused, with its conversation, and the
 * form locked (`SavedButRefused`).
 *
 * FOUND IN REVIEW: a refused schedule used to keep the goal, paused, and lock the form. A person who
 * fixed what was refused could not press Create again, and the paused goal stayed on the Routines
 * list with no way to delete it.
 */
export function createFromPlanMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (plan: RoutinePlan): Promise<MadeRoutine> => {
      if (plan.kind === "routine") {
        const { routine } = plan;
        return withConversation<MadeRoutine>(
          routine.botId,
          routine.conversationId,
          routine.title?.trim() || routine.instruction.trim(),
          async (conversationId, saved) => {
            const made = await createRoutine({ ...routine, conversationId });
            saved();
            return {
              kind: "routine",
              id: made.routine.id,
              when: scheduleWords(made.routine),
              startedConversationId: startedFor(
                routine.conversationId,
                conversationId,
              ),
            };
          },
        );
      }

      if (plan.kind === "check-in") {
        const { checkIn } = plan;
        return withConversation<MadeRoutine>(
          checkIn.botId,
          checkIn.conversationId,
          checkIn.subject.trim() || checkIn.focus.trim(),
          async (conversationId, saved) => {
            // A new one: the server refuses one the Bot already has, should this screen's list of
            // them be out of date, as Name does while it is typed.
            const made = await createProactiveSetting(
              { ...checkIn, conversationId },
              { refuseExisting: true },
            );
            saved();
            return {
              kind: "check-in",
              id: made.checkIn.id,
              when: `Checks ${intervalLabel(made.checkIn.intervalMinutes).toLowerCase()}`,
              startedConversationId: startedFor(
                checkIn.conversationId,
                conversationId,
              ),
            };
          },
        );
      }

      const { goal: input, schedule, runNow } = plan;
      return withConversation<MadeRoutine>(
        input.botId,
        input.conversationId,
        input.title,
        async (conversationId, saved) => {
          const goal = await createResponsibility({
            ...input,
            conversationId,
          });
          const { id } = goal;
          let running: { id: string; when: string } | null = null;

          if (schedule) {
            try {
              const { routine } = await createRoutine({
                botId: input.botId,
                conversationId,
                goalId: id,
                instruction: runGoalInstruction(goal.title, id),
                cron: schedule.cron,
                timezone: schedule.timezone,
                // The routine store refuses a title over 100 characters.
                ...(Array.from(goal.title).length <= 100
                  ? { title: goal.title }
                  : {}),
              });
              running = { id: routine.id, when: scheduleWords(routine) };
            } catch (error) {
              /*
               * Only a 4xx is the server saying no. A 5xx, a timeout or a dropped connection
               * says nothing about whether the routine was saved, and pausing the goal then
               * would leave a live routine firing into a paused goal.
               */
              const refused =
                (error instanceof ClientError &&
                  error.status >= 400 &&
                  error.status < 500) ||
                unavailableSaid(error) !== undefined;
              if (!refused) {
                saved();
                throw new SavedButRefused(
                  "It's saved on the Routines page, but its schedule may not have been set. Open it there to check.",
                );
              }
              // Nothing was made but the goal: take it back. `withConversation` then takes back the
              // conversation started for it, since `saved` was not called.
              const removed = await deleteResponsibility(id).then(
                () => true,
                () => false,
              );
              if (removed) throw error;
              saved();
              const refusal =
                error instanceof Error ? error.message : String(error);
              const paused = await responsibilityAction(id, "pause").then(
                () => true,
                () => false,
              );
              // The refusal rides along as the cause: a hold folded into this sentence is still
              // drawn calmly (lib/load-failure.tsx).
              throw new SavedButRefused(
                paused
                  ? `It's saved but paused, on the Routines page. Its schedule was refused. ${refusal}`
                  : `It's saved on the Routines page, but it won't run on its own. Its schedule was refused. ${refusal}`,
                { cause: error },
              );
            }
          }
          // Nothing after this is undone: the goal and its conversation are kept.
          saved();

          if (runNow) {
            try {
              await responsibilityAction(id, "run");
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              // The fallback only says it didn't start, which this sentence already says.
              throw new SavedButRefused(
                `It's saved on the Routines page, but it didn't start. ${
                  message === GOAL_ACTION_FALLBACK.run
                    ? "Open it there to run it."
                    : message
                }`,
                { cause: error },
              );
            }
          }
          return {
            kind: "goal",
            id,
            when: running?.when ?? "",
            routineId: running?.id ?? null,
            startedConversationId: startedFor(
              input.conversationId,
              conversationId,
            ),
          };
        },
      );
    },
    // onSettled, not onSuccess: a goal kept, paused, after a refusal still has to show on the list.
    onSettled: settleMade(queryClient),
  });
}

/**
 * Takes back what a create just made: the routine, or the goal and the routine that runs it, or the
 * check-in, and then the conversation started for it. A goal's routine goes first, so a goal is never left with a routine firing into it. It
 * is the box's Undo, offered on the line under the box and nowhere later.
 */
export function undoMadeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (made: MadeRoutine): Promise<void> => {
      switch (made.kind) {
        case "routine":
          await deleteRoutine(organizationId(), made.id, once(), {
            fallback: UNDO_FALLBACK,
          });
          break;
        case "goal":
          if (made.routineId)
            await deleteRoutine(organizationId(), made.routineId, once(), {
              fallback: UNDO_FALLBACK,
            });
          await deleteResponsibility(made.id);
          break;
        case "check-in":
          await removeProactiveSetting(made.id);
          break;
      }
      // The conversation started for it goes too, last, once nothing posts in it. Best effort, as
      // when a refused create takes one back: the routine is gone either way.
      if (made.startedConversationId)
        await deleteConversation(
          organizationId(),
          made.startedConversationId,
          { "Idempotency-Key": idempotencyKey() },
          undefined,
          { fallback: "Couldn't remove the conversation." },
        ).catch(() => undefined);
    },
    onSettled: settleMade(queryClient),
  });
}

/** Switch one routine on or off. Immediate; there is no save. */
export function setRoutineEnabledMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { id: string; enabled: boolean }) =>
      (variables.enabled ? resumeRoutine : pauseRoutine)(
        organizationId(),
        variables.id,
        once(),
        { fallback: FALLBACK },
      ),
    onSuccess: () => invalidateRoutines(queryClient),
  });
}

/**
 * Change a routine's name, what it does, its schedule or its time zone. Only the fields sent change.
 * The server says what it refused (a schedule too frequent, a time zone it doesn't know) in words a
 * person reads, which the dialog shows as they are.
 */
export function updateRoutineMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { id: string; changes: UpdateRoutineRequest }) =>
      updateRoutine(organizationId(), variables.id, variables.changes, once(), {
        fallback: "Couldn't save your changes. Try again.",
      }).then((answer) => answer.routine),
    onSuccess: () => invalidateRoutines(queryClient),
  });
}

/** Every routine delete, so the routine's page can tell it was deleted from there. */
export const deleteRoutineMutationKey = [...routineKeys.all, "delete"] as const;

/**
 * Delete a routine. Its runs stop existing with it, so they are removed rather than read again: a
 * read would ask for a routine that is gone and answer 404, which the page still showing it used to
 * do once on its way back to Routines. Every other routine read is refreshed.
 */
export function deleteRoutineMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: deleteRoutineMutationKey,
    mutationFn: (id: string) =>
      deleteRoutine(organizationId(), id, once(), { fallback: FALLBACK }),
    onSuccess: async (_result, id) => {
      // A read of its runs already on its way is dropped too, not left to land in the cache.
      await queryClient.cancelQueries({ queryKey: routineKeys.runs(id) });
      queryClient.removeQueries({ queryKey: routineKeys.runs(id) });
      return queryClient.invalidateQueries({
        queryKey: routineKeys.all,
        predicate: (query) => query.queryKey[1] !== id,
      });
    },
  });
}

/**
 * Run now — the Test button. This DOES REAL WORK: the Bot carries out the instruction in the
 * routine's channel exactly as a scheduled firing would. Refused for a paused routine.
 */
export function runRoutineNowMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) =>
      runRoutine(organizationId(), id, once(), {
        fallback: "That routine could not be started.",
      }),
    onSuccess: () => invalidateRoutines(queryClient),
  });
}
