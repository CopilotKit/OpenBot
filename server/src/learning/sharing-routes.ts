import {
  isLearnedSkillName,
  isLearningSharingMode,
  type LearnedSkillContent,
  type LearningSource,
  type PersonalLearningSharing,
  type PersonalReview,
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
  learningFailure,
  readProposal,
  readProposals,
  requestFailure,
  reviewProposal,
  runSummary,
} from "./review";
import type { LearningSettingsStore } from "./settings";
import type { LearningSharingStore } from "./sharing";

export type PersonalLearningRouteDeps = {
  store: LearningSharingStore;
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
  /** The Learning spaces this person reviews (learning/scopes.ts). */
  scopesFor: (actor: AuthenticatedActor) => Promise<LearningSource[]>;
  /** The titles of this person's own recordings by id; an id they don't own is left out. */
  recordingTitles?: (
    userId: string,
    ids: string[],
  ) => Promise<Map<string, string | null>>;
};

/** What a person reads when they try to open their Skills while an administrator has not allowed it. */
const SHARING_OFF =
  "An admin hasn't turned on sharing Skills with every Bot, so your Skills stay with your own Bots.";

const smallBody = bodyLimit({
  maxSize: 2 * 1024,
  onError: (context) =>
    context.json({ error: "That request is too large." }, 413),
});

/**
 * Settings, Learning: who else's Bots use the Skills learned from a person's own recordings. Theirs alone, scoped to the
 * signed-in person and never to anything in the path, like their standing instructions: there is no route for reading
 * or changing somebody else's.
 */
export function createPersonalLearningRoutes(
  deps: PersonalLearningRouteDeps,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);

  const audit = async (event: Parameters<typeof recordAuditEvent>[1]) => {
    if (!deps.auditStore) return;
    await recordAuditEvent(deps.auditStore, event);
  };

  routes.get("/", async (context) => {
    const userId = context.var.actor.id;
    const [sharing, read, sharingAllowed] = await Promise.all([
      deps.store.read(userId),
      deps.skillsOf(userId),
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
                const approval = await deps.approvals.get(userId, skill.name);
                return {
                  ...skill,
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
        { error: "Couldn't reach Intelligence just now. Try again." },
        503,
      );
    }
    const [scopes, allowed] = await Promise.all([
      deps.scopesFor(context.var.actor),
      canReview(),
    ]);
    const sources = await Promise.all(
      scopes.map(async (source) => {
        const [proposals, runs] = await Promise.all([
          readProposals(manage, source.containerId).catch(() => null),
          manage
            .listLearningRuns({ containerId: source.containerId })
            .catch(() => null),
        ]);
        const latest = runs
          ? [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
          : undefined;
        return {
          ...source,
          proposals:
            proposals?.filter((entry) => entry.status === "pending_review") ??
            null,
          latestRun: latest ? runSummary(latest) : null,
        };
      }),
    );
    const answer: PersonalReview = {
      canReview: allowed,
      autoApprove: null,
      sources,
    };
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
        { error: "Couldn't reach Intelligence just now. Try again." },
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
      const failure = learningFailure(error);
      return context.json({ error: failure.error }, failure.status);
    }
  });

  /**
   * Approve or reject a proposal from the person's own space. On approve, OpenBot writes its own record of who approved
   * the skill before Intelligence is asked, and takes it back if Intelligence refuses.
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
          { error: "An admin reviews these skills. You can't approve them." },
          403,
        );
      }
      const manage = deps.manage;
      if (!manage) {
        return context.json(
          { error: "Couldn't reach Intelligence just now. Try again." },
          503,
        );
      }
      const containerId = source.containerId;
      try {
        const review = await reviewProposal({
          manage,
          containerId,
          candidateId,
          action,
          ...(action === "approve" && source.kind === "recordings"
            ? {
                before: recordApprovalBefore(
                  deps.approvals,
                  actor.id,
                  "person",
                ),
              }
            : {}),
        });
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
      } catch (error) {
        if (error instanceof UnnamedSkillError) {
          return context.json({ error: error.message }, 422);
        }
        const failure = learningFailure(error);
        await audit({
          eventType: "configuration.changed",
          targetType: "learning_skill",
          targetId: candidateId,
          actorUserId: actor.id,
          payload: {
            change: "skill_review_failed",
            decision: action,
            containerId,
            code: requestFailure(error).code ?? null,
            by: actor.email,
          },
        });
        return context.json({ error: failure.error }, failure.status);
      }
    });
  }

  routes.get("/skills/:name", async (context) => {
    const name = context.req.param("name");
    if (!isLearnedSkillName(name)) {
      return context.json({ error: "Name a Skill to read." }, 400);
    }
    const skill = await deps
      .skillOf?.(context.var.actor.id, name)
      .catch(() => undefined);
    if (skill === undefined) {
      return context.json(
        {
          error:
            "Couldn't read your Skills from Intelligence just now. Try again.",
        },
        503,
      );
    }
    if (skill === null) {
      return context.json({ error: "You have no Skill by that name." }, 404);
    }
    return context.json({ skill });
  });

  routes.put("/mode", smallBody, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      mode?: unknown;
    } | null;
    if (!isLearningSharingMode(body?.mode)) {
      return context.json(
        { error: "Choose closed, open or choose for your Skills." },
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

  routes.put("/skills/:name", smallBody, async (context) => {
    const name = context.req.param("name");
    const body = (await context.req.json().catch(() => null)) as {
      open?: unknown;
    } | null;
    if (!isLearnedSkillName(name) || typeof body?.open !== "boolean") {
      return context.json(
        { error: "Name a Skill and say whether it is open to everyone." },
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
        return context.json({ error: "You have no Skill by that name." }, 404);
      return read.unavailable === "off"
        ? context.json(
            {
              error:
                "An admin has turned off Automatic Learning, so you have no Skills to change.",
            },
            409,
          )
        : context.json(
            {
              error:
                "Couldn't check your Skills with Intelligence just now, so nothing changed. Try again.",
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

  routes.post("/skills/:name/share-request", smallBody, async (context) => {
    const name = context.req.param("name");
    if (!isLearnedSkillName(name)) {
      return context.json({ error: "Name a Skill to ask to share." }, 400);
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
            "Only a Skill you approved yourself needs an admin to share it. Share any other Skill with its Open switch.",
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
