import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import type {
  SharedUseApproval as ApiSharedUseApproval,
  SharedUseAudience,
  SharedUseMember,
} from "@/lib/api/generated/model";
import {
  approveSharedUseRequest,
  createSharedUseRequest,
  declineSharedUseRequest,
  getBotSharedUse,
  listSharedUseRequests,
} from "@/lib/api/generated/shared-use/shared-use";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { teamName } from "@/lib/teams/names";

/**
 * Who may steer a Bot that uses a shared account: the API's own audience. `team` is everyone in the
 * organization, never one team. A team is named as a member of a `people` audience.
 */
export type SharedAudience = SharedUseAudience;
/** A person by id, a team by id, or a directory group by its name: the API's own member. */
export type ApprovalMember = SharedUseMember;
/** An audience for a Bot's use of a shared account: the API's `SharedUseApproval`. */
export type SharedUseApproval = ApiSharedUseApproval;
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

/** Whether an approval names a team, so its reader needs the organization's teams to say which. */
export function approvalNamesTeam(
  approval: SharedUseApproval | null | undefined,
): boolean {
  return (
    approval?.audience === "people" &&
    approval.members.some((member) => member.kind === "team")
  );
}

/** Whether an approval is for named teams and people and names nobody, which covers no one. */
export function approvalNamesNobody(approval: SharedUseApproval): boolean {
  return approval.audience === "people" && approval.members.length === 0;
}

/**
 * Who an approval covers, in a line. A team is called by its name, looked up in the organization's
 * `teams`, never by its id: one that is not among them has been deleted since and says so. Before
 * the teams have arrived the line says how many teams, which is all it knows. Directory groups and
 * people read as they always have.
 */
export function describeApproval(
  approval: SharedUseApproval,
  teams?: readonly { id: string; name: string }[],
): string {
  const outside = approval.outsideInput ? ", and outside input" : "";
  if (approval.audience === "owner") return `Only its owner${outside}`;
  if (approval.audience === "team") return `Everyone${outside}`;
  const teamIds = approval.members
    .filter((member) => member.kind === "team")
    .map((member) => member.value);
  const known = teams
    ? teamIds
        .filter((id) => teams.some((team) => team.id === id))
        .map((id) => teamName(teams, id))
    : [];
  const gone = teams ? teamIds.length - known.length : 0;
  const groups = approval.members
    .filter((member) => member.kind === "group")
    .map((member) => member.value);
  const people = approval.members.filter(
    (member) => member.kind === "user",
  ).length;
  const parts = [
    ...(teams === undefined && teamIds.length
      ? [`${teamIds.length} ${teamIds.length === 1 ? "team" : "teams"}`]
      : []),
    ...(known.length
      ? [`the team${known.length > 1 ? "s" : ""} ${known.join(", ")}`]
      : []),
    ...(gone === 1 ? ["a team that no longer exists"] : []),
    ...(gone > 1 ? [`${gone} teams that no longer exist`] : []),
    ...(groups.length
      ? [`the group${groups.length > 1 ? "s" : ""} ${groups.join(", ")}`]
      : []),
    ...(people ? [`${people} ${people === 1 ? "person" : "people"}`] : []),
  ];
  const last = parts.pop();
  const named =
    last === undefined
      ? "Nobody named"
      : parts.length
        ? `${parts.join(", ")} and ${last}`
        : last;
  return `${named.charAt(0).toUpperCase()}${named.slice(1)}${outside}`;
}
