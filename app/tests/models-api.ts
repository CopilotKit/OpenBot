/**
 * The model connections API as the server answers it, for a test that fakes `fetch` by hand.
 *
 * The app reads and changes the vault, the models Bots can run on and a person's model choice for a
 * conversation through the client generated from api/openapi.yaml, at
 * `/api/v2/organizations/default/...`. A test fakes those addresses with what is here: a list comes
 * back one page at a time as `{ credentials, nextCursor }`, `null` ending it.
 */

/**
 * The Response a real `fetch` returns. Read before any test registers happy-dom, as each test file
 * that needs it does at its top.
 */
const NativeResponse = globalThis.Response;

const ORGANIZATION = "/api/v2/organizations/default";
export const CREDENTIALS_PATH = `${ORGANIZATION}/credentials`;
/** Where the Bots read their model key, and whether one is kept there. */
export const MODEL_KEY_PATH = `${ORGANIZATION}/model-key`;
export const MODEL_CATALOGUE_PATH = `${ORGANIZATION}/model-catalogue`;

/** Revoking one credential, an action on its own address. */
export function revokeCredentialPath(credentialId: string): string {
  return `${CREDENTIALS_PATH}/${encodeURIComponent(credentialId)}/revoke`;
}

/** The signed-in person's choice for one conversation. */
export function modelChoicePath(conversationId: string): string {
  return `${ORGANIZATION}/people/me/model-choices/${encodeURIComponent(conversationId)}`;
}

/** The conversation a choice's address names, or undefined for any other address. */
export function modelChoiceConversation(pathname: string): string | undefined {
  const match =
    /^\/api\/v2\/organizations\/default\/people\/me\/model-choices\/([^/]+)$/.exec(
      pathname,
    );
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/** Which view of the catalogue a request asked for: what people may pick, or everything listed. */
export function catalogueView(url: URL): "offered" | "all" | undefined {
  if (url.pathname !== MODEL_CATALOGUE_PATH) return undefined;
  return url.searchParams.get("view") === "all" ? "all" : "offered";
}

/** A credential as the API shows it, from what a test gives. Never a secret. */
export function credentialBody(credential: {
  id: string;
  kind: string;
  provider: string;
  keyId: string;
  metadata?: Record<string, unknown>;
  revokedAt?: string | null;
  createdAt?: string;
}) {
  return {
    metadata: {},
    revokedAt: null,
    createdAt: "2026-11-14T09:00:00.000Z",
    ...credential,
  };
}

/** One page of the vault, as the API's body. Null ends the list. */
export function credentialPage(
  credentials: readonly unknown[],
  nextCursor: string | null = null,
) {
  return { credentials, nextCursor };
}

/** Where the Bots read their model key, as the API answers it. */
export function modelKeyBody(
  modelKey: { provider: string; keyId: string },
  set = false,
) {
  return { ...modelKey, set };
}

/** A catalogue as the API answers it: either of today's two lists, with what the other one said. */
export function catalogueBody(
  catalogue: Record<string, unknown>,
  extra: { choosable?: boolean; listed?: boolean } = {},
) {
  return {
    choosable: catalogue.choosable ?? extra.choosable ?? true,
    listed: catalogue.listed ?? extra.listed ?? true,
    ...catalogue,
  };
}

/** A refusal as the API answers it: a problem, carrying the sentence a person reads. */
export function problemResponse(
  status: number,
  code: string,
  detail: string,
): Response {
  return new NativeResponse(
    JSON.stringify({
      type: `https://open.bot/errors/${code.toLowerCase().replaceAll("_", "-")}`,
      title: detail,
      status,
      detail,
      code,
      category: status === 404 ? "not_found" : "validation",
      retryable: false,
      requestId: "req_test",
      traceId: "trace_test",
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );
}
