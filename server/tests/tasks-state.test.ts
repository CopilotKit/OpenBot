import { describe, expect, test } from "bun:test";
import {
  nextStepOf,
  plainFailure,
  replyEnding,
  taskStatus,
} from "../src/tasks/state";

/*
 * The rules a task's state is read by, on their own. Ported as they are from OpenDuet, whose task
 * list has been reading tasks by them since tasks began there.
 */

describe("plainFailure", () => {
  test("says why a run couldn't finish without the error itself", () => {
    expect(plainFailure("The routine's turn was stopped after 300s.")).toBe(
      "the run took longer than 5 minutes",
    );
    expect(plainFailure("The turn finished without saying anything.")).toBe(
      "the run ended without a reply",
    );
    // Never the Bot in the third person: each reads after "I couldn't finish this:" too.
    expect(
      plainFailure(
        "This Bot or its conversation is no longer available to you.",
      ),
    ).toBe("this conversation is gone");
    expect(plainFailure("This Bot is paused.")).toBe("work is paused");
    expect(
      plainFailure(
        "This Bot uses gpt-x, which isn't an allowed model. Ask an admin to allow it.",
      ),
    ).toBe("the model isn't allowed here");
    expect(
      plainFailure("This turn failed before it could be tried again."),
    ).toBe("it failed before it could be tried again");
    expect(plainFailure("fetch failed")).toBe("a service didn't answer");
    expect(plainFailure("invalid x-api-key")).toBe(
      "the model provider turned the request away",
    );
    expect(plainFailure('429 {"error":{"type":"rate_limit"}} at line 3')).toBe(
      "something went wrong during the run",
    );
    // A run cut off by a crash leaves no error of its own.
    expect(plainFailure(null)).toBe("the run was cut off partway through");
  });
});

describe("taskStatus", () => {
  const at = (needsInput: boolean, working: boolean, resolved: boolean) =>
    taskStatus({ needsInput, working, resolved });

  test("puts what waits on the person first, then work under way, then the person's done", () => {
    expect(at(false, false, false)).toBe("ready_for_review");
    expect(
      taskStatus({
        needsInput: false,
        working: false,
        resolved: false,
        failed: true,
      }),
    ).toBe("failed");
    // Marked done beats failed; a retry under way beats both.
    expect(
      taskStatus({
        needsInput: false,
        working: false,
        resolved: true,
        failed: true,
      }),
    ).toBe("resolved");
    expect(
      taskStatus({
        needsInput: false,
        working: true,
        resolved: false,
        failed: true,
      }),
    ).toBe("working");
    expect(at(false, false, true)).toBe("resolved");
    expect(at(false, true, false)).toBe("working");
    expect(at(false, true, true)).toBe("working");
    expect(at(true, true, false)).toBe("needs_input");
    expect(at(true, false, true)).toBe("needs_input");
  });
});

describe("a task's next step", () => {
  test("only a spoken final paragraph asks for input, past draft quotes and list items", () => {
    for (const text of [
      "Which one should I use? 🙂",
      "Ready. Shall I send it? Let me know.",
      "Which date works?\n\n- Friday\n- Monday",
      "Which version?\n\n> Would you like a quote?",
    ])
      expect(replyEnding(text).asks).toBe(true);
    for (const text of [
      "- Is Friday okay?",
      "> Is Friday okay?",
      "“Can we book Friday?”",
      "Done.\n\n- Why not Friday?",
      "I found the date.\n\n**Draft:** Can we book Friday?",
    ])
      expect(replyEnding(text).asks).toBe(false);
  });

  test("is where the Bot's words leave things, or the person's own words while it works on them", () => {
    expect(
      nextStepOf(
        "I read Sam's email and the thread before it.\n\n- Draft A\n- Draft B\n\nShall I send draft A? It keeps the Friday date.",
        true,
      ),
    ).toBe("Shall I send draft A?");
    expect(nextStepOf("Also copy Ana on it.", false)).toBe(
      "“Also copy Ana on it.”",
    );
    expect(nextStepOf("   ", true)).toBeNull();
  });
});
