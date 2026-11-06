import { describe, expect, test } from "bun:test";
import {
  type Candidate,
  type CandidateDetail,
  type Evidence,
  type LearningManagement,
  readProposal,
  readProposals,
} from "../src/learning/review";

const candidate = {
  id: "0198a012-a20f-77c0-9e33-8992f18e74b1",
  title: "Refund check",
  description: "Check order age first",
  reason: "Seen twice",
  operation: "create",
  status: "pending",
  createdAt: "2026-11-01T00:00:00.000Z",
  reviewedAt: null,
} as unknown as Candidate;

const detail = {
  ...candidate,
  bundle: { files: [{ path: "SKILL.md", content: "# Skill" }] },
  supportingInsights: [
    { id: "insight-1", statement: "Check age", impact: "high" },
    { id: "insight-2", statement: "Unreadable", impact: "low" },
  ],
} as unknown as CandidateDetail;

const entries = [
  {
    threadId: "thread-1",
    threadName: "Refund chat",
    threadPresent: true,
    unavailable: null,
    cited: [],
  },
  {
    kind: "trajectory",
    trajectoryId: "recording-1",
    trajectoryPresent: true,
    unavailable: null,
    eventCount: 1,
    events: [{ name: "click" }],
  },
  {
    kind: "trajectory",
    trajectoryId: "recording-2",
    trajectoryPresent: true,
    unavailable: null,
    eventCount: 0,
    events: [],
  },
] as unknown as Evidence[];

function stub(): LearningManagement {
  return {
    listLearningCandidates: async () => [candidate, candidate],
    getLearningCandidate: async () => detail,
    getLearningInsightEvidence: async ({
      insightId,
    }: {
      insightId: string;
    }) => {
      if (insightId === "insight-2") throw new Error("gone");
      return [...entries, entries[1]];
    },
  } as unknown as LearningManagement;
}

describe("readProposals", () => {
  test("maps every candidate to a proposal", async () => {
    const proposals = await readProposals(stub(), "openbot");
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({
      id: candidate.id,
      title: "Refund check",
    });
    expect("bundle" in proposals[0]).toBe(false);
  });
});

describe("readProposal", () => {
  test("without titles leaves recording titles null", async () => {
    const result = await readProposal(stub(), "openbot", candidate.id);
    expect(result.files).toEqual([{ path: "SKILL.md", content: "# Skill" }]);
    expect(result.insights[1]?.evidence).toBeNull();
    const recordings = result.insights[0]?.evidence?.filter(
      (item) => item.kind === "recording",
    );
    expect(recordings?.map((item) => item.title)).toEqual([null, null, null]);
  });

  test("titles fill only recordings, once, with their ids", async () => {
    const calls: string[][] = [];
    const result = await readProposal(
      stub(),
      "openbot",
      candidate.id,
      async (ids) => {
        calls.push(ids);
        return new Map([["recording-1", "Open the order"]]);
      },
    );
    expect(calls).toEqual([["recording-1", "recording-2"]]);
    const evidence = result.insights[0]?.evidence ?? [];
    expect(evidence[0]).toMatchObject({
      kind: "conversation",
      title: "Refund chat",
    });
    expect(
      evidence.flatMap((item) =>
        item.kind === "recording" ? [item.title] : [],
      ),
    ).toEqual(["Open the order", null, "Open the order"]);
  });

  test("a throwing titles leaves them null", async () => {
    const result = await readProposal(
      stub(),
      "openbot",
      candidate.id,
      async () => {
        throw new Error("nope");
      },
    );
    expect(
      result.insights[0]?.evidence?.flatMap((item) =>
        item.kind === "recording" ? [item.title] : [],
      ),
    ).toEqual([null, null, null]);
  });
});
