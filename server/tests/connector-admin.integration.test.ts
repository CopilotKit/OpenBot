import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createConnectorAdminService } from "../src/connectors";
import type { CredentialAdminService } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { TEST_POOL } from "./support/database";
import {
  connectorInstances,
  credentials as credentialRows,
} from "../src/db/schema";

/**
 * What the Connectors page reports about a connector that has been set up.
 *
 * The catalogue is built from `knowledge.yaml`, which says what a deployment may connect to rather
 * than what it has, so the listing has to read the instances as well.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const sources = [
  { type: "google-drive" as const, roots: ["Policies"] },
  { type: "microsoft-onedrive" as const, roots: ["Operations"] },
];

/**
 * No vault: what is under test is what the listing reports, not how a secret is kept. The row is
 * still written, because a connector instance references the credential it was set up with.
 */
const issued: string[] = [];
const credentials = {
  create: async () => {
    const [row] = await database
      .insert(credentialRows)
      .values({
        kind: "connector",
        provider: "google_drive",
        encryptedValue: "{}",
        keyId: "someone@example.com",
        metadata: {},
      })
      .returning({ id: credentialRows.id });
    issued.push(row.id);
    return {
      id: row.id,
      kind: "connector" as const,
      provider: "google_drive",
      keyId: "someone@example.com",
      metadata: {},
      revokedAt: null,
    };
  },
} as unknown as CredentialAdminService;

const service = createConnectorAdminService(sources, database, credentials);

async function removeGoogleDriveInstance() {
  await database
    .delete(connectorInstances)
    .where(eq(connectorInstances.type, "google_drive"));
}

let alreadyConfigured = false;

beforeAll(async () => {
  alreadyConfigured =
    (
      await database
        .select({ id: connectorInstances.id })
        .from(connectorInstances)
        .where(eq(connectorInstances.type, "google_drive"))
    ).length > 0;
});

afterAll(async () => {
  if (!alreadyConfigured) await removeGoogleDriveInstance();
  for (const id of issued) {
    await database.delete(credentialRows).where(eq(credentialRows.id, id));
  }
});

test("a connector reads as configured once it has been set up", async () => {
  if (alreadyConfigured) await removeGoogleDriveInstance();

  const before = await service.list();
  expect(before.map((connector) => connector.configured)).toEqual([
    false,
    false,
  ]);

  await service.configureGoogleDrive?.({
    serviceAccountJson: JSON.stringify({ type: "service_account" }),
    impersonationSubject: "someone@example.com",
    actorUserId: "admin",
  });

  const after = await service.list();
  // Only the one that was set up, so the listing reports the deployment rather than the catalogue.
  expect(
    after.map((connector) => [connector.type, connector.configured]),
  ).toEqual([
    ["google_drive", true],
    ["onedrive", false],
  ]);
});
