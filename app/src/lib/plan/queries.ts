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

/** Whether Bots in the organization can't run until a card is added or updated. */
export function needsCard(plan: PlanStatus | undefined): boolean {
  return (
    plan?.required === true &&
    (plan.status === "none" || plan.status === "past_due")
  );
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
