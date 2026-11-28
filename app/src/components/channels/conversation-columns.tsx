import type { ReactNode } from "react";

/**
 * The two columns every conversation is drawn in, one Bot or several: the transcript's, and the
 * composer's under it. One definition, so a group cannot drift from a conversation with one Bot;
 * it once had neither column's side inset, and on a phone its lines and its message box ran to the
 * screen's edges.
 *
 * A `.tsx` file rather than `.ts` on purpose: the real-browser tests build the stylesheet from the
 * classes in every `.tsx` file under `components`, and these classes have to be in it.
 */

/**
 * The transcript's column. 768px, wider than the composer's 672px, which is the reading width
 * ChatGPT and Claude.ai give an answer, and 16px a side in a pane narrower than that.
 */
export const transcriptColumn = "mx-auto w-full max-w-3xl px-4";

/**
 * THE TRANSCRIPT'S SIDE INSET IN A NARROW PANE, AND THE SAME 768px COMPOSER IN A WIDE ONE.
 *
 * The composer had no inset of its own, so in a pane narrower than its 768px column it ran to the
 * pane's border, and the starter tasks above it with it, while the transcript kept 16px a side. Now
 * the column always pads `px-4`, as the transcript's does, and is allowed 2rem more than
 * `max-w-3xl` to pay for it: from an 800px pane up the composer is 768px wide exactly as before, and
 * below that it stands 16px off each edge.
 *
 * A width, not a breakpoint, on purpose. A viewport breakpoint does not know how much of the window
 * the sidebar takes, and a container query would need `@container` on an ancestor of the composer,
 * which is layout containment: it would become the containing block for the @ menu, which is
 * `position: fixed` at the caret (see `DictationSurface`).
 *
 * `composer-column` is the hook skins restyle it by (`skins.css`, and OpenDuet's and OpenDots' own).
 */
export function ComposerColumn({ children }: { children: ReactNode }) {
  return (
    <div
      className="mx-auto w-full max-w-[calc(var(--container-3xl)+2rem)] shrink-0 px-4 pb-4"
      data-slot="composer-column"
    >
      {children}
    </div>
  );
}
