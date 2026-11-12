/**
 * Project folders for the sidebar.
 *
 * A project is a person's own filing of conversations: it groups channels in their sidebar and
 * nothing else. It carries no permission of its own — every channel route still resolves the caller
 * in `channel_memberships` — so a project can only ever hold a channel its owner could already
 * open, and moving one into a folder is filing rather than sharing.
 */
import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { channels, users } from "./core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * One person's folder of conversations.
 *
 * Per person, unlike a channel: two members of the same channel each file it where they like, and a
 * project belongs to the person who made it. That is why the filing lives in the join table below
 * rather than as a `project_id` column on `channels`, which would have to mean one folder for
 * everybody who can see the channel.
 */
export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    /** Who made it, and the only person who may rename it, delete it or file channels into it. */
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Where the folder sits in this person's Projects section. Ties fall back to `created_at`. */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** The Projects section reads one person's folders, in their order. */
    index("projects_by_owner_idx").on(
      table.ownerUserId,
      table.sortOrder,
      table.createdAt,
    ),
  ],
);

/**
 * Which conversation a person has filed in which of their folders.
 *
 * THREE COLUMNS, NOT TWO, because the fact being stored is per person. `owner_user_id` is the same
 * value as `projects.owner_user_id` and exists so the uniqueness rule below can be expressed in one
 * index: one folder per conversation per person, while two people may file the same conversation
 * into two different folders. Neither a primary key on `(project_id, channel_id)` nor a nullable
 * column on `channels` can say that.
 *
 * Deleting a project deletes these rows and nothing else, so the conversations return to the
 * Group/Direct sections intact.
 */
export const channelProjects = pgTable(
  "channel_projects",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /**
     * The person whose filing this is. Written from the project's owner, which never changes, and
     * kept here rather than joined at read time so a violation of "one folder per person" is a
     * constraint rather than a race two requests could both pass.
     */
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.channelId] }),
    uniqueIndex("channel_projects_one_folder_per_person_idx").on(
      table.channelId,
      table.ownerUserId,
    ),
    /** Reading a page of channels joins this by (channel, person) on every roster request. */
    index("channel_projects_by_owner_channel_idx").on(
      table.ownerUserId,
      table.channelId,
    ),
  ],
);