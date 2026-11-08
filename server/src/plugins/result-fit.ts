import { cutAtCodeUnits } from "../channels/text";
import { MAX_RESULT_CHARS } from "./mcp";

/**
 * A connector's JSON answer as the text a model reads, kept under {@link MAX_RESULT_CHARS} without
 * cutting through the middle of a record, and saying how to get whatever was left out.
 *
 * THE CUT USED TO BE BLIND. A result over the cap was cut at character 20,000 and ended
 * "[truncated]". A Gmail listing is an array of messages, each carrying its raw MIME payload, so the
 * cut landed inside the FIRST message's base64-encoded HTML: the Bot was handed part of one email,
 * no page token (it sat after the cut) and no word on how to read the rest, and it told the person
 * it could not say whether its answer covered their inbox. A cut a model can see is still better
 * than an unbounded one; what it was missing was the way back to the rest.
 *
 * SO A LIST IS CUT BETWEEN ITS ITEMS. Where the answer holds an array, as many whole items as fit are
 * kept, the rest are named by count, and the note says which call fetches them: by default the same
 * call asking for no more than that many at a time, so the vendor's own page token then starts
 * exactly where the shown items stop. A next-page token beside a cut list is dropped, because
 * following it would skip the items that were left out of this answer.
 *
 * ANYTHING ELSE IS CUT AS BEFORE, and the note says how to ask for less instead of only that
 * something is missing.
 */

/** Where an action's answer keeps its records, and how a model reads the ones a cut leaves out. */
export type ListShape = {
  /** The top-level key holding the array, `messages` for a Gmail listing. */
  key: string;
  /**
   * Top-level keys left out when the list is cut: the next page's token, and anything that names
   * it, since following it would skip the records left out.
   */
  dropWhenCut: readonly string[];
  /** The end of "To read them, …", given how many whole records were shown and the ones left out. */
  rest(shown: number, leftOut: readonly unknown[]): string;
};

/**
 * A top-level key that carries the cursor to the next page, in the spellings vendors use. Used only
 * where the action has no {@link ListShape}, to drop a token that would skip the items left out.
 */
const CURSOR_KEY = /^next_?(page_?)?(token|cursor)$/i;

/** The note that ends a result cut as text. Written for the model that called the action. */
export function cutNote(toolName: string, length: number): string {
  return `[truncated: ${toolName} returned ${length} characters and only the first ${MAX_RESULT_CHARS} are shown. To read the rest, call it again asking for less: fewer results per call, fewer fields, or a narrower search, then page through what is left.]`;
}

/** The note that ends a list cut between its items. Written for the model that called the action. */
export function listNote(options: {
  toolName: string;
  key: string;
  shown: number;
  total: number;
  /** How to read the rest, when the action's shape says; a generic sentence otherwise. */
  rest?: string;
}): string {
  const { toolName, key, shown, total } = options;
  const rest =
    options.rest ??
    `call ${toolName} again asking for at most ${shown} at a time, then page through the rest`;
  return `[truncated: ${toolName} answered with ${total} ${key}. The first ${shown} are shown above, each whole, and the other ${total - shown} were left out so this result fits. To read them, ${rest}.]`;
}

/** The array a cut keeps whole items of, and where it is. Null when there is nothing to page. */
function listOf(
  value: unknown,
  shape: ListShape | undefined,
): { key: string | null; items: unknown[] } | null {
  if (Array.isArray(value)) return { key: null, items: value };
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (shape) {
    const items = record[shape.key];
    return Array.isArray(items) ? { key: shape.key, items } : null;
  }
  // No declared shape: the longest array at the top level is the list.
  let found: { key: string; items: unknown[] } | null = null;
  for (const [key, items] of Object.entries(record)) {
    if (Array.isArray(items) && items.length > (found?.items.length ?? 0)) {
      found = { key, items };
    }
  }
  return found;
}

/**
 * The text of a JSON answer, fitted to the cap. `text` is `JSON.stringify(value, null, 2)`, which
 * the caller has already made and checked has a JSON form at all.
 */
export function fitJsonResult(
  value: unknown,
  text: string,
  toolName: string,
  shape?: ListShape,
): { text: string; truncated: boolean } {
  if (text.length <= MAX_RESULT_CHARS) return { text, truncated: false };

  const list = listOf(value, shape);
  if (list && list.items.length > 1) {
    const render = (count: number) => {
      const items = list.items.slice(0, count);
      if (list.key === null) return JSON.stringify(items, null, 2);
      const kept = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([key]) =>
          shape ? !shape.dropWhenCut.includes(key) : !CURSOR_KEY.test(key),
        ),
      );
      return JSON.stringify({ ...kept, [list.key]: items }, null, 2);
    };
    // The most whole items that fit: the rendered length only grows with the count.
    let low = 0;
    let high = list.items.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (render(middle).length <= MAX_RESULT_CHARS) low = middle;
      else high = middle - 1;
    }
    if (low > 0) {
      return {
        text: `${render(low)}\n\n${listNote({
          toolName,
          key: list.key ?? "items",
          shown: low,
          total: list.items.length,
          ...(shape ? { rest: shape.rest(low, list.items.slice(low)) } : {}),
        })}`,
        truncated: true,
      };
    }
  }

  return {
    text: `${cutAtCodeUnits(text, MAX_RESULT_CHARS)}\n\n${cutNote(toolName, text.length)}`,
    truncated: true,
  };
}
