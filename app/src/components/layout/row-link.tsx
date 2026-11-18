import { cloneElement, type ReactElement, type ReactNode } from "react";

/**
 * A row that opens somewhere and also has buttons of its own (Stop, Reopen, Try again): its title
 * is the link, stretched over the whole row, so a click anywhere on it opens it, and the buttons sit
 * above the stretch. A button can't go inside a link, so before this such a row either lost its
 * link or put Open on a line of its own under the words.
 *
 * `ROW_WITH_LINK` goes on the Item, `ROW_BUTTONS` on its ItemActions.
 */
export const ROW_WITH_LINK =
  "relative hover:bg-muted has-[[data-slot=row-link]:focus-visible]:ring-[3px] has-[[data-slot=row-link]:focus-visible]:ring-ring/50";

export const ROW_BUTTONS =
  "[&_a]:relative [&_a]:z-10 [&_button]:relative [&_button]:z-10";

/** The row's title as its link: `link` is where it goes, a router Link with no children. */
export function RowLink({
  link,
  children,
}: {
  link: ReactElement<{ className?: string; children?: ReactNode }>;
  children: ReactNode;
}) {
  return cloneElement(link, {
    className:
      "outline-none after:absolute after:inset-0 after:rounded-lg after:content-['']",
    "data-slot": "row-link",
    children,
  } as never);
}
