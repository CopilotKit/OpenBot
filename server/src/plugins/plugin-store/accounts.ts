import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { recordAuditEvent } from "../../audit";
import { brokeredAccounts, mcpServers } from "../../db/schema";
import { toolkitOfFor } from "../access";
import { BrokerUnconfiguredError } from "../broker";
import { type AccountRef, filedUnderPerson } from "../shared-accounts";
import type { StoreContext } from "./context";
import { PluginRefusedError } from "./model";

/** A person's account, as their app page and a Bot's call read it. */
export type BrokeredAccountRecord = {
  /** Opaque to the browser: which row a Disconnect or Make default press is about. */
  id: string;
  /** What the vendor says the account is: an email address or a login. Null where it said none. */
  identity: string | null;
  /** What a person and a model call the account: the identity, or "account 2" where there is none. */
  label: string;
  isDefault: boolean;
  connectedAt: string | null;
};

/** The account a call runs in, read off the row it picked. */
export type PinnedAccount = {
  vendorUserId: string;
  /** The vendor's id for the account, or null where the user id alone names it. */
  accountId: string | null;
  label: string;
  /** How many accounts the person holds at the app, which says whether there was a choice. */
  among: number;
};

type PersonAccount = Extract<AccountRef, { holder: "person" }>;

type Row = typeof brokeredAccounts.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const iso = (value: Date | null): string | null =>
  value ? value.toISOString() : null;

/** Oldest first, by when the vendor says it was made and then by when this deployment saw it. */
const ordered = (rows: Row[]): Row[] =>
  [...rows].sort((left, right) => {
    const a = left.connectedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const b = right.connectedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (a !== b) return a < b ? -1 : 1;
    // A vendor that dates nothing (Arcade): the person's own id before the further ids made from it.
    if (left.vendorUserId.length !== right.vendorUserId.length)
      return left.vendorUserId.length - right.vendorUserId.length;
    return left.createdAt.getTime() - right.createdAt.getTime();
  });

function recordsOf(rows: Row[]): BrokeredAccountRecord[] {
  return ordered(rows).map((row, index) => ({
    id: row.id,
    identity: row.identity,
    label: row.identity ?? `account ${index + 1}`,
    isDefault: row.isDefault,
    connectedAt: iso(row.connectedAt),
  }));
}

/** A unique-index race between two syncs, which the second one can ignore. */
const isUniqueViolation = (error: unknown): boolean => {
  const code =
    (error as { code?: unknown })?.code ??
    (error as { cause?: { code?: unknown } })?.cause?.code;
  return code === "23505";
};

/**
 * The accounts each person holds at each brokered app, kept in step with the vendor's own listing.
 *
 * Shared by the store's account methods and by the call path, so the account a call is pointed at
 * and the accounts a page lists are read the same way.
 */
export function accountBook(context: StoreContext) {
  const { database, broker, brokerProvider } = context;

  const rowsFor = (toolkit: string, userId: string) =>
    database
      .select()
      .from(brokeredAccounts)
      .where(
        and(
          eq(brokeredAccounts.provider, brokerProvider),
          eq(brokeredAccounts.app, toolkit),
          eq(brokeredAccounts.userId, userId),
        ),
      );

  /** Make the oldest remaining account the default where none is. */
  const settleDefault = async (toolkit: string, userId: string) => {
    const rows = ordered(await rowsFor(toolkit, userId));
    if (rows.length === 0 || rows.some((row) => row.isDefault)) return;
    try {
      await database
        .update(brokeredAccounts)
        .set({ isDefault: true })
        .where(eq(brokeredAccounts.id, rows[0]?.id ?? ""));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  };

  /**
   * Rebuild a person's accounts at one app from what the vendor lists now, and answer them.
   *
   * Asked about the person's own broker id and about every further id of theirs a row already
   * names (Arcade files each further account under one; see `anotherArcadeAccount`). An account the
   * vendor no longer lists is dropped here, and one it lists that was not here is added, so a row is
   * never the only evidence of an account. The default survives where its account does.
   *
   * A broker that cannot list accounts one by one, and a Shared app's team account, answer from
   * the table as it stands, which for them is empty.
   */
  async function sync(input: {
    toolkit: string;
    account: AccountRef;
  }): Promise<BrokeredAccountRecord[]> {
    const { toolkit, account } = input;
    if (account.holder !== "person") return [];
    if (!broker?.accountsOf)
      return recordsOf(await rowsFor(toolkit, account.userId));

    const held = await rowsFor(toolkit, account.userId);
    const filedUnder = [
      ...new Set([
        account.vendorUserId,
        ...held
          .map((row) => row.vendorUserId)
          .filter((id) => filedUnderPerson(id, account.vendorUserId)),
      ]),
    ];
    const listed: {
      vendorUserId: string;
      accountId: string;
      identity: string | null;
      connectedAt: Date | null;
    }[] = [];
    for (const vendorUserId of filedUnder) {
      for (const found of await broker.accountsOf({
        account: { ...account, vendorUserId },
        toolkit,
      })) {
        listed.push({
          vendorUserId,
          accountId: found.accountId ?? "",
          identity: found.identity,
          connectedAt: found.connectedAt ? new Date(found.connectedAt) : null,
        });
      }
    }

    const key = (row: { vendorUserId: string; accountId: string }) =>
      `${row.vendorUserId}\u0000${row.accountId}`;
    const keep = new Set(listed.map(key));
    const gone = held.filter((row) => !keep.has(key(row)));
    if (gone.length > 0) {
      await database.delete(brokeredAccounts).where(
        inArray(
          brokeredAccounts.id,
          gone.map((row) => row.id),
        ),
      );
    }
    for (const found of listed) {
      await database
        .insert(brokeredAccounts)
        .values({
          provider: brokerProvider,
          app: toolkit,
          userId: account.userId,
          vendorUserId: found.vendorUserId,
          accountId: found.accountId,
          identity: found.identity,
          connectedAt: found.connectedAt,
        })
        .onConflictDoUpdate({
          target: [
            brokeredAccounts.provider,
            brokeredAccounts.app,
            brokeredAccounts.userId,
            brokeredAccounts.vendorUserId,
            brokeredAccounts.accountId,
          ],
          set: {
            identity: found.identity,
            connectedAt: found.connectedAt,
          },
        });
    }
    await settleDefault(toolkit, account.userId);
    return recordsOf(await rowsFor(toolkit, account.userId));
  }

  /**
   * The account a call runs in, picked from the accounts of the person whose account the call
   * opens, or null where they hold none recorded here (a connection made before accounts were
   * listed, which runs as it always did).
   *
   * `named` IS WHAT THE MODEL PASSED AND IS ONLY EVER MATCHED, never used. It is compared with the
   * labels of this person's own accounts and nothing else, so a name that is somebody else's
   * account, an id, or anything the person does not hold is refused with the list they do hold.
   */
  async function pick(input: {
    toolkit: string;
    title: string;
    account: PersonAccount;
    named: unknown;
  }): Promise<PinnedAccount | null> {
    const { toolkit, title, account, named } = input;
    let rows = ordered(await rowsFor(toolkit, account.userId)).filter((row) =>
      filedUnderPerson(row.vendorUserId, account.vendorUserId),
    );
    const pinned = (row: Row, label: string): PinnedAccount => ({
      vendorUserId: row.vendorUserId,
      accountId: row.accountId === "" ? null : row.accountId,
      label,
      among: rows.length,
    });

    if (named === undefined || named === null || named === "") {
      const records = recordsOf(rows);
      const chosen = records.find((record) => record.isDefault) ?? records[0];
      const row =
        chosen && rows.find((candidate) => candidate.id === chosen.id);
      return row && chosen ? pinned(row, chosen.label) : null;
    }

    const wanted =
      typeof named === "string" ? named.trim().toLowerCase() : null;
    const find = () => {
      const records = recordsOf(rows);
      const match = records.find(
        (record) =>
          record.label.toLowerCase() === wanted ||
          (record.identity !== null &&
            record.identity.toLowerCase() === wanted),
      );
      const row = match && rows.find((candidate) => candidate.id === match.id);
      return { records, match, row };
    };
    let found = find();
    /*
     * NOTHING RECORDED YET, SO THE VENDOR IS ASKED ONCE. A connection made before this deployment
     * listed accounts has no rows until the app's page is opened; a call naming an account is the
     * one moment that matters, so the listing is made here rather than refusing a real account.
     */
    if (!found.row && rows.length === 0 && wanted !== null) {
      await sync({ toolkit, account }).catch(() => []);
      rows = ordered(await rowsFor(toolkit, account.userId)).filter((row) =>
        filedUnderPerson(row.vendorUserId, account.vendorUserId),
      );
      found = find();
    }
    if (found.row && found.match) return pinned(found.row, found.match.label);

    const yours = found.records.map((record) => record.label);
    throw new PluginRefusedError(
      yours.length > 0
        ? `That isn't one of your ${title} accounts, so nothing was done. Use one of: ${yours.join(", ")}.`
        : `You have no ${title} accounts to choose from, so nothing was done. Leave the account out to use the one you connected.`,
      null,
    );
  }

  return { rowsFor, sync, pick, settleDefault };
}

/** What a person does to their own accounts at one app. */
export function accountMethods(context: StoreContext) {
  const { database, broker, brokerProvider, auditStore } = context;
  const book = accountBook(context);

  return {
    /** See {@link accountBook}'s `sync`. */
    async syncBrokeredAccounts(input: {
      toolkit: string;
      account: AccountRef;
    }): Promise<BrokeredAccountRecord[]> {
      return book.sync(input);
    },

    /**
     * Each app's accounts for one person, as a Bot is told about them, read from the table alone.
     * An app with no rows is absent.
     */
    async accountChoicesFor(
      userId: string,
      toolkits: string[],
    ): Promise<Map<string, BrokeredAccountRecord[]>> {
      const choices = new Map<string, BrokeredAccountRecord[]>();
      if (!userId || toolkits.length === 0) return choices;
      const rows = await database
        .select()
        .from(brokeredAccounts)
        .where(
          and(
            eq(brokeredAccounts.provider, brokerProvider),
            eq(brokeredAccounts.userId, userId),
            inArray(brokeredAccounts.app, [...new Set(toolkits)]),
          ),
        )
        .orderBy(asc(brokeredAccounts.createdAt));
      const byApp = new Map<string, Row[]>();
      for (const row of rows) {
        byApp.set(row.app, [...(byApp.get(row.app) ?? []), row]);
      }
      for (const [app, held] of byApp) choices.set(app, recordsOf(held));
      return choices;
    },

    /**
     * The same, keyed by the servers a Bot's tools are on: for each brokered Personal app this
     * person holds accounts at, its title and their accounts. What `grantedTools` tells a model.
     */
    async accountChoicesForServers(
      userId: string,
      serverIds: string[],
    ): Promise<
      Map<string, { title: string; choices: BrokeredAccountRecord[] }>
    > {
      const answer = new Map<
        string,
        { title: string; choices: BrokeredAccountRecord[] }
      >();
      if (!userId || serverIds.length === 0) return answer;
      const servers = await database
        .select({
          id: mcpServers.id,
          title: mcpServers.title,
          url: mcpServers.url,
          accountMode: mcpServers.accountMode,
        })
        .from(mcpServers)
        .where(
          and(
            inArray(mcpServers.id, [...new Set(serverIds)]),
            eq(mcpServers.provenance, brokerProvider),
          ),
        );
      const apps = new Map<string, { id: string; title: string }[]>();
      for (const server of servers) {
        if (server.accountMode === "shared") continue;
        const app = toolkitOfFor(brokerProvider, server.url);
        if (!app) continue;
        apps.set(app, [
          ...(apps.get(app) ?? []),
          { id: server.id, title: server.title },
        ]);
      }
      if (apps.size === 0) return answer;
      const rows = await database
        .select()
        .from(brokeredAccounts)
        .where(
          and(
            eq(brokeredAccounts.provider, brokerProvider),
            eq(brokeredAccounts.userId, userId),
            inArray(brokeredAccounts.app, [...apps.keys()]),
          ),
        );
      const byApp = new Map<string, Row[]>();
      for (const row of rows) {
        byApp.set(row.app, [...(byApp.get(row.app) ?? []), row]);
      }
      for (const [app, held] of byApp) {
        const choices = recordsOf(held);
        for (const server of apps.get(app) ?? [])
          answer.set(server.id, { title: server.title, choices });
      }
      return answer;
    },

    /** Make one of a person's accounts the one a call uses when it names none. False where it is not theirs. */
    async setDefaultBrokeredAccount(input: {
      toolkit: string;
      userId: string;
      id: string;
    }): Promise<boolean> {
      // Not an id this table could hold, so not one of theirs; asked as text it would be a 500.
      if (!UUID.test(input.id)) return false;
      return await database.transaction(async (transaction) => {
        const mine = and(
          eq(brokeredAccounts.provider, brokerProvider),
          eq(brokeredAccounts.app, input.toolkit),
          eq(brokeredAccounts.userId, input.userId),
        );
        const [row] = await transaction
          .select({ id: brokeredAccounts.id })
          .from(brokeredAccounts)
          .where(and(mine, eq(brokeredAccounts.id, input.id)));
        if (!row) return false;
        await transaction
          .update(brokeredAccounts)
          .set({ isDefault: false })
          .where(and(mine, sql`${brokeredAccounts.isDefault}`));
        await transaction
          .update(brokeredAccounts)
          .set({ isDefault: true })
          .where(eq(brokeredAccounts.id, row.id));
        return true;
      });
    },

    /**
     * End one of a person's accounts at an app and keep the rest.
     *
     * `only` where it is the last account they hold there: the caller ends the whole connection
     * instead, through the same disconnect the app's single account always had, so the trail, the
     * siblings and the connection row are handled as they always were. `null` where the id is not
     * one of this person's accounts at this app.
     */
    async disconnectBrokeredAccount(input: {
      toolkit: string;
      account: PersonAccount;
      id: string;
      by: string;
    }): Promise<{ only: true } | { remaining: number } | null> {
      if (!broker) throw new BrokerUnconfiguredError(brokerProvider, "person");
      const rows = (
        await book.rowsFor(input.toolkit, input.account.userId)
      ).filter((row) =>
        filedUnderPerson(row.vendorUserId, input.account.vendorUserId),
      );
      const row = rows.find((candidate) => candidate.id === input.id);
      if (!row) return null;
      if (rows.length === 1) return { only: true };

      /*
       * ONE ACCOUNT, NEVER THE SWEEP. `revoke` ends every account a person holds for the app; this
       * ends the one they pressed Disconnect beside. Composio names it by its id; Arcade by the user
       * id it is filed under, which holds that one account and nothing else.
       */
      if (row.accountId !== "") await broker.revokeAccount(row.accountId);
      else
        await broker.revoke({
          account: { ...input.account, vendorUserId: row.vendorUserId },
          toolkit: input.toolkit,
        });

      await database
        .delete(brokeredAccounts)
        .where(eq(brokeredAccounts.id, row.id));
      await book.settleDefault(input.toolkit, input.account.userId);

      const remaining = rows.length - 1;
      await recordAuditEvent(auditStore, {
        eventType: "mcp.account_disconnected",
        targetType: "mcp_server",
        targetId: input.toolkit,
        payload: {
          actor: input.by,
          server: input.toolkit,
          owner: input.account.userId,
          reason: "self",
          vendorRevocationRequested: true,
          scope: "one_account",
          remaining,
        },
      });
      return { remaining };
    },

    /** Forget every account row a person holds at an app, when the whole connection ends. */
    async forgetBrokeredAccounts(input: {
      toolkit: string;
      userId: string;
    }): Promise<void> {
      await database
        .delete(brokeredAccounts)
        .where(
          and(
            eq(brokeredAccounts.provider, brokerProvider),
            eq(brokeredAccounts.app, input.toolkit),
            eq(brokeredAccounts.userId, input.userId),
          ),
        );
    },
  };
}
