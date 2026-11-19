/**
 * The phone's way to OpenBot: the client generated from api/openapi.yaml (./generated), which every screen calls the
 * API through, the mutator each of its calls goes through (./request), and what the screens share on top of them.
 */
import {
  getApprovalSettings,
  listApprovalRules,
} from "./generated/approval-rules/approval-rules";
import {
  getApprovalPreferences,
  listApprovals,
  listPersonApprovalRules,
  listQuestions,
} from "./generated/approvals/approvals";
import { listBots } from "./generated/bots/bots";
import type {
  Approval,
  ApprovalRuleBehaviour,
  Bot,
  PersonApprovalRule,
  Question,
} from "./generated/model";
import { ME, ORGANIZATION_ID } from "./request";

export type {
  Bot,
  BotLifecycle,
  CheckInItem,
  ComputerControl,
  ComputerScreenshot,
  ConversationMessage,
  ConversationSummary,
  Memory,
  Routine,
  RoutineRun,
  Task,
  TaskStatus,
} from "./generated/model";
export {
  ApiError,
  chooseOrganization,
  DEPLOYMENT_ORGANIZATION_ID,
  deploymentOrganization,
  ME,
  ORGANIZATION_ID,
  organizationAddress,
  organizationChoices,
} from "./request";

/** One page of a list the API pages (`limit`, `cursor`, `nextCursor`). */
type Paged = { nextCursor?: string | null };

/**
 * Every item of one of the API's lists, page by page: `read` asks for one page, `items` takes its items. The screens
 * here show the whole list. A cursor handed back twice ends it too.
 */
export async function everyPage<P extends Paged, T>(
  read: (page: { limit: number; cursor?: string }) => Promise<P>,
  items: (page: P) => readonly T[] | undefined,
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await read({ limit: 100, ...(cursor ? { cursor } : {}) });
    all.push(...(items(page) ?? []));
    if (cursor) seen.add(cursor);
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
  } while (cursor && !seen.has(cursor));
  return all;
}

/** What waits on the person: the actions their Bots asked about, and the questions they asked. */
export async function loadApprovalInbox(): Promise<ApprovalInbox> {
  const [requests, questions] = await Promise.all([
    everyPage(
      (page) => listApprovals(ORGANIZATION_ID, ME, page),
      (page) => page.approvals,
    ),
    everyPage(
      (page) => listQuestions(ORGANIZATION_ID, ME, page),
      (page) => page.questions,
    ),
  ]);
  return { requests, questions };
}
/** The person's own approval preferences and rules, with what the organization set for everybody. */
export async function loadApprovalSettings(): Promise<ApprovalSettings> {
  const [preferences, rules, team, teamRules] = await Promise.all([
    getApprovalPreferences(ORGANIZATION_ID, ME),
    everyPage(
      (page) => listPersonApprovalRules(ORGANIZATION_ID, ME, page),
      (page) => page.approvalRules,
    ),
    getApprovalSettings(ORGANIZATION_ID),
    everyPage(
      (page) => listApprovalRules(ORGANIZATION_ID, page),
      (page) => page.approvalRules,
    ),
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
export type ApprovalInbox = { requests: Approval[]; questions: Question[] };

/** Every Bot this person can reach, read page by page to the end. */
export function everyBot(): Promise<Bot[]> {
  return everyPage(
    (page) => listBots(ORGANIZATION_ID, page),
    (page) => page.bots,
  );
}
export type RuleBehaviour = ApprovalRuleBehaviour;
/** A rule as Custom rules shows it, the person's own and the organization's alike. */
export type ApprovalRule = Pick<
  PersonApprovalRule,
  "id" | "botId" | "toolRef" | "effect" | "scope" | "behaviour"
>;
export const BEHAVIOUR_LABELS: Record<RuleBehaviour, string> = {
  allow: "Take action without asking",
  pre_approved: "Take action if pre-approved",
  ask: "Ask before taking action",
  hand_off: "Hand off to you",
};
export type ApprovalSettings = {
  enabled: boolean;
  rules: ApprovalRule[];
  teamRules: ApprovalRule[];
  preferences?: { enabled: boolean; autoReview: boolean };
  team?: { enforceAutoReview: boolean; customRulesEnabled: boolean };
};
