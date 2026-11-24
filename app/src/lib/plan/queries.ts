import {
  type QueryClient,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import type { OrganizationPlan } from "@/lib/api/generated/model";
import { getOrganizationPlan } from "@/lib/api/generated/organizations/organizations";
import { organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";
import { useCurrentOrganizationId } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { showCardNeeded } from "./card-needed";

/**
 * The organization's plan, as the server reads it: whether this OpenBot needs one at all, and where
 * the organization stands. `addCardUrl` is the server's verdict on who may add a card: present for
 * an owner or an admin, null for a member.
 */
export type PlanStatus = OrganizationPlan;

/** What an OpenBot that answers no plan address means: it needs none, as every self-hosted one. */
const NOT_REQUIRED: PlanStatus = {
  required: false,
  status: "not_required",
  trialEndsAt: null,
  renewsAt: null,
  addCardUrl: null,
};

export const planKeys = {
  all: ["plan"] as const,
  current: () => ["plan", "current"] as const,
};

/**
 * The plan of the organization the person is working in.
 *
 * An OpenBot from before plans has no such address and answers not found: it needs no plan, so that
 * is read as not required. Any other failure is an error the screens draw nothing for.
 */
export function planQueryOptions() {
  return queryOptions({
    queryKey: planKeys.current(),
    queryFn: async ({ signal }): Promise<PlanStatus> => {
      try {
        return await getOrganizationPlan(organizationId(), {
          signal,
          fallback: "Couldn't load this organization's plan.",
        });
      } catch (error) {
        if (
          error instanceof ClientError &&
          error.status === 404 &&
          (error.code === undefined || error.code === "NOT_FOUND")
        )
          return NOT_REQUIRED;
        throw error;
      }
    },
  });
}

/**
 * Whether Bots in the organization can't run until a card is added or updated: the free trial is
 * used up (`none`), or the last payment failed. Never while runs are left on the free trial (`free`).
 */
export function needsCard(plan: PlanStatus | undefined): boolean {
  return (
    plan?.required === true &&
    (plan.status === "none" || plan.status === "past_due")
  );
}

/**
 * Whether the person has used up their free trial: the server sends the allowance's size only from
 * then on (`freeRunsAllowance`), so the number never shows before.
 */
export function trialUsedUp(plan: PlanStatus | undefined): boolean {
  return (
    plan?.required === true &&
    plan.status === "none" &&
    typeof plan.freeRunsAllowance === "number"
  );
}

/**
 * Asked in front of every action that starts a run (sending a message, Run now, Work on it, a voice
 * call): when the organization's plan, as last read, says Bots can't run, the dialog that says why
 * opens and the action is not sent. True when it stopped the action.
 *
 * Read from the cache, so it costs nothing in front of every press. The dialog reads the plan again
 * each time it opens, so an admin who has just added a card on another page is let through on their
 * next try. A plan not read yet stops nothing; the server decides, and its refusal opens the same
 * dialog.
 */
export function stopIfNeedsCard(): boolean {
  const plan = queryClient.getQueryData<PlanStatus>(planKeys.current());
  if (!needsCard(plan)) return false;
  showCardNeeded();
  return true;
}

/** Whether Bots can't run until a card is added or updated, for a screen that draws something for it. */
export function useNeedsCard(): boolean {
  return needsCard(usePlan());
}

/**
 * The plan, once the app knows which organization it is working in: every page draws it, some
 * before the list of the person's organizations has answered, and the address names the one.
 * `fresh` reads it again on mount, for a screen that has just been told Bots can't run. `client`
 * names the query client, for a component drawn inside a conversation, whose components read no
 * query context of their own (`StarPrompt` names it the same way).
 */
export function usePlan({
  fresh = false,
  client,
}: {
  fresh?: boolean;
  client?: QueryClient;
} = {}): PlanStatus | undefined {
  const known = useCurrentOrganizationId() !== undefined;
  return useQuery(
    {
      ...planQueryOptions(),
      enabled: known,
      ...(fresh ? { refetchOnMount: "always" as const } : {}),
    },
    client,
  ).data;
}
