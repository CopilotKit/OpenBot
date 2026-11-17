import { createMathPlugin } from "@streamdown/math";
/*
 * KaTeX's stylesheet and its fonts, which the stylesheet names by relative URL: the build emits the
 * fonts beside the app's other assets and serves them from the app's own origin, the desktop's
 * included, so a formula never reaches out to a CDN. Imported here, with the plugin, so the
 * stylesheet arrives with the first formula and not with every conversation.
 */
import "katex/dist/katex.min.css";

/**
 * Streamdown's maths plugin (remark-math and KaTeX). A single `$` stays a dollar sign, which is the
 * plugin's default: "$25,000" in an answer is a price. A formula KaTeX can't read is drawn as its
 * source in the muted text colour, as the plugin does, rather than as an error.
 */
export const math = createMathPlugin({
  singleDollarTextMath: false,
  errorColor: "var(--muted-foreground)",
});
