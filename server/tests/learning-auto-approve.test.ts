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

function detail(id: string): CandidateDetail {
  return {
    ...candidate(id),
    bundle: {
      files: [
        {
          path: "SKILL.md",
          content: `---\nname: skill-${id}\n---\n# Skill`,
        },
      ],
    },
    supportingInsights: [],
  } as unknown as CandidateDetail;
}

function stubManage(
  byContainer: Record<string, Candidate[]>,
  options: { conflict?: Set<string>; gate?: Promise<void> } = {},
) {
  const approved: { containerId: string; candidateId: string }[] = [];
  let listCalls = 0;
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
    getLearningCandidate: async ({ candidateId }: { candidateId: string }) =>
      detail(candidateId),
    reviewLearningCandidate: async ({
      containerId,
      candidateId,
    }: {
      containerId: string;
      candidateId: string;
    }) => {
      approved.push({ containerId, candidateId });
      if (options.conflict?.has(candidateId))
        throw Object.assign(new Error("conflict"), {
          status: 409,
          code: "LEARNING_CANDIDATE_CONFLICT",
        });
      return { status: "approved", operation: "add" };
    },
  } as unknown as LearningManagement;
  return { manage, approved, listCalls: () => listCalls };
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

  test("two overlapping sweeps approve each proposal once and treat 409 as done", async () => {
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
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const approver = createAutoApprover({
        manage,
        enabled: async () => true,
        sources,
        approvals,
        userId: "user-1",
        audit,
      });

      const first = approver.sweep();
      const second = approver.sweep();
      expect(second).toBe(first);
      open();
      expect(await first).toEqual({ approved: 2 });
      expect(await second).toEqual({ approved: 2 });

      expect(approved.map((entry) => entry.candidateId).sort()).toEqual([
        "c1",
        "r1",
        "taken",
      ]);
      expect(rows.map((row) => row.targetId).sort()).toEqual(["c1", "r1"]);
      expect(errors).toHaveLength(0);

      // Once settled, the next sweep runs afresh.
      const third = approver.sweep();
      expect(third).not.toBe(first);
      await third;
    } finally {
      console.error = originalError;
    }
  });

  test("a failing candidate or source doesn't stop the sweep", async () => {
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
