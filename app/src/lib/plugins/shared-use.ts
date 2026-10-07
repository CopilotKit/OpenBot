import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";

export type SharedAudience = "owner" | "people" | "team";
export type ApprovalMember = { kind: "user" | "group"; value: string };
export type SharedUseApproval = {
  audience: SharedAudience;
  outsideInput: boolean;
  members: ApprovalMember[];
};
export type SharedUseRequest = {
  id: string;
  botId: string;
  botName: string;
  ownerUserId: string | null;
  serverId: string;
  title: string;
  proposed: SharedUseApproval;
  current: SharedUseApproval | null;
  reason: string;
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

export function sharedUseRequestsQueryOptions(enabled: boolean) {
  return queryOptions({
    queryKey: sharedUseKeys.requests(),
    queryFn: () =>
      client<SharedUseRequest[]>("/api/approvals/shared-use", "requests", {
        fallback: "Shared account requests could not be loaded.",
      }),
    enabled,
    refetchInterval: 10_000,
  });
}

export function botSharedAppsQueryOptions(botId: string) {
  return queryOptions({
    queryKey: sharedUseKeys.bot(botId),
    queryFn: async (): Promise<BotSharedApps> => {
      const response = await client(
        `/api/approvals/shared-use/bot/${encodeURIComponent(botId)}`,
        { fallback: "This Bot's shared apps could not be loaded." },
      );
      return response.json();
    },
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
      client(
        `/api/approvals/shared-use/${encodeURIComponent(id)}/${decision}`,
        { method: "POST", fallback: "That decision could not be saved." },
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
      client("/api/approvals/shared-use", {
        method: "POST",
        body,
        fallback: "The request could not be sent.",
      }),
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
