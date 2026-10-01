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
  | "teamBots";

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
