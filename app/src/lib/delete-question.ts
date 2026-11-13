import { openingOf } from "@/lib/voice/cut";

/** How much of a name a delete question quotes before it is cut. */
const NAME_LIMIT = 60;

/**
 * The question a delete dialog asks, naming the thing by what its own page and list call it.
 *
 * `fallback` is asked when there is no name to quote, such as a conversation nobody has used yet.
 */
export function deleteQuestion(name: string, fallback: string): string {
  const trimmed = name.trim();
  if (!trimmed) return fallback;
  const shown =
    trimmed.length > NAME_LIMIT
      ? `${openingOf(trimmed, NAME_LIMIT).trimEnd()}…`
      : trimmed;
  return `Delete “${shown}”?`;
}
