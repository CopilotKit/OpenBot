/**
 * The admin settings API as the server answers it, for a test that fakes `fetch` by hand.
 *
 * The app reads what this OpenBot offers, the organization's settings, permission switches, network
 * policies, model usage, recorded commands, a person's own switches and the setup checklist through
 * the client generated from api/openapi.yaml, at `/api/v2/organizations/default/...`. A test written
 * against what `/api/capabilities`, `/api/admin/enterprise` and `/api/setup` answered passes that
 * here and gets the API's answer.
 */

/**
 * The Response a real `fetch` returns. Read before any test registers happy-dom, as each test file
 * that needs it does at its top.
 */
const NativeResponse = globalThis.Response;

const ORGANIZATION = "/api/v2/organizations/default";
/** What this OpenBot offers, read before anybody signs in. */
export const DEPLOYMENT_PATH = `${ORGANIZATION}/deployment`;
export const SETTINGS_PATH = `${ORGANIZATION}/settings`;
export const STOP_INACTIVE_COMPUTERS_PATH = `${SETTINGS_PATH}/stop-inactive-computers`;
export const CAPABILITIES_PATH = `${ORGANIZATION}/capabilities`;
export const BATCH_UPDATE_CAPABILITIES_PATH = `${CAPABILITIES_PATH}/batch-update`;
export const TRANSLATE_CAPABILITIES_PATH = `${CAPABILITIES_PATH}/translate`;
export const PREVIEW_CAPABILITIES_PATH = `${CAPABILITIES_PATH}/preview`;
export const NETWORK_POLICIES_PATH = `${ORGANIZATION}/network-policies`;
export const TRANSLATE_NETWORK_POLICY_PATH = `${NETWORK_POLICIES_PATH}/translate`;
export const REPLAY_NETWORK_POLICY_PATH = `${NETWORK_POLICIES_PATH}/replay`;
export const MODEL_USAGE_PATH = `${ORGANIZATION}/model-usage`;
export const COMPUTER_ACTIONS_PATH = `${ORGANIZATION}/computer-actions`;
export const SETUP_CHECKLIST_PATH = `${ORGANIZATION}/setup-checklist`;
export const CHECK_SETUP_PATH = `${SETUP_CHECKLIST_PATH}/check`;
/** The switches as they apply to the person asking. */
export const MY_CAPABILITIES_PATH = `${ORGANIZATION}/people/me/capabilities`;

/** One switch's address, which a change to it is sent to. */
export function capabilityPath(capability: string): string {
  return `${CAPABILITIES_PATH}/${capability}`;
}

/** A network policy's address: `organization`, or `group:` and the group's name. */
export function networkPolicyPath(
  scopeKind: "organization" | "group",
  scopeId = "",
): string {
  return `${NETWORK_POLICIES_PATH}/${encodeURIComponent(
    scopeKind === "organization" ? "organization" : `group:${scopeId}`,
  )}`;
}

/** What `/api/capabilities` answered, which a test may give in part. */
export type TodayDeployment = {
  edition?: string;
  localEvaluation?: boolean;
  generativeUi?: boolean;
  selfHostBanner?: boolean;
  transcription?: boolean;
  voice?: boolean;
  durableHistory?: boolean;
  authProviders?: string[];
  ssoConfigured?: boolean;
  ssoRequired?: boolean;
};

/** The API's `deployment`, with what a test left out read as off. */
export function deploymentBody(today: TodayDeployment = {}) {
  return {
    edition: today.edition === "personal" ? "personal" : "team",
    localEvaluation: today.localEvaluation === true,
    generativeUi: today.generativeUi === true,
    selfHostBanner: today.selfHostBanner === true,
    transcription: today.transcription === true,
    voice: today.voice === true,
    durableHistory: today.durableHistory === true,
    authProviders: today.authProviders ?? [],
    ssoConfigured: today.ssoConfigured === true,
    ssoRequired: today.ssoRequired === true,
  };
}

export function deploymentResponse(today: TodayDeployment = {}): Response {
  return NativeResponse.json(deploymentBody(today));
}

/** The setup checklist, as the API answers it: itself, not wrapped. */
export function setupChecklistResponse(checklist: unknown): Response {
  return NativeResponse.json(checklist);
}

/** A person's own switches, as `/api/admin/enterprise/me` answered them and the API still does. */
export function myCapabilitiesResponse(mine: {
  capabilities: Record<string, boolean>;
  enforced?: boolean;
}): Response {
  return NativeResponse.json({
    capabilities: mine.capabilities,
    enforced: mine.enforced ?? true,
  });
}

/** What `GET /api/admin/enterprise` answered, which a test may give in part. */
export type TodayOverview = {
  capabilities?: {
    capability: string;
    title: string;
    description: string;
    default: boolean;
    organization: boolean | null;
    roles: Record<string, boolean>;
    groups: Record<string, boolean>;
  }[];
  settings?: Record<string, unknown>;
  groups?: string[];
  network?: {
    scopeKind: "organization" | "group";
    scopeId: string;
    mode: string;
    rules: unknown[];
    locked: boolean;
    updatedBy: string | null;
    updatedAt: string;
  }[];
  defaultDestinations?: string[];
  mcpServers?: { id: string; title: string; url: string }[];
  builtInModel?: string | null;
  scim?: {
    configured: boolean;
    connectionId: string;
    baseUrl: string | null;
    rotating: boolean;
  };
  otel?: { configured: boolean };
  actionRecordRetentionDays?: number;
};

const DEFAULT_SETTINGS = {
  ssoRequired: false,
  actionRecording: false,
  inactiveComputerDays: 30,
  modelAllowlist: { enabled: false, models: [] },
  mcpAllowlist: { enabled: false, servers: [] },
  skillSharing: false,
  proactiveDailyRuns: 24,
  modelSelection: false,
};

/** The organization's settings, with what goes beside them, from today's overview. */
export function settingsBody(overview: TodayOverview) {
  return {
    ...DEFAULT_SETTINGS,
    ...overview.settings,
    context: {
      builtInModel: overview.builtInModel ?? null,
      directoryGroups: overview.groups ?? [],
      apps: overview.mcpServers ?? [],
      defaultDestinations: overview.defaultDestinations ?? [],
      scim: overview.scim ?? {
        configured: false,
        connectionId: "scim",
        baseUrl: null,
        rotating: false,
      },
      otel: overview.otel ?? { configured: false },
      actionRecordRetentionDays: overview.actionRecordRetentionDays ?? 90,
    },
  };
}

/**
 * The API's answer to one of the three reads the admin's settings screens are drawn from (the
 * settings, the switches and the network policies), from what `GET /api/admin/enterprise` answered;
 * undefined for any other request. Every list on one page.
 */
export function overviewResponse(
  path: string,
  overview: TodayOverview,
): Response | undefined {
  const pathname = path.split("?")[0];
  if (pathname === SETTINGS_PATH)
    return NativeResponse.json(settingsBody(overview));
  if (pathname === CAPABILITIES_PATH)
    return NativeResponse.json({
      capabilities: (overview.capabilities ?? []).map(
        ({ capability, ...rest }) => ({ id: capability, ...rest }),
      ),
      nextCursor: null,
    });
  if (pathname === NETWORK_POLICIES_PATH)
    return NativeResponse.json({
      networkPolicies: (overview.network ?? []).map((policy) => ({
        id:
          policy.scopeKind === "organization"
            ? "organization"
            : `group:${policy.scopeId}`,
        ...policy,
      })),
      nextCursor: null,
    });
  return undefined;
}

/** Whether a request is one of the three reads {@link overviewResponse} answers. */
export function isOverviewRead(path: string): boolean {
  const pathname = path.split("?")[0];
  return (
    pathname === SETTINGS_PATH ||
    pathname === CAPABILITIES_PATH ||
    pathname === NETWORK_POLICIES_PATH
  );
}
