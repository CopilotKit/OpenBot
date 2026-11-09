import { expect, test } from "bun:test";
import { approvalPhrase, approvalWords } from "@openbot/shared/tool-name";
import { type ApprovalCandidate, targetSubject } from "../src/approvals/types";
import { createHostAccessBroker } from "../src/host-access/broker";
import { hostAccessTools } from "../src/host-access/tools";
import { waitingLine } from "../src/tasks/state";

/*
 * A folder on the person's computer is named by its name, never by the id OpenBot gave the grant.
 *
 * FOUND ON THE MAC (main 3b400d2c1): with "Ask before making changes" on, the conversation's card for
 * a folder edit read "Write file on host-grant-15407-1794112361547002000", the command's "Run command
 * on host-grant-…", and the same id named every approval row in Settings > Activity. The folder was
 * called folder-test. These drive the Bot's real folder tools through the real broker and read what
 * its approval gate was handed, which is what the card, the task line and the trail are made from.
 */

const GRANT = "host-grant-15407-1794112361547002000";
const BOT = "trivia-pal";
const PERSON = "dev-local-user";

/** The candidate each folder action put to the approval gate, as the tools sent it. */
async function asked(
  name: string,
  args: Record<string, unknown>,
): Promise<ApprovalCandidate> {
  let candidate: ApprovalCandidate | undefined;
  const broker = createHostAccessBroker(Date.now, {
    approvalGate: async (asked) => {
      candidate = asked;
      // The person says no, so nothing reaches the desktop and the test needs none.
      throw new Error("stop here");
    },
  });
  broker.rememberGrant({
    id: GRANT,
    botId: BOT,
    actorId: PERSON,
    displayName: "folder-test",
    revoked: false,
  });
  broker.nextDesktopOperation();
  const tool = hostAccessTools({ broker, botId: BOT, actorId: PERSON }).find(
    (candidate) => candidate.name === name,
  );
  if (!tool) throw new Error(`${name} is not offered`);
  await tool.execute(args);
  if (!candidate) throw new Error("the approval gate was never asked");
  return candidate;
}

test("the card names the file and the folder an edit is in, and the folder a command runs in, never the grant's id", async () => {
  const edit = await asked("host_write_file", {
    grantId: GRANT,
    path: "notes.txt",
    content: "FOLDER-EDITED-43",
  });
  // Found on Windows: the card named the folder ("share") and not the file.
  // In the words its step and its Activity row use, never "write file on notes.txt in folder-test".
  expect(approvalWords(edit)).toEqual({
    action: "save a file",
    place: "notes.txt in folder-test",
  });
  expect(approvalPhrase(edit)).toBe("save a file notes.txt in folder-test");
  const command = await asked("host_run_command", {
    grantId: GRANT,
    command: "wc -c notes.txt",
  });
  expect(approvalWords(command).place).toBe("folder-test");
  // The rule a person saves from the card stays on the grant, which a name could not tell apart.
  expect(edit.scope).toBe(GRANT);
});

test("the trail's approval rows name the file, the command and the folder, never the grant's id", async () => {
  const edit = await asked("host_write_file", {
    grantId: GRANT,
    path: "notes.txt",
    content: "FOLDER-EDITED-43",
  });
  expect(targetSubject(edit.target)).toEqual({
    file: "notes.txt",
    folder: "folder-test",
  });
  const command = await asked("host_run_command", {
    grantId: GRANT,
    command: "wc -c notes.txt",
  });
  expect(targetSubject(command.target)).toEqual({
    command: "wc -c notes.txt",
    folder: "folder-test",
  });
  const listing = await asked("host_list_files", { grantId: GRANT });
  expect(JSON.stringify(targetSubject(listing.target))).not.toContain(GRANT);
  expect(targetSubject(listing.target)).toEqual({ folder: "folder-test" });
});

test("a task waiting on a folder edit says where by the folder's name", () => {
  expect(
    waitingLine({
      kind: "approval",
      toolRef: "host/write_file",
      scope: GRANT,
      target: { displayName: "folder-test" },
      handOff: false,
    }),
  ).toBe("Waiting for your approval: save a file in folder-test");
  expect(
    waitingLine({
      kind: "approval",
      toolRef: "host/write_file",
      scope: GRANT,
      target: { displayName: "folder-test", relativePath: "notes.txt" },
      handOff: false,
    }),
  ).toBe("Waiting for your approval: save a file notes.txt in folder-test");
});
