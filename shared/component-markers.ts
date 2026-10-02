/**
 * How a gallery component's tool result starts when nothing was drawn.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, for the reason `handoff-markers.ts` gives. The browser
 * answers a refused component call with this, and so does the server when it executes a component
 * for a headless turn with nobody watching. The transcript renderer reads it back when a stored
 * conversation is opened later, so a call that was refused is drawn as a refusal rather than as the
 * chart it was never allowed to be.
 */
export const NOT_SHOWN = "Not shown: ";

/** How that result ends: addressed to the model, and stripped before a person reads the reason. */
export const NOT_SHOWN_TAIL =
  " Nothing was displayed, so tell the person that.";
