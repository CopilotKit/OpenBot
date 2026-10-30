import { afterAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { mcpServers, mcpTools } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The migration that gives an existing deployment's dead apps an answer, run against a real
 * database.
 *
 * WHAT IT REPAIRS. `addBrokeredApp` settles `account_mode` on the INSERT and — from the change this
 * migration ships beside — after the upsert as well. Its CONFLICT arm never did, so an enable that
 * landed on a row which was not brokered converted it and left this column null. `accountFor`
 * refuses a call against such a row as ambiguous, so the app is enabled, listed, connectable, and
 * declines every call it is asked for.
 *
 * WHY A MIGRATION AND NOT THE WRITER ALONE. An app that is already enabled cannot be added again
 * without being removed first — the Plugins page's Add is a switch, and switching it off takes the
 * app and every connection on it — so the repair in `addBrokeredApp` can never reach a row that is
 * already in this state. Without this file every deployment that is already broken stays broken.
 *
 * Found through `_journal.json` rather than by filename, for `last-sign-in-backfill`'s reason: the
 * number in front of a migration is not stable across a rebase, and a migration left out of the
 * journal never runs at all. So the journal entry is what is asserted and the SQL is read from
 * whatever file it names.
 */
const JOURNAL = (await Bun.file(
  new URL("../drizzle/meta/_journal.json", import.meta.url),
).json()) as { entries: { idx: number; tag: string }[] };

const entry = JOURNAL.entries.find((candidate) =>
  candidate.tag.endsWith("_arcade_provider_backfill"),
);

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const PREFIX = "acctmode-backfill-";

/** Thrown to unwind the transaction, so the backfill never touches the rows of the database it ran against. */
class Rollback extends Error {}

describe("the account-mode backfill migration", () => {
  test("is registered in the journal, so it runs", () => {
    expect(entry).toBeDefined();
  });

  test("settles every brokered app with an account and nothing else", async () => {
    const migration = await Bun.file(
      new URL(`../drizzle/${entry?.tag}.sql`, import.meta.url),
    ).text();

    /**
     * One row per case the predicate decides, named for what it is.
     *
     * `unreadable` is the one worth saying out loud: a null `auth_scheme` is NOT a no-auth app —
     * `schemeKind` calls it `unreadable` and `accountFor` treats it as having an account — so it
     * is refused exactly as `consent` is and needs the mode just as much. `custom` and
     * `first-party` are the two provenances that have no account to hold at all.
     */
    const rows = [
      { id: `${PREFIX}consent`, provenance: "composio", scheme: "OAUTH2" },
      { id: `${PREFIX}key`, provenance: "composio", scheme: "API_KEY" },
      { id: `${PREFIX}arcade`, provenance: "arcade", scheme: "OAUTH2" },
      { id: `${PREFIX}unreadable`, provenance: "composio", scheme: null },
      { id: `${PREFIX}noauth`, provenance: "composio", scheme: "NO_AUTH" },
      { id: `${PREFIX}custom`, provenance: "custom", scheme: null },
      { id: `${PREFIX}firstparty`, provenance: "first-party", scheme: null },
    ] as const;
    const chosen = `${PREFIX}chosen`;
    const ids = [...rows.map((candidate) => candidate.id), chosen];
    const observed = new Map<string, string | null>();

    try {
      await database.transaction(async (tx) => {
        for (const candidate of rows) {
          await tx.insert(mcpServers).values({
            id: candidate.id,
            title: candidate.id,
            vendor: "Composio",
            url: `composio://${candidate.id}`,
            provenance: candidate.provenance,
            authScheme: candidate.scheme,
          });
        }
        // An administrator who already chose Shared, which nothing here may overrule.
        await tx.insert(mcpServers).values({
          id: chosen,
          title: chosen,
          vendor: "Composio",
          url: `composio://${chosen}`,
          provenance: "composio",
          authScheme: "OAUTH2",
          accountMode: "shared",
        });

        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) await tx.execute(sql.raw(statement));
        }

        const after = await tx
          .select({ id: mcpServers.id, accountMode: mcpServers.accountMode })
          .from(mcpServers)
          .where(inArray(mcpServers.id, ids));
        for (const row of after) observed.set(row.id, row.accountMode);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    expect(Object.fromEntries(observed)).toEqual({
      [`${PREFIX}consent`]: "personal",
      [`${PREFIX}key`]: "personal",
      [`${PREFIX}arcade`]: "personal",
      [`${PREFIX}unreadable`]: "personal",
      [`${PREFIX}noauth`]: null,
      [`${PREFIX}custom`]: null,
      [`${PREFIX}firstparty`]: null,
      [chosen]: "shared",
    });
  });

  test("gives every recorded action without a vendor spelling its own name, and leaves one that has it", async () => {
    const migration = await Bun.file(
      new URL(`../drizzle/${entry?.tag}.sql`, import.meta.url),
    ).text();

    /*
     * `bare` is a row as the previous build's replicas write it during a rolling deploy: no
     * `vendor_name` at all. `spelled` is an Arcade row this build wrote, whose vendor spelling is
     * NOT its name and must survive the backfill untouched.
     */
    const server = `${PREFIX}tools`;
    const observed = new Map<string, string | null>();

    try {
      await database.transaction(async (tx) => {
        await tx.insert(mcpServers).values({
          id: server,
          title: server,
          vendor: "Arcade",
          url: `arcade://${server}`,
          provenance: "arcade",
          authScheme: "OAUTH2",
        });
        await tx.insert(mcpTools).values([
          { serverId: server, name: "GMAIL_FETCH_EMAILS" },
          {
            serverId: server,
            name: "ListEmails",
            vendorName: "Gmail.ListEmails",
          },
        ]);

        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) await tx.execute(sql.raw(statement));
        }

        const after = await tx
          .select({ name: mcpTools.name, vendorName: mcpTools.vendorName })
          .from(mcpTools)
          .where(eq(mcpTools.serverId, server));
        for (const row of after) observed.set(row.name, row.vendorName);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    expect(Object.fromEntries(observed)).toEqual({
      GMAIL_FETCH_EMAILS: "GMAIL_FETCH_EMAILS",
      ListEmails: "Gmail.ListEmails",
    });
  });
});

afterAll(async () => {
  await database.$client.close();
});
