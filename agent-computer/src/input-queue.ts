/**
 * The person's input on a live screen, applied one message after another, with superseded moves and
 * scrolls folded together while they wait.
 *
 * Applying a message is a trip to the browser that waits for the page to take it, about a frame. A
 * mouse sends a move 60 to 144 times a second and a trackpad sends scrolls faster still, so a queue
 * that applied every one grew for as long as the hand moved: a click landed behind seconds of stale
 * moves, and a scroll went on after the fingers stopped. Only the newest position of a move still
 * waiting matters, and scrolls still waiting add up to one, so each is folded into the message waiting
 * just before it when that one is the same kind. Nothing else is ever folded or dropped: a press, a
 * release, a key and a paste are applied, in the order sent, every time.
 *
 * Only a message still waiting is folded, never one being applied, and only into the one directly
 * before it, so the order of everything the person did stays as they did it.
 */

type WheelMessage = Record<string, unknown> & {
  deltaX: number;
  deltaY: number;
};

/** What the queue reads of a message to decide whether it can fold. Anything else is applied as sent. */
type Foldable =
  | { kind: "move"; modifiers: number }
  | { kind: "wheel"; message: WheelMessage; modifiers: number };

type Item = { raw: string; fold: Foldable | null };

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Whether a raw message is a move or a scroll, read without trusting it: anything odd is not folded. */
export function foldableOf(raw: string): Foldable | null {
  // A frame-sized string is not a move. Folding is an optimisation, so anything large is simply applied.
  if (raw.length > 1_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  const message = parsed as Record<string, unknown>;
  const modifiers = finite(message.modifiers) ? message.modifiers : 0;
  if (!finite(message.x) || !finite(message.y)) return null;
  if (message.type === "mouse" && message.event === "moved")
    return { kind: "move", modifiers };
  if (
    message.type === "wheel" &&
    finite(message.deltaX) &&
    finite(message.deltaY)
  )
    return { kind: "wheel", message: message as WheelMessage, modifiers };
  return null;
}

/**
 * Fold `next` into `waiting` when both are moves, or both scrolls with the same modifiers held.
 * Answers the item that stands for both, or null when they must stay two.
 */
function fold(waiting: Item, next: Item): Item | null {
  if (!waiting.fold || !next.fold) return null;
  const a = waiting.fold;
  const b = next.fold;
  if (a.modifiers !== b.modifiers) return null;
  // The newer move replaces the older: where the pointer was on its way is not worth a frame.
  if (a.kind === "move" && b.kind === "move") return next;
  if (a.kind === "wheel" && b.kind === "wheel") {
    // At the newer position, by the distance of both.
    const message = {
      ...b.message,
      deltaX: a.message.deltaX + b.message.deltaX,
      deltaY: a.message.deltaY + b.message.deltaY,
    };
    return {
      raw: JSON.stringify(message),
      fold: { kind: "wheel", message, modifiers: b.modifiers },
    };
  }
  return null;
}

export type InputQueue = {
  /** A message from the person, applied after everything sent before it. */
  push(raw: string): void;
  /** How many items are waiting, not counting the one being applied. For tests and logs. */
  waiting(): number;
};

export function createInputQueue(
  apply: (raw: string) => Promise<void>,
  onError: (error: unknown) => void = () => undefined,
): InputQueue {
  const pending: Item[] = [];
  let running = false;

  const drain = async () => {
    if (running) return;
    running = true;
    try {
      for (let item = pending.shift(); item; item = pending.shift()) {
        try {
          await apply(item.raw);
        } catch (error) {
          // One that failed says so and lets the next one through.
          onError(error);
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    push(raw) {
      const next = { raw, fold: foldableOf(raw) };
      const last = pending.at(-1);
      const folded = last ? fold(last, next) : null;
      if (folded) pending[pending.length - 1] = folded;
      else pending.push(next);
      void drain();
    },
    waiting: () => pending.length,
  };
}
