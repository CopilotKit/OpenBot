import { markFor } from "./marks";

/**
 * A brand's mark beside its name, or the name on its own.
 *
 * The name is drawn by the caller either way. This component owns only the tile, so a row with no
 * mark keeps the same shape as a row with one and does not read as unfinished.
 *
 * Decorative, always: `alt=""` and `aria-hidden`, because the name is already there in text and a
 * screen reader announcing "OpenAI OpenAI" is worse than one announcing it once.
 */
export function Mark({ id, name }: { id: string | null; name: string }) {
  const uri = markFor(id);
  if (!uri) {
    /*
     * No mark exists for this brand anywhere we can use, so the name carries the tile and nothing
     * is invented to fill it: see src/marks/README.md.
     *
     * Only a name that is actually a brand, though. "An agent you already run" is a description of
     * a choice rather than a company, and setting it in a 44px box produced "An agent you alrea dy
     * run" stacked five lines deep. A row with no tile is cleaner than a tile with a paragraph in
     * it, and that row already reads by its name and summary.
     */
    if (name.length > 12) return null;
    return (
      <div className="mark-tile mark-wordmark" aria-hidden="true">
        <span>{name}</span>
      </div>
    );
  }
  return (
    <div className="mark-tile">
      <img src={uri} alt="" aria-hidden="true" />
    </div>
  );
}
