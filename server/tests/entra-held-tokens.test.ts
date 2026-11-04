import { expect, test } from "bun:test";
import { heldTokens } from "../src/auth/entra";

/**
 * The tokens `auth/entra.ts` holds, per person and per person and system, are dropped once they
 * expire. They used to be held for the life of the process, one row for everybody ever seen.
 *
 * Lifetimes are Entra's: an access token lives 60 to 90 minutes from when it is issued.
 */

const HR = "api://hr-api/.default";
const minutes = (count: number) => count * 60_000;

test("expired tokens are dropped as new ones are written, and live ones are kept", () => {
  let clock = Date.parse("2026-11-02T09:00:00Z");
  const held = heldTokens(() => clock);
  held.set(`alice\n${HR}`, { token: "a", expiresAt: clock + minutes(62) });
  held.set(`bob\n${HR}`, { token: "b", expiresAt: clock + minutes(88) });

  // Alice's has lapsed and Bob's has not, when Cara's arrives.
  clock += minutes(70);
  held.set(`cara\n${HR}`, { token: "c", expiresAt: clock + minutes(75) });

  expect([...held.keys()]).toEqual([`bob\n${HR}`, `cara\n${HR}`]);
  expect(held.get(`alice\n${HR}`)).toBeUndefined();
});

test("a burst of writes sweeps at most once a minute", () => {
  let clock = Date.parse("2026-11-02T09:00:00Z");
  const held = heldTokens(() => clock);
  clock += minutes(2);
  held.set("alice", { token: "a", expiresAt: clock + 1_000 });

  // Expired, but the last sweep was moments ago: it waits for the next one.
  clock += 5_000;
  held.set("bob", { token: "b", expiresAt: clock + minutes(60) });
  expect([...held.keys()]).toEqual(["alice", "bob"]);

  clock += minutes(1);
  held.set("cara", { token: "c", expiresAt: clock + minutes(60) });
  expect([...held.keys()]).toEqual(["bob", "cara"]);
});
