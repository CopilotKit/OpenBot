import { queryOptions } from "@tanstack/react-query";
import {
  getPersonCapabilities,
  listCapabilities,
} from "@/lib/api/generated/capabilities/capabilities";
import {
  listNetworkPolicies,
  replayNetworkPolicy,
} from "@/lib/api/generated/network-policies/network-policies";
import {
  getModelUsage,
  getOrganizationSettings,
  listComputerActions,
} from "@/lib/api/generated/organization-settings/organization-settings";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
import { client } from "@/lib/client";

export type CapabilityKey =
  | "useBots"
  | "cloudBrowser"
  | "cloudNetwork"
  | "cloudComputer"
  | "localComputer"
  | "customRules"
  | "passwordManager"
  | "slackTeams"
  | "teamBots"
  | "ownerApps"
  | "isolatedComputers"
  | "proactive";

/** One switch as the server stored it at each scope. `null` means no row: the scope inherits. */
export type CapabilitySetting = {
  capability: CapabilityKey;
  title: string;
  description: string;
  default: boolean;
  organization: boolean | null;
  /** Each member role's switch, by role. */
  roles: Partial<Record<"owner" | "admin" | "member", boolean>>;
  groups: Record<string, boolean>;
};

/** One allowlist entry. Either kind can name ports (`443`, `5432,8000-8100`); without them, every port. */
export type EgressRule =
  | { type: "domain"; value: string; ports?: string }
  | { type: "cidr"; value: string; ports?: string };

export type NetworkMode =
  | "allow_all"
  | "defaults_plus_allowlist"
  | "allowlist_only";

export type NetworkPolicy = {
  scopeKind: "organization" | "group";
  scopeId: string;
  mode: NetworkMode;
  rules: EgressRule[];
  locked: boolean;
  updatedBy: string | null;
  updatedAt: string;
};

export type EnterpriseSettings = {
  ssoRequired: boolean;
  actionRecording: boolean;
  inactiveComputerDays: number;
  modelAllowlist: { enabled: boolean; models: string[] };
  mcpAllowlist: { enabled: boolean; servers: string[] };
  /** People may open the Skills learned from their recordings to every Bot. Off by default. */
  skillSharing: boolean;
  /** How many check-ins each Bot may run for one person in a day. 24 by default. */
  proactiveDailyRuns: number;
  /** People may pick the model a built-in Bot answers on, per conversation. Off by default. */
  modelSelection: boolean;
};

export type EnterpriseOverview = {
  capabilities: CapabilitySetting[];
  settings: EnterpriseSettings;
  groups: string[];
  network: NetworkPolicy[];
  defaultDestinations: string[];
  mcpServers: { id: string; title: string; url: string }[];
  builtInModel: string | null;
  scim: {
    configured: boolean;
    connectionId: string;
    baseUrl: string | null;
    rotating: boolean;
  };
  otel: { configured: boolean };
  actionRecordRetentionDays: number;
};

export type ModelUsageSummary = {
  model: string;
  source: "configured" | "observed" | "unknown";
  runs: number;
  refused: number;
  people: number;
  lastUsedAt: string;
};

export type ModelUsageRow = {
  id: string;
  email: string | null;
  agentId: string;
  model: string;
  source: string;
  allowed: boolean;
  createdAt: string;
};

export type ActionRecord = {
  id: string;
  surface: "cloud" | "local";
  botId: string | null;
  toolName: string;
  command: string;
  outcome: string;
  createdAt: string;
};

/** Why a check-in stopped before the model. */
export type CheckInSkipReason =
  | "off_admin"
  | "off_person"
  | "paused"
  | "capped"
  | "unreachable"
  | "no_sources"
  | "busy";

/**
 * One Bot's check-ins over the window, as the admin's Check-ins page reads them. Counts only: the
 * server sends no titles and no people.
 *
 * `items` are the ones raised in the window, by where each stands now, so `raised` is the sum of the
 * other four. `acceptance` is started out of started and hidden, null until somebody answered one.
 */
export type BotCheckInMetrics = {
  agentId: string;
  name: string;
  avatarSeed: string;
  /** People whose check-ins with this Bot are on now. */
  peopleOn: number;
  runs: {
    quiet: number;
    raised: number;
    failed: number;
    skipped: Record<CheckInSkipReason, number>;
  };
  items: {
    raised: number;
    started: number;
    hidden: number;
    cleared: number;
    open: number;
  };
  acceptance: number | null;
  /** This Bot's items that a ping carried. */
  pinged: number;
};

export type CheckInMetrics = {
  days: 7 | 30;
  /** The daily cap in force. */
  dailyRuns: number;
  bots: BotCheckInMetrics[];
  /** One ping folds every Bot's items for a person, so pings are counted for everybody at once. */
  pings: { sent: number; itemsPerPing: number | null };
};

export const enterpriseKeys = {
  all: ["enterprise"] as const,
  overview: () => ["enterprise", "overview"] as const,
  modelUsage: (days: number) =>
    ["enterprise", "model-usage", { days }] as const,
  actions: () => ["enterprise", "actions"] as const,
  /*
   * Under the enterprise root although the route is `/api/admin/proactive`: who has check-ins on and
   * the cap in force both move when a switch or a setting is saved, and every enterprise write
   * invalidates this root.
   */
  checkIns: (days: 7 | 30) => ["enterprise", "check-ins", { days }] as const,
  /* Under the root, so saving a policy, which changes the one in force, asks the replay again. */
  networkReplay: (candidate: NetworkCandidate) =>
    ["enterprise", "network-replay", candidate] as const,
};

/** A network policy as the dialog holds it, not yet saved. */
export type NetworkCandidate = {
  scopeKind: "organization" | "group";
  scopeId: string;
  mode: NetworkMode;
  rules: EgressRule[];
  locked: boolean;
};

/** One host whose page visits a candidate decides differently from the policy in force. */
export type NetworkReplayHost = {
  host: string;
  /** "block": allowed today, blocked by the candidate. "allow": the other way round. */
  change: "block" | "allow";
  visits: number;
  /** The Bots that made them, by id. */
  bots: string[];
  lastVisit: string;
};

/**
 * Recent page visits replayed under a candidate network policy, beside the policy in force.
 * `covered` is the visits by Bots the candidate would apply to; `undecided` is visits to a named host
 * that only an IP range could allow, which the computer decides with an address the trail doesn't keep.
 */
export type NetworkReplayReport = {
  scanned: number;
  covered: number;
  wouldBlock: number;
  wouldAllow: number;
  undecided: number;
  unchanged: number;
  /** Capped by the server; the counts cover every visit, and `sites` every site. */
  hosts: NetworkReplayHost[];
  sites: number;
};

/**
 * What a network policy would change, over the page visits on the trail. Writes nothing. A list the
 * save would refuse is refused here too, with the parser's sentence.
 */
export function networkReplayQueryOptions(candidate: NetworkCandidate) {
  return queryOptions({
    queryKey: enterpriseKeys.networkReplay(candidate),
    queryFn: ({ signal }): Promise<NetworkReplayReport> =>
      // An action that saves nothing: each ask is its own, so each gets its own key.
      replayNetworkPolicy(
        ORGANIZATION_ID,
        candidate,
        { "Idempotency-Key": idempotencyKey() },
        {
          signal,
          fallback: "Couldn't check this list against recent page visits.",
        },
      ),
  });
}

/** Every page of a list, for a screen that shows all of it. */
async function everyPage<T>(
  read: (cursor: string | undefined) => Promise<{
    items: T[];
    nextCursor: string | null;
  }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

const OVERVIEW_FALLBACK = "Could not load enterprise controls";

/**
 * The admin's settings screens, read as one: the organization's settings with what goes beside them,
 * every permission switch, and every network policy, from the API's three resources.
 */
export function enterpriseOverviewQueryOptions() {
  return queryOptions({
    queryKey: enterpriseKeys.overview(),
    queryFn: async ({ signal }): Promise<EnterpriseOverview> => {
      const options = { signal, fallback: OVERVIEW_FALLBACK };
      const [settings, capabilities, network] = await Promise.all([
        getOrganizationSettings(ORGANIZATION_ID, options),
        everyPage(async (cursor) => {
          const page = await listCapabilities(
            ORGANIZATION_ID,
            { limit: 100, ...(cursor ? { cursor } : {}) },
            options,
          );
          return { items: page.capabilities, nextCursor: page.nextCursor };
        }),
        everyPage(async (cursor) => {
          const page = await listNetworkPolicies(
            ORGANIZATION_ID,
            { limit: 100, ...(cursor ? { cursor } : {}) },
            options,
          );
          return { items: page.networkPolicies, nextCursor: page.nextCursor };
        }),
      ]);
      const { context, ...values } = settings;
      return {
        capabilities: capabilities.map(({ id, ...capability }) => ({
          capability: id,
          ...capability,
        })),
        settings: values,
        groups: context.directoryGroups,
        network: network.map(({ id: _id, ...policy }) => policy),
        defaultDestinations: context.defaultDestinations,
        mcpServers: context.apps,
        builtInModel: context.builtInModel,
        scim: context.scim,
        otel: context.otel,
        actionRecordRetentionDays: context.actionRecordRetentionDays,
      };
    },
  });
}

export function modelUsageQueryOptions(days = 30) {
  return queryOptions({
    queryKey: enterpriseKeys.modelUsage(days),
    queryFn: async ({
      signal,
    }): Promise<{
      summary: ModelUsageSummary[];
      recent: ModelUsageRow[];
    }> => {
      const usage = await getModelUsage(
        ORGANIZATION_ID,
        { days },
        { signal, fallback: "Could not load model usage" },
      );
      return {
        // The server names how each model is known with one of three words.
        summary: usage.summary as ModelUsageSummary[],
        recent: usage.recent,
      };
    },
  });
}

export function checkInMetricsQueryOptions(days: 7 | 30) {
  return queryOptions({
    queryKey: enterpriseKeys.checkIns(days),
    queryFn: async (): Promise<CheckInMetrics> =>
      (
        await client(`/api/admin/proactive?days=${days}`, {
          fallback: "Couldn't load check-ins",
        })
      ).json(),
  });
}

/** The newest 50 recorded commands: the first page of the API's list. */
export function actionRecordsQueryOptions() {
  return queryOptions({
    queryKey: enterpriseKeys.actions(),
    queryFn: async ({ signal }): Promise<ActionRecord[]> =>
      (
        await listComputerActions(
          ORGANIZATION_ID,
          { limit: 50 },
          { signal, fallback: "Could not load recorded actions" },
        )
      ).computerActions,
  });
}

/** The capability switches as they apply to the person asking. */
export type MyCapabilities = {
  capabilities: Partial<Record<CapabilityKey, boolean>>;
  /** False on a deployment running without enterprise controls, where the defaults stand. */
  enforced: boolean;
};

/**
 * What this person may use, which is not an administrator's read: the API's `people/me/capabilities`,
 * which anybody signed in may ask about themselves. The switches decide what the app offers them, so
 * the app has to be able to ask.
 */
export function myCapabilitiesQueryOptions() {
  return queryOptions({
    queryKey: ["enterprise", "me"] as const,
    queryFn: ({ signal }): Promise<MyCapabilities> =>
      getPersonCapabilities(ORGANIZATION_ID, "me", {
        signal,
        fallback: "Couldn't load what OpenBot allows.",
      }),
  });
}
