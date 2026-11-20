#!/usr/bin/env bun
/** Explicit operator entry point. Metadata hashes must come from a trusted release approval. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  parseReleaseManifest,
  type UpgradePolicy,
} from "../shared/release-manifest";
import {
  planKubernetesPromotion,
  promoteKubernetes,
  writeGitOpsPromotion,
} from "./promote-kubernetes";
import {
  acceptedBuildEnvironment,
  applyLocalUpdate,
  assertLocalStartAllowed,
  type LocalUpdateOptions,
  planLocalUpdate,
} from "./update-local";

const HELP = `Usage:
  bun scripts/update.ts local check|plan|apply [options]
  bun scripts/update.ts local status --root /installation
  bun scripts/update.ts kubernetes check|plan|apply|gitops [options]

Common:
  --candidate FILE --candidate-sha256 TRUSTED_SHA256 --policy FILE
  --timeout SECONDS --acknowledge-interruption
Local:
  --root DIRECTORY --topology host|image --backup-dir DIRECTORY
  --customer-path RELATIVE_PATH (repeatable)
Kubernetes:
  --current FILE --chart PINNED.tgz --namespace NAME --release NAME
  --values CUSTOMER.yaml (repeatable) --output ABSOLUTE_DIRECTORY
  --backup-reference ID_OR_PATH --backup-command-json '["executable","argument"]'

The policy JSON contains distributionId, repository and channel. The candidate checksum must
come from independently approved metadata, not a checksum computed solely from an untrusted
download. This command does not establish publisher authenticity from a checksum alone.
Local updates require a known accepted .openbot-release.json and a fetched clean Git baseline.
Host updates require this installation's host services already stopped; unrelated processes
are never killed. Kubernetes apply changes an existing Helm release; gitops only writes review
artifacts and ordering instructions. No mode deletes database/profile/workspace volumes.
`;

function policy(path: string): UpgradePolicy {
  const value: UpgradePolicy = JSON.parse(readFileSync(path, "utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !==
      "channel,distributionId,repository" ||
    typeof value.distributionId !== "string" ||
    !value.distributionId.trim() ||
    typeof value.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) ||
    typeof value.channel !== "string" ||
    !value.channel.trim()
  )
    throw new Error(
      "Policy must contain exactly distributionId, repository and channel",
    );
  return value;
}
function trustedCandidate(path: string, expected: string) {
  if (!/^[0-9a-f]{64}$/.test(expected))
    throw new Error(
      "--candidate-sha256 must be an independently approved SHA-256",
    );
  const bytes = readFileSync(path);
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error(
      "Candidate metadata checksum mismatch; nothing was changed",
    );
  return parseReleaseManifest(JSON.parse(bytes.toString("utf8")));
}
export async function main(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      root: { type: "string" },
      candidate: { type: "string" },
      "candidate-sha256": { type: "string" },
      policy: { type: "string" },
      topology: { type: "string" },
      "backup-dir": { type: "string" },
      "customer-path": { type: "string", multiple: true },
      timeout: { type: "string" },
      "acknowledge-interruption": { type: "boolean" },
      current: { type: "string" },
      chart: { type: "string" },
      namespace: { type: "string" },
      release: { type: "string" },
      values: { type: "string", multiple: true },
      output: { type: "string" },
      "backup-reference": { type: "string" },
      "backup-command-json": { type: "string" },
      "intelligence-capability": { type: "string", multiple: true },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const [mode, action] = positionals;
  if (
    positionals.length !== 2 ||
    !["local", "kubernetes"].includes(mode ?? "") ||
    ![
      "check",
      "plan",
      "apply",
      "gitops",
      "status",
      "assert-start",
      "build-environment",
    ].includes(action ?? "")
  )
    throw new Error(HELP);
  const required = (name: string, value: string | undefined) => {
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const root = resolve(values.root ?? process.cwd());
  if (mode === "local" && action === "build-environment") {
    for (const [key, value] of Object.entries(acceptedBuildEnvironment(root)))
      console.log(`${key}=${value}`);
    return 0;
  }
  if (mode === "local" && action === "assert-start") {
    assertLocalStartAllowed(root, process.env.OPENBOT_UPDATE_OPERATION);
    return 0;
  }
  if (mode === "local" && action === "status") {
    console.log(
      readFileSync(join(root, ".openbot-update-journal.json"), "utf8"),
    );
    return 0;
  }
  if (
    (mode === "local" && action === "gitops") ||
    (mode === "kubernetes" && action === "status")
  )
    throw new Error("That action is not supported for this deployment mode");
  const candidate = trustedCandidate(
    required("candidate", values.candidate),
    required("candidate-sha256", values["candidate-sha256"]),
  );
  const configuredPolicy = policy(required("policy", values.policy));
  const common = {
    candidate,
    policy: configuredPolicy,
    timeoutSeconds: values.timeout ? Number(values.timeout) : undefined,
    acknowledgeInterruption: values["acknowledge-interruption"] ?? false,
    intelligenceCapabilities: values["intelligence-capability"],
  };
  if (mode === "local") {
    if (values.topology !== "host" && values.topology !== "image")
      throw new Error("--topology must explicitly be host or image");
    const options: LocalUpdateOptions = {
      ...common,
      root,
      topology: values.topology,
      backupDirectory: resolve(required("backup-dir", values["backup-dir"])),
      customerPaths: values["customer-path"],
    };
    if (action === "apply") {
      console.log(JSON.stringify(await applyLocalUpdate(options), null, 2));
      return 0;
    }
    const plan = await planLocalUpdate(options);
    console.log(JSON.stringify(plan, null, 2));
    return plan.allowed ? 0 : 2;
  }
  let backupCommand: string[] | undefined;
  if (values["backup-command-json"]) {
    const parsed: unknown = JSON.parse(values["backup-command-json"]);
    if (
      !Array.isArray(parsed) ||
      !parsed.length ||
      parsed.some((value) => typeof value !== "string" || !value)
    )
      throw new Error(
        "--backup-command-json must be a nonempty JSON string array",
      );
    backupCommand = parsed;
  }
  const options = {
    ...common,
    current: parseReleaseManifest(
      JSON.parse(readFileSync(required("current", values.current), "utf8")),
    ),
    chart: resolve(required("chart", values.chart)),
    namespace: required("namespace", values.namespace),
    release: required("release", values.release),
    customerValues: (values.values ?? []).map((path) => resolve(path)),
    outputDirectory: resolve(required("output", values.output)),
    backupReference: required("backup-reference", values["backup-reference"]),
    backupCommand,
  };
  if (action === "gitops") {
    console.log(JSON.stringify(await writeGitOpsPromotion(options), null, 2));
    return 0;
  }
  if (action === "apply") {
    console.log(JSON.stringify(await promoteKubernetes(options), null, 2));
    return 0;
  }
  const plan = await planKubernetesPromotion(options);
  console.log(JSON.stringify(plan, null, 2));
  return plan.allowed ? 0 : 2;
}
if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
