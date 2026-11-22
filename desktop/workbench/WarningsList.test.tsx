import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { Warning } from "./layoutWatch";
import { formatTime } from "./RunControls";
import { WarningsList, warningKey, warningText } from "./WarningsList";

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
});

test("lists newest first, later entries first on ties", () => {
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
  expect(labels.map((l) => l[0])).toEqual(["C", "B", "A"]);
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
  const [b, a] = getAllByRole("button");
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
  const [b, a] = getAllByRole("button");
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
