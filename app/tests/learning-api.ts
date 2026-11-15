/**
 * Learning and memory as the API answers them, for a test that fakes `fetch` by hand.
 *
 * The app reads and changes Learning and memory through the client generated from api/openapi.yaml,
 * at `/api/v2/organizations/default/...`. A test describes what it needs with the builders here and
 * answers each request with `served`, which checks the answer against the operation's own schema
 * (generated from the same spec the server checks its answers against), so a fake cannot drift from
 * what the server sends. A refusal is the API's problem details, with the sentence in `detail`.
 */

import type { ZodType } from "zod";
import * as learning from "../src/lib/api/generated/learning/learning.zod";
import * as memory from "../src/lib/api/generated/memory/memory.zod";

export { learning as learningContract, memory as memoryContract };

/**
 * The Response a real `fetch` returns. Read before any test registers happy-dom, as each test file
 * that needs it does at its top.
 */
const NativeResponse = globalThis.Response;

export const ORGANIZATION = "/api/v2/organizations/default";
const segment = (value: string) => encodeURIComponent(value);

/** The organization's Learning: its settings, spaces, proposals, runs and published skills. */
export const LEARNING = {
  settings: `${ORGANIZATION}/settings/learning`,
  createContainer: `${ORGANIZATION}/settings/learning/create-container`,
  overview: `${ORGANIZATION}/settings/learning/overview`,
  skills: `${ORGANIZATION}/settings/learning/skills`,
  skill: (name: string) =>
    `${ORGANIZATION}/settings/learning/skills/${segment(name)}`,
  proposals: `${ORGANIZATION}/settings/learning/proposals`,
  proposal: (id: string) =>
    `${ORGANIZATION}/settings/learning/proposals/${segment(id)}`,
  evidence: (insightId: string) =>
    `${ORGANIZATION}/settings/learning/insights/${segment(insightId)}/evidence`,
  runs: `${ORGANIZATION}/settings/learning/runs`,
  delivery: (botId: string) =>
    `${ORGANIZATION}/bots/${segment(botId)}/learning-status`,
  peopleProposals: `${ORGANIZATION}/personal-learning-proposals`,
  sharingRequests: `${ORGANIZATION}/skill-sharing-requests`,
  sharingDecision: (id: string, decision: "approve" | "decline") =>
    `${ORGANIZATION}/skill-sharing-requests/${segment(id)}/${decision}`,
};

/** One person's Learning: `me` for the person signed in, or a person's id where an admin reads it. */
export function personLearning(personId = "me") {
  const person = `${ORGANIZATION}/people/${segment(personId)}`;
  return {
    settings: `${person}/learning-settings`,
    review: `${person}/learning-review`,
    recordingSkills: `${person}/learning-proposals`,
    proposal: (id: string) => `${person}/learning-proposals/${segment(id)}`,
    evidence: (insightId: string) =>
      `${person}/learning-insights/${segment(insightId)}/evidence`,
    runs: `${person}/learning-runs`,
    recordingTitles: `${person}/recording-titles`,
    learnedSkill: (name: string) => `${person}/learned-skills/${segment(name)}`,
    share: (name: string) => `${person}/learned-skills/${segment(name)}/share`,
  };
}

/** The person's own memories and memory sources, and a Bot's read actions. */
export const MEMORY = {
  memories: `${ORGANIZATION}/people/me/memories`,
  memory: (id: string) => `${ORGANIZATION}/people/me/memories/${segment(id)}`,
  sources: `${ORGANIZATION}/people/me/memory-sources`,
  source: (id: string) =>
    `${ORGANIZATION}/people/me/memory-sources/${segment(id)}`,
  sync: (id: string) =>
    `${ORGANIZATION}/people/me/memory-sources/${segment(id)}/sync`,
  tools: (botId: string) =>
    `${ORGANIZATION}/bots/${segment(botId)}/memory-source-tools`,
};

/** What a test needs of one request: its method, path, query and JSON body. */
export type ApiRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  idempotencyKey: string | null;
};

/** The request `fetch` was called with, whatever it was made with. */
export function requestOf(input: unknown, init?: RequestInit): ApiRequest {
  const text =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : String(input);
  const url = new URL(text, "http://openbot.test");
  const headers = new Headers(init?.headers);
  return {
    method: (init?.method ?? "GET").toUpperCase(),
    path: url.pathname,
    query: url.searchParams,
    body:
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null,
    idempotencyKey: headers.get("Idempotency-Key"),
  };
}

/**
 * An answer the API's contract allows, or the test fails here. Said as well as thrown: the app turns
 * a failed read into an error on screen, which a test then reports far from the fake that caused it.
 */
export function served(schema: ZodType, body: unknown, status = 200): Response {
  const checked = schema.safeParse(body);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const message = `A test's answer is not one the API sends: ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}. Got ${JSON.stringify(body).slice(0, 400)}`;
    console.error(message);
    throw new Error(message);
  }
  return NativeResponse.json(checked.data as object, { status });
}

/** A write that answers nothing. */
export function noContent(): Response {
  return new NativeResponse(null, { status: 204 });
}

const CATEGORY: Record<number, string> = {
  400: "validation",
  401: "auth",
  403: "permission",
  404: "not_found",
  409: "conflict",
  422: "validation",
  429: "rate_limit",
  502: "dependency",
  503: "dependency",
};

/** A refusal as the API answers one: problem details, with the sentence a person reads in `detail`. */
export function problem(
  status: number,
  detail: string,
  code = "INTERNAL_ERROR",
): Response {
  return new NativeResponse(
    JSON.stringify({
      type: `https://open.bot/errors/${code.toLowerCase().replaceAll("_", "-")}`,
      title: detail,
      status,
      detail,
      code,
      category: CATEGORY[status] ?? "internal",
      retryable: status === 429 || status >= 500,
      requestId: "req_test",
      traceId: "trace_test",
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

/**
 * A UUID for a test's short name ("p1", "run-2"), the same every time: the API names proposals,
 * insights, runs and recordings by UUID, and a test reads better naming them by a word.
 */
export function testId(key: string): string {
  const hex = Array.from(new TextEncoder().encode(key), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (hex.length > 12) throw new Error(`"${key}" is too long for a test id.`);
  return `00000000-0000-4000-8000-${hex.padStart(12, "0")}`;
}

const CREATED_AT = "2026-11-01T00:00:00.000Z";
const RUN_ID = "0198a012-a20f-77c0-9e33-8992f18e7400";

type Body = Record<string, unknown>;

/** Learning's settings, with what a test left out as a fresh install has it. */
export const learningSettingsBody = (settings: Body = {}) => ({
  enabled: false,
  defaultTarget: null,
  bots: {},
  personalReview: "admins",
  ...settings,
});

/** The answer to reading or saving Learning's settings. */
export const learningConfigurationBody = ({
  settings = {},
  automatic = null,
}: {
  settings?: Body;
  automatic?: Body | null;
} = {}) => ({ settings: learningSettingsBody(settings), automatic });

/** A proposal as the API lists it, with what a test left out as one waiting for review. */
export const proposalBody = (proposal: Body) => ({
  runId: RUN_ID,
  operation: "add",
  status: "pending_review",
  description: `${String(proposal.title ?? "A skill")} description`,
  reason: "Seen in your recordings.",
  createdAt: CREATED_AT,
  reviewedAt: null,
  publishedSkillId: null,
  ...proposal,
});

/** One proposal with its files and insights, as reading it answers. */
export const proposalDetailBody = (proposal: Body) => ({
  files: [],
  insights: [],
  ...proposalBody(proposal),
});

/** A run as the API answers it, with what a test left out as a run that finished with nothing. */
export const runBody = (run: Body) => ({
  status: "succeeded",
  triggerSource: "manual",
  proposalCount: null,
  insightCount: null,
  failureCode: null,
  failure: null,
  createdAt: CREATED_AT,
  startedAt: null,
  completedAt: null,
  ...run,
});

/** One of a person's Learning spaces in their review. */
export const spaceBody = (space: Body) => ({
  containerId: "user-1",
  kind: "recordings",
  label: "From your recordings",
  proposals: [],
  latestRun: null,
  ...space,
});

/** A person's review of their own spaces. */
export const reviewBody = (review: Body = {}) => ({
  canReview: false,
  autoApprove: null,
  approved: 0,
  spaces: [],
  ...review,
});

/** A person's own Learning choices and skills. */
export const personLearningBody = (person: Body = {}) => ({
  mode: "closed",
  sharingAllowed: true,
  autoApprove: null,
  skills: [],
  ...person,
});

/** One skill in a person's own space. */
export const personalSkillBody = (skill: Body) => ({
  description: "",
  open: false,
  approvedBy: null,
  sharing: "none",
  ...skill,
});

/** A learned or published skill with its files. */
export const learnedSkillBody = (skill: Body) => ({
  description: "",
  files: [],
  ...skill,
});

/** A how-Learning-stands answer for a space with no dashboard to count from. */
export const overviewBody = (overview: Body = {}) => ({
  configuration: "configured",
  container: { id: "openbot", name: "OpenBot" },
  pendingThreadCount: null,
  pendingCandidateCount: 0,
  publishedSkillCount: null,
  insightCount: null,
  hasActiveRun: false,
  latestRunStatus: null,
  links: { learning: null, candidates: null, runs: null },
  ...overview,
});

/** A memory as the API answers it, with what a test left out as a fact the person wrote. */
export const memoryBody = (record: Body) => ({
  content: "I prefer mornings.",
  provenance: "You",
  sourceId: null,
  enabled: true,
  reviewState: "confirmed",
  formedBy: "person",
  formedByBotId: null,
  sourceApp: null,
  sourceLink: null,
  observedAt: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  ...record,
});

/** A memory source as the API answers it, with what a test left out as one that read cleanly. */
export const memorySourceBody = (source: Body) => ({
  toolRef: "googledrive/list_files",
  title: "Drive files",
  args: {},
  enabled: true,
  syncStatus: "succeeded",
  syncError: null,
  lastSyncAt: null,
  nextSyncAt: CREATED_AT,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  ...source,
});

/** One page holding a whole list, which is how the server answers a short one. */
export const page = (schema: ZodType, name: string, items: unknown[]) =>
  served(schema, { [name]: items, nextCursor: null });
