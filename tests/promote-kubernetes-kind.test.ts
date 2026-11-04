/**
 * A whole Kubernetes promotion against a real cluster: real kubectl, real Helm, a real server pod
 * answering `/release` from inside its container. It checks what tests/promote-kubernetes-helm.test.ts
 * models, end to end.
 *
 * Opt-in, because it needs a cluster it may write to. Point it at a disposable one, for example:
 *   kind create cluster --name openbot-promotion --kubeconfig /tmp/openbot-kind.kubeconfig
 *   OPENBOT_KIND_KUBECONFIG=/tmp/openbot-kind.kubeconfig bun test tests/promote-kubernetes-kind.test.ts
 * It installs into its own namespace and deletes that namespace afterwards. The server image is
 * pulled by digest from Docker Hub.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promoteKubernetes } from "../scripts/promote-kubernetes";
import { runCommand } from "../scripts/update-local";
import targetFixture from "../shared/fixtures/releases/candidate.json";
import currentFixture from "../shared/fixtures/releases/installed.json";
import { parseReleaseManifest } from "../shared/release-manifest";

setDefaultTimeout(600_000);
const kubeconfig = process.env.OPENBOT_KIND_KUBECONFIG;
const namespace = `openbot-promotion-${randomBytes(3).toString("hex")}`;
// oven/bun:1.4.3-slim, pinned. Any image with bun on its PATH would do.
const image =
  "oven/bun@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288";
const [repository = "", digest = ""] = image.split("@");

const SERVER = `Bun.serve({ port: 3001, fetch(request) {
  if (new URL(request.url).pathname !== "/release") return new Response("ok");
  return Response.json({ version: process.env.RELEASE, commit: process.env.COMMIT,
    distributionId: "acme.openbot", repository: "acme/openbot", channel: "stable" });
} });`;
const TEMPLATES = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-server
  labels: { app.kubernetes.io/instance: {{ .Release.Name }}, app.kubernetes.io/component: server }
spec:
  replicas: {{ .Values.server.replicaCount }}
  selector:
    matchLabels: { app.kubernetes.io/instance: {{ .Release.Name }}, app.kubernetes.io/component: server }
  template:
    metadata:
      labels: { app.kubernetes.io/instance: {{ .Release.Name }}, app.kubernetes.io/component: server }
      annotations: {{ toJson .Values.server.podAnnotations }}
    spec:
      containers:
        - name: server
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}@{{ .Values.image.digest }}"
          command: ["bun", "-e", {{ .Files.Get "server.js" | quote }}]
          env:
            - name: RELEASE
              valueFrom: { fieldRef: { fieldPath: "metadata.annotations['openbot.ai/release']" } }
            - name: COMMIT
              valueFrom: { fieldRef: { fieldPath: "metadata.annotations['openbot.ai/source-commit']" } }
          readinessProbe: { httpGet: { path: /health, port: 3001 }, periodSeconds: 1 }
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: {{ .Release.Name }}-routines
  labels: { app.kubernetes.io/instance: {{ .Release.Name }} }
spec:
  suspend: {{ .Values.routines.suspend }}
  schedule: "0 0 1 1 *"
  jobTemplate: { spec: { template: { spec: { restartPolicy: Never, containers: [ { name: c, image: "${image}", command: ["true"] } ] } } } }
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: {{ .Release.Name }}-attachments-culler
  labels: { app.kubernetes.io/instance: {{ .Release.Name }} }
spec:
  schedule: "0 0 1 1 *"
  jobTemplate: { spec: { template: { spec: { restartPolicy: Never, containers: [ { name: c, image: "${image}", command: ["true"] } ] } } } }
`;

const work = mkdtempSync(join(tmpdir(), "openbot-promotion-kind-"));
let chart = "";
const inherited = process.env.KUBECONFIG;
const run = (command: string[]) => runCommand(command, { cwd: work });
const kubectl = (...args: string[]) =>
  run(["kubectl", "--namespace", namespace, ...args]);

describe.skipIf(!kubeconfig)("Kubernetes promotion on a real cluster", () => {
  beforeAll(async () => {
    process.env.KUBECONFIG = kubeconfig;
    const source = join(work, "openbot-fixture");
    mkdirSync(join(source, "templates"), { recursive: true });
    writeFileSync(
      join(source, "Chart.yaml"),
      "apiVersion: v2\nname: openbot-fixture\nversion: 0.1.4\n",
    );
    writeFileSync(
      join(source, "values.yaml"),
      "server:\n  replicaCount: 2\n  podAnnotations: {}\nroutines:\n  suspend: false\nimage:\n  repository: ghcr.io/copilotkit/openbot\n  tag: v0.2.0\n  digest: ''\n",
    );
    writeFileSync(join(source, "server.js"), SERVER);
    writeFileSync(join(source, "templates", "release.yaml"), TEMPLATES);
    await run(["helm", "package", source, "--destination", work]);
    chart = join(
      work,
      readdirSync(work).find((name) => name.endsWith(".tgz")) ?? "",
    );
    await run(["kubectl", "create", "namespace", namespace]);
  });
  afterAll(async () => {
    try {
      if (kubeconfig)
        await run([
          "kubectl",
          "delete",
          "namespace",
          namespace,
          "--wait=false",
        ]);
    } finally {
      if (inherited === undefined) delete process.env.KUBECONFIG;
      else process.env.KUBECONFIG = inherited;
      rmSync(work, { recursive: true, force: true });
    }
  });

  test.each(["true", "false"])(
    "a maintenance promotion (installed with --server-side=%s) resumes every CronJob and keeps --set values and the mirror",
    async (serverSide) => {
      const release = `openbot-${serverSide === "true" ? "ssa" : "csa"}`;
      const current = parseReleaseManifest(structuredClone(currentFixture));
      const candidate = parseReleaseManifest(structuredClone(targetFixture));
      current.artifacts.images.openbot = { reference: image };
      candidate.artifacts.images.openbot = { reference: image };
      candidate.artifacts.chart = {
        version: "0.1.4",
        url: "https://github.com/acme/openbot/releases/download/v0.3.0/openbot-fixture.tgz",
        sha256: createHash("sha256").update(readFileSync(chart)).digest("hex"),
      };
      // Installed through a registry mirror the manifest does not name, with --set values no
      // customer file carries.
      const mirror = `docker.io/${repository}`;
      await run([
        "helm",
        "install",
        release,
        chart,
        "--namespace",
        namespace,
        `--server-side=${serverSide}`,
        "--set",
        `image.repository=${mirror}`,
        "--set",
        `image.digest=${digest}`,
        "--set",
        "server.replicaCount=3",
        "--set-string",
        "server.podAnnotations.openbot\\.ai/release=v0.2.0",
        "--set-string",
        `server.podAnnotations.openbot\\.ai/source-commit=${current.source.commit}`,
        "--wait",
        "--timeout",
        "300s",
      ]);
      const customerValues = join(work, `${release}-customer.yaml`);
      writeFileSync(customerValues, "routines:\n  suspend: false\n");
      const outputDirectory = join(work, `${release}-promotion`);
      const journal = await promoteKubernetes({
        current,
        candidate,
        policy: {
          distributionId: "acme.openbot",
          repository: "acme/openbot",
          channel: "stable",
        },
        namespace,
        release,
        chart,
        customerValues: [customerValues],
        outputDirectory,
        backupReference: "snapshot:kind-fixture",
        backupCommand: ["true"],
        acknowledgeInterruption: true,
        timeoutSeconds: 300,
      });
      expect(journal.phase).toBe("accepted");
      expect(journal.pausedCronJobs?.map((job) => job.wasSuspended)).toEqual([
        false,
        false,
      ]);
      for (const name of ["routines", "attachments-culler"])
        expect([
          name,
          (
            await kubectl(
              "get",
              "cronjob",
              `${release}-${name}`,
              "-o",
              "jsonpath={.spec.suspend}",
            )
          ).trim(),
        ]).toEqual([name, "false"]);
      expect(
        (
          await kubectl(
            "get",
            "deployment",
            `${release}-server`,
            "-o",
            "jsonpath={.spec.replicas}",
          )
        ).trim(),
      ).toBe("3");
      expect(
        (
          await kubectl(
            "get",
            "deployment",
            `${release}-server`,
            "-o",
            "jsonpath={.spec.template.spec.containers[0].image}",
          )
        ).trim(),
      ).toBe(`${mirror}:v0.3.0@${digest}`);
      expect(
        JSON.parse(
          readFileSync(join(outputDirectory, "previous-values.json"), "utf8"),
        ).server.replicaCount,
      ).toBe(3);
    },
  );
});
