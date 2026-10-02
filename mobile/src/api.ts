import { authClient, serverUrl } from "./auth";
export async function api<T>(
  path: string,
  input?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  if (!path.startsWith("/api/")) throw new Error("Use an OpenBot API path.");
  const cookie = await authClient.getCookie();
  const response = await fetch(`${serverUrl}${path}`, {
    method: input?.method,
    credentials: "omit",
    headers: {
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
  if (!response.ok)
    throw new Error(
      body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
        ? body.error
        : `Request failed (${response.status}).`,
    );
  return body as T;
}
export type Conversation = {
  id: string;
  name: string;
  agentIds: string[];
  active: boolean;
};
export type TranscriptMessage = {
  id: string;
  role: string;
  content?: string | unknown[];
  toolCalls?: unknown[];
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
/** A Bot as `GET /api/agents` returns it. */
export type Bot = {
  id: string;
  name: string;
  title?: string;
  roleDescription?: string;
  mine: boolean;
  canManage: boolean;
};
export type BotLifecycle = { paused: boolean; pausedAt: string | null };
export type RoutineStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "waiting";
export type Routine = {
  id: string;
  agentId: string;
  /** Display text from the server; never parsed here. */
  schedule: string;
  timezone: string;
  instruction: string;
  channel: { id: string; name: string | null; gone: boolean };
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
export type GrantedPlugins = {
  tools: { ref: string; description: string }[];
  skills: { slug: string; title: string; summary: string }[];
};
export type SkillSummary = { slug: string; title: string; summary: string };
/** Who drives a Bot's computer, as `GET /api/computers/:botId/control` answers. */
export type ControlState = {
  holder: "bot" | "human";
  requested: boolean;
  reason?: string;
  transitioning: boolean;
  request?: { id: string; status: string; reason: string };
  secretWanted?: string;
};
export type Screenshot = {
  base64: string;
  width: number;
  height: number;
  url?: string;
};
