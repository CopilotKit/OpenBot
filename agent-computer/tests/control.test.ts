import { describe, expect, test } from "bun:test";
import {
  ControlError,
  ControlRequestError,
  createControl,
  HELP_REQUEST_TTL_MS,
  SnapshotRequiredError,
} from "../src/control";

function fixture() {
  let tick = Date.parse("2026-09-26T00:00:00Z");
  const control = createControl(() => new Date(tick).toISOString());
  const advance = (ms: number) => {
    tick += ms;
  };
  const request = (toolCallId = "call-1") =>
    control.requestHelp("Sign in to continue.", toolCallId).request!;
  return { control, advance, request };
}

describe("request-aware handoff", () => {
  test("asking closes admission without granting human input", () => {
    const { control, request } = fixture();
    expect(control.get()).toMatchObject({
      holder: "bot",
      requested: false,
      transitioning: false,
      resumeSnapshotRequired: false,
    });
    const help = request();
    expect(help.status).toBe("waiting");
    expect(control.get().requested).toBe(true);
    expect(control.humanMayDrive()).toBe(false);
    expect(() => control.admitBotAction()).toThrow(ControlError);
  });

  test("take drains an old action; detector can request help inside its own lease", async () => {
    const { control, request } = fixture();
    const finish = control.admitBotAction(true);
    const help = request();
    expect(control.get().transitioning).toBe(true);
    const taking = control.take(help.id);
    await Promise.resolve();
    expect(control.humanMayDrive()).toBe(false);
    expect(() => control.admitBotAction()).toThrow(ControlError);
    finish();
    expect((await taking).holder).toBe("human");
    expect(control.get().transitioning).toBe(false);
  });

  test("only waiting expires; taken control has no ten-minute limit", async () => {
    const waiting = fixture();
    const help = waiting.request();
    waiting.advance(HELP_REQUEST_TTL_MS + 1);
    expect(waiting.control.get(help.id).request?.status).toBe("expired");
    expect(waiting.control.get().requested).toBe(false);
    expect(() => waiting.control.admitBotAction()()).not.toThrow();
    await expect(waiting.control.take(help.id)).rejects.toThrow(/no longer/);
    const taken = fixture();
    const held = taken.request();
    await taken.control.take(held.id);
    taken.advance(HELP_REQUEST_TTL_MS * 10);
    expect(taken.control.get(held.id).request?.status).toBe("taken");
    expect(taken.control.get().request?.expiresAt).toBeUndefined();
    expect(taken.control.humanMayDrive()).toBe(true);
  });

  test("completion requires fresh snapshot even on the same page; files need only ownership", async () => {
    const { control, request } = fixture();
    const help = request();
    await control.take(help.id);
    control.snapshotTaken();
    control.release(help.id);
    expect(control.get().request?.status).toBe("completed");
    expect(() => control.admitBotAction(true)).toThrow(SnapshotRequiredError);
    control.admitBotAction(false)();
    control.snapshotTaken();
    control.admitBotAction(true)();
    expect(control.release(help.id).request?.status).toBe("completed");
  });

  test("idempotency and exact historical lookup survive later requests", async () => {
    const { control, request } = fixture();
    const first = request();
    expect(request().id).toBe(first.id);
    expect(request("parallel-call").id).toBe(first.id);
    await control.take(first.id);
    await control.take(first.id);
    control.release(first.id);
    const next = request("call-2");
    expect(next.id).not.toBe(first.id);
    expect(control.get(first.id).request?.status).toBe("completed");
    expect(request().id).toBe(first.id);
    expect(request("parallel-call").id).toBe(first.id);
    expect(control.get().request?.id).toBe(next.id);
    expect(() => control.release(first.id)).toThrow(/no longer/);
    await expect(control.take(first.id)).rejects.toThrow(/no longer/);
    expect(() => control.get("unknown")).toThrow(/not found/);
  });

  test("cancel while taken preserves ownership and cannot later become completion", async () => {
    const { control, request } = fixture();
    const help = request();
    await control.take(help.id);
    expect(control.cancel(help.id).request?.status).toBe("cancelled");
    expect(control.humanMayDrive()).toBe(true);
    expect(control.release(help.id).request?.status).toBe("cancelled");
    expect(control.humanMayDrive()).toBe(false);
    expect(control.get().resumeSnapshotRequired).toBe(true);
  });

  test("cancel waiting and reset report terminal outcomes, never success", async () => {
    const { control, request } = fixture();
    const cancelled = request();
    control.cancel(cancelled.id);
    expect(() => control.release(cancelled.id)).toThrow();
    const interrupted = request("call-2");
    await control.take(interrupted.id);
    control.interrupt("The browser restarted.");
    expect(control.get(interrupted.id).request).toMatchObject({
      status: "interrupted",
      interruption: "The browser restarted.",
    });
    expect(control.humanMayDrive()).toBe(false);
    expect(() => control.admitBotAction(true)).toThrow(ControlError);
    expect(() => control.release(interrupted.id)).toThrow();
  });

  test("a request nobody took does not strand the Bot when the browser restarts", () => {
    const { control, request } = fixture();
    const unanswered = request();
    control.interrupt("The browser restarted.");
    expect(control.get(unanswered.id).request?.status).toBe("interrupted");
    // The page is as the Bot left it, so a fresh look is all it needs, not a person.
    expect(() => control.admitBotAction(true)).toThrow(SnapshotRequiredError);
    control.snapshotTaken();
    expect(() => control.admitBotAction(true)).not.toThrow();
  });

  test("reads are copies and reasons are bounded", () => {
    const { control } = fixture();
    const state = control.requestHelp("x".repeat(900));
    expect(state.reason).toHaveLength(500);
    state.request!.status = "completed";
    expect(control.get().request?.status).toBe("waiting");
    expect(createControl().requestHelp(null).reason).toBe(
      "The assistant needs a person to continue.",
    );
  });
});

describe("secret entry remains scoped and ephemeral", () => {
  test("requires a field, records only label/ref/snapshot, and clears after delivery", () => {
    const { control } = fixture();
    for (const ref of [undefined, "", " ", 7])
      expect(() => control.requestSecret({ ref })).toThrow(ControlRequestError);
    control.requestSecret({ label: " code ", ref: "e12", snapshotId: 3 });
    expect(control.pendingSecret()).toEqual({ ref: "e12", snapshotId: 3 });
    expect(control.get().secretWanted).toBe("code");
    control.secretSupplied();
    expect(control.pendingSecret()).toBeNull();
  });
  test("expires unanswered secrets and admits a fresh request afterward", () => {
    const { control, advance } = fixture();
    control.requestSecret({ ref: "e1" });
    advance(HELP_REQUEST_TTL_MS + 1);
    expect(control.pendingSecret()).toBeNull();
    expect(control.get().secretRef).toBeUndefined();
    control.requestSecret({ ref: "e2", snapshotId: "junk" });
    expect(control.pendingSecret()).toEqual({
      ref: "e2",
      snapshotId: undefined,
    });
  });
  test("take and release clear outstanding secret fields", async () => {
    const { control, request } = fixture();
    const help = request();
    control.requestSecret({ ref: "e1" });
    await control.take(help.id);
    expect(control.pendingSecret()).toBeNull();
    control.requestSecret({ ref: "e2" });
    control.release(help.id);
    expect(control.pendingSecret()).toBeNull();
  });
});
