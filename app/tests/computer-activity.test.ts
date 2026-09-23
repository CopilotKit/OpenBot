import { beforeEach, describe, expect, test } from "bun:test";
import {
  activityFor,
  clearActivity,
  recordActivity,
} from "../src/lib/computers/activity";
import { outputOf } from "../src/lib/copilot/computer-tools";

/**
 * What a Bot did on its computer, other than browse.
 *
 * The screen said what it was looking at and nothing said what it was doing: a shell command was one
 * grey line with the output nowhere, so a person watching a Bot work on a machine holding their
 * logins had to take the model's word for what it printed.
 *
 * `outputOf` is the part that reads a result, and it is the part that gets it wrong: it looked for
 * `contents` on a file read, which is the name on the way in rather than the way back, and the pane
 * said "It printed nothing" about a file the Bot had just read out loud. These pin the field names.
 */

describe("reading what a call printed", () => {
  test("a command is its stdout", () => {
    expect(outputOf({ ok: true, stdout: "ripgrep 14.1.0\n", stderr: "" })).toBe(
      "ripgrep 14.1.0\n",
    );
  });

  test("a failing command keeps its stderr, which is the whole message", () => {
    expect(
      outputOf({
        ok: true,
        stdout: "",
        stderr: "ls: cannot access '/nope'",
        exitCode: 2,
      }),
    ).toBe("ls: cannot access '/nope'");
  });

  test("both streams, in the order a terminal shows them", () => {
    expect(outputOf({ ok: true, stdout: "one", stderr: "and a warning" })).toBe(
      "one\nand a warning",
    );
  });

  test("a file read is its text", () => {
    // `text`, not `contents`. `contents` is the field on the way in, and reading it back gave an
    // empty pane for a file that had just been read.
    expect(outputOf({ ok: true, path: "notes.md", text: "hello" })).toBe(
      "hello",
    );
  });

  test("a listing marks folders the way a terminal does", () => {
    expect(
      outputOf({
        ok: true,
        entries: [
          { path: "notes", kind: "folder" },
          { path: "notes.md", kind: "file", bytes: 5 },
        ],
      }),
    ).toBe("notes/\nnotes.md  5 bytes");
  });

  test("a refusal is its reason, which is the useful part", () => {
    expect(
      outputOf({ ok: false, refused: true, reason: "A boundary said no." }),
    ).toBe("A boundary said no.");
  });

  test("something with none of those fields gives nothing rather than a guess", () => {
    // The pane then says the call printed nothing, which is honest. Inventing a summary from an
    // unrecognised shape is how a view starts lying about what happened.
    expect(outputOf({ ok: true })).toBe("");
  });
});

describe("the activity a pane shows", () => {
  beforeEach(() => {
    clearActivity("bot-1");
    clearActivity("bot-2");
  });

  test("keeps what a Bot ran, in the order it ran it", () => {
    recordActivity("bot-1", "call-1", {
      kind: "command",
      subject: "ls",
      output: "a\nb",
    });
    recordActivity("bot-1", "call-2", {
      kind: "command",
      subject: "pwd",
      output: "/workspace",
    });

    expect(activityFor("bot-1").map((entry) => entry.subject)).toEqual([
      "ls",
      "pwd",
    ]);
  });

  test("keeps one Bot's work out of another's", () => {
    recordActivity("bot-1", "call-3", {
      kind: "command",
      subject: "ls",
      output: "",
    });

    expect(activityFor("bot-2")).toEqual([]);
  });

  test("a computer nothing has happened on is empty rather than undefined", () => {
    expect(activityFor("never-used")).toEqual([]);
  });

  test("wiping a computer forgets what ran on it", () => {
    // Reset deletes the machine those commands ran on, so leaving them on screen would describe
    // something that no longer exists.
    recordActivity("bot-1", "call-4", {
      kind: "command",
      subject: "ls",
      output: "",
    });
    clearActivity("bot-1");

    expect(activityFor("bot-1")).toEqual([]);
  });

  test("stops growing, because this is a pane and not an archive", () => {
    for (let index = 0; index < 250; index += 1) {
      recordActivity("bot-1", `call-${index}`, {
        kind: "command",
        subject: `command-${index}`,
        output: "",
      });
    }

    const kept = activityFor("bot-1");
    expect(kept).toHaveLength(200);
    // The oldest go first: what somebody watching wants is what just happened.
    expect(kept[0]?.subject).toBe("command-50");
    expect(kept.at(-1)?.subject).toBe("command-249");
  });

  test("every entry is distinguishable, so two identical commands both show", () => {
    recordActivity("bot-1", "call-6", {
      kind: "command",
      subject: "ls",
      output: "",
    });
    recordActivity("bot-1", "call-7", {
      kind: "command",
      subject: "ls",
      output: "",
    });

    const [first, second] = activityFor("bot-1");
    expect(first?.id).not.toBe(second?.id);
  });

  test("one call is one entry, however many times a render records it", () => {
    /*
     * The property the whole keyed signature exists for. The handlers moved to the server, so the
     * only place the browser still sees a call is `render` — which runs on every paint. Before the
     * key, a Bot that ran one command grew a fresh copy of it in the pane on each one.
     */
    for (let paint = 0; paint < 5; paint += 1) {
      recordActivity("bot-1", "one-call", {
        kind: "command",
        subject: "bun test",
        output: "ok",
      });
    }

    expect(activityFor("bot-1")).toHaveLength(1);
  });

  test("a wiped computer can record the same call id again", () => {
    // Reset gives the Bot a new machine. The key must not outlive the thing it was about, or the
    // first command on the new computer is silently dropped as a duplicate of one on the old.
    recordActivity("bot-1", "call-8", {
      kind: "command",
      subject: "ls",
      output: "",
    });
    clearActivity("bot-1");
    recordActivity("bot-1", "call-8", {
      kind: "command",
      subject: "ls",
      output: "",
    });

    expect(activityFor("bot-1")).toHaveLength(1);
  });
});
