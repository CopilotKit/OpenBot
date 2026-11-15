import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  approveSharedUseRequest,
  createSharedUseRequest,
  declineSharedUseRequest,
  getBotSharedUse,
  listSharedUseRequests,
} from "@/lib/api/generated/shared-use/shared-use";
import { idempotencyKey, organizationId } from "@/lib/api/request";

export type SharedAudience = "owner" | "people" | "team";
/** A person by id, a team by id, or a directory group by its name. */
export type ApprovalMember = {
  kind: "user" | "group" | "team";
  value: string;
};
export type SharedUseApproval = {
  audience: SharedAudience;
  outsideInput: boolean;
  members: ApprovalMember[];
};
export type SharedUseRequestReason =
  | "refused_call"
  | "publish"
  | "trigger"
  | "grant";
export type SharedUseRequest = {
  id: string;
  botId: string;
  botName: string;
  ownerUserId: string | null;
  serverId: string;
  title: string;
  proposed: SharedUseApproval;
  current: SharedUseApproval | null;
  reason: SharedUseRequestReason;
  requestedBy: string;
  status: string;
  createdAt: string;
};
export type BotSharedApps = {
  apps: {
    serverId: string;
    title: string;
    approval: SharedUseApproval | null;
    needed: SharedUseApproval;
    covered: boolean;
  }[];
  pending: SharedUseRequest[];
};

/* Under ["approvals"], so the inbox's own refresh covers these too. */
export const sharedUseKeys = {
  requests: () => ["approvals", "shared-use"] as const,
  bot: (botId: string) => ["approvals", "shared-use", "bot", botId] as const,
};

/** Every request still waiting, read page by page until the list ends. */
async function waitingRequests(
  signal?: AbortSignal,
): Promise<SharedUseRequest[]> {
  const requests: SharedUseRequest[] = [];
  let cursor: string | undefined;
  do {
    const page = await listSharedUseRequests(
      organizationId(),
      { limit: 100, ...(cursor ? { cursor } : {}) },
      { signal, fallback: "Couldn't load shared account requests." },
    );
    requests.push(...page.sharedUseRequests);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return requests;
}

export function sharedUseRequestsQueryOptions(enabled: boolean) {
  return queryOptions({
    queryKey: sharedUseKeys.requests(),
    queryFn: ({ signal }) => waitingRequests(signal),
    enabled,
    refetchInterval: 10_000,
  });
}

export function botSharedAppsQueryOptions(botId: string) {
  return queryOptions({
    queryKey: sharedUseKeys.bot(botId),
    queryFn: ({ signal }): Promise<BotSharedApps> =>
      getBotSharedUse(organizationId(), botId, {
        signal,
        fallback: "Couldn't load this Bot's shared apps.",
      }),
  });
}

export function decideSharedUseMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async ({
      id,
      decision,
    }: {
      id: string;
      decision: "approve" | "decline";
    }) =>
      (decision === "approve"
        ? approveSharedUseRequest
        : declineSharedUseRequest)(
        organizationId(),
        id,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't save that decision." },
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["approvals"] }),
  });
}

export function requestSharedUseMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (body: {
      botId: string;
      serverId: string;
      reason: "publish" | "trigger";
    }) =>
      createSharedUseRequest(
        organizationId(),
        body,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't send the request." },
      ),
    onSettled: (_data, _error, body) =>
      queryClient.invalidateQueries({
        queryKey: sharedUseKeys.bot(body.botId),
      }),
  });
}

export function describeApproval(approval: SharedUseApproval): string {
  const outside = approval.outsideInput ? ", and outside input" : "";
  if (approval.audience === "owner") return `Only its owner${outside}`;
  if (approval.audience === "team") return `Everyone${outside}`;
  const groups = approval.members
    .filter((member) => member.kind === "group")
    .map((member) => member.value);
  const people = approval.members.filter(
    (member) => member.kind === "user",
  ).length;
  const parts = [
    ...(groups.length
      ? [`The group${groups.length > 1 ? "s" : ""} ${groups.join(", ")}`]
      : []),
    ...(people ? [`${people} ${people === 1 ? "person" : "people"}`] : []),
  ];
  return `${parts.join(" and ") || "Nobody named"}${outside}`;
}
