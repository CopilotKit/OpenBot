import { describe, expect, test } from "bun:test";
import {
  type Candidate,
  type CandidateDetail,
  type Evidence,
  type LearningManagement,
  readProposal,
  readProposals,
  readSkillRecordings,
  reviewProposal,
} from "../src/learning/review";
import { fakeIntelligence, RUNTIME_KEY } from "./support/intelligence-learning";

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

describe("readSkillRecordings", () => {
  /** A reviewed proposal as Intelligence lists it: its title is the SKILL.md name of the skill it publishes. */
  const listed = (
    id: string,
    title: string,
    status: "approved" | "rejected" | "pending_review",
    operation: "add" | "update" | "remove" = "add",
  ) => ({ ...candidate, id, title, status, operation }) as unknown as Candidate;
  const trajectory = (id: string, present = true) => ({
    kind: "trajectory",
    trajectoryId: id,
    trajectoryPresent: present,
    unavailable: null,
    eventCount: 1,
    events: [{ name: "click" }],
  });

  function intelligence(
    candidates: Candidate[],
    evidenceOf: Record<string, unknown[]>,
  ) {
    const opened: string[] = [];
    const manage = {
      listLearningCandidates: async () => candidates,
      getLearningCandidate: async ({
        candidateId,
      }: {
        candidateId: string;
      }) => {
        opened.push(candidateId);
        return {
          ...detail,
          id: candidateId,
          supportingInsights: [
            { id: `${candidateId}-insight`, statement: "", impact: "" },
          ],
        };
      },
      getLearningInsightEvidence: async ({
        insightId,
      }: {
        insightId: string;
      }) => {
        const found = evidenceOf[insightId.replace(/-insight$/, "")];
        if (!found) throw new Error("unreadable");
        return found;
      },
    } as unknown as LearningManagement;
    return { manage, opened };
  }

  test("reads the recordings of the approved proposals that published the skill, newest first", async () => {
    const { manage, opened } = intelligence(
      [
        listed("pending", "example-nav", "pending_review"),
        listed("update", "example-nav", "approved", "update"),
        listed("other-skill", "another-skill", "approved"),
        listed("rejected", "example-nav", "rejected"),
        listed("first", "example-nav", "approved"),
      ],
      {
        update: [trajectory("rec-b"), entries[0]],
        first: [trajectory("rec-a"), trajectory("rec-b", false)],
      },
    );
    expect(await readSkillRecordings(manage, "space", "example-nav")).toEqual([
      { id: "rec-b", available: true },
      { id: "rec-a", available: true },
    ]);
    expect(opened).toEqual(["update", "first"]);
  });

  test("stops at the skill's last removal: a skill learned again starts over", async () => {
    const { manage } = intelligence(
      [
        listed("again", "example-nav", "approved"),
        listed("removed", "example-nav", "approved", "remove"),
        listed("before", "example-nav", "approved"),
      ],
      { again: [trajectory("rec-new")], before: [trajectory("rec-old")] },
    );
    expect(await readSkillRecordings(manage, "space", "example-nav")).toEqual([
      { id: "rec-new", available: true },
    ]);
  });

  test("a skill with no approved proposal, or evidence that can't be read, has no recordings", async () => {
    const { manage } = intelligence(
      [listed("pending", "example-nav", "pending_review")],
      {},
    );
    expect(await readSkillRecordings(manage, "space", "example-nav")).toEqual(
      [],
    );
    const unreadable = intelligence(
      [listed("approved", "example-nav", "approved")],
      {},
    );
    expect(
      await readSkillRecordings(unreadable.manage, "space", "example-nav"),
    ).toEqual([]);
  });
});

/** Collects what `console.error` writes, by the `type` each JSON line carries. */
function captureErrors() {
  const original = console.error;
  const lines: string[] = [];
  console.error = (line: unknown) => {
    lines.push(String(line));
  };
  return {
    types: () =>
      lines.map((line) => (JSON.parse(line) as { type: string }).type),
    restore: () => {
      console.error = original;
    },
  };
}

describe("reviewProposal", () => {
  function reviewing(
    review: () => Promise<unknown>,
    calls: string[],
    reread?: () => Promise<unknown>,
  ): LearningManagement {
    let reads = 0;
    return {
      getLearningCandidate: async () => {
        reads += 1;
        if (reads > 1 && reread) {
          calls.push("reread");
          return reread();
        }
        calls.push("read");
        return detail;
      },
      reviewLearningCandidate: async () => {
        calls.push("review");
        return review();
      },
    } as unknown as LearningManagement;
  }
  const approved = async () => ({
    candidateId: candidate.id,
    operation: "add",
    status: "approved",
    publishedRegistryRevision: 1,
    publishedSkillId: "skill-1",
  });
  const conflict = Object.assign(new Error("conflict"), {
    status: 409,
    code: "LEARNING_CANDIDATE_CONFLICT",
  });

  test("before runs after the read and before the review", async () => {
    const calls: string[] = [];
    const result = await reviewProposal({
      manage: reviewing(approved, calls),
      containerId: "openbot",
      candidateId: candidate.id,
      action: "approve",
      before: async (seen) => {
        calls.push("before");
        expect(seen.files).toEqual([{ path: "SKILL.md", content: "# Skill" }]);
        expect(seen.insights).toEqual([]);
        return async () => {
          calls.push("undo");
        };
      },
    });
    expect(calls).toEqual(["read", "before", "review"]);
    expect(result).toEqual({
      id: candidate.id,
      status: "approved",
      operation: "add",
      title: "Refund check",
    });
  });

  test("a 409 from the review calls an undo handed back alone, and rethrows", async () => {
    const calls: string[] = [];
    const review = reviewProposal({
      manage: reviewing(async () => {
        throw conflict;
      }, calls),
      containerId: "openbot",
      candidateId: candidate.id,
      action: "approve",
      before: async () => {
        calls.push("before");
        return async () => {
          calls.push("undo");
        };
      },
    });
    await expect(review).rejects.toBe(conflict);
    expect(calls).toEqual(["read", "before", "review", "undo"]);
  });

  function approving(
    review: () => Promise<unknown>,
    calls: string[],
    reread?: () => Promise<unknown>,
  ) {
    return reviewProposal({
      manage: reviewing(review, calls, reread),
      containerId: "openbot",
      candidateId: candidate.id,
      action: "approve",
      before: async () => {
        calls.push("before");
        return {
          undo: async () => {
            calls.push("undo");
          },
          after: async () => {
            calls.push("after");
          },
        };
      },
    });
  }
  const timedOut = new Error("The operation timed out.");
  const failing = (status: number) =>
    Object.assign(new Error(`status ${status}`), { status });
  const stillPending = async () => ({ ...detail, status: "pending_review" });

  test("a 409 undoes without reading the proposal again", async () => {
    const calls: string[] = [];
    await expect(
      approving(
        async () => {
          throw conflict;
        },
        calls,
        stillPending,
      ),
    ).rejects.toBe(conflict);
    expect(calls).toEqual(["read", "before", "review", "undo"]);
  });

  for (const status of [400, 404, 422, 499]) {
    test(`a ${status} is a sure refusal, so the record is taken back`, async () => {
      const calls: string[] = [];
      const refused = failing(status);
      await expect(
        approving(
          async () => {
            throw refused;
          },
          calls,
          stillPending,
        ),
      ).rejects.toBe(refused);
      expect(calls).toEqual(["read", "before", "review", "undo"]);
    });
  }

  test("an error without a status keeps the record even while the proposal still reads as pending", async () => {
    const calls: string[] = [];
    await expect(
      approving(
        async () => {
          throw timedOut;
        },
        calls,
        stillPending,
      ),
    ).rejects.toBe(timedOut);
    expect(calls).toEqual(["read", "before", "review"]);
  });

  for (const status of [500, 502, 503, 504]) {
    test(`a ${status} may still land, so the record stays`, async () => {
      const calls: string[] = [];
      const unavailable = failing(status);
      await expect(
        approving(
          async () => {
            throw unavailable;
          },
          calls,
          stillPending,
        ),
      ).rejects.toBe(unavailable);
      expect(calls).toEqual(["read", "before", "review"]);
    });
  }

  test("after runs once Intelligence took the review, and never the undo", async () => {
    const calls: string[] = [];
    const result = await approving(approved, calls);
    expect(calls).toEqual(["read", "before", "review", "after"]);
    expect(result.status).toBe("approved");
  });

  test("a throwing after is logged and the review still succeeds", async () => {
    const calls: string[] = [];
    const logged = captureErrors();
    try {
      const result = await reviewProposal({
        manage: reviewing(approved, calls),
        containerId: "openbot",
        candidateId: candidate.id,
        action: "approve",
        before: async () => ({
          after: async () => {
            calls.push("after");
            throw new Error("database gone");
          },
        }),
      });
      expect(result.status).toBe("approved");
    } finally {
      logged.restore();
    }
    expect(calls).toEqual(["read", "review", "after"]);
    expect(logged.types()).toEqual(["learning-review-after-failed"]);
  });

  test("a throwing undo is logged and still rethrows the review's error", async () => {
    const calls: string[] = [];
    const logged = captureErrors();
    try {
      const review = reviewProposal({
        manage: reviewing(async () => {
          throw conflict;
        }, calls),
        containerId: "openbot",
        candidateId: candidate.id,
        action: "approve",
        before: async () => async () => {
          calls.push("undo");
          throw new Error("database gone");
        },
      });
      await expect(review).rejects.toBe(conflict);
    } finally {
      logged.restore();
    }
    expect(calls).toEqual(["read", "review", "undo"]);
    expect(logged.types()).toEqual(["learning-review-undo-failed"]);
  });

  test("on success the undo is not called", async () => {
    const calls: string[] = [];
    await reviewProposal({
      manage: reviewing(approved, calls),
      containerId: "openbot",
      candidateId: candidate.id,
      action: "approve",
      before: async () => async () => {
        calls.push("undo");
      },
    });
    expect(calls).toEqual(["read", "review"]);
  });

  test("a throwing before means no review call", async () => {
    const calls: string[] = [];
    const refused = new Error("unnamed");
    const review = reviewProposal({
      manage: reviewing(approved, calls),
      containerId: "openbot",
      candidateId: candidate.id,
      action: "approve",
      before: async () => {
        calls.push("before");
        throw refused;
      },
    });
    await expect(review).rejects.toBe(refused);
    expect(calls).toEqual(["read", "before"]);
  });

  test("without before it reads and reviews", async () => {
    const calls: string[] = [];
    const result = await reviewProposal({
      manage: reviewing(
        async () => ({
          candidateId: candidate.id,
          operation: "add",
          status: "rejected",
          publishedRegistryRevision: null,
          publishedSkillId: null,
        }),
        calls,
      ),
      containerId: "openbot",
      candidateId: candidate.id,
      action: "reject",
    });
    expect(calls).toEqual(["read", "review"]);
    expect(result.status).toBe("rejected");
  });
});

describe("the fake Intelligence answers reviews as Intelligence does", () => {
  const id = "0198a012-a20f-77c0-9e33-8992f18e74d1";
  const other = "0198a012-a20f-77c0-9e33-8992f18e74d2";
  const base = "/api/v1/learning/containers/openbot/candidates";
  const auth = { authorization: `Bearer ${RUNTIME_KEY}` };

  function serve() {
    const fake = fakeIntelligence("current", {
      containers: ["openbot"],
      candidates: [id, other],
    });
    const call = (path: string, method = "GET") =>
      fetch(`${fake.url}${base}${path}`, { method, headers: auth });
    return { fake, call };
  }

  test("a reviewed proposal reads as reviewed, published where it was approved", async () => {
    const { fake, call } = serve();
    try {
      const review = (await (await call(`/${id}/approve`, "POST")).json()) as {
        review: { publishedSkillId: string };
      };
      await call(`/${other}/reject`, "POST");
      const approvedDetail = (await (await call(`/${id}`)).json()) as {
        candidate: Record<string, unknown>;
      };
      expect(approvedDetail.candidate).toMatchObject({
        status: "approved",
        reviewedAt: expect.any(String),
        publishedSkillId: review.review.publishedSkillId,
        publishedRegistryRevision: 2,
      });
      expect(approvedDetail.candidate.bundle).toBeDefined();
      const rejectedDetail = (await (await call(`/${other}`)).json()) as {
        candidate: Record<string, unknown>;
      };
      expect(rejectedDetail.candidate).toMatchObject({
        status: "rejected",
        publishedSkillId: null,
      });
      const listed = (await (await call("")).json()) as {
        candidates: Record<string, unknown>[];
      };
      expect(listed.candidates.find((entry) => entry.id === id)).toMatchObject({
        status: "approved",
        publishedSkillId: review.review.publishedSkillId,
      });
    } finally {
      fake.stop();
    }
  });

  test("a route Intelligence doesn't have is not found and changes nothing", async () => {
    const { fake, call } = serve();
    try {
      for (const [path, method] of [
        [`/${id}/evidence`, "GET"],
        [`/${id}/evidence`, "POST"],
        [`/${id}/approve`, "GET"],
        [`/${id}/reject`, "GET"],
        [`/${id}`, "POST"],
      ] as const) {
        const answer = await call(path, method);
        expect(answer.status).toBe(404);
        expect(
          ((await answer.json()) as { error: { code: string } }).error.code,
        ).toBe("ROUTE_NOT_FOUND");
      }
      expect(fake.candidates.get(id)?.status).toBe("pending_review");
    } finally {
      fake.stop();
    }
  });
});
