import { GALLERY_COMPONENTS } from "@/lib/copilot/gallery-registry";

/**
 * The answers a Bot can give, drawn rather than described.
 *
 * Somebody meeting this product asks one question first: what does an answer look like? A list of
 * names answers it for nobody, and a screenshot ages the moment a component changes. So every tile
 * is the real component, rendered from the arguments it ships as its own introduction: the actual
 * donut, the actual line chart, the actual card that waits for an answer.
 *
 * What is shown is what the Bot was granted, not what the build contains. A component can be
 * unpublished, or held back from this Bot, and showing it anyway would be advertising something the
 * person cannot have.
 *
 * The tiles are quiet on purpose. Every one of them is a different shape, colour and density, and
 * the eye should land on those rather than on frames we drew around them: one hairline, one label,
 * and the component left to be the interesting thing.
 */

/**
 * Charts first.
 *
 * They answer "is any of this visual" in one glance. A rail that opens with two decision cards and
 * a paragraph makes somebody scroll to find that out, and most people will not.
 */
const ORDER: Record<string, number> = { chart: 0, card: 1, decision: 2 };

export function GalleryPreview({
  /**
   * What this Bot may actually answer with, as the deployment reports it.
   *
   * Undefined while it is still being asked for, which is not the same as an empty list: one is
   * "not yet" and the other is "none", and they must not look alike.
   */
  available,
  /**
   * How many across. One by default, and that is not timidity.
   *
   * These are conversation-sized components: a record card has a label column and a value column, a
   * chart has an axis. Give them half of a narrow rail and the values wrap to one character per
   * line, which is not a smaller version of the component but a broken one. Two-up is for a page
   * with a page's width.
   */
  columns = 1,
}: {
  available?: readonly { name: string; description: string }[];
  columns?: 1 | 2;
}) {
  if (!available) {
    return (
      <p className="text-muted-foreground text-sm">Loading what it can draw…</p>
    );
  }

  const granted = new Map(
    available.map((component) => [component.name, component.description]),
  );
  const shown = GALLERY_COMPONENTS.filter((component) =>
    granted.has(component.name),
  ).sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9));

  if (shown.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        This Bot has not been granted any components, so it answers in prose.
      </p>
    );
  }

  return (
    <ul
      className={`grid gap-px overflow-hidden rounded-xl border border-border bg-border ${
        columns === 2 ? "grid-cols-1 xl:grid-cols-2" : "grid-cols-1"
      }`}
    >
      {shown.map((component) => (
        <li
          className="flex flex-col gap-3 bg-background p-4"
          key={component.name}
        >
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="font-medium text-sm">{component.title}</h3>
            <span className="shrink-0 text-[11px] text-muted-foreground uppercase tracking-wider">
              {component.kind}
            </span>
          </div>

          <div className="min-w-0">
            <PreviewOf name={component.name} />
          </div>

          <p className="text-muted-foreground text-xs leading-relaxed">
            {firstSentence(
              granted.get(component.name) || component.description,
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * One component, drawn from its own sample props.
 *
 * Separate from the gallery because the two surfaces want different framing: the gallery labels
 * every tile, and an admin page already has the name and the description above it.
 */
export function PreviewOf({ name }: { name: string }) {
  const component = GALLERY_COMPONENTS.find((entry) => entry.name === name);
  if (!component) return null;
  if (!component.preview) {
    /*
     * Said rather than faked. This one draws whatever the deployment's own records hold, and
     * inventing numbers for a tile would be the single dishonest thing on a page whose whole
     * argument is that answers come from somewhere real.
     */
    return (
      <p className="text-muted-foreground text-sm">
        Draws this deployment's own records, so it has nothing to show until a
        Bot asks for it.
      </p>
    );
  }
  return (
    /*
     * Not interactive: a decision card here has nothing to decide, and a button that does nothing
     * is worse than one that is plainly a picture.
     */
    <div className="pointer-events-none" inert>
      <component.Component {...component.preview} />
    </div>
  );
}

/**
 * The first sentence of what the model is told.
 *
 * The full description is written for a model deciding whether to call this, and carries the
 * comparisons that matter to that decision. A person reading a gallery wants to know what it is.
 */
function firstSentence(description: string): string {
  const end = description.indexOf(". ");
  return end === -1 ? description : description.slice(0, end + 1);
}
