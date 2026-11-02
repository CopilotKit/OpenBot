// The chat message and tool call a click landed in, as the content script reads them from the page, carried in a private
// field of the click to the service worker. The agent events (background/agent/events.ts) turn it into CopilotKit's own
// agent context for the click and remove it, so the click that leaves has exactly CopilotKit's fields.

/** The click value's private field. */
export const AGENT_TARGET_FIELD = "agentTarget";

/** The `data-message-id` and `data-tool-call-id` of the closest elements around the click, as CopilotKit's enricher
 * (`LearningBridge.enrich`) reads them; null where none. */
export type AgentTarget = {
  messageId: string | null;
  toolCallId: string | null;
};
