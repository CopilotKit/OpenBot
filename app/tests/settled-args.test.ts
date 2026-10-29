import { expect, test } from "bun:test";
import { settledArgs } from "@/lib/copilot/settled-args";

/**
 * Partial JSON only ever stops at its end, so of all the arguments drawn while a call streams, only
 * the last value can be half there. A label that is half typed reads fine; a number that is half
 * typed is a different number (12 on its way to 125), so a bar would jump. Those are held back until
 * something follows them or the call completes.
 */

test("a trailing number is held back while streaming", () => {
  expect(
    settledArgs(
      {
        points: [
          { label: "A", value: 4 },
          { label: "B", value: 12 },
        ],
      },
      false,
    ),
  ).toEqual({ points: [{ label: "A", value: 4 }, { label: "B" }] });
});

test("complete arguments are returned as they are", () => {
  const args = { points: [{ label: "B", value: 12 }] };
  expect(settledArgs(args, true)).toBe(args);
});

test("a trailing label is kept", () => {
  expect(settledArgs({ points: [{ value: 4, label: "Rev" }] }, false)).toEqual({
    points: [{ value: 4, label: "Rev" }],
  });
});

test("a trailing link is held back", () => {
  expect(
    settledArgs({ title: "Docs", link: { url: "https://exa" } }, false),
  ).toEqual({ title: "Docs", link: {} });
});

test("a trailing colour is held back", () => {
  expect(settledArgs({ title: "Status", colour: "#3" }, false)).toEqual({
    title: "Status",
  });
});

test("a number followed by another key is kept", () => {
  expect(settledArgs({ value: 12, label: "B" }, false)).toEqual({
    value: 12,
    label: "B",
  });
});
