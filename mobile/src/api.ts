import * as Crypto from "expo-crypto";
import { authClient, serverUrl } from "./auth";

/** A refusal from the server, with its status and the API's problem code when it gave one. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The organization's address in the API. Until a person can belong to several, an install has one,
 * addressed as `default`.
 */
export const ORGANIZATION = "/api/v2/organizations/default";

/** Whether this request is a write to the API, which takes an Idempotency-Key. */
const apiWrite = (path: string, method: string | undefined) =>
  path.startsWith("/api/v2/") && !!method && method.toUpperCase() !== "GET";

/**
 * Every item of one of the API's lists, page by page. The API pages every list (`cursor`, `limit`,
 * `nextCursor`), and the screens here show the whole list. A cursor handed back twice ends it too.
 */
export async function everyPage<T>(path: string, key: string): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await api<Record<string, unknown>>(
      `${path}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    all.push(...((page[key] as T[] | undefined) ?? []));
    if (cursor) seen.add(cursor);
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
  } while (cursor && !seen.has(cursor));
  return all;
}

export async function api<T>(
  path: string,
  input?: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  },
): Promise<T> {
  if (!path.startsWith("/api/")) throw new Error("Use an OpenBot API path.");
  const cookie = await authClient.getCookie();
  const response = await fetch(`${serverUrl}${path}`, {
    method: input?.method,
    credentials: "omit",
    headers: {
      // A new key for each write asked for, unless the caller sends its own to retry with.
      ...(apiWrite(path, input?.method)
        ? { "Idempotency-Key": Crypto.randomUUID() }
        : {}),
      ...input?.headers,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(input?.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
    },
    ...(input?.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    signal: input?.signal,
  });
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json();
  if (!response.ok) {
    // Today's routes say why in `error`; the API's problems in `detail`.
    const said =
      body && typeof body === "object"
        ? (("detail" in body && typeof body.detail === "string"
            ? body.detail
            : undefined) ??
          ("error" in body && typeof body.error === "string"
            ? body.error
            : undefined))
        : undefined;
    const code =
      body &&
      typeof body === "object" &&
      "code" in body &&
      typeof body.code === "string"
        ? body.code
        : undefined;
    throw new ApiError(
      said ?? `Request failed (${response.status}).`,
      response.status,
      code,
    );
  }
  return body as T;
}
/** The person asking, as the API addresses them. */
const ME = `${ORGANIZATION}/people/me`;
/** Where one of the person's approvals is decided. */
export const approvalDecisionPath = (id: string) =>
  `${ME}/approvals/${encodeURIComponent(id)}/decide`;
/** Where one of the questions a Bot asked the person is answered. */
export const questionResponsePath = (id: string) =>
  `${ME}/questions/${encodeURIComponent(id)}/respond`;
export const APPROVAL_PREFERENCES_PATH = `${ME}/approval-preferences`;
export const APPROVAL_RULES_PATH = `${ME}/approval-rules`;
export const approvalRulePath = (id: string) =>
  `${APPROVAL_RULES_PATH}/${encodeURIComponent(id)}`;
/** What waits on the person: the actions their Bots asked about, and the questions they asked. */
export async function loadApprovalInbox(): Promise<ApprovalInbox> {
  const [requests, questions] = await Promise.all([
    everyPage<ApprovalInbox["requests"][number]>(
      `${ME}/approvals`,
      "approvals",
    ),
    everyPage<NonNullable<ApprovalInbox["questions"]>[number]>(
      `${ME}/questions`,
      "questions",
    ),
  ]);
  return { requests, questions };
}
/** The person's own approval preferences and rules, with what the organization set for everybody. */
export async function loadApprovalSettings(): Promise<ApprovalSettings> {
  const [preferences, rules, team, teamRules] = await Promise.all([
    api<{ enabled: boolean; autoReview: boolean }>(APPROVAL_PREFERENCES_PATH),
    everyPage<ApprovalRule>(APPROVAL_RULES_PATH, "approvalRules"),
    api<{ enforceAutoReview: boolean; customRulesEnabled: boolean }>(
      `${ORGANIZATION}/approval-settings`,
    ),
    everyPage<ApprovalRule>(`${ORGANIZATION}/approval-rules`, "approvalRules"),
  ]);
  return {
    enabled: preferences.enabled,
    rules,
    teamRules,
    preferences: {
      enabled: preferences.enabled,
      autoReview: preferences.autoReview,
    },
    team: {
      enforceAutoReview: team.enforceAutoReview,
      customRulesEnabled: team.customRulesEnabled,
    },
  };
}
/** A conversation, as the API lists it. */
export type Conversation = {
  id: string;
  name: string;
  botIds: string[];
  active: boolean;
};
/** One thing said in a conversation, as the API lists it. */
export type TranscriptMessage = {
  id: string;
  role: "person" | "bot" | "tool" | "system";
  text: string;
  /** How many tools the Bot called in this message, when it called any. */
  toolCalls?: number;
};
export type ApprovalInbox = {
  requests: {
    id: string;
    botId?: string;
    toolRef?: string;
    status: string;
    effect?: string;
    scope?: string;
    preview?: unknown;
    action?: {
      botId: string;
      toolRef: string;
      effect: string;
      scope: string;
      args: unknown;
      target?: unknown;
      /** Why it asked. A check-in task's approval (`source` "task") offers no standing rule. */
      policy?: { source: string; reason: string };
    };
  }[];
  questions?: {
    id: string;
    question: string;
    why?: string;
    botId: string;
    channelId?: string;
  }[];
};
/** A Bot as the API's `listBots` and `getBot` return it, in the fields this app reads. */
export type Bot = {
  id: string;
  name: string;
  title?: string;
  roleDescription?: string;
  mine: boolean;
  canManage: boolean;
};
/** The person's own state with a Bot, as the API's `getBotLifecycle` returns it. */
export type BotLifecycle = {
  botId: string;
  paused: boolean;
  pausedAt: string | null;
};

/** Every Bot this person can reach, read page by page to the end. */
export function everyBot(): Promise<Bot[]> {
  return everyPage<Bot>(`${ORGANIZATION}/bots`, "bots");
}

/** One Bot's address in the API. */
export function botPath(botId: string): string {
  return `${ORGANIZATION}/bots/${encodeURIComponent(botId)}`;
}
/**
 * Something a Bot's check-in found that needs the person, as the API's check-in items list
 * it (open ones only). `detail` says why it was raised; `sourceApp` is the app it was read in.
 */
export type CheckInItem = {
  id: string;
  botId: string;
  title: string;
  detail: string;
  sourceApp: string | null;
  sourceLink: string | null;
  createdAt: string;
};
/** What starting an item made of it: a task in its own conversation. */
export type StartedItem = { task: { id: string; conversationId: string } };
export type TaskStatus =
  | "needs_input"
  | "working"
  | "resolved"
  | "failed"
  | "ready_for_review";
/** A task started from an item, as the API lists it. */
export type BotTask = {
  id: string;
  botId: string;
  conversationId: string;
  title: string;
  status: TaskStatus;
  /** Why its turn couldn't finish, while failed. */
  failure: string | null;
  /** The last thing said in its conversation. */
  next: string | null;
  updatedAt: string;
};
export type RoutineStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "waiting";
export type Routine = {
  id: string;
  botId: string;
  /** Display text from the server; never parsed here. */
  schedule: string;
  timezone: string;
  instruction: string;
  conversation: { id: string; name: string | null; gone: boolean };
  enabled: boolean;
  nextRunAt: string;
  lastRun: { status: RoutineStatus | null; at: string | null } | null;
};
export type RoutineRun = {
  id: string;
  status: RoutineStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};
export type Memory = {
  id: string;
  content: string;
  provenance: string;
  enabled: boolean;
  reviewState: "unreviewed" | "confirmed" | "edited";
  formedBy: "person" | "import" | "bot";
  updatedAt: string;
};
export type RuleBehaviour = "allow" | "pre_approved" | "ask" | "hand_off";
export const BEHAVIOUR_LABELS: Record<RuleBehaviour, string> = {
  allow: "Take action without asking",
  pre_approved: "Take action if pre-approved",
  ask: "Ask before taking action",
  hand_off: "Hand off to you",
};
export type ApprovalRule = {
  id: string;
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  behaviour: RuleBehaviour;
};
export type ApprovalSettings = {
  enabled: boolean;
  rules: ApprovalRule[];
  teamRules: ApprovalRule[];
  preferences?: { enabled: boolean; autoReview: boolean };
  team?: { enforceAutoReview: boolean; customRulesEnabled: boolean };
};
/** One thing a Bot was given, as `GET .../bots/{botId}/grants` lists it. */
export type BotGrant = {
  id: string;
  kind: "action" | "skill" | "bot";
  ref: string;
  action: { description: string } | null;
  skill: { slug: string; title: string; summary: string } | null;
};
export type SkillSummary = { slug: string; title: string; summary: string };
/** Who drives a Bot's computer: the API's ComputerControl, as `GET .../computers/{botId}/control` answers. */
export type ControlState = {
  holder: "bot" | "human";
  requested: boolean;
  reason?: string;
  transitioning: boolean;
  request?: { id: string; status: string; reason: string };
  secretWanted?: string;
};
/** One frame of a Bot's screen: the API's ComputerFrame. */
export type Screenshot = {
  base64: string;
  width: number;
  height: number;
  url?: string;
};
