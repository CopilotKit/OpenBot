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

/**
 * The most of a message `POST /api/route` reads, and a message's opening cut to it.
 *
 * The route refuses anything longer with a 400, so the prompt it builds stays bounded. The composer
 * has no such limit, and both callers here carry on past a routing that failed: the home composer
 * sends the message to the default coworker instead, and a chosen coworker's conversation starts
 * without its `channel.routed` row. So a pasted email thread or log went to the wrong coworker, or
 * unrecorded, and nothing on screen said so. Who a message is for is plain from its opening, so the
 * opening is what is asked about; the whole message still goes to the coworker.
 *
 * Trimmed first, as the route trims, and cut one unit short when the cut would split a character, so
 * the router is not handed half of an emoji.
 */
const ROUTING_TEXT_LIMIT = 10_000;

function routingText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= ROUTING_TEXT_LIMIT) return trimmed;
  const opening = trimmed.slice(0, ROUTING_TEXT_LIMIT);
  const last = opening.charCodeAt(opening.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? opening.slice(0, -1) : opening;
}

export async function routeMessage(
  text: string,
  agentId?: string,
): Promise<RoutingDecision> {
  const asked = routingText(text);
  const response = await client("/api/route", {
    method: "POST",
    body: agentId ? { text: asked, agentId } : { text: asked },
    fallback: "Could not choose a coworker.",
  });
  return (await response.json()) as RoutingDecision;
}
