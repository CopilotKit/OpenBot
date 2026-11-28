import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import {
  forgetHeldFilesInMemory,
  STAGED_FILE_HELD_MS,
  savedDraftKey,
  writeSavedDraft,
} from "@/components/channels/composer/saved-draft";
import { authKeys } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * AN UNSENT REPLY STAYS WITH ITS CONVERSATION.
 *
 * Reported from OpenBot 1.2.0-rc.4: type a reply in a conversation and leave it unsent, open
 * another conversation from the sidebar, come back, and the box was empty with nothing said. A file
 * attached to the reply was gone too. Opening a conversation remounts its composer (the channel
 * screen is keyed on the conversation), and the composer kept nothing, so both were lost.
 *
 * These drive the composer as the channel screen mounts it: one box per conversation, unmounted when
 * another is opened. A reload is the same remount with this visit's memory gone, which the browser
 * keeps nothing of but `localStorage` (and IndexedDB, which this harness does not have).
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
/** Every request the composers made, as `METHOD path`. */
let requests: string[];

beforeEach(() => {
  window.localStorage.clear();
  forgetHeldFilesInMemory();
  queryClient.setQueryData(authKeys.currentUser(), { id: "person-1" });
  requests = [];
  let uploads = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    requests.push(`${method} ${new URL(url, "http://localhost/").pathname}`);
    if (method === "POST") {
      const file = ((init as RequestInit).body as FormData).get("file") as File;
      uploads += 1;
      return new Response(
        JSON.stringify({
          id: `stored-${uploads}`,
          name: file.name,
          mimeType: "text/plain",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  queryClient.removeQueries({ queryKey: authKeys.currentUser() });
});

function editorOf(container: HTMLElement): HTMLElement {
  return container.querySelector("[contenteditable]") as HTMLElement;
}

function typedText(container: HTMLElement): string {
  return editorOf(container).textContent ?? "";
}

/** Type the way this suite can: a plain-text paste at the end of the box (see composer-send-failure). */
function typeInto(container: HTMLElement, words: string) {
  const editor = editorOf(container);
  editor.focus();
  const caret = document.createRange();
  caret.selectNodeContents(editor);
  caret.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(caret);
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? words : ""),
    },
  });
}

function drop(container: HTMLElement, files: File[]) {
  fireEvent.drop(container.querySelector("form") as HTMLFormElement, {
    dataTransfer: { files, items: [], types: ["Files"] },
  });
}

/**
 * The file's chip is on the strip and has finished uploading. Send is held shut while any upload
 * is in flight (`canSendDraft`), so an open Send is the screen saying the file is there for good.
 */
async function attached(view: ReturnType<typeof render>, name: string) {
  await waitFor(() => {
    expect(view.queryByLabelText(`Remove ${name}`)).not.toBeNull();
    expect(
      (view.getByLabelText("Send message") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
}

/** The box a conversation's screen draws. */
function conversation(
  channelId: string,
  onSubmit: () => Promise<void> = async () => {},
) {
  return (
    <Composer
      channelId={channelId}
      compact
      draftKey={`conversation:${channelId}`}
      onSubmit={onSubmit}
    />
  );
}

const uploadsMade = () => requests.filter((line) => line.startsWith("POST"));
const deletesMade = () => requests.filter((line) => line.startsWith("DELETE"));

test("a reply and its file are still there after opening another conversation, and after a reload, until sent", async () => {
  // Type a reply and attach a file, and leave it unsent.
  const first = render(conversation("design"));
  await act(async () => {
    typeInto(first.container, "Half a reply");
  });
  drop(first.container, [
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  ]);
  await attached(first, "notes.txt");
  first.unmount();

  // Open another conversation: its box is its own, and empty.
  const other = render(conversation("notes"));
  expect(typedText(other.container)).toBe("");
  expect(other.queryByLabelText(/^Remove /)).toBeNull();
  other.unmount();

  // Come back: the words and the file are where they were left, and the file is not uploaded again.
  const back = render(conversation("design"));
  expect(typedText(back.container)).toContain("Half a reply");
  await attached(back, "notes.txt");
  expect(uploadsMade()).toHaveLength(1);
  // Nothing gave the file's row back to the server while the draft held it.
  expect(deletesMade()).toEqual([]);
  back.unmount();

  // Reload: this visit's memory is gone, the draft is not.
  forgetHeldFilesInMemory();
  let sent: string | undefined;
  const reloaded = render(
    <Composer
      channelId="design"
      compact
      draftKey="conversation:design"
      onSubmit={async (draft) => {
        sent = `${draft.text} + ${draft.attachments.map((file) => file.filename).join(",")}`;
      }}
    />,
  );
  expect(typedText(reloaded.container)).toContain("Half a reply");
  await attached(reloaded, "notes.txt");

  // Send: the message carries both, and the box is empty when the conversation opens again.
  await act(async () => {
    fireEvent.click(reloaded.getByLabelText("Send message"));
  });
  expect(sent).toBe("Half a reply + notes.txt");
  reloaded.unmount();
  const afterSend = render(conversation("design"));
  expect(typedText(afterSend.container)).toBe("");
  expect(afterSend.queryByLabelText(/^Remove /)).toBeNull();
  expect(uploadsMade()).toHaveLength(1);
  expect(deletesMade()).toEqual([]);
});

test("a failed send keeps the reply and its file for the next time the conversation opens", async () => {
  const first = render(
    conversation("design", async () => {
      throw new Error("the turn could not be started");
    }),
  );
  await act(async () => {
    typeInto(first.container, "Try this");
  });
  drop(first.container, [
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  ]);
  await attached(first, "notes.txt");
  await act(async () => {
    fireEvent.click(first.getByLabelText("Send message"));
  });
  expect(typedText(first.container)).toContain("Try this");
  first.unmount();

  const back = render(conversation("design"));
  expect(typedText(back.container)).toContain("Try this");
  await attached(back, "notes.txt");
});

test("the box with no conversation yet keeps its words and its held file", async () => {
  const home = () => (
    <Composer draftKey="home" holdsFilesUntilSent onSubmit={async () => {}} />
  );
  const first = render(home());
  await act(async () => {
    typeInto(first.container, "Plan my week");
  });
  drop(first.container, [
    new File(["notes"], "agenda.txt", { type: "text/plain" }),
  ]);
  await attached(first, "agenda.txt");
  first.unmount();

  const back = render(home());
  expect(typedText(back.container)).toContain("Plan my week");
  await attached(back, "agenda.txt");
  // Held in this tab: nothing was uploaded for a conversation that does not exist yet.
  expect(uploadsMade()).toEqual([]);
});

test("an @ chip comes back as a chip, and a file the server no longer holds is said, not shown", async () => {
  const key = savedDraftKey("conversation:design") as string;
  writeSavedDraft(key, {
    segments: [
      {
        type: "chip",
        trigger: "@",
        value: "bot-1",
        displayText: "Researcher",
      },
      { type: "text", text: " check this" },
    ],
    uploadGroup: "group-1",
    staged: [
      {
        attachmentId: "stored-old",
        url: "/api/v2/organizations/default/attachments/stored-old",
        mimeType: "text/plain",
        filename: "old.txt",
        size: 5,
        stagedAt: Date.now() - STAGED_FILE_HELD_MS - 1,
      },
    ],
    heldFiles: 0,
    savedAt: Date.now(),
  });

  const view = render(conversation("design"));
  const chip = editorOf(view.container).querySelector(
    "[data-chip-value='bot-1']",
  );
  expect(chip?.textContent).toContain("Researcher");
  expect(typedText(view.container)).toContain("check this");
  await waitFor(() =>
    expect(
      view.queryByText(/removed after a day without being sent/),
    ).not.toBeNull(),
  );
  expect(view.queryByLabelText("Remove old.txt")).toBeNull();
});
