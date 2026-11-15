import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  createConversation,
  deleteConversation,
  updateConversation,
} from "@/lib/api/generated/conversations/conversations";
import type { CreateRoutineRequest } from "@/lib/api/generated/model";
import {
  createRoutine as createRoutineRequest,
  deleteRoutine,
  pauseRoutine,
  resumeRoutine,
  runRoutine,
} from "@/lib/api/generated/routines/routines";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { channelKeys } from "@/lib/channels/queries";
import { ClientError } from "@/lib/client";
import { createProactiveSetting, proactiveKeys } from "@/lib/proactive";
import {
  createResponsibility,
  deleteResponsibility,
  GOAL_ACTION_FALLBACK,
  responsibilityAction,
  responsibilityKeys,
} from "@/lib/responsibilities";
import { NEW_CONVERSATION } from "./form";
import { type RoutinePlan, runGoalInstruction } from "./plan";
import { routineKeys } from "./queries";

/**
 * Writes against a person's own standing instructions.
 *
 * Create is here, as a plan the form made, through the same store calls a Bot's tools make; there is no edit.
 * Changing a routine is conversational, through the `RoutineTools` a Bot calls mid-chat. See
 * the routines operations in the API spec for the full reasoning.
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

/** What a person reads when a routine could not be made and the server said nothing of its own. */
const CREATE_FALLBACK = "Couldn't set up that routine. Try again.";

/** `createRoutine`: a routine, or with `goalId` the routine that runs that goal on a schedule. */
function createRoutine(body: CreateRoutineRequest) {
  return createRoutineRequest(organizationId(), body, once(), {
    fallback: CREATE_FALLBACK,
  });
}

/** A write was saved or may have been saved: the screen must not offer to create it again. */
export class SavedButRefused extends Error {}

/**
 * Starts a new conversation when asked, and takes it back if nothing was saved in it.
 *
 * With `NEW_CONVERSATION`, the conversation is started first, as the person and the Bot, and named
 * after `name`. `write` gets the conversation to use and a `saved` callback it calls once the write has
 * landed. If the server refuses `write` before `saved` was called, the started conversation is removed (best
 * effort) and the error is rethrown: an empty conversation nobody asked for is not what a refused
 * form should leave behind.
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
    // even with an existing conversation: retrying could duplicate the saved work.
    const refused =
      error instanceof ClientError && error.status >= 400 && error.status < 500;
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
    mutationFn: async (plan: RoutinePlan): Promise<void> => {
      if (plan.kind === "routine") {
        const { routine } = plan;
        await withConversation(
          routine.botId,
          routine.conversationId,
          routine.title?.trim() || routine.instruction.trim(),
          async (conversationId, saved) => {
            await createRoutine({ ...routine, conversationId });
            saved();
          },
        );
        return;
      }

      if (plan.kind === "check-in") {
        const { checkIn } = plan;
        await withConversation(
          checkIn.botId,
          checkIn.conversationId,
          checkIn.subject.trim() || checkIn.focus.trim(),
          async (conversationId, saved) => {
            // A new one: the server refuses one the Bot already has, should this screen's list of
            // them be out of date, as Name does while it is typed.
            await createProactiveSetting(
              { ...checkIn, conversationId },
              { refuseExisting: true },
            );
            saved();
          },
        );
        return;
      }

      const { goal: input, schedule, runNow } = plan;
      await withConversation(
        input.botId,
        input.conversationId,
        input.title,
        async (conversationId, saved) => {
          const goal = await createResponsibility({
            ...input,
            conversationId,
          });
          const { id } = goal;

          if (schedule) {
            try {
              await createRoutine({
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
            } catch (error) {
              /*
               * Only a 4xx is the server saying no. A 5xx, a timeout or a dropped connection
               * says nothing about whether the routine was saved, and pausing the goal then
               * would leave a live routine firing into a paused goal.
               */
              const refused =
                error instanceof ClientError &&
                error.status >= 400 &&
                error.status < 500;
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
              const refusal = error.message;
              const paused = await responsibilityAction(id, "pause").then(
                () => true,
                () => false,
              );
              throw new SavedButRefused(
                paused
                  ? `It's saved but paused, on the Routines page. Its schedule was refused. ${refusal}`
                  : `It's saved on the Routines page, but it won't run on its own. Its schedule was refused. ${refusal}`,
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
              );
            }
          }
        },
      );
    },
    // onSettled, not onSuccess: a goal kept, paused, after a refusal still has to show on the list.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: routineKeys.all }),
        queryClient.invalidateQueries({ queryKey: responsibilityKeys.all }),
        queryClient.invalidateQueries({ queryKey: proactiveKeys.settings }),
        queryClient.invalidateQueries({ queryKey: channelKeys.all }),
      ]),
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
