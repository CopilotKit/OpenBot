export type Box = { x: number; y: number; width: number; height: number };

type Gaps = {
  top: number | null;
  right: number | null;
  bottom: number | null;
  left: number | null;
};

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart) > 0;
}

function intersects(a: Box, b: Box) {
  return (
    overlaps(a.x, a.x + a.width, b.x, b.x + b.width) &&
    overlaps(a.y, a.y + a.height, b.y, b.y + b.height)
  );
}

function nearest(current: number | null, candidate: number) {
  return current === null || candidate < current ? candidate : current;
}

export function gaps(target: Box, others: readonly Box[]): Gaps {
  const result: Gaps = { top: null, right: null, bottom: null, left: null };
  const tRight = target.x + target.width;
  const tBottom = target.y + target.height;

  for (const other of others) {
    if (intersects(target, other)) continue;
    const oRight = other.x + other.width;
    const oBottom = other.y + other.height;
    const horizontal = overlaps(target.x, tRight, other.x, oRight);
    const vertical = overlaps(target.y, tBottom, other.y, oBottom);

    if (horizontal) {
      if (oBottom <= target.y) {
        result.top = nearest(result.top, target.y - oBottom);
      } else if (other.y >= tBottom) {
        result.bottom = nearest(result.bottom, other.y - tBottom);
      }
    }
    if (vertical) {
      if (oRight <= target.x) {
        result.left = nearest(result.left, target.x - oRight);
      } else if (other.x >= tRight) {
        result.right = nearest(result.right, other.x - tRight);
      }
    }
  }
  return result;
}

function distanceToGrid(value: number, step: number) {
  const r = ((value % step) + step) % step;
  return Math.min(r, step - r);
}

export function offGrid(box: Box, step: number): { x: number; y: number } {
  return { x: distanceToGrid(box.x, step), y: distanceToGrid(box.y, step) };
}
