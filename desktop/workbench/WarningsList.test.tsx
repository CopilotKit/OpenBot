import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { type Movement, warningMark } from "./findings";
import type { Warning } from "./layoutWatch";
import { formatTime } from "./RunControls";
import {
  mergeRunWarnings,
  WarningsList,
  warningKey,
  warningText,
} from "./WarningsList";

beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const BOX = { x: 0, y: 0, width: 10, height: 10 };
const clipped = (at: number, label: string): Warning => ({
  kind: "clipped",
  at,
  label,
  box: BOX,
  scrollWidth: 20,
  scrollHeight: 10,
});

/** Waits real time: the list's hover delay uses the page's timers. */
const wait = (ms: number) =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

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
      from: BOX,
      to: { ...BOX, x: 3, y: 4 },
    }),
  ).toBe(`Save moved 5px at ${t} (click)`);
  expect(warningText(clipped(1500, "Title"))).toBe(`Title is cut off at ${t}`);
  expect(
    warningText({
      kind: "outside",
      at: 1500,
      label: "Menu",
      overBy: 11.6,
      box: BOX,
    }),
  ).toBe(`Menu is 12px outside the window at ${t}`);
  expect(
    warningText({
      kind: "spacing",
      at: 1500,
      label: "The window buttons",
      rule: "column",
      box: BOX,
      buttons: BOX,
      size: 11,
      text: "The window buttons sit 11 px right of the middle of their column",
    }),
  ).toBe(
    `The window buttons sit 11 px right of the middle of their column at ${t}`,
  );
});

test("lists by time, then by label, in a fixed order", () => {
  const warnings: Warning[] = [
    clipped(100, "A"),
    clipped(300, "B"),
    clipped(300, "C"),
  ];
  const { getAllByRole, getByText } = render(
    <WarningsList warnings={warnings} onSeek={() => {}} />,
  );
  expect(getByText("Layout warnings (3)")).not.toBeNull();
  const labels = getAllByRole("button").map((b) => b.textContent ?? "");
  expect(labels.map((l) => l[0])).toEqual(["A", "B", "C"]);
});

test("clicking seeks to the warning time", () => {
  const onSeek = mock((_ms: number) => {});
  const { getByRole } = render(
    <WarningsList warnings={[clipped(250, "A")]} onSeek={onSeek} />,
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

test("a pointer that rests on a row for the delay shows its warning", async () => {
  const onHover = mock((_w: Warning) => {});
  const warning = clipped(250, "A");
  const { getByRole } = render(
    <WarningsList
      warnings={[warning]}
      onSeek={() => {}}
      onHover={onHover}
      hoverDelay={20}
    />,
  );
  fireEvent.mouseMove(getByRole("button"), { clientX: 5, clientY: 5 });
  await wait(5);
  expect(onHover).not.toHaveBeenCalled();
  // More moves on the same row do not start the delay again.
  fireEvent.mouseMove(getByRole("button"), { clientX: 6, clientY: 5 });
  await wait(30);
  expect(onHover).toHaveBeenCalledTimes(1);
  expect(onHover).toHaveBeenCalledWith(warning);
});

test("a pointer that passes over a row does not show its warning", async () => {
  const onHover = mock((_w: Warning) => {});
  const { getAllByRole } = render(
    <WarningsList
      warnings={[clipped(100, "A"), clipped(200, "B")]}
      onSeek={() => {}}
      onHover={onHover}
      hoverDelay={20}
    />,
  );
  const [a, b] = getAllByRole("button");
  fireEvent.mouseMove(b, { clientX: 5, clientY: 5 });
  fireEvent.mouseLeave(b, { clientX: 5, clientY: 15 });
  fireEvent.mouseMove(a, { clientX: 5, clientY: 15 });
  await wait(30);
  expect(onHover.mock.calls.map(([w]) => w.label)).toEqual(["A"]);
});

test("a move with the pointer in the same place is the list changing, not the pointer", async () => {
  const onHover = mock((_w: Warning) => {});
  const { getAllByRole } = render(
    <WarningsList
      warnings={[clipped(100, "A"), clipped(200, "B")]}
      onSeek={() => {}}
      onHover={onHover}
      hoverDelay={20}
    />,
  );
  const [a, b] = getAllByRole("button");
  fireEvent.mouseMove(b, { clientX: 5, clientY: 5 });
  await wait(30);
  // The rows moved under a pointer that stayed still.
  fireEvent.mouseLeave(b, { clientX: 5, clientY: 5 });
  fireEvent.mouseMove(a, { clientX: 5, clientY: 5 });
  await wait(30);
  expect(onHover.mock.calls.map(([w]) => w.label)).toEqual(["B"]);
});

test("a click pins the warning and does not wait for the delay", async () => {
  const onHover = mock((_w: Warning) => {});
  const onPin = mock((_w: Warning) => {});
  const onSeek = mock((_ms: number) => {});
  const { getByRole } = render(
    <WarningsList
      warnings={[clipped(250, "A")]}
      onSeek={onSeek}
      onHover={onHover}
      onPin={onPin}
      hoverDelay={20}
    />,
  );
  fireEvent.mouseMove(getByRole("button"), { clientX: 5, clientY: 5 });
  fireEvent.click(getByRole("button"));
  await wait(30);
  expect(onPin).toHaveBeenCalledTimes(1);
  expect(onHover).not.toHaveBeenCalled();
  expect(onSeek).not.toHaveBeenCalled();
});

test("leaving the list says so, and stops a row's delay", async () => {
  const onHover = mock((_w: Warning) => {});
  const onLeave = mock(() => {});
  const { getByRole, container } = render(
    <WarningsList
      warnings={[clipped(250, "A")]}
      onSeek={() => {}}
      onHover={onHover}
      onLeave={onLeave}
      hoverDelay={20}
    />,
  );
  fireEvent.mouseMove(getByRole("button"), { clientX: 5, clientY: 5 });
  fireEvent.mouseLeave(container.querySelector("section") as Element, {
    clientX: 500,
    clientY: 5,
  });
  await wait(30);
  expect(onLeave).toHaveBeenCalledTimes(1);
  expect(onHover).not.toHaveBeenCalled();
});

test("the shown warning's row says when it is jumping and when it is pinned", () => {
  const warning = clipped(250, "A");
  const key = warningKey(warning);
  const { getByRole, rerender } = render(
    <WarningsList
      warnings={[warning]}
      onSeek={() => {}}
      onPin={() => {}}
      highlight={{ key, pinned: false, jumping: true }}
    />,
  );
  expect(getByRole("button").textContent).toContain("Jumping…");
  expect(getByRole("button").getAttribute("aria-pressed")).toBe("false");
  rerender(
    <WarningsList
      warnings={[warning]}
      onSeek={() => {}}
      onPin={() => {}}
      highlight={{ key, pinned: true, jumping: false }}
    />,
  );
  expect(getByRole("button").textContent).not.toContain("Jumping…");
  expect(getByRole("button").getAttribute("aria-pressed")).toBe("true");
});

test("while the page seeks, the heading says where it goes and the list is busy", () => {
  const { getByRole, container } = render(
    <WarningsList
      warnings={[clipped(44_000, "A")]}
      onSeek={() => {}}
      seekingTo={44_000}
    />,
  );
  expect(getByRole("status").textContent).toBe("Seeking to 0:44…");
  expect(container.querySelector("section")?.getAttribute("aria-busy")).toBe(
    "true",
  );
});

test("the same warning twice keeps two rows", () => {
  const { getAllByRole } = render(
    <WarningsList
      warnings={[clipped(100, "A"), clipped(100, "A")]}
      onSeek={() => {}}
    />,
  );
  expect(getAllByRole("button")).toHaveLength(2);
});

test("mergeRunWarnings keeps the rows a seek back has not found again", () => {
  const early = clipped(1000, "Title");
  const late = clipped(9000, "Footer");
  const found = clipped(1000, "Title");
  // A seek back to 0:02 found only the early warning again: the late row stays.
  expect(mergeRunWarnings([early, late], [found], 2000)).toEqual([found, late]);
  expect(mergeRunWarnings([], [found], 2000)).toEqual([found]);
});

test("mergeRunWarnings drops a kept row the clock went past without finding it again", () => {
  const early = clipped(1000, "Title");
  const late = clipped(9000, "Footer");
  // After a fix and a reload, the run found nothing. Ahead of 0:09 the late row stays, muted.
  expect(mergeRunWarnings([early, late], [], 0)).toEqual([early, late]);
  expect(mergeRunWarnings([early, late], [], 5000)).toEqual([late]);
  // At its own time it stays: the watch finds a warning at the clock's time, not before.
  expect(mergeRunWarnings([late], [], 9000)).toEqual([late]);
  // Past it, unfound: the warning is gone from the run, so the row goes.
  expect(mergeRunWarnings([early, late], [], 9001)).toEqual([]);
  // Found again past its time: one row, the found one.
  const again = clipped(9000, "Footer");
  expect(mergeRunWarnings([early, late], [again], 12000)).toEqual([again]);
});

// The page merges at the layout watch's checkedAt. A seek back gives a new window: no warnings,
// checked at 0. Every row stays, and the replay finds the early ones again.
test("a seek back keeps every row: the new window starts at 0 with no warnings", () => {
  const early = clipped(1000, "Title");
  const late = clipped(9000, "Footer");
  const atEnd = mergeRunWarnings([], [early, late], 60_000);
  const newWindow = mergeRunWarnings(atEnd, [], 0);
  expect(newWindow).toEqual([early, late]);
  // The replay walked to 0:02: it found the early row; the late one waits ahead, muted.
  const replayed = mergeRunWarnings(newWindow, [early], 2000);
  expect(replayed).toEqual([early, late]);
});

test("after a seek back the list keeps its rows: the ones not reached show muted, in the same place", () => {
  const early = clipped(1000, "Title");
  const late = clipped(9000, "Footer");
  const full = render(
    <WarningsList warnings={[early, late]} onSeek={() => {}} />,
  );
  const before = [...full.container.querySelectorAll("li")].map(
    (li) => li.textContent,
  );
  full.unmount();

  const view = render(
    <WarningsList
      warnings={mergeRunWarnings([early, late], [early], 2000)}
      found={[early]}
      onSeek={() => {}}
    />,
  );
  const rows = [...view.container.querySelectorAll("li button")];
  expect(rows.map((row) => row.textContent)).toEqual(before);
  expect(rows[0]?.className ?? "").not.toContain("wb-warning-later");
  expect(rows[1]?.className).toContain("wb-warning-later");
  expect(view.getByText(/Layout warnings \(2\)/)).toBeTruthy();
});

test("while the pointer is in the list, a seek back that drops a row keeps every row in its place, muted; the new rows show when the pointer leaves", () => {
  // The review's case: a 0:00 row above the hovered one is not found again after the seek.
  const clock = clipped(0, "The whole page");
  const hovered = clipped(5000, "Install");
  const late = clipped(9000, "Footer");
  const view = render(
    <WarningsList
      warnings={[clock, hovered, late]}
      onSeek={() => {}}
      run="a"
    />,
  );
  const section = view.container.querySelector("section") as Element;
  const texts = () =>
    [...view.container.querySelectorAll("li button")].map(
      (row) => row.textContent,
    );
  const before = texts();
  fireEvent.mouseEnter(section, { clientX: 5, clientY: 40 });
  fireEvent.mouseMove(view.getAllByRole("button")[1] as Element, {
    clientX: 5,
    clientY: 40,
  });

  // The seek back: the run has only the hovered row now, and a new one.
  const found = clipped(6000, "New");
  view.rerender(
    <WarningsList
      warnings={[hovered, found]}
      found={[hovered, found]}
      onSeek={() => {}}
      run="a"
    />,
  );
  expect(texts()).toEqual(before);
  const rows = [...view.container.querySelectorAll("li button")];
  expect(rows[0]?.className).toContain("wb-warning-later");
  expect(rows[1]?.className ?? "").not.toContain("wb-warning-later");
  expect(rows[2]?.className).toContain("wb-warning-later");

  // The pointer leaves: the rows of now show.
  fireEvent.mouseLeave(section, { clientX: 500, clientY: 40 });
  expect(texts()).toEqual([warningText(hovered), warningText(found)]);
});

test("a new run shows its own rows at once, also with the pointer in the list", () => {
  const view = render(
    <WarningsList warnings={[clipped(0, "A")]} onSeek={() => {}} run="a" />,
  );
  fireEvent.mouseEnter(view.container.querySelector("section") as Element);
  view.rerender(
    <WarningsList warnings={[clipped(0, "B")]} onSeek={() => {}} run="b" />,
  );
  expect(view.container.textContent).toContain("B is cut off");
  expect(view.container.textContent).not.toContain("A is cut off");
});

const moved = (at: number, label: string): Warning => ({
  kind: "moved",
  at,
  label,
  dx: 0,
  dy: 156,
  cause: "click",
  from: BOX,
  to: { ...BOX, y: 156 },
});

test("with the classes of the moves, the expected moves hide behind a toggle", async () => {
  const expectedMove = moved(37_000, 'p "Done"');
  const jitter = moved(40_000, 'button "Continue"');
  const cut = clipped(1_000, 'p "Long"');
  const movements = new Map<string, Movement>([
    [
      warningMark(expectedMove),
      { class: "expected", rule: "after-action", why: "after the click" },
    ],
    [
      warningMark(jitter),
      { class: "jitter", rule: "jitter", why: "back and forth" },
    ],
  ]);
  const onHover = mock((_w: Warning) => {});
  const { getAllByRole, getByRole, getByText, queryByText } = render(
    <WarningsList
      warnings={[expectedMove, jitter, cut]}
      movements={movements}
      onSeek={() => {}}
      onHover={onHover}
      hoverDelay={20}
    />,
  );
  getByText("Layout warnings (2)");
  const rows = () => getAllByRole("button").map((b) => b.textContent ?? "");
  expect(rows()).toEqual([
    `${warningText(cut)}`,
    `${warningText(jitter)}Jitter`,
  ]);
  expect(queryByText(/156px at 0:37/)).toBeNull();

  const toggle = getByRole("checkbox", { name: "Show expected moves (1)" });
  fireEvent.click(toggle);
  expect(rows()).toEqual([
    `${warningText(cut)}`,
    `${warningText(expectedMove)}Expected: after an input`,
    `${warningText(jitter)}Jitter`,
  ]);
  // The hover still shows the row's warning, also for an expected move.
  const row = getAllByRole("button")[1] as HTMLElement;
  fireEvent.mouseMove(row, { clientX: 5, clientY: 5 });
  await wait(30);
  expect(onHover).toHaveBeenCalledWith(expectedMove);
});

test("with no expected moves there is no toggle", () => {
  const { queryByRole } = render(
    <WarningsList
      warnings={[clipped(1_000, "A")]}
      movements={new Map()}
      onSeek={() => {}}
    />,
  );
  expect(queryByRole("checkbox")).toBeNull();
});
