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
  /**
   * The systems this coworker can actually reach, by name.
   *
   * Routing on the role description alone routes on what somebody wrote a coworker was for, which is
   * not the same as what it can do. A question about a document in Google Drive went to the coworker
   * whose description says "company knowledge" and which held no Drive grants at all, so it browsed
   * to the vendor, met a sign-in wall and asked the person to sign in to an account they had already
   * connected. The coworker that could have answered was one line further down the roster.
   *
   * Empty for a coworker holding nothing, which is most of them in most deployments. It is a hint
   * rather than a filter: a specialist with no connectors is still the right answer to a question
   * about its specialism.
   */
  reaches?: readonly string[];
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
    .map((c) =>
      [
        `- id: ${c.id}`,
        `  name: ${c.name}`,
        `  for: ${c.roleDescription}`,
        ...(c.reaches && c.reaches.length > 0
          ? [`  can reach: ${c.reaches.join(", ")}`]
          : []),
      ].join("\n"),
    )
    .join("\n");
  return [
    "You route a person's message to the one coworker best suited to it.",
    "Here are the coworkers and what each is for:",
    roster,
    "",
    'Reply with only JSON: {"agentId": "<one id from the list>", "reason": "<short, names the fit>", "confidence": <0..1>}.',
    "Pick the specialist whose purpose matches the message. If none clearly fits, use the most general coworker and give it a low confidence.",
    /*
     * Only when somebody on the roster can actually reach something.
     *
     * A deployment with no connectors would otherwise carry a rule about systems none of its
     * coworkers have, in every routing prompt it ever sends. Same principle as the guidance a Bot
     * gets about its own grants: say nothing about what is not there.
     */
    ...(candidates.some((c) => c.reaches && c.reaches.length > 0)
      ? [
          "When the message names a system a coworker can reach, prefer that coworker: one that cannot reach it has no way to answer and will fall back to a browser that is signed in as nobody. Purpose still comes first — a specialist with no systems listed is right for a question about its specialism.",
        ]
      : []),
    "",
    `Message: ${text}`,
  ].join("\n");
}

/**
 * The one coworker that can reach a system this message names, when there is exactly one.
 *
 * A hint for the router became a decision for the fallback, and only there. A confident match on
 * purpose still wins: a specialist with no connectors is the right answer to a question about its
 * specialism, and this must not turn reach into a filter that overrides that.
 *
 * Matched on the system's own id with separators loosened, so `google-drive` answers to "Google
 * Drive" as somebody would type it. Deliberately not fuzzy beyond that: a router that guesses at
 * near-misses is a router nobody can predict.
 */
function onlyCoworkerReaching(
  text: string,
  candidates: readonly RoutingCandidate[],
): { id: string; name: string; system: string } | null {
  const haystack = text.toLowerCase();
  const named = new Set<string>();
  for (const candidate of candidates) {
    for (const system of candidate.reaches ?? []) {
      const spelled = system.toLowerCase().replace(/[-_]+/g, " ");
      if (
        haystack.includes(spelled) ||
        haystack.includes(system.toLowerCase())
      ) {
        named.add(system);
      }
    }
  }

  for (const system of named) {
    const holders = candidates.filter((candidate) =>
      candidate.reaches?.includes(system),
    );
    const only = holders[0];
    if (holders.length === 1 && only) {
      return { id: only.id, name: only.name, system };
    }
  }
  return null;
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
        /*
         * Before the default, ask whether the message named a system only one coworker can reach.
         *
         * Every path into here is "we are not sure", and the default is a guess. When the message
         * says Google Drive and exactly one coworker holds Google Drive, that is not a guess: the
         * others cannot answer it at all, and a Bot with no connector meets a sign-in wall the
         * connector exists to avoid.
         *
         * Only when the answer is unambiguous. Two coworkers holding the same system is a choice
         * this cannot make, and it falls through to the default as before.
         */
        const reachable = onlyCoworkerReaching(text, candidates);
        if (reachable) {
          return {
            agentId: reachable.id,
            name: reachable.name,
            reason: `the only coworker that can reach ${reachable.system}`,
            fallback: true,
          };
        }
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
