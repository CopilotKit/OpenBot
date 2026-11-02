import { MODEL_TOOL_LIMIT } from "@openbot/shared/model-tool-limit";

/**
 * Room left in every request for the tools a Bot carries without being granted them: remembering,
 * following up, asking for app access, the person's computer, the browser and whatever the app
 * declares. A built-in Bot sends about 40 of those.
 */
export const BUILT_IN_TOOL_ALLOWANCE = 40;

/** The most tools a Bot may be granted, so every request it makes stays within the model's limit. */
export const GRANTED_TOOL_BUDGET = MODEL_TOOL_LIMIT - BUILT_IN_TOOL_ALLOWANCE;

/**
 * Why granting `adding` more of an app's tools would take a Bot past what a model accepts, or null
 * when it fits. `holding` is how many tools the Bot is granted already.
 *
 * ONE PRESS USED TO GIVE EVERY READ AN APP HAS. For Composio's Shopify that was 239 tools, and the
 * Bot, now past the limit, never answered again. Refused instead, with the numbers, so the person
 * pressing learns why and can choose fewer.
 */
export function toolBudgetRefusal(input: {
  app: string;
  adding: number;
  holding: number;
}): string | null {
  const total = input.holding + input.adding;
  if (total <= GRANTED_TOOL_BUDGET) return null;
  return `This would give the Bot ${input.adding} of ${input.app}'s tools, ${total} granted in all, and a Bot can be granted at most ${GRANTED_TOOL_BUDGET}: a model takes at most ${MODEL_TOOL_LIMIT} tools in one request, and the Bot needs the rest for its own.`;
}
