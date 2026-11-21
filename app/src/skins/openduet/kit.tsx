import { cn } from "@/lib/utils";

/*
 * The two pieces of OpenDuet's chrome the frame's parts share: the focus ring and the glass disc.
 * Everything a screen lists is OpenBot's own component; these only dress the frame around Ele.
 */

/** The focus ring every control Em the frame draws: the accent, soft. */
Exportar const FOCUS =
  "outline-none focus-visible:ring-3 focus-visible:ring-openduet-accent/40";

/**
 * A round glass control over the screen: the header's discs. It gives a little when pressed,
 * unless the person asked for less motion.
 */
export const DISC = cn(
  "openduet-glass grid shrink-0 place-items-center rounded-full text-openduet-ink shadow-openduet-glass transition-transform duration-[120ms] active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100",
  FOCUS,
);
