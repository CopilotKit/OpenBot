import { describe, expect, test } from "bun:test";
import { grantRoster } from "../src/lib/agents/grant-roster";

/**
 * Which Bots a connector screen draws a row for.
 *
 * The grants the server reports are not filtered by anybody's roster preferences, and the roster the
 * browser holds is. Joining one against the other dropped live grants off the only screens that can
 * take them away. `handoff-roster.test.ts` is the same rule for the Handoff panel.
 */

const bot = (id: string, hidden = false) => ({ id, hidden, name: id });

describe("who a connector screen draws a row for", () => {
  test("draws everybody on the roster, holding a grant or not", () => {
    const rows = grantRoster({
      roster: [bot("a"), bot("b")],
      hidden: [],
      holders: ["a"],
    });

    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
  });

  /*
   * The bug. Hiding is one row per person in `agent_preferences`, and a grant is a deployment-wide
   * fact an administrator set. Hide the grantee and its switches disappeared while the grant stayed
   * in force.
   */
  test("still draws a hidden Bot that holds a grant, after the roster, so it can be revoked", () => {
    const rows = grantRoster({
      roster: [bot("a")],
      hidden: [bot("c", true), bot("d", true)],
      holders: ["c"],
    });

    expect(rows.map((row) => row.id)).toEqual(["a", "c"]);
    expect(rows[1]?.hidden).toBe(true);
  });

  test("leaves a hidden Bot that holds nothing hidden", () => {
    const rows = grantRoster({
      roster: [bot("a")],
      hidden: [bot("d", true)],
      holders: ["a"],
    });

    expect(rows.map((row) => row.id)).toEqual(["a"]);
  });

  test("never draws a Bot twice", () => {
    const rows = grantRoster({
      roster: [bot("a")],
      hidden: [bot("a", true)],
      holders: ["a", "a"],
    });

    expect(rows.map((row) => row.id)).toEqual(["a"]);
  });
});
