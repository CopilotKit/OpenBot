/**
 * A refusal the server sent about a key, made safe to put in front of a person.
 *
 * The server's sentence is the useful one and is shown as it stands. What it may carry is an app's
 * own error body: a key check that failed once quoted Fireflies' whole JSON reply into the banner. A
 * server that still does that, or an app whose reply the server could not read, must not put an
 * envelope on screen, so anything shaped like data is taken out. When what is left is not a sentence,
 * the screen's own words are used.
 */
export function readableRefusal(message: string, fallback: string): string {
  const text = message.trim();
  const start = text.search(/[{[]/);
  if (start === -1) return text || fallback;
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  const kept =
    `${text.slice(0, start)} ${end > start ? text.slice(end + 1) : ""}`
      .replace(/\s+/g, " ")
      .replace(/:\s*(?=[.\s]|$)/, ".")
      .trim();
  return /[{}[\]]/.test(kept) || kept.split(" ").length < 4 ? fallback : kept;
}
