import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * No page draws an error's own words straight into the page, or keeps only the words to draw later.
 *
 * A failure said in the error's own words (`{save.error.message}`) is drawn in the red the app keeps
 * for what failed. While OpenBot moves an organization, or its database is out of reach, the server
 * answers 503 with a sentence for people and Retry-After: that is not a failure, and the sentence is
 * to be drawn calm. Memory drew it in red because it drew `memories.error.message` itself (found by
 * the end-to-end test of database sharding). `failureSaid(error)` (lib/load-failure.tsx) draws the
 * same words for a real failure and the server's sentence calmly for a hold, so every place draws an
 * error's words through it, and this test finds any that doesn't.
 *
 * A press that failed did the same a step earlier: it kept `error.message` in its state
 * (`setFailure(error.message)`) and drew that string red, so the hold was lost before anything was
 * drawn (exporting the audit log, adding someone to a team, creating a Bot). A press keeps the error
 * itself (`failureOf`, `failureInstead`), and a toast takes its type from it (`failureToastType`).
 *
 * What it finds:
 * - a `.message` as the whole of a JSX child (`{x.error.message}`, `{failure?.message}`,
 *   `{(save.error ?? remove.error)?.message}`), or as the start or end of an `||`/`??` choice in one;
 * - an error's `.message` handed to a state setter (`setError(thrown.message)`,
 *   `setError(error instanceof Error ? error.message : "…")`) or to a prop named for an error
 *   (`error={save.error?.message}`);
 * - a toast that says an error's `.message` as an error without asking `failureToastType`;
 * - a press's error answered with the screen's own words in red, the error never asked
 *   (`{save.error ? (<p className="text-destructive">Couldn't save it.</p>)`), where
 *   `loadFailure(save.error, "Couldn't save it.")` says the same words and draws a hold calmly.
 */
const SRC = join(import.meta.dir, "..", "src");

/** The primitives draw what they are given (a form's field errors), not a server's answer. */
const OUTSIDE = [
  join(SRC, "components", "ui"),
  join(SRC, "lib", "api", "generated"),
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return OUTSIDE.includes(path) ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

/** `x.message`, `x.error?.message`, `(a.error ?? b.error)?.message`. */
const MESSAGE = String.raw`(?:[A-Za-z_$][\w$.?]*|\([^(){}]*\))\??\.message`;
/** `{ x.error.message }`, `{failure?.message || ...`, `... ?? x.error.message}` as a JSX child. */
const DRAWN = new RegExp(
  String.raw`>\s*\{\s*${MESSAGE}\s*(\}|\|\||\?\?)|(\|\||\?\?)\s*${MESSAGE}\s*\}\s*<|^\s*\{\s*${MESSAGE}\s*(\}|\|\||\?\?)`,
  "m",
);
/** `error={x.error?.message}`, `submissionError={failure?.message ?? null}`. */
const PROP = new RegExp(String.raw`\b\w*[eE]rror=\{\s*${MESSAGE}`);

/** A zod issue's words are the form's own, not a server's answer. */
const ISSUE = /issues\[\d+\]\??\.message|\bissue\.message/g;
/** An error's words as what a call keeps: the thrown thing's `.message`, alone or chosen. */
const KEPT_MESSAGE =
  /^\s*(?:\(\s*)?[A-Za-z_$][\w$]*(?:\s+as\s+\w+\s*\))?\??\.message\b|^\s*[A-Za-z_$][\w$]*\s+instanceof\s+\w+(?:\s*&&\s*[\w$.]+)?\s*\?\s*[A-Za-z_$][\w$]*\.message\b/;

/** Each call of `callee` in `text`, with the line it starts on and what it is called with. */
function calls(
  text: string,
  callee: RegExp,
): { line: number; argument: string }[] {
  const found: { line: number; argument: string }[] = [];
  for (const match of text.matchAll(callee)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    let end = open;
    for (; end < text.length; end++) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")" && --depth === 0) break;
    }
    found.push({
      line: text.slice(0, match.index).split("\n").length,
      argument: text.slice(open + 1, end),
    });
  }
  return found;
}

/**
 * `{save.error ? (<p className="text-destructive …">Couldn't save it. Try again.</p>)`: a press that
 * failed, said in the screen's own sentence in red, with the error never asked. Saving a credential,
 * the AI connection's dialog and the usage-data switch said a move this way, in red.
 * `loadFailure(save.error, "Couldn't save it. Try again.")` says the same sentence for a failure.
 */
const OWN_WORDS_IN_RED =
  /\{\s*[\w$.?]*\.error\??\s*(?:\?|&&)\s*\(\s*<(\w+)\b[^>]*?text-destructive[^>]*>\s*[^\s<{][^<{]*<\/\1>/g;

/** Every place in `text` that draws or keeps an error's words around the shared rule. */
function bypasses(text: string): number[] {
  const lines: number[] = [];
  text.split("\n").forEach((line, index) => {
    if (DRAWN.test(line) || PROP.test(line)) lines.push(index + 1);
  });
  for (const match of text.matchAll(OWN_WORDS_IN_RED))
    lines.push(text.slice(0, match.index).split("\n").length);
  // A state setter, or a callback that hands a failure on to one (`report`, `onError`).
  for (const { line, argument } of calls(
    text,
    /\b(?:set[A-Z]\w*|report|onError)\(/g,
  ))
    if (KEPT_MESSAGE.test(argument.replace(ISSUE, ""))) lines.push(line);
  for (const { line, argument } of calls(text, /\btoast\.add\(/g))
    if (
      /\.message\b/.test(argument) &&
      /type:\s*"error"/.test(argument) &&
      !argument.includes("failureToastType")
    )
      lines.push(line);
  return [...new Set(lines)].sort((a, b) => a - b);
}

describe("an error's own words", () => {
  test("are drawn through failureSaid on every page, and kept whole until then", () => {
    const raw: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (const line of bypasses(text))
        raw.push(`${relative(SRC, file)}:${line}: ${lines[line - 1]?.trim()}`);
    }
    expect(raw).toEqual([]);
  });

  test("the scan finds the shapes it is meant to", () => {
    for (const text of [
      "          {memories.error.message}",
      "          {review.error?.message}",
      '          {bots.error?.message || "Couldn\'t load your Bots."}',
      "<p>{delivery.error.message}</p>",
      "          {failure.message}",
      "              {(save.error ?? remove.error)?.message}",
      "              error={signOut.error?.message}",
      "      onError: (thrown: Error) => setProblem(thrown.message),",
      "      setError((thrown as Error).message);",
      "      report(thrown.message);",
      "    onError: (error) => onError(error.message),",
      '      setFailure(\n        error instanceof Error\n          ? error.message\n          : "Couldn\'t add them. Try again in a moment.",\n      );',
      "      setUnreachable(\n          error instanceof Error && error.message\n            ? error.message\n            : MASTRA_UNREACHABLE,\n        );",
      '          toast.add({\n            id: SWITCH_TOAST,\n            title: error.message,\n            type: "error",\n          }),',
      '        {createCredential.error ? (\n          <p className="mt-5 text-destructive text-sm" role="alert">\n            Couldn\'t save the credential. Try again.\n          </p>\n        ) : null}',
      '        {open.error && (\n          <ItemDescription\n            className="line-clamp-none text-destructive"\n            role="alert"\n          >\n            Couldn\'t open the log folder.\n          </ItemDescription>\n        )}',
    ])
      expect({ text, found: bypasses(text).length > 0 }).toEqual({
        text,
        found: true,
      });
    for (const text of [
      "          {failureSaid(memories.error)}",
      "    error: error ? error.message : null,",
      "  return error instanceof Error ? error.message : String(error);",
      "      setNameError(parsed.error.issues[0]?.message);",
      '      setExportError(failureOf(error, "Couldn\'t export these events. Try again."));',
      "      setError(GROUP_TAKES_NO_FILES);",
      "          toast.add({\n            title: error.message,\n            type: failureToastType(error),\n          }),",
      '        {createCredential.error ? (\n          <p className="mt-5 text-destructive text-sm" role="alert">\n            {loadFailure(\n              createCredential.error,\n              "Couldn\'t save the credential. Try again.",\n            )}\n          </p>\n        ) : null}',
      '        {copy.error ? (\n          <p className="text-muted-foreground text-sm">Couldn\'t copy it.</p>\n        ) : null}',
    ])
      expect({ text, found: bypasses(text).length > 0 }).toEqual({
        text,
        found: false,
      });
  });
});
