// server/tests/shared-use.test.ts
import { describe, expect, test } from "bun:test";
import {
  admits, asSharedUseApproval, type BotFacts, covers, exposureOf, type SharedUseApproval, steeringOf,
} from "../src/plugins/shared-use";

const sources = (map: Record<string, string[]>) => async (id: string) => map[id] ?? [];
const owner = "u_owner";
const actor = (actorId: string, groups: string[] = [], isAdmin = false) => ({ actorId, groups, isAdmin });
const approval = (over: Partial<SharedUseApproval>): SharedUseApproval => ({
  audience: "owner", outsideInput: false, members: [], ...over,
});

describe("steeringOf", () => {
  test("a person, a routine and a memory sync are steered by the actor, from inside", async () => {
    for (const initiator of [undefined, { kind: "person" } as const, { kind: "routine", id: "x" } as const, { kind: "memory", id: "m" } as const]) {
      expect(await steeringOf(initiator, sources({}))).toEqual({ kind: "actor", outside: false });
    }
  });

  test("a responsibility is outside input when any of its sources is not manual or schedule", async () => {
    const lookup = sources({ quiet: ["schedule", "manual"], loud: ["schedule", "email"], future: ["carrier-pigeon"] });
    expect(await steeringOf({ kind: "responsibility", id: "quiet" }, lookup)).toEqual({ kind: "actor", outside: false });
    expect(await steeringOf({ kind: "responsibility", id: "loud" }, lookup)).toEqual({ kind: "actor", outside: true });
    expect(await steeringOf({ kind: "responsibility", id: "future" }, lookup)).toEqual({ kind: "actor", outside: true });
  });

  test("a handoff is steered by its origin, however deep", async () => {
    const lookup = sources({ loud: ["email"] });
    expect(await steeringOf({ kind: "handoff", id: "b", origin: { kind: "responsibility", id: "loud" } }, lookup))
      .toEqual({ kind: "actor", outside: true });
    expect(await steeringOf({ kind: "handoff", id: "b", origin: { kind: "person" } }, lookup))
      .toEqual({ kind: "actor", outside: false });
  });

  test("a handoff that lost its origin, the deployment, and anything unknown are refused", async () => {
    for (const initiator of [{ kind: "handoff", id: "b" }, { kind: "deployment" }, { kind: "robot" }] as never[]) {
      expect((await steeringOf(initiator, sources({}))).kind).toBe("refuse");
    }
  });
});

describe("admits", () => {
  test("the owner and an administrator are inside every audience", () => {
    expect(admits(approval({ audience: "owner" }), owner, actor(owner), { outside: false })).toBe(true);
    expect(admits(approval({ audience: "owner" }), owner, actor("u_admin", [], true), { outside: false })).toBe(true);
  });

  test("owner-only refuses anyone else", () => {
    expect(admits(approval({ audience: "owner" }), owner, actor("u_other"), { outside: false })).toBe(false);
  });

  test("people admits listed people and members of listed groups, and nobody added later", () => {
    const people = approval({ audience: "people", members: [{ kind: "user", value: "u_named" }, { kind: "group", value: "platform" }] });
    expect(admits(people, owner, actor("u_named"), { outside: false })).toBe(true);
    expect(admits(people, owner, actor("u_new_hire", ["platform"]), { outside: false })).toBe(true);
    expect(admits(people, owner, actor("u_added_later"), { outside: false })).toBe(false);
  });

  test("team admits any signed-in person", () => {
    expect(admits(approval({ audience: "team" }), owner, actor("u_anyone"), { outside: false })).toBe(true);
  });

  test("outside input needs outsideInput, even for the owner", () => {
    expect(admits(approval({ audience: "team" }), owner, actor(owner), { outside: true })).toBe(false);
    expect(admits(approval({ audience: "owner", outsideInput: true }), owner, actor(owner), { outside: true })).toBe(true);
  });
});

describe("exposureOf", () => {
  const bot = (over: Partial<BotFacts>): BotFacts => ({
    ownerUserId: owner, visibility: "private", publication: null, assignments: [], sources: [], ...over,
  });

  test("a private unpublished Bot is exposed to its owner only", () => {
    expect(exposureOf(bot({}))).toEqual({ audience: "owner", outsideInput: false, members: [] });
  });

  test("public, published to the team, or assigned to * is the whole team", () => {
    expect(exposureOf(bot({ visibility: "public" })).audience).toBe("team");
    expect(exposureOf(bot({ publication: { audience: "team", members: [] } })).audience).toBe("team");
    expect(exposureOf(bot({ assignments: ["*"] })).audience).toBe("team");
  });

  test("named publication and group assignments combine into people", () => {
    expect(exposureOf(bot({
      publication: { audience: "people", members: [{ kind: "user", value: "u1" }] },
      assignments: ["platform"],
    }))).toEqual({
      audience: "people", outsideInput: false,
      members: [{ kind: "user", value: "u1" }, { kind: "group", value: "platform" }],
    });
  });

  test("any outside source makes it outside input", () => {
    expect(exposureOf(bot({ sources: ["schedule", "slack"] })).outsideInput).toBe(true);
  });
});

describe("covers", () => {
  test("nothing approved covers nothing", () => {
    expect(covers(null, approval({}))).toBe(false);
  });
  test("a wider audience covers a narrower one, never the reverse", () => {
    expect(covers(approval({ audience: "team" }), approval({ audience: "people", members: [{ kind: "user", value: "u" }] }))).toBe(true);
    expect(covers(approval({ audience: "people" }), approval({ audience: "team" }))).toBe(false);
  });
  test("people covers people only when every needed member was approved", () => {
    const approved = approval({ audience: "people", members: [{ kind: "group", value: "platform" }] });
    expect(covers(approved, approval({ audience: "people", members: [{ kind: "group", value: "platform" }] }))).toBe(true);
    expect(covers(approved, approval({ audience: "people", members: [{ kind: "group", value: "sales" }] }))).toBe(false);
  });
  test("outside input is covered only by outsideInput", () => {
    expect(covers(approval({ audience: "team" }), approval({ outsideInput: true }))).toBe(false);
  });
});

describe("asSharedUseApproval", () => {
  test("reads a well-formed approval and refuses anything else", () => {
    expect(asSharedUseApproval({ audience: "people", outsideInput: false, members: [{ kind: "group", value: "x" }] }))
      .toEqual({ audience: "people", outsideInput: false, members: [{ kind: "group", value: "x" }] });
    expect(asSharedUseApproval({ audience: "everyone", outsideInput: false })).toBeNull();
    expect(asSharedUseApproval({ audience: "team" })).toBeNull();
    expect(asSharedUseApproval({ audience: "people", outsideInput: false, members: [{ kind: "role", value: "x" }] })).toBeNull();
  });
});
