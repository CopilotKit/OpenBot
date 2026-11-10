import { describe, expect, test } from "bun:test";
import {
  applyCapabilityChanges,
  type CapabilityChange,
  changesWarning,
  checkCapabilityChanges,
  MAX_CAPABILITY_CHANGES,
  outcomeLines,
} from "../src/admin/capability-changes";
import recorded from "./fixtures/who-can-recorded.json";

/**
 * The gate every permission change passes before it is read, previewed or saved: real permissions,
 * real roles and groups, and nothing the rule ignores. The inputs are the changes real models wrote
 * (`fixtures/who-can-recorded.json`) and the mistakes the gate exists for: a group's off switch, a
 * group named the way people say it rather than the way the directory spells it, a role called
 * "members", and a permission called by its title.
 */

const GROUPS = ["Contractors", "Engineering", "Field Sales (EMEA)", "Sales"];

const setting = { on: true, off: false, inherit: null } as const;
/** A recorded writer answer as the route turns it into changes. */
function written(answer: string): CapabilityChange[] {
  return (
    JSON.parse(answer) as {
      changes: {
        scopeKind: CapabilityChange["scopeKind"];
        scopeId: string;
        capability: string;
        setting: keyof typeof setting;
      }[];
    }
  ).changes.map((change) => ({
    scopeKind: change.scopeKind,
    scopeId: change.scopeKind === "organization" ? "" : change.scopeId,
    capability: change.capability,
    allowed: setting[change.setting],
  }));
}

const trap = written(recorded.trap.writer[0] as string);
const inversion = written(recorded.readingCatchesInversion.writer[0] as string);

describe("checkCapabilityChanges", () => {
  test("the changes real models wrote check", () => {
    expect(checkCapabilityChanges(trap, GROUPS)).toEqual({ ok: true });
    expect(checkCapabilityChanges(inversion, GROUPS)).toEqual({ ok: true });
  });

  test("a group's off switch is refused, with how to take a permission from a group instead", () => {
    const check = checkCapabilityChanges(
      [
        {
          scopeKind: "group",
          scopeId: "Contractors",
          capability: "localComputer",
          allowed: false,
        },
      ],
      GROUPS,
    );
    expect(check).toEqual({
      ok: false,
      error:
        'Change 1: A group can only turn a permission on, so off for the group "Contractors" changes nothing. To take it from a group, turn it off for everybody or for a role, then turn it on for every other group.',
      problems: [
        {
          change: 1,
          field: "allowed",
          message:
            'A group can only turn a permission on, so off for the group "Contractors" changes nothing. To take it from a group, turn it off for everybody or for a role, then turn it on for every other group.',
        },
      ],
    });
    // Removing a group's switch is allowed: it takes back a grant.
    expect(
      checkCapabilityChanges(
        [
          {
            scopeKind: "group",
            scopeId: "Contractors",
            capability: "localComputer",
            allowed: null,
          },
        ],
        GROUPS,
      ),
    ).toEqual({ ok: true });
  });

  test("every mistake in one answer is named, so one retry can fix them all", () => {
    const check = checkCapabilityChanges(
      [
        // The way people say it, not the way the directory spells it.
        {
          scopeKind: "group",
          scopeId: "field sales",
          capability: "passwordManager",
          allowed: true,
        },
        {
          scopeKind: "role",
          scopeId: "members",
          capability: "teamBots",
          allowed: false,
        },
        // The title on the screen, not the permission's name.
        {
          scopeKind: "organization",
          scopeId: "",
          capability: "Local computer access",
          allowed: false,
        },
        {
          scopeKind: "group",
          scopeId: "Sales",
          capability: "localComputer",
          allowed: true,
        },
        {
          scopeKind: "group",
          scopeId: "Sales",
          capability: "localComputer",
          allowed: null,
        },
      ],
      GROUPS,
    );
    expect(check.ok).toBeFalse();
    if (check.ok) return;
    expect(check.problems).toEqual([
      {
        change: 1,
        field: "scope",
        message:
          'There\'s no group called "field sales". The groups are "Contractors", "Engineering", "Field Sales (EMEA)", "Sales".',
      },
      {
        change: 2,
        field: "scope",
        message: 'A role is "admin" or "user", not "members".',
      },
      {
        change: 3,
        field: "capability",
        message:
          '"Local computer access" isn\'t a permission here. The permissions are "useBots", "cloudBrowser", "cloudNetwork", "cloudComputer", "localComputer", "customRules", "passwordManager", "slackTeams", "teamBots", "ownerApps", "isolatedComputers", "proactive".',
      },
      {
        change: 5,
        field: "scope",
        message: "It sets the same switch as change 4.",
      },
    ]);
    // The error the model is sent back is every problem, numbered as the changes are.
    expect(check.error).toStartWith(
      'Change 1: There\'s no group called "field sales".',
    );
    expect(check.error).toContain(
      'Change 2: A role is "admin" or "user", not "members".',
    );
  });

  test("an OpenBot with no groups says so when a change names one", () => {
    const check = checkCapabilityChanges(
      [
        {
          scopeKind: "group",
          scopeId: "Contractors",
          capability: "localComputer",
          allowed: true,
        },
      ],
      [],
    );
    expect(check.ok ? "" : check.error).toBe(
      'Change 1: There\'s no group called "Contractors". OpenBot has no groups yet.',
    );
  });

  test("no changes, and more than one description's worth, are refused", () => {
    expect(checkCapabilityChanges([], GROUPS)).toEqual({
      ok: false,
      error: "No changes were written.",
      problems: [],
    });
    const many = Array.from(
      { length: MAX_CAPABILITY_CHANGES + 1 },
      (_, index): CapabilityChange => ({
        scopeKind: "group",
        scopeId: `Team ${index}`,
        capability: "teamBots",
        allowed: true,
      }),
    );
    expect(checkCapabilityChanges(many, GROUPS).ok).toBeFalse();
  });
});

describe("what the changes come to", () => {
  test("the trap's changes leave Contractors out, by the resolver, and leave nobody without it", () => {
    const after = applyCapabilityChanges([], trap);
    expect(outcomeLines([], after, trap, GROUPS)).toEqual([
      "Local computer access:",
      "- Admins in no group that gives it: on before, off after.",
      "- Members in no group that gives it: on before, off after.",
      "- Groups that give it to their members whatever the organization or role says: none before; Engineering, Field Sales (EMEA), Sales after.",
      "- Groups that don't give it, after: Contractors.",
    ]);
    expect(changesWarning(after, trap, GROUPS)).toBeNull();
  });

  test("taking a permission from everybody with no group to give it back is warned about", () => {
    const changes: CapabilityChange[] = [
      {
        scopeKind: "organization",
        scopeId: "",
        capability: "localComputer",
        allowed: false,
      },
      {
        scopeKind: "group",
        scopeId: "Engineering",
        capability: "localComputer",
        allowed: null,
      },
    ];
    const before = applyCapabilityChanges(
      [],
      [
        {
          scopeKind: "group",
          scopeId: "Engineering",
          capability: "localComputer",
          allowed: true,
        },
      ],
    );
    const after = applyCapabilityChanges(before, changes);
    expect(after).toEqual([
      {
        scopeKind: "organization",
        scopeId: "",
        capability: "localComputer",
        allowed: false,
      },
    ]);
    expect(changesWarning(after, changes, GROUPS)).toBe(
      'After this, nobody has "Local computer access".',
    );
  });
});
