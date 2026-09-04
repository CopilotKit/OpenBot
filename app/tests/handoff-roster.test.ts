import { describe, expect, test } from "bun:test";
import { handoffRoster } from "../src/lib/agents/handoff-roster";

/**
 * Which coworkers the handoff panel draws a switch for.
 *
 * The grants the server reports are not filtered by anybody's roster preferences, and the roster the
 * browser holds is. Joining one against the other dropped live grants off the only screen that can
 * take them away.
 */

const bot = (id: string, hidden = false) => ({
  id,
  hidden,
  name: id,
  title: `${id}'s job`,
});

describe("who the handoff panel offers a switch for", () => {
  test("offers everybody else on the roster", () => {
    const { candidates, granted, total } = handoffRoster({
      agentId: "a",
      roster: [bot("a"), bot("b"), bot("c")],
      hidden: [],
      reachable: ["b"],
      grantable: true,
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["b", "c"]);
    expect(granted).toBe(1);
    expect(total).toBe(2);
  });

  test("never offers a Bot itself, which the server refuses anyway", () => {
    const { candidates } = handoffRoster({
      agentId: "a",
      roster: [bot("a")],
      hidden: [],
      reachable: [],
      grantable: true,
    });

    expect(candidates).toEqual([]);
  });

  /*
   * The bug. Hiding is one row per person in `agent_preferences`, and the grant is a deployment-wide
   * fact an administrator set. Hide the grantee and the switch disappeared, while `mayAddress` went
   * on letting the hop through.
   */
  test("still offers a granted coworker this person has hidden, so it can be revoked", () => {
    const { candidates, granted, total } = handoffRoster({
      agentId: "a",
      roster: [bot("a"), bot("b")],
      hidden: [bot("c", true)],
      reachable: ["b", "c"],
      grantable: true,
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["b", "c"]);
    expect(granted).toBe(2);
    // And the count says two of two rather than one of one: the row is drawn, so it counts.
    expect(total).toBe(2);
  });

  test("leaves a hidden coworker hidden when nothing was granted to it", () => {
    // Hiding is a preference about clutter. This screen has no business undoing it for a coworker
    // that has nothing to withdraw.
    const { candidates, total } = handoffRoster({
      agentId: "a",
      roster: [bot("a"), bot("b")],
      hidden: [bot("c", true)],
      reachable: ["b"],
      grantable: true,
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["b"]);
    expect(total).toBe(1);
  });

  test("shows only the leftovers on a coworker that cannot hold a grant", () => {
    // Every new grant would be refused, so offering switches that can only bounce is noise. A stale
    // grant is still shown, on the roster or off it, because taking away is always allowed.
    const { candidates, granted } = handoffRoster({
      agentId: "a",
      roster: [bot("a"), bot("b"), bot("c")],
      hidden: [bot("d", true), bot("e", true)],
      reachable: ["b", "d"],
      grantable: false,
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["b", "d"]);
    expect(granted).toBe(2);
  });

  test("draws one row for a coworker that somehow appears on both lists", () => {
    // The two reads are mutually exclusive per person today. If that ever stops being true, a
    // duplicate row is a duplicate React key, which is a worse failure than a missing note.
    const { candidates, total } = handoffRoster({
      agentId: "a",
      roster: [bot("b")],
      hidden: [bot("b", true)],
      reachable: ["b"],
      grantable: true,
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["b"]);
    expect(total).toBe(1);
  });

  test("counts nothing when this coworker may ask nobody", () => {
    const { granted, total } = handoffRoster({
      agentId: "a",
      roster: [bot("a"), bot("b")],
      hidden: [],
      reachable: [],
      grantable: true,
    });

    expect(granted).toBe(0);
    expect(total).toBe(1);
  });
});
