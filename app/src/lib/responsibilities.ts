import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  completeGoal,
  createGithubEventSource,
  createGoal,
  createGoalTrigger,
  deleteGithubEventSource,
  deleteGoal,
  deleteGoalTrigger,
  disableGoalTrigger,
  enableGoalTrigger,
  getGoalTriggerSecret,
  listGithubEventSources,
  listGoalRuns,
  listGoals,
  listGoalTriggers,
  pauseGoal,
  replaceGoalTriggerSecret,
  resumeGoal,
  runGoal,
  updateGoal,
} from "@/lib/api/generated/goals/goals";
import type {
  CreateGoalRequest,
  GithubEventSource,
  Goal,
  GoalRun,
  GoalTrigger,
  GoalTriggerConfig,
  GoalTriggerFilter,
  GoalTriggerKind,
  UpdateGoalRequest,
} from "@/lib/api/generated/model";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { sharedUseKeys } from "@/lib/plugins/shared-use";
import {
  everyPage,
  ROUTINES_REFETCH_MS,
  routineKeys,
} from "@/lib/routines/queries";

/** A goal: the API's `Goal`. `recurring` runs again and again with no end, and is refused alongside `endsWhenMet`. */
export type ResponsibilityRecord = Goal;
/** One run of a goal, with what the Bot said: the API's `GoalRun`. */
export type ResponsibilityRunRecord = GoalRun;
/** A GitHub repository whose events reach the person's goals: the API's `GithubEventSource`. */
export type GithubBindingRecord = GithubEventSource;
export const responsibilityKeys = {
  all: ["responsibilities"] as const,
  runs: (id: string) => ["responsibilities", id, "runs"] as const,
  bindings: ["responsibilities", "github-bindings"] as const,
  triggers: (id: string) => ["responsibilities", id, "triggers"] as const,
};

/**
 * A fresh key for each write a person asks for. TanStack does not retry a mutation, so each attempt
 * is a new write; a retry of the same write would reuse its key.
 */
const once = () => ({ "Idempotency-Key": idempotencyKey() });

export function responsibilitiesQueryOptions() {
  return queryOptions({
    queryKey: responsibilityKeys.all,
    queryFn: async ({ signal }): Promise<ResponsibilityRecord[]> => {
      const goals = await everyPage(async (params) => {
        const page = await listGoals(organizationId(), params, {
          signal,
          fallback: "Couldn't load your goals. Reload the page.",
        });
        return { items: page.goals, nextCursor: page.nextCursor };
      });
      // The API lists goals by when each was made. The screens show the one changed last first.
      return goals.sort((a, b) =>
        a.updatedAt === b.updatedAt ? 0 : a.updatedAt < b.updatedAt ? 1 : -1,
      );
    },
    // The routines' interval: the Routines list builds a goal's row from both reads.
    refetchInterval: ROUTINES_REFETCH_MS,
  });
}
export function responsibilityRunsQueryOptions(id: string) {
  return queryOptions({
    queryKey: responsibilityKeys.runs(id),
    queryFn: ({ signal }): Promise<ResponsibilityRunRecord[]> =>
      everyPage(async (params) => {
        const page = await listGoalRuns(organizationId(), id, params, {
          signal,
          fallback: "Couldn't load this goal's runs. Reload the page.",
        });
        return { items: page.runs, nextCursor: page.nextCursor };
      }),
    refetchInterval: 10_000,
  });
}
export function githubBindingsQueryOptions() {
  return queryOptions({
    queryKey: responsibilityKeys.bindings,
    queryFn: ({ signal }): Promise<GithubBindingRecord[]> =>
      everyPage(async (params) => {
        const page = await listGithubEventSources(organizationId(), params, {
          signal,
          fallback: "Could not load GitHub event sources",
        });
        return {
          items: page.githubEventSources,
          nextCursor: page.nextCursor,
        };
      }),
  });
}
export async function createResponsibility(
  input: CreateGoalRequest,
): Promise<ResponsibilityRecord> {
  return (
    await createGoal(organizationId(), input, once(), {
      fallback: "Couldn't save the goal. Try again.",
    })
  ).goal;
}
export function updateResponsibility(id: string, patch: UpdateGoalRequest) {
  return updateGoal(organizationId(), id, patch, once(), {
    fallback: "Couldn't save your changes to the goal. Try again.",
  });
}
/**
 * What a person reads when a goal could not be changed and the server said nothing of its own. A
 * sentence each, since a create from the New routine screen quotes it inside its own message.
 */
export const GOAL_ACTION_FALLBACK = {
  pause: "Couldn't pause the goal. Try again.",
  resume: "Couldn't resume the goal. Try again.",
  complete: "Couldn't complete the goal. Try again.",
  run: "Couldn't start the goal. Try again.",
} as const;
const GOAL_ACTIONS = {
  pause: pauseGoal,
  resume: resumeGoal,
  complete: completeGoal,
  run: runGoal,
} as const;
export async function responsibilityAction(
  id: string,
  action: keyof typeof GOAL_ACTION_FALLBACK,
): Promise<void> {
  await GOAL_ACTIONS[action](organizationId(), id, once(), {
    fallback: GOAL_ACTION_FALLBACK[action],
  });
}
/** Delete a goal, and on the server the routines that run it. */
export function deleteResponsibility(id: string) {
  return deleteGoal(organizationId(), id, once(), {
    fallback: "Couldn't delete the goal. Try again.",
  });
}
export async function createGithubBinding(
  repository: string,
  secret: string,
): Promise<GithubBindingRecord> {
  return (
    await createGithubEventSource(
      organizationId(),
      { repository, secret },
      once(),
      { fallback: "Could not connect GitHub events" },
    )
  ).githubEventSource;
}
export function removeGithubBinding(id: string) {
  return deleteGithubEventSource(organizationId(), id, once(), {
    fallback: "Could not disconnect GitHub events",
  });
}

export type TriggerKind = GoalTriggerKind;
export type TriggerFilter = GoalTriggerFilter;
export type TriggerConfig = GoalTriggerConfig;
/**
 * A registered way for an outside event to start a run of a goal: the API's `GoalTrigger`. A trigger
 * that is off acknowledges deliveries but never starts a run. `path` is where a webhook or provider
 * posts, and `address` where mail is sent when the deployment has inbound email.
 */
export type TriggerRecord = GoalTrigger;
/** Which trigger, and the goal it belongs to: the API addresses a trigger under its goal. */
type TriggerRef = Pick<TriggerRecord, "id" | "goalId">;

export function triggersQueryOptions(id: string) {
  return queryOptions({
    queryKey: responsibilityKeys.triggers(id),
    queryFn: ({ signal }): Promise<TriggerRecord[]> =>
      everyPage(async (params) => {
        const page = await listGoalTriggers(organizationId(), id, params, {
          signal,
          fallback: "Could not load triggers",
        });
        return { items: page.triggers, nextCursor: page.nextCursor };
      }),
  });
}
export function createTrigger(
  goalId: string,
  input: { config: TriggerConfig; secret?: string },
): Promise<{ trigger: TriggerRecord; secret: string | null }> {
  return createGoalTrigger(organizationId(), goalId, input, once(), {
    fallback: "Could not add the trigger",
  });
}
/** Rotate a generated secret, or store the provider's newly pasted one. */
export function setTriggerSecret(
  trigger: TriggerRef,
  secret?: string,
): Promise<{ trigger: TriggerRecord; secret: string | null }> {
  return replaceGoalTriggerSecret(
    organizationId(),
    trigger.goalId,
    trigger.id,
    once(),
    secret ? { secret } : {},
    { fallback: "Could not change the trigger secret" },
  );
}
export async function revealTriggerSecret(
  trigger: TriggerRef,
): Promise<string | null> {
  return (
    await getGoalTriggerSecret(organizationId(), trigger.goalId, trigger.id, {
      fallback: "Could not read the trigger secret",
    })
  ).secret;
}
export function removeTrigger(trigger: TriggerRef) {
  return deleteGoalTrigger(
    organizationId(),
    trigger.goalId,
    trigger.id,
    once(),
    { fallback: "Could not remove the trigger" },
  );
}

export function setTriggerEnabled(trigger: TriggerRef, enabled: boolean) {
  return (enabled ? enableGoalTrigger : disableGoalTrigger)(
    organizationId(),
    trigger.goalId,
    trigger.id,
    once(),
    { fallback: "Could not change the trigger" },
  );
}

const settleGithub = (queryClient: QueryClient) => () =>
  queryClient.invalidateQueries({ queryKey: responsibilityKeys.bindings });

export function createGithubBindingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      repository,
      secret,
    }: {
      repository: string;
      secret: string;
    }) => createGithubBinding(repository, secret),
    onSettled: settleGithub(queryClient),
  });
}
export function removeGithubBindingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: removeGithubBinding,
    onSettled: settleGithub(queryClient),
  });
}

const settleResponsibilities = (queryClient: QueryClient) => () =>
  queryClient.invalidateQueries({ queryKey: responsibilityKeys.all });

export function updateResponsibilityMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: { title: string; instruction: string; successCriteria: string };
    }) => updateResponsibility(id, patch),
    onSuccess: settleResponsibilities(queryClient),
  });
}

/** Pause, resume, complete or run a responsibility now. */
export function responsibilityActionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      id,
      action,
    }: {
      id: string;
      action: "pause" | "resume" | "complete" | "run";
    }) => responsibilityAction(id, action),
    onSuccess: (_data, { action }) => {
      const goals = settleResponsibilities(queryClient)();
      // Completing a goal switches off the routines that serve it, on the server, before this
      // response returns, so only "complete" refreshes them. A run can also complete a goal, but
      // it is accepted (202) and finishes later, so refreshing routines now would see nothing
      // new: the routines' own poll (`ROUTINES_REFETCH_MS`) reads them once it has. Pause and
      // resume leave routines as they were.
      if (action !== "complete") return goals;
      return Promise.all([
        goals,
        queryClient.invalidateQueries({ queryKey: routineKeys.all }),
      ]);
    },
  });
}

/**
 * Delete a goal. The server deletes the routines that run it too, so both lists are refreshed.
 * The goal's own runs and triggers stop existing, so they are removed rather than refetched: a
 * refetch would ask for a goal that is gone and answer 404.
 */
/** Every goal delete, so the goal's page can tell it was deleted from there. */
export const deleteResponsibilityMutationKey = [
  ...responsibilityKeys.all,
  "delete",
] as const;

export function deleteResponsibilityMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: deleteResponsibilityMutationKey,
    mutationFn: (id: string) => deleteResponsibility(id),
    onSuccess: (_result, id) => {
      queryClient.removeQueries({ queryKey: responsibilityKeys.runs(id) });
      queryClient.removeQueries({ queryKey: responsibilityKeys.triggers(id) });
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: responsibilityKeys.all,
          predicate: (query) => query.queryKey[1] !== id,
        }),
        queryClient.invalidateQueries({ queryKey: routineKeys.all }),
      ]);
    },
  });
}

const settleTriggers = (queryClient: QueryClient, responsibilityId: string) =>
  queryClient.invalidateQueries({
    queryKey: responsibilityKeys.triggers(responsibilityId),
  });

/**
 * Add a trigger. A new trigger is a new way a shared app gets called, so the approval it needs may
 * have changed: the shared-use requests are refreshed alongside the triggers.
 */
export function createTriggerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      responsibilityId,
      input,
    }: {
      responsibilityId: string;
      input: { config: TriggerConfig; secret?: string };
    }) => createTrigger(responsibilityId, input),
    onSuccess: async (_created, { responsibilityId }) => {
      await settleTriggers(queryClient, responsibilityId);
      await queryClient.invalidateQueries({
        queryKey: sharedUseKeys.requests(),
      });
    },
  });
}

/**
 * Read a trigger's write-only secret on demand. No `queryClient` and no `onSuccess`: it changes
 * nothing and caches nothing, so there is nothing to invalidate, and the secret lives only in the
 * row that asked for it.
 */
export function revealTriggerSecretMutationOptions() {
  return mutationOptions({ mutationFn: revealTriggerSecret });
}

/** Rotate a generated secret, or store the provider's newly pasted one. */
export function setTriggerSecretMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      trigger,
      secret,
    }: {
      trigger: TriggerRef;
      secret?: string;
    }) => setTriggerSecret(trigger, secret),
    onSuccess: (_result, { trigger }) =>
      settleTriggers(queryClient, trigger.goalId),
  });
}

export function removeTriggerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (trigger: TriggerRef) => removeTrigger(trigger),
    onSuccess: (_result, trigger) =>
      settleTriggers(queryClient, trigger.goalId),
  });
}

/** Switch a trigger on or off; a paused trigger acknowledges deliveries but never starts a run. */
export function setTriggerEnabledMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      trigger,
      enabled,
    }: {
      trigger: TriggerRef;
      enabled: boolean;
    }) => setTriggerEnabled(trigger, enabled),
    onSuccess: (_result, { trigger }) =>
      settleTriggers(queryClient, trigger.goalId),
  });
}
