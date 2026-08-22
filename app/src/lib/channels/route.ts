import { client } from "@/lib/client";

/**
 * Which coworker a first message should go to.
 *
 * With no `@`, the server reads the roster for the person asking and picks by what each coworker is
 * for. With an `@`, pass its `agentId`: the server honours that choice as-is and records it, so the
 * audit trail is not silent about mentioned conversations. Either way this can only ever return a
 * coworker the person is already allowed to reach. `fallback` is true when the result is the default
 * rather than an inferred match, which the caller can say out loud. A thrown error here is not fatal:
 * the caller falls back to the mentioned coworker, or to the default — exactly what the server does.
 */
export type RoutingDecision = {
  agentId: string;
  name: string;
  reason: string;
  fallback: boolean;
};

export async function routeMessage(
  text: string,
  agentId?: string,
): Promise<RoutingDecision> {
  const response = await client("/api/route", {
    method: "POST",
    body: agentId ? { text, agentId } : { text },
    fallback: "Could not choose a coworker.",
  });
  return (await response.json()) as RoutingDecision;
}
