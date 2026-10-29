import { expect, test } from "bun:test";
import { frameFiring } from "@openbot/shared/routine-firing";
import type { TranscriptItem } from "@/components/channels/tool-activity";
import { turnsOf } from "@/components/channels/transcript-turns";

/**
 * The rail beside a conversation has one mark per turn: something the person sent, and what the Bot
 * said back. Each mark knows the row it jumps to and the words its preview shows.
 */

const said = (
  id: string,
  role: "user" | "assistant",
  text: string,
): TranscriptItem => ({ kind: "text", id, role, text });

const files = (id: string, count: number): TranscriptItem => ({
  kind: "attachments",
  id,
  attachments: Array.from({ length: count }, (_, index) => ({
    id: `${id}-${index}`,
    attachmentId: `${id}-${index}`,
    url: `/files/${index}`,
    modality: "image" as const,
  })),
});

const searched = (id: string): TranscriptItem => ({
  kind: "tool",
  id,
  toolCall: {
    id,
    type: "function",
    function: { name: "web_search", arguments: "{}" },
  },
  result: "found",
});

test("one turn per message the person sent, with the first thing the Bot said back", () => {
  const turns = turnsOf([
    said("u1", "user", "What changed?"),
    searched("t1"),
    said("a1", "assistant", "Two things changed."),
    said("a1b", "assistant", "And a third."),
    said("u2", "user", "Why?"),
    said("a2", "assistant", "Because."),
  ]);

  expect(turns).toEqual([
    {
      id: "u1",
      index: 0,
      prompt: "What changed?",
      reply: "Two things changed.",
    },
    { id: "u2", index: 4, prompt: "Why?", reply: "Because." },
  ]);
});

test("files sent with a caption are one turn, and files alone are named by count", () => {
  const turns = turnsOf([
    files("f1", 2),
    said("u1", "user", "Look at these"),
    said("a1", "assistant", "Seen."),
    files("f2", 1),
    said("a2", "assistant", "A chart."),
  ]);

  expect(turns.map(({ id, prompt }) => ({ id, prompt }))).toEqual([
    { id: "f1", prompt: "Look at these" },
    { id: "f2", prompt: "1 file" },
  ]);
});

test("a routine firing is not a turn the person took", () => {
  const firing = frameFiring("Send the daily digest.");
  const turns = turnsOf([
    said("u1", "user", "Hello"),
    said("a1", "assistant", "Hi"),
    said("r1", "user", firing),
    said("a2", "assistant", "Here is the digest."),
  ]);

  expect(turns.map((turn) => turn.id)).toEqual(["u1"]);
});

test("a turn still waiting for its reply has none", () => {
  expect(turnsOf([said("u1", "user", "Hello")])).toEqual([
    { id: "u1", index: 0, prompt: "Hello", reply: "" },
  ]);
});

test("markdown is read as plain words", () => {
  const [turn] = turnsOf([
    said("u1", "user", "Hi"),
    said(
      "a1",
      "assistant",
      "## Summary\n\n**Two** things, see [the doc](https://x.y).",
    ),
  ]);

  expect(turn?.reply).toBe("Summary Two things, see the doc.");
});
