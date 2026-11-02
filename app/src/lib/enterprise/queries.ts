import { queryOptions } from "@tanstack/react-query";
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
  | "isolatedComputers";

/** One switch as the server stored it at each scope. `null` means no row: the scope inherits. */
export type CapabilitySetting = {
  capability: CapabilityKey;
  title: string;
  description: string;
  default: boolean;
  organization: boolean | null;
  roles: Partial<Record<"admin" | "user", boolean>>;
  groups: Record<string, boolean>;
};

export type EgressRule =
  | { type: "domain"; value: string }
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

export const enterpriseKeys = {
  all: ["enterprise"] as const,
  overview: () => ["enterprise", "overview"] as const,
  modelUsage: (days: number) =>
    ["enterprise", "model-usage", { days }] as const,
  actions: () => ["enterprise", "actions"] as const,
};

export function enterpriseOverviewQueryOptions() {
  return queryOptions({
    queryKey: enterpriseKeys.overview(),
    queryFn: async (): Promise<EnterpriseOverview> =>
      (
        await client("/api/admin/enterprise", {
          fallback: "Could not load enterprise controls",
        })
      ).json(),
  });
}

export function modelUsageQueryOptions(days = 30) {
  return queryOptions({
    queryKey: enterpriseKeys.modelUsage(days),
    queryFn: async (): Promise<{
      summary: ModelUsageSummary[];
      recent: ModelUsageRow[];
    }> =>
      (
        await client(`/api/admin/enterprise/models/usage?days=${days}`, {
          fallback: "Could not load model usage",
        })
      ).json(),
  });
}

export function actionRecordsQueryOptions() {
  return queryOptions({
    queryKey: enterpriseKeys.actions(),
    queryFn: (): Promise<ActionRecord[]> =>
      client("/api/admin/enterprise/actions?limit=50", "actions", {
        fallback: "Could not load recorded actions",
      }),
  });
}

/** The capability switches as they apply to the person asking. */
export type MyCapabilities = {
  capabilities: Partial<Record<CapabilityKey, boolean>>;
  /** False on a deployment running without enterprise controls, where the defaults stand. */
  enforced: boolean;
};

/**
 * What this person may use, which is not an administrator's read.
 *
 * `/me` sits under the enterprise ADMIN prefix and is deliberately the one route there that any
 * signed-in person may call: the switches decide what the app offers them, so the app has to be
 * able to ask. Everything else behind that prefix requires an administrator.
 */
export function myCapabilitiesQueryOptions() {
  return queryOptions({
    queryKey: ["enterprise", "me"] as const,
    queryFn: async (): Promise<MyCapabilities> =>
      (
        await client("/api/admin/enterprise/me", {
          fallback: "Could not load what this deployment allows",
        })
      ).json(),
  });
}
