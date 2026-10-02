import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { agentKeys } from "@/lib/agents/queries";
import { client } from "@/lib/client";

/** A published Team Bot as this person sees it. Audience fields only for its owner and admins. */
export type TeamBot = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  mine: boolean;
  audience: "team" | "people";
  publishedAt: string;
  /** An administrator put it in this person's sidebar; they cannot hide it. */
  assigned: boolean;
  /** False while its name or description would leave teammates unable to see it. */
  visibleToTeam: boolean;
  people?: string[];
  groups?: string[];
  assignments?: string[];
};
export type TeamBotsData = {
  teamBots: TeamBot[];
  /** This person's own Bots that are not published yet. */
  publishable: { id: string; name: string; title: string }[];
};

export const teamBotKeys = { all: ["team-bots"] as const };

export function teamBotsQueryOptions() {
  return queryOptions({
    queryKey: teamBotKeys.all,
    queryFn: async (): Promise<TeamBotsData> => {
      const response = await client("/api/team-bots", {
        fallback: "Team Bots could not be loaded.",
      });
      return (await response.json()) as TeamBotsData;
    },
  });
}

/** Where a teammate starts a private chat with a Team Bot; what "Copy link" copies. */
export function teamBotLink(botId: string, origin = window.location.origin) {
  return `${origin}/channel/new?agent=${encodeURIComponent(botId)}`;
}

const path = (botId: string, rest = "") =>
  `/api/team-bots/${encodeURIComponent(botId)}${rest}`;

/** Any change to who can see a Bot changes the roster too. */
const refresh = (queryClient: QueryClient) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: teamBotKeys.all }),
    queryClient.invalidateQueries({ queryKey: agentKeys.all }),
  ]);

export function publishTeamBotMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      botId: string;
      audience: "team" | "people";
      emails: string[];
      groups: string[];
    }) => {
      const { botId, ...body } = input;
      await client(path(botId, "/publication"), {
        method: "PUT",
        body,
        fallback: "The Bot could not be published.",
      });
    },
    onSettled: () => refresh(queryClient),
  });
}

export function unpublishTeamBotMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (botId: string) => {
      await client(path(botId, "/publication"), {
        method: "DELETE",
        fallback: "The Bot could not be unpublished.",
      });
    },
    onSettled: () => refresh(queryClient),
  });
}

export function assignTeamBotMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      botId: string;
      group: string;
      remove?: boolean;
    }) => {
      await client(
        input.remove
          ? path(input.botId, `/assignments/${encodeURIComponent(input.group)}`)
          : path(input.botId, "/assignments"),
        {
          method: input.remove ? "DELETE" : "POST",
          ...(input.remove ? {} : { body: { group: input.group } }),
          fallback: "The assignment could not be saved.",
        },
      );
    },
    onSettled: () => refresh(queryClient),
  });
}

export type TeamBotConsentDecision =
  | "allow_once"
  | "allow_always"
  | "allow_all_team_bots"
  | "skip";

export function teamBotConsentMutationOptions() {
  return mutationOptions({
    mutationFn: async (input: {
      botId: string;
      serverId: string;
      decision: TeamBotConsentDecision;
    }) => {
      await client(path(input.botId, "/consents"), {
        method: "POST",
        body: { serverId: input.serverId, decision: input.decision },
        fallback: "Your answer could not be saved.",
      });
    },
  });
}

export function clearTeamBotConsentsMutationOptions() {
  return mutationOptions({
    mutationFn: async () => {
      await client("/api/team-bots/consents", {
        method: "DELETE",
        fallback: "Your connector preferences could not be cleared.",
      });
    },
  });
}

/** Mirrors `TEAM_BOT_CONSENT_MARKER` in server/src/team-bots/team-bots.ts. */
export const TEAM_BOT_CONSENT_MARKER = "[team-bot-consent]";

/** A consent refusal's card data, or null for any other tool result. */
export function readTeamBotConsent(
  text: string | undefined,
): { botId: string; serverId: string; message: string } | null {
  if (!text?.startsWith(TEAM_BOT_CONSENT_MARKER)) return null;
  const rest = text.slice(TEAM_BOT_CONSENT_MARKER.length);
  const end = rest.indexOf("}");
  if (end < 0) return null;
  try {
    const parsed = JSON.parse(rest.slice(0, end + 1)) as {
      botId?: unknown;
      serverId?: unknown;
    };
    if (typeof parsed.botId !== "string" || typeof parsed.serverId !== "string")
      return null;
    return {
      botId: parsed.botId,
      serverId: parsed.serverId,
      message: rest.slice(end + 1).trim(),
    };
  } catch {
    return null;
  }
}
