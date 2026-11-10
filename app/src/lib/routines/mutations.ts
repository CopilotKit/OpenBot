import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { channelKeys } from "@/lib/channels/queries";
import { client } from "@/lib/client";
import { NEW_CONVERSATION } from "./form";
import { routineKeys } from "./queries";

/**
 * Writes against a person's own standing instructions.
 *
 * Create is here, through the same store call a Bot's `create_routine` makes; there is no edit.
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

/**
 * New routine.
 *
 * With `NEW_CONVERSATION`, the conversation it posts in is started first, as the person and the
 * Bot, and named after the routine so the sidebar says what it is for. A routine the server then
 * refuses takes that conversation back with it: an empty conversation nobody asked for is not
 * what a refused form should leave behind.
 */
export function createRoutineMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: RoutineInput): Promise<{ id: string }> => {
      let started: string | null = null;
      if (input.channelId === NEW_CONVERSATION) {
        const response = await client("/api/channels", {
          method: "POST",
          body: { agentIds: [input.agentId] },
          fallback: "Couldn't start a conversation for this routine.",
        });
        started = ((await response.json()) as { channel: { id: string } })
          .channel.id;
        const name = input.title?.trim() || input.instruction.trim();
        // Best effort: a conversation that keeps its default name still works.
        await client(`/api/channels/${started}/title`, {
          method: "PUT",
          body: { title: Array.from(name).slice(0, 60).join("") },
          fallback: "Couldn't name the conversation.",
        }).catch(() => undefined);
      }
      try {
        return await client<{ id: string }>("/api/routines", "routine", {
          method: "POST",
          body: { ...input, channelId: started ?? input.channelId },
          fallback: "Couldn't set up that routine. Try again.",
        });
      } catch (error) {
        if (started) {
          await client(`/api/channels/${started}`, {
            method: "DELETE",
            fallback: "Couldn't remove the conversation.",
          }).catch(() => undefined);
        }
        throw error;
      }
    },
    onSuccess: () =>
      Promise.all([
        invalidateRoutines(queryClient),
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
