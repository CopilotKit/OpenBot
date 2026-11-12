/**
 * Project folders: the storage half.
 *
 * A project is one person's filing of their own conversations. Nothing here grants access to a
 * channel: `moveChannel` refuses a channel the caller is not in, and every channel route keeps
 * resolving the caller in `channel_memberships` as before. A folder only decides where a row is
 * drawn in that person's sidebar.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import {
  channelMemberships,
  channelProjects,
  channels,
  projects,
} from "../db/schema";

/** A folder as the sidebar needs it: its name, its order, and which conversations it holds. */
export type ProjectSummary = {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  /**
   * The conversations filed here, by id only.
   *
   * Ids rather than names, because this is the one read that could otherwise carry a channel's
   * title to somebody who cannot open it. A folder holds only its owner's channels, and the query
   * below filters to channels that person is still a member of, so nothing leaks — and with ids
   * alone there is nothing in the payload to leak even if that filter were ever wrong.
   */
  channelIds: string[];
};

/** No such folder, or one belonging to somebody else. The caller is told the same thing either way. */
export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`Project ${id} was not found.`);
    this.name = "ProjectNotFoundError";
  }
}

/**
 * The channel is not one the caller can open.
 *
 * A deleted channel answers the same way a channel somebody else owns does, which is the rule the
 * channel routes already follow: a member who is not one is not told which of the two it was.
 */
export class ProjectChannelNotFoundError extends Error {
  constructor(id: string) {
    super(`Channel ${id} was not found.`);
    this.name = "ProjectChannelNotFoundError";
  }
}

/** A name a folder can carry: trimmed, not empty, and short enough for a sidebar row. */
export const MAX_PROJECT_NAME_LENGTH = 60;

export type ProjectStore = {
  /** This person's folders, in their order, each with the conversations it holds. */
  list(actor: AgentActor): Promise<ProjectSummary[]>;
  create(actor: AgentActor, name: string): Promise<ProjectSummary>;
  /** Renames a folder. Throws `ProjectNotFoundError` for anybody but its owner. */
  rename(
    actor: AgentActor,
    projectId: string,
    name: string,
  ): Promise<ProjectSummary>;
  /**
   * Deletes a folder and its filing, leaving every conversation in it untouched: the rows in
   * `channel_projects` go with the project, and the channels return to Group/Direct on the next
   * read. Throws `ProjectNotFoundError` for anybody but its owner.
   */
  remove(actor: AgentActor, projectId: string): Promise<void>;
  /**
   * Files a conversation into a folder of the caller's, or takes it out when `projectId` is null.
   *
   * Refuses with `ProjectChannelNotFoundError` when the caller is not a member of the channel, and
   * with `ProjectNotFoundError` when the folder is not theirs — so a member cannot be filed into
   * somebody else's project, and a stranger cannot learn a channel exists by trying to move it.
   */
  moveChannel(
    actor: AgentActor,
    channelId: string,
    projectId: string | null,
  ): Promise<void>;
};

export function createProjectStore(database: Database): ProjectStore {
  /** The folder, if this person owns it. Used before every write. */
  const owned = async (actor: AgentActor, projectId: string) => {
    const [row] = await database
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.id, projectId), eq(projects.ownerUserId, actor.id)),
      )
      .limit(1);
    if (!row) throw new ProjectNotFoundError(projectId);
    return row;
  };

  /**
   * The conversations this person has filed, grouped by folder.
   *
   * Read with the membership join rather than from the filing rows alone: a folder must never name
   * a conversation its owner cannot open, whether the channel was deleted or they are no longer in
   * it, and this is the same join every channel route resolves its caller with.
   */
  const filedByProject = async (userId: string) => {
    const filed = await database
      .select({
        projectId: channelProjects.projectId,
        channelId: channelProjects.channelId,
      })
      .from(channelProjects)
      .innerJoin(channels, eq(channels.id, channelProjects.channelId))
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channelProjects.channelId),
          eq(channelMemberships.userId, userId),
        ),
      )
      /* A deleted conversation is not there to be listed in a folder either. */
      .where(
        and(
          eq(channelProjects.ownerUserId, userId),
          isNull(channels.deletedAt),
        ),
      );

    const byProject = new Map<string, string[]>();
    for (const row of filed) {
      const ids = byProject.get(row.projectId);
      if (ids) ids.push(row.channelId);
      else byProject.set(row.projectId, [row.channelId]);
    }
    return byProject;
  };

  return {
    async list(actor) {
      const rows = await database
        .select({
          id: projects.id,
          name: projects.name,
          sortOrder: projects.sortOrder,
          createdAt: projects.createdAt,
          updatedAt: projects.updatedAt,
        })
        .from(projects)
        .where(eq(projects.ownerUserId, actor.id))
        .orderBy(
          asc(projects.sortOrder),
          asc(projects.createdAt),
          asc(projects.id),
        );

      const byProject = await filedByProject(actor.id);

      return rows.map((row) => ({
        ...row,
        channelIds: byProject.get(row.id) ?? [],
      }));
    },

    async create(actor, name) {
      /*
       * The order is read then written rather than derived in one statement, which two folders
       * created at the same instant could both pass. The tie is not a correctness problem — the
       * listing breaks it on `created_at` and then `id` — so the extra round trip buys a stable
       * order without a lock on every creation.
       */
      const [next] = await database
        .select({
          sortOrder: sql<number>`coalesce(max(${projects.sortOrder}) + 1, 0)::int`,
        })
        .from(projects)
        .where(eq(projects.ownerUserId, actor.id));
      const [created] = await database
        .insert(projects)
        .values({
          id: `project_${crypto.randomUUID()}`,
          ownerUserId: actor.id,
          name,
          sortOrder: next?.sortOrder ?? 0,
        })
        .returning({
          id: projects.id,
          name: projects.name,
          sortOrder: projects.sortOrder,
          createdAt: projects.createdAt,
          updatedAt: projects.updatedAt,
        });
      if (!created) throw new Error("The project could not be created.");
      return { ...created, channelIds: [] };
    },

    async rename(actor, projectId, name) {
      const [renamed] = await database
        .update(projects)
        .set({ name, updatedAt: new Date() })
        .where(
          and(eq(projects.id, projectId), eq(projects.ownerUserId, actor.id)),
        )
        .returning({
          id: projects.id,
          name: projects.name,
          sortOrder: projects.sortOrder,
          createdAt: projects.createdAt,
          updatedAt: projects.updatedAt,
        });
      if (!renamed) throw new ProjectNotFoundError(projectId);
      // A rename leaves the filing alone, so the folder is read back rather than guessed at.
      const filed = await filedByProject(actor.id);
      return { ...renamed, channelIds: filed.get(projectId) ?? [] };
    },

    async remove(actor, projectId) {
      const [deleted] = await database
        .delete(projects)
        .where(
          and(eq(projects.id, projectId), eq(projects.ownerUserId, actor.id)),
        )
        .returning({ id: projects.id });
      /*
       * The filing rows go with the project by cascade. The channels are untouched: no channel
       * row, membership or transcript is referenced by the row that was deleted, which is what
       * makes "deleting a folder returns its conversations" true rather than a cleanup step.
       */
      if (!deleted) throw new ProjectNotFoundError(projectId);
    },

    async moveChannel(actor, channelId, projectId) {
      /* Membership first, in the same place every channel route resolves it. */
      const [membership] = await database
        .select({ channelId: channelMemberships.channelId })
        .from(channelMemberships)
        .innerJoin(channels, eq(channels.id, channelMemberships.channelId))
        .where(
          and(
            eq(channelMemberships.channelId, channelId),
            eq(channelMemberships.userId, actor.id),
            isNull(channels.deletedAt),
          ),
        )
        .limit(1);
      if (!membership) throw new ProjectChannelNotFoundError(channelId);

      if (projectId === null) {
        // Out of whatever folder this person had it in. Nothing else changes.
        await database
          .delete(channelProjects)
          .where(
            and(
              eq(channelProjects.channelId, channelId),
              eq(channelProjects.ownerUserId, actor.id),
            ),
          );
        return;
      }

      const project = await owned(actor, projectId);
      /*
       * Upsert on the per-person key, so filing a conversation that is already in a folder moves
       * it rather than failing on the primary key of the row it is leaving.
       */
      await database
        .insert(channelProjects)
        .values({ projectId: project.id, channelId, ownerUserId: actor.id })
        .onConflictDoUpdate({
          target: [channelProjects.channelId, channelProjects.ownerUserId],
          set: { projectId: project.id },
        });
    },
  };
}
