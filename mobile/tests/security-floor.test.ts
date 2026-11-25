/**
 * OpenBot Mobile's security floor. Metro bundles only mobile/, so the app carries its own copy of
 * shared/security-floor.ts; this holds the copy to the original and drives the phone's decision
 * through the same signed documents the other apps read (shared/fixtures/security-floor/cases.json).
 *
 * The phone verifies with @noble/curves (Hermes has no WebCrypto Ed25519), so the noble verifier is
 * checked against every fixture and against WebCrypto, and once more with no random source at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import cases from "../../shared/fixtures/security-floor/cases.json";
import {
  type FloorStore,
  verifySecurityFloor,
  webCryptoVerify,
} from "../src/security-floor";
import { SECURITY_FLOOR_ADDRESSES } from "../src/security-floor-addresses";
import {
  floorDecision,
  heldFloorDecision,
  nobleVerify,
  refreshedFloorDecision,
} from "../src/security-floor-check";

const REPO = join(import.meta.dir, "..", "..");
const keys = [cases.publicKey];
const CLOUD = "https://cloud.openbot.example";
const COMPANY = "https://openbot.acme.example";

function doc(name: string): string {
  const found = cases.cases.find((c) => c.name === name);
  if (!found) throw new Error(`no case ${name}`);
  return found.document;
}

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

/** A feed that answers each address from `answers` and fails any it doesn't list, as offline does. */
function feed(answers: Record<string, string>) {
  const asked: string[] = [];
  const get = (async (input: string | URL | Request) => {
    asked.push(String(input));
    const answer = answers[String(input)];
    if (answer === undefined) throw new TypeError("Network request failed");
    return new Response(answer, { status: 200 });
  }) as typeof fetch;
  return { fetch: get, asked };
}

const [mirror, github] = SECURITY_FLOOR_ADDRESSES as [string, string];
const phone = (release: string, origin = CLOUD) => ({
  origin,
  release,
  keys,
});

test("OpenBot Mobile's copies of the floor rule and its keys are the shared ones, byte for byte", () => {
  for (const name of ["security-floor.ts", "security-floor.json"]) {
    const copy = readFileSync(join(REPO, "mobile", "src", name));
    const original = readFileSync(join(REPO, "shared", name));
    expect({ name, same: copy.equals(original) }).toEqual({ name, same: true });
  }
});

describe("the phone's Ed25519", () => {
  for (const c of cases.cases)
    test(`${c.name} ${c.verifies ? "verifies" : "is ignored"}, as WebCrypto decides`, async () => {
      const noble = await verifySecurityFloor(c.document, keys, nobleVerify);
      const webCrypto = await verifySecurityFloor(
        c.document,
        keys,
        webCryptoVerify,
      );
      expect(noble.ok).toBe(c.verifies);
      expect(noble).toEqual(webCrypto);
    });

  test("verifies with no random source, as on a phone without getRandomValues", async () => {
    const script = [
      "Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });",
      `const { verifySecurityFloor } = await import(${JSON.stringify(join(REPO, "mobile", "src", "security-floor.ts"))});`,
      `const { nobleVerify } = await import(${JSON.stringify(join(REPO, "mobile", "src", "security-floor-check.ts"))});`,
      `const cases = await Bun.file(${JSON.stringify(join(REPO, "shared", "fixtures", "security-floor", "cases.json"))}).json();`,
      "const results = [];",
      "for (const c of cases.cases) results.push((await verifySecurityFloor(c.document, [cases.publicKey], nobleVerify)).ok === c.verifies);",
      "console.log(JSON.stringify({ crypto: typeof globalThis.crypto, results }));",
    ].join("\n");
    const run = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: join(REPO, "mobile"),
    });
    const out = run.stdout.toString().trim();
    expect({ exit: run.exitCode, stderr: run.stderr.toString() }).toEqual({
      exit: 0,
      stderr: "",
    });
    expect(JSON.parse(out)).toEqual({
      crypto: "undefined",
      results: cases.cases.map(() => true),
    });
  });
});

describe("whether OpenBot Mobile stops", () => {
  test("below the floor it stops and names the release to update to; at or above it runs", async () => {
    const current = await verifySecurityFloor(
      doc("current"),
      keys,
      nobleVerify,
    );
    if (!current.ok) throw new Error(current.reason);
    expect(floorDecision(current.floor, phone("1.1.1"))).toEqual({
      blocked: true,
      update: "1.1.2",
    });
    expect(floorDecision(current.floor, phone("1.1.2"))).toEqual({
      blocked: false,
    });
    expect(floorDecision(current.floor, phone("1.3.0"))).toEqual({
      blocked: false,
    });
    const { store } = memoryStore();
    expect(
      await refreshedFloorDecision({
        ...phone("1.1.1"),
        store,
        fetch: feed({ [mirror]: doc("current") }).fetch,
      }),
    ).toEqual({ blocked: true, update: "1.1.2" });
  });

  test("an app built for a company's own OpenBot ignores the floor", async () => {
    const { store } = memoryStore();
    expect(
      await refreshedFloorDecision({
        ...phone("0.0.1", COMPANY),
        store,
        fetch: feed({ [mirror]: doc("current") }).fetch,
      }),
    ).toEqual({ blocked: false });
    expect(
      await heldFloorDecision({ ...phone("0.0.1", COMPANY), store }),
    ).toEqual({ blocked: false });
  });

  test("offline, the floor it kept still stops it, at launch and on every check", async () => {
    const { store, held } = memoryStore();
    await refreshedFloorDecision({
      ...phone("1.1.1"),
      store,
      fetch: feed({ [mirror]: doc("current") }).fetch,
    });
    expect(held()).toBe(doc("current"));
    expect(await heldFloorDecision({ ...phone("1.1.1"), store })).toEqual({
      blocked: true,
      update: "1.1.2",
    });
    expect(
      await refreshedFloorDecision({
        ...phone("1.1.1"),
        store,
        fetch: feed({}).fetch,
      }),
    ).toEqual({ blocked: true, update: "1.1.2" });
  });

  for (const name of ["unsigned", "zero signature", "tampered", "other key"])
    test(`a ${name} floor changes nothing`, async () => {
      const { store, held } = memoryStore();
      const offered = doc(name);
      expect(
        await refreshedFloorDecision({
          ...phone("1.1.1"),
          store,
          fetch: feed({ [mirror]: offered, [github]: offered }).fetch,
        }),
      ).toEqual({ blocked: false });
      expect(held()).toBeNull();
    });

  test("a lower serial can't lift a block, and a changed kept copy counts for nothing", async () => {
    const { store, held } = memoryStore(doc("current"));
    expect(
      await refreshedFloorDecision({
        ...phone("1.1.1"),
        store,
        fetch: feed({ [mirror]: doc("older") }).fetch,
      }),
    ).toEqual({ blocked: true, update: "1.1.2" });
    expect(held()).toBe(doc("current"));
    const changed = memoryStore(doc("tampered"));
    expect(
      await heldFloorDecision({ ...phone("0.0.1"), store: changed.store }),
    ).toEqual({ blocked: false });
  });

  test("a first launch that never reached the feed runs", async () => {
    const { store, held } = memoryStore();
    const { fetch, asked } = feed({});
    expect(
      await refreshedFloorDecision({ ...phone("0.0.1"), store, fetch }),
    ).toEqual({ blocked: false });
    expect(asked).toEqual([mirror, github]);
    expect(held()).toBeNull();
  });

  test("a build that names no release runs", async () => {
    const current = await verifySecurityFloor(
      doc("current"),
      keys,
      nobleVerify,
    );
    if (!current.ok) throw new Error(current.reason);
    expect(
      floorDecision(current.floor, { origin: CLOUD, release: undefined }),
    ).toEqual({ blocked: false });
  });
});

describe("on React Native's AbortSignal, which has no timeout", () => {
  const timeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  afterEach(() => {
    if (timeout) Object.defineProperty(AbortSignal, "timeout", timeout);
  });

  test("the floor is still read, and still stops a build below it", async () => {
    Object.defineProperty(AbortSignal, "timeout", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const { store } = memoryStore();
    const { fetch, asked } = feed({ [mirror]: doc("current") });
    expect(
      await refreshedFloorDecision({ ...phone("1.1.1"), store, fetch }),
    ).toEqual({ blocked: true, update: "1.1.2" });
    expect(asked).toEqual([mirror]);
  });
});
