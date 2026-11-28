/**
 * The backup target guard. Before the backup that comes ahead of a migrating upgrade, the agent
 * confirms that the database the chart's values back up is the database the product's server
 * actually uses, and refuses the upgrade when it is not, or when it cannot tell.
 *
 * Why: a restore always creates a NEW database server on every cloud, and the agent's values
 * (`backup.<kind>`) are a separate copy of where the database is. They can drift back to the old
 * server (a `helm upgrade --reuse-values` from an earlier revision does exactly that), and a backup
 * of the wrong database before a migration is no backup at all.
 *
 * The two sides, without the agent reading any secret:
 *
 *   - the product's database: the server's `/release` names its host (and, for a Cloud SQL socket,
 *     the instance connection name), never credentials or the URL;
 *   - the backup's database: the chart's backup-target Job asks the cloud, under the backup's own
 *     identity, where the configured instance, cluster or server answers (its endpoint names and
 *     addresses), and writes that to its termination message.
 *
 * `backup.kind=command` is exempt: the agent cannot know what a command backs up.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type { ReleaseIdentity } from "../../shared/kubernetes-promotion";
import type { AgentConfig } from "./config";
import { fillJob, runJob } from "./jobs";
import type { Kube } from "./kube";

export type BackupKind = AgentConfig["backup"]["kind"];

/** What the product's server says it is connected to. */
export interface ProductDatabase {
  host: string | null;
  instanceConnectionName: string | null;
}

/** Where the configured backup target answers, as its cloud describes it. */
export interface BackupTarget {
  /** How a person names it in the values: `backup.rdsSnapshot.instance=openbot-db`, say. */
  label: string;
  /** Host names it answers on (endpoints, FQDNs, DNS names). */
  names: string[];
  /** IP addresses it answers on. */
  addresses: string[];
  /** Cloud SQL or AlloyDB instance connection names. */
  connectionNames: string[];
}

export type Verdict =
  | { ok: true; how: string }
  | { ok: false; mismatch: boolean; reason: string };

export class BackupTargetRefused extends Error {
  constructor(
    readonly reason: string,
    readonly mismatch: boolean,
  ) {
    super(`backup target refused: ${reason}`);
  }
}

const VALUES_KEY: Record<Exclude<BackupKind, "command" | "none">, string> = {
  "rds-snapshot": "backup.rdsSnapshot.instance",
  "aurora-snapshot": "backup.auroraSnapshot.cluster",
  "azure-pg-backup": "backup.azurePgBackup.server",
  "cloudsql-backup": "backup.cloudsqlBackup.instance",
  "alloydb-backup": "backup.alloydbBackup.cluster",
};

export function normalizeHost(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
}

const text = z.string().min(1);
const optionalText = z.string().nullish();
const RdsInstance = z.object({ id: text, endpoint: optionalText });
const AuroraCluster = z.object({
  id: text,
  endpoint: optionalText,
  reader: optionalText,
  custom: z.array(z.string()).nullish(),
});
const AzureServer = z.object({ name: optionalText, fqdn: optionalText });
const CloudSqlInstance = z.object({
  name: optionalText,
  connectionName: optionalText,
  dnsName: optionalText,
  dnsNames: z.array(z.object({ name: optionalText })).nullish(),
  ipAddresses: z
    .array(z.object({ ipAddress: optionalText, type: optionalText }))
    .nullish(),
});
const AlloyDbInstance = z.object({
  name: optionalText,
  ipAddress: optionalText,
  publicIpAddress: optionalText,
  pscInstanceConfig: z.object({ pscDnsName: optionalText }).nullish(),
});
const Message = z.object({ kind: text, describe: z.unknown() });

function present(values: (string | null | undefined)[]) {
  return [
    ...new Set(
      values
        .filter((value): value is string => !!value?.trim())
        .map(normalizeHost),
    ),
  ];
}
function split(values: string[]) {
  return {
    names: values.filter((value) => !isIP(value)),
    addresses: values.filter((value) => isIP(value)),
  };
}

/**
 * The backup-target Job's termination message, read for the configured kind: `{"kind": ...,
 * "describe": ...}` where `describe` is the cloud CLI's own answer (see the chart's
 * backup-target-job.yaml for the exact command per kind).
 */
export function backupTargetFrom(kind: BackupKind, message: string) {
  if (kind === "command" || kind === "none")
    throw new Error(`backup.kind=${kind} has no target to read`);
  let parsed: z.infer<typeof Message>;
  try {
    parsed = Message.parse(JSON.parse(message));
  } catch {
    throw new Error(
      `the backup-target Job's answer is not the expected JSON: ${message.slice(0, 300) || "(empty)"}`,
    );
  }
  if (parsed.kind !== kind)
    throw new Error(
      `the backup-target Job describes a ${parsed.kind} target, but backup.kind is ${kind}`,
    );
  const key = VALUES_KEY[kind];
  const describe = parsed.describe;
  switch (kind) {
    case "rds-snapshot": {
      const instance = RdsInstance.parse(describe);
      return {
        label: `${key}=${instance.id}`,
        ...split(present([instance.endpoint])),
        connectionNames: [],
      } satisfies BackupTarget;
    }
    case "aurora-snapshot": {
      const { cluster, instances } = z
        .object({
          cluster: AuroraCluster,
          instances: z.array(z.string().nullable()).nullish(),
        })
        .parse(describe);
      return {
        label: `${key}=${cluster.id}`,
        ...split(
          present([
            cluster.endpoint,
            cluster.reader,
            ...(cluster.custom ?? []),
            ...(instances ?? []),
          ]),
        ),
        connectionNames: [],
      } satisfies BackupTarget;
    }
    case "azure-pg-backup": {
      const server = AzureServer.parse(describe);
      return {
        label: `${key}=${server.name ?? "(unnamed)"}`,
        ...split(present([server.fqdn])),
        connectionNames: [],
      } satisfies BackupTarget;
    }
    case "cloudsql-backup": {
      const instance = CloudSqlInstance.parse(describe);
      return {
        label: `${key}=${instance.name ?? instance.connectionName ?? "(unnamed)"}`,
        ...split(
          present([
            instance.dnsName,
            ...(instance.dnsNames ?? []).map((entry) => entry.name),
            // OUTGOING is the address the instance connects out from, not one it answers on.
            ...(instance.ipAddresses ?? [])
              .filter((entry) => entry.type !== "OUTGOING")
              .map((entry) => entry.ipAddress),
          ]),
        ),
        connectionNames: present([instance.connectionName]),
      } satisfies BackupTarget;
    }
    case "alloydb-backup": {
      const instances = z.array(AlloyDbInstance).parse(describe);
      const cluster =
        instances[0]?.name?.match(/\/clusters\/([^/]+)\//)?.[1] ?? "(none)";
      return {
        label: `${key}=${cluster}`,
        ...split(
          present(
            instances.flatMap((instance) => [
              instance.ipAddress,
              instance.publicIpAddress,
              instance.pscInstanceConfig?.pscDnsName,
            ]),
          ),
        ),
        connectionNames: present(instances.map((instance) => instance.name)),
      } satisfies BackupTarget;
    }
  }
}

/** The database the running server reports on /release, or null when it reports none. */
export function productDatabase(
  identity: ReleaseIdentity | null,
): ProductDatabase | null {
  const database = identity?.database;
  if (!database || typeof database !== "object") return null;
  const host =
    typeof database.host === "string" && database.host.trim()
      ? normalizeHost(database.host)
      : null;
  const instanceConnectionName =
    typeof database.instanceConnectionName === "string" &&
    database.instanceConnectionName.trim()
      ? database.instanceConnectionName.trim().toLowerCase()
      : null;
  return host || instanceConnectionName
    ? { host, instanceConnectionName }
    : null;
}

export type Resolve = (host: string) => Promise<string[]>;

/** The addresses a name resolves to from this pod, which shares the cluster's resolver with the
 * product's server. None when it does not resolve. */
export const resolveHost: Resolve = async (host) => {
  if (isIP(host)) return [host];
  try {
    const answers = await lookup(host, { all: true });
    return [...new Set(answers.map((answer) => answer.address))];
  } catch {
    return [];
  }
};

/**
 * Is the backup target the product's database? By instance connection name when both sides have
 * one; else by host name; else by address, which covers a CNAME of the endpoint (a custom DNS name,
 * or a private DNS zone). Unknown on either side is a refusal, never a pass.
 */
export async function compareTarget(
  product: ProductDatabase | null,
  target: BackupTarget,
  resolve: Resolve = resolveHost,
): Promise<Verdict> {
  const described = [
    ...target.names,
    ...target.addresses,
    ...target.connectionNames,
  ];
  if (!product)
    return {
      ok: false,
      mismatch: false,
      reason:
        "the running server does not report its database on /release, so the backup target cannot be confirmed",
    };
  if (!described.length)
    return {
      ok: false,
      mismatch: false,
      reason: `the cloud describes no endpoint for ${target.label}, so it cannot be confirmed as the product's database`,
    };
  const uses = product.host ?? product.instanceConnectionName;
  const differs = () =>
    `${target.label} is ${described.slice(0, 4).join(", ")}, but the product's server uses ${uses}. Point ${target.label.split("=")[0]} at the database the product uses`;
  if (product.instanceConnectionName && target.connectionNames.length)
    return target.connectionNames.includes(product.instanceConnectionName)
      ? { ok: true, how: `instance ${product.instanceConnectionName}` }
      : { ok: false, mismatch: true, reason: differs() };
  if (!product.host)
    return {
      ok: false,
      mismatch: false,
      reason: `the product's server reports instance ${product.instanceConnectionName} and no host, and the cloud describes no instance connection name for ${target.label}`,
    };
  if (
    target.names.includes(product.host) ||
    target.addresses.includes(product.host)
  )
    return { ok: true, how: `host ${product.host}` };
  const productAddresses = isIP(product.host)
    ? [product.host]
    : await resolve(product.host);
  if (!productAddresses.length)
    return {
      ok: false,
      mismatch: false,
      reason: `the product's database host ${product.host} does not resolve from the agent, so ${target.label} cannot be confirmed as its database`,
    };
  const targetAddresses = new Set(target.addresses);
  for (const name of target.names)
    for (const address of await resolve(name)) targetAddresses.add(address);
  const shared = productAddresses.find((address) =>
    targetAddresses.has(address),
  );
  if (shared) return { ok: true, how: `host ${product.host} at ${shared}` };
  return { ok: false, mismatch: true, reason: differs() };
}

interface Pod {
  status?: {
    containerStatuses?: {
      state?: { terminated?: { message?: string; exitCode?: number } };
    }[];
  };
}

/** The termination message of the Job's pod: what the backup-target script wrote, or the end of
 * its log when it failed before writing (FallbackToLogsOnError). */
async function terminationMessage(kube: Kube, namespace: string, job: string) {
  const pods = await kube.list<Pod>(
    namespace,
    "pod",
    `batch.kubernetes.io/job-name=${job}`,
  );
  for (const pod of pods)
    for (const container of pod.status?.containerStatuses ?? []) {
      const message = container.state?.terminated?.message?.trim();
      if (message) return message;
    }
  return "";
}

/**
 * Runs the chart's backup-target Job and compares what the cloud says with what the server says.
 * Resolves with how they matched; throws BackupTargetRefused otherwise. Never skips a cloud kind.
 */
/**
 * The first OpenBot release whose server reports its database on /release. 1.1.2 was cut from main
 * before the field existed, so the first release that can carry it is the next one after 1.1.2.
 * A server older than this cannot say which database it uses: the check is skipped for it, with a
 * warning, so installs on those releases can still upgrade to one that reports it. A server at or
 * after this release that reports nothing is refused like any other unknown.
 */
export const DATABASE_IDENTITY_SINCE = "v1.1.3";

const VERSION =
  /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?$/;

/** Whether `version` is a release before DATABASE_IDENTITY_SINCE, by semantic versioning's order
 * (a pre-release, `1.1.3-rc.1`, comes before its release). False for anything that is not a
 * release number: an unknown version is never let through. */
export function predatesDatabaseIdentity(version: string | undefined) {
  const running = VERSION.exec(version ?? "");
  const since = VERSION.exec(DATABASE_IDENTITY_SINCE);
  if (!running || !since) return false;
  for (const index of [1, 2, 3]) {
    const difference = Number(running[index]) - Number(since[index]);
    if (difference !== 0) return difference < 0;
  }
  return running[4] !== undefined && since[4] === undefined;
}

export interface Confirmation {
  /** False only when the check was skipped for a server that predates it. */
  verified: boolean;
  message: string;
}

export async function confirmBackupTarget(options: {
  kube: Kube;
  kind: BackupKind;
  /** The chart's backup-target-job.yaml, or undefined when the chart has none. */
  template: string | undefined;
  operation: string;
  timeoutSeconds: number;
  identity: ReleaseIdentity | null;
  resolve?: Resolve;
}): Promise<Confirmation> {
  const { kube, kind, template } = options;
  if (kind === "none")
    throw new BackupTargetRefused(
      "no backup is configured (backup.kind is empty), and an upgrade that migrates the database needs one; set backup.kind and its values with helm upgrade openbot-agent",
      false,
    );
  if (kind === "command")
    return { verified: true, message: "backup.kind=command is not checked" };
  const product = productDatabase(options.identity);
  if (!product && predatesDatabaseIdentity(options.identity?.version))
    return {
      verified: false,
      message: `backup target not verified: server predates the check (${options.identity?.version} is older than ${DATABASE_IDENTITY_SINCE}, the first release that reports its database); the backup is of ${VALUES_KEY[kind]} as configured`,
    };
  if (!product)
    throw new BackupTargetRefused(
      `the running server (${options.identity?.version ?? "unknown version"}) does not report its database on /release, so ${VALUES_KEY[kind]} cannot be confirmed as the database it uses`,
      false,
    );
  if (!template)
    throw new BackupTargetRefused(
      "the openbot-agent chart gives the agent no backup-target Job (backup-target-job.yaml), so the backup target cannot be confirmed; upgrade the openbot-agent chart",
      false,
    );
  const job = fillJob(template, options.operation);
  let message = "";
  try {
    await runJob(kube, template, options.operation, options.timeoutSeconds);
    message = await terminationMessage(kube, job.namespace, job.name);
  } catch (error) {
    const said = await terminationMessage(kube, job.namespace, job.name).catch(
      () => "",
    );
    throw new BackupTargetRefused(
      `the cloud did not describe ${VALUES_KEY[kind]}: ${(said || (error instanceof Error ? error.message : String(error))).slice(-600)}`,
      false,
    );
  }
  let target: BackupTarget;
  try {
    target = backupTargetFrom(kind, message);
  } catch (error) {
    throw new BackupTargetRefused(
      error instanceof Error ? error.message : String(error),
      false,
    );
  }
  const verdict = await compareTarget(product, target, options.resolve);
  if (!verdict.ok)
    throw new BackupTargetRefused(verdict.reason, verdict.mismatch);
  return {
    verified: true,
    message: `${target.label} is the product's database (${verdict.how})`,
  };
}
