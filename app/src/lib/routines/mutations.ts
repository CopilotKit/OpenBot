import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { channelKeys } from "@/lib/channels/queries";
import { ClientError, client } from "@/lib/client";
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
 * `server/src/routines/routes.ts` for the full reasoning.
 */

const FALLBACK = "That routine could not be changed.";

function invalidateRoutines(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: routineKeys.all });
}

/** What `POST /api/routines` accepts. The owner is whoever is signed in, never a field. */
export type RoutineInput = {
  agentId: string;
  instruction: string;
  title?: string;
  /** Five cron fields, built by `cronFrom` in `form.ts`. */
  cron: string;
  timezone: string;
  /** A conversation the person and the Bot share, or `NEW_CONVERSATION` to start one for it. */
  channelId: string;
};

/** What a person reads when a routine could not be made and the server said nothing of its own. */
const CREATE_FALLBACK = "Couldn't set up that routine. Try again.";

/** `POST /api/routines`: a routine, or with `goalId` the routine that runs that goal on a schedule. */
function createRoutine(body: RoutineInput & { goalId?: string }) {
  return client("/api/routines", {
    method: "POST",
    body,
    fallback: CREATE_FALLBACK,
  });
}

/** A write was saved or may have been saved: the screen must not offer to create it again. */
export class SavedButRefused extends Error {}

/**
 * Starts a new conversation when asked, and takes it back if nothing was saved in it.
 *
 * With `NEW_CONVERSATION`, the conversation is started first, as the person and the Bot, and named
 * after `name`. `write` gets the channel to use and a `saved` callback it calls once the write has
 * landed. If the server refuses `write` before `saved` was called, the started conversation is removed (best
 * effort) and the error is rethrown: an empty conversation nobody asked for is not what a refused
 * form should leave behind.
 */
async function withConversation<T>(
  agentId: string,
  channelId: string,
  name: string,
  write: (channelId: string, saved: () => void) => Promise<T>,
): Promise<T> {
  let started: string | null = null;
  if (channelId === NEW_CONVERSATION) {
    const response = await client("/api/channels", {
      method: "POST",
      body: { agentIds: [agentId] },
      fallback: "Couldn't start a conversation for this routine.",
    });
    started = ((await response.json()) as { channel: { id: string } }).channel
      .id;
    // Best effort: a conversation that keeps its default name still works.
    await client(`/api/channels/${started}/title`, {
      method: "PUT",
      body: { title: Array.from(name.trim()).slice(0, 60).join("") },
      fallback: "Couldn't name the conversation.",
    }).catch(() => undefined);
  }
  let kept = false;
  try {
    return await write(started ?? channelId, () => {
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
      await client(`/api/channels/${started}`, {
        method: "DELETE",
        fallback: "Couldn't remove the conversation.",
      }).catch(() => undefined);
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
          routine.agentId,
          routine.channelId,
          routine.title?.trim() || routine.instruction.trim(),
          async (channelId, saved) => {
            await createRoutine({ ...routine, channelId });
            saved();
          },
        );
        return;
      }

      if (plan.kind === "check-in") {
        const { checkIn } = plan;
        await withConversation(
          checkIn.agentId,
          checkIn.channelId,
          checkIn.subject.trim() || checkIn.focus.trim(),
          async (channelId, saved) => {
            await createProactiveSetting({ ...checkIn, channelId });
            saved();
          },
        );
        return;
      }

      const { goal: input, schedule, runNow } = plan;
      await withConversation(
        input.agentId,
        input.channelId,
        input.title,
        async (channelId, saved) => {
          const goal = await createResponsibility({ ...input, channelId });
          const { id } = goal;

          if (schedule) {
            try {
              await createRoutine({
                agentId: input.agentId,
                channelId,
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
      client(`/api/routines/${encodeURIComponent(variables.id)}/enabled`, {
        method: "PUT",
        body: { enabled: variables.enabled },
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateRoutines(queryClient),
  });
}

export function deleteRoutineMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) =>
      client(`/api/routines/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateRoutines(queryClient),
  });
}

/**
 * Run now — the Test button. This DOES REAL WORK: the Bot carries out the instruction in the
 * routine's channel exactly as a scheduled firing would. Refused for a paused routine.
 */
export function runRoutineNowMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) =>
      client(`/api/routines/${encodeURIComponent(id)}/run`, {
        method: "POST",
        fallback: "That routine could not be started.",
      }),
    onSuccess: () => invalidateRoutines(queryClient),
  });
}
