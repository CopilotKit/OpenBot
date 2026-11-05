/**
 * Routines on a Helm install: the sweep that fires them, and the secret it fires them with, rendered
 * by real Helm from the real chart.
 *
 * What must not regress, because each one fails silently on a cluster: a person asks a Bot for a
 * routine, it is stored, scheduled and shown with a next run time, and it never runs.
 *  - a vanilla install runs the routines CronJob, with no secret for anybody to make by hand;
 *  - the CronJob presents WORKER_SHARED_SECRET from a Secret something actually writes, and the API
 *    server checks the very same Secret and key, so the two can only agree;
 *  - every shipped `ci/` target does the same, whether this chart, a store or the operator holds
 *    the rest of its secrets;
 *  - a secret the operator gives (a value, or a key in their store) is the one used;
 *  - nothing ships a fixed value, which would be a credential published in this repository.
 *
 * Kept across upgrades is `lookup`'s job, which needs a cluster: the last block runs against one when
 * OPENBOT_KIND_KUBECONFIG names a disposable cluster (see tests/promote-kubernetes-kind.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const helm = Bun.which("helm") !== null;
const kubeconfig = process.env.OPENBOT_KIND_KUBECONFIG;
const chart = join(import.meta.dir, "../charts/openbot");
const SANDBOX_API = [
  "--api-versions",
  "agents.x-k8s.io/v1beta1/Sandbox",
  "--api-versions",
  "extensions.agents.x-k8s.io/v1beta1/SandboxTemplate",
];

type EnvVar = {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string } };
};
type PodSpec = { containers: { name: string; env?: EnvVar[] }[] };
type Doc = {
  kind: string;
  metadata: { name: string; labels?: Record<string, string> };
  spec?: {
    suspend?: boolean;
    template?: { spec: PodSpec };
    jobTemplate?: { spec: { template: { spec: PodSpec } } };
    target?: { name: string };
    data?: { secretKey: string }[];
    ports?: { port: number }[];
  };
  data?: Record<string, string>;
  stringData?: Record<string, string>;
};

function render(...args: string[]): Doc[] {
  const result = Bun.spawnSync(
    [
      "helm",
      "template",
      "openbot",
      chart,
      "--namespace",
      "openbot",
      "--set-string",
      `secrets.keyEncryptionKey=${randomBytes(32).toString("base64")}`,
      ...SANDBOX_API,
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return parseAllDocuments(new TextDecoder().decode(result.stdout))
    .map((document) => document.toJSON() as Doc | null)
    .filter((document): document is Doc => document !== null);
}

const values = (target: string) => [
  "--values",
  join(chart, `ci/${target}-values.yaml`),
];

const component = (name: string) => (doc: Doc) =>
  doc.metadata.labels?.["app.kubernetes.io/component"] === name;

function server(docs: Doc[]): Doc | undefined {
  return docs.find((d) => d.kind === "Deployment" && component("server")(d));
}

function sweep(docs: Doc[]): Doc | undefined {
  return docs.find((d) => d.kind === "CronJob" && component("routines")(d));
}

function env(doc: Doc | undefined): EnvVar[] {
  const pod =
    doc?.spec?.template?.spec ?? doc?.spec?.jobTemplate?.spec.template.spec;
  return pod?.containers[0]?.env ?? [];
}

function workerRef(doc: Doc | undefined) {
  return env(doc).find((e) => e.name === "WORKER_SHARED_SECRET")?.valueFrom
    ?.secretKeyRef;
}

/** What a Secret in the render holds at a key, or undefined when the render does not write it. */
function written(docs: Doc[], name: string, key: string): string | undefined {
  const secret = docs.find(
    (d) => d.kind === "Secret" && d.metadata.name === name,
  );
  if (secret?.stringData?.[key] !== undefined) return secret.stringData[key];
  const raw = secret?.data?.[key];
  return raw === undefined
    ? undefined
    : Buffer.from(raw, "base64").toString("utf8");
}

/** Whether a store will write this key into this Secret: an ExternalSecret targeting it names it. */
function synced(docs: Doc[], name: string, key: string): boolean {
  return docs.some(
    (d) =>
      d.kind === "ExternalSecret" &&
      d.spec?.target?.name === name &&
      (d.spec?.data ?? []).some((entry) => entry.secretKey === key),
  );
}

/** Every Secret in the render that carries a worker secret. */
function workerSecrets(docs: Doc[]): string[] {
  return docs
    .filter(
      (d) =>
        d.kind === "Secret" &&
        (d.stringData?.["worker-shared-secret"] !== undefined ||
          d.data?.["worker-shared-secret"] !== undefined),
    )
    .map((d) => d.metadata.name);
}

const targets = readdirSync(join(chart, "ci"))
  .filter((file) => file.endsWith("-values.yaml"))
  .map((file) => file.replace(/-values\.yaml$/, ""));

describe.skipIf(!helm)("routines on a Helm install", () => {
  test("a vanilla install runs the sweep on a worker secret the chart writes, and the server checks that same one", () => {
    const docs = render(...values("vanilla"));
    const cronJob = sweep(docs);
    expect(cronJob).toBeDefined();
    expect(cronJob?.spec?.suspend).toBe(false);

    const fromSweep = workerRef(cronJob);
    const fromServer = workerRef(server(docs));
    expect(fromSweep).toBeDefined();
    expect(fromServer).toEqual(fromSweep);
    const secret = written(docs, fromSweep?.name ?? "", fromSweep?.key ?? "");
    expect(secret?.length ?? 0).toBeGreaterThanOrEqual(32);

    // And the sweep hands each firing to this release's own server, on the port it serves.
    const internal = new URL(
      env(cronJob).find((e) => e.name === "SERVER_INTERNAL_URL")?.value ?? "",
    );
    const service = docs.find(
      (d) => d.kind === "Service" && d.metadata.name === internal.hostname,
    );
    expect(service && component("server")(service)).toBe(true);
    expect(service?.spec?.ports?.map((p) => p.port)).toContain(
      Number(internal.port),
    );
  });

  test("generates a fresh secret rather than shipping one", () => {
    const once = render(...values("vanilla"));
    const twice = render(...values("vanilla"));
    const ref = workerRef(sweep(once));
    const first = written(once, ref?.name ?? "", ref?.key ?? "");
    const second = written(twice, ref?.name ?? "", ref?.key ?? "");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  test.each(targets)(
    "the %s target fires routines on a secret something writes",
    (target) => {
      const docs = render(...values(target));
      const cronJob = sweep(docs);
      expect(cronJob).toBeDefined();
      const ref = workerRef(cronJob);
      expect(ref).toBeDefined();
      expect(workerRef(server(docs))).toEqual(ref);
      const name = ref?.name ?? "";
      const key = ref?.key ?? "";
      expect(Boolean(written(docs, name, key)) || synced(docs, name, key)).toBe(
        true,
      );
    },
  );

  test("a worker secret given as a value is the one both sides use", () => {
    for (const extra of [
      [],
      // With the operator's own Secret holding everything else, the value still reaches both sides.
      ["--set-string", "secrets.existingSecret=mine"],
    ]) {
      const docs = render(
        ...values("vanilla"),
        "--set-string",
        "secrets.workerSharedSecret=given-by-the-operator",
        ...extra,
      );
      const ref = workerRef(sweep(docs));
      expect(workerRef(server(docs))).toEqual(ref);
      expect(written(docs, ref?.name ?? "", ref?.key ?? "")).toBe(
        "given-by-the-operator",
      );
    }
  });

  test("a worker secret named in the store is read from the store, and the chart writes none", () => {
    const docs = render(
      ...values("eks"),
      "--set",
      "externalSecrets.data[6].secretKey=worker-shared-secret",
      "--set",
      "externalSecrets.data[6].remoteRef.key=openbot/worker-shared-secret",
    );
    const ref = workerRef(sweep(docs));
    expect(workerRef(server(docs))).toEqual(ref);
    expect(synced(docs, ref?.name ?? "", ref?.key ?? "")).toBe(true);
    expect(workerSecrets(docs)).toEqual([]);
  });

  test("with the operator's own Secret and no worker secret anywhere it can be seen, the chart writes one", () => {
    // `helm template` cannot look inside the operator's Secret, so this is also what any render
    // without a cluster shows. Against a cluster, a key in that Secret is used instead (below).
    const docs = render(
      ...values("vanilla"),
      "--set-string",
      "secrets.existingSecret=mine",
    );
    const ref = workerRef(sweep(docs));
    expect(ref?.name).not.toBe("mine");
    expect(workerRef(server(docs))).toEqual(ref);
    expect(
      written(docs, ref?.name ?? "", ref?.key ?? "")?.length,
    ).toBeGreaterThanOrEqual(32);
  });

  test("switched off, there is no sweep, no worker secret, and the server is given none", () => {
    const docs = render(
      ...values("vanilla"),
      "--set",
      "routines.enabled=false",
    );
    expect(sweep(docs)).toBeUndefined();
    expect(workerRef(server(docs))).toBeUndefined();
    expect(workerSecrets(docs)).toEqual([]);
  });
});

/*
 * Against a real API server, because `lookup` sees nothing under `helm template`: a generated worker
 * secret must be the same on the next upgrade (the server holds it from its last start and the next
 * sweep must present it), and a key in the operator's own Secret must be used rather than replaced.
 */
describe.skipIf(!helm || !kubeconfig)("routines against a cluster", () => {
  const namespace = `openbot-routines-${randomBytes(3).toString("hex")}`;
  const kubectl = (args: string[], stdin?: string) => {
    const result = Bun.spawnSync(
      ["kubectl", "--kubeconfig", kubeconfig ?? "", "-n", namespace, ...args],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(result.stderr));
    }
    return new TextDecoder().decode(result.stdout);
  };
  const renderLive = (...args: string[]) =>
    render(
      "--dry-run=server",
      "--kubeconfig",
      kubeconfig ?? "",
      "--namespace",
      namespace,
      ...values("vanilla"),
      ...args,
    );

  test("keeps a generated worker secret across upgrades, and uses one the operator's Secret holds", () => {
    Bun.spawnSync([
      "kubectl",
      "--kubeconfig",
      kubeconfig ?? "",
      "create",
      "namespace",
      namespace,
    ]);
    try {
      const first = renderLive();
      const ref = workerRef(sweep(first));
      const value = written(first, ref?.name ?? "", ref?.key ?? "");
      expect(value).toBeDefined();
      // What `helm install` would have created: the rendered Secret, owned by the release.
      const secret = first.find(
        (d) => d.kind === "Secret" && d.metadata.name === ref?.name,
      );
      kubectl(
        ["apply", "-f", "-"],
        JSON.stringify({
          ...secret,
          metadata: {
            ...secret?.metadata,
            annotations: {
              "meta.helm.sh/release-name": "openbot",
              "meta.helm.sh/release-namespace": namespace,
            },
          },
        }),
      );
      const upgrade = renderLive();
      expect(workerRef(sweep(upgrade))).toEqual(ref);
      expect(written(upgrade, ref?.name ?? "", ref?.key ?? "")).toBe(value);

      kubectl([
        "create",
        "secret",
        "generic",
        "mine",
        "--from-literal=worker-shared-secret=the-operators-own",
      ]);
      const own = renderLive("--set-string", "secrets.existingSecret=mine");
      expect(workerRef(sweep(own))).toEqual({
        name: "mine",
        key: "worker-shared-secret",
      });
      expect(workerRef(server(own))).toEqual(workerRef(sweep(own)));
      expect(workerSecrets(own)).toEqual([]);
    } finally {
      Bun.spawnSync([
        "kubectl",
        "--kubeconfig",
        kubeconfig ?? "",
        "delete",
        "namespace",
        namespace,
        "--wait=false",
      ]);
    }
  });
});
