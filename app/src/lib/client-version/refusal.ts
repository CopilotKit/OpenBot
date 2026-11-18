/**
 * Whether the OpenBot this page talks to refused it for being too old an app.
 *
 * Every request names this app in the `OpenBot-Client` header (`lib/client.ts`). An OpenBot whose
 * oldest served release of that app is newer than it refuses every request except its `deployment`
 * with a 400 problem whose code is CLIENT_UPDATE_REQUIRED, naming the app (`client`) and the oldest
 * release it serves (`minimumVersion`). Inside OpenBot Desktop's window the desktop app adds its own
 * name to the page's header, so there the app named can be OpenBot Desktop rather than this page.
 *
 * `lib/client.ts` hands every 400 here before the caller sees it. The first refusal is kept until the
 * page is loaded again, and the update screen reads it (`components/layout/client-version-gate.tsx`),
 * so a tab left open across an upgrade shows "Update OpenBot" in place of a screen whose read failed.
 *
 * No imports from the app, so the transport can report to it without a cycle.
 */
import {
  CLIENT_KINDS,
  CLIENT_UPDATE_REQUIRED,
  type ClientKind,
  isVersion,
} from "@openbot/shared/client-version";

/** The app the OpenBot refused, and the oldest release of it that OpenBot serves. */
export type ClientRefusal = { client: ClientKind; minimumVersion?: string };

let refused: ClientRefusal | null = null;
const listeners = new Set<() => void>();

/** The refusal a problem body is, or null when it is some other answer. */
export function clientRefusalOf(body: unknown): ClientRefusal | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const problem = body as {
    code?: unknown;
    client?: unknown;
    minimumVersion?: unknown;
  };
  if (problem.code !== CLIENT_UPDATE_REQUIRED) return null;
  // A refusal that names no app we know is still this page's to act on: it is the page that asked.
  const client = (CLIENT_KINDS as readonly unknown[]).includes(problem.client)
    ? (problem.client as ClientKind)
    : "web";
  return isVersion(problem.minimumVersion)
    ? { client, minimumVersion: problem.minimumVersion }
    : { client };
}

/**
 * A request was answered 400. Its body is read from a copy, so the caller still reads its own; the
 * promise settles once it has been, so the caller can fail knowing whether this was the reason.
 */
export function noteRefusal(response: Response): Promise<void> {
  if (response.status !== 400 || refused !== null) return Promise.resolve();
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) return Promise.resolve();
  return response
    .clone()
    .json()
    .then(
      (body: unknown) => {
        const refusal = clientRefusalOf(body);
        if (refusal === null || refused !== null) return;
        refused = refusal;
        for (const listener of listeners) listener();
      },
      () => undefined,
    );
}

/** For `useSyncExternalStore`. */
export function subscribeClientRefusal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The refusal this page met, or null while it has met none. */
export function clientRefusal(): ClientRefusal | null {
  return refused;
}

/** Forget the refusal, as loading the page again does. For tests, which share one module. */
export function forgetClientRefusal(): void {
  if (refused === null) return;
  refused = null;
  for (const listener of listeners) listener();
}
