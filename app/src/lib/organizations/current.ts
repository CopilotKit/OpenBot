/**
 * The organization the person is working in, held in one place for the whole app.
 *
 * A person can belong to several organizations. Which one they are working in is the server's
 * answer: the active one in the list of their own (lib/organizations/queries.ts). Reading that list
 * is what sets it here, and switching (lib/organizations/mutations.ts) is what changes it. Every
 * request the API addresses by organization reads it from here, and the query client keeps each
 * organization's answers apart with it (query-client.ts).
 *
 * UNKNOWN UNTIL THE LIST HAS ANSWERED. There is no default: {@link organizationId} throws when asked
 * too early, so a request is never sent to a guessed organization. The signed-in gate reads the list
 * before any screen draws (lib/auth/queries.ts, `signedInUser`).
 *
 * A module and not a query's data, because a cache key has to be written before a request is made,
 * and because the query client itself reads it. It imports nothing, so anything may import it.
 */
import { useSyncExternalStore } from "react";

type Listener = (
  next: string | undefined,
  previous: string | undefined,
) => void;

let current: string | undefined;
const listeners = new Set<Listener>();

/** The organization the person is working in, or undefined until their organizations have been read. */
export function currentOrganizationId(): string | undefined {
  return current;
}

/**
 * The organization a request is addressed to. Throws before the person's organizations have been
 * read: nothing may be asked of an organization the server has not named.
 */
export function organizationId(): string {
  if (current === undefined) {
    throw new Error(
      "The organization is not known yet. Read the person's organizations first (signedInUser).",
    );
  }
  return current;
}

/** Work in `id` from now on. Tells every listener when it changed. Undefined is for a test to start from nothing. */
export function setCurrentOrganization(id: string | undefined): void {
  if (id === current) return;
  const previous = current;
  current = id;
  for (const listener of [...listeners]) listener(id, previous);
}

/** Hear each change of organization. Returns how to stop hearing. */
export function onOrganizationChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current organization for a component, which redraws when it changes. */
export function useCurrentOrganizationId(): string | undefined {
  return useSyncExternalStore(
    onOrganizationChange,
    currentOrganizationId,
    currentOrganizationId,
  );
}
