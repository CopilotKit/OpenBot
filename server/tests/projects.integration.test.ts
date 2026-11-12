import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  channelMemberships,
  channelProjects,
  channels,
  projects,
  users,
} from "../src/db/schema";
import {
  createChannelProjectRoutes,
  createProjectRoutes,
} from "../src/projects/routes";
import { createProjectStore } from "../src/projects/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Project folders: who may rename and delete one, what may be filed into it, and what a folder is
 * allowed to say about the conversations inside it.
 *
 * A folder is one person's filing and carries no permission of its own (see
 * `src/db/schema/projects.ts`). Everything a folder can be refused for is therefore decided in the
 * project store's WHERE clauses and in the membership join that fills `channelIds`, and a test that
 * asserted against an in-memory stand-in for the store would pass with every one of those clauses
 * deleted. So this file runs the real store against PostgreSQL and the real routers over it, and
 * every refusal is checked twice: the status the browser gets, and the rows the database still
 * holds afterwards. A stranger's write is asserted to be 404 (never 403, so the answer does not
 * confirm the folder exists, and never 500, which is what an unguarded `update` on somebody else's
 * row would have produced).
 *
 * Faked: nothing. The conversation is a row in `channels` with a `channel_memberships` row, which
 * is exactly what a real conversation is before agents and transcripts enter the picture, and the
 * subject here is filing rather than conversation lifecycle.
 *
 * How to run it, from the repository root:
 *
 *   docker run -d --name openbot-test-pg -e POSTGRES_DB=openbot_test -e POSTGRES_USER=openbot \
 *     -e POSTGRES_PASSWORD=openbot -p 127.0.0.1:55432:5432 pgvector/pgvector:pg17
 *   DATABASE_URL=postgres://openbot:openbot@127.0.0.1:55432/openbot_test bun server/scripts/migrate.ts
 *   TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:55432/openbot_test \
 *     bun test server/tests/projects.integration.test.ts
 *
 * `TEST_DATABASE_URL` is refused unless it names a dedicated database (`support/database.ts`), so
 * the run can never reach the developer's own `openbot` rows.
 */

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const projectStore = createProjectStore(database);
const suite = `projects-${randomUUID().slice(0, 8)}`;

const createdUserIds: string[] = [];
const createdChannelIds: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

/** One person, as the session resolves them. */
async function person(name = "Project Test"): Promise<AuthenticatedActor> {
  const id = `${suite}-user-${randomUUID()}`;
  const email = `${id}@example.test`;
  await database.insert(users).values({ id, email, name });
  createdUserIds.push(id);
  return { id, email, name, role: "user" };
}

/** A conversation, named the way the sidebar would draw it. */
async function conversation(title: string): Promise<string> {
  const id = `channel_${randomUUID()}`;
  await database.insert(channels).values({ id, name: title, description: "" });
  createdChannelIds.push(id);
  return id;
}

/** What `channel_memberships` is for: the one row every channel route resolves its caller in. */
async function memberOf(channelId: string, userId: string): Promise<void> {
  await database.insert(channelMemberships).values({ channelId, userId });
}

type ProjectPayload = {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  channelIds: string[];
};

/** The browser's side: the four requests it makes, mounted over the real store. */
function browserFor(actor: AuthenticatedActor) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/api/projects", createProjectRoutes(projectStore, requireUser));
  app.route(
    "/api/channels",
    createChannelProjectRoutes(projectStore, requireUser),
  );

  const json = { "content-type": "application/json" };

  return {
    async create(name: string) {
      const response = await app.request("/api/projects", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ name }),
      });
      return {
        status: response.status,
        body: (await response.json()) as {
          project?: ProjectPayload;
          error?: string;
        },
      };
    },
    /** The sidebar's read: this person's folders and the conversations filed in them. */
    async list() {
      const response = await app.request("/api/projects");
      expect(response.status).toBe(200);
      const text = await response.text();
      return { text, body: JSON.parse(text) as { projects: ProjectPayload[] } };
    },
    async rename(projectId: string, name: unknown) {
      const response = await app.request(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: json,
        body: JSON.stringify({ name }),
      });
      return {
        status: response.status,
        body: (await response.json()) as {
          project?: ProjectPayload;
          error?: string;
        },
      };
    },
    async remove(projectId: string) {
      const response = await app.request(`/api/projects/${projectId}`, {
        method: "DELETE",
      });
      return { status: response.status };
    },
    /** `projectId: null` is the menu's "remove from project". */
    async move(channelId: string, projectId: string | null) {
      const response = await app.request(`/api/channels/${channelId}/project`, {
        method: "PATCH",
        headers: json,
        body: JSON.stringify({ projectId }),
      });
      return {
        status: response.status,
        body: (await response.json().catch(() => null)) as {
          error?: string;
        } | null,
      };
    },
  };
}

/** The folder row, or undefined when it is gone. */
async function folderRow(projectId: string) {
  const [row] = await database
    .select({
      id: projects.id,
      name: projects.name,
      ownerUserId: projects.ownerUserId,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row;
}

/** Every filing row for one conversation, whoever made it. */
async function filingsOf(channelId: string) {
  return await database
    .select({
      projectId: channelProjects.projectId,
      ownerUserId: channelProjects.ownerUserId,
    })
    .from(channelProjects)
    .where(eq(channelProjects.channelId, channelId));
}

describe("who a folder belongs to", () => {
  test("its owner renames it and reads the new name back", async () => {
    const owner = await person();
    const browser = browserFor(owner);

    // The create form sends what was typed, newlines and all; the row is one trimmed line.
    const created = await browser.create("  Q3   planning\nnotes ");
    expect(created.status).toBe(201);
    const projectId = created.body.project?.id ?? "";
    expect(created.body.project?.name).toBe("Q3 planning notes");
    expect(created.body.project?.channelIds).toEqual([]);

    const renamed = await browser.rename(projectId, "Hiring");
    expect(renamed.status).toBe(200);
    expect(renamed.body.project?.name).toBe("Hiring");

    // Written, not echoed: the row is what a reload reads.
    expect((await folderRow(projectId))?.name).toBe("Hiring");
    expect((await browser.list()).body.projects.map((p) => p.name)).toEqual([
      "Hiring",
    ]);
  });

  test("a stranger's rename is refused as not found and changes nothing", async () => {
    const owner = await person();
    const stranger = await person();
    const projectId =
      (await browserFor(owner).create("Board")).body.project?.id ?? "";

    const refused = await browserFor(stranger).rename(projectId, "Mine now");

    // 404 rather than 403: the answer must not confirm that somebody else's folder exists. What it
    // must never be is a 500, which is what an ownership check added after the update would give.
    expect(refused.status).toBe(404);
    expect(refused.status).not.toBe(500);
    expect(refused.body.error).toBe("Couldn't find that project.");
    expect((await folderRow(projectId ?? ""))?.name).toBe("Board");
    // And the stranger has nothing to see either.
    expect((await browserFor(stranger).list()).body.projects).toEqual([]);
  });

  test("a stranger's delete leaves the folder and everything filed in it", async () => {
    const owner = await person();
    const stranger = await person();
    const browser = browserFor(owner);
    const projectId = (await browser.create("Board")).body.project?.id ?? "";
    const channelId = await conversation("Q3 headcount");
    await memberOf(channelId, owner.id);
    expect((await browser.move(channelId, projectId)).status).toBe(204);

    const refused = await browserFor(stranger).remove(projectId);

    expect(refused.status).toBe(404);
    expect(refused.status).not.toBe(500);
    expect((await folderRow(projectId))?.name).toBe("Board");
    expect(await filingsOf(channelId)).toEqual([
      { projectId, ownerUserId: owner.id },
    ]);
  });

  test("its owner deletes it, and the folder is gone from the list", async () => {
    const owner = await person();
    const browser = browserFor(owner);
    const projectId = (await browser.create("Board")).body.project?.id ?? "";

    const removed = await browser.remove(projectId);

    expect(removed.status).toBe(204);
    expect(await folderRow(projectId)).toBeUndefined();
    expect((await browser.list()).body.projects).toEqual([]);
  });

  test("a folder name is required, one line, and short enough for a row", async () => {
    const owner = await person();
    const browser = browserFor(owner);

    expect((await browser.create("   ")).status).toBe(400);
    // A body that is not an object is a 400 as well, not a 500 from reading `.name` off it.
    const notAnObject = await browserFor(owner).rename("missing", ["Board"]);
    expect(notAnObject.status).toBe(400);

    const projectId = (await browser.create("Board")).body.project?.id ?? "";
    const tooLong = await browser.rename(projectId, "x".repeat(61));
    expect(tooLong.status).toBe(400);
    expect((await folderRow(projectId))?.name).toBe("Board");
  });
});

describe("filing a conversation into a folder", () => {
  test("a member files a conversation, moves it, and takes it out", async () => {
    const owner = await person();
    const browser = browserFor(owner);
    const planning = (await browser.create("Planning")).body.project?.id ?? "";
    const hiring = (await browser.create("Hiring")).body.project?.id ?? "";
    const channelId = await conversation("Q3 headcount");
    await memberOf(channelId, owner.id);

    expect((await browser.move(channelId, planning)).status).toBe(204);
    expect(await filingsOf(channelId)).toEqual([
      { projectId: planning, ownerUserId: owner.id },
    ]);
    expect(
      (await browser.list()).body.projects.flatMap((p) => p.channelIds),
    ).toEqual([channelId]);

    // Filing it somewhere else MOVES it: one person files one conversation once.
    expect((await browser.move(channelId, hiring)).status).toBe(204);
    expect(await filingsOf(channelId)).toEqual([
      { projectId: hiring, ownerUserId: owner.id },
    ]);

    expect((await browser.move(channelId, null)).status).toBe(204);
    expect(await filingsOf(channelId)).toEqual([]);
  });

  test("a non-member filing somebody else's conversation is refused as not found", async () => {
    const owner = await person();
    const stranger = await person();
    const projectId =
      (await browserFor(stranger).create("Snooping")).body.project?.id ?? "";
    const channelId = await conversation("Board salaries Q3");
    await memberOf(channelId, owner.id);

    const refused = await browserFor(stranger).move(channelId, projectId);

    // The channel route's own rule, reached through the filing: a stranger is not told whether the
    // conversation exists or was deleted. Not a 500 from inserting a membership-less channel.
    expect(refused.status).toBe(404);
    expect(refused.status).not.toBe(500);
    expect(refused.body?.error).toBe("Couldn't find that conversation.");
    expect(await filingsOf(channelId)).toEqual([]);
    expect(
      (await browserFor(stranger).list()).body.projects.flatMap(
        (p) => p.channelIds,
      ),
    ).toEqual([]);
  });

  test("a member cannot file a conversation into somebody else's folder", async () => {
    const owner = await person();
    const colleague = await person();
    const channelId = await conversation("Q3 headcount");
    // Both people are in the conversation, so the membership gate is passed and the folder's
    // ownership is the only thing left to refuse them.
    await memberOf(channelId, owner.id);
    await memberOf(channelId, colleague.id);
    const ownersFolder =
      (await browserFor(owner).create("Board")).body.project?.id ?? "";
    expect((await browserFor(owner).move(channelId, ownersFolder)).status).toBe(
      204,
    );

    // Same conversation, somebody else's folder id: refusing this keeps a folder from being filled
    // by anyone but the person whose sidebar it is.
    const refused = await browserFor(colleague).move(channelId, ownersFolder);
    expect(refused.status).toBe(404);
    expect(refused.status).not.toBe(500);
    expect(refused.body?.error).toBe("Couldn't find that project.");
    // The owner's filing is untouched by the attempt, and the colleague's own sidebar is empty.
    expect(await filingsOf(channelId)).toEqual([
      { projectId: ownersFolder, ownerUserId: owner.id },
    ]);
    expect(
      (await browserFor(colleague).list()).body.projects.flatMap(
        (p) => p.channelIds,
      ),
    ).toEqual([]);
  });
});

describe("what a folder is allowed to say", () => {
  test("it names a conversation only while its owner can still open it", async () => {
    const owner = await person();
    const browser = browserFor(owner);
    const projectId = (await browser.create("Board")).body.project?.id ?? "";
    const mine = await conversation("Q3 headcount");
    const takenAway = await conversation("Former team retro");
    await memberOf(mine, owner.id);
    await memberOf(takenAway, owner.id);
    expect((await browser.move(mine, projectId)).status).toBe(204);
    expect((await browser.move(takenAway, projectId)).status).toBe(204);

    // Membership withdrawn after the filing: the store refuses a new filing like this, so the row
    // goes in directly to stand for a person removed from a group while their folder remembered it.
    await database
      .delete(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, takenAway),
          eq(channelMemberships.userId, owner.id),
        ),
      );

    const folder = (await browser.list()).body.projects.find(
      (p) => p.id === projectId,
    );
    expect(folder?.channelIds).toEqual([mine]);
  });

  test("it carries conversation ids and never a conversation title", async () => {
    const owner = await person();
    const browser = browserFor(owner);
    const projectId = (await browser.create("Board")).body.project?.id ?? "";
    const titled = "Board salaries Q3 — confidential";
    const channelId = await conversation(titled);
    await memberOf(channelId, owner.id);
    expect((await browser.move(channelId, projectId)).status).toBe(204);

    const { text, body } = await browser.list();

    // The title is what a person who cannot open the conversation must never learn, and ids are the
    // one shape of answer that cannot carry it even if a filter above were wrong.
    expect(text).not.toContain(titled);
    expect(text).not.toContain("confidential");
    expect(Object.keys(body.projects[0] ?? {}).sort()).toEqual([
      "channelIds",
      "createdAt",
      "id",
      "name",
      "sortOrder",
      "updatedAt",
    ]);
    expect(body.projects[0]?.channelIds).toEqual([channelId]);
  });

  test("somebody else's folders are not in the answer at all", async () => {
    const owner = await person();
    const stranger = await person();
    const projectId =
      (await browserFor(owner).create("Board")).body.project?.id ?? "";

    const { text, body } = await browserFor(stranger).list();

    expect(body.projects).toEqual([]);
    expect(text).not.toContain(projectId);
  });
});

describe("deleting a folder", () => {
  test("returns its conversations, still filed where anybody else put them", async () => {
    const owner = await person();
    const colleague = await person();
    const channelId = await conversation("Q3 headcount");
    await memberOf(channelId, owner.id);
    await memberOf(channelId, colleague.id);
    const ownersBrowser = browserFor(owner);
    const ownersFolder =
      (await ownersBrowser.create("Board")).body.project?.id ?? "";
    const colleaguesFolder =
      (await browserFor(colleague).create("Team")).body.project?.id ?? "";
    expect((await ownersBrowser.move(channelId, ownersFolder)).status).toBe(
      204,
    );
    expect(
      (await browserFor(colleague).move(channelId, colleaguesFolder)).status,
    ).toBe(204);

    expect((await ownersBrowser.remove(ownersFolder)).status).toBe(204);

    /*
     * A folder files a conversation through a row in `channel_projects`; a channel has no
     * `project_id` column to clear (see db/schema/projects.ts, and why). So "the project_id is taken
     * off" is that row being gone, and the other person's filing of the same conversation being
     * still there — the same conversation filed in two folders, one of which was deleted.
     */
    expect(await filingsOf(channelId)).toEqual([
      { projectId: colleaguesFolder, ownerUserId: colleague.id },
    ]);

    // The conversation itself is untouched: deleting a folder is a sidebar act, not a delete.
    const [channel] = await database
      .select({
        id: channels.id,
        name: channels.name,
        deletedAt: channels.deletedAt,
      })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    expect(channel).toEqual({
      id: channelId,
      name: "Q3 headcount",
      deletedAt: null,
    });
    expect(
      await database
        .select({ userId: channelMemberships.userId })
        .from(channelMemberships)
        .where(eq(channelMemberships.channelId, channelId)),
    ).toHaveLength(2);

    // Both sidebars agree afterwards: the folder is gone for its owner, and the conversation is
    // still filed for the colleague.
    const owners = await ownersBrowser.list();
    expect(owners.body.projects).toEqual([]);
    expect(owners.text).not.toContain(channelId);
    expect(
      (await browserFor(colleague).list()).body.projects.flatMap(
        (p) => p.channelIds,
      ),
    ).toEqual([channelId]);

    // And it can be filed again, into a folder made after the delete.
    const planning =
      (await ownersBrowser.create("Planning")).body.project?.id ?? "";
    expect((await ownersBrowser.move(channelId, planning)).status).toBe(204);
    expect(await filingsOf(channelId)).toEqual(
      expect.arrayContaining([
        { projectId: planning, ownerUserId: owner.id },
        { projectId: colleaguesFolder, ownerUserId: colleague.id },
      ]),
    );
  });
});
