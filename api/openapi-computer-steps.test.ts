import { expect, test } from "bun:test";
import { RunComputerStepResponse } from "../app/src/lib/api/generated/approvals/approvals.zod";
import {
  ClickComputerBody,
  ListComputerFilesBody,
  NavigateComputerBody,
  PressComputerKeyBody,
  ReadComputerFileBody,
  ReadComputerPageQueryParams,
  RequestComputerControlBody,
  RequestComputerSecretBody,
  RunComputerCommandBody,
  ScrollComputerBody,
  SnapshotComputerBody,
  TypeComputerBody,
  WriteComputerFileBody,
} from "../app/src/lib/api/generated/computers/computers.zod";

/**
 * A Bot's computer step runs once, however many times and from wherever it is asked. The server
 * claims each step by its conversation's thread and its tool call, so every way a client asks for
 * one can name both, and a step the server already ran, or is running, comes back as `taken`
 * instead of running a second time. Checked through the schemas generated from the spec, strict as
 * the server reads a request body.
 */

const THREAD = "5f0d6c0e-2f1a-4a53-9d51-6f3d6b1f6f10";
const CALL = "call_8c1f";

test("a step already run, or running, comes back as taken, with the first run's result once it has one", () => {
  const finished = RunComputerStepResponse.safeParse({
    outcome: "taken",
    threadId: THREAD,
    toolCallId: CALL,
    running: false,
    result: { ok: true, stdout: "done\n" },
  });
  expect(finished.success).toBe(true);
  const running = RunComputerStepResponse.safeParse({
    outcome: "taken",
    threadId: THREAD,
    toolCallId: CALL,
    running: true,
  });
  expect(running.success).toBe(true);
  // It always names the step it answers, and whether the first run is still going.
  expect(
    RunComputerStepResponse.safeParse({ outcome: "taken", running: false })
      .success,
  ).toBe(false);
  expect(
    RunComputerStepResponse.safeParse({
      outcome: "taken",
      threadId: THREAD,
      toolCallId: CALL,
    }).success,
  ).toBe(false);
});

// Each direct call a page makes for a Bot's tool call, with the fields it already sends.
const DIRECT_CALLS = [
  ["snapshot", SnapshotComputerBody, {}],
  ["navigate", NavigateComputerBody, { url: "https://example.com" }],
  ["click", ClickComputerBody, { ref: "e12", snapshotId: 4 }],
  ["type", TypeComputerBody, { ref: "e7", snapshotId: 4, text: "report" }],
  ["key", PressComputerKeyBody, { key: "Enter" }],
  ["scroll", ScrollComputerBody, { deltaY: 600 }],
  ["exec", RunComputerCommandBody, { command: "ls -la" }],
  ["files/list", ListComputerFilesBody, { path: "reports" }],
  ["files/read", ReadComputerFileBody, { path: "reports/q3.md" }],
  ["files/write", WriteComputerFileBody, { path: "q3.md", contents: "# Q3" }],
  ["control/request", RequestComputerControlBody, { reason: "Sign in" }],
  ["control/secret", RequestComputerSecretBody, { ref: "e12", snapshotId: 4 }],
] as const;

test("every direct computer call can name its thread and tool call, and none has to", () => {
  for (const [name, body, fields] of DIRECT_CALLS) {
    const strict = body.strict();
    expect({ name, without: strict.safeParse(fields).success }).toEqual({
      name,
      without: true,
    });
    expect({
      name,
      with: strict.safeParse({ ...fields, threadId: THREAD, toolCallId: CALL })
        .success,
    }).toEqual({ name, with: true });
    expect({
      name,
      empty: strict.safeParse({ ...fields, threadId: "", toolCallId: CALL })
        .success,
    }).toEqual({ name, empty: false });
  }
  // Reading the page is a GET, so it names them in its query.
  expect(
    ReadComputerPageQueryParams.strict().safeParse({
      threadId: THREAD,
      toolCallId: CALL,
    }).success,
  ).toBe(true);
  expect(ReadComputerPageQueryParams.strict().safeParse({}).success).toBe(true);
});
