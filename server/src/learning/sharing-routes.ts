import {
  isLearnedSkillName,
  isLearningSharingMode,
  type LearnedSkillContent,
  type LearnedSkillDetail,
  type LearningSource,
  type PersonalLearningSharing,
  type PersonalReview,
  type RecordingSkills,
} from "@openbot/shared/learning";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables, AuthenticatedActor } from "../auth/guards";
import { currentEdition } from "../edition";
import {
  recordApprovalBefore,
  type SkillApprovalStore,
  UnnamedSkillError,
} from "./approvals";
import {
  CANDIDATE_ID,
  type LearningManagement,
  type LearningModelUnavailable,
  learningFailure,
  noLearningModel,
  readProposal,
  readProposals,
  readSkillRecordings,
  requestFailure,
  reviewProposal,
  runSummary,
} from "./review";
import type { LearningModelCalls } from "./model-endpoint";
import type { LearningSettingsStore } from "./settings";
import type { LearningSharingStore } from "./sharing";

export type PersonalLearningRouteDeps = {
  store: LearningSharingStore;
  /** What became of the Learning endpoint's calls, on a plan, so a failed run says why. */
  modelCalls?: LearningModelCalls;
  /** Who approved each skill in the person's space and where a request to share it stands. */
  approvals: SkillApprovalStore;
  /** The Skills in this person's own space, read the way a run reads them (learning/runtime.ts `personalSkills`). */
  skillsOf: (
    userId: string,
  ) => Promise<
    | { skills: { name: string; description: string }[] }
    | { unavailable: "off" | "unavailable" }
  >;
  /** One Skill's files from this person's own space; null when they have none by that name. */
  skillOf?: (
    userId: string,
    name: string,
  ) => Promise<LearnedSkillContent | null>;
  /**
   * The Skills published in any one Learning space, read the way a run reads them. In the personal edition Your Skills
   * also list what the person's Bots learned from conversations, so every space `scopesFor` names is read.
   */
  containerSkills?: (
    containerId: string,
  ) => Promise<
    { skills: LearnedSkillContent[] } | { unavailable: "off" | "unavailable" }
  >;
  /** Tells this replica's open-Skill index to read again; other replicas see the change within its TTL. */
  invalidate: () => void;
  /**
   * Whether an administrator lets people open their Skills to every Bot (Admin, Automatic learning, Skill sharing),
   * read fresh for every change. Off, opening is refused and closing is not: a person can always take their Skills
   * back to their own Bots.
   */
  sharingAllowed: () => Promise<boolean>;
  auditStore?: AuditStore;
  /** The runtime key's Learning routes, for reading the proposals and runs of the spaces a person reviews. */
  manage?: LearningManagement;
  /** Learning settings, read fresh to see who reviews what people's recordings propose. */
  settings: LearningSettingsStore;
  /** Approves what is pending in the person's Learning spaces; run when automatic approval is switched on. */
  autoApprover?: { sweep(): Promise<{ approved: number }> };
  /** The Learning spaces this person reviews (learning/scopes.ts). */
  scopesFor: (actor: AuthenticatedActor) => Promise<LearningSource[]>;
  /** The titles of this person's own recordings by id; an id they don't own is left out. */
  recordingTitles?: (
    userId: string,
    ids: string[],
  ) => Promise<Map<string, string | null>>;
  /**
   * Why OpenBot Desktop could not give its local Intelligence's Learning agent a model, from
   * `OPENBOT_LEARNING_MODEL_UNAVAILABLE`. See `learningModelUnavailable`.
   */
  modelUnavailable?: LearningModelUnavailable;
};

/** The most proposals one recording's skills are looked for in, newest first. Each costs a read of its evidence. */
const RECORDING_SKILL_PROPOSALS = 5;
/** How much earlier than the recording's stop a proposal may be dated and still count: the two clocks can differ. */
const RECORDING_CLOCK_SLACK_MS = 60_000;

/** What a person reads when they try to open their Skills while an administrator has not allowed it. */
const SHARING_OFF =
  "An admin hasn't turned on sharing skills with every Bot, so your skills stay with your own Bots.";

const smallBody = bodyLimit({
  maxSize: 2 * 1024,
  onError: (context) =>
    context.json({ error: "That request is too large." }, 413),
});

type Settled<T> =
  | { failed: false; value: T }
  | { failed: true; value: null; missing: boolean; off: boolean };

/** Awaits a read and says whether it failed because the space is not made yet or Learning is off in Intelligence. */
async function settle<T>(read: Promise<T>): Promise<Settled<T>> {
  try {
    return { failed: false, value: await read };
  } catch (error) {
    const { code } = requestFailure(error);
    return {
      failed: true,
      value: null,
      missing: code === "LEARNING_CONTAINER_NOT_FOUND",
      off: code === "ROUTE_NOT_FOUND" || code === "LEARNING_NOT_ENABLED",
    };
  }
}

/**
 * Settings, Learning for the signed-in person: their sharing choice, their Skills, and review of their own Learning
 * spaces. Every route is scoped to the signed-in person, like their standing instructions: there is no route for reading
 * or changing somebody else's, and a `container` query only picks among their own spaces (`scopesFor`).
 */
export function createPersonalLearningRoutes(
  deps: PersonalLearningRouteDeps,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);

  /**
   * Writes an audit row for what a person just did. A write that fails is logged and never changes the answer: the
   * change it records has already happened, and saying it failed would send the person to repeat it.
   */
  const audit = async (event: Parameters<typeof recordAuditEvent>[1]) => {
    if (!deps.auditStore) return;
    try {
      await recordAuditEvent(deps.auditStore, event);
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "learning-audit-failed",
          eventType: event.eventType,
          change:
            typeof event.payload.change === "string"
              ? event.payload.change
              : null,
          targetId: event.targetId ?? null,
          errorType: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  /**
   * The spaces Your Skills read from, in order, the person's own first; null outside the personal edition or without a
   * way to read them, where Your Skills are the person's own space alone.
   */
  const skillSpaces = async (actor: AuthenticatedActor) => {
    const containerSkills = deps.containerSkills;
    if (currentEdition() !== "personal" || !containerSkills) return null;
    const scopes = await deps.scopesFor(actor);
    return { containerSkills, scopes };
  };

  routes.get("/", async (context) => {
    const userId = context.var.actor.id;
    const spaces = await skillSpaces(context.var.actor);
    const [sharing, read, sharingAllowed] = await Promise.all([
      deps.store.read(userId),
      spaces
        ? Promise.all(
            spaces.scopes.map(async (scope) => ({
              scope,
              read: await spaces
                .containerSkills(scope.containerId)
                .catch(() => ({ unavailable: "unavailable" as const })),
            })),
          ).then((reads) => {
            const seen = new Set<string>();
            const skills: {
              name: string;
              description: string;
              own: boolean;
            }[] = [];
            for (const { scope, read: space } of reads) {
              if (!("skills" in space)) continue;
              for (const skill of space.skills) {
                if (seen.has(skill.name)) continue;
                seen.add(skill.name);
                skills.push({
                  name: skill.name,
                  description: skill.description,
                  own: scope.kind === "recordings",
                });
              }
            }
            if (skills.length > 0 || reads.some((r) => "skills" in r.read))
              return { skills };
            const first = reads[0]?.read;
            return {
              unavailable:
                first && "unavailable" in first
                  ? first.unavailable
                  : ("unavailable" as const),
            };
          })
        : deps.skillsOf(userId).then((own) =>
            "skills" in own
              ? {
                  skills: own.skills.map((skill) => ({
                    ...skill,
                    own: true,
                  })),
                }
              : own,
          ),
      deps.sharingAllowed(),
    ]);
    const opened = new Set(sharing.openSkills);
    const answer: PersonalLearningSharing =
      "skills" in read
        ? {
            mode: sharing.mode,
            sharingAllowed,
            skills: await Promise.all(
              read.skills.map(async (skill) => {
                const approval = skill.own
                  ? await deps.approvals.get(userId, skill.name)
                  : null;
                return {
                  name: skill.name,
                  description: skill.description,
                  open: opened.has(skill.name),
                  approvedBy: approval?.approvedBy ?? null,
                  sharing: approval?.sharing ?? "none",
                };
              }),
            ),
          }
        : {
            mode: sharing.mode,
            sharingAllowed,
            skills: null,
            unavailable: read.unavailable,
          };
    return context.json(answer);
  });

  /** Whether the person decides on proposals themselves: always in the personal edition, otherwise when an admin chose people. */
  const canReview = async () =>
    currentEdition() === "personal" ||
    (await deps.settings.read()).personalReview === "people";

  /** Which of the person's sources a request is about: the one asked for, or the first. Null when it isn't theirs. */
  const sourceFor = async (
    actor: AuthenticatedActor,
    wanted: string | undefined,
  ): Promise<LearningSource | null> => {
    const scopes = await deps.scopesFor(actor);
    return (
      (wanted
        ? scopes.find((scope) => scope.containerId === wanted)
        : scopes[0]) ?? null
    );
  };

  routes.get("/review", async (context) => {
    const manage = deps.manage;
    if (!manage) {
      return context.json(
        { error: "Couldn't reach the backend just now. Try again." },
        503,
      );
    }
    const personal = currentEdition() === "personal";
    const [scopes, allowed] = await Promise.all([
      deps.scopesFor(context.var.actor),
      canReview(),
    ]);
    const readRuns = (source: LearningSource) =>
      settle(manage.listLearningRuns({ containerId: source.containerId }));
    const readPending = (source: LearningSource) =>
      settle(readProposals(manage, source.containerId));
    let approved = 0;
    let reads: {
      source: LearningSource;
      proposals: Settled<Awaited<ReturnType<typeof readProposals>>>;
      runs: Settled<Awaited<ReturnType<typeof manage.listLearningRuns>>>;
    }[];
    if (personal) {
      /*
       * Runs first, then the sweep, then proposals. A run that finishes after its runs were read still reads as
       * running, so the page polls again and the next sweep approves what it proposed. Read the other way round, a run
       * finishing between the sweep and the runs read would stop polling with its proposals left waiting.
       */
      const runs = await Promise.all(scopes.map(readRuns));
      try {
        approved = (await deps.autoApprover?.sweep())?.approved ?? 0;
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "learning-auto-approve-failed",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      const proposals = await Promise.all(scopes.map(readPending));
      reads = scopes.map((source, index) => ({
        source,
        proposals: proposals[index] as (typeof proposals)[number],
        runs: runs[index] as (typeof runs)[number],
      }));
    } else {
      reads = await Promise.all(
        scopes.map(async (source) => {
          const [proposals, runs] = await Promise.all([
            readPending(source),
            readRuns(source),
          ]);
          return { source, proposals, runs };
        }),
      );
    }
    const sources = reads.map(({ source, proposals, runs }) => {
      const off = [proposals, runs].some(
        (outcome) => outcome.failed && outcome.off,
      );
      if (off) {
        return {
          ...source,
          proposals: null,
          latestRun: null,
          unavailable: "learning-off" as const,
        };
      }
      // A person's space exists once a Recorder connects, so not being there yet means nothing to review.
      if (proposals.failed && proposals.missing) {
        return { ...source, proposals: [], latestRun: null };
      }
      // Each read stands alone: run history that can't be read hides only the latest run, never what waits for review.
      const latest = runs.value
        ? [...runs.value].sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt),
          )[0]
        : undefined;
      return {
        ...source,
        proposals:
          proposals.value?.filter(
            (entry) => entry.status === "pending_review",
          ) ?? null,
        latestRun: latest ? runSummary(latest, deps.modelCalls) : null,
      };
    });
    const answer: PersonalReview = {
      canReview: allowed,
      autoApprove: personal
        ? ((await deps.settings.read()).autoApprove ?? true)
        : null,
      approved,
      ...(deps.modelUnavailable
        ? { modelProblem: noLearningModel(deps.modelUnavailable) }
        : {}),
      sources,
    };
    return context.json(answer);
  });

  /**
   * The skills Learning proposed from one recording, for Teach a Bot once it saves one: `title` is the recording's name
   * and `since` when it stopped (milliseconds). Read from the proposals made since then in the person's own recording
   * spaces, newest first and a few at most, kept where the evidence cites a recording of theirs by that name. Recordings
   * that aren't theirs never match: `recordingTitles` names only their own.
   */
  routes.get("/recording-skills", async (context) => {
    const title = context.req.query("title")?.trim() ?? "";
    const since = Number(context.req.query("since"));
    if (!title || title.length > 200 || !Number.isFinite(since)) {
      return context.json({ error: "Name a recording to look for." }, 400);
    }
    const manage = deps.manage;
    const recordingTitles = deps.recordingTitles;
    if (!manage || !recordingTitles) {
      return context.json(
        { error: "Couldn't reach the backend just now. Try again." },
        503,
      );
    }
    const actor = context.var.actor;
    const from = since - RECORDING_CLOCK_SLACK_MS;
    const titles = (ids: string[]) => recordingTitles(actor.id, ids);
    const sources = (await deps.scopesFor(actor)).filter(
      (source) => source.kind === "recordings",
    );
    const answer: RecordingSkills = { skills: [] };
    for (const source of sources) {
      const listed = await settle(readProposals(manage, source.containerId));
      // A space not made yet holds nothing; any other failure is said, so the page doesn't read it as "none yet".
      if (listed.failed) {
        if (listed.missing) continue;
        if (listed.off) return context.json(answer);
        return context.json(
          { error: "Couldn't read your skills just now. Try again." },
          502,
        );
      }
      const recent = listed.value
        .filter(
          (proposal) =>
            Date.parse(proposal.createdAt) >= from &&
            proposal.status !== "rejected" &&
            proposal.operation !== "remove",
        )
        .slice(0, RECORDING_SKILL_PROPOSALS);
      for (const proposal of recent) {
        const detail = await readProposal(
          manage,
          source.containerId,
          proposal.id,
          titles,
        ).catch(() => null);
        const cited = detail?.insights.some((insight) =>
          (insight.evidence ?? []).some(
            (item) => item.kind === "recording" && item.title?.trim() === title,
          ),
        );
        if (cited)
          answer.skills.push({ ...proposal, container: source.containerId });
      }
    }
    return context.json(answer);
  });

  routes.get("/proposals/:candidateId", async (context) => {
    const candidateId = context.req.param("candidateId");
    if (!CANDIDATE_ID.test(candidateId)) {
      return context.json({ error: "Name a skill to open." }, 400);
    }
    const manage = deps.manage;
    if (!manage) {
      return context.json(
        { error: "Couldn't reach the backend just now. Try again." },
        503,
      );
    }
    const actor = context.var.actor;
    const source = await sourceFor(actor, context.req.query("container"));
    if (!source) {
      return context.json({ error: "You have no skill like that." }, 404);
    }
    const recordingTitles = deps.recordingTitles;
    try {
      return context.json({
        proposal: await readProposal(
          manage,
          source.containerId,
          candidateId,
          source.kind === "recordings" && recordingTitles
            ? (ids) => recordingTitles(actor.id, ids)
            : undefined,
        ),
      });
    } catch (error) {
      const failure = learningFailure(error, deps.modelUnavailable);
      return context.json({ error: failure.error }, failure.status);
    }
  });

  /**
   * Approve or reject a proposal from one of the person's spaces. On approving a skill from their recordings, OpenBot
   * writes its own record of who approved it before Intelligence is asked, and takes it back if Intelligence refuses.
   */
  for (const action of ["approve", "reject"] as const) {
    routes.post(`/proposals/:candidateId/${action}`, async (context) => {
      const candidateId = context.req.param("candidateId");
      if (!CANDIDATE_ID.test(candidateId)) {
        return context.json({ error: "Name a skill to review." }, 400);
      }
      const actor = context.var.actor;
      const source = await sourceFor(actor, context.req.query("container"));
      if (!source) {
        return context.json({ error: "You have no skill like that." }, 404);
      }
      if (!(await canReview())) {
        return context.json(
          { error: "An admin reviews these skills. You can't review them." },
          403,
        );
      }
      const manage = deps.manage;
      if (!manage) {
        return context.json(
          { error: "Couldn't reach the backend just now. Try again." },
          503,
        );
      }
      const containerId = source.containerId;
      const recordWithApproval = recordApprovalBefore(
        deps.approvals,
        actor.id,
        "person",
      );
      /*
       * The approval row is what holds a skill the person approved for themselves back from other people's Bots. It is
       * written before Intelligence publishes, and every run reads it fresh (learning/runtime.ts
       * `PersonalSkillSources.withheld`), so no open-skill index has to be told.
       */
      let review: Awaited<ReturnType<typeof reviewProposal>>;
      try {
        review = await reviewProposal({
          manage,
          containerId,
          candidateId,
          action,
          ...(action === "approve" && source.kind === "recordings"
            ? { before: recordWithApproval }
            : {}),
        });
      } catch (error) {
        await audit({
          eventType: "configuration.changed",
          targetType: "learning_skill",
          targetId: candidateId,
          actorUserId: actor.id,
          payload: {
            change: "skill_review_failed",
            decision: action,
            containerId,
            code:
              error instanceof UnnamedSkillError
                ? "UNNAMED_SKILL"
                : (requestFailure(error).code ?? null),
            by: actor.email,
          },
        });
        if (error instanceof UnnamedSkillError) {
          return context.json({ error: error.message }, 422);
        }
        const failure = learningFailure(error, deps.modelUnavailable);
        return context.json({ error: failure.error }, failure.status);
      }
      await audit({
        eventType: "configuration.changed",
        targetType: "learning_skill",
        targetId: candidateId,
        actorUserId: actor.id,
        payload: {
          change: action === "approve" ? "skill_approved" : "skill_rejected",
          containerId,
          title: review.title,
          operation: review.operation,
          by: actor.email,
        },
      });
      return context.json({
        proposal: { id: candidateId, status: review.status },
      });
    });
  }

  /** Learn now on one of the person's spaces, where they review their own skills (always in the personal edition). */
  routes.post("/runs", async (context) => {
    const actor = context.var.actor;
    const source = await sourceFor(actor, context.req.query("container"));
    if (!source) {
      return context.json({ error: "You have no space like that." }, 404);
    }
    if (!(await canReview())) {
      return context.json(
        { error: "An admin decides when Learning runs. You can't start it." },
        403,
      );
    }
    const manage = deps.manage;
    if (!manage) {
      return context.json(
        { error: "Couldn't reach the backend just now. Try again." },
        503,
      );
    }
    const containerId = source.containerId;
    let run: Awaited<ReturnType<typeof manage.startLearningRun>>;
    try {
      run = await manage.startLearningRun({ containerId });
    } catch (error) {
      const failure = learningFailure(error, deps.modelUnavailable);
      return context.json({ error: failure.error }, failure.status);
    }
    await audit({
      eventType: "configuration.changed",
      targetType: "learning",
      actorUserId: actor.id,
      payload: {
        change: "learning_run_started",
        containerId,
        runId: run.id,
        by: actor.email,
      },
    });
    return context.json({ run: { id: run.id, status: run.status } });
  });

  /**
   * The first space with a Skill by that name, and that space; undefined when no space could be read and none had it.
   */
  const findInSpaces = async (
    spaces: NonNullable<Awaited<ReturnType<typeof skillSpaces>>>,
    name: string,
  ): Promise<
    { skill: LearnedSkillContent; scope: LearningSource } | null | undefined
  > => {
    let anyRead = false;
    for (const scope of spaces.scopes) {
      const read = await spaces
        .containerSkills(scope.containerId)
        .catch(() => null);
      if (!read || !("skills" in read)) continue;
      anyRead = true;
      const found = read.skills.find((skill) => skill.name === name);
      if (found) return { skill: found, scope };
    }
    return anyRead ? null : undefined;
  };

  /**
   * The person's own recordings a Skill in their recordings space was learned from, with their titles: the same for a
   * Skill they approved and one approved automatically (`readSkillRecordings`). A recording that is not theirs is left
   * out. Undefined where the sources can't be read, which never stops the Skill itself from opening.
   */
  const recordingsOf = async (
    actor: AuthenticatedActor,
    scope: LearningSource,
    name: string,
  ): Promise<LearnedSkillDetail["recordings"]> => {
    const { manage, recordingTitles } = deps;
    if (scope.kind !== "recordings" || !manage || !recordingTitles)
      return undefined;
    try {
      const cited = await readSkillRecordings(manage, scope.containerId, name);
      if (cited.length === 0) return [];
      const titles = await recordingTitles(
        actor.id,
        cited.map((recording) => recording.id),
      );
      return cited.flatMap((recording) =>
        titles.has(recording.id)
          ? [{ ...recording, title: titles.get(recording.id) ?? null }]
          : [],
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "learning-skill-sources-unread",
          containerId: scope.containerId,
          code: requestFailure(error).code ?? null,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return undefined;
    }
  };

  routes.get("/skills/:name", async (context) => {
    const name = context.req.param("name");
    if (!isLearnedSkillName(name)) {
      return context.json({ error: "Name a skill to read." }, 400);
    }
    const actor = context.var.actor;
    const spaces = await skillSpaces(actor);
    let skill: LearnedSkillContent | null | undefined;
    let scope: LearningSource | null = null;
    if (spaces) {
      const found = await findInSpaces(spaces, name);
      skill = found ? found.skill : found;
      scope = found ? found.scope : null;
    } else if (deps.skillOf) {
      skill = await deps.skillOf(actor.id, name).catch(() => undefined);
      // Outside the personal edition the Skill is read from the person's own space, which their recordings join.
      scope = (await sourceFor(actor, undefined)) ?? null;
    } else {
      // No reader is wired here, so trying again can't help.
      return context.json(
        { error: "Reading your skills isn't available here." },
        503,
      );
    }
    if (skill === undefined) {
      return context.json(
        {
          error:
            "Couldn't read your Skills from the backend just now. Try again.",
        },
        503,
      );
    }
    if (skill === null) {
      return context.json({ error: "You have no skill by that name." }, 404);
    }
    const recordings = scope
      ? await recordingsOf(actor, scope, name)
      : undefined;
    const detail: LearnedSkillDetail = {
      ...skill,
      ...(recordings ? { recordings } : {}),
    };
    return context.json({ skill: detail });
  });

  routes.put("/mode", smallBody, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      mode?: unknown;
    } | null;
    if (!isLearningSharingMode(body?.mode)) {
      return context.json(
        { error: "Choose closed, open or choose for your skills." },
        400,
      );
    }
    // Closing is always allowed; opening to every Bot waits for an administrator.
    if (body.mode !== "closed" && !(await deps.sharingAllowed())) {
      return context.json({ error: SHARING_OFF }, 403);
    }
    const userId = context.var.actor.id;
    const { from, to } = await deps.store.setMode(userId, body.mode);
    deps.invalidate();
    if (from !== to) {
      await audit({
        eventType: "learning.sharing_changed",
        targetType: "learning_sharing",
        targetId: userId,
        actorUserId: userId,
        payload: { from, to },
      });
    }
    return context.json({ mode: to });
  });

  routes.put("/auto-approve", smallBody, async (context) => {
    if (currentEdition() !== "personal") {
      return context.notFound();
    }
    const body = (await context.req.json().catch(() => null)) as {
      autoApprove?: unknown;
    } | null;
    if (typeof body?.autoApprove !== "boolean") {
      return context.json(
        { error: "Say whether to approve learned skills automatically." },
        400,
      );
    }
    const autoApprove = body.autoApprove;
    const userId = context.var.actor.id;
    await deps.settings.setAutoApprove(autoApprove);
    await audit({
      eventType: "configuration.changed",
      targetType: "learning",
      actorUserId: userId,
      payload: { change: "auto_approve", to: autoApprove },
    });
    if (autoApprove) {
      try {
        await deps.autoApprover?.sweep();
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "learning-auto-approve-failed",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    return context.json({ autoApprove });
  });

  routes.put("/skills/:name", smallBody, async (context) => {
    const name = context.req.param("name");
    const body = (await context.req.json().catch(() => null)) as {
      open?: unknown;
    } | null;
    if (!isLearnedSkillName(name) || typeof body?.open !== "boolean") {
      return context.json(
        { error: "Name a skill and say whether it is open to everyone." },
        400,
      );
    }
    if (body.open && !(await deps.sharingAllowed())) {
      return context.json({ error: SHARING_OFF }, 403);
    }
    const userId = context.var.actor.id;
    /*
     * Only a Skill the person has. Opening is checked against the Skills published in their own space, read the way a
     * run reads them, so nobody can open a name in advance for a Skill they do not have yet. Closing also accepts a
     * name they opened earlier that has since left their space, so an entry can always be taken back.
     */
    const [read, sharing] = await Promise.all([
      deps.skillsOf(userId),
      body.open ? undefined : deps.store.read(userId),
    ]);
    const theirs =
      ("skills" in read && read.skills.some((skill) => skill.name === name)) ||
      (sharing?.openSkills.includes(name) ?? false);
    if (!theirs) {
      if ("skills" in read)
        return context.json({ error: "You have no skill by that name." }, 404);
      return read.unavailable === "off"
        ? context.json(
            {
              error:
                "An admin has turned off automatic learning, so you have no skills to change.",
            },
            409,
          )
        : context.json(
            {
              error:
                "Couldn't check your Skills with the backend just now, so nothing changed. Try again.",
            },
            503,
          );
    }
    const changed = await deps.store.setSkillOpen(userId, name, body.open);
    deps.invalidate();
    if (changed) {
      await audit({
        eventType: body.open
          ? "learning.skill_opened"
          : "learning.skill_closed",
        targetType: "learned_skill",
        targetId: name,
        actorUserId: userId,
        payload: { skill: name },
      });
    }
    return context.json({ name, open: body.open });
  });

  /**
   * Ask an admin to share a skill the person approved for themselves. Only where an admin decides sharing: not in the
   * personal edition, and not while the admin hasn't turned on sharing skills with every Bot.
   */
  routes.post("/skills/:name/share-request", smallBody, async (context) => {
    if (currentEdition() === "personal") {
      return context.notFound();
    }
    const name = context.req.param("name");
    if (!isLearnedSkillName(name)) {
      return context.json({ error: "Name a skill to ask to share." }, 400);
    }
    if (!(await deps.sharingAllowed())) {
      return context.json({ error: SHARING_OFF }, 403);
    }
    const userId = context.var.actor.id;
    const row = await deps.approvals.get(userId, name);
    if (
      row?.approvedBy === "person" &&
      (row.sharing === "approved" || row.sharing === "requested")
    ) {
      return context.json({ name, sharing: row.sharing });
    }
    if (!(await deps.approvals.requestSharing(userId, name))) {
      return context.json(
        {
          error:
            "Only a skill you approved yourself needs an admin to share it. Share any other skill with its Open switch.",
        },
        409,
      );
    }
    await audit({
      eventType: "learning.sharing_requested",
      targetType: "learned_skill",
      targetId: name,
      actorUserId: userId,
      payload: { skill: name },
    });
    return context.json({ name, sharing: "requested" });
  });

  return routes;
}
