/**
 * The message box's frame, shared by its two layouts (docs/app-guidelines.md, "The look").
 *
 * At rest it is a card like any other: flat, with a hairline border. While someone types in it, it
 * glows in the focus color: its border tints, a soft ring of `ring` goes round it and a soft
 * shadow of `ring` sits under it. It is the only thing in the app that glows, and it is drawn from
 * `ring` alone, so it has its dark value already. The glow eases in, and with reduced motion it
 * simply appears.
 */
export const MESSAGE_BOX_FRAME =
  "rounded-xl border border-border bg-card transition-[border-color,box-shadow] duration-150 ease-out motion-reduce:transition-none focus-within:border-ring/60 focus-within:ring-4 focus-within:ring-ring/15 focus-within:shadow-lg focus-within:shadow-ring/20";
