export const SLACK_TURN_PHASES = [
  "identity.resolve",
  "ingress.remember",
  "ingress.take",
  "identity.validate",
  "link_card.post",
  "thread.subscribe",
  "execution.prepare",
  "agent.run",
  "transcript_link.post",
] as const;

export type SlackTurnPhase = (typeof SLACK_TURN_PHASES)[number];
export type SlackTurnFailureEvent = {
  type: "slack-turn-failed";
  phase: SlackTurnPhase;
  reason?: SlackTurnFailureReason;
};
export type SlackTurnFailureLogger = (event: SlackTurnFailureEvent) => void;

const SLACK_TURN_FAILURE_REASONS = new Set([
  "slack_identity_provider_invalid",
  "slack_identity_actor_kind_invalid",
  "slack_identity_tenant_invalid",
  "slack_identity_actor_invalid",
  "slack_identity_link_lookup_failed",
  "slack_identity_user_lookup_failed",
  "slack_identity_email_lookup_failed",
  "slack_identity_link_write_failed",
  "slack_identity_link_token_failed",
]);

type SlackTurnFailureReason =
  | "slack_identity_provider_invalid"
  | "slack_identity_actor_kind_invalid"
  | "slack_identity_tenant_invalid"
  | "slack_identity_actor_invalid"
  | "slack_identity_link_lookup_failed"
  | "slack_identity_user_lookup_failed"
  | "slack_identity_email_lookup_failed"
  | "slack_identity_link_write_failed"
  | "slack_identity_link_token_failed";

function safeFailureReason(error: unknown): SlackTurnFailureReason | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return;
  const code = error.code;
  return typeof code === "string" && SLACK_TURN_FAILURE_REASONS.has(code)
    ? (code as SlackTurnFailureReason)
    : undefined;
}

export const defaultSlackTurnFailureLogger: SlackTurnFailureLogger = (
  event,
) => {
  console.error(JSON.stringify(event));
};

export async function runSlackPhase<T>(
  phase: SlackTurnPhase,
  operation: () => T | Promise<T>,
  logger: SlackTurnFailureLogger,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    try {
      const reason = safeFailureReason(error);
      logger({
        type: "slack-turn-failed",
        phase,
        ...(reason ? { reason } : {}),
      });
    } catch {
      // Observability must never replace the application failure.
    }
    throw error;
  }
}
