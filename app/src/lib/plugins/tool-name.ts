/**
 * A tool call, named the way the person watching would name it.
 *
 * The model is offered `mcp__notes__search_notes`, because a tool name has to be unique across every
 * server a Bot holds and has to survive two vendors both calling something `search`. None of that is
 * the reader's problem, and putting it on screen tells them how the thing is built rather than what
 * their Bot just did.
 *
 * Anything that is not a prefixed MCP name is left exactly as it is: a component the app registered
 * already has a name somebody chose.
 */
export type ToolName = {
  /** What was done, for the line itself. */
  label: string;
  /** Which server it was done against, muted beside the label. Absent for anything not MCP. */
  detail?: string;
};

export function readToolName(name: string): ToolName {
  const parts = name.split("__");
  if (parts.length < 3 || parts[0] !== "mcp") return { label: name };

  const [, server, ...rest] = parts;
  const tool = rest.join("__");
  const label = humanise(tool);

  /*
   * The server is dropped when the action already says it. Vendors name a tool after the thing it
   * acts on, so `mcp__notes__search_notes` would otherwise read "Search notes notes" and
   * `mcp__routines__create_routine` "Create routine routines", both of which look like a bug rather
   * than a label. Compared a word at a time and singularised, so the plural spelling of the server
   * still matches the singular in the label.
   */
  const named = label
    .toLowerCase()
    .split(" ")
    .map(singular)
    .includes(singular((server ?? "").toLowerCase()));
  return named ? { label } : { label, detail: server };
}

/**
 * `routines` and `routine` are the same word for this purpose.
 *
 * A vendor names the server for the collection and the tool for the one item —
 * `mcp__routines__create_routine` — so the exact-substring test that stops "Search notes notes" lets
 * "Create routine routines" straight through, and it reads as a typo rather than as a label.
 *
 * Dropping one trailing `s` from each side before comparing is the whole of the difference between
 * those two cases. This is not a stemmer and must not grow into one: the only thing it has to catch
 * is one vendor writing the same noun twice, once plural and once not.
 */
function singular(word: string): string {
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

/**
 * `search_notes` as "Search notes".
 *
 * Vendors write tool names in snake_case, camelCase or a mixture, and the only thing they agree on
 * is that the first word is a verb. Splitting on both and sentence-casing the result gets a phrase
 * that reads as an action without anybody maintaining a table of names.
 */
function humanise(tool: string): string {
  const words = tool
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  if (words.length === 0) return tool;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
