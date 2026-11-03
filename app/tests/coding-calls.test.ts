import { expect, test } from "bun:test";
import {
  codingLook,
  commandLook,
  foreignCodingCall,
} from "@/lib/copilot/coding-calls";
import { recorded } from "./coding-tools.fixture";

/**
 * Which shell commands fold into a run of reads and searches. Folding hides a command behind a
 * summary that says it only looked, so anything that could change something must keep its own card.
 */

test.each([
  // What Claude Code runs to look around, and what it counts each as.
  ["ls -la /workspace", "directory"],
  ["ls *.py", "directory"],
  ["tree -L 2", "directory"],
  ["cat greet.py", "file"],
  ["head -n 40 greet.py", "file"],
  ["cat greet.py | sort -r", "file"],
  ['grep -rn "def |class " src | head -20', "pattern"],
  ["grep -o 'def [a-z]*' greet.py", "pattern"],
  ["grep -rn TODO . 2>/dev/null", "pattern"],
  ["grep -rn TODO . 2>&1 | head", "pattern"],
  ["rg TODO", "pattern"],
  ["find . -name '*.py' -not -path './node_modules/*'", "pattern"],
  ["find . -name a -o -name b", "pattern"],
] as const)("%s looks at %s", (command, look) => {
  expect(commandLook(command)).toBe(look);
});

test.each([
  // Runs or changes something, or might.
  "python3 greet.py",
  "seq 1 40",
  "find . -name '*.pyc' -delete",
  "find . -name '*.py' -exec rm {} +",
  "ls /x && rm -rf /x",
  "head -n 5 file.txt; rm file.txt",
  "cat a > b",
  "cat a | xargs rm",
  "cat a | sort -o b",
  "cat a | sort -ro b",
  "tree -o listing.txt",
  "rg --pre ./decode TODO",
  "echo $(rm x)",
  "cat `rm x`",
  "FOO=1 ls",
  "ls\nrm x",
  "cat <<EOF\nhi\nEOF",
  "ls |",
])("%s keeps its own card", (command) => {
  expect(commandLook(command)).toBeNull();
});

test("a recorded listing is a look once its command has arrived, and not before", () => {
  const { name, arguments: args } = recorded.failedCommand;
  expect(codingLook(name, args)).toBe("directory");
  expect(codingLook(name, args.slice(0, 20))).toBeNull();
  // Read, Grep and Glob are looks by name, while their arguments arrive too.
  expect(codingLook("Read", '{"file_pa')).toBe("file");
  expect(codingLook(recorded.edit.name, recorded.edit.arguments)).toBeNull();
});

test("Claude Code's names with Claude Code's arguments are its tools, and with others are not", () => {
  for (const call of Object.values(recorded))
    expect(foreignCodingCall(call.name, call.arguments)).toBe(false);
  expect(foreignCodingCall("Bash", '{"cmd": "ls"}')).toBe(true);
  expect(foreignCodingCall("Edit", '{"path": "a", "patch": "b"}')).toBe(true);
  // Still arriving: not judged yet.
  expect(foreignCodingCall("Bash", '{"cm')).toBe(false);
  // Not one of Claude Code's names at all.
  expect(foreignCodingCall("run_command", '{"cmd": "ls"}')).toBe(false);
});
