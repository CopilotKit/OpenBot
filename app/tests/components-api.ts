/**
 * The components API as the server answers it, for a test that fakes `fetch` by hand.
 *
 * The app reads and writes components through the client generated from api/openapi.yaml, at
 * `/api/v2/organizations/default/components` and a Bot's `bots/{botId}/components`: a list comes
 * back as `{ components, nextCursor }` with `nextCursor` null on the last page, a check as
 * `{ allowed, reason }`, and a read of a component's data as `{ allowed, data, reason }`.
 */

/**
 * The Response a real `fetch` returns. Read before any test registers happy-dom, as each test file
 * that needs it does at its top.
 */
const NativeResponse = globalThis.Response;

const ORGANIZATION = "/api/v2/organizations/default";
/** Every component, which an admin governs and a conversation draws from. */
export const COMPONENTS_PATH = `${ORGANIZATION}/components`;
/** Where the app announces what it can draw, on every load. */
export const ANNOUNCE_COMPONENTS_PATH = `${COMPONENTS_PATH}/announce`;

/** One component's address. */
export function componentPath(name: string): string {
  return `${COMPONENTS_PATH}/${encodeURIComponent(name)}`;
}

/** What one Bot may draw. */
export function botComponentsPath(bot: string): string {
  return `${ORGANIZATION}/bots/${encodeURIComponent(bot)}/components`;
}

/** Where the app asks whether a Bot may draw one component now. */
export function checkComponentPath(bot: string, name: string): string {
  return `${botComponentsPath(bot)}/${encodeURIComponent(name)}/check`;
}

/** Where a component reads its data for a Bot. */
export function callComponentPath(bot: string, name: string): string {
  return `${botComponentsPath(bot)}/${encodeURIComponent(name)}/call`;
}

/** Any Bot's check of any component. */
export const CHECK_COMPONENT =
  /^\/api\/v2\/organizations\/default\/bots\/[^/]+\/components\/[^/]+\/check$/;

/** What one Bot may draw, as the API answers it: every one on one page. */
export function botComponentsResponse(
  components: readonly { name: string; description: string }[] = [],
): Response {
  return NativeResponse.json({ components, nextCursor: null });
}

/** A component as today's list described it, which a test may give in part. */
export type TodayComponent = {
  name: string;
  title?: string;
  kind?: string;
  draftDescription?: string;
  publishedDescription?: string | null;
  published?: boolean;
  publishedAt?: string | null;
  updatedBy?: string | null;
  updatedAt?: string;
  hasUnpublishedChanges?: boolean;
  withheldFrom?: string[];
  functions?: string[];
  /** A Playground component's source, as it is drafted and as it is published. */
  draftSource?: {
    html: string;
    css: string;
    jsFunctions: string;
    argumentSchema: Record<string, unknown>;
    sampleArguments: Record<string, unknown>;
  } | null;
  source?: {
    html: string;
    css: string;
    jsFunctions: string;
    argumentSchema: Record<string, unknown>;
    revision: number;
  } | null;
};

/** The API's component, as an admin sees it, from what today's list said about it. */
export function componentBody(today: TodayComponent) {
  const published = today.published ?? true;
  const description =
    today.publishedDescription === undefined
      ? (today.draftDescription ?? "Draws something.")
      : today.publishedDescription;
  return {
    name: today.name,
    title: today.title ?? today.name,
    kind: today.kind ?? "card",
    published,
    publishedAt: today.publishedAt ?? "2026-11-02T10:15:00.000Z",
    description,
    source: today.source ?? null,
    draft: {
      title: today.title ?? today.name,
      description: today.draftDescription ?? description ?? "",
      source: today.draftSource ?? null,
    },
    hasUnpublishedChanges: today.hasUnpublishedChanges ?? false,
    withheldFrom: today.withheldFrom ?? [],
    functions: today.functions ?? [],
    updatedBy: today.updatedBy ?? null,
    updatedAt: today.updatedAt ?? "2026-11-02T10:15:00.000Z",
  };
}

/** The components list, as the API answers it: every one on one page. */
export function componentsResponse(
  components: readonly TodayComponent[] = [],
): Response {
  return NativeResponse.json({
    components: components.map(componentBody),
    nextCursor: null,
  });
}

/** What announcing the gallery added. */
export function announcedResponse(added: readonly string[] = []): Response {
  return NativeResponse.json({ added });
}

/** A check's answer: allowed, or why not. */
export function checkResponse(
  decision: { allowed: true } | { allowed: false; reason: string },
): Response {
  return NativeResponse.json({
    allowed: decision.allowed,
    reason: decision.allowed ? null : decision.reason,
  });
}

/** A read's answer: the data, or why it didn't run. */
export function callResponse(
  result: { allowed: true; data: unknown } | { allowed: false; reason: string },
): Response {
  return NativeResponse.json(
    result.allowed
      ? { allowed: true, data: result.data, reason: null }
      : { allowed: false, data: null, reason: result.reason },
  );
}
