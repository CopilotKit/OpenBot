import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptedChanges, differences, failing } from "./asyncapi-diff";

/**
 * The breaking-change check, held to real changes to the real file: each test edits a copy of
 * api/asyncapi.yaml the way a pull request would, runs the AsyncAPI CLI's diff on the two, and says
 * whether the check must fail. Needs the CLI (bun install --cwd api/asyncapi-tools); without it the
 * tests are skipped, and CI's API job, which installs it, runs them.
 */

const SPEC = join(import.meta.dir, "asyncapi.yaml");
const installed = existsSync(
  join(import.meta.dir, "asyncapi-tools/node_modules/.bin/asyncapi"),
);

/** The changes that fail, after one edit to the file. */
function failuresAfter(from: string, to: string, accepted = ""): string[] {
  const original = readFileSync(SPEC, "utf8");
  expect(original).toContain(from);
  const head = join(mkdtempSync(join(tmpdir(), "asyncapi-diff-")), "head.yaml");
  writeFileSync(head, original.replace(from, to));
  return failing(differences(SPEC, head), acceptedChanges(accepted)).map(
    (change) => `${change.action} ${change.path}`,
  );
}

const slow = { timeout: 120_000 };

test.skipIf(!installed)(
  "the file against itself breaks nothing",
  () => {
    expect(failuresAfter("asyncapi: 3.1.0", "asyncapi: 3.1.0")).toEqual([]);
  },
  slow,
);

test.skipIf(!installed)(
  "moving a socket's address fails",
  () => {
    expect(
      failuresAfter(
        "address: /api/channels/events",
        "address: /api/channels/happenings",
      ),
    ).toEqual(["edit /channels/legacyConversationEvents/address"]);
  },
  slow,
);

test.skipIf(!installed)(
  "taking a message off a channel fails",
  () => {
    const original = readFileSync(SPEC, "utf8");
    const inChannel =
      '      screenText:\n        $ref: "#/components/messages/ScreenText"\n';
    const inOperation =
      '      - $ref: "#/channels/legacyBotScreen/messages/screenText"\n';
    expect(original).toContain(inChannel);
    expect(original).toContain(inOperation);
    const head = join(
      mkdtempSync(join(tmpdir(), "asyncapi-diff-")),
      "head.yaml",
    );
    writeFileSync(
      head,
      original.replace(inChannel, "").replace(inOperation, ""),
    );
    const failed = failing(differences(SPEC, head)).map(
      (change) => `${change.action} ${change.path}`,
    );
    expect(failed).toContain(
      "remove /channels/legacyBotScreen/messages/screenText",
    );
  },
  slow,
);

test.skipIf(!installed)(
  "making a payload member required fails",
  () => {
    expect(
      failuresAfter(
        "        - lastMessageAgentId\n      properties:",
        "        - lastMessageAgentId\n        - summary\n      properties:",
      ),
    ).toEqual(["add /components/schemas/ConversationActivity/required/5"]);
  },
  slow,
);

test.skipIf(!installed)(
  "changing a payload member's type fails",
  () => {
    expect(
      failuresAfter(
        "        confirmFrames:\n          type: boolean",
        "        confirmFrames:\n          type: string",
      ),
    ).toEqual([
      "edit /components/schemas/ScreenHello/properties/confirmFrames/type",
    ]);
  },
  slow,
);

test.skipIf(!installed)(
  "removing a payload member fails",
  () => {
    expect(
      failuresAfter(
        "        fatal:\n          type: boolean\n          description: True when connecting again will not help.\n",
        "",
      ),
    ).toEqual(["remove /components/schemas/TerminalError/properties/fatal"]);
  },
  slow,
);

test.skipIf(!installed)(
  "a new optional payload member passes",
  () => {
    expect(
      failuresAfter(
        "        fatal:\n          type: boolean\n",
        "        code:\n          type: string\n        fatal:\n          type: boolean\n",
      ),
    ).toEqual([]);
  },
  slow,
);

test.skipIf(!installed)(
  "rewording a description passes",
  () => {
    expect(
      failuresAfter(
        "description: The conversation.",
        "description: The conversation it is about.",
      ),
    ).toEqual([]);
  },
  slow,
);

test.skipIf(!installed)(
  "an accepted change passes, and only that change",
  () => {
    const accepted =
      "- 2026-11-14 `edit /components/schemas/ScreenHello/properties/confirmFrames/type` for the test.";
    expect(
      failuresAfter(
        "        confirmFrames:\n          type: boolean",
        "        confirmFrames:\n          type: string",
        accepted,
      ),
    ).toEqual([]);
    expect(
      failuresAfter(
        "address: /api/channels/events",
        "address: /api/channels/happenings",
        accepted,
      ),
    ).toEqual(["edit /channels/legacyConversationEvents/address"]);
  },
  slow,
);
