/**
 * The organization the person works in answered that it isn't there for them: they were removed from it, or it was
 * deleted, while the app was open. The request function says so here (src/api/request.ts) once it has forgotten that
 * organization, and Home reads the person's organizations again, so they work in another of theirs, or are told they
 * are in none, with no restart. It imports nothing, so it can be tested without a phone.
 */

type Listener = () => void;
const listeners = new Set<Listener>();

/** The organization the person worked in is gone for them. */
export function reportOrganizationGone(): void {
  for (const listener of [...listeners]) listener();
}

/** Hear each time it happens. Returns how to stop hearing. */
export function onOrganizationGone(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
