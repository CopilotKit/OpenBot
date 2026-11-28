/**
 * The backup target guard's rule, on what the clouds and the server really say: the cloud CLIs'
 * own answers (the projections the chart's backup-target Job asks for) and the database a server
 * reports on /release. The agent end to end, with real RDS instances, is backup-target-kind.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  BackupTargetRefused,
  backupTargetFrom,
  compareTarget,
  confirmBackupTarget,
  DATABASE_IDENTITY_SINCE,
  predatesDatabaseIdentity,
  productDatabase,
  type Resolve,
} from "../src/backup-target";
import type { Kube } from "../src/kube";

/** A resolver with fixed answers, as the cluster's DNS would give them. */
const dns =
  (answers: Record<string, string[]>): Resolve =>
  async (host) =>
    answers[host] ?? (/^[0-9.]+$/.test(host) ? [host] : []);
const none: Resolve = async () => [];

const message = (kind: string, describe: unknown) =>
  JSON.stringify({ kind, describe });

// `aws rds describe-db-instances --query 'DBInstances[0].{id:DBInstanceIdentifier,endpoint:Endpoint.Address}'`
const rdsA = message("rds-snapshot", {
  id: "openbot-btg-a",
  endpoint: "openbot-btg-a.cjv3mw1yq0ex.us-east-2.rds.amazonaws.com",
});
const rdsB = message("rds-snapshot", {
  id: "openbot-btg-b",
  endpoint: "openbot-btg-b.cjv3mw1yq0ex.us-east-2.rds.amazonaws.com",
});
const onA = productDatabase({
  version: "1.2.0",
  database: {
    host: "openbot-btg-a.cjv3mw1yq0ex.us-east-2.rds.amazonaws.com",
    instanceConnectionName: null,
  },
});

describe("backup target guard", () => {
  test("RDS: the instance the product uses passes, another instance is refused as a mismatch", async () => {
    expect(
      await compareTarget(onA, backupTargetFrom("rds-snapshot", rdsA), none),
    ).toEqual({
      ok: true,
      how: "host openbot-btg-a.cjv3mw1yq0ex.us-east-2.rds.amazonaws.com",
    });
    const refused = await compareTarget(
      onA,
      backupTargetFrom("rds-snapshot", rdsB),
      dns({
        "openbot-btg-a.cjv3mw1yq0ex.us-east-2.rds.amazonaws.com": [
          "172.31.5.20",
        ],
        "openbot-btg-b.cjv3mw1yq0ex.us-east-2.rds.amazonaws.com": [
          "172.31.40.7",
        ],
      }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.mismatch).toBe(true);
    expect(refused.reason).toContain(
      "backup.rdsSnapshot.instance=openbot-btg-b",
    );
    expect(refused.reason).toContain(
      "the product's server uses openbot-btg-a.cjv3mw1yq0ex.us-east-2.rds.amazonaws.com",
    );
  });

  test("Azure: values left on the old server after a restore to a new one are refused", async () => {
    // What happened on 19 Nov: the product was restored to a new flexible server, and a
    // `helm upgrade --reuse-values` put the agent's backup back on the old one.
    // `az postgres flexible-server show --query '{name:name,fqdn:fullyQualifiedDomainName}'`
    const restored = productDatabase({
      database: {
        host: "openbot-mgmt-azure-pg-r11190529.postgres.database.azure.com",
      },
    });
    const old = backupTargetFrom(
      "azure-pg-backup",
      message("azure-pg-backup", {
        name: "openbot-mgmt-azure-pg",
        fqdn: "openbot-mgmt-azure-pg.postgres.database.azure.com",
      }),
    );
    const verdict = await compareTarget(
      restored,
      old,
      dns({
        "openbot-mgmt-azure-pg-r11190529.postgres.database.azure.com": [
          "10.20.1.5",
        ],
        "openbot-mgmt-azure-pg.postgres.database.azure.com": ["10.20.1.4"],
      }),
    );
    expect(verdict).toMatchObject({ ok: false, mismatch: true });
    const current = backupTargetFrom(
      "azure-pg-backup",
      message("azure-pg-backup", {
        name: "openbot-mgmt-azure-pg-r11190529",
        fqdn: "openbot-mgmt-azure-pg-r11190529.postgres.database.azure.com",
      }),
    );
    expect((await compareTarget(restored, current, none)).ok).toBe(true);
  });

  test("Aurora: the writer, reader, a custom endpoint or a member instance all name the cluster", async () => {
    // describe-db-clusters' Endpoint, ReaderEndpoint, CustomEndpoints; describe-db-instances' addresses.
    const cluster = backupTargetFrom(
      "aurora-snapshot",
      message("aurora-snapshot", {
        cluster: {
          id: "openbot-aurora",
          endpoint:
            "openbot-aurora.cluster-cjv3mw1yq0ex.us-east-2.rds.amazonaws.com",
          reader:
            "openbot-aurora.cluster-ro-cjv3mw1yq0ex.us-east-2.rds.amazonaws.com",
          custom: [
            "openbot-app.cluster-custom-cjv3mw1yq0ex.us-east-2.rds.amazonaws.com",
          ],
        },
        instances: [
          "openbot-aurora-1.cjv3mw1yq0ex.us-east-2.rds.amazonaws.com",
          null,
        ],
      }),
    );
    for (const host of [
      "OPENBOT-AURORA.cluster-cjv3mw1yq0ex.us-east-2.rds.amazonaws.com.",
      "openbot-app.cluster-custom-cjv3mw1yq0ex.us-east-2.rds.amazonaws.com",
      "openbot-aurora-1.cjv3mw1yq0ex.us-east-2.rds.amazonaws.com",
    ])
      expect(
        (
          await compareTarget(
            productDatabase({ database: { host } }),
            cluster,
            none,
          )
        ).ok,
      ).toBe(true);
  });

  test("Cloud SQL: by private address or by the socket's instance connection name; not by the outgoing address", async () => {
    // `gcloud sql instances describe --format='json(name,connectionName,ipAddresses,dnsName,dnsNames)'`
    const instance = backupTargetFrom(
      "cloudsql-backup",
      message("cloudsql-backup", {
        name: "openbot-mgmt-gcp-pg",
        connectionName: "openbot-files-live:us-central1:openbot-mgmt-gcp-pg",
        ipAddresses: [
          { ipAddress: "10.61.0.3", type: "PRIVATE" },
          { ipAddress: "34.123.10.9", type: "OUTGOING" },
        ],
        dnsName: "f3a1c2.1a2b3c4d5e6f.us-central1.sql.goog.",
      }),
    );
    expect(
      (
        await compareTarget(
          productDatabase({ database: { host: "10.61.0.3" } }),
          instance,
          none,
        )
      ).ok,
    ).toBe(true);
    expect(
      await compareTarget(
        productDatabase({ database: { host: "34.123.10.9" } }),
        instance,
        none,
      ),
    ).toMatchObject({ ok: false, mismatch: true });
    expect(
      (
        await compareTarget(
          productDatabase({
            database: {
              host: null,
              instanceConnectionName:
                "openbot-files-live:us-central1:openbot-mgmt-gcp-pg",
            },
          }),
          instance,
          none,
        )
      ).ok,
    ).toBe(true);
    expect(
      await compareTarget(
        productDatabase({
          database: {
            host: null,
            instanceConnectionName:
              "openbot-files-live:us-central1:openbot-mgmt-gcp-pg-restored",
          },
        }),
        instance,
        none,
      ),
    ).toMatchObject({ ok: false, mismatch: true });
  });

  test("AlloyDB: by an instance's address in the cluster", async () => {
    // `gcloud alloydb instances list --format='json(name,ipAddress,publicIpAddress,pscInstanceConfig)'`
    const cluster = backupTargetFrom(
      "alloydb-backup",
      message("alloydb-backup", [
        {
          name: "projects/openbot-files-live/locations/us-central1/clusters/openbot/instances/primary",
          ipAddress: "10.62.0.2",
        },
      ]),
    );
    expect(cluster.label).toBe("backup.alloydbBackup.cluster=openbot");
    expect(
      (
        await compareTarget(
          productDatabase({ database: { host: "10.62.0.2" } }),
          cluster,
          none,
        )
      ).ok,
    ).toBe(true);
  });

  test("a name of the product's own (a CNAME of the endpoint) passes by address, and a different address is a mismatch", async () => {
    const product = productDatabase({
      database: { host: "db.openbot.internal" },
    });
    const target = backupTargetFrom("rds-snapshot", rdsA);
    expect(
      await compareTarget(
        product,
        target,
        dns({
          "db.openbot.internal": ["172.31.5.20"],
          "openbot-btg-a.cjv3mw1yq0ex.us-east-2.rds.amazonaws.com": [
            "172.31.5.20",
          ],
        }),
      ),
    ).toEqual({ ok: true, how: "host db.openbot.internal at 172.31.5.20" });
    expect(
      await compareTarget(
        product,
        target,
        dns({
          "db.openbot.internal": ["172.31.40.7"],
          "openbot-btg-a.cjv3mw1yq0ex.us-east-2.rds.amazonaws.com": [
            "172.31.5.20",
          ],
        }),
      ),
    ).toMatchObject({ ok: false, mismatch: true });
  });

  test("anything unknown is refused, never passed", async () => {
    const target = backupTargetFrom("rds-snapshot", rdsA);
    // A server from before the field.
    expect(productDatabase({ version: "1.1.0" })).toBeNull();
    expect(await compareTarget(null, target, none)).toMatchObject({
      ok: false,
      mismatch: false,
    });
    // A host the agent cannot resolve, that is not the endpoint.
    expect(
      await compareTarget(
        productDatabase({ database: { host: "db.openbot.internal" } }),
        target,
        none,
      ),
    ).toMatchObject({ ok: false, mismatch: false });
    // An instance still being created has no endpoint yet.
    const creating = backupTargetFrom(
      "rds-snapshot",
      message("rds-snapshot", { id: "openbot-btg-a", endpoint: null }),
    );
    expect(await compareTarget(onA, creating, none)).toMatchObject({
      ok: false,
      mismatch: false,
    });
    // The Job's answer is for another kind, or not JSON at all.
    expect(() => backupTargetFrom("azure-pg-backup", rdsA)).toThrow(
      "backup.kind is azure-pg-backup",
    );
    expect(() =>
      backupTargetFrom(
        "rds-snapshot",
        "An error occurred (DBInstanceNotFound) when calling the DescribeDBInstances operation",
      ),
    ).toThrow("not the expected JSON");
  });

  test("a server that predates the check is let through with a warning; one at or after it that reports nothing is refused", async () => {
    // Neither case reaches the cloud: nothing here may touch the cluster.
    const kube = new Proxy({} as Kube, {
      get: () => {
        throw new Error("the cluster was asked");
      },
    });
    const confirm = (version: string | undefined) =>
      confirmBackupTarget({
        kube,
        kind: "rds-snapshot",
        template: "kind: Job",
        operation: "261119233220-f498d1",
        timeoutSeconds: 600,
        // What /release says on a server from before the field: no `database` at all.
        identity: {
          version,
          commit: "e373655cc7d506d11bc99e4165935bf6f8f98fd7",
          distributionId: "CopilotKit/OpenBot",
          repository: "CopilotKit/OpenBot",
          channel: "stable",
          lastAppliedMigration: "0137_ai_connections",
        },
      });

    expect(DATABASE_IDENTITY_SINCE).toBe("v1.1.3");
    for (const version of [
      "v1.1.0",
      "v1.1.1",
      "v1.1.2",
      "v1.1.3-rc.1",
      "1.0.4",
    ]) {
      expect(predatesDatabaseIdentity(version)).toBe(true);
      const skipped = await confirm(version);
      expect(skipped.verified).toBe(false);
      expect(skipped.message).toStartWith(
        "backup target not verified: server predates the check",
      );
      expect(skipped.message).toContain(version);
    }
    for (const version of [
      "v1.1.3",
      "v1.2.0-rc.1",
      "v2.0.0",
      undefined,
      "main",
    ]) {
      expect(predatesDatabaseIdentity(version)).toBe(false);
      const refused = await confirm(version).catch((error) => error);
      expect(refused).toBeInstanceOf(BackupTargetRefused);
      expect(refused.mismatch).toBe(false);
      expect(refused.message).toContain("does not report its database");
    }
  });

  test("with no backup chosen, a migrating upgrade is refused before the cluster is asked anything", async () => {
    const kube = new Proxy({} as Kube, {
      get: () => {
        throw new Error("the cluster was asked");
      },
    });
    const refused = await confirmBackupTarget({
      kube,
      kind: "none",
      template: "kind: Job",
      operation: "261120060000-a1b2c3",
      timeoutSeconds: 600,
      identity: null,
    }).catch((error) => error);
    expect(refused).toBeInstanceOf(BackupTargetRefused);
    expect(refused.mismatch).toBe(false);
    expect(refused.message).toContain("no backup is configured");
  });
});
