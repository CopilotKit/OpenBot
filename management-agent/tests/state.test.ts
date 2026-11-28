/**
 * The agent's state and the promotion journal live in the same ConfigMap. Both saves read every key
 * before writing every key back, so a journal write overlapping a state write can revert the other
 * one — including turning an `accepted` journal back into a blocking phase after a restart.
 */
import { describe, expect, test } from "bun:test";
import type { PromotionJournal } from "../../shared/kubernetes-promotion";
import type { Kube } from "../src/kube";
import { EMPTY_STATE, StateStore, type AgentState } from "../src/state";

const NAMESPACE = "openbot-system";
const NAME = "openbot-agent-state";

function journal(phase: PromotionJournal["phase"]): PromotionJournal {
  return {
    operation: "upgrade",
    phase,
    fromVersion: "v1.1.0",
    toVersion: "v1.1.1",
    namespace: "openbot",
    release: "openbot",
    backupReference: "backup-1",
    databaseMayHaveChanged: true,
    recovery: "inspect the rollout",
  };
}

const verifying = journal("verifying");
const accepted = journal("accepted");
const nextState: AgentState = {
  ...EMPTY_STATE,
  paused: true,
  handledCommands: ["c1"],
};

class FakeKube {
  data: Record<string, string> = {};
  gets = 0;
  applies = 0;
  failNextApply = false;
  private gated = false;
  private release: (() => void) | null = null;

  gateFirstApply() {
    this.gated = true;
    return () => {
      this.release?.();
      this.release = null;
    };
  }

  async get<T>() {
    this.gets++;
    return { data: { ...this.data } } as T;
  }

  async apply(value: { data?: Record<string, string> }) {
    this.applies++;
    if (this.failNextApply) {
      this.failNextApply = false;
      throw new Error("apply failed");
    }
    if (this.gated) {
      this.gated = false;
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    this.data = { ...value.data };
  }
}

async function until(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a save");
    await Bun.sleep(5);
  }
}

function store(kube: FakeKube) {
  return new StateStore(kube as unknown as Kube, NAMESPACE, NAME);
}

describe("state ConfigMap writes", () => {
  test("a journal write and a state write cannot revert one another", async () => {
    const kube = new FakeKube();
    kube.data = {
      "state.json": `${JSON.stringify(EMPTY_STATE)}\n`,
      "journal.json": `${JSON.stringify(verifying)}\n`,
    };
    const releaseFirstApply = kube.gateFirstApply();
    const stateStore = store(kube);

    const savingJournal = stateStore.saveJournal(accepted);
    await until(() => kube.applies === 1);
    const savingState = stateStore.saveState(nextState);
    await Bun.sleep(20);
    const getsWhileJournalWritePending = kube.gets;
    releaseFirstApply();
    await Promise.all([savingJournal, savingState]);

    // With the old code the second save read the stale snapshot straight away and its apply
    // overwrote the journal that had just been written.
    expect(getsWhileJournalWritePending).toBe(1);
    expect(JSON.parse(kube.data["journal.json"]!)).toEqual(accepted);
    expect(JSON.parse(kube.data["state.json"]!)).toEqual(nextState);
  });

  test("a failed save does not leave the queue wedged", async () => {
    const kube = new FakeKube();
    kube.failNextApply = true;
    const stateStore = store(kube);

    await expect(stateStore.saveJournal(accepted)).rejects.toThrow(
      "apply failed",
    );
    await stateStore.saveState(nextState);

    expect(JSON.parse(kube.data["state.json"]!)).toEqual(nextState);
  });
});
