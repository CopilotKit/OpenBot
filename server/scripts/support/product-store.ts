import type {
  ProductEvent,
  ProductIdentity,
  ProductRun,
  ProductStore,
} from "../../src/telemetry/product";

/** Shared store contract fixture: retain this instance across adapter restarts. */
export function productStoreFixture(
  identity: ProductIdentity = {
    deploymentId: "deployment-one",
    salt: "synthetic-salt",
  },
) {
  const runs = new Map<string, ProductRun>();
  const events = new Map<string, ProductEvent>();
  const attempted = new Set<string>();
  const delivering = new Set<string>();
  const store: ProductStore = {
    identity: async () => identity,
    accept: async (run) => {
      const old = runs.get(run.context.run_id);
      if (old)
        return old.actorUserId === run.actorUserId &&
          old.threadId === run.threadId
          ? old
          : null;
      runs.set(run.context.run_id, run);
      return run;
    },
    run: async (id) => runs.get(id) ?? null,
    finish: async (
      id,
      outcome,
      failureCategory,
      resultMessageIds,
      terminalAt,
    ) => {
      const old = runs.get(id);
      if (!old || old.terminalAt) return null;
      const run = {
        ...old,
        outcome,
        failureCategory,
        resultMessageIds,
        terminalAt,
      };
      runs.set(id, run);
      return run;
    },
    linkResults: async (id, resultMessageIds) => {
      const run = runs.get(id);
      if (run) runs.set(id, { ...run, resultMessageIds });
    },
    result: async (actor, thread, id) =>
      [...runs.values()].find(
        (r) =>
          r.actorUserId === actor &&
          r.threadId === thread &&
          r.resultMessageIds.includes(id),
      ) ?? null,
    event: async (event) => {
      if (events.has(event.id)) return false;
      events.set(event.id, event);
      return true;
    },
    pending: async (limit) =>
      [...events.values()].filter((e) => !attempted.has(e.id)).slice(0, limit),
    deliver: async (id, send) => {
      if (attempted.has(id) || delivering.has(id)) return false;
      delivering.add(id);
      try {
        await send();
        attempted.add(id);
        return true;
      } finally {
        delivering.delete(id);
      }
    },
    prune: async () => {},
  };
  return { store, runs, events, attempted };
}
