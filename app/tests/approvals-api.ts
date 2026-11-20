/**
 * The approvals API as the server answers it, for a test that fakes `fetch` by hand.
 *
 * The app reads what waits on a person (approvals and questions), what they set for themselves
 * (preferences, their own rules, what they allowed for one conversation) and what the organization
 * set for everybody (its approval settings and rules) through the client generated from
 * api/openapi.yaml, at `/api/v2/organizations/default/...`, and draws them as one inbox. A test
 * written against that one inbox passes it here and gets each of the API's answers.
 */

import type { ZodType } from "zod";
import * as ruleContract from "../src/lib/api/generated/approval-rules/approval-rules.zod";
import * as contract from "../src/lib/api/generated/approvals/approvals.zod";

/**
 * The Response a real `fetch` returns. Read before any test registers happy-dom, as each test file
 * that needs it does at its top.
 */
const NativeResponse = globalThis.Response;

const ORGANIZATION = "/api/v2/organizations/default";
const ME = `${ORGANIZATION}/people/me`;
export const APPROVALS_PATH = `${ME}/approvals`;
export const QUESTIONS_PATH = `${ME}/questions`;
export const APPROVAL_PREFERENCES_PATH = `${ME}/approval-preferences`;
export const PERSON_APPROVAL_RULES_PATH = `${ME}/approval-rules`;
export const CONVERSATION_GRANTS_PATH = `${ME}/conversation-grants`;
export const COMPUTER_STEPS_PATH = `${ME}/computer-steps`;
export const APPROVAL_SETTINGS_PATH = `${ORGANIZATION}/approval-settings`;
export const APPROVAL_RULES_PATH = `${ORGANIZATION}/approval-rules`;

const segment = (id: string) => encodeURIComponent(id);
/** Where one approval is decided. */
export const approvalDecisionPath = (id: string) =>
  `${APPROVALS_PATH}/${segment(id)}/decide`;
/** Where one question is answered, and where it is put down unanswered. */
export const questionResponsePath = (id: string) =>
  `${QUESTIONS_PATH}/${segment(id)}/respond`;
export const questionDismissalPath = (id: string) =>
  `${QUESTIONS_PATH}/${segment(id)}/dismiss`;
/** One rule of the person's own, and one of the organization's. */
export const personApprovalRulePath = (id: string) =>
  `${PERSON_APPROVAL_RULES_PATH}/${segment(id)}`;
export const approvalRulePath = (id: string) =>
  `${APPROVAL_RULES_PATH}/${segment(id)}`;
/** One "Allow for this conversation". */
export const conversationGrantPath = (id: string) =>
  `${CONVERSATION_GRANTS_PATH}/${segment(id)}`;
/** How one conversation asks, by its thread. */
export const approvalModePath = (threadId: string) =>
  `${ME}/approval-modes/${segment(threadId)}`;

/** The inbox a test describes: the screens' one object, any part of which it may leave out. */
export type TestInbox = {
  enabled?: boolean;
  requests?: readonly unknown[];
  rules?: readonly unknown[];
  teamRules?: readonly unknown[];
  conversationGrants?: readonly unknown[];
  preferences?: {
    enabled?: boolean;
    autoReview?: boolean;
    hostCommands?: string;
  };
  team?: object;
  hostCommands?: string;
  questions?: readonly unknown[];
};

const CREATED_AT = "2026-11-14T09:00:00.000Z";

/** An approval as the API answers it, with what a test left out as it is while one waits. */
export function approvalBody(request: unknown) {
  return {
    status: "pending",
    decision: null,
    result: null,
    createdAt: CREATED_AT,
    decidedAt: null,
    consumedAt: null,
    completedAt: null,
    ...(request as object),
  };
}

/** The person's approval preferences, from the inbox's switch, preferences and effective policy. */
export function approvalPreferencesBody(inbox: TestInbox) {
  const hostCommands = inbox.preferences?.hostCommands ?? "ask";
  return {
    enabled: inbox.preferences?.enabled ?? inbox.enabled ?? false,
    autoReview: inbox.preferences?.autoReview ?? false,
    hostCommands,
    effectiveHostCommands: inbox.hostCommands ?? hostCommands,
  };
}

/** The organization's approval settings, with the defaults for what a test left out. */
export function approvalSettingsBody(inbox: TestInbox) {
  return {
    enforceAutoReview: false,
    customRulesEnabled: true,
    hostCommandsCap: "allow",
    actionKinds: {},
    ...inbox.team,
  };
}

/** The path of a request, whatever it was made with: no origin and no query. */
function pathOf(input: unknown): string {
  const text =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : String(input);
  return new URL(text, "http://openbot.test").pathname;
}

/**
 * An answer the API's contract allows, or the test fails here. The server checks every answer it
 * sends against the same schema, generated from api/openapi.yaml, so a fake holding a status the
 * API never sends, or missing a field it always sends, is a fake of nothing.
 */
function served(schema: ZodType, body: unknown, status = 200): Response {
  const checked = schema.safeParse(body);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    // Said as well as thrown: the app turns a failed read into an empty screen, which a test then
    // reports as a missing row, far from the fake that caused it.
    const message = `A test's approvals answer is not one the API sends: ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}. Got ${JSON.stringify(body).slice(0, 400)}`;
    console.error(message);
    throw new Error(message);
  }
  return NativeResponse.json(checked.data as object, { status });
}

/** One page holding the whole list, which is how the server answers a short one. */
const page = (schema: ZodType, name: string, items: readonly unknown[]) =>
  served(schema, { [name]: items, nextCursor: null });

/**
 * The API's answer to one of the seven reads the inbox is made of, from the inbox a test describes,
 * or undefined when the request is not one of them.
 */
export function approvalInboxResponse(
  input: unknown,
  inbox: TestInbox = {},
): Response | undefined {
  const path = pathOf(input);
  if (path === APPROVALS_PATH)
    return page(
      contract.ListApprovalsResponse,
      "approvals",
      (inbox.requests ?? []).map(approvalBody),
    );
  if (path === QUESTIONS_PATH)
    return page(
      contract.ListQuestionsResponse,
      "questions",
      (inbox.questions ?? []).map((question) => ({
        // The Bot whose conversation it belongs to is the Bot that asked, unless a test says so.
        conversationBotId: (question as { botId?: string }).botId,
        createdAt: CREATED_AT,
        ...(question as object),
      })),
    );
  if (path === APPROVAL_PREFERENCES_PATH)
    return served(
      contract.GetApprovalPreferencesResponse,
      approvalPreferencesBody(inbox),
    );
  if (path === PERSON_APPROVAL_RULES_PATH)
    return page(
      contract.ListPersonApprovalRulesResponse,
      "approvalRules",
      (inbox.rules ?? []).map((rule) => ({
        account: null,
        kind: null,
        createdAt: CREATED_AT,
        ...(rule as object),
      })),
    );
  if (path === CONVERSATION_GRANTS_PATH)
    return page(
      contract.ListConversationGrantsResponse,
      "conversationGrants",
      inbox.conversationGrants ?? [],
    );
  if (path === APPROVAL_SETTINGS_PATH)
    return served(
      ruleContract.GetApprovalSettingsResponse,
      approvalSettingsBody(inbox),
    );
  if (path === APPROVAL_RULES_PATH)
    return page(
      ruleContract.ListApprovalRulesResponse,
      "approvalRules",
      (inbox.teamRules ?? []).map((rule) => ({
        createdBy: null,
        createdAt: CREATED_AT,
        ...(rule as object),
      })),
    );
  return undefined;
}

/** How a conversation asks, as the API answers it. */
export function approvalModeResponse(asksEveryStep: boolean): Response {
  return served(contract.GetApprovalModeResponse, { asksEveryStep });
}

/** A write that answers nothing: a question dismissed, a rule or a conversation approval removed. */
export function noContentResponse(): Response {
  return new NativeResponse(null, { status: 204 });
}

/**
 * The API's answer to one of the approval writes, in the shape the server gives it, or undefined
 * when the request is not one of them: a decided approval, an answered question, the saved
 * preferences, settings or rule, and nothing at all for a dismissal or a removal.
 */
export function approvalWriteResponse(
  input: unknown,
  init: { method?: string; body?: unknown } | undefined,
  inbox: TestInbox = {},
): Response | undefined {
  const path = pathOf(input);
  const method = (
    input instanceof Request ? input.method : (init?.method ?? "GET")
  ).toUpperCase();
  if (method === "GET") return undefined;
  const body = (
    typeof init?.body === "string" ? JSON.parse(init.body) : {}
  ) as Record<string, unknown>;
  const decided = /\/approvals\/([^/]+)\/decide$/.exec(path);
  if (path.startsWith(`${APPROVALS_PATH}/`) && decided) {
    const id = decodeURIComponent(decided[1] ?? "");
    const request =
      (inbox.requests ?? []).find(
        (one) => (one as { id?: string }).id === id,
      ) ?? {};
    return served(contract.DecideApprovalResponse, {
      action: {
        botId: "bot",
        toolRef: "tool",
        effect: "write",
        scope: "*",
        threadId: "thread",
      },
      ...approvalBody(request),
      id,
      status: body.decision === "deny" ? "denied" : "approved",
      decision: body.decision,
      decidedAt: CREATED_AT,
    });
  }
  const question = /\/questions\/([^/]+)\/(respond|dismiss)$/.exec(path);
  if (path.startsWith(`${QUESTIONS_PATH}/`) && question)
    return question[2] === "dismiss"
      ? noContentResponse()
      : served(contract.RespondToQuestionResponse, {
          id: decodeURIComponent(question[1] ?? ""),
          continueHere: false,
        });
  if (path === APPROVAL_PREFERENCES_PATH)
    return served(contract.UpdateApprovalPreferencesResponse, {
      ...approvalPreferencesBody(inbox),
      ...body,
    });
  if (path === APPROVAL_SETTINGS_PATH)
    return served(ruleContract.UpdateApprovalSettingsResponse, {
      ...approvalSettingsBody(inbox),
      ...body,
    });
  const person = path.startsWith(PERSON_APPROVAL_RULES_PATH);
  if (person || path.startsWith(APPROVAL_RULES_PATH)) {
    if (method === "DELETE") return noContentResponse();
    const id = path.split("/").at(-1) ?? "";
    const rule = {
      id: method === "POST" ? "rule-new" : decodeURIComponent(id),
      botId: "*",
      toolRef: "*",
      effect: "*",
      scope: "*",
      behaviour: "ask",
      ...(person ? { account: null, kind: null } : { createdBy: null }),
      createdAt: CREATED_AT,
      ...body,
    };
    const created = method === "POST";
    return served(
      person
        ? created
          ? contract.CreatePersonApprovalRuleResponse
          : contract.UpdatePersonApprovalRuleResponse
        : created
          ? ruleContract.CreateApprovalRuleResponse
          : ruleContract.UpdateApprovalRuleResponse,
      rule,
      created ? 201 : 200,
    );
  }
  if (path.startsWith(`${CONVERSATION_GRANTS_PATH}/`) && method === "DELETE")
    return noContentResponse();
  return undefined;
}

/** A refusal as the API answers one: problem details, with the sentence a person reads in `detail`. */
export function problemResponse(status: number, detail: string): Response {
  return new NativeResponse(
    JSON.stringify({
      type: "https://open.bot/errors/validation-error",
      title: "Request validation failed.",
      status,
      detail,
      code: "VALIDATION_ERROR",
      category: "validation",
      retryable: false,
      requestId: "req_test",
      traceId: "trace_test",
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

/**
 * The API's answer to a computer step, from what a test's gate decided, written as the step's three
 * outcomes used to be told apart: a result (done), a 202 (waiting for the person's approval), a 409
 * saying a person has the computer (held). All three are answers now, sent with 200 and an
 * `outcome`; anything else the gate refused is a problem carrying its sentence.
 */
export async function computerStepResponse(
  decided: Response,
): Promise<Response> {
  const body = ((await decided.json().catch(() => null)) ?? {}) as Record<
    string,
    unknown
  >;
  if (decided.status === 202)
    return served(contract.RunComputerStepResponse, {
      outcome: "waiting",
      ...(typeof body.approvalId === "string"
        ? { approvalId: body.approvalId }
        : {}),
      reason:
        typeof body.reason === "string"
          ? body.reason
          : "This action is waiting for your approval.",
    });
  if (decided.status === 409 && body.humanHasControl === true)
    return served(contract.RunComputerStepResponse, {
      outcome: "held",
      ...body,
    });
  if (!decided.ok)
    return problemResponse(
      decided.status,
      typeof body.error === "string" ? body.error : "That did not work.",
    );
  return served(contract.RunComputerStepResponse, {
    outcome: "done",
    ...("result" in body ? { result: body.result } : {}),
  });
}
