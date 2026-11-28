import type { AppAccess, AppAccessRequest } from "@/lib/app-access/queries";

/**
 * The Bot grants and app access request API as the server answers it, for a test that fakes `fetch`
 * by hand.
 *
 * The app reads what a Bot may use, a Bot's apps, the apps a person could give and the requests for
 * apps through the client generated from api/openapi.yaml, at
 * `/api/v2/organizations/default/bots/{botId}/grants`, `/bots/{botId}/apps`,
 * `/people/me/giveable-apps` and `/app-access-requests`. A test written in the screens' own words
 * (what a Bot holds, an app as the card draws it, a request as the inbox draws it) passes them here
 * and gets the API's answer.
 */

/**
 * The Response a real `fetch` returns. Read before any test registers happy-dom, as each test file
 * that needs it does at its top.
 */
const NativeResponse = globalThis.Response;

const ORGANIZATION = "/api/v2/organizations/default";
export const GIVEABLE_APPS_PATH = `${ORGANIZATION}/people/me/giveable-apps`;
export const APP_ACCESS_REQUESTS_PATH = `${ORGANIZATION}/app-access-requests`;
/** How apps are set up here: the card reads which directory service the apps come from. */
export const APP_SETUP_PATH = `${ORGANIZATION}/app-setup`;

/** A Bot's grants: what it holds, given and taken one at a time or one app's actions together. */
export function botGrantsPath(botId: string): string {
  return `${ORGANIZATION}/bots/${encodeURIComponent(botId)}/grants`;
}

/** One grant's address: `action:<app id>:<action name>`, `skill:<slug>` or `bot:<Bot id>`. */
export function botGrantPath(botId: string, grantId: string): string {
  return `${botGrantsPath(botId)}/${encodeURIComponent(grantId)}`;
}

/** A Bot's apps, each as it stands for the person asking. */
export function botAppsPath(botId: string): string {
  return `${ORGANIZATION}/bots/${encodeURIComponent(botId)}/apps`;
}

/** One app on a Bot, and its `give`, `take-back` and `approve` actions beneath it. */
export function botAppPath(botId: string, appId: string): string {
  return `${botAppsPath(botId)}/${encodeURIComponent(appId)}`;
}

/** One request, and its `approve` and `dismiss` actions beneath it. */
export function appAccessRequestPath(id: string): string {
  return `${APP_ACCESS_REQUESTS_PATH}/${encodeURIComponent(id)}`;
}

/**
 * What a Bot holds, in the words the screens read it: its apps' actions and its skills. Anything
 * else a test wrote beside them (a skill's instructions, a tool's model name) the API doesn't send,
 * and is left out.
 */
export type HeldToday = {
  tools?: ({ ref: string; description?: string } & Record<string, unknown>)[];
  skills?: ({ slug: string; title?: string; summary?: string } & Record<
    string,
    unknown
  >)[];
  /** Other Bots it may hand work to, by id. */
  bots?: string[];
};

/** The API's page of a Bot's grants for what a test says the Bot holds, on one page. */
export function botGrantsBody(held: HeldToday = {}) {
  const actions = (held.tools ?? []).map((tool) => {
    const slash = tool.ref.indexOf("/");
    const appId = slash < 0 ? tool.ref : tool.ref.slice(0, slash);
    const name = slash < 0 ? "" : tool.ref.slice(slash + 1);
    return {
      id: `action:${appId}:${name}`,
      kind: "action",
      ref: tool.ref,
      action: {
        appId,
        name,
        description: tool.description ?? "",
        destructive: false,
        read: true,
      },
      skill: null,
    };
  });
  const skills = (held.skills ?? []).map((skill) => ({
    id: `skill:${skill.slug}`,
    kind: "skill",
    ref: skill.slug,
    action: null,
    skill: {
      slug: skill.slug,
      title: skill.title ?? skill.slug,
      summary: skill.summary ?? "",
    },
  }));
  const bots = (held.bots ?? []).map((bot) => ({
    id: `bot:${bot}`,
    kind: "bot",
    ref: bot,
    action: null,
    skill: null,
  }));
  return { grants: [...actions, ...bots, ...skills], nextCursor: null };
}

export function botGrantsResponse(held: HeldToday = {}): Response {
  return NativeResponse.json(botGrantsBody(held));
}

/** One app on a Bot as the API answers it, from the app as the card draws it. */
export function botAppBody(access: AppAccess) {
  return {
    id: access.key,
    title: access.displayName,
    logo: access.logo,
    source: access.source,
    account: access.account,
    connect: access.connect,
    state: access.state,
    unavailable: access.unavailable,
    accountHolder: access.accountHolder,
    asksFirst: access.asksFirst,
    granted: access.granted,
    ownerGrants: access.ownerGrants,
    givenByOwner: access.givenByOwner,
    needsConnect: access.needsConnect,
    connectedAt: access.connectedAt,
    requestKind: access.requestKind,
    pendingRequest: access.request,
  };
}

export function botAppResponse(access: AppAccess): Response {
  return NativeResponse.json(botAppBody(access));
}

/** A Bot's apps on one page. */
export function botAppsResponse(apps: AppAccess[]): Response {
  return NativeResponse.json({ apps: apps.map(botAppBody), nextCursor: null });
}

/** The apps a person could give their own Bots, on one page. */
export function giveableAppsResponse(
  apps: Pick<AppAccess, "key" | "displayName" | "logo" | "account">[],
): Response {
  return NativeResponse.json({
    apps: apps.map((app) => ({
      id: app.key,
      title: app.displayName,
      logo: app.logo,
      account: app.account,
    })),
    nextCursor: null,
  });
}

/** One request as the inbox draws it: a person asking to give Gmail to Expenses. Override any field. */
export function appAccessRequest(
  overrides: Partial<AppAccessRequest> = {},
): AppAccessRequest {
  return {
    id: "req_1",
    appKey: "composio-gmail",
    appTitle: "Gmail",
    kind: "grant",
    status: "pending",
    agentId: "expenses",
    botName: "Expenses",
    requestedBy: "usr_ada",
    requesterEmail: "ada@example.com",
    requesterName: "Ada",
    createdAt: "2026-10-20T10:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    actions: [],
    ...overrides,
  };
}

/** A request for an app as the API answers it, from the request as the inbox draws it. */
export function appAccessRequestBody(request: AppAccessRequest) {
  return {
    id: request.id,
    appId: request.appKey,
    appTitle: request.appTitle,
    kind: request.kind,
    status: request.status,
    botId: request.agentId,
    botName: request.botName,
    requestedBy: request.requestedBy,
    requesterEmail: request.requesterEmail,
    requesterName: request.requesterName,
    createdAt: request.createdAt,
    resolvedAt: request.resolvedAt,
    resolvedBy: request.resolvedBy,
    actions: request.actions,
  };
}

export function appAccessRequestResponse(request: AppAccessRequest): Response {
  return NativeResponse.json(appAccessRequestBody(request));
}

/** Waiting requests on one page. */
export function appAccessRequestsResponse(
  requests: AppAccessRequest[],
): Response {
  return NativeResponse.json({
    appAccessRequests: requests.map(appAccessRequestBody),
    nextCursor: null,
  });
}

/** What approving changed: the request, answered, whether the app was turned on, and what was given. */
export function appAccessApprovalResponse(approval: {
  request: AppAccessRequest;
  enabled?: boolean;
  granted?: string[];
}): Response {
  return NativeResponse.json({
    appAccessRequest: appAccessRequestBody(approval.request),
    enabled: approval.enabled ?? false,
    granted: approval.granted ?? [],
  });
}

/** How apps are set up here, with the directory service named; everything else off. */
export function appSetupResponse(
  directoryProvider: "composio" | "arcade" | null = "composio",
): Response {
  return NativeResponse.json({
    directoryAvailable: directoryProvider !== null,
    directoryProvider,
    authorizesPerAction: false,
    botsMayCallBack: false,
    redirectUri: null,
  });
}
