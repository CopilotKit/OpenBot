/*
 * The web app's look as rules a test can read (docs/app-guidelines.md, "The web app's look").
 *
 * Each rule is checked against one class at a time, with its variants taken off, so
 * `hover:md:rounded-sm` is read as `rounded-sm`. Only string literals are read, never comments:
 * the class names a screen draws with live in strings, and a comment may quote a class to say why
 * it is not used.
 */

export type Rule =
  | "corner"
  | "cornerStep"
  | "shadow"
  | "shadowStep"
  | "text"
  | "darkColor"
  | "card";

const SIDE = "(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?";

/** Each rule against one class, its variants already taken off. `card` is read per string. */
export const RULES: Record<Exclude<Rule, "card">, RegExp> = {
  // A corner of its own: `rounded-[20px]`, `rounded-t-(--x)`.
  corner: new RegExp(`^rounded${SIDE}-[[(]`),
  // A corner step the rules don't name. Controls are md, cards lg, menus and dialogs xl, round
  // things full; `none` squares a part off. Bare `rounded` is the sm step.
  cornerStep: new RegExp(`^rounded${SIDE}(?:-(?:xs|sm|2xl|3xl|4xl))?$`),
  // A shadow of its own: `shadow-[0_1px_2px_…]`, or a drop shadow written out.
  shadow: /^(?:drop-)?shadow-[[(]/,
  // A shadow step the rules don't name. xs is raised, lg floats, 2xl sits over the app.
  shadowStep: /^shadow(?:-(?:sm|md|xl|inner))?$/,
  // Text sized by hand: `text-[10px]`, `text-[0.8rem]`, with or without a line height after it.
  text: /^text-\[[\d.]+(?:px|rem|em)\](?:\/.+)?$/,
  // A color utility; `darkColor` counts it only under a `dark:` variant.
  darkColor:
    /^(?:bg|text|border(?:-[trblxyse])?|ring|ring-offset|outline|fill|stroke|divide|from|via|to|decoration|placeholder|caret|shadow|accent)-(?!(?:\d+|xs|sm|base|md|lg|xl|\d+xl|none|hidden|solid|dashed|dotted|double|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|clip|ellipsis|inset|x|y|t|r|b|l|s|e|offset-\d+)$)/,
};

/** The text of every string literal in a source file, comments skipped. */
function strings(source: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let text = "";
      let closed = false;
      while (j < source.length) {
        const d = source[j];
        if (d === "\\") {
          text += source.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (d === c) {
          closed = true;
          break;
        }
        // A quote that reaches the end of its line is an apostrophe in JSX text, not a string.
        if (d === "\n" && c !== "`") break;
        if (c === "`" && d === "$" && source[j + 1] === "{") {
          let depth = 1;
          j += 2;
          while (j < source.length && depth > 0) {
            if (source[j] === "{") depth++;
            else if (source[j] === "}") depth--;
            j++;
          }
          text += " ";
          continue;
        }
        text += d;
        j++;
      }
      if (closed) {
        found.push(text);
        i = j + 1;
      } else i++;
    } else i++;
  }
  return found;
}

/** A class split into its variants and the utility, `!` taken off. Brackets keep their colons. */
function parts(token: string): { variants: string[]; utility: string } {
  const pieces: string[] = [];
  let depth = 0;
  let current = "";
  for (const c of token) {
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    if (c === ":" && depth === 0) {
      pieces.push(current);
      current = "";
    } else current += c;
  }
  const utility = current.replace(/^!|!$/g, "");
  return { variants: pieces, utility };
}

/** Every class written in a source file's strings, variants and all, in order. */
export function classes(source: string): string[] {
  return strings(source).flatMap((text) => text.split(/\s+/).filter(Boolean));
}

/** Every class in a source file's strings that breaks a rule, by rule. */
export function offences(source: string): Record<Rule, string[]> {
  const result: Record<Rule, string[]> = {
    corner: [],
    cornerStep: [],
    shadow: [],
    shadowStep: [],
    text: [],
    darkColor: [],
    card: [],
  };
  for (const text of strings(source)) {
    const utilities: string[] = [];
    for (const token of text.split(/\s+/).filter(Boolean)) {
      const { variants, utility } = parts(token);
      utilities.push(utility);
      for (const rule of [
        "corner",
        "cornerStep",
        "shadow",
        "shadowStep",
        "text",
      ] as const) {
        if (RULES[rule].test(utility)) result[rule].push(utility);
      }
      if (variants.includes("dark") && RULES.darkColor.test(utility))
        result.darkColor.push(token);
    }
    // A bordered card drawn by hand: a corner, a border and the card's fill in one string.
    if (
      utilities.some((u) => u.startsWith("rounded")) &&
      utilities.some((u) => u === "border" || u === "border-border") &&
      utilities.includes("bg-card")
    )
      result.card.push(text.trim());
  }
  return result;
}
