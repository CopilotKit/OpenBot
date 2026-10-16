import { markFor } from "@/lib/marks";

/**
 * A framework's own mark, beside its name.
 *
 * Draws nothing when the brand has no mark. Three of the frameworks have none in any maintained
 * set, and `shared/marks/README.md` is explicit about why nothing is drawn to fill the gap: a
 * monogram we drew would read as the vendor's own, which is the thing a trade mark holder actually
 * objects to. The caller draws the name either way, so a row without a mark is not a lesser one.
 *
 * Decorative, always: `alt=""` and `aria-hidden`, because the name is already there in text and a
 * screen reader announcing "LangGraph LangGraph" is worse than one announcing it once.
 */
export function HarnessMark({ id, name }: { id: string | null; name: string }) {
  const uri = markFor(id);
  if (!uri) return null;
  return (
    <img
      alt=""
      aria-hidden="true"
      className="size-5 shrink-0"
      data-mark={name}
      src={uri}
    />
  );
}
