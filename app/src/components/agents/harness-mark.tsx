import { markFor } from "@/lib/marks";

/**
 * A framework's own mark, beside its name.
 *
 * Draws nothing when the brand has no mark, and `shared/marks/README.md` is explicit about why
 * nothing is drawn to fill the gap: a monogram we drew would read as the vendor's own, which is the
 * thing a trade mark holder actually objects to. The caller draws the name either way, so a row
 * without a mark is not a lesser one.
 *
 * Decorative, always: `alt=""` and `aria-hidden`, because the name is already there in text and a
 * screen reader announcing "LangGraph LangGraph" is worse than one announcing it once.
 */
/** The column every row reserves, marked or not, so the names beside it line up. */
export const MARK_TILE = "size-5 shrink-0";

export function HarnessMark({ id, name }: { id: string | null; name: string }) {
  const uri = markFor(id);
  /*
   * An empty box of the same size, not nothing. A row with no mark ("An agent you already run", or
   * a brand that publishes none) in a collapsed box started its name a tile's width to the left of
   * the rest — a ragged list rather than a row without artwork. Reserving the column draws no mark and invents none, which is
   * what the README forbids; it only keeps the names in line.
   */
  if (!uri) return <span aria-hidden="true" className={MARK_TILE} />;
  return (
    /*
     * ON A WHITE TILE IN DARK MODE, BECAUSE SOME MARKS DISAPPEAR WITHOUT ONE. A mark drawn in
     * `currentColor` (Antigravity, Mastra, OpenAI, half of Strands) cannot see the page's text
     * colour from inside an `<img>`, so it is always black; LangGraph and CrewAI are drawn in fixed
     * dark colours. All of them read on white, so dark mode gives every mark a white tile rather
     * than recolouring anybody's artwork, which `shared/marks/README.md` rules out.
     */
    <img
      alt=""
      aria-hidden="true"
      className={`${MARK_TILE} rounded-sm dark:bg-white dark:p-0.5`}
      data-mark={name}
      src={uri}
    />
  );
}
