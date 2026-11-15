import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { agentKeys } from "@/lib/agents/queries";
import type {
  TeamBotAudience,
  TeamBotConsentAnswerDecision,
  TeamBot as TeamBotModel,
} from "@/lib/api/generated/model";
import {
  answerTeamBotConsent,
  assignTeamBot,
  clearTeamBotConsents,
  listTeamBots,
  publishTeamBot,
  unassignTeamBot,
  unpublishTeamBot,
} from "@/lib/api/generated/team-bots/team-bots";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { sharedUseKeys } from "@/lib/plugins/shared-use";

/**
 * A published Team Bot as this person sees it: the API's `TeamBot`. Who it reaches (`people`,
 * `groups`, `assignedGroups`) is there only for its owner and admins.
 */
export type TeamBot = TeamBotModel;

export const teamBotKeys = { all: ["team-bots"] as const };

/** A fresh key for each write a person asks for, as `once` in lib/agents/mutations.ts. */
const once = () => ({ "Idempotency-Key": idempotencyKey() });

/**
 * Every Team Bot this person may use or manages, page by page to the end. A repeated cursor ends
 * the list, as `everyBot` in lib/agents/queries.ts does.
 */
async function everyTeamBot(): Promise<TeamBot[]> {
  const teamBots: TeamBot[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await listTeamBots(
      organizationId(),
      { limit: 100, ...(cursor ? { cursor } : {}) },
      { fallback: "Team Bots could not be loaded." },
    );
    teamBots.push(...page.teamBots);
    if (cursor) seen.add(cursor);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && !seen.has(cursor));
  return teamBots;
}

export function teamBotsQueryOptions() {
  return queryOptions({
    queryKey: teamBotKeys.all,
    queryFn: (): Promise<TeamBot[]> => everyTeamBot(),
  });
}

/** Where a teammate starts a private chat with a Team Bot; what "Copy link" copies. */
export function teamBotLink(botId: string, origin = window.location.origin) {
  return `${origin}/channel/new?agent=${encodeURIComponent(botId)}`;
}

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
      audience: TeamBotAudience;
      emails: string[];
      groups: string[];
    }) => {
      const { botId, ...publication } = input;
      await publishTeamBot(organizationId(), botId, publication, once(), {
        fallback: "The Bot could not be published.",
      });
    },
    /* Publishing can widen who reaches a shared app, so the request inbox may now hold a
     * fresh one (or SharedAppNotice's own query may need to drop a request it just resolved). */
    onSettled: () =>
      Promise.all([
        refresh(queryClient),
        queryClient.invalidateQueries({ queryKey: sharedUseKeys.requests() }),
      ]),
  });
}

export function unpublishTeamBotMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (botId: string) => {
      await unpublishTeamBot(organizationId(), botId, once(), {
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
      const write = input.remove ? unassignTeamBot : assignTeamBot;
      await write(organizationId(), input.botId, input.group, once(), {
        fallback: "The assignment could not be saved.",
      });
    },
    onSettled: () => refresh(queryClient),
  });
}

export type TeamBotConsentDecision = TeamBotConsentAnswerDecision;

export function teamBotConsentMutationOptions() {
  return mutationOptions({
    mutationFn: async (input: {
      botId: string;
      serverId: string;
      decision: TeamBotConsentDecision;
    }) => {
      await answerTeamBotConsent(
        organizationId(),
        input.botId,
        { serverId: input.serverId, decision: input.decision },
        once(),
        { fallback: "Your answer could not be saved." },
      );
    },
  });
}

export function clearTeamBotConsentsMutationOptions() {
  return mutationOptions({
    mutationFn: async () => {
      await clearTeamBotConsents(organizationId(), "me", once(), {
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
