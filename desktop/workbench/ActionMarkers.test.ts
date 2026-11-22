import { expect, test } from "bun:test";
import {
  type ActionMark,
  type Followed,
  followMarks,
  followTarget,
  GHOST_MS,
  markAt,
  sameBox,
} from "./ActionMarkers";

const box = (x: number, y = 10) => ({ x, y, width: 80, height: 20 });
const element = (over: Partial<Followed> = {}) =>
  ({
    isConnected: true,
    checkVisibility: () => true,
    ...over,
  }) as Followed & Element;

test("a marker follows its element to the new box", () => {
  expect(followTarget(element(), () => box(40))).toEqual({
    drop: false,
    box: box(40),
  });
});

test("a marker goes when its element left the document, is hidden or has no size", () => {
  // The next screen replaced the Install button: the marker must not sit over the new screen.
  expect(followTarget(element({ isConnected: false }), () => box(1))).toEqual({
    drop: true,
  });
  expect(
    followTarget(element({ checkVisibility: () => false }), () => box(1)),
  ).toEqual({ drop: true });
  expect(
    followTarget(element(), () => ({ x: 5, y: 5, width: 0, height: 0 })),
  ).toEqual({ drop: true });
  expect(followTarget(element(), () => null)).toEqual({ drop: true });
});

test("a marker without an element keeps its place, and a browser without checkVisibility still follows", () => {
  expect(followTarget(null, () => box(1))).toEqual({ drop: false, box: null });
  expect(
    followTarget(element({ checkVisibility: undefined }), () => box(2)),
  ).toEqual({ drop: false, box: box(2) });
});

test("followMarks keeps the same array when nothing moved, so a frame sets no state", () => {
  const target = element();
  const marks: ActionMark[] = [
    { id: 1, label: "Click Install", box: box(10), target },
    { id: 2, label: "Click Nothing (not found)", box: null },
  ];
  expect(followMarks(marks, () => box(10.2))).toBe(marks);
});

test("followMarks moves a marker with its element, and leaves a ghost where an element went", () => {
  const moving = element();
  const gone = element({ isConnected: false });
  const marks: ActionMark[] = [
    { id: 1, label: "Click Next", box: box(10), target: moving },
    { id: 2, label: "Click Install", box: box(50), target: gone },
  ];
  const next = followMarks(marks, () => box(34, 90), 1000);
  expect(next.map((m) => [m.id, m.box, m.ghostSince ?? null])).toEqual([
    [1, box(34, 90), null],
    [2, box(50), 1000],
  ]);
  // The ghost goes GHOST_MS later.
  expect(followMarks(next, () => box(34, 90), 1000 + GHOST_MS)).toEqual([
    next[0] as ActionMark,
  ]);
});

test("markAt: the Install button left at once after the click, so a ghost stays at its last box for GHOST_MS", () => {
  const install: ActionMark = {
    id: 1,
    label: "Click · Install",
    box: box(50),
    target: element({ isConnected: false }),
  };
  const ghost = markAt(install, () => box(1), 20);
  expect(ghost).toEqual({ ...install, ghostSince: 20 });
  // Same object while it fades: a frame with no change sets no state.
  expect(markAt(ghost as ActionMark, () => box(1), 20 + GHOST_MS - 1)).toBe(
    ghost,
  );
  expect(markAt(ghost as ActionMark, () => box(1), 20 + GHOST_MS)).toBeNull();
});

test("markAt: never a ghost over an element that is still there; it follows it instead", () => {
  const target = element();
  const ghost: ActionMark = {
    id: 1,
    label: "Click · Next",
    box: box(50),
    target,
    ghostSince: 100,
  };
  // The element is back (or was only hidden for a frame): the marker follows it again.
  expect(markAt(ghost, () => box(80), 200)).toEqual({
    ...ghost,
    box: box(80),
    ghostSince: null,
  });
  // Hidden or of no size counts as gone: a ghost at the last box.
  const hidden = element({ checkVisibility: () => false });
  expect(
    markAt({ ...ghost, target: hidden, ghostSince: null }, () => box(1), 300),
  ).toEqual({ ...ghost, target: hidden, ghostSince: 300 });
});

test("markAt: a marker that never had a box has no ghost; one without an element stays", () => {
  const nowhere: ActionMark = {
    id: 1,
    label: "Click Install",
    box: null,
    target: element({ isConnected: false }),
  };
  expect(markAt(nowhere, () => null, 0)).toBeNull();
  const notFound: ActionMark = { id: 2, label: "Click Nothing", box: null };
  expect(markAt(notFound, () => null, 0)).toBe(notFound);
});

test("sameBox rounds to the pixel", () => {
  expect(sameBox(box(10), box(10.4))).toBe(true);
  expect(sameBox(box(10), box(11))).toBe(false);
  expect(sameBox(null, null)).toBe(true);
  expect(sameBox(null, box(1))).toBe(false);
});
