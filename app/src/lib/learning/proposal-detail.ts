import type {
  LearningEvidence,
  LearningProposalDetail,
} from "@openbot/shared/learning";
import type {
  LearningEvidence as ApiLearningEvidence,
  LearningProposalDetail as ApiLearningProposalDetail,
  LearningEvidenceList,
  RecordingTitles,
} from "@/lib/api/generated/model";

/** The most Insights one proposal shows evidence for. */
export const MAX_INSIGHTS = 10;
/** The longest cited message shown, in characters. */
export const MAX_MESSAGE = 4_000;
/** The most recordings one request for their titles may name. */
const MAX_TITLES = 50;

/**
 * One piece of evidence as the proposal dialog draws it: a recording by whether it can still be opened and the names of
 * the events it cites, a conversation by the messages it cites, each cut to a length a dialog can show.
 */
export function evidenceFrom(entry: ApiLearningEvidence): LearningEvidence {
  if (entry.kind === "recording")
    return {
      kind: "recording",
      id: entry.trajectoryId,
      title: null,
      available: entry.trajectoryPresent && entry.unavailable === null,
      eventCount: entry.eventCount,
      events: entry.events.map((event) => event.name),
    };
  return {
    kind: "conversation",
    id: entry.threadId,
    title: entry.threadName,
    available: entry.threadPresent && entry.unavailable === null,
    messages: entry.cited.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content.slice(0, MAX_MESSAGE),
    })),
  };
}

/** How the proposal's own space is read: its evidence one insight at a time, and its recordings' titles. */
export type ProposalSources = {
  /** The evidence behind one insight, read where the proposal is. */
  evidence: (insightId: string) => Promise<LearningEvidenceList>;
  /**
   * The titles of the recordings the evidence cites, read as their owner's. Absent where recordings are not named,
   * as in a Bot's own space.
   */
  titles?: (ids: string[]) => Promise<RecordingTitles>;
};

/**
 * Everything a person needs to decide on a proposal, in the one shape every Learning dialog draws: the files it
 * publishes with SKILL.md first, and for each of its first ten insights the evidence behind it.
 *
 * Evidence that can't be read is null for that insight alone, and recordings whose titles can't be read are shown
 * without one: neither stops the proposal from opening.
 */
export async function assembleProposal(
  proposal: ApiLearningProposalDetail,
  sources: ProposalSources,
): Promise<LearningProposalDetail> {
  const insights = await Promise.all(
    proposal.insights.slice(0, MAX_INSIGHTS).map(async (insight) => ({
      id: insight.id,
      statement: insight.statement,
      impact: insight.impact,
      evidence: await sources
        .evidence(insight.id)
        .then((list) => list.evidence.map(evidenceFrom))
        .catch(() => null),
    })),
  );
  if (sources.titles) await nameRecordings(insights, sources.titles);
  const files = [...proposal.files]
    .sort((a, b) =>
      a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : 0,
    )
    .map((file) => ({ path: file.path, content: file.content }));
  return {
    id: proposal.id,
    title: proposal.title,
    description: proposal.description,
    reason: proposal.reason,
    operation: proposal.operation,
    status: proposal.status,
    createdAt: proposal.createdAt,
    reviewedAt: proposal.reviewedAt,
    files,
    insights,
  };
}

/** Gives each cited recording its title, asking for at most fifty at a time. A failed ask leaves those untitled. */
async function nameRecordings(
  insights: LearningProposalDetail["insights"],
  titles: NonNullable<ProposalSources["titles"]>,
): Promise<void> {
  const ids = [
    ...new Set(
      insights.flatMap((insight) =>
        (insight.evidence ?? []).flatMap((item) =>
          item.kind === "recording" ? [item.id] : [],
        ),
      ),
    ),
  ];
  const found = new Map<string, string | null>();
  for (let start = 0; start < ids.length; start += MAX_TITLES) {
    const answer = await titles(ids.slice(start, start + MAX_TITLES)).catch(
      () => null,
    );
    for (const recording of answer?.recordings ?? [])
      found.set(recording.id, recording.title);
  }
  for (const insight of insights)
    for (const item of insight.evidence ?? [])
      if (item.kind === "recording") item.title = found.get(item.id) ?? null;
}
