import type { GrantedComponent } from "@/lib/components/queries";

/**
 * What a gallery card knows about whether its Bot may show it.
 *
 * THREE STATES, NOT TWO. Grants are fetched per Bot, and until the surface has declared its Bot and
 * the answer has come back nobody knows. Reading that as "not held" drew the refusal first and the
 * component a moment later, flashing "not available" at somebody who was allowed to see it. So
 * unknown is its own state, and a card in it draws as it would if held. Only an answer, or a load
 * that failed outright, decides otherwise.
 */
export type Grants =
  | { status: "unknown" }
  | { status: "known"; held: ReadonlyMap<string, string> }
  | { status: "failed" };

export type GrantSnapshot = {
  grants: Grants;
  /** Refusals the server decided at call time, keyed by the call they refused. */
  refusals: ReadonlyMap<string, string>;
};

/**
 * Grants from the polled query.
 *
 * Known whenever there is data, even if the latest poll failed: a blip in a five-second poll is not
 * a reason to take back what was already known. Failed only when nothing ever arrived.
 */
export function grantsFrom(query: {
  data?: readonly GrantedComponent[];
  isError: boolean;
  enabled: boolean;
}): Grants {
  if (query.data !== undefined) {
    return {
      status: "known",
      held: new Map(
        query.data.map((component) => [component.name, component.description]),
      ),
    };
  }
  if (query.enabled && query.isError) return { status: "failed" };
  return { status: "unknown" };
}

export const NOT_AVAILABLE = (title: string) =>
  `${title} is not available to this Bot at the moment. An administrator grants components per Bot, and can unpublish one for every Bot at once.`;

export const COULDNT_CHECK = (title: string) =>
  `Couldn't check whether this Bot may show ${title}. Try again in a moment.`;

export type CardState = "draw" | "wait-for-grant" | { refused: string };

/** What one card draws, given what is known about its grant and its own call. */
export function cardState(
  snapshot: GrantSnapshot,
  name: string,
  title: string,
  toolCallId?: string,
): CardState {
  const refusal = toolCallId ? snapshot.refusals.get(toolCallId) : undefined;
  if (refusal !== undefined) return { refused: refusal };
  const { grants } = snapshot;
  if (grants.status === "failed") return { refused: COULDNT_CHECK(title) };
  if (grants.status === "unknown") return "wait-for-grant";
  return grants.held.has(name) ? "draw" : { refused: NOT_AVAILABLE(title) };
}

function sameGrants(a: Grants, b: Grants): boolean {
  if (a.status !== b.status) return false;
  if (a.status !== "known" || b.status !== "known") return true;
  if (a.held.size !== b.held.size) return false;
  for (const [name, description] of a.held) {
    if (b.held.get(name) !== description) return false;
  }
  return true;
}

/**
 * The grants and refusals every gallery card reads, outside React state on purpose.
 *
 * The SDK remounts a card whenever the render function it was registered with changes identity, so
 * that function is created once and cannot close over grants that change. It subscribes here with
 * `useSyncExternalStore` instead, and a change re-renders the card rather than rebuilding it.
 */
export function createGrantStore() {
  let snapshot: GrantSnapshot = {
    grants: { status: "unknown" },
    refusals: new Map(),
  };
  const listeners = new Set<() => void>();

  return {
    get: (): GrantSnapshot => snapshot,
    set(next: Partial<GrantSnapshot>) {
      const grants =
        next.grants && !sameGrants(next.grants, snapshot.grants)
          ? next.grants
          : snapshot.grants;
      const refusals = next.refusals ?? snapshot.refusals;
      if (grants === snapshot.grants && refusals === snapshot.refusals) return;
      snapshot = { grants, refusals };
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type GrantStore = ReturnType<typeof createGrantStore>;
