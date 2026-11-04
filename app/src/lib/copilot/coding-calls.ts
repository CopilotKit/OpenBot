import { parse } from "shell-quote";
import { z } from "zod";

/**
 * Which calls in a conversation are Claude Code's own tools, read from the call itself.
 *
 * THE NAMES ARE GLOBAL. `CodingTools` registers `Bash`, `Read`, `Edit` and the rest by bare name
 * for every Bot, because nothing in the browser can say which harness a Bot runs: a Bot is an AG-UI
 * address, and the harness picked in the New Bot dialog only decorates the address step and is
 * never stored. So the call has to say it. A call under one of these names is drawn as Claude
 * Code's only when its arguments are Claude Code's, which are the fields the Agent SDK's
 * `sdk-tools.d.ts` marks required (`BashInput.command`, `FileEditInput.file_path`, `old_string`
 * and `new_string`, and so on). Another harness's tool that happens to share a name, with other
 * arguments, is drawn as any tool the app has no component for.
 *
 * A call whose arguments are still arriving is given the benefit of the doubt: its JSON does not
 * parse until the last of it lands, and Claude Code is the only harness that sends these names.
 */

const text = z.string();

/** What every call of each tool carries, from the Agent SDK's tool input types. */
const CLAUDE_CODE_ARGUMENTS = {
  Bash: z.object({ command: text }),
  Edit: z.object({ file_path: text, old_string: text, new_string: text }),
  // Gone from current Claude Code, kept for Bots on a version that still has it.
  MultiEdit: z.object({
    file_path: text,
    edits: z.array(z.object({ old_string: text, new_string: text })),
  }),
  Write: z.object({ file_path: text, content: text }),
  Read: z.object({ file_path: text }),
  Grep: z.object({ pattern: text }),
  Glob: z.object({ pattern: text }),
  TodoWrite: z.object({
    todos: z.array(z.object({ content: text, status: text })),
  }),
  TaskCreate: z.object({ subject: text }),
  TaskUpdate: z.object({ taskId: text }),
} as const;

export type CodingToolName = keyof typeof CLAUDE_CODE_ARGUMENTS;

function isCodingTool(name: string): name is CodingToolName {
  return Object.hasOwn(CLAUDE_CODE_ARGUMENTS, name);
}

/** The arguments as an object once all of them have arrived, or undefined while they stream. */
function settled(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return undefined;
  }
}

/**
 * Whether a call uses one of Claude Code's tool names with arguments Claude Code never sends. Such
 * a call is somebody else's tool and is drawn as one.
 */
export function foreignCodingCall(name: string, args: string): boolean {
  if (!isCodingTool(name)) return false;
  const given = settled(args);
  if (given === undefined) return false;
  return !CLAUDE_CODE_ARGUMENTS[name].safeParse(given).success;
}

/**
 * What a call that only looked at something did, in the words Claude Code counts them in: it read
 * files, searched for patterns, or listed directories.
 */
export type Look = "file" | "pattern" | "directory";

/**
 * The look a call is, or null when it changed something, ran something, or is not Claude Code's.
 *
 * Claude Code folds a run of these into one line ("Read 3 files, searched for 2 patterns"), and the
 * transcript does the same. Read, Grep and Glob are looks by name, so they fold while their
 * arguments arrive. A Bash command is a look only once the command can be read, and only when it is
 * one of the plain read, search and list commands Claude Code counts in that line.
 */
export function codingLook(name: string, args: string): Look | null {
  if (!isCodingTool(name)) return null;
  const given = settled(args);
  if (
    given !== undefined &&
    !CLAUDE_CODE_ARGUMENTS[name].safeParse(given).success
  )
    return null;
  if (name === "Read") return "file";
  if (name === "Grep" || name === "Glob") return "pattern";
  if (name !== "Bash" || given === undefined) return null;
  return commandLook((given as { command: string }).command);
}

const LOOK_PROGRAMS: Record<string, Look> = {
  cat: "file",
  head: "file",
  tail: "file",
  grep: "pattern",
  egrep: "pattern",
  fgrep: "pattern",
  rg: "pattern",
  find: "pattern",
  ls: "directory",
  tree: "directory",
  du: "directory",
};

/** What a later stage of a pipeline may be: filters that only shorten or count what they are given. */
const FILTERS = new Set([
  "head",
  "tail",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "sort",
]);

/** Arguments that make an otherwise read-only program run, delete or write something. */
const ACTS: Record<string, (argument: string) => boolean> = {
  find: (argument) =>
    /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(
      argument,
    ),
  rg: (argument) => argument === "--pre" || argument.startsWith("--pre="),
  // `-o` names a file to write the result to, alone or in a cluster of short options.
  sort: (argument) =>
    /^-[a-zA-Z]*o/.test(argument) || argument.startsWith("--output"),
  tree: (argument) => /^-[a-zA-Z]*o/.test(argument),
};

type Token = ReturnType<typeof parse>[number];

/** Whether a token is a plain word or a glob pattern, which a read-only command may take. */
function word(token: Token): string | undefined {
  if (typeof token === "string") return token;
  if ("op" in token && token.op === "glob") return token.pattern;
  return undefined;
}

/**
 * The look a shell command is, read conservatively. One pipeline of words, the first a program from
 * `LOOK_PROGRAMS` and the rest filters, with errors sent to /dev/null at most. Anything else, a `;`,
 * an `&&`, a redirect into a file, a substitution, a second line or a variable set in front, is a
 * command that may do more than look, and keeps its own card.
 */
export function commandLook(command: string): Look | null {
  if (/[\n\r`]|\$\(/.test(command)) return null;
  let tokens: Token[];
  try {
    tokens = parse(command);
  } catch {
    return null;
  }
  const stages: string[][] = [[]];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    // `2>/dev/null` and `2>&1`, which only quiet or merge what it prints.
    if (token === "2") {
      const [op, target] = [tokens[index + 1], tokens[index + 2]];
      if (
        op &&
        typeof op === "object" &&
        "op" in op &&
        ((op.op === ">" && target === "/dev/null") ||
          (op.op === ">&" && target === "1"))
      ) {
        index += 2;
        continue;
      }
    }
    if (typeof token === "object" && "op" in token && token.op === "|") {
      stages.push([]);
      continue;
    }
    if (typeof token === "object" && "comment" in token) continue;
    const value = word(token);
    if (value === undefined) return null;
    stages.at(-1)?.push(value);
  }
  const [first, ...rest] = stages;
  const program = first?.[0];
  if (!program || !Object.hasOwn(LOOK_PROGRAMS, program)) return null;
  for (const [name, ...args] of stages) {
    if (name === undefined) return null;
    const acts = ACTS[name];
    if (acts && args.some(acts)) return null;
  }
  if (rest.some((stage) => !FILTERS.has(stage[0] as string))) return null;
  return LOOK_PROGRAMS[program] ?? null;
}
