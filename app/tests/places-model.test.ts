import { expect, test } from "bun:test";
import {
  DEFAULT_PLACE,
  movePlace,
  PLACE_IDS,
  parseStoredOrder,
  parseStoredPlace,
  placeForPath,
  readPlacesFlag,
} from "@/lib/places/places";

test("only Bots and Routines pages move the strip", () => {
  expect(placeForPath("/bots")).toBe("bots");
  expect(placeForPath("/bots/abc/skills")).toBe("bots");
  expect(placeForPath("/routines/goals/g1")).toBe("routines");
  expect(placeForPath("/")).toBeNull();
  expect(placeForPath("/channel/c1")).toBeNull();
  expect(placeForPath("/group/c1")).toBeNull();
  expect(placeForPath("/botsy")).toBeNull();
});

test("a stored place that is not one falls back", () => {
  expect(parseStoredPlace("bots")).toBe("bots");
  expect(parseStoredPlace("goals")).toBe(DEFAULT_PLACE);
  expect(parseStoredPlace(null)).toBe(DEFAULT_PLACE);
});

test("a stored order keeps what it knows, drops what it does not, and appends what is new", () => {
  expect(parseStoredOrder(null)).toEqual([...PLACE_IDS]);
  expect(parseStoredOrder("not json")).toEqual([...PLACE_IDS]);
  expect(parseStoredOrder('["bots","goals","openbot","bots"]')).toEqual([
    "bots",
    "openbot",
    "conversations",
    "routines",
    "at-work",
  ]);
});

test("a place moves one step and stops at the ends", () => {
  const order = [...PLACE_IDS];
  expect(movePlace(order, "bots", -1)).toEqual([
    "openbot",
    "bots",
    "conversations",
    "routines",
    "at-work",
  ]);
  expect(movePlace(order, "openbot", -1)).toEqual(order);
  expect(movePlace(order, "at-work", 1)).toEqual(order);
});

test("the switch is set from the address, remembered, and survives storage that throws", () => {
  const kept = new Map<string, string>();
  const storage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  };
  expect(readPlacesFlag("", storage)).toBe(false);
  expect(readPlacesFlag("?places=on", storage)).toBe(true);
  expect(readPlacesFlag("", storage)).toBe(true);
  expect(readPlacesFlag("?x=1&places=off", storage)).toBe(false);
  expect(readPlacesFlag("?places=maybe", storage)).toBe(false);
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  expect(readPlacesFlag("?places=on", broken)).toBe(true);
  expect(readPlacesFlag("", broken)).toBe(false);
});
