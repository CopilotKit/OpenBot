/**
 * Moving an existing deployment's delivery bindings and push devices into Intelligence, once, at
 * boot. The same rules as the conversation copy (conversations/upgrade.ts): idempotent, safe from any
 * number of replicas, every row accounted for before it records itself, loud on a refusal.
 *
 * The queues and pairing codes (`delivery_inbox`, `delivery_outbox`, `delivery_challenges`) are not
 * copied: they stay in this deployment's database, where they always were.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ImportResult } from "../conversations/types";
import type { Database } from "../db/client";
import {
  deliveryBindings,
  intelligenceCopies,
  pushDevices,
} from "../db/schema";
import {
  bindingToWire,
  type DeliveryDirectory,
  deviceToWire,
} from "./directory";

export const DELIVERY_COPY_NAME = "delivery";

export class DeliveryCopyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryCopyMismatchError";
  }
}

async function importAll<T extends { id: string }>(
  resource: string,
  items: T[],
  send: (batch: T[], key: string) => Promise<ImportResult[]>,
): Promise<number> {
  let present = 0;
  const refused: string[] = [];
  for (let at = 0; at < items.length; at += 100) {
    const batch = items.slice(at, at + 100);
    const key = `openbot-upgrade:${resource}:${createHash("sha256").update(JSON.stringify(batch)).digest("hex")}`;
    const results = new Map(
      (await send(batch, key)).map((result) => [result.id, result]),
    );
    for (const item of batch) {
      const result = results.get(item.id);
      if (result?.status === "created" || result?.status === "exists")
        present += 1;
      else
        refused.push(
          `${item.id}: ${result?.error?.code ?? "not answered for"} ${result?.error?.message ?? ""}`.trim(),
        );
    }
  }
  if (refused.length > 0)
    throw new DeliveryCopyMismatchError(
      `${items.length} ${resource} were to be copied into Intelligence and ${present} are there. Refused:\n${refused.slice(0, 50).join("\n")}`,
    );
  return present;
}

export async function copyLocalDeliveryToIntelligence(
  database: Database,
  directory: DeliveryDirectory,
): Promise<
  | { kind: "done-before" }
  | { kind: "copied"; bindings: number; devices: number }
> {
  const [done] = await database
    .select({ name: intelligenceCopies.name })
    .from(intelligenceCopies)
    .where(eq(intelligenceCopies.name, DELIVERY_COPY_NAME))
    .limit(1);
  if (done) return { kind: "done-before" };

  const bindingRows = await database.select().from(deliveryBindings);
  const deviceRows = await database.select().from(pushDevices);
  const bindings = await importAll(
    "delivery bindings",
    bindingRows.map((row) =>
      bindingToWire({
        id: row.id,
        ownerUserId: row.ownerUserId,
        channelId: row.channelId,
        agentId: row.agentId,
        threadId: row.threadId,
        transport: row.transport,
        realm: row.realm,
        identity: row.identity,
        address: row.address,
        mentionId: row.mentionId,
        enabled: row.enabled,
        optedOutAt: row.optedOutAt,
        createdAt: row.createdAt,
      }),
    ),
    (batch, key) => directory.client.importBindings(batch, key),
  );
  const devices = await importAll(
    "push devices",
    deviceRows.map((row) =>
      deviceToWire({
        id: row.id,
        ownerUserId: row.ownerUserId,
        token: row.token,
        projectId: row.projectId,
        platform: row.platform,
        enabled: row.enabled,
        createdAt: row.createdAt,
      }),
    ),
    (batch, key) => directory.client.importDevices(batch, key),
  );
  // What this instance holds is read again, so the copy is served from the first request.
  await directory.resync();
  const held = new Set([
    ...directory.bindings().map((binding) => `b:${binding.id}`),
    ...directory.devices().map((device) => `d:${device.id}`),
  ]);
  const missing = [
    ...bindingRows
      .filter((row) => !held.has(`b:${row.id}`))
      .map((row) => row.id),
    ...deviceRows
      .filter((row) => !held.has(`d:${row.id}`))
      .map((row) => row.id),
  ];
  if (missing.length > 0)
    throw new DeliveryCopyMismatchError(
      `${bindingRows.length + deviceRows.length} delivery records were to be copied into Intelligence and ${bindingRows.length + deviceRows.length - missing.length} are there. Missing: ${missing.slice(0, 50).join(", ")}`,
    );
  await database
    .insert(intelligenceCopies)
    .values({ name: DELIVERY_COPY_NAME, copied: bindings + devices })
    .onConflictDoNothing();
  console.info(
    JSON.stringify({
      type: "delivery-copied-to-intelligence",
      bindings: bindingRows.length,
      devices: deviceRows.length,
    }),
  );
  return {
    kind: "copied",
    bindings: bindingRows.length,
    devices: deviceRows.length,
  };
}
