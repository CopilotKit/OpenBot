import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type KubernetesPromotionOptions,
  planKubernetesPromotion,
  promoteKubernetes,
  writeGitOpsPromotion,
} from "../scripts/promote-kubernetes";
import type { CommandRunner } from "../scripts/update-local";
import targetFixture from "../shared/fixtures/releases/candidate.json";
import currentFixture from "../shared/fixtures/releases/installed.json";
import { parseReleaseManifest } from "../shared/release-manifest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openbot-promotion-"));
  roots.push(root);
  const chart = join(root, "openbot-0.1.4.tgz");
  writeFileSync(chart, "pinned chart fixture");
  const current = parseReleaseManifest(structuredClone(currentFixture));
  const candidate = parseReleaseManifest(structuredClone(targetFixture));
  current.artifacts.images.openbot = {
    reference: `ghcr.io/acme/openbot@sha256:${"b".repeat(64)}`,
  };
  candidate.artifacts.images.openbot = {
    reference: `ghcr.io/acme/openbot@sha256:${"b".repeat(64)}`,
  };
  candidate.artifacts.chart = {
    version: "0.1.4",
    url: "https://github.com/acme/openbot/releases/download/v0.3.0/openbot-0.1.4.tgz",
    sha256: createHash("sha256").update(readFileSync(chart)).digest("hex"),
  };
  const values = join(root, "customer-values.yaml");
  writeFileSync(
    values,
    "secrets:\n  existingSecret: customer-secrets\nconfig:\n  tenantPackageDir: /customer\n",
  );
  const calls: string[][] = [];
  const run: CommandRunner = async (command) => {
    calls.push([...command]);
    if (command[0] === "kubectl" && command.includes("exec"))
      return JSON.stringify({
        version: candidate.version,
        commit: candidate.source.commit,
        distributionId: candidate.distribution.id,
        repository: candidate.distribution.repository,
        channel: candidate.distribution.channel,
      });
    if (command[0] === "kubectl" && command.includes("cronjob"))
      return JSON.stringify({ items: [] });
    if (command[0] === "kubectl" && command.includes("get"))
      return JSON.stringify({
        items: [
          {
            spec: {
              template: {
                metadata: {
                  annotations: {
                    "openbot.ai/distribution": "acme.openbot",
                    "openbot.ai/release": "v0.3.0",
                    "openbot.ai/source-commit": candidate.source.commit,
                  },
                },
                spec: {
                  containers: [
                    {
                      name: "server",
                      image: `ghcr.io/acme/openbot:v0.3.0@sha256:${"b".repeat(64)}`,
                    },
                  ],
                },
              },
            },
          },
        ],
      });
    return "";
  };
  const options: KubernetesPromotionOptions = {
    current,
    candidate,
    policy: {
      distributionId: "acme.openbot",
      repository: "acme/openbot",
      channel: "stable",
    },
    namespace: "customer",
    release: "openbot",
    chart,
    customerValues: [values],
    outputDirectory: join(root, "promotion"),
    backupReference: "snapshot:verified-backup",
    backupCommand: ["backup-fixture"],
    acknowledgeInterruption: true,
    timeoutSeconds: 120,
    run,
  };
  return { root, calls, options };
}
test("Helm plan pins the chart and images while leaving customer values separate", async () => {
  const f = fixture();
  const plan = await planKubernetesPromotion(f.options);
  expect(plan.allowed).toBe(true);
  expect(plan.values.image.digest).toBe(`sha256:${"b".repeat(64)}`);
  expect(readFileSync(f.options.customerValues[0] ?? "", "utf8")).toContain(
    "customer-secrets",
  );
  expect(f.calls).toHaveLength(0);
});
test("wrong chart checksum and missing backup block promotion before cluster mutation", async () => {
  const f = fixture();
  writeFileSync(f.options.chart, "corrupted");
  const plan = await planKubernetesPromotion({
    ...f.options,
    backupReference: "",
  });
  expect(plan.allowed).toBe(false);
  expect(plan.reasons.join(" ")).toContain("checksum");
  expect(plan.reasons.join(" ")).toContain("backup");
  expect(f.calls).toHaveLength(0);
});
test("Helm promotion waits for migration and rollout and records acceptance last", async () => {
  const f = fixture();
  const result = await promoteKubernetes(f.options);
  expect(result.phase).toBe("accepted");
  const upgrade = f.calls.find((c) => c[0] === "helm" && c[1] === "upgrade");
  expect(upgrade).toContain("--wait");
  expect(upgrade).toContain("--wait-for-jobs");
  expect(upgrade).not.toContain("--atomic");
  expect(upgrade).toContain(f.options.customerValues[0] ?? "");
  expect(
    f.calls.some((c) => c.includes("rollout") && c.includes("status")),
  ).toBe(true);
  expect(
    JSON.parse(
      readFileSync(
        join(f.options.outputDirectory, "accepted-release.json"),
        "utf8",
      ),
    ).version,
  ).toBe("v0.3.0");
});
test("failed migration/Helm execution preserves evidence without automatic SQL rollback", async () => {
  const f = fixture();
  const run: CommandRunner = async (command, options) => {
    if (command[0] === "helm" && command[1] === "upgrade")
      throw new Error("migration failed");
    return f.options.run?.(command, options) ?? "";
  };
  await expect(promoteKubernetes({ ...f.options, run })).rejects.toThrow(
    "migration failed",
  );
  expect(
    JSON.parse(
      readFileSync(
        join(f.options.outputDirectory, "promotion-journal.json"),
        "utf8",
      ),
    ).phase,
  ).toBe("recovery-required");
  expect(f.calls.some((c) => c.includes("rollback"))).toBe(false);
});
test("GitOps writes pinned review artifacts without claiming deployment or calling a cluster", async () => {
  const f = fixture();
  const result = await writeGitOpsPromotion(f.options);
  expect(result.phase).toBe("proposed");
  expect(f.calls).toHaveLength(0);
  expect(
    readFileSync(join(f.options.outputDirectory, "ORDERING.md"), "utf8"),
  ).toContain("migration");
  expect(
    readFileSync(
      join(f.options.outputDirectory, "release-values.json"),
      "utf8",
    ),
  ).toContain("sha256:");
});

test("Helm workload metadata alone cannot accept a server reporting another release", async () => {
  const f = fixture();
  const run: CommandRunner = async (command, options) =>
    command.includes("exec")
      ? JSON.stringify({ version: "another-release" })
      : (f.options.run?.(command, options) ?? "");
  await expect(promoteKubernetes({ ...f.options, run })).rejects.toThrow(
    "identity",
  );
});
