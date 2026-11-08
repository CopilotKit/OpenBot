import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { SkillApprovalStore } from "../src/learning/approvals";
import { createAutoApprover } from "../src/learning/auto-approve";
import type {
  Candidate,
  CandidateDetail,
  LearningManagement,
} from "../src/learning/review";

const RECORDINGS = "recordings-container";
const CONVERSATIONS = "conversations-container";

function candidate(id: string, status = "pending_review"): Candidate {
  return {
    id,
    title: `Skill ${id}`,
    description: "",
    reason: "",
    operation: "add",
    status,
    createdAt: "2026-11-01T00:00:00.000Z",
    reviewedAt: null,
  } as unknown as Candidate;
}

function detail(id: string, named = true): CandidateDetail {
  return {
    ...candidate(id),
    bundle: {
      files: [
        {
          path: "SKILL.md",
          content: named
            ? `---\nname: skill-${id}\n---\n# Skill`
            : "# A skill with no name",
        },
      ],
    },
    supportingInsights: [],
  } as unknown as CandidateDetail;
}

/**
 * Intelligence's Learning API for a few spaces. A reviewed proposal is settled, so a later sweep no longer sees it
 * pending; one in `conflict` was settled by another review first, and one in `failing` fails with a 500.
 */
function stubManage(
  byContainer: Record<string, Candidate[]>,
  options: {
    conflict?: Set<string>;
    failing?: Set<string>;
    unnamed?: Set<string>;
    gate?: Promise<void>;
    onReview?: (candidateId: string) => void;
  } = {},
) {
  const approved: { containerId: string; candidateId: string }[] = [];
  const detailReads: string[] = [];
  let listCalls = 0;
  const settle = (containerId: string, candidateId: string) => {
    byContainer[containerId] = (byContainer[containerId] ?? []).map((entry) =>
      entry.id === candidateId ? { ...entry, status: "approved" } : entry,
    );
  };
  const manage = {
    listLearningCandidates: async ({
      containerId,
    }: {
      containerId: string;
    }) => {
      listCalls++;
      await options.gate;
      return byContainer[containerId] ?? [];
    },
    getLearningCandidate: async ({ candidateId }: { candidateId: string }) => {
      detailReads.push(candidateId);
      return detail(candidateId, !options.unnamed?.has(candidateId));
    },
    reviewLearningCandidate: async ({
      containerId,
      candidateId,
    }: {
      containerId: string;
      candidateId: string;
    }) => {
      approved.push({ containerId, candidateId });
      options.onReview?.(candidateId);
      if (options.failing?.has(candidateId))
        throw Object.assign(new Error("Intelligence failed"), { status: 500 });
      settle(containerId, candidateId);
      if (options.conflict?.has(candidateId))
        throw Object.assign(new Error("conflict"), {
          status: 409,
          code: "LEARNING_CANDIDATE_CONFLICT",
        });
      return { status: "approved", operation: "add" };
    },
  } as unknown as LearningManagement;
  return {
    manage,
    approved,
    detailReads,
    listCalls: () => listCalls,
  };
}

/** Collects what is logged to console.error while `body` runs, each line parsed as JSON. */
async function capturingErrors<T>(
  body: () => Promise<T>,
): Promise<{ result: T; errors: Record<string, unknown>[] }> {
  const errors: Record<string, unknown>[] = [];
  const originalError = console.error;
  console.error = (line: string) => errors.push(JSON.parse(line));
  try {
    return { result: await body(), errors };
  } finally {
    console.error = originalError;
  }
}

function stubApprovals() {
  const recorded: { userId: string; skillName: string; by: string }[] = [];
  const approvals = {
    recordApprovalStamped: async (
      userId: string,
      skillName: string,
      by: "person" | "admin",
    ) => {
      recorded.push({ userId, skillName, by });
      return { existed: false, previous: null, written: "stamp" };
    },
    forgetIfUnchanged: async () => true,
    restoreIfUnchanged: async () => true,
    forget: async () => null,
    restoreIfAbsent: async () => true,
  } as unknown as SkillApprovalStore;
  return { approvals, recorded };
}

function stubAudit() {
  const rows: AuditEventInput[] = [];
  const audit: AuditStore = {
    insert: async (event) => {
      rows.push(event);
    },
  };
  return { audit, rows };
}

const sources = async () => [
  { containerId: RECORDINGS, kind: "recordings" as const, label: "Recordings" },
  {
    containerId: CONVERSATIONS,
    kind: "conversations" as const,
    label: "Conversations",
  },
];

describe("createAutoApprover", () => {
  test("a sweep approves every pending proposal across sources", async () => {
    const { manage, approved } = stubManage({
      [RECORDINGS]: [candidate("r1"), candidate("r-done", "approved")],
      [CONVERSATIONS]: [candidate("c1"), candidate("c2")],
    });
    const { approvals, recorded } = stubApprovals();
    const { audit, rows } = stubAudit();
    const approver = createAutoApprover({
      manage,
      enabled: async () => true,
      sources,
      approvals,
      userId: "user-1",
      audit,
    });

    expect(await approver.sweep()).toEqual({ approved: 3 });
    expect(approved).toEqual([
      { containerId: RECORDINGS, candidateId: "r1" },
      { containerId: CONVERSATIONS, candidateId: "c1" },
      { containerId: CONVERSATIONS, candidateId: "c2" },
    ]);
    expect(recorded).toEqual([
      { userId: "user-1", skillName: "skill-r1", by: "person" },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      eventType: "configuration.changed",
      targetType: "learning_skill",
      targetId: "r1",
      actorUserId: "user-1",
      initiator: { kind: "deployment" },
      payload: {
        change: "skill_approved",
        containerId: RECORDINGS,
        title: "Skill r1",
        operation: "add",
        by: "automatic",
      },
    });
  });

  test("a sweep does nothing when switched off", async () => {
    const { manage, approved, listCalls } = stubManage({
      [RECORDINGS]: [candidate("r1")],
    });
    const { approvals, recorded } = stubApprovals();
    const { audit, rows } = stubAudit();
    let sourcesRead = false;
    const approver = createAutoApprover({
      manage,
      enabled: async () => false,
      sources: async () => {
        sourcesRead = true;
        return sources();
      },
      approvals,
      userId: "user-1",
      audit,
    });

    expect(await approver.sweep()).toEqual({ approved: 0 });
    expect(listCalls()).toBe(0);
    expect(sourcesRead).toBe(false);
    expect(approved).toHaveLength(0);
    expect(recorded).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  test("calls during a running sweep share one follow-up, so each proposal is reviewed once and a 409 is quiet", async () => {
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { manage, approved } = stubManage(
      {
        [RECORDINGS]: [candidate("r1"), candidate("taken")],
        [CONVERSATIONS]: [candidate("c1")],
      },
      { conflict: new Set(["taken"]), gate },
    );
    const { approvals } = stubApprovals();
    const { audit, rows } = stubAudit();
    let runs = 0;
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const approver = createAutoApprover({
        manage,
        enabled: async () => true,
        sources: async () => {
          runs++;
          return sources();
        },
        approvals,
        userId: "user-1",
        audit,
      });

      const first = approver.sweep();
      const second = approver.sweep();
      const third = approver.sweep();
      expect(second).not.toBe(first);
      expect(third).toBe(second);
      open();
      expect(await first).toEqual({ approved: 2 });
      // The follow-up runs after the first and finds nothing left pending.
      expect(await second).toEqual({ approved: 0 });
      expect(runs).toBe(2);

      expect(approved.map((entry) => entry.candidateId).sort()).toEqual([
        "c1",
        "r1",
        "taken",
      ]);
      expect(rows.map((row) => row.targetId).sort()).toEqual(["c1", "r1"]);
      expect(errors).toHaveLength(0);

      // Once settled, the next sweep runs afresh.
      const fourth = approver.sweep();
      expect(fourth).not.toBe(second);
      await fourth;
      expect(runs).toBe(3);
    } finally {
      console.error = originalError;
    }
  });

  test("switching on while a sweep that read it as off is running approves in a sweep that starts after", async () => {
    let on = false;
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { manage, approved } = stubManage({
      [RECORDINGS]: [candidate("r1")],
    });
    const { approvals } = stubApprovals();
    const approver = createAutoApprover({
      manage,
      enabled: async () => {
        const answer = on;
        await gate;
        return answer;
      },
      sources,
      approvals,
      userId: "user-1",
    });

    const running = approver.sweep();
    on = true;
    const afterSwitch = approver.sweep();
    open();
    expect(await running).toEqual({ approved: 0 });
    expect(await afterSwitch).toEqual({ approved: 1 });
    expect(approved).toEqual([{ containerId: RECORDINGS, candidateId: "r1" }]);
  });

  test("a sweep stops approving once switched off", async () => {
    let on = true;
    const { manage, approved } = stubManage(
      {
        [RECORDINGS]: [candidate("r1"), candidate("r2")],
        [CONVERSATIONS]: [candidate("c1")],
      },
      {
        onReview: (candidateId) => {
          if (candidateId === "r1") on = false;
        },
      },
    );
    const { approvals, recorded } = stubApprovals();
    const approver = createAutoApprover({
      manage,
      enabled: async () => on,
      sources,
      approvals,
      userId: "user-1",
    });

    expect(await approver.sweep()).toEqual({ approved: 1 });
    expect(approved).toEqual([{ containerId: RECORDINGS, candidateId: "r1" }]);
    expect(recorded.map((entry) => entry.skillName)).toEqual(["skill-r1"]);
  });

  test("a failing source is logged and the sweep goes on to the next", async () => {
    const { manage, approved } = stubManage({
      [CONVERSATIONS]: [candidate("c1")],
    });
    const failing = {
      ...manage,
      listLearningCandidates: async (input: { containerId: string }) => {
        if (input.containerId === RECORDINGS) throw new Error("down");
        return manage.listLearningCandidates(input);
      },
    } as LearningManagement;
    const { approvals } = stubApprovals();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (line: string) => errors.push(line);
    try {
      const approver = createAutoApprover({
        manage: failing,
        enabled: async () => true,
        sources,
        approvals,
        userId: "user-1",
      });
      expect(await approver.sweep()).toEqual({ approved: 1 });
    } finally {
      console.error = originalError;
    }
    expect(approved).toEqual([
      { containerId: CONVERSATIONS, candidateId: "c1" },
    ]);
    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0] ?? "")).toMatchObject({
      type: "learning-auto-approve-failed",
      containerId: RECORDINGS,
    });
  });

  test("a failing proposal is logged and the sweep goes on to the next", async () => {
    const { manage, approved } = stubManage(
      {
        [RECORDINGS]: [candidate("bad"), candidate("good")],
      },
      { failing: new Set(["bad"]) },
    );
    const { approvals } = stubApprovals();
    const { audit, rows } = stubAudit();
    const approver = createAutoApprover({
      manage,
      enabled: async () => true,
      sources,
      approvals,
      userId: "user-1",
      audit,
    });

    const { result, errors } = await capturingErrors(() => approver.sweep());
    expect(result).toEqual({ approved: 1 });
    expect(approved.map((entry) => entry.candidateId)).toEqual(["bad", "good"]);
    expect(rows.map((row) => row.targetId)).toEqual(["good"]);
    expect(errors).toEqual([
      expect.objectContaining({
        type: "learning-auto-approve-failed",
        containerId: RECORDINGS,
        candidateId: "bad",
        status: 500,
      }),
    ]);
  });

  test("a skill with no name is logged once and skipped by later sweeps", async () => {
    const { manage, approved, detailReads } = stubManage(
      {
        [RECORDINGS]: [candidate("nameless"), candidate("named")],
      },
      { unnamed: new Set(["nameless"]) },
    );
    const { approvals, recorded } = stubApprovals();
    const approver = createAutoApprover({
      manage,
      enabled: async () => true,
      sources,
      approvals,
      userId: "user-1",
    });

    const first = await capturingErrors(() => approver.sweep());
    expect(first.result).toEqual({ approved: 1 });
    expect(first.errors).toEqual([
      expect.objectContaining({
        type: "learning-auto-approve-failed",
        containerId: RECORDINGS,
        candidateId: "nameless",
        errorType: "UnnamedSkillError",
      }),
    ]);

    const second = await capturingErrors(() => approver.sweep());
    expect(second.result).toEqual({ approved: 0 });
    expect(second.errors).toEqual([]);
    // Not even read again: the same proposal still has no name.
    expect(detailReads).toEqual(["nameless", "named"]);
    expect(approved.map((entry) => entry.candidateId)).toEqual(["named"]);
    expect(recorded.map((entry) => entry.skillName)).toEqual(["skill-named"]);
  });

  test("an audit write that fails is logged and the approval still counts", async () => {
    const { manage, approved } = stubManage({
      [RECORDINGS]: [candidate("r1")],
      [CONVERSATIONS]: [candidate("c1")],
    });
    const { approvals } = stubApprovals();
    const audit: AuditStore = {
      insert: async () => {
        throw new Error("audit down");
      },
    };
    const approver = createAutoApprover({
      manage,
      enabled: async () => true,
      sources,
      approvals,
      userId: "user-1",
      audit,
    });

    const { result, errors } = await capturingErrors(() => approver.sweep());
    expect(result).toEqual({ approved: 2 });
    expect(approved.map((entry) => entry.candidateId)).toEqual(["r1", "c1"]);
    expect(errors).toEqual([
      expect.objectContaining({
        type: "learning-auto-approve-failed",
        candidateId: "r1",
        message: "audit down",
      }),
      expect.objectContaining({
        type: "learning-auto-approve-failed",
        candidateId: "c1",
        message: "audit down",
      }),
    ]);
  });

  test("a sweep whose settings can't be read logs and approves nothing", async () => {
    const { manage, approved } = stubManage({
      [RECORDINGS]: [candidate("r1")],
    });
    const { approvals } = stubApprovals();
    const originalError = console.error;
    try {
      for (const failing of ["enabled", "sources"] as const) {
        const errors: string[] = [];
        console.error = (line: string) => errors.push(line);
        const approver = createAutoApprover({
          manage,
          enabled:
            failing === "enabled"
              ? async () => {
                  throw new Error("settings down");
                }
              : async () => true,
          sources:
            failing === "sources"
              ? async () => {
                  throw new Error("sources down");
                }
              : sources,
          approvals,
          userId: "user-1",
        });
        expect(await approver.sweep()).toEqual({ approved: 0 });
        expect(errors).toHaveLength(1);
        expect(JSON.parse(errors[0] ?? "")).toMatchObject({
          type: "learning-auto-approve-failed",
          message: failing === "enabled" ? "settings down" : "sources down",
        });
      }
    } finally {
      console.error = originalError;
    }
    expect(approved).toHaveLength(0);
  });

  test("an approval is recorded as the deployment's, not the person's", async () => {
    const { manage } = stubManage({ [CONVERSATIONS]: [candidate("c1")] });
    const { approvals } = stubApprovals();
    const { audit, rows } = stubAudit();
    const approver = createAutoApprover({
      manage,
      enabled: async () => true,
      sources,
      approvals,
      userId: "user-1",
      audit,
    });
    await approver.sweep();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.initiator).toEqual({ kind: "deployment" });
    expect(rows[0]?.payload).toMatchObject({ by: "automatic" });
  });

  test("a source whose space isn't made yet is skipped without a log", async () => {
    const { manage, approved } = stubManage({
      [CONVERSATIONS]: [candidate("c1")],
    });
    const missing = {
      ...manage,
      listLearningCandidates: async (input: { containerId: string }) => {
        if (input.containerId === RECORDINGS)
          throw Object.assign(new Error("not found"), {
            status: 404,
            code: "LEARNING_CONTAINER_NOT_FOUND",
          });
        return manage.listLearningCandidates(input);
      },
    } as LearningManagement;
    const { approvals } = stubApprovals();
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const approver = createAutoApprover({
        manage: missing,
        enabled: async () => true,
        sources,
        approvals,
        userId: "user-1",
      });
      expect(await approver.sweep()).toEqual({ approved: 1 });
      expect(approved.map((entry) => entry.candidateId)).toEqual(["c1"]);
      expect(errors).toHaveLength(0);
    } finally {
      console.error = originalError;
    }
  });
});
