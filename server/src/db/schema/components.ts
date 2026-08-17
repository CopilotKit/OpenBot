import {
  boolean,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { agents } from "./core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * A component a Bot may answer with, and the state that governs it.
 *
 * The code owns the component; this table owns its governance. The React file and its schema are
 * compiled into the app and cannot be edited from here. What lives in a row is everything a
 * deployment decides at runtime: whether it is published at all, what the model is told about it, and
 * who last changed that. A fork that deletes `RecordCard` leaves a row with nothing to draw it, which
 * the Admin page reports rather than hiding, a catalogue that silently disagrees with the build is
 * worse than one that says so.
 *
 * `name` is the primary key and a contract. It is the tool name the model calls, the key the
 * app maps to a renderer, and the thing a customer's fork keeps when it replaces the component. A
 * surrogate id would let two rows claim one name and would break that mapping silently.
 */
export const components = pgTable("components", {
  name: text("name").primaryKey(),
  title: text("title").notNull(),
  /** Grouping for the Admin page only: chart, card, decision. Never read by the model. */
  kind: text("kind").notNull(),

  /**
   * The draft and the published description, which is the only version pair a compiled component can
   * have.
   *
   * The description is not decoration: it is what the model reads while deciding whether to call
   * this component at all, so changing it changes behaviour. That makes it exactly the thing that
   * should not take effect the moment somebody types it. A draft is edited freely and changes
   * nothing; publishing promotes it and the next run sees it.
   */
  draftDescription: text("draft_description").notNull(),
  /** Null until first published. Null means the model is never offered this component. */
  publishedDescription: text("published_description"),

  published: boolean("published").notNull().default(false),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  /** Who last changed anything about this component. An email, because that is what a reader knows. */
  updatedBy: text("updated_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * One Bot held back from one component. A published component is available to every Bot; a row here
 * is the exception.
 *
 * Open by default because a component is a way of answering, not a way of reaching anything. What a
 * component may READ is {@link componentFunctions}, which is strict: no row, no call.
 */
export const componentExclusions = pgTable(
  "component_exclusions",
  {
    componentName: text("component_name")
      .notNull()
      .references(() => components.name, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** An email. Who decided this Bot should not answer with this. */
    withheldBy: text("withheld_by"),
    withheldAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.componentName, table.agentId] })],
);

/**
 * The functions one component may call. A row is the permission.
 *
 * Same shape as a grant, for the same reason. Absence is the refusal, so a component nobody has
 * granted anything can call nothing, including a component somebody added this morning, and one
 * whose grants were lost. There is no "denied" row to forget to write.
 *
 * Keyed on the component, not the Bot. A component only renders for a Bot that
 * holds it, so the Bot is already gated one level up; adding it here would be a second lock on the
 * same door and a second place for the two to disagree. Which Bot was on screen is recorded on every
 * call, because that is a fact about the call rather than about the permission.
 */
export const componentFunctions = pgTable(
  "component_functions",
  {
    componentName: text("component_name")
      .notNull()
      .references(() => components.name, { onDelete: "cascade" }),
    /** The name of a function this build ships. Not a foreign key: functions live in code. */
    functionName: text("function_name").notNull(),
    grantedBy: text("granted_by"),
    grantedAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.componentName, table.functionName] }),
  ],
);
