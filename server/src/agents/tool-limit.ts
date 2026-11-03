import { resolveModel } from "@copilotkit/runtime/v2";
import { MODEL_TOOL_LIMIT } from "@openbot/shared/model-tool-limit";
import {
  type AuditInitiator,
  type AuditStore,
  recordAuditEvent,
} from "../audit";

/**
 * The last check before a built-in Bot's model call: a run that would send more tools than its
 * provider accepts is refused with a sentence, instead of being sent a request that cannot succeed.
 *
 * A BACKSTOP NOW, NOT THE DEFENCE. Tool search (`tool-search.ts`) keeps what one step is sent under
 * {@link MODEL_TOOL_LIMIT} by putting an app's tools behind a search. What it cannot put away is
 * what a Bot needs to be itself, the tools the client adds, and the runtime's own two, so a run
 * whose own core is past the limit still reaches here. That should be rare, and when it happens the
 * person is owed a sentence and the admin a row, not an empty answer.
 *
 * DECIDED BY THE API, NOT THE HOST. Measured: Chat Completions refuses a 129th tool on every OpenAI
 * model, and the Responses API took 2,000. The runtime picks the API (Responses on OpenAI's and
 * Azure's hosts, Chat Completions on any other unless `COPILOTKIT_OPENAI_API` says otherwise), so
 * the question is asked of the runtime's own `resolveModel` rather than answered again here: a copy
 * of that rule would drift from it, and the first sign would be a Bot refused on the wrong path.
 * The Responses API's real limit is the compiled size of its strict schemas, which depends on what
 * the schemas say and not on how many there are, so no count is enforced there; the provider's own
 * refusal reaches the person as the run's error. Anthropic documents no count for ordinary tools.
 */

export type ToolLimit = {
  /** The provider, as a person reads it in the refusal. */
  provider: string;
  limit: number;
};

/**
 * The limit a built-in Bot's requests are held to, or null where no count applies.
 *
 * Resolving builds a provider client and sends nothing. A model the runtime cannot resolve is not
 * this check's to refuse: the run fails on its own, with the runtime's own message.
 */
export function toolLimitFor(
  model: { provider: "openai" | "anthropic"; defaultModel: string },
  apiKey?: string,
): ToolLimit | null {
  if (model.provider !== "openai") return null;
  try {
    const resolved = resolveModel(`openai/${model.defaultModel}`, apiKey);
    return typeof resolved === "object" && resolved.provider === "openai.chat"
      ? { provider: "OpenAI", limit: MODEL_TOOL_LIMIT }
      : null;
  } catch {
    return null;
  }
}

/**
 * The `provider` of a limit that is OpenBot's own: the most tools tool search sends in one step,
 * on a provider that documents no count. Recorded under this name so an admin reading the row is not
 * told a provider refused something it never saw.
 */
export const OPENBOT_TOOL_LIMIT = "OpenBot";

/**
 * What the person is shown: which Bot, how many, how many fit, and whose number that is.
 *
 * The next step is an admin's, and it is "look", not "remove apps": an app's tools wait behind
 * search and are not in this count, so removing an app rarely changes it. What is counted is what
 * the Bot needs on every step, and the audit row says how many that was.
 */
export function toolLimitRefusal(
  botName: string,
  count: number,
  limit: ToolLimit,
): string {
  const whose =
    limit.provider === OPENBOT_TOOL_LIMIT
      ? `OpenBot sends at most ${limit.limit} at once`
      : `its model takes at most ${limit.limit} at once`;
  return `${botName} can't answer. It needs ${count} tools on every step, and ${whose}. Ask an admin to check this Bot's setup.`;
}

/**
 * How a refusal reaches the audit trail, bound per person the way the server binds every other
 * per-person collaborator. Here rather than inline at boot so the row it writes can be tested.
 */
export function toolLimitRecorder(store: AuditStore) {
  return (actorId: string, initiator?: AuditInitiator) =>
    (
      botId: string,
      refused: { tools: number; limit: number; provider: string },
    ): Promise<void> =>
      recordAuditEvent(store, {
        eventType: "agent.tool_limit_refused",
        targetType: "agent",
        targetId: botId,
        actorUserId: actorId,
        ...(initiator ? { initiator } : {}),
        payload: { bot: botId, ...refused },
      });
}
