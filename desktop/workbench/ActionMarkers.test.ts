import { expect, test } from "bun:test";
import {
  type ActionMark,
  type Followed,
  followMarks,
  followTarget,
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

test("followMarks moves a marker with its element and drops the ones whose element went", () => {
  const moving = element();
  const gone = element({ isConnected: false });
  const marks: ActionMark[] = [
    { id: 1, label: "Click Next", box: box(10), target: moving },
    { id: 2, label: "Click Install", box: box(50), target: gone },
  ];
  const next = followMarks(marks, () => box(34, 90));
  expect(next.map((m) => [m.id, m.box])).toEqual([[1, box(34, 90)]]);
});

test("sameBox rounds to the pixel", () => {
  expect(sameBox(box(10), box(10.4))).toBe(true);
  expect(sameBox(box(10), box(11))).toBe(false);
  expect(sameBox(null, null)).toBe(true);
  expect(sameBox(null, box(1))).toBe(false);
});
