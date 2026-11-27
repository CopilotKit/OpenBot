/*
 * The spec's answers: every handler that Orval generated from api/openapi.yaml. Each tag's
 * `*.msw.ts` file exports one aggregator (`getBotsMock` and so on) that returns all its handlers.
 * The fake fetch uses them last, after the scene's own answers. Pattern: the aggregator `getBotsMock`
 * in app/src/lib/api/generated/bots/bots.msw.ts.
 */
import type { RequestHandler } from "msw";

const AGGREGATOR = /^get[A-Z]\w*Mock$/;

/**
 * The handlers of every aggregator in these modules. An aggregator is an exported function named
 * `get<Tag>Mock`. The `get<Operation>ResponseMock` functions (one answer body) and the
 * `get<Operation>MockHandler` functions (one handler) are not aggregators.
 */
export function pickAggregators(
  modules: Record<string, Record<string, unknown>>,
): RequestHandler[] {
  const handlers: RequestHandler[] = [];
  for (const path of Object.keys(modules).sort()) {
    const module = modules[path];
    for (const [name, value] of Object.entries(module)) {
      if (!AGGREGATOR.test(name)) continue;
      if (name.endsWith("ResponseMock") || name.endsWith("MockHandler")) {
        continue;
      }
      if (typeof value !== "function") continue;
      const made: unknown = value();
      if (Array.isArray(made)) handlers.push(...(made as RequestHandler[]));
    }
  }
  return handlers;
}

/** The generated handlers of all tags. Only Vite can run this (`import.meta.glob`). */
export function generatedHandlers(): RequestHandler[] {
  return pickAggregators(
    import.meta.glob<Record<string, unknown>>(
      "../../src/lib/api/generated/*/*.msw.ts",
      { eager: true },
    ),
  );
}
