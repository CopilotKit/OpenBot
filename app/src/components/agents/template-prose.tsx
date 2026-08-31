/**
 * How a stranger's words are drawn, wherever they are drawn.
 *
 * Two screens render a template's prose: the consent screen, where somebody decides whether to run
 * it, and the template's own page, where somebody reads it before deciding anything. They must
 * render it IDENTICALLY. The treatment below is a security control rather than a style — verbatim,
 * unabridged, unformatted — and a second copy of it is a second place for one of those three
 * properties to be quietly lost, on whichever screen nobody looked at recently.
 */

/**
 * A stranger's text, shown as the characters it is.
 *
 * Monospace and pre-wrapped: an ellipsis in the middle of an instruction is the one rendering this
 * may not do, because the part it hides is the part worth hiding something in. No markdown renderer
 * touches it either — a heading and a link are formatting a model never sees, and the reader needs
 * to read what the model reads. React's own text escaping is what makes `<script>` and `&lt;` appear
 * as themselves rather than disappearing into the document; the parser has already refused the
 * characters that would be invisible here whatever this box did.
 *
 * WHETHER IT IS A BOX OR A DOCUMENT IS THE CALLER'S TO SAY, and neither answer touches the three
 * properties above. The height cap arrived here with the consent panel, which is a 560px side
 * surface where a 155-line block wedged between two decisions is worse than a scroll well. It then
 * came along when this component was extracted, and turned the template's own page — whose entire
 * argument is that "read it before you install it" is only honest advice if there is somewhere to
 * read it — into six or seven twelve-line portholes, each with a nested scroller that hands
 * scrolling back to the page at its end. A reader auditing a stranger's YAML could not see the
 * shape of the document. So the page that is a document passes `capped={false}`, and the panel that
 * is a decision surface keeps the cap.
 *
 * When it IS capped it scrolls, so it must be reachable by keyboard: a scroll container that no
 * key can reach hides the second half of a stranger's instructions from anybody not using a mouse.
 * `tabIndex` and the name are applied only in that case, because an uncapped block scrolls nothing
 * and would be a tab stop that goes nowhere. `role="group"` rather than `region` — the reading page
 * draws six or more of these, and each one as a landmark would bury the page's real structure.
 */
const PROSE =
  "whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed";

export function Verbatim({
  children,
  capped = true,
  label,
}: {
  children: string;
  capped?: boolean;
  /** Names the box when it scrolls, so a keyboard reader knows whose words they landed in. */
  label?: string;
}) {
  /*
   * TWO SHAPES RATHER THAN ONE WITH THREE TERNARIES, because the scrolling one carries an
   * interaction contract that has to hold together: a tab stop, a role that gives it a name, and
   * the name itself. Written as conditional props, a lint rule cannot see that the role and the
   * label always arrive together, and neither can a reader — which is how one of the three goes
   * missing later. The class list is shared, so the three properties that are a security control
   * (verbatim, unabridged, unformatted) cannot drift between them.
   */
  if (!capped) {
    return <pre className={PROSE}>{children}</pre>;
  }
  /*
   * A NAMED SECTION AROUND THE SCROLLER, rather than a role and a tabindex on the `pre` itself.
   * A `section` with an accessible name is already a region, so the scroll container is reachable
   * and announced without asserting a role by hand — which is what both `useSemanticElements` and
   * `noNoninteractiveTabindex` are pointing at when they refuse the shorter spelling. The `pre`
   * keeps every property that is the security control; the wrapper only owns the scrolling.
   */
  return (
    <section
      aria-label={label ?? "A stranger's text"}
      className="max-h-64 overflow-y-auto rounded-lg border border-border bg-muted/40"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container that no key can reach hides the second half of a stranger's instructions from anybody not using a mouse.
      tabIndex={0}
    >
      <pre
        className={`whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed`}
      >
        {children}
      </pre>
    </section>
  );
}

/** A claim the author typed. Never an anchor, and labelled as a claim wherever it appears. */
export function Claim({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      {/*
       * `source` and `example_url` arrive looking like addresses and are rendered as text on
       * purpose. They are attacker-controlled strings sitting a centimetre from a Bot's name while
       * somebody decides whether to trust it, and a link is a thing that can be clicked by somebody
       * who has not finished reading. `break-all` because a long one must wrap rather than push the
       * panel wide.
       */}
      <span className="break-all font-mono text-xs">{value}</span>
    </div>
  );
}

/**
 * The sentence that heads every block of somebody else's prose.
 *
 * One string, used on both screens, because it is the sentence doing the work: a reader who knows
 * these are instructions written by a stranger reads them differently from one who thinks they are
 * a product description. Softening it on one screen and not the other would leave the softer one as
 * the one people happen to read.
 */
export const STRANGER_WROTE_IT =
  "This text is given to a model as instructions. It was written by a stranger.";
