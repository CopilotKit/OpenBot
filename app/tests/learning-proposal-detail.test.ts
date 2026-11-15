import { expect, test } from "bun:test";
import type {
  LearningEvidence,
  LearningProposalDetail,
} from "@/lib/api/generated/model";
import {
  assembleProposal,
  MAX_INSIGHTS,
  MAX_MESSAGE,
} from "@/lib/learning/proposal-detail";
import { learningContract, proposalDetailBody, testId } from "./learning-api";

/**
 * A proposal's detail is assembled in the app from the API's pieces: the proposal with its files and
 * insights, each insight's evidence read on its own, and the titles of the recordings that evidence
 * cites. Every Learning dialog draws the one shape this makes, so what a person reads about a
 * proposal is decided here.
 */

const SKILL_MD =
  "---\nname: refund-order\ndescription: Refund an order.\n---\n\n1. Open the order.\n2. Click Refund.\n";

/** A proposal as reading it answers, checked against the operation's own schema. */
const proposal = (insightCount: number): LearningProposalDetail =>
  learningContract.GetLearningProposalResponse.parse(
    proposalDetailBody({
      id: testId("p1"),
      title: "refund-order",
      description: "Refund an order from its page.",
      files: [
        { path: "references/policy.md", content: "Refunds inside 30 days." },
        { path: "SKILL.md", content: SKILL_MD },
        { path: "scripts/check.sh", content: "echo ok" },
      ],
      insights: Array.from({ length: insightCount }, (_, index) => ({
        id: testId(`i${index}`),
        statement: `Insight ${index}`,
        impact: `Impact ${index}`,
      })),
    }),
  );

const recording = (
  key: string,
  overrides: Partial<Extract<LearningEvidence, { kind: "recording" }>> = {},
): LearningEvidence => ({
  kind: "recording",
  trajectoryId: testId(key),
  trajectoryPresent: true,
  unavailable: null,
  eventCount: 2,
  events: [
    { seq: 0, name: "Open the order", offsetMs: 0 },
    { seq: 1, name: "Click Refund", offsetMs: 1200 },
  ],
  ...overrides,
});

const conversation = (content: string): LearningEvidence => ({
  kind: "conversation",
  threadId: "thread-1182",
  threadName: "Refund for order 1182",
  threadPresent: true,
  unavailable: null,
  messageCount: 12,
  cited: [{ id: "message-1", role: "user", content }],
});

test("SKILL.md comes first, and every file keeps its content", async () => {
  const detail = await assembleProposal(proposal(0), {
    evidence: async () => ({ evidence: [] }),
  });
  expect(detail.files).toEqual([
    { path: "SKILL.md", content: SKILL_MD },
    { path: "references/policy.md", content: "Refunds inside 30 days." },
    { path: "scripts/check.sh", content: "echo ok" },
  ]);
  expect(detail.title).toBe("refund-order");
  expect(detail.status).toBe("pending_review");
});

test("evidence is read for the first ten insights only", async () => {
  const asked: string[] = [];
  const detail = await assembleProposal(proposal(MAX_INSIGHTS + 3), {
    evidence: async (insightId) => {
      asked.push(insightId);
      return { evidence: [] };
    },
  });
  expect(MAX_INSIGHTS).toBe(10);
  expect(asked).toHaveLength(10);
  expect(detail.insights.map((insight) => insight.statement)).toEqual(
    Array.from({ length: 10 }, (_, index) => `Insight ${index}`),
  );
});

test("a recording reads as available only while it is there and its snapshot can be read, with its events by name", async () => {
  const detail = await assembleProposal(proposal(1), {
    evidence: async () => ({
      evidence: [
        recording("r1"),
        recording("r2", { trajectoryPresent: false }),
        recording("r3", { unavailable: "snapshot-missing" }),
      ],
    }),
  });
  expect(detail.insights[0]?.evidence).toEqual([
    {
      kind: "recording",
      id: testId("r1"),
      title: null,
      available: true,
      eventCount: 2,
      events: ["Open the order", "Click Refund"],
    },
    {
      kind: "recording",
      id: testId("r2"),
      title: null,
      available: false,
      eventCount: 2,
      events: ["Open the order", "Click Refund"],
    },
    {
      kind: "recording",
      id: testId("r3"),
      title: null,
      available: false,
      eventCount: 2,
      events: ["Open the order", "Click Refund"],
    },
  ]);
});

test("a cited message is cut to 4,000 characters, and the conversation keeps its title", async () => {
  const long = `${"I need a refund for order 1182. ".repeat(200)}Thanks.`;
  const detail = await assembleProposal(proposal(1), {
    evidence: async () => ({ evidence: [conversation(long)] }),
  });
  const [entry] = detail.insights[0]?.evidence ?? [];
  expect(entry?.kind).toBe("conversation");
  if (entry?.kind !== "conversation") return;
  expect(entry.title).toBe("Refund for order 1182");
  expect(entry.id).toBe("thread-1182");
  expect(entry.available).toBe(true);
  expect(entry.messages[0]?.content).toHaveLength(MAX_MESSAGE);
  expect(entry.messages[0]?.content).toBe(long.slice(0, 4000));
});

test("evidence that can't be read is null for that insight alone, and the proposal still opens", async () => {
  const detail = await assembleProposal(proposal(2), {
    evidence: async (insightId) => {
      if (insightId === testId("i0"))
        throw new Error("The backend no longer has this insight.");
      return { evidence: [conversation("Can I get a refund?")] };
    },
  });
  expect(detail.insights[0]?.evidence).toBeNull();
  expect(detail.insights[1]?.evidence).toHaveLength(1);
});

test("cited recordings are named by their titles, and one without a title is left unnamed", async () => {
  const asked: string[][] = [];
  const detail = await assembleProposal(proposal(2), {
    evidence: async (insightId) => ({
      evidence:
        insightId === testId("i0")
          ? [recording("r1"), recording("r2")]
          : [recording("r1")],
    }),
    titles: async (ids) => {
      asked.push(ids);
      return {
        recordings: [{ id: testId("r1"), title: "Refund an order" }],
      };
    },
  });
  // Each recording is asked about once, however many insights cite it.
  expect(asked).toEqual([[testId("r1"), testId("r2")]]);
  const titles = detail.insights.flatMap((insight) =>
    (insight.evidence ?? []).map((item) => item.title),
  );
  expect(titles).toEqual(["Refund an order", null, "Refund an order"]);
});

test("titles that can't be read leave the recordings unnamed, not the proposal unopened", async () => {
  const detail = await assembleProposal(proposal(1), {
    evidence: async () => ({ evidence: [recording("r1")] }),
    titles: async () => {
      throw new Error("Couldn't read your recordings.");
    },
  });
  expect(detail.insights[0]?.evidence?.[0]?.title).toBeNull();
});

test("titles are asked for at most fifty recordings at a time", async () => {
  const asked: number[] = [];
  const many = Array.from({ length: 60 }, (_, index) => recording(`r${index}`));
  await assembleProposal(proposal(1), {
    evidence: async () => ({ evidence: many }),
    titles: async (ids) => {
      asked.push(ids.length);
      return { recordings: [] };
    },
  });
  expect(asked).toEqual([50, 10]);
});

test("without a way to read titles, as in a Bot's own space, no title is asked for", async () => {
  const detail = await assembleProposal(proposal(1), {
    evidence: async () => ({ evidence: [recording("r1")] }),
  });
  expect(detail.insights[0]?.evidence?.[0]?.title).toBeNull();
});
