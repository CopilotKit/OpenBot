import { IconCloud } from "@tabler/icons-react";

/**
 * The tile for "Any OpenAI-compatible endpoint": Tabler's cloud, the icon OpenBot's admin page gives
 * the same source.
 *
 * An endpoint is nobody's, so no vendor's mark belongs here (see shared/marks/README.md). Without a
 * tile, though, it was the one row in the list with nothing beside its name. This is the marks' own
 * tile, white and bordered in both themes, with the icon in the marks' ink.
 *
 * Decorative, like a mark: the row's name already says what it is.
 */
export function EndpointMark() {
  return (
    <div className="mark-tile mark-icon" aria-hidden="true" data-icon="cloud">
      <IconCloud stroke={1.75} />
    </div>
  );
}
