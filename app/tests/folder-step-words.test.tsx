import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { DECLINED_BY_PERSON } from "@openbot/shared/approval-outcomes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { subjectText } from "../src/components/audit/audit-cells";
import type { VisibleChatItem } from "../src/components/channels/chat-messages";
import { ServerToolLine } from "../src/components/channels/chat-transcript";
import {
  stepDetails,
  stepDetailsIn,
} from "../src/components/channels/tool-activity";
import {
  FolderNamesContext,
  folderNamesIn,
} from "../src/lib/folders/folder-steps";
import { REFUSAL_MARKER } from "../src/lib/plugins/tool-result";
import { settleReactWork } from "./settle-react-work";

/**
 * A step on a folder on the person's computer, as the conversation draws it.
 *
 * FOUND ON WINDOWS: the person pressed Deny on OpenBot Desktop's "Allow this file change?" and the
 * step read "Blocked: Saved a file", past tense for a file that was never saved. A blocked step says
 * what was tried, and which file, the way a blocked step on the Bot's own computer does
 * ("Blocked: Save a file  notes.txt · You declined it.").
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** What the desktop answers when the person presses Deny, behind the server's refusal marker. */
const DECLINED = `${REFUSAL_MARKER} Declined in OpenBot Desktop.`;

const write = JSON.stringify({
  grantId: "host-grant-1",
  path: "todo.txt",
  content: "pick up dry cleaning\n",
});

function line(name: string, args: string, result?: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ServerToolLine args={args} name={name} result={result} />
    </QueryClientProvider>,
  );
}

test("a blocked file change says what was tried, and on which file", () => {
  const view = line("host_write_file", write, DECLINED);
  const text = view.container.textContent ?? "";
  expect(text).toContain("Blocked: Save a file");
  expect(text).toContain("todo.txt");
  expect(text).not.toContain("Saved a file");
});

test("every folder step that is blocked reads as what was tried", () => {
  const cases = [
    ["host_list_files", { grantId: "g" }, "Blocked: List files"],
    ["host_read_file", { grantId: "g", path: "a.md" }, "Blocked: Read a file"],
    [
      "host_run_command",
      { grantId: "g", command: "dir" },
      "Blocked: Run a command",
    ],
    ["host_list_folders", {}, "Blocked: Check your folders"],
  ] as const;
  for (const [name, args, words] of cases) {
    const view = line(name, JSON.stringify(args), DECLINED);
    expect(view.container.textContent).toContain(words);
    view.unmount();
  }
});

test("a file change that happened keeps its past tense, and names the file too", () => {
  const view = line("host_write_file", write, JSON.stringify({ ok: true }));
  const text = view.container.textContent ?? "";
  expect(text).toContain("Saved a file");
  expect(text).toContain("todo.txt");
  expect(text).not.toContain("Blocked");
});

test("in a folded run, a blocked folder step is named for what was tried beside Blocked", () => {
  const item: Extract<VisibleChatItem, { kind: "tool" }> = {
    kind: "tool",
    id: "w",
    toolCall: {
      id: "w",
      type: "function",
      function: { name: "host_write_file", arguments: write },
    },
    result: DECLINED,
  };
  expect(stepDetails(item)).toMatchObject({
    refused: true,
    label: "Save a file",
  });
  const { result: _blocked, ...running } = item;
  expect(stepDetails(running)).toMatchObject({ label: "Saving a file" });
});

/*
 * FOUND ON THE MAC (main 3b400d2c1): with "Ask before making changes" on, the person pressed Deny on
 * the conversation's own card for a folder edit. The file was not touched and the Bot said so, but
 * the step read "Saved a file  notes.txt", done. The approval service answers a declined step with
 * the sentence it tells the Bot, with no refusal marker, so the line took it for the tool's result.
 * It reads as declined now, the way a Bot's own computer step does, live and when the conversation
 * is opened again (the thread keeps the same answer).
 */
test("a folder change declined on the conversation's card reads as declined, not saved", () => {
  const edit = JSON.stringify({
    grantId: "host-grant-15407-1794112361547002000",
    path: "notes.txt",
    content: "FOLDER-EDITED-43",
  });
  const view = line("host_write_file", edit, DECLINED_BY_PERSON);
  const text = view.container.textContent ?? "";
  expect(text).toContain("Blocked: Save a file");
  expect(text).toContain("notes.txt · You declined it.");
  expect(text).not.toContain("Saved a file");
  // The sentence written for the Bot is not what the person reads.
  expect(text).not.toContain("Do not try this action");
  view.unmount();

  const command = line(
    "host_run_command",
    JSON.stringify({ grantId: "g", command: "wc -c notes.txt" }),
    DECLINED_BY_PERSON,
  );
  expect(command.container.textContent).toContain("Blocked: Run a command");
  expect(command.container.textContent).toContain("You declined it.");
  expect(command.container.textContent).not.toContain("Ran a command");
});

test("in a folded run, a folder step declined on the card is Blocked, named for what was tried", () => {
  const item: Extract<VisibleChatItem, { kind: "tool" }> = {
    kind: "tool",
    id: "d",
    toolCall: {
      id: "d",
      type: "function",
      function: { name: "host_write_file", arguments: write },
    },
    result: DECLINED_BY_PERSON,
  };
  expect(stepDetails(item)).toMatchObject({
    refused: true,
    label: "Save a file",
  });
  expect(stepDetails(item).output).toBe("You declined it.");
});

/*
 * FOUND ON THE MAC: an opened folder step in a folded run listed its raw arguments, the grant's
 * internal id first ("grantId  host-grant-74138-1794115092137885000"). What a person reads leaves
 * it out; the path and the content stay.
 */
test("an opened folder step never lists the grant's internal id", () => {
  const item: Extract<VisibleChatItem, { kind: "tool" }> = {
    kind: "tool",
    id: "s",
    toolCall: {
      id: "s",
      type: "function",
      function: {
        name: "host_write_file",
        arguments: JSON.stringify({
          grantId: "host-grant-74138-1794115092137885000",
          path: "notes.txt",
          content: "FOLDER-EDITED-45",
        }),
      },
    },
    result: JSON.stringify({ ok: true }),
  };
  const { inputs } = stepDetails(item);
  expect(inputs.map(([key]) => key)).toEqual(["path", "content"]);
  expect(JSON.stringify(inputs)).not.toContain("host-grant");
});

/*
 * FOUND ON WINDOWS (main 0c140734): opening "Check your folders" showed the tool's answer as it
 * came, {"connected":true,"folders":[{"grantId":"host-grant-7712-…","displayName":"share"}]}, and
 * the Save step named the file but not the folder it was in. A person reads the folders by name, no
 * JSON and no grant id, and a folder step names its file and folder as the card does:
 * "todo.txt in share".
 */
const GRANT = "host-grant-7712-1794100000000000000";
const listing = JSON.stringify({
  connected: true,
  folders: [{ grantId: GRANT, displayName: "share" }],
});
const listStep: Extract<VisibleChatItem, { kind: "tool" }> = {
  kind: "tool",
  id: "l",
  toolCall: {
    id: "l",
    type: "function",
    function: { name: "host_list_folders", arguments: "{}" },
  },
  result: listing,
};
const saveStep: Extract<VisibleChatItem, { kind: "tool" }> = {
  kind: "tool",
  id: "w2",
  toolCall: {
    id: "w2",
    type: "function",
    function: {
      name: "host_write_file",
      arguments: JSON.stringify({
        grantId: GRANT,
        path: "todo.txt",
        content: "pick up dry cleaning",
      }),
    },
  },
  result: "Wrote file. Backup, if the file existed, is .openbot-backups/x",
};

test("an opened Check your folders step names the folders, never JSON or a grant id", () => {
  const view = line("host_list_folders", "{}", listing);
  const text = view.container.textContent ?? "";
  expect(text).toContain("Folders it can read: share.");
  expect(text).not.toContain("{");
  expect(text).not.toContain("host-grant");
  view.unmount();

  expect(stepDetails(listStep).output).toBe("Folders it can read: share.");
  const offline = line(
    "host_list_folders",
    "{}",
    JSON.stringify({ connected: false, folders: [] }),
  );
  expect(offline.container.textContent).toContain(
    "No folders are shared with this Bot. OpenBot Desktop isn't running.",
  );
});

test("no folder step shows an answer written as JSON", () => {
  for (const name of [
    "host_list_files",
    "host_read_file",
    "host_run_command",
  ]) {
    const item: Extract<VisibleChatItem, { kind: "tool" }> = {
      ...saveStep,
      toolCall: {
        ...saveStep.toolCall,
        function: { name, arguments: JSON.stringify({ grantId: GRANT }) },
      },
      result: JSON.stringify({ grantId: GRANT }),
    };
    expect(stepDetails(item).output).toBeUndefined();
  }
  // A file's contents or a command's output is what the person asked about, and stays.
  expect(
    stepDetails({ ...saveStep, result: "pick up dry cleaning\n" }).output,
  ).toBe("pick up dry cleaning\n");
});

test("a folder step names its file and the folder it is in, as the card does", () => {
  const folders = folderNamesIn([listStep, saveStep]);
  expect(folders.get(GRANT)).toBe("share");

  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <FolderNamesContext.Provider value={folders}>
        <ServerToolLine
          args={saveStep.toolCall.function.arguments}
          name="host_write_file"
          result={saveStep.result}
        />
      </FolderNamesContext.Provider>
    </QueryClientProvider>,
  );
  expect(view.container.textContent).toContain("todo.txt in share");
  view.unmount();

  expect(stepDetailsIn(folders)(saveStep).detail).toBe("todo.txt in share");
  // A command or a listing is on the whole folder.
  expect(
    stepDetailsIn(folders)({
      ...saveStep,
      toolCall: {
        ...saveStep.toolCall,
        function: {
          name: "host_run_command",
          arguments: JSON.stringify({ grantId: GRANT, command: "dir" }),
        },
      },
    }).detail,
  ).toBe("in share");
});

test("Activity names a folder step's file and folder", () => {
  const row = (payload: Record<string, unknown>) =>
    subjectText(
      {
        id: "e",
        createdAt: "2026-11-08T00:00:00.000Z",
        eventType: "computer.action_allowed",
        targetType: "host_access",
        targetId: GRANT,
        actorUserId: "person",
        initiatorKind: "person",
        payload,
      } as unknown as Parameters<typeof subjectText>[0],
      false,
    );
  expect(
    row({ action: "host/write_file", file: "todo.txt", folder: "share" }),
  ).toBe("todo.txt in share");
  expect(
    row({ action: "host/run_command", command: "dir", folder: "share" }),
  ).toBe("dir in share");
  // A row written before rows named their folder keeps the file alone.
  expect(row({ action: "host/write_file", file: "todo.txt" })).toBe("todo.txt");
});
