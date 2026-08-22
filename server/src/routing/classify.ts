/**
 * Choosing which coworker an untagged message is for.
 *
 * A channel is pinned to one coworker for the life of its thread, and the pin is set before the
 * first turn runs, so this decision happens at channel creation, not during a run. When the person
 * named a coworker with `@`, there is nothing to decide and this is never called. When they did not,
 * this reads the message against what each coworker is for and picks one.
 *
 * The model call is injected rather than made here, so the part that matters — what happens when the
 * answer is missing, malformed, or names a coworker that is not on the roster — is a plain function
 * with no network in the way. Every one of those failure paths lands on the deployment's default
 * coworker and says so; nothing here ever throws, because a router that throws would turn "we were
 * not sure who to ask" into "your message went nowhere".
 */

export type RoutingCandidate = {
  id: string;
  name: string;
  /** What this coworker is for. The one line an operator wrote to say when to reach them. */
  roleDescription: string;
};

export type RoutingDecision = {
  agentId: string;
  name: string;
  /** A sentence a person reads, naming why it went where it went. */
  reason: string;
  /** True when this is the default rather than an inferred match: an honest "we were not sure". */
  fallback: boolean;
};

/** Below this the match is a guess, and a guess should defer to the default rather than surprise. */
const MIN_CONFIDENCE = 0.6;

export function routingPrompt(
  text: string,
  candidates: readonly RoutingCandidate[],
): string {
  const roster = candidates
    .map((c) => `- id: ${c.id}\n  name: ${c.name}\n  for: ${c.roleDescription}`)
    .join("\n");
  return [
    "You route a person's message to the one coworker best suited to it.",
    "Here are the coworkers and what each is for:",
    roster,
    "",
    'Reply with only JSON: {"agentId": "<one id from the list>", "reason": "<short, names the fit>", "confidence": <0..1>}.',
    "Pick the specialist whose purpose matches the message. If none clearly fits, use the most general coworker and give it a low confidence.",
    "",
    `Message: ${text}`,
  ].join("\n");
}

export function createIntentRouter(deps: {
  /** Runs the prompt and returns the model's raw text. May reject; the router absorbs it. */
  complete: (prompt: string) => Promise<string>;
}) {
  return {
    async route(
      text: string,
      candidates: readonly RoutingCandidate[],
      defaultId: string,
    ): Promise<RoutingDecision> {
      const byId = new Map(candidates.map((c) => [c.id, c]));
      const fallback = (reason: string): RoutingDecision => {
        const chosen = byId.get(defaultId) ?? candidates[0];
        return chosen
          ? { agentId: chosen.id, name: chosen.name, reason, fallback: true }
          : // No roster at all is a misconfiguration, not a routing outcome; surface the default id.
            { agentId: defaultId, name: defaultId, reason, fallback: true };
      };

      // Nothing to decide between: one coworker, or none but the default.
      if (candidates.length <= 1) {
        return fallback("the only coworker available");
      }

      let raw: string;
      try {
        raw = await this._complete(text, candidates);
      } catch {
        return fallback(
          "sent to your default while the router was unreachable",
        );
      }

      let parsed: { agentId?: unknown; reason?: unknown; confidence?: unknown };
      try {
        // The model is asked for bare JSON, but tolerate a fenced or padded answer.
        const match = raw.match(/\{[\s\S]*\}/);
        parsed = match ? JSON.parse(match[0]) : {};
      } catch {
        return fallback(
          "sent to your default; the router's answer did not parse",
        );
      }

      const id = typeof parsed.agentId === "string" ? parsed.agentId : "";
      const match = byId.get(id);
      if (!match) {
        // A returned id that is not on the roster is the dangerous case: never act on it.
        return fallback(
          "sent to your default; the router named no coworker on your roster",
        );
      }
      const confidence =
        typeof parsed.confidence === "number" ? parsed.confidence : 0;
      if (confidence < MIN_CONFIDENCE) {
        return fallback(
          "sent to your default; no specialist was a confident match",
        );
      }

      const reason =
        typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim()
          : `matches ${match.name}`;
      return { agentId: match.id, name: match.name, reason, fallback: false };
    },

    // Split out so the prompt-build + call is one seam the tests can leave alone.
    async _complete(
      text: string,
      candidates: readonly RoutingCandidate[],
    ): Promise<string> {
      return deps.complete(routingPrompt(text, candidates));
    },
  };
}

export type IntentRouter = ReturnType<typeof createIntentRouter>;
