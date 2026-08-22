import { client } from "@/lib/client";

/**
 * Which coworker a message should go to.
 *
 * The server reads the roster for the person asking and picks by what each coworker is for, so this
 * can only ever return a coworker they are already allowed to reach. `fallback` is true when it is
 * the default rather than an inferred match, which the caller can say out loud. A thrown error here
 * is not fatal: the caller falls back to the default coworker, which is exactly what the server
 * does too.
 *
 * Pass `agentId` when the draft named somebody with `@`. Nothing is inferred in that case and no
 * model is called; the call exists so the choice reaches the audit trail, which otherwise had a row
 * for every routed conversation and none at all for chosen ones.
 */
export type RoutingDecision = {
  agentId: string;
  name: string;
  reason: string;
  fallback: boolean;
  viaMention: boolean;
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
