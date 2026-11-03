/**
 * Can two organizations' releases of this chart share one cluster?
 *
 * Each organization gets its own release, in its own namespace, with its computers in a namespace of
 * their own. That is only safe while nothing one release writes can select, reach, overwrite or be
 * granted anything of the other's, and every way of breaking it is quiet: a selector missing the
 * release label, a policy written into the wrong namespace, a name that is not the release's. Each of
 * those renders perfectly and installs cleanly, so this renders the chart as two organizations and
 * compares them.
 *
 *     bun scripts/check-chart-tenancy.ts <ci-values.yaml> [--chart charts/openbot]
 *
 * Four renders: two organizations in namespaces of their own (the supported shape), the same two in
 * one namespace (which proves every name and selector is the release's rather than the namespace's),
 * and, for `computers.mode: sandbox`, a second release pointed at the first one's computers namespace,
 * which has to collide on the namespace's claim so Helm refuses it.
 */
import { parse, parseAllDocuments } from "yaml";

const args = process.argv.slice(2);
const valuesFile = args.find((arg) => !arg.startsWith("--"));
const chartFlag = args.indexOf("--chart");
const chart = chartFlag === -1 ? "charts/openbot" : args[chartFlag + 1];
if (!valuesFile || !chart) {
  console.error(
    "usage: bun scripts/check-chart-tenancy.ts <ci-values.yaml> [--chart charts/openbot]",
  );
  process.exit(2);
}

type Manifest = {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
  };
  // biome-ignore lint/suspicious/noExplicitAny: a rendered manifest is any Kubernetes object.
  spec?: any;
  data?: Record<string, string>;
};

type Org = {
  release: string;
  namespace: string;
  computersNamespace: string;
};

/** Kinds that have no namespace. A release writing one of these collides with every other release. */
const CLUSTER_SCOPED = new Set([
  "APIService",
  "ClusterIssuer",
  "ClusterRole",
  "ClusterRoleBinding",
  "ClusterSecretStore",
  "CSIDriver",
  "CustomResourceDefinition",
  "GatewayClass",
  "IngressClass",
  "MutatingWebhookConfiguration",
  "Namespace",
  "PersistentVolume",
  "PriorityClass",
  "RuntimeClass",
  "StorageClass",
  "ValidatingAdmissionPolicy",
  "ValidatingAdmissionPolicyBinding",
  "ValidatingWebhookConfiguration",
  "VolumeSnapshotClass",
]);

const INSTANCE = "app.kubernetes.io/instance";
const COMPONENT = "app.kubernetes.io/component";
const NAME = "app.kubernetes.io/name";
const NAMESPACE_NAME = "kubernetes.io/metadata.name";

const values = (parse(await Bun.file(valuesFile).text()) ?? {}) as {
  computers?: { mode?: string };
  networkPolicy?: { enabled?: boolean; ingressFrom?: unknown[] };
};
const sandbox = values.computers?.mode === "sandbox";
const policiesOn = values.networkPolicy?.enabled === true;
const ingressFromSet = (values.networkPolicy?.ingressFrom ?? []).length > 0;
const keyEncryptionKey = Buffer.from(
  crypto.getRandomValues(new Uint8Array(32)),
).toString("base64");

/** `helm template`, as one organization. */
function render(org: Org): { manifests: Manifest[]; error?: string } {
  const command = [
    "helm",
    "template",
    org.release,
    chart as string,
    "--namespace",
    org.namespace,
    "--values",
    valuesFile as string,
    "--set-string",
    `secrets.keyEncryptionKey=${keyEncryptionKey}`,
    "--api-versions",
    "agents.x-k8s.io/v1beta1/Sandbox",
    "--api-versions",
    "extensions.agents.x-k8s.io/v1beta1/SandboxTemplate",
  ];
  if (sandbox) {
    command.push(
      "--set-string",
      `computers.sandbox.namespace=${org.computersNamespace}`,
    );
  }
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    return {
      manifests: [],
      error: new TextDecoder().decode(result.stderr).trim(),
    };
  }
  const manifests = parseAllDocuments(new TextDecoder().decode(result.stdout))
    .map((document) => document.toJS() as Manifest | null)
    .filter((manifest): manifest is Manifest => Boolean(manifest?.kind));
  return { manifests };
}

/** The namespace an object lands in: its own, or the release's when it names none. */
function namespaceOf(manifest: Manifest, org: Org): string {
  return manifest.metadata?.namespace ?? org.namespace;
}

/** Where this release's pods of a component run. */
function expectedNamespace(component: string, org: Org): string {
  return component === "computer" && sandbox
    ? org.computersNamespace
    : org.namespace;
}

function identity(manifest: Manifest, org: Org): string {
  return `${manifest.kind}/${namespaceOf(manifest, org)}/${manifest.metadata?.name}`;
}

type Peer = {
  namespaceSelector?: { matchLabels?: Record<string, string> };
  podSelector?: { matchLabels?: Record<string, string> };
};

/** Every label selector this object uses to pick pods, with where it was found. */
function selectorsOf(
  manifest: Manifest,
): { where: string; labels: Record<string, string> }[] {
  const found: { where: string; labels: Record<string, string> }[] = [];
  const spec = manifest.spec ?? {};
  const add = (where: string, labels: unknown) => {
    if (labels && typeof labels === "object" && !Array.isArray(labels)) {
      found.push({ where, labels: labels as Record<string, string> });
    }
  };
  if (manifest.kind === "Service") add("spec.selector", spec.selector);
  if (
    ["Deployment", "StatefulSet", "PodDisruptionBudget"].includes(
      manifest.kind ?? "",
    )
  ) {
    add("spec.selector.matchLabels", spec.selector?.matchLabels);
  }
  const affinity = spec.template?.spec?.affinity?.podAntiAffinity;
  for (const term of [
    ...(affinity?.requiredDuringSchedulingIgnoredDuringExecution ?? []),
    ...(affinity?.preferredDuringSchedulingIgnoredDuringExecution ?? []).map(
      (preferred: { podAffinityTerm?: unknown }) => preferred.podAffinityTerm,
    ),
  ]) {
    add("podAntiAffinity", term?.labelSelector?.matchLabels);
  }
  if (manifest.kind === "NetworkPolicy") {
    add("spec.podSelector", spec.podSelector?.matchLabels);
    for (const [direction, rules] of [
      ["ingress", spec.ingress],
      ["egress", spec.egress],
    ] as const) {
      for (const rule of rules ?? []) {
        for (const peer of (direction === "ingress" ? rule.from : rule.to) ??
          []) {
          add(`${direction} peer`, (peer as Peer).podSelector?.matchLabels);
        }
      }
    }
  }
  return found;
}

/** The pod templates this chart creates computers from, wherever they live. */
function computerPodLabels(
  manifests: Manifest[],
  org: Org,
): { namespace: string; labels: Record<string, string> }[] {
  const pods: { namespace: string; labels: Record<string, string> }[] = [];
  for (const manifest of manifests) {
    if (
      manifest.kind === "StatefulSet" &&
      manifest.metadata?.labels?.[COMPONENT] === "computer"
    ) {
      pods.push({
        namespace: namespaceOf(manifest, org),
        labels: manifest.spec?.template?.metadata?.labels ?? {},
      });
    }
    const template = manifest.data?.["sandbox-template.json"];
    if (manifest.kind === "ConfigMap" && template) {
      const parsed = JSON.parse(template) as {
        podTemplate?: { metadata?: { labels?: Record<string, string> } };
      };
      // The server creates every Sandbox in the computers namespace it is told about.
      pods.push({
        namespace: org.computersNamespace,
        labels: parsed.podTemplate?.metadata?.labels ?? {},
      });
    }
  }
  return pods;
}

function matches(
  selector: Record<string, string>,
  labels: Record<string, string>,
): boolean {
  return Object.entries(selector).every(
    ([key, value]) => labels[key] === value,
  );
}

/** Every environment variable on every container, as name and value. */
function envOf(manifests: Manifest[]): { name: string; value?: string }[] {
  const env: { name: string; value?: string }[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
    } else if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (Array.isArray(record.env)) {
        for (const variable of record.env as { name: string; value?: string }[])
          env.push(variable);
      }
      for (const child of Object.values(record)) visit(child);
    }
  };
  visit(manifests);
  return env;
}

/** What one release, rendered on its own, must hold to. */
function checkOne(
  org: Org,
  other: Org,
  manifests: Manifest[],
  problems: string[],
) {
  const own = new Set([org.namespace, org.computersNamespace]);
  const theirs = new Set(
    [other.namespace, other.computersNamespace].filter((ns) => !own.has(ns)),
  );
  const say = (message: string) => problems.push(`${org.release}: ${message}`);

  for (const manifest of manifests) {
    const id = identity(manifest, org);
    if (CLUSTER_SCOPED.has(manifest.kind ?? "")) {
      say(
        `${manifest.kind}/${manifest.metadata?.name} is cluster-scoped, so every release would write the same one. Cluster-wide pieces are installed once per cluster, not per release.`,
      );
      continue;
    }
    const namespace = namespaceOf(manifest, org);
    if (!own.has(namespace)) {
      say(
        `${id} is written outside this release's namespaces (${[...own].join(", ")}).`,
      );
    }

    for (const { where, labels } of selectorsOf(manifest)) {
      const ours = NAME in labels || COMPONENT in labels;
      if (ours && labels[INSTANCE] !== org.release) {
        say(
          `${id} ${where} selects ${JSON.stringify(labels)} without ${INSTANCE}: ${org.release}, so it can pick another release's pods.`,
        );
      }
    }

    if (manifest.kind === "NetworkPolicy") {
      for (const [direction, rules] of [
        ["ingress", manifest.spec?.ingress],
        ["egress", manifest.spec?.egress],
      ] as const) {
        for (const rule of rules ?? []) {
          for (const peer of ((direction === "ingress" ? rule.from : rule.to) ??
            []) as Peer[]) {
            const named = peer.namespaceSelector?.matchLabels?.[NAMESPACE_NAME];
            if (named && theirs.has(named)) {
              say(
                `${id} ${direction} names ${other.release}'s namespace ${named}.`,
              );
            }
            // A peer naming one of this chart's components has to name the namespace it runs in:
            // with no namespace selector a peer means the policy's own namespace.
            const component = peer.podSelector?.matchLabels?.[COMPONENT];
            if (
              component &&
              peer.podSelector?.matchLabels?.[NAME] !== "postgresql"
            ) {
              const peerNamespace = peer.namespaceSelector ? named : namespace;
              const expected = expectedNamespace(component, org);
              if (peerNamespace !== expected) {
                say(
                  `${id} ${direction} looks for this release's ${component} in ${peerNamespace ?? "every namespace"}, but it runs in ${expected}.`,
                );
              }
            }
          }
        }
      }
    }

    if (manifest.kind === "RoleBinding") {
      for (const subject of manifest.spec?.subjects ??
        (manifest as unknown as { subjects?: unknown[] }).subjects ??
        []) {
        const { kind, namespace: subjectNamespace } = subject as {
          kind?: string;
          namespace?: string;
        };
        if (kind === "ServiceAccount" && subjectNamespace !== org.namespace) {
          say(
            `${id} grants a service account in ${subjectNamespace}, not in ${org.namespace}.`,
          );
        }
      }
    }
  }

  for (const variable of envOf(manifests)) {
    if (variable.name === "COMPUTER_SANDBOX_NAMESPACE") {
      if (variable.value !== org.computersNamespace) {
        say(
          `COMPUTER_SANDBOX_NAMESPACE is ${variable.value}, not ${org.computersNamespace}.`,
        );
      }
    }
  }

  // Every computer this release creates is fenced where it runs, when policies are on.
  if (policiesOn) {
    const policies = manifests.filter((m) => m.kind === "NetworkPolicy");
    for (const pod of computerPodLabels(manifests, org)) {
      const fenced = policies.some(
        (policy) =>
          namespaceOf(policy, org) === pod.namespace &&
          matches(policy.spec?.podSelector?.matchLabels ?? {}, pod.labels),
      );
      if (!fenced) {
        say(
          `no NetworkPolicy in ${pod.namespace} selects this release's computers (${JSON.stringify(pod.labels)}), so any pod in the cluster can reach them.`,
        );
      }
    }
    if (ingressFromSet) {
      const server = policies.find(
        (policy) =>
          policy.spec?.podSelector?.matchLabels?.[COMPONENT] === "server",
      );
      for (const rule of server?.spec?.ingress ?? []) {
        if (!rule.from || rule.from.length === 0) {
          say(
            "the API's network policy admits every pod on its port although networkPolicy.ingressFrom names who may.",
          );
        }
      }
    }
  }

  if (sandbox) {
    const claim = manifests.find(
      (manifest) =>
        manifest.kind === "ConfigMap" &&
        namespaceOf(manifest, org) === org.computersNamespace &&
        manifest.data?.release === org.release,
    );
    if (!claim) {
      say(
        `nothing claims ${org.computersNamespace} for this release, so a second release could be installed into it.`,
      );
    }
  }
}

/** What two releases rendered together must hold to: no object written twice. */
function collisions(
  a: { org: Org; manifests: Manifest[] },
  b: { org: Org; manifests: Manifest[] },
): string[] {
  const ids = new Set(a.manifests.map((manifest) => identity(manifest, a.org)));
  return b.manifests
    .map((manifest) => identity(manifest, b.org))
    .filter((id) => ids.has(id));
}

const problems: string[] = [];
const orgA: Org = {
  release: "org-a",
  namespace: "org-a",
  computersNamespace: sandbox ? "org-a-computers" : "org-a",
};
const orgB: Org = {
  release: "org-b",
  namespace: "org-b",
  computersNamespace: sandbox ? "org-b-computers" : "org-b",
};

function renderOrFail(org: Org): Manifest[] {
  const { manifests, error } = render(org);
  if (error) {
    console.error(`::error::${org.release} did not render:\n${error}`);
    process.exit(1);
  }
  if (manifests.length === 0) {
    console.error(`::error::${org.release} rendered nothing.`);
    process.exit(1);
  }
  return manifests;
}

// 1. The supported shape: a namespace each, and a computers namespace each.
const a = renderOrFail(orgA);
const b = renderOrFail(orgB);
checkOne(orgA, orgB, a, problems);
checkOne(orgB, orgA, b, problems);
for (const id of collisions(
  { org: orgA, manifests: a },
  { org: orgB, manifests: b },
)) {
  problems.push(`both releases write ${id}.`);
}

// 2. One namespace for both, which only works if every name and selector is the release's own.
const sharedA: Org = { ...orgA, namespace: "openbot" };
const sharedB: Org = { ...orgB, namespace: "openbot" };
if (!sandbox) {
  sharedA.computersNamespace = "openbot";
  sharedB.computersNamespace = "openbot";
}
const inOneA = renderOrFail(sharedA);
const inOneB = renderOrFail(sharedB);
for (const id of collisions(
  { org: sharedA, manifests: inOneA },
  { org: sharedB, manifests: inOneB },
)) {
  problems.push(
    `in one namespace, both releases write ${id}: its name is not the release's.`,
  );
}

// 3. A second release pointed at the first one's computers: Helm must refuse it on the claim.
if (sandbox) {
  const intruder: Org = {
    release: "org-b",
    namespace: "org-b",
    computersNamespace: orgA.computersNamespace,
  };
  const clash = collisions(
    { org: orgA, manifests: a },
    { org: intruder, manifests: renderOrFail(intruder) },
  );
  if (
    !clash.some((id) => id.startsWith(`ConfigMap/${orgA.computersNamespace}/`))
  ) {
    problems.push(
      `a second release in ${orgA.computersNamespace} writes nothing the first one already owns, so Helm would install it and the two would manage each other's computers.`,
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log(
  `Two organizations render side by side from ${valuesFile} with nothing shared: ${a.length} and ${b.length} objects, ${sandbox ? "computers in a namespace each" : "computers beside each server"}${policiesOn ? ", every computer fenced where it runs" : ""}.`,
);
