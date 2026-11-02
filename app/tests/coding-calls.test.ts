import { expect, test } from "bun:test";
import { foreignCodingCall } from "@/lib/copilot/coding-calls";
import { recorded } from "./coding-tools.fixture";

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
