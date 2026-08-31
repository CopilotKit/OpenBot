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
 * Monospace and pre-wrapped, in a box that scrolls rather than one that truncates: an ellipsis in
 * the middle of an instruction is the one rendering this may not do, because the part it hides is
 * the part worth hiding something in. No markdown renderer touches it either — a heading and a link
 * are formatting a model never sees, and the reader needs to read what the model reads. React's own
 * text escaping is what makes `<script>` and `&lt;` appear as themselves rather than disappearing
 * into the document; the parser has already refused the characters that would be invisible here
 * whatever this box did.
 */
export function Verbatim({ children }: { children: string }) {
  return (
    <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
      {children}
    </pre>
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
