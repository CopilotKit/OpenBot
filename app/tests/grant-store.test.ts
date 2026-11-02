import { expect, mock, test } from "bun:test";
import {
  cardState,
  COULDNT_CHECK,
  createGrantStore,
  type GrantSnapshot,
  grantsFrom,
  NOT_AVAILABLE,
} from "@/lib/copilot/grant-store";

/**
 * What a gallery card knows about whether its Bot may show it. "Not known yet" is not "refused":
 * a card that drew the refusal while the grants were still on their way, and then the component,
 * flashed "not available" at somebody who was allowed to see it.
 */

const held = (...names: string[]) =>
  new Map(names.map((name) => [name, `${name} description`]));

test("grants are unknown while there is no Bot to ask about", () => {
  expect(grantsFrom({ isError: false, enabled: false })).toEqual({
    status: "unknown",
  });
});

test("grants are unknown while the first answer is on its way", () => {
  expect(grantsFrom({ isError: false, enabled: true })).toEqual({
    status: "unknown",
  });
});

test("grants are known once they arrive", () => {
  expect(
    grantsFrom({
      data: [{ name: "chart", description: "d" }],
      isError: false,
      enabled: true,
    }),
  ).toEqual({ status: "known", held: new Map([["chart", "d"]]) });
});

test("grants that could not be loaded at all have failed", () => {
  expect(grantsFrom({ isError: true, enabled: true })).toEqual({
    status: "failed",
  });
});

test("a failed poll keeps the grants already known", () => {
  expect(
    grantsFrom({
      data: [{ name: "chart", description: "d" }],
      isError: true,
      enabled: true,
    }),
  ).toEqual({ status: "known", held: new Map([["chart", "d"]]) });
});

function snapshot(overrides: Partial<GrantSnapshot> = {}): GrantSnapshot {
  return {
    grants: { status: "unknown" },
    refusals: new Map(),
    ...overrides,
  };
}

test("a card waits, never refuses, while grants are unknown", () => {
  expect(cardState(snapshot(), "chart", "Bar chart")).toBe("wait-for-grant");
});

test("a held component draws", () => {
  expect(
    cardState(
      snapshot({ grants: { status: "known", held: held("chart") } }),
      "chart",
      "Bar chart",
    ),
  ).toBe("draw");
});

test("a component the Bot does not hold is refused", () => {
  expect(
    cardState(
      snapshot({ grants: { status: "known", held: held() } }),
      "chart",
      "Bar chart",
    ),
  ).toEqual({ refused: NOT_AVAILABLE("Bar chart") });
});

test("grants that failed refuse with the couldn't-check reason", () => {
  expect(
    cardState(snapshot({ grants: { status: "failed" } }), "chart", "Bar chart"),
  ).toEqual({ refused: COULDNT_CHECK("Bar chart") });
  expect(COULDNT_CHECK("Bar chart")).toBe(
    "Couldn't check whether this Bot may show Bar chart. Try again in a moment.",
  );
});

test("a refusal for this call wins over a grant", () => {
  expect(
    cardState(
      snapshot({
        grants: { status: "known", held: held("chart") },
        refusals: new Map([["call-2", "Not in this channel."]]),
      }),
      "chart",
      "Bar chart",
      "call-2",
    ),
  ).toEqual({ refused: "Not in this channel." });
});

test("the store tells its listeners about a change and not about a no-op", () => {
  const store = createGrantStore();
  const listener = mock(() => {});
  store.subscribe(listener);

  store.set({ grants: { status: "unknown" } });
  expect(listener).toHaveBeenCalledTimes(0);

  const before = store.get();
  store.set({ grants: { status: "failed" } });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(store.get()).not.toBe(before);
});
