import { GalleryFrame } from "./frame";

/** Why: what the Bot sent is not something the component can draw. */
export const UNREADABLE =
  "The Bot sent data OpenBot couldn't read. Ask it to try again.";

/** Why, when the call failed and what it sent was fine. */
export const WENT_WRONG =
  "Something went wrong while showing it. Ask the Bot to try again.";

/**
 * A call that is over and left nothing to draw: it failed, or what the Bot sent can't be read.
 *
 * Drawn in place of the component's waiting state, which otherwise waits for data that is never
 * coming, for good and again after a reload. A refusal is something else and has its own card
 * (`RefusedCard`): there the Bot was not allowed to show it, here it tried and couldn't.
 */
export function FailedCard({
  title,
  reason,
}: {
  /** The component's own title, so a person is not shown a tool name. */
  title: string;
  reason: string;
}) {
  return (
    <GalleryFrame>
      <div data-testid="component-failed" role="status">
        <p className="text-sm font-medium">
          Couldn't show the {title.toLowerCase()}.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{reason}</p>
      </div>
    </GalleryFrame>
  );
}
