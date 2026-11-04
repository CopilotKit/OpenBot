/**
 * Moving an existing deployment's Bots into Intelligence, once, at boot.
 *
 * A deployment that ran before this release holds its Bots in `agents` and `agent_profiles`. This
 * copies every one of them into Intelligence's agent registry, deleted ones included (their
 * conversations stay readable), with the id, type, configuration, profile, owner, callback-token hash
 * and timestamps they had. Then it checks that Intelligence holds every id it copied, and only then
 * records the copy as done, so it never runs again: a Bot later deleted for good in Intelligence must
 * not come back from the local row this release keeps.
 *
 * SAFE TO RUN ANY NUMBER OF TIMES, FROM ANY NUMBER OF REPLICAS AT ONCE. Each Bot is created under an
 * idempotency key made from its id, with a body made only from the local rows, so two
 * replicas copying the same Bot send the same request and Intelligence answers the second with the
 * first's result. A Bot Intelligence already has is left alone.
 *
 * LOUD ON A MISMATCH. A Bot Intelligence refuses, or one missing after the copy, stops the boot with
 * the ids named. Running on with some Bots copied and some not would show people a roster with Bots
 * missing and nothing saying why.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import { agentProfiles, agents, intelligenceCopies } from "../../db/schema";
import { BotAlreadyExistsError } from "./client";
import type { BotDirectory } from "./directory";
import type { BotDraft } from "./types";

export const BOT_COPY_NAME = "bots";

/**
 * The same key for the same copy from every replica, so their copies are one write: made from the
 * Bot as the local rows describe it, which every replica reads alike. The rows, not only the id, so a
 * different body under the same id (a database restored over another) is told apart as a different
 * request rather than refused as a reused key. Hashed, because Intelligence refuses an
 * Idempotency-Key over 128 characters and a Bot id may be up to 200.
 */
function upgradeKey(draft: BotDraft): string {
  return `openbot-upgrade:bots:${createHash("sha256").update(JSON.stringify(draft)).digest("hex")}`;
}

export type BotCopyOutcome =
  | { kind: "done-before" }
  | { kind: "copied"; local: number; created: number; present: number };

export class BotCopyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotCopyMismatchError";
  }
}

export async function copyLocalBotsToIntelligence(
  database: Database,
  directory: Pick<BotDirectory, "create" | "registry">,
): Promise<BotCopyOutcome> {
  const [done] = await database
    .select({ name: intelligenceCopies.name })
    .from(intelligenceCopies)
    .where(eq(intelligenceCopies.name, BOT_COPY_NAME))
    .limit(1);
  if (done) return { kind: "done-before" };

  const rows = await database
    .select({
      id: agents.id,
      name: agents.name,
      type: agents.type,
      configuration: agents.configuration,
      packageId: agents.packageId,
      createdAt: agents.createdAt,
      ownerUserId: agentProfiles.ownerUserId,
      title: agentProfiles.title,
      roleDescription: agentProfiles.roleDescription,
      avatarSeed: agentProfiles.avatarSeed,
      visibility: agentProfiles.visibility,
      isolated: agentProfiles.isolated,
      callbackTokenHash: agentProfiles.callbackTokenHash,
      callbackTokenIssuedAt: agentProfiles.callbackTokenIssuedAt,
      deletedAt: agentProfiles.deletedAt,
    })
    .from(agents)
    .leftJoin(agentProfiles, eq(agentProfiles.agentId, agents.id));

  /*
   * An `agents` row with no profile was never a Bot anybody saw: every roster, the runtime and the
   * tombstones all joined the profile. There is nothing to carry over, and it is said rather than
   * dropped quietly.
   */
  const profileless = rows.filter((row) => row.title === null);
  if (profileless.length > 0) {
    console.warn(
      JSON.stringify({
        type: "bot-copy-skipped-profileless",
        note: "These agents rows have no profile, were shown nowhere, and are not copied.",
        bots: profileless.map((row) => row.id),
      }),
    );
  }
  const local = rows.filter((row) => row.title !== null);

  const { bots: before } = await directory.registry.all({
    includeDeleted: true,
  });
  const already = new Set(before.map((bot) => bot.id));

  let created = 0;
  const refused: string[] = [];
  for (const row of local) {
    if (already.has(row.id)) continue;
    const draft: BotDraft = {
      id: row.id,
      type: row.type,
      name: row.name,
      title: row.title ?? "",
      roleDescription: row.roleDescription ?? "",
      avatarSeed: row.avatarSeed ?? row.id,
      visibility: row.visibility ?? "private",
      ownerUserId: row.ownerUserId,
      packageId: row.packageId,
      isolated: row.isolated ?? false,
      configuration: (row.configuration ?? {}) as Record<string, unknown>,
      callbackTokenHash: row.callbackTokenHash,
      callbackTokenIssuedAt: row.callbackTokenIssuedAt,
      createdAt: row.createdAt,
      deletedAt: row.deletedAt,
    };
    try {
      await directory.create(draft, upgradeKey(draft));
      created += 1;
    } catch (error) {
      // Another replica copied it between the listing and here.
      if (error instanceof BotAlreadyExistsError) continue;
      refused.push(
        `${row.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (refused.length > 0) {
    throw new BotCopyMismatchError(
      `Intelligence refused ${refused.length} of this deployment's ${local.length} Bots, so they were not moved and this server will not start without them:\n${refused.join("\n")}`,
    );
  }

  const { bots: after } = await directory.registry.all({
    includeDeleted: true,
  });
  const present = new Set(after.map((bot) => bot.id));
  const missing = local.filter((row) => !present.has(row.id));
  if (missing.length > 0) {
    throw new BotCopyMismatchError(
      `${local.length} Bots were to be copied into Intelligence and ${local.length - missing.length} are there. Missing: ${missing.map((row) => row.id).join(", ")}`,
    );
  }

  await database
    .insert(intelligenceCopies)
    .values({ name: BOT_COPY_NAME, copied: local.length })
    .onConflictDoNothing();
  console.info(
    JSON.stringify({
      type: "bots-copied-to-intelligence",
      local: local.length,
      created,
      inIntelligence: after.length,
    }),
  );
  return {
    kind: "copied",
    local: local.length,
    created,
    present: after.length,
  };
}
