import { useRenderTool } from "@copilotkit/react-core/v2";
import { useContext } from "react";
import { z } from "zod";
import {
  CommandCard,
  codingOutcome,
  DiffCard,
  GlobLine,
  GrepLine,
  ReadLine,
  TaskLine,
  TodoCard,
} from "@/components/channels/coding-tool-cards";
import { ArgumentsArrivingContext } from "@/components/gallery/streaming";

/**
 * How a coding harness Bot's own tools read in the transcript.
 *
 * RENDER ONLY. These are Claude Code's built-in tools, run inside the Claude Agent SDK harness
 * (`agent-claude-sdk/`) on the Bot's own machine; OpenBot never runs them and offers none of them to
 * a model. `ag-ui-claude-sdk` streams each call under Claude Code's own name (`Bash`, `Edit`), with
 * Claude Code's arguments, and its result is the text Claude Code gave the model. Without these they
 * fold into the generic "Used 6 tools" line, and a Bot that wrote and ran code shows none of it.
 * Reads and searches still fold, into Claude Code's own "Read 3 files and searched for 2 patterns"
 * line; see `groupToolSteps`.
 *
 * REGISTERED BY BARE NAME, FOR EVERY BOT. The browser cannot tell which harness a Bot runs, so a call
 * is drawn here only when it carries Claude Code's arguments; another harness's `Bash` with other
 * arguments is drawn as any other tool. See `coding-calls.ts`.
 *
 * The names are Claude Code's, across its versions. MultiEdit has gone from current ones, Grep and
 * Glob are absent from its native macOS and Linux builds, which search through Bash instead, and its
 * task tools replace TodoWrite unless the harness sets `CLAUDE_CODE_ENABLE_TASKS=0`. Every one of
 * them is drawn, so a Bot is legible whichever it gets.
 */

const optionalText = z.string().optional();

const command = z.object({ command: optionalText, description: optionalText });
const edit = z.object({
  file_path: optionalText,
  old_string: optionalText,
  new_string: optionalText,
  replace_all: z.boolean().optional(),
});
const multiEdit = z.object({
  file_path: optionalText,
  edits: z
    .array(z.object({ old_string: optionalText, new_string: optionalText }))
    .optional(),
});
const write = z.object({ file_path: optionalText, content: optionalText });
const read = z.object({
  file_path: optionalText,
  offset: z.number().optional(),
  limit: z.number().optional(),
});
const grep = z.object({
  pattern: optionalText,
  path: optionalText,
  output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
});
const glob = z.object({ pattern: optionalText, path: optionalText });
const todoWrite = z.object({
  todos: z
    .array(
      z.object({
        content: optionalText,
        status: z.enum(["pending", "in_progress", "completed"]).optional(),
        activeForm: optionalText,
      }),
    )
    .optional(),
});
const taskCreate = z.object({ subject: optionalText });
const taskUpdate = z.object({
  taskId: optionalText,
  status: optionalText,
  subject: optionalText,
});

/** Running only while its turn is: a call left without a result by a stopped turn has stopped. */
function useOutcome(result: string | undefined) {
  return codingOutcome(result, useContext(ArgumentsArrivingContext));
}

function Command({ command, result }: { command?: string; result?: string }) {
  return <CommandCard command={command} outcome={useOutcome(result)} />;
}

function Diff({
  kind,
  path,
  changes,
  replaceAll,
  result,
}: {
  kind: "edit" | "write";
  path?: string;
  changes: { before: string; after: string }[];
  replaceAll?: boolean;
  result?: string;
}) {
  return (
    <DiffCard
      changes={changes}
      kind={kind}
      outcome={useOutcome(result)}
      path={path}
      replaceAll={replaceAll}
    />
  );
}

function Read({ path, result }: { path?: string; result?: string }) {
  return <ReadLine outcome={useOutcome(result)} path={path} />;
}

function Grep({
  args,
  result,
}: {
  args: z.infer<typeof grep> | undefined;
  result?: string;
}) {
  return (
    <GrepLine
      mode={args?.output_mode}
      outcome={useOutcome(result)}
      path={args?.path}
      pattern={args?.pattern}
    />
  );
}

function Glob({ pattern, result }: { pattern?: string; result?: string }) {
  return <GlobLine outcome={useOutcome(result)} pattern={pattern} />;
}

function Task({
  label,
  doing,
  subject,
  result,
}: {
  label: string;
  doing: string;
  subject?: string;
  result?: string;
}) {
  return (
    <TaskLine
      doing={doing}
      label={label}
      outcome={useOutcome(result)}
      subject={subject}
    />
  );
}

/** What a task update did, said the way a person would. */
function taskUpdateLabel(
  taskId: string | undefined,
  status: string | undefined,
) {
  const task = taskId ? `task ${taskId}` : "a task";
  if (status === "completed") return `Finished ${task}`;
  if (status === "in_progress") return `Started ${task}`;
  if (status === "deleted") return `Removed ${task}`;
  if (status === "pending") return `Reopened ${task}`;
  return `Updated ${task}`;
}

export function CodingTools() {
  useRenderTool({
    name: "Bash",
    parameters: command,
    render: ({ parameters: given, result }) => (
      <Command command={given?.command} result={result} />
    ),
  });

  useRenderTool({
    name: "Edit",
    parameters: edit,
    render: ({ parameters: given, result }) => (
      <Diff
        changes={[
          { before: given?.old_string ?? "", after: given?.new_string ?? "" },
        ]}
        kind="edit"
        path={given?.file_path}
        replaceAll={given?.replace_all === true}
        result={result}
      />
    ),
  });

  useRenderTool({
    name: "MultiEdit",
    parameters: multiEdit,
    render: ({ parameters: given, result }) => (
      <Diff
        changes={(given?.edits ?? []).map((change) => ({
          before: change?.old_string ?? "",
          after: change?.new_string ?? "",
        }))}
        kind="edit"
        path={given?.file_path}
        result={result}
      />
    ),
  });

  useRenderTool({
    name: "Write",
    parameters: write,
    render: ({ parameters: given, result }) => (
      <Diff
        changes={[{ before: "", after: given?.content ?? "" }]}
        kind="write"
        path={given?.file_path}
        result={result}
      />
    ),
  });

  useRenderTool({
    name: "Read",
    parameters: read,
    render: ({ parameters: given, result }) => (
      <Read path={given?.file_path} result={result} />
    ),
  });

  useRenderTool({
    name: "Grep",
    parameters: grep,
    render: ({ parameters: given, result }) => (
      <Grep args={given} result={result} />
    ),
  });

  useRenderTool({
    name: "Glob",
    parameters: glob,
    render: ({ parameters: given, result }) => (
      <Glob pattern={given?.pattern} result={result} />
    ),
  });

  useRenderTool({
    name: "TodoWrite",
    parameters: todoWrite,
    render: ({ parameters: given }) => <TodoCard todos={given?.todos ?? []} />,
  });

  useRenderTool({
    name: "TaskCreate",
    parameters: taskCreate,
    render: ({ parameters: given, result }) => (
      <Task
        doing="Adding a task"
        label="Added a task"
        result={result}
        subject={given?.subject}
      />
    ),
  });

  useRenderTool({
    name: "TaskUpdate",
    parameters: taskUpdate,
    render: ({ parameters: given, result }) => (
      <Task
        doing="Updating a task"
        label={taskUpdateLabel(given?.taskId, given?.status)}
        result={result}
        subject={given?.subject}
      />
    ),
  });

  return null;
}
