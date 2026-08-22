import { client } from "@/lib/client";

/**
 * Which coworker an untagged message should go to.
 *
 * Called only when the composer draft names no one with `@`. The server reads the roster for the
 * person asking and picks by what each coworker is for, so this can only ever return a coworker they
 * are already allowed to reach. `fallback` is true when it is the default rather than an inferred
 * match, which the caller can say out loud. A thrown error here is not fatal: the caller falls back
 * to the default coworker, which is exactly what the server does too.
 */
export type RoutingDecision = {
  agentId: string;
  name: string;
  reason: string;
  fallback: boolean;
};

export async function routeMessage(text: string): Promise<RoutingDecision> {
  const response = await client("/api/route", {
    method: "POST",
    body: { text },
    fallback: "Could not choose a coworker.",
  });
  return (await response.json()) as RoutingDecision;
}
