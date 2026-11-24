/**
 * The message box's frame, shared by its two layouts (docs/app-guidelines.md, "The look").
 *
 * At rest it is a card like any other: flat, with a hairline border. While someone is typing in
 * it (it has focus and holds text, and the frame carries `data-typing`), it glows in the focus
 * color: its border tints, a soft ring of `ring` goes round it and a soft shadow of `ring` sits
 * under it. Focus alone is not enough: a conversation keeps the box focused from the moment it
 * opens, and a box that always glows is decoration. It is the only thing in the app that glows,
 * drawn from `ring` alone, so it has its dark value already. The glow eases in, and with reduced
 * motion it simply appears.
 */
export const MESSAGE_BOX_FRAME =
  "rounded-xl border border-border bg-card transition-[border-color,box-shadow] duration-150 ease-out motion-reduce:transition-none focus-within:data-typing:border-ring/60 focus-within:data-typing:ring-4 focus-within:data-typing:ring-ring/15 focus-within:data-typing:shadow-lg focus-within:data-typing:shadow-ring/20";
