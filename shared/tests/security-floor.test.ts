import { describe, expect, test } from "bun:test";
import cases from "../fixtures/security-floor/cases.json";
import {
  belowFloor,
  type FloorStore,
  floorApplies,
  heldSecurityFloor,
  refreshSecurityFloor,
  verifySecurityFloor,
} from "../security-floor";

const keys = [cases.publicKey];
const doc = (name: string) => {
  const found = cases.cases.find((c) => c.name === name);
  if (!found) throw new Error(`no case ${name}`);
  return found.document;
};

function memoryStore(initial: string | null = null) {
  let text = initial;
  const store: FloorStore = {
    read: async () => text,
    write: async (next) => {
      text = next;
    },
  };
  return { store, held: () => text };
}

/** A feed that answers each address from `answers`, and fails any address it doesn't list. */
function feed(answers: Record<string, string | number>) {
  return (async (input: string | URL | Request) => {
    const answer = answers[String(input)];
    if (answer === undefined) throw new TypeError("fetch failed");
    if (typeof answer === "number") return new Response("", { status: answer });
    return new Response(answer, { status: 200 });
  }) as typeof fetch;
}

// Where an app reads the floor: its mirror first, then the release. Each app names its own.
const mirror = "https://mirror.floor.example/latest/security-floor.json";
const github = "https://release.floor.example/latest/security-floor.json";
const SECURITY_FLOOR_ADDRESSES = [mirror, github];

describe("verifying a floor", () => {
  for (const c of cases.cases) {
    test(`${c.name} ${c.verifies ? "verifies" : "is ignored"}`, async () => {
      const verified = await verifySecurityFloor(c.document, keys);
      expect(verified.ok).toBe(c.verifies);
      if (verified.ok) {
        expect(verified.floor.serial).toBe(c.serial as number);
        expect(verified.floor.floors.desktop).toBe(c.desktop as string);
      }
    });
  }

  test("no floor verifies against an app with no keys", async () => {
    expect((await verifySecurityFloor(doc("current"), [])).ok).toBe(false);
  });
});

describe("below the floor", () => {
  test("an app below its floor is blocked, at or above it is not", async () => {
    const verified = await verifySecurityFloor(doc("current"), keys);
    if (!verified.ok) throw new Error(verified.reason);
    const floor = verified.floor;
    expect(belowFloor(floor, "desktop", "1.1.1")).toBe("1.1.2");
    expect(belowFloor(floor, "desktop", "1.1.2")).toBeNull();
    expect(belowFloor(floor, "desktop", "1.2.0")).toBeNull();
    // A candidate or internal build of a release counts as that release.
    expect(belowFloor(floor, "desktop", "1.1.2-rc.1")).toBeNull();
    expect(belowFloor(floor, "desktop", "1.1.1-internal.4.gabc")).toBe("1.1.2");
    expect(belowFloor(floor, "recorder", "0.9.0")).toBe("1.1.2");
    expect(belowFloor(null, "desktop", "0.0.1")).toBeNull();
  });

  test("a company's own OpenBot ignores the floor; Desktop's own back end and a listed Cloud follow it", async () => {
    const verified = await verifySecurityFloor(doc("current"), keys);
    if (!verified.ok) throw new Error(verified.reason);
    const floor = verified.floor;
    expect(floorApplies(floor, { contained: true })).toBe(true);
    expect(
      floorApplies(floor, {
        origin: "https://cloud.openbot.example/some/page",
      }),
    ).toBe(true);
    expect(
      floorApplies(floor, { origin: "https://openbot.acme.example" }),
    ).toBe(false);
    expect(floorApplies(floor, { origin: "http://127.0.0.1:3000" })).toBe(
      false,
    );
  });
});

describe("keeping the floor", () => {
  test("a verified floor is kept, and blocks again offline", async () => {
    const { store, held } = memoryStore();
    const online = await refreshSecurityFloor({
      store,
      keys,
      addresses: SECURITY_FLOOR_ADDRESSES,
      fetch: feed({ [mirror]: doc("current") }),
    });
    expect(online?.serial).toBe(2);
    expect(held()).toBe(doc("current"));
    const offline = await refreshSecurityFloor({
      store,
      keys,
      addresses: SECURITY_FLOOR_ADDRESSES,
      fetch: feed({}),
    });
    expect(belowFloor(offline, "desktop", "1.1.1")).toBe("1.1.2");
  });

  test("a lower serial is ignored, so a replayed old floor can't lift a block", async () => {
    const { store, held } = memoryStore(doc("current"));
    const floor = await refreshSecurityFloor({
      store,
      keys,
      addresses: SECURITY_FLOOR_ADDRESSES,
      fetch: feed({ [mirror]: doc("older") }),
    });
    expect(floor?.serial).toBe(2);
    expect(held()).toBe(doc("current"));
  });

  for (const name of [
    "unsigned",
    "zero signature",
    "tampered",
    "other key",
    "not a floor",
  ]) {
    test(`a ${name} floor changes nothing`, async () => {
      const { store, held } = memoryStore(doc("older"));
      const floor = await refreshSecurityFloor({
        store,
        keys,
        addresses: SECURITY_FLOOR_ADDRESSES,
        fetch: feed({ [mirror]: doc(name), [github]: doc(name) }),
      });
      expect(floor?.serial).toBe(1);
      expect(held()).toBe(doc("older"));
    });
  }

  test("a first launch that has never reached the feed runs", async () => {
    const { store, held } = memoryStore();
    const floor = await refreshSecurityFloor({
      store,
      keys,
      addresses: SECURITY_FLOOR_ADDRESSES,
      fetch: feed({}),
    });
    expect(floor).toBeNull();
    expect(belowFloor(floor, "desktop", "0.0.1")).toBeNull();
    expect(held()).toBeNull();
  });

  test("the mirror missing the floor falls back to GitHub", async () => {
    const { store } = memoryStore();
    const floor = await refreshSecurityFloor({
      store,
      keys,
      addresses: SECURITY_FLOOR_ADDRESSES,
      fetch: feed({ [mirror]: 404, [github]: doc("current") }),
    });
    expect(floor?.serial).toBe(2);
  });

  test("an app built with no key reads nothing, since no floor could verify", async () => {
    const { store } = memoryStore();
    let asked = 0;
    const counting = (async () => {
      asked += 1;
      return new Response(doc("current"));
    }) as unknown as typeof fetch;
    expect(
      await refreshSecurityFloor({
        store,
        keys: [],
        addresses: SECURITY_FLOOR_ADDRESSES,
        fetch: counting,
      }),
    ).toBeNull();
    expect(asked).toBe(0);
  });

  test("a kept copy changed on the device counts for nothing", async () => {
    const { store } = memoryStore(doc("tampered"));
    expect(await heldSecurityFloor({ store, keys })).toBeNull();
  });
});
