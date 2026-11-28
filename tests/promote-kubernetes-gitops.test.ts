import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type KubernetesPromotionOptions,
  promoteKubernetes,
  writeGitOpsPromotion,
} from "../scripts/promote-kubernetes";
import type { CommandRunner } from "../scripts/update-local";
import { runCommand } from "../scripts/update-local";
import targetFixture from "../shared/fixtures/releases/candidate.json";
import currentFixture from "../shared/fixtures/releases/installed.json";
import { parseReleaseManifest } from "../shared/release-manifest";

// Each case packages a chart and renders it with real `helm`.
setDefaultTimeout(30_000);

// What a GitOps controller is told to do, and what an operator is told to inspect, follow the
// chart being promoted to. A chart whose server applies its own migrations as it starts has no
// migration Job, and the ordering used to tell every controller to run one anyway.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const IMAGE =
  '"{{ .Values.image.repository }}:{{ .Values.image.tag }}@{{ .Values.image.digest }}"';
/** The server of a chart whose server migrates the database itself before it listens. */
const SERVER_MIGRATES = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-server
  labels:
    app.kubernetes.io/component: server
spec:
  template:
    spec:
      initContainers:
        - name: wait-for-database
          image: postgres:17
      containers:
        - name: server
          image: ${IMAGE}
`;
/** The guarded pre-upgrade Job of a chart that migrates before it replaces the server. */
const MIGRATION_JOB = `apiVersion: batch/v1
kind: Job
metadata:
  name: {{ .Release.Name }}-migrate
  labels:
    app.kubernetes.io/component: migrations
  annotations:
    helm.sh/hook: pre-install,pre-upgrade
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: ${IMAGE}
          workingDir: /app/server
          command:
            - /bin/sh
            - -ec
            - |
              exec /usr/local/bin/bun scripts/migrate.ts
`;

/** A promotion to a real packaged chart with the given templates, rendered by real Helm. */
function promotion(templates: Record<string, string>, databaseChanges = true) {
  const root = mkdtempSync(join(tmpdir(), "openbot-gitops-"));
  roots.push(root);
  const source = join(root, "openbot");
  mkdirSync(join(source, "templates"), { recursive: true });
  writeFileSync(
    join(source, "Chart.yaml"),
    'apiVersion: v2\nname: openbot\nversion: 0.3.0\nappVersion: "0.3.0"\n',
  );
  writeFileSync(
    join(source, "values.yaml"),
    'image:\n  repository: ghcr.io/acme/openbot\n  tag: ""\n  digest: ""\n',
  );
  for (const [name, template] of Object.entries(templates))
    writeFileSync(join(source, "templates", name), template);
  execFileSync("helm", ["package", source, "--destination", root], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chart = join(root, "openbot-0.3.0.tgz");
  const current = parseReleaseManifest(structuredClone(currentFixture));
  const candidate = parseReleaseManifest(structuredClone(targetFixture));
  for (const manifest of [current, candidate])
    manifest.artifacts.images.openbot = {
      reference: `ghcr.io/acme/openbot@sha256:${"b".repeat(64)}`,
    };
  if (databaseChanges) candidate.compatibility.database.to = "openbot-db-2";
  candidate.artifacts.chart = {
    version: "0.3.0",
    url: "https://github.com/acme/openbot/releases/download/v0.3.0/openbot-0.3.0.tgz",
    sha256: createHash("sha256").update(readFileSync(chart)).digest("hex"),
  };
  const values = join(root, "customer-values.yaml");
  writeFileSync(values, "replicas: 2\n");
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
  };
  return options;
}
async function ordering(options: KubernetesPromotionOptions) {
  const result = await writeGitOpsPromotion(options);
  expect(result.phase).toBe("proposed");
  return readFileSync(result.ordering, "utf8");
}

test("a chart whose server migrates at start is not given a migration Job to run", async () => {
  const text = await ordering(promotion({ "server.yaml": SERVER_MIGRATES }));
  expect(text).toContain("3. Run no migration Job: this chart has none.");
  expect(text).toContain("`wait-for-database`");
  expect(text).toContain("require readiness before accepting");
  expect(text).not.toContain("guarded migration Job");
  expect(text).not.toContain("pre-upgrade hook");
  expect(text).not.toContain("must define its own ordered migration phase");
  // The rest of the ordering is what it always was.
  expect(text).toContain("1. Verify chart archive SHA-256");
  expect(text).toContain("snapshot:verified-backup");
  expect(text).toContain("5. Resume routines");
  expect(text).toContain("A Git revert does not undo database changes.");
});

test("a chart that still has a guarded migration Job keeps the instruction to run it first", async () => {
  const text = await ordering(
    promotion({
      "server.yaml": SERVER_MIGRATES,
      "migrate.yaml": MIGRATION_JOB,
    }),
  );
  expect(text).toContain(
    "3. Run the target image's guarded migration Job and require successful completion before replacing server replicas.",
  );
  expect(text).toContain(
    "A renderer/controller that ignores Helm hooks must define its own ordered migration phase.",
  );
  expect(text).not.toContain("Run no migration");
});

test("a promotion that leaves the database where it is names no migration at all", async () => {
  const text = await ordering(
    promotion({ "server.yaml": SERVER_MIGRATES }, false),
  );
  expect(text).toContain(
    "3. Run no migration: this release declares no database change.",
  );
  expect(text).not.toContain("migration Job");
});

/**
 * The same for a live promotion that stops after Helm started: the recovery note names where the
 * migration ran. Helm renders the real chart; the cluster calls are answered here, and `helm
 * upgrade` fails as a server that could not migrate fails it.
 */
test.each([
  [
    "the server's logs for a chart whose server migrates",
    { "server.yaml": SERVER_MIGRATES },
    "This chart has no migration Job: its server applies the migrations as it starts. Inspect the server pods' logs and the rollout.",
  ],
  [
    "the migration Job for a chart that has one",
    { "server.yaml": SERVER_MIGRATES, "migrate.yaml": MIGRATION_JOB },
    "Inspect the migration Job and rollout.",
  ],
])(
  "a promotion that stops after Helm started points at %s",
  async (_name, templates, advice) => {
    const options = promotion(templates);
    const run: CommandRunner = async (command, runOptions) => {
      if (command[0] === "helm" && command[1] === "template")
        return runCommand(command, runOptions);
      if (command[0] === "helm" && command[1] === "upgrade")
        throw new Error("timed out waiting for the condition");
      if (command[0] === "helm" && command[1] === "get")
        return command[2] === "values" ? "null\n" : "";
      if (command[0] === "helm" && command[1] === "version") return "v3.19.0";
      if (command[0] === "kubectl" && command.includes("cronjob"))
        return JSON.stringify({ items: [] });
      if (command[0] === "kubectl" && command.includes("get"))
        return JSON.stringify({
          items: [
            {
              spec: {
                template: {
                  spec: {
                    containers: [
                      {
                        name: "server",
                        image: `ghcr.io/acme/openbot:v0.2.0@sha256:${"b".repeat(64)}`,
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
    await expect(promoteKubernetes({ ...options, run })).rejects.toThrow(
      "requires operator recovery",
    );
    const journal = JSON.parse(
      readFileSync(
        join(options.outputDirectory, "promotion-journal.json"),
        "utf8",
      ),
    );
    expect(journal.phase).toBe("recovery-required");
    expect(journal.recovery).toContain(advice);
  },
);
