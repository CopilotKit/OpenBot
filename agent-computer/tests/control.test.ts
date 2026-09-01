import { describe, expect, test } from "bun:test";
import {
  CONTROL_ALREADY_HELD,
  CONTROL_LEASE_REQUIRED,
  ControlError,
  ControlRequestError,
  createControl,
} from "../src/control";

const LEASE_A = "a".repeat(43);
const LEASE_B = "b".repeat(43);
const LEASE_UNTIL = "2026-08-14T00:10:00.000Z";

/**
 * The wheel, tested on both paths.
 *
 * This is the piece standing between two drivers and one page, and until now it had no tests at all, * it lived as a `let` inside the file that imports playwright, so a test could not reach it without
 * launching Chrome. What is checked here is mostly the refusal path, because that is where this
 * component earns its keep: a Bot clicking while a person types, a secret typed when nothing asked for
 * one, a request answered twice, a handover that leaves a password box open behind it.
 *
 * A fake clock is injected so `since` can be asserted rather than shrugged at.
 */
function fixture() {
  let tick = 0;
  const start = Date.parse("2026-08-14T00:00:00.000Z");
  const control = createControl(() => {
    tick += 1;
    return new Date(start + tick * 1_000).toISOString();
  });
  return { control };
}

describe("the happy path: ask, hand over, hand back", () => {
  test("starts with the Bot driving and nothing pending", () => {
    const { control } = fixture();
    const state = control.get();
    expect(state.holder).toBe("bot");
    expect(state.requested).toBe(false);
    expect(state.reason).toBeUndefined();
    expect(control.pendingSecret()).toBeNull();
    // Nothing to refuse yet.
    expect(() => control.assertBotMayAct()).not.toThrow();
  });

  test("the Bot asking for help does NOT hand itself the human's authority", () => {
    const { control } = fixture();
    const state = control.requestHelp("There is a login wall.");
    // The flag is raised and a person decides. A Bot that could take control on its own behalf could
    // also hand a person a page they never asked to see.
    expect(state.requested).toBe(true);
    expect(state.reason).toBe("There is a login wall.");
    expect(state.holder).toBe("bot");
    // And it may still act while it waits: asking is not being blocked.
    expect(() => control.assertBotMayAct()).not.toThrow();
  });

  test("taking the wheel keeps the reason and lowers the flag", () => {
    const { control } = fixture();
    control.requestHelp("Sign in to continue.");
    const state = control.take(LEASE_A, LEASE_UNTIL);
    expect(state.holder).toBe("human");
    // The reason survives, because it is the thing the person was just asked to do.
    expect(state.reason).toBe("Sign in to continue.");
    // The request is answered, so the surface stops asking.
    expect(state.requested).toBe(false);
    expect(control.humanMayDrive(LEASE_A)).toBe(true);
  });

  test("handing back returns the wheel and clears the old request", () => {
    const { control } = fixture();
    control.requestHelp("Sign in to continue.");
    control.take(LEASE_A, LEASE_UNTIL);
    const state = control.release(LEASE_A);
    expect(state.holder).toBe("bot");
    // Dropped on purpose: leaving it set has the surface still showing a request that was dealt with.
    expect(state.reason).toBeUndefined();
    expect(state.requested).toBe(false);
    expect(control.humanMayDrive(LEASE_A)).toBe(false);
    expect(() => control.assertBotMayAct()).not.toThrow();
  });

  test("`since` moves on a handover and not on a request", () => {
    const { control } = fixture();
    const created = control.get().since;
    control.requestHelp("Stuck.");
    // Asking for help is not a change of driver, so the clock does not restart.
    expect(control.get().since).toBe(created);
    expect(control.take(LEASE_A, LEASE_UNTIL).since).not.toBe(created);
  });
});

describe("the crappy paths: two drivers, one page", () => {
  test("the Bot is refused while a person holds the wheel", () => {
    const { control } = fixture();
    control.take(LEASE_A, LEASE_UNTIL);
    expect(() => control.assertBotMayAct()).toThrow(ControlError);
    // Refused with a reason the Bot can act on, wait, rather than a bare failure.
    expect(() => control.assertBotMayAct()).toThrow(/hand it back/);
  });

  test("the refusal lifts the moment the person hands back", () => {
    const { control } = fixture();
    control.take(LEASE_A, LEASE_UNTIL);
    control.release(LEASE_A);
    expect(() => control.assertBotMayAct()).not.toThrow();
  });

  test("a person's input is not applied merely because they asked", () => {
    const { control } = fixture();
    control.requestHelp("Sign in.");
    // The Bot asked for help and no person has taken the wheel. An open socket is not permission: this is
    // what stops anything that can reach the port from driving the browser mid-task.
    expect(control.humanMayDrive(LEASE_A)).toBe(false);
  });

  test("taking the wheel twice is not a way to lose the reason", () => {
    const { control } = fixture();
    control.requestHelp("Sign in.");
    control.take(LEASE_A, LEASE_UNTIL);
    const state = control.take(LEASE_A, LEASE_UNTIL);
    expect(state.holder).toBe("human");
    expect(state.reason).toBe("Sign in.");
  });

  test("handing back when the Bot already has it is harmless", () => {
    const { control } = fixture();
    const state = control.release(LEASE_A);
    expect(state.holder).toBe("bot");
    expect(() => control.assertBotMayAct()).not.toThrow();
  });

  test("the caller cannot reach in and change the state it was handed", () => {
    const { control } = fixture();
    const state = control.get();
    state.holder = "human";
    // A copy, so reading the state is not a way to take the wheel.
    expect(control.get().holder).toBe("bot");
  });

  test("junk reasons fall back to something a person can read", () => {
    const { control } = fixture();
    // The wire carries whatever the caller sent. An empty or non-string reason must not leave the
    // person staring at a blank explanation of why they have just been handed a browser.
    for (const junk of ["", "   ", null, undefined, 42, {}]) {
      const { control: fresh } = fixture();
      expect(fresh.requestHelp(junk).reason).toBe(
        "The assistant needs a person to continue.",
      );
    }
    expect(control.requestHelp("  Trimmed.  ").reason).toBe("Trimmed.");
  });
});

describe("the crappy paths: secrets", () => {
  test("a secret request must name the field it goes in", () => {
    const { control } = fixture();
    // The version without this typed the value into whatever happened to have focus, and reported
    // success when that was nothing at all.
    for (const bad of [{}, { ref: "" }, { ref: "   " }, { ref: 7 }]) {
      expect(() => control.requestSecret(bad)).toThrow(ControlRequestError);
    }
    // A request error, not a control refusal: the caller asked wrongly and no driver changed.
    expect(() => control.requestSecret({})).toThrow(/which field/);
    expect(control.pendingSecret()).toBeNull();
  });

  test("a secret request records the label and the field, and nothing else", () => {
    const { control } = fixture();
    const state = control.requestSecret({
      label: "  the six-digit code  ",
      ref: "e12",
      snapshotId: 3,
    });
    expect(state.secretWanted).toBe("the six-digit code");
    expect(state.secretRef).toBe("e12");
    expect(state.secretSnapshotId).toBe(3);
    expect(control.pendingSecret()).toEqual({ ref: "e12", snapshotId: 3 });
  });

  test("an unlabelled request still says something honest", () => {
    const { control } = fixture();
    expect(control.requestSecret({ ref: "e1" }).secretWanted).toBe(
      "the value this page is asking for",
    );
  });

  test("a non-numeric snapshotId is dropped rather than carried as junk", () => {
    const { control } = fixture();
    const state = control.requestSecret({ ref: "e1", snapshotId: "3" });
    // Carried through to `locateRef`, where a string would prevent the numeric staleness check from
    // matching and could let a stale field accept the secret.
    expect(state.secretSnapshotId).toBeUndefined();
  });

  test("nothing is pending until the Bot asks", () => {
    const { control } = fixture();
    // What makes the masked box scoped rather than a general-purpose way to type into the page.
    expect(control.pendingSecret()).toBeNull();
  });

  test("a supplied secret closes the request, so it cannot be answered twice", () => {
    const { control } = fixture();
    control.requestSecret({ ref: "e12", label: "code" });
    control.secretSupplied();
    expect(control.pendingSecret()).toBeNull();
    expect(control.get().secretWanted).toBeUndefined();
    expect(control.get().secretRef).toBeUndefined();
  });

  test("a FAILED attempt leaves the request open", () => {
    const { control } = fixture();
    control.requestSecret({ ref: "e12", label: "code" });
    // `secretSupplied` is called only after the value reached the field, so a field that could not be
    // found leaves this pending and the person can try again instead of starting over.
    expect(control.pendingSecret()).not.toBeNull();
  });

  test("handing the wheel over or back closes any pending secret", () => {
    for (const handover of ["take", "release"] as const) {
      const { control } = fixture();
      control.requestSecret({ ref: "e12", label: "password" });
      if (handover === "take") {
        control.take(LEASE_A, LEASE_UNTIL);
      } else {
        control.release(LEASE_A);
      }
      // A person who drove the browser themselves has dealt with the login. A masked box still asking
      // for a password afterwards is asking for a secret nothing is waiting for.
      expect(control.pendingSecret()).toBeNull();
      expect(control.get().secretWanted).toBeUndefined();
    }
  });

  test("the secret VALUE is never anywhere in the state", () => {
    const { control } = fixture();
    control.requestSecret({ ref: "e12", label: "one-time code" });
    // The machine has no field that could hold it, and this test exists to fail if one is ever added.
    // The value passes through a single request, into the page, and is not kept.
    const serialised = JSON.stringify(control.get());
    expect(serialised).not.toContain("value:");
    expect(
      Object.keys(control.get())
        .filter((k) => /secret/i.test(k))
        .sort(),
    ).toEqual(["secretRef", "secretSnapshotId", "secretWanted"]);
  });
});

/**
 * A request nobody answered does not outlive the run that made it.
 *
 * Control belongs to the computer, not to a conversation, and an unanswered request used to sit on
 * it forever. The run that asked had ended, but every later conversation with that Bot showed a live
 * "Take control" for work it was not doing — and showed the reason the Bot gave, which is written
 * for whoever asked and was being rendered to whoever looked.
 *
 * Seen in the product: a brand new channel, on an unrelated question, displaying "Google Docs is
 * asking for sign-in before I can read the PRD document" from a conversation minutes earlier.
 */
describe("an unanswered request to take the wheel", () => {
  test("is still shown inside the window", () => {
    let clock = "2026-08-22T03:00:00.000Z";
    const control = createControl(() => clock);
    control.requestHelp("sign in to Drive");

    clock = "2026-08-22T03:05:00.000Z";
    const state = control.get();
    expect(state.requested).toBe(true);
    expect(state.reason).toBe("sign in to Drive");
  });

  test("stops being shown once it is stale, and takes its reason with it", () => {
    let clock = "2026-08-22T03:00:00.000Z";
    const control = createControl(() => clock);
    control.requestHelp("sign in to Drive");

    clock = "2026-08-22T03:20:00.000Z";
    const state = control.get();
    expect(state.requested).toBe(false);
    // The reason is the part that leaked between conversations, so it goes too.
    expect(state.reason).toBeUndefined();
  });

  test("keeps the wheel while the browser renews its lease", () => {
    /*
     * The one case that must not expire. Somebody may be halfway through typing a code, and pulling
     * the browser back mid-sign-in is worse than any stale prompt. Only the ASK times out.
     */
    let clock = "2026-08-22T03:00:00.000Z";
    const control = createControl(() => clock);
    control.requestHelp("sign in to Drive");
    control.take(LEASE_A, "2026-08-22T03:02:00.000Z");

    clock = "2026-08-22T03:01:00.000Z";
    control.renew(LEASE_A, "2026-08-22T03:03:00.000Z");
    clock = "2026-08-22T03:02:30.000Z";
    expect(control.get().holder).toBe("human");
  });
});

describe("a control lease belongs to one browser session", () => {
  test("a second lease cannot take, drive, renew, or release the first session", () => {
    const { control } = fixture();
    control.take(LEASE_A, LEASE_UNTIL);

    expect(() => control.take(LEASE_B, LEASE_UNTIL)).toThrow(
      CONTROL_ALREADY_HELD,
    );
    expect(control.humanMayDrive(LEASE_B)).toBe(false);
    expect(() => control.renew(LEASE_B, LEASE_UNTIL)).toThrow(
      CONTROL_LEASE_REQUIRED,
    );
    expect(() => control.release(LEASE_B)).toThrow(CONTROL_LEASE_REQUIRED);
    expect(control.humanMayDrive(LEASE_A)).toBe(true);
  });

  test("an expired browser lease returns control to the Bot", () => {
    let clock = "2026-08-22T03:00:00.000Z";
    const control = createControl(() => clock);
    control.take(LEASE_A, "2026-08-22T03:01:00.000Z");

    clock = "2026-08-22T03:01:01.000Z";
    expect(control.get().holder).toBe("bot");
    expect(control.humanMayDrive(LEASE_A)).toBe(false);
  });

  test("an expired lease cannot block the Bot when no browser remains to poll state", () => {
    let clock = "2026-08-22T03:00:00.000Z";
    const control = createControl(() => clock);
    control.take(LEASE_A, "2026-08-22T03:01:00.000Z");

    clock = "2026-08-22T03:01:01.000Z";
    expect(() => control.assertBotMayAct()).not.toThrow();
    expect(control.get().holder).toBe("bot");
  });

  test("stopping the controlled browser revokes its lease", () => {
    const { control } = fixture();
    control.take(LEASE_A, LEASE_UNTIL);

    expect(control.revoke().holder).toBe("bot");
    expect(control.humanMayDrive(LEASE_A)).toBe(false);
  });
});
