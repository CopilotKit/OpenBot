import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Warning } from "./layoutWatch";
import { formatTime } from "./RunControls";
import { WarningsList, warningText } from "./WarningsList";

beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("describes each kind of warning", () => {
  const t = formatTime(1500);
  expect(
    warningText({
      kind: "moved",
      at: 1500,
      label: "Save",
      dx: 3,
      dy: 4,
      cause: "click",
    }),
  ).toBe(`Save moved 5px at ${t} (click)`);
  expect(warningText({ kind: "clipped", at: 1500, label: "Title" })).toBe(
    `Title is cut off at ${t}`,
  );
  expect(
    warningText({ kind: "outside", at: 1500, label: "Menu", overBy: 11.6 }),
  ).toBe(`Menu is 12px outside the window at ${t}`);
});

test("lists newest first, later entries first on ties", () => {
  const warnings: Warning[] = [
    { kind: "clipped", at: 100, label: "A" },
    { kind: "clipped", at: 300, label: "B" },
    { kind: "clipped", at: 300, label: "C" },
  ];
  const { getAllByRole, getByText } = render(
    <WarningsList warnings={warnings} onSeek={() => {}} />,
  );
  expect(getByText("Layout warnings (3)")).not.toBeNull();
  const labels = getAllByRole("button").map((b) => b.textContent ?? "");
  expect(labels.map((l) => l[0])).toEqual(["C", "B", "A"]);
});

test("clicking seeks to the warning time", () => {
  const onSeek = mock((_ms: number) => {});
  const { getByRole } = render(
    <WarningsList
      warnings={[{ kind: "clipped", at: 250, label: "A" }]}
      onSeek={onSeek}
    />,
  );
  fireEvent.click(getByRole("button"));
  expect(onSeek).toHaveBeenCalledWith(250);
});

test("says when there are none", () => {
  const { getByText } = render(
    <WarningsList warnings={[]} onSeek={() => {}} />,
  );
  expect(getByText("No layout warnings.")).not.toBeNull();
});
