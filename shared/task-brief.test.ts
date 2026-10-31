import { describe, expect, test } from "bun:test";
import {
  frameTaskBrief,
  frameTaskReply,
  readTaskBrief,
  readTaskFrame,
  START_TASK_TOOL,
  TASK_FRAME,
  TASK_REPLY_LINE,
} from "./task-brief";
import { frameFiring, readFiring } from "./routine-firing";

const ASK =
  "Draft a reply to Rosa saying we'll take Oat Satin instead of the discontinued glaze.";

describe("frameTaskBrief", () => {
  test("puts the frame above the person's ask, and tells the Bot not to hand the task on", () => {
    expect(frameTaskBrief(ASK).startsWith(TASK_FRAME.join("\n"))).toBe(true);
    expect(frameTaskBrief(ASK).endsWith(ASK)).toBe(true);
    expect(TASK_FRAME.join(" ")).toContain(`Never call ${START_TASK_TOOL}`);
  });
});

describe("readTaskBrief", () => {
  test("gives back exactly the ask, over several lines too", () => {
    expect(readTaskBrief(frameTaskBrief(ASK))).toBe(ASK);
    const multi = "Prepare notes.\n\nSource: https://mail.google.com/x";
    expect(readTaskBrief(frameTaskBrief(multi))).toBe(multi);
    expect(readTaskFrame(frameTaskBrief(ASK))).toEqual({
      kind: "brief",
      text: ASK,
    });
    const historical = [...TASK_FRAME, "", ASK].join("\n");
    expect(readTaskBrief(historical)).toBe(ASK);
    expect(readTaskFrame(historical)).toEqual({ kind: "brief", text: ASK });
  });

  test("keeps a historical reply separator quoted in a new task's ask", () => {
    const ask = `Explain this excerpt:\n\n${TASK_REPLY_LINE}\n\nUse the new rate.`;
    expect(readTaskBrief(frameTaskBrief(ask))).toBe(
      "Explain this excerpt:\n\nThe run before this one couldn't finish. The person replied to the task with this:\n\nUse the new rate.",
    );
    expect(readTaskFrame(frameTaskBrief(ask))?.kind).toBe("brief");
  });

  test("gives back only the person's words from a reply to a failed task, which still carries the ask", () => {
    const framed = frameTaskReply(ASK, "Use the Oat Satin glaze.");
    expect(framed).toContain(ASK);
    expect(readTaskBrief(framed)).toBe("Use the Oat Satin glaze.");
    expect(readTaskFrame(framed)).toEqual({
      kind: "reply",
      text: "Use the Oat Satin glaze.",
    });
    expect(readTaskBrief(frameTaskReply(ASK, "Two lines.\n\nNo more."))).toBe(
      "Two lines.\n\nNo more.",
    );
  });

  test("retains the full earlier input and quoted separators across successive corrections", () => {
    const separator = `\n\n${TASK_REPLY_LINE}\n\n`;
    const prior = frameTaskReply(
      `Review 📒. ${ASK}`,
      "Use the revised totals.",
    );
    const reply = `Keep this quote:${separator}Use October's rate.\n`;
    const framed = frameTaskReply(prior, reply);
    expect(framed).toContain(prior);
    expect(readTaskBrief(framed)).toBe(reply);
    expect(readTaskBrief(frameTaskReply(framed, "Done."))).toBe("Done.");
  });

  test("still reads historical reply frames without a context length", () => {
    const reply = `Keep this quote:\n\n${TASK_REPLY_LINE}\n\nQuoted example.`;
    const historical = [
      ...TASK_FRAME,
      "",
      ASK,
      "",
      TASK_REPLY_LINE,
      "",
      reply,
    ].join("\n");
    expect(readTaskBrief(historical)).toBe(reply);
    expect(readTaskFrame(historical)).toEqual({ kind: "reply", text: reply });
    const corrected = frameTaskReply(historical, "Use the revised totals.");
    expect(corrected).toContain(historical);
    expect(readTaskBrief(corrected)).toBe("Use the revised totals.");
  });

  test("says no to a message the person wrote, or one line of the frame quoted back", () => {
    expect(readTaskBrief(ASK)).toBeNull();
    expect(readTaskFrame(ASK)).toBeNull();
    expect(readTaskBrief(`${TASK_FRAME[0]}\n\n${ASK}`)).toBeNull();
  });

  test("is not mistaken for a routine's firing, nor a firing for it", () => {
    expect(readFiring(frameTaskBrief(ASK))).toBeNull();
    expect(readTaskBrief(frameFiring(ASK))).toBeNull();
  });
});
