/**
 * A coding harness Bot's tool calls, as `agent-claude-sdk/` sends them.
 *
 * RECORDED, not written: each `recorded` entry is one call from a real run of `OpenBotClaudeAgentAdapter`
 * (ag-ui-claude-sdk 0.1.5, claude-agent-sdk 0.2.152, which bundles Claude Code 2.1.259), copied out of
 * its AG-UI event stream. `arguments` is the call's streamed arguments joined, `live` the content of
 * its TOOL_CALL_RESULT, and `history` the same result in the MESSAGES_SNAPSHOT that ends the turn,
 * which is what a reloaded conversation draws. The two differ for a failure: the live result is
 * wrapped as `{"error": true, ...}`, the history keeps only Claude Code's own text.
 *
 * TodoWrite was recorded with `CLAUDE_CODE_ENABLE_TASKS=0`; without it Claude Code plans with
 * TaskCreate and TaskUpdate, recorded too.
 */
export type RecordedCall = {
  name: string;
  arguments: string;
  live: string;
  history: string;
};

export const recorded = {
  todoPlan: {
    name: "TodoWrite",
    arguments:
      '{"todos": [\n  {\n    "content": "Write greet.py module",\n    "activeForm": "Writing greet.py module",\n    "status": "in_progress"\n  },\n  {\n    "content": "Edit and modify greet.py",\n    "activeForm": "Editing and modifying greet.py",\n    "status": "pending"\n  },\n  {\n    "content": "Test greet.py using Grep and Glob tools",\n    "activeForm": "Testing greet.py using Grep and Glob tools",\n    "status": "pending"\n  },\n  {\n    "content": "Run greet.py and other bash commands",\n    "activeForm": "Running greet.py and other bash commands",\n    "status": "pending"\n  }\n]}',
    live: "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable",
    history:
      "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable",
  },
  todoProgress: {
    name: "TodoWrite",
    arguments:
      '{"todos": [{"content": "Write greet.py module", "activeForm": "Writing greet.py module", "status": "completed"}, {"content": "Edit and modify greet.py", "activeForm": "Editing and modifying greet.py", "status": "completed"}, {"content": "Test greet.py using Grep and Glob tools", "activeForm": "Testing greet.py using Grep and Glob tools", "status": "in_progress"}, {"content": "Run greet.py and other bash commands", "activeForm": "Running greet.py and other bash commands", "status": "pending"}]}',
    live: "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable",
    history:
      "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable",
  },
  write: {
    name: "Write",
    arguments:
      '{"file_path": "/private/tmp/claude-harness-run/work4/greet.py", "content": "#!/usr/bin/env python3\\n\\"\\"\\"\\nA simple greeting module.\\n\\nThis module provides functions for greeting and saying farewell to people.\\n\\"\\"\\"\\n\\n\\ndef greet(name):\\n    \\"\\"\\"\\n    Greet someone by name.\\n    \\n    Args:\\n        name: The name of the person to greet\\n        \\n    Returns:\\n        A greeting string\\n    \\"\\"\\"\\n    return f\\"Hello, {name}!\\"\\n\\n\\ndef farewell(name):\\n    \\"\\"\\"\\n    Say farewell to someone by name.\\n    \\n    Args:\\n        name: The name of the person to bid farewell\\n        \\n    Returns:\\n        A farewell string\\n    \\"\\"\\"\\n    return f\\"Goodbye, {name}!\\"\\n\\n\\nif __name__ == \\"__main__\\":\\n    name = \\"World\\"\\n    print(greet(name))\\n    print(farewell(name))\\n"}',
    live: "File created successfully at: /private/tmp/claude-harness-run/work4/greet.py (file state is current in your context — no need to Read it back)",
    history:
      "File created successfully at: /private/tmp/claude-harness-run/work4/greet.py (file state is current in your context — no need to Read it back)",
  },
  read: {
    name: "Read",
    arguments:
      '{"file_path": "/private/tmp/claude-harness-run/work4/greet.py"}',
    live: '1\t#!/usr/bin/env python3\n2\t"""\n3\tA simple greeting module.\n4\t\n5\tThis module provides functions for greeting and saying farewell to people.\n6\t"""\n7\t\n8\t\n9\tdef greet(name):\n10\t    """\n11\t    Greet someone by name.\n12\t\n13\t    Args:\n14\t        name: The name of the person to greet\n15\t\n16\t    Returns:\n17\t        A greeting string\n18\t    """\n19\t    return f"Hello, {name}!"\n20\t\n21\t\n22\tdef farewell(name):\n23\t    """\n24\t    Say farewell to someone by name.\n25\t\n26\t    Args:\n27\t        name: The name of the person to bid farewell\n28\t\n29\t    Returns:\n30\t        A farewell string\n31\t    """\n32\t    return f"Goodbye, {name}!"\n33\t\n34\t\n35\tif __name__ == "__main__":\n36\t    name = "World"\n37\t    print(greet(name))\n38\t    print(farewell(name))\n39\t',
    history:
      '1\t#!/usr/bin/env python3\n2\t"""\n3\tA simple greeting module.\n4\t\n5\tThis module provides functions for greeting and saying farewell to people.\n6\t"""\n7\t\n8\t\n9\tdef greet(name):\n10\t    """\n11\t    Greet someone by name.\n12\t\n13\t    Args:\n14\t        name: The name of the person to greet\n15\t\n16\t    Returns:\n17\t        A greeting string\n18\t    """\n19\t    return f"Hello, {name}!"\n20\t\n21\t\n22\tdef farewell(name):\n23\t    """\n24\t    Say farewell to someone by name.\n25\t\n26\t    Args:\n27\t        name: The name of the person to bid farewell\n28\t\n29\t    Returns:\n30\t        A farewell string\n31\t    """\n32\t    return f"Goodbye, {name}!"\n33\t\n34\t\n35\tif __name__ == "__main__":\n36\t    name = "World"\n37\t    print(greet(name))\n38\t    print(farewell(name))\n39\t',
  },
  edit: {
    name: "Edit",
    arguments:
      '{"file_path": "/private/tmp/claude-harness-run/work4/greet.py", "old_string": "    return f\\"Hello, {name}!\\"", "new_string": "    return f\\"Hi, {name}!\\""}',
    live: "The file /private/tmp/claude-harness-run/work4/greet.py has been updated successfully. (file state is current in your context — no need to Read it back)",
    history:
      "The file /private/tmp/claude-harness-run/work4/greet.py has been updated successfully. (file state is current in your context — no need to Read it back)",
  },
  run: {
    name: "Bash",
    arguments:
      '{"command": "python3 /private/tmp/claude-harness-run/work4/greet.py", "description": "Run the greet.py script"}',
    live: "Hi, World!\nBye, World!",
    history: "Hi, World!\nBye, World!",
  },
  longOutput: {
    name: "Bash",
    arguments:
      '{"command": "seq 1 40", "description": "Generate sequence from 1 to 40"}',
    live: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20\n21\n22\n23\n24\n25\n26\n27\n28\n29\n30\n31\n32\n33\n34\n35\n36\n37\n38\n39\n40",
    history:
      "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20\n21\n22\n23\n24\n25\n26\n27\n28\n29\n30\n31\n32\n33\n34\n35\n36\n37\n38\n39\n40",
  },
  failedCommand: {
    name: "Bash",
    arguments:
      '{"command": "ls /definitely/not/here", "description": "List non-existent directory"}',
    live: '{"error": true, "content": "Exit code 1\\nls: /definitely/not/here: No such file or directory"}',
    history: "Exit code 1\nls: /definitely/not/here: No such file or directory",
  },
  refusedEdit: {
    name: "Edit",
    arguments:
      '{"file_path": "/private/tmp/claude-harness-run/work6/greet.py", "old_string": "THIS TEXT DOES NOT EXIST", "new_string": "x"}',
    live: '{"error": true, "content": "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>"}',
    history:
      "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>",
  },
  taskCreate: {
    name: "TaskCreate",
    arguments:
      '{"subject": "Create greet.py module", "description": "Write a 30-line Python module with greet() and farewell() functions and a __main__ block"}',
    live: "Task #1 created successfully: Create greet.py module",
    history: "Task #1 created successfully: Create greet.py module",
  },
  taskStart: {
    name: "TaskUpdate",
    arguments: '{"taskId": "1", "status": "in_progress"}',
    live: "Updated task #1 status",
    history: "Updated task #1 status",
  },
  taskFinish: {
    name: "TaskUpdate",
    arguments: '{"taskId": "1", "status": "completed"}',
    live: "Updated task #1 status",
    history: "Updated task #1 status",
  },
} satisfies Record<string, RecordedCall>;

/**
 * Grep, Glob and MultiEdit, which that build of Claude Code does not offer (its native macOS and
 * Linux builds search through Bash), so nothing could record them. Arguments follow the Agent SDK's
 * `GrepInput`, `GlobInput` and MultiEdit's `edits`; results follow the text Claude Code writes for
 * them.
 */
export const documented = {
  grepFiles: {
    name: "Grep",
    arguments: JSON.stringify({ pattern: "def ", path: "/workspace" }),
    result:
      "Found 2 files\n/workspace/greet.py\n/workspace/tests/test_greet.py",
  },
  grepContent: {
    name: "Grep",
    arguments: JSON.stringify({
      pattern: "def ",
      path: "/workspace/greet.py",
      output_mode: "content",
      "-n": true,
    }),
    result: "9:def greet(name):\n22:def farewell(name):",
  },
  grepNone: {
    name: "Grep",
    arguments: JSON.stringify({ pattern: "class ", output_mode: "content" }),
    result: "No matches found",
  },
  glob: {
    name: "Glob",
    arguments: JSON.stringify({ pattern: "**/*.py" }),
    result: "/workspace/greet.py\n/workspace/tests/test_greet.py",
  },
  multiEdit: {
    name: "MultiEdit",
    arguments: JSON.stringify({
      file_path: "/workspace/greet.py",
      edits: [
        {
          old_string: '    return f"Hi, {name}!"',
          new_string: '    return f"Hello there, {name}!"',
        },
        {
          old_string: '    return f"Bye, {name}!"',
          new_string: '    return f"Goodbye, {name}. See you soon!"',
        },
      ],
    }),
    result: "Applied 2 edits to /workspace/greet.py",
  },
};

/**
 * Calls the recorded run did not make, built from the harness's own code and the Agent SDK's types:
 * an edit with `replace_all` (`FileEditInput.replace_all`), and a command whose output is a JSON
 * object with an `error` field, as `ag-ui-claude-sdk` 0.1.5's `_normalize_text` passes it on.
 */
export const constructed = {
  apiError: {
    name: "Bash",
    arguments: JSON.stringify({
      command: "curl -s https://api.example.com/v1/orders",
      description: "Fetch the orders",
    }),
    // What the harness sends when a command prints that: it parses JSON text and sends it on
    // re-serialised with Python's `json.dumps`.
    result: '{"error": true, "message": "rate limited"}',
  },
  replaceAll: {
    name: "Edit",
    arguments: JSON.stringify({
      file_path: "/workspace/greet.py",
      old_string: "name",
      new_string: "person",
      replace_all: true,
    }),
    // The card does not read the answer to an edit, only whether it failed.
    result:
      "The file /workspace/greet.py has been updated successfully. (file state is current in your context — no need to Read it back)",
  },
};
