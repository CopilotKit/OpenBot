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
