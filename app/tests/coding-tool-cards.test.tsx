import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { CodingTools } from "@/lib/copilot/coding-tools";
import { queryClient } from "@/query-client";
import {
  constructed,
  documented,
  type RecordedCall,
  recorded,
} from "./coding-tools.fixture";
import { settleReactWork } from "./settle-react-work";

/**
 * A coding harness Bot's own tools, drawn by the real transcript through the renderers the app
 * registers, from calls recorded off the real harness (see the fixture). Each call is drawn as the
 * turn streams it (`live`) and as a reloaded conversation has it (`history`), because the two carry
 * a failure differently.
 */

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // Nothing here needs the server; a waiting approval asked about is simply not found.
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

type Call = { name: string; arguments: string };

/** A turn of calls, each answered with `results[i]`, or still running where that is undefined. */
function turn(calls: Call[], results: (string | undefined)[]): Message[] {
  return [
    { id: "u1", role: "user", content: "Build greet.py and run it." },
    ...calls.flatMap((call, index): Message[] => {
      const id = `call-${index}`;
      const result = results[index];
      return [
        {
          id: `a-${index}`,
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            },
          ],
        },
        ...(result === undefined
          ? []
          : [
              {
                id: `t-${index}`,
                role: "tool" as const,
                toolCallId: id,
                content: result,
              },
            ]),
      ];
    }),
  ];
}

function draw(messages: Message[], busy = false) {
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <CodingTools />
        <ChatTranscript busy={busy} messages={messages} restoring={false} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

/** The one card a call drew, found by what it says it did. */
async function card(view: ReturnType<typeof draw>, label: string) {
  return within(await view.findByRole("region", { name: label }));
}

/** The coding cards drawn, by what each says it did. Other regions on the page are left out. */
function cards(view: ReturnType<typeof draw>): (string | null)[] {
  return view
    .queryAllByRole("region")
    .map((region) => region.getAttribute("aria-label"))
    .filter((label) =>
      /^(Ran a command|Edited a file|Wrote a file)$/.test(label ?? ""),
    );
}

/** What a reader is told by each element matching `selector`: decoration hidden from a screen reader is left out. */
function readableLines(root: HTMLElement, selector: string): (string | null)[] {
  return Array.from(root.querySelectorAll(selector), (element) => {
    const read = element.cloneNode(true) as HTMLElement;
    for (const hidden of read.querySelectorAll("[aria-hidden]"))
      hidden.remove();
    return read.textContent;
  });
}

/** The lines a command card is showing, exactly as drawn. */
function shownLines(view: ReturnType<typeof draw>): string[] {
  return (view.container.querySelector("section pre")?.textContent ?? "").split(
    "\n",
  );
}

const live = (call: RecordedCall) => draw(turn([call], [call.live]));
const reloaded = (call: RecordedCall) => draw(turn([call], [call.history]));

test("a command shows what it ran and what it printed", async () => {
  const view = live(recorded.run);
  const command = await card(view, "Ran a command");
  expect(
    command.getByText("python3 /private/tmp/claude-harness-run/work4/greet.py"),
  );
  expect(command.getByText(/Hi, World!\s+Bye, World!/)).toBeTruthy();
  // Done says nothing beside the command: the output is the answer.
  expect(command.queryByText("Running")).toBeNull();
  expect(command.queryByText(/Exit code/)).toBeNull();
});

test("a command still running says so, and one its turn left behind says it never finished", async () => {
  const running = draw(turn([recorded.run], [undefined]), true);
  expect(
    (await card(running, "Ran a command")).getByText("Running"),
  ).toBeTruthy();
  cleanup();

  const stopped = draw(turn([recorded.run], [undefined]), false);
  const command = await card(stopped, "Ran a command");
  expect(command.getByText("Not completed")).toBeTruthy();
  expect(command.queryByText("Running")).toBeNull();
});

test("long output shows its first lines and opens to the rest", async () => {
  const view = live(recorded.longOutput);
  const command = await card(view, "Ran a command");
  expect(shownLines(view)).toEqual(["1", "2", "3", "4", "5", "6"]);

  fireEvent.click(command.getByRole("button", { name: "Show 34 more lines" }));
  expect(shownLines(view)).toHaveLength(40);
  expect(shownLines(view).at(-1)).toBe("40");

  fireEvent.click(command.getByRole("button", { name: "Show less" }));
  expect(shownLines(view)).toHaveLength(6);
});

test("a failed command shows its exit code, live and after a reload", async () => {
  for (const draw of [live, reloaded]) {
    const view = draw(recorded.failedCommand);
    const command = await card(view, "Ran a command");
    expect(command.getByText("Exit code 1")).toBeTruthy();
    expect(
      command.getByText("ls: /definitely/not/here: No such file or directory"),
    ).toBeTruthy();
    cleanup();
  }
});

test("a command that printed JSON with an error field still worked", async () => {
  const view = draw(
    turn([constructed.apiError], [constructed.apiError.result]),
  );
  const command = await card(view, "Ran a command");
  expect(command.queryByText("Didn't work")).toBeNull();
  expect(command.queryByText(/Exit code/)).toBeNull();
  expect(
    command.getByText('{"error": true, "message": "rate limited"}'),
  ).toBeTruthy();
});

test("an edit is a diff of what it replaced, in red, and what it put in, in green", async () => {
  const view = live(recorded.edit);
  const edit = await card(view, "Edited a file");
  expect(edit.getByText("greet.py").getAttribute("title")).toBe(
    "/private/tmp/claude-harness-run/work4/greet.py",
  );
  expect(edit.getByText("+1")).toBeTruthy();
  expect(edit.getByText("−1")).toBeTruthy();
  const removed = edit.getByText("Removed:").parentElement;
  const added = edit.getByText("Added:").parentElement;
  expect(removed?.textContent).toBe('Removed:     return f"Hello, {name}!"');
  expect(added?.textContent).toBe('Added:     return f"Hi, {name}!"');
  expect(removed?.parentElement?.className).toContain("bg-red-500/10");
  expect(added?.parentElement?.className).toContain("bg-emerald-500/10");
});

test("an edit that replaced every occurrence says so", async () => {
  const view = draw(
    turn([constructed.replaceAll], [constructed.replaceAll.result]),
  );
  const edit = await card(view, "Edited a file");
  expect(edit.getByText("All occurrences")).toBeTruthy();
  cleanup();

  // One that replaced a single occurrence says nothing about it.
  const single = live(recorded.edit);
  expect(
    (await card(single, "Edited a file")).queryByText("All occurrences"),
  ).toBeNull();
});

test("an edit Claude Code refused says it didn't work, live and after a reload", async () => {
  for (const draw of [live, reloaded]) {
    const view = draw(recorded.refusedEdit);
    const edit = await card(view, "Edited a file");
    expect(edit.getByText("Didn't work")).toBeTruthy();
    cleanup();
  }
});

test("a written file is all added lines, folded after the first few", async () => {
  const view = live(recorded.write);
  const write = await card(view, "Wrote a file");
  // 38 lines and a final newline.
  expect(write.getByText("+38")).toBeTruthy();
  expect(write.queryByText("Removed:")).toBeNull();
  expect(write.getAllByText("Added:")).toHaveLength(12);

  fireEvent.click(write.getByRole("button", { name: "Show 26 more lines" }));
  expect(write.getAllByText("Added:")).toHaveLength(38);
});

test("several edits to one file are one diff, counted together", async () => {
  const view = draw(
    turn([documented.multiEdit], [documented.multiEdit.result]),
  );
  const edit = await card(view, "Edited a file");
  expect(edit.getByText("+2")).toBeTruthy();
  expect(edit.getByText("−2")).toBeTruthy();
  expect(edit.getAllByText("Removed:")).toHaveLength(2);
});

test("a run of reads and searches is one line, as Claude Code folds it, that opens to each", async () => {
  const view = draw(
    turn(
      [
        recorded.read,
        documented.grepFiles,
        documented.grepContent,
        documented.grepNone,
        documented.glob,
      ],
      [
        recorded.read.history,
        documented.grepFiles.result,
        documented.grepContent.result,
        documented.grepNone.result,
        documented.glob.result,
      ],
    ),
  );
  const line = await view.findByText("Read 1 file and searched for 4 patterns");
  // One row for the run, not five.
  expect(cards(view)).toEqual([]);
  (line.closest("details") as HTMLDetailsElement).open = true;
  // Each step says what it found, as it would standing alone. Read numbers the empty line after the
  // final newline too.
  expect(readableLines(view.container, "ol > li details > summary")).toEqual([
    "Read 39 linesgreet.py",
    'Found 2 files"def " in workspace',
    'Found 2 matches"def " in greet.py',
    'Found no matches"class "',
    "Found 2 files**/*.py",
  ]);
});

test("a coding turn folds only its reads and searches, and keeps every change and command in view", async () => {
  // A recorded turn: plan, write, read it back, edit, list a folder that is not there, list another,
  // run it. Claude Code shows the plan, the write, the edit and the run on their own, and folds the
  // read and the two listings.
  const calls = [
    recorded.todoPlan,
    recorded.write,
    recorded.read,
    recorded.edit,
    recorded.failedCommand,
    recorded.failedCommand,
    recorded.run,
  ];
  const view = draw(
    turn(
      calls,
      calls.map((call) => call.history),
    ),
  );
  await view.findByText("To-dos");
  expect(cards(view)).toEqual([
    "Wrote a file",
    "Edited a file",
    "Ran a command",
  ]);
  // A lone read keeps its own line; the two listings fold into one, which says both didn't work.
  expect(view.getByText("Read 39 lines")).toBeTruthy();
  expect(view.getByText("Listed 2 directories")).toBeTruthy();
  expect(view.getByText("2 issues")).toBeTruthy();
});

test("a tool that shares a Claude Code name but not its arguments is drawn as any other tool", async () => {
  // Another harness's `Bash`, taking `cmd` where Claude Code's takes `command`.
  const other = { name: "Bash", arguments: JSON.stringify({ cmd: "ls" }) };
  const view = draw(turn([other], ["greet.py"]));
  await view.findByText("Bash");
  expect(view.queryByRole("region", { name: "Ran a command" })).toBeNull();
  cleanup();

  // And folds with its neighbours, as a tool the app has no component for does.
  const two = draw(turn([other, other], ["greet.py", "greet.py"]));
  expect(await two.findByText("Used 2 tools")).toBeTruthy();
  expect(cards(two)).toEqual([]);
});

test("a plan is a checklist of done, in progress and not started", async () => {
  const view = live(recorded.todoProgress);
  const plan = within(
    (await view.findByText("To-dos")).closest("figure") as HTMLElement,
  );
  expect(plan.getByText("2 of 4")).toBeTruthy();
  // The tick drawn in the box is decoration; the state is said in words.
  const items = readableLines(plan.getByRole("list"), "li");
  expect(items).toEqual([
    "Write greet.py module, Done",
    "Edit and modify greet.py, Done",
    "Test greet.py using Grep and Glob tools, In progress",
    "Run greet.py and other bash commands, Not started",
  ]);
});

test("the task tools say what happened to which task", async () => {
  const view = draw(
    turn(
      [recorded.taskCreate, recorded.taskStart, recorded.taskFinish],
      [
        recorded.taskCreate.history,
        recorded.taskStart.history,
        recorded.taskFinish.history,
      ],
    ),
  );
  expect(await view.findByText("Added a task")).toBeTruthy();
  expect(view.getByText(JSON.parse(recorded.taskCreate.arguments).subject));
  expect(view.getByText("Started task 1")).toBeTruthy();
  expect(view.getByText("Finished task 1")).toBeTruthy();
});
