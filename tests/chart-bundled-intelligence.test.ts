/**
 * The chart installing Intelligence with OpenBot, wired by itself: rendered by real Helm from the
 * real chart and its real Intelligence dependency.
 *
 * What must not regress, because each of these fails silently on a cluster rather than at install:
 *  - the server's Intelligence addresses are the Services the Intelligence chart actually renders;
 *  - the runtime key the server reads is the Secret the key Job writes, and the Job's service token is
 *    the one Intelligence's API mounts, for an organization Intelligence's bootstrap creates;
 *  - the licence, given once, reaches OpenBot's server and Intelligence's API;
 *  - OpenBot's bundled PostgreSQL and Intelligence's never render as the same object, and
 *    Intelligence's database URL names its own database with the password that database is given;
 *  - `intelligence.enabled: false` renders today's chart: no Intelligence, the addresses and key the
 *    operator named, and no gateway proxy;
 *  - Automatic Learning is on in the bundled Intelligence, as it is in OpenBot: its agent, scheduler
 *    and object store render, every Secret they read is one the chart writes with the key they ask
 *    for, and every client of the store reaches the store's pod, whatever the release is called;
 *  - the Job that installs Learning's queue waits out the restart of Intelligence's database an
 *    upgrade causes for as long as OpenBot's own migrations wait.
 */
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parse, parseAllDocuments } from "yaml";
import {
  dependencyKeys,
  underDependency,
  withoutChartDefault,
} from "../scripts/chart-reuse-values";

const helm = Bun.which("helm") !== null;
const chart = join(import.meta.dir, "../charts/openbot");
const LICENCE = "licence-given-once";

type Doc = {
  kind: string;
  metadata: { name: string; labels?: Record<string, string> };
  spec?: {
    template?: {
      spec: {
        containers: { name: string; env?: EnvVar[] }[];
        volumes?: { secret?: { secretName: string } }[];
      };
    };
    ports?: { port: number }[];
  };
  data?: Record<string, string>;
  stringData?: Record<string, string>;
};
type EnvVar = {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef?: { name: string; key: string };
    configMapKeyRef?: { name: string; key: string };
  };
};

function render(...args: string[]): Doc[] {
  return renderChart(chart, ...args);
}

function renderChart(from: string, ...args: string[]): Doc[] {
  const result = Bun.spawnSync(
    [
      "helm",
      "template",
      "openbot",
      from,
      "--namespace",
      "openbot",
      "--set-string",
      `secrets.keyEncryptionKey=${randomBytes(32).toString("base64")}`,
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

function refusal(...args: string[]): string {
  try {
    render(...args);
  } catch (error) {
    return String(error);
  }
  return "";
}

const vanilla = [
  "--values",
  join(chart, "ci/vanilla-values.yaml"),
  "--set-string",
  `secrets.licenseToken=${LICENCE}`,
];

function find(docs: Doc[], kind: string, name: string): Doc {
  const doc = docs.find((d) => d.kind === kind && d.metadata.name === name);
  if (!doc) throw new Error(`no ${kind} ${name} in the render`);
  return doc;
}

function workload(
  docs: Doc[],
  kind: string,
  predicate: (doc: Doc) => boolean,
): Doc {
  const doc = docs.find((d) => d.kind === kind && predicate(d));
  if (!doc) throw new Error(`no matching ${kind} in the render`);
  return doc;
}

const component = (name: string) => (doc: Doc) =>
  doc.metadata.labels?.["app.kubernetes.io/component"] === name;

function containerEnv(doc: Doc, container?: string): EnvVar[] {
  const containers = doc.spec?.template?.spec.containers ?? [];
  const chosen = container
    ? containers.find((c) => c.name === container)
    : containers[0];
  return chosen?.env ?? [];
}

function envValue(env: EnvVar[], name: string): string | undefined {
  return env.find((e) => e.name === name)?.value;
}

function envSecret(env: EnvVar[], name: string) {
  return env.find((e) => e.name === name)?.valueFrom?.secretKeyRef;
}

function secretValue(
  docs: Doc[],
  name: string,
  key: string,
): string | undefined {
  const secret = find(docs, "Secret", name);
  if (secret.stringData?.[key] !== undefined) return secret.stringData[key];
  const raw = secret.data?.[key];
  return raw === undefined
    ? undefined
    : Buffer.from(raw, "base64").toString("utf8");
}

/** host:port of a ws/http URL, and the Service it should be. */
function serviceOf(docs: Doc[], url: string) {
  const { hostname, port } = new URL(url);
  const service = find(docs, "Service", hostname);
  const ports = (service.spec?.ports ?? []).map((p) => p.port);
  return { service, port: Number(port), ports };
}

describe.skipIf(!helm)("the chart with the bundled Intelligence", () => {
  test("points the server at the Services the Intelligence chart renders, and carries the browser's gateway socket", () => {
    const docs = render(...vanilla);
    const server = workload(docs, "Deployment", component("server"));
    const env = containerEnv(server);

    const api = envValue(env, "INTELLIGENCE_API_URL") ?? "";
    const gateway = envValue(env, "INTELLIGENCE_GATEWAY_WS_URL") ?? "";
    const apiService = serviceOf(docs, api);
    const gatewayService = serviceOf(docs, gateway);
    expect(
      apiService.service.metadata.labels?.["app.kubernetes.io/component"],
    ).toBe("app-api");
    expect(apiService.ports).toContain(apiService.port);
    expect(
      gatewayService.service.metadata.labels?.["app.kubernetes.io/component"],
    ).toBe("realtime-gateway");
    expect(gatewayService.ports).toContain(gatewayService.port);
    expect(new URL(gateway).protocol).toBe("ws:");

    // The browser reaches the gateway through the server, since nothing else of Intelligence's is
    // reachable from outside the cluster.
    expect(envValue(env, "INTELLIGENCE_GATEWAY_PROXY")).toBe("on");
    expect(
      envValue(env, "INTELLIGENCE_BROWSER_GATEWAY_WS_URL"),
    ).toBeUndefined();
  });

  test("generates OpenBot's runtime key once, and the server and Intelligence's bootstrap read that one Secret", () => {
    const docs = render(...vanilla);
    const server = workload(docs, "Deployment", component("server"));
    const bootstrap = workload(docs, "Job", component("bootstrap"));

    const key = envSecret(containerEnv(server), "INTELLIGENCE_API_KEY");
    const value = secretValue(docs, key?.name ?? "", key?.key ?? "") ?? "";
    // The shape Intelligence's bootstrap accepts (app-db-migrations/bootstrap-self-hosted.sh), with
    // the short and long tokens its API splits the key into on every request.
    expect(value).toMatch(
      /^cpk(-[A-Za-z0-9-]*)?_[A-Za-z0-9]{8,64}_[A-Za-z0-9]{24,256}$/,
    );

    // Intelligence's bootstrap reads the same Secret and key for OpenBot's project, in OpenBot's
    // organization, with the container Automatic Learning assigns.
    const fromBootstrap = (containerEnv(bootstrap) ?? []).filter((e) =>
      /^BOOTSTRAP_PROJECT_\d+_API_KEY$/.test(e.name),
    );
    expect(fromBootstrap.map((e) => e.valueFrom?.secretKeyRef)).toEqual([
      { name: key?.name ?? "", key: key?.key ?? "" },
    ]);
    const config = JSON.parse(
      Buffer.from(
        envValue(containerEnv(bootstrap), "BOOTSTRAP_CONFIG_B64") ?? "",
        "base64",
      ).toString("utf8"),
    ) as {
      organizations: { slug: string }[];
      projects: {
        organizationSlug: string;
        apiKey?: { existingSecret: string; key: string };
        learningContainers?: { id: string }[];
      }[];
    };
    const project = config.projects.find(
      (p) => p.apiKey?.existingSecret === key?.name,
    );
    expect(config.organizations.map((o) => o.slug)).toContain(
      project?.organizationSlug,
    );
    expect(project?.learningContainers?.map((c) => c.id)).toContain("openbot");

    // No Job of OpenBot's makes the key, so none of its pods is allowed to write a Secret.
    const ownRoles = docs.filter(
      (d) =>
        (d.kind === "Role" || d.kind === "RoleBinding") &&
        d.metadata.labels?.["app.kubernetes.io/name"] === "openbot",
    );
    expect(ownRoles.map((d) => d.metadata.name)).toEqual([]);
  });

  test("hands the licence, given once, to OpenBot's server and to Intelligence's API", () => {
    const docs = render(...vanilla);
    const server = workload(docs, "Deployment", component("server"));
    const appApi = workload(docs, "Deployment", component("app-api"));
    const openbotSide = envSecret(
      containerEnv(server),
      "COPILOTKIT_LICENSE_TOKEN",
    );
    const intelligenceSide = envSecret(
      containerEnv(appApi),
      "COPILOTKIT_LICENSE_TOKEN",
    );
    expect(
      secretValue(docs, openbotSide?.name ?? "", openbotSide?.key ?? ""),
    ).toBe(LICENCE);
    expect(
      secretValue(
        docs,
        intelligenceSide?.name ?? "",
        intelligenceSide?.key ?? "",
      ),
    ).toBe(LICENCE);
  });

  test("with the licence in a Secret of the operator's, both sides read that one Secret", () => {
    const docs = render(
      "--set",
      "config.singleUser=true",
      "--set",
      "postgresql.enabled=true",
      "--set-string",
      "postgresql.auth.existingSecret=openbot",
      "--set-string",
      "secrets.existingSecret=openbot",
      "--set-string",
      "intelligence.appApi.licenseSecret.existingSecret=openbot",
    );
    const server = workload(docs, "Deployment", component("server"));
    const appApi = workload(docs, "Deployment", component("app-api"));
    expect(
      envSecret(containerEnv(server), "COPILOTKIT_LICENSE_TOKEN"),
    ).toMatchObject({ name: "openbot", key: "license-token" });
    expect(envSecret(containerEnv(appApi), "COPILOTKIT_LICENSE_TOKEN")).toEqual(
      { name: "openbot", key: "license-token" },
    );
  });

  test("keeps OpenBot's database and Intelligence's apart, and gives Intelligence the URL of its own", () => {
    const docs = render(...vanilla);
    const names = docs.map((d) => `${d.kind}/${d.metadata.name}`);
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);

    const databases = docs.filter(
      (d) =>
        d.kind === "StatefulSet" &&
        (d.spec?.template?.spec.containers ?? []).some(
          (c) => c.name === "postgresql",
        ),
    );
    expect(databases).toHaveLength(2);

    const appApi = workload(docs, "Deployment", component("app-api"));
    const ref = envSecret(containerEnv(appApi), "DATABASE_URL");
    const url = new URL(
      secretValue(docs, ref?.name ?? "", ref?.key ?? "") ?? "",
    );
    const intelligenceDb = find(docs, "Service", url.hostname);
    const openbotServer = workload(docs, "Deployment", component("server"));
    const openbotDbUrl =
      envValue(containerEnv(openbotServer), "DATABASE_URL") ?? "";
    expect(openbotDbUrl).not.toContain(`@${url.hostname}:`);
    expect(intelligenceDb.metadata.name).not.toBe("openbot-postgresql");
    // The password in the URL is the one Bitnami initializes that database with.
    expect(decodeURIComponent(url.password)).toBe(
      secretValue(docs, ref?.name ?? "", "postgres-password"),
    );
  });

  test("refuses an Intelligence address of your own beside the bundled one, a missing licence, and a release from before it", () => {
    expect(
      refusal(
        ...vanilla,
        "--set-string",
        "config.intelligence.apiUrl=https://api.intelligence.copilotkit.ai",
      ),
    ).toContain("this chart installs one too");
    expect(
      refusal(...vanilla, "--set-string", "secrets.licenseToken="),
    ).toContain("needs the CopilotKit licence");
    expect(refusal(...vanilla, "--set", "intelligence=null")).toContain(
      "no `intelligence` key",
    );
  });
});

type Container = {
  name: string;
  env?: EnvVar[];
  envFrom?: { configMapRef?: { name: string }; secretRef?: { name: string } }[];
};
type PodSpec = { containers: Container[]; initContainers?: Container[] };
type Workload = {
  kind: string;
  metadata: { name: string; labels?: Record<string, string> };
  spec?: {
    selector?:
      | Record<string, string>
      | { matchLabels?: Record<string, string> };
    ports?: { port: number; targetPort?: string | number; name?: string }[];
    template?: {
      metadata?: { labels?: Record<string, string> };
      spec: PodSpec;
    };
    jobTemplate?: { spec: { template: { spec: PodSpec } } };
  };
  data?: Record<string, string>;
};

/** A workload's own container: the first, not an init container. */
function mainContainer(doc: Doc): Container {
  const container = (doc as Workload).spec?.template?.spec.containers[0];
  if (!container) throw new Error(`${doc.metadata.name} has no container`);
  return container;
}

/** Every container of a Deployment, StatefulSet, Job or CronJob. */
function containersOf(doc: Workload): Container[] {
  const pod =
    doc.spec?.template?.spec ?? doc.spec?.jobTemplate?.spec.template.spec;
  return [...(pod?.initContainers ?? []), ...(pod?.containers ?? [])];
}

const WORKLOADS = new Set(["Deployment", "StatefulSet", "Job", "CronJob"]);
const MODEL_KEY = "the-customers-model-key";
const learningVanilla = [
  ...vanilla,
  "--set-string",
  `secrets.modelApiKey=${MODEL_KEY}`,
];

/** A variable's value as the container sees it: written in, or read from a ConfigMap. */
function configValue(docs: Doc[], container: Container, name: string) {
  const variable = container.env?.find((e) => e.name === name);
  const mapData = (mapName: string | undefined) =>
    (
      docs.find((d) => d.kind === "ConfigMap" && d.metadata.name === mapName) as
        | Workload
        | undefined
    )?.data;
  if (variable?.value !== undefined) return variable.value;
  const ref = variable?.valueFrom?.configMapKeyRef;
  if (ref) return mapData(ref.name)?.[ref.key];
  for (const from of container.envFrom ?? []) {
    const value = mapData(from.configMapRef?.name)?.[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

describe.skipIf(!helm)("Automatic Learning in the bundled Intelligence", () => {
  test("is on, with its agent on the customer's model key and the scheduler", () => {
    const docs = render(...learningVanilla);
    const appApi = mainContainer(
      workload(docs, "Deployment", component("app-api")),
    );
    expect(configValue(docs, appApi, "LEARNING_RUNTIME_ENABLED")).toBe("true");
    // The self-hosted rollout gate, which closes before the licence is read.
    expect(configValue(docs, appApi, "LEARNING_ENABLED")).toBe("true");
    expect(configValue(docs, appApi, "LEARNING_AUTOMATION_ENABLED")).toBe(
      "true",
    );
    // The model reaches the agent from its Secret, below, so Intelligence's own `learning.agent.model`
    // is empty and this reads false. Intelligence reads it only under a local evaluation licence,
    // which starts only on the CopilotKit CLI's own k3d install and never under this chart.
    expect(configValue(docs, appApi, "APP_API_LEARNING_MODEL_CONFIGURED")).toBe(
      "false",
    );
    const agent = mainContainer(
      workload(docs, "Deployment", component("learning-agent")),
    );
    expect(
      agent.env?.filter((e) => e.name === "LEARNING_AGENT_MODEL"),
    ).toHaveLength(1);
    const model = envSecret(agent.env ?? [], "LEARNING_AGENT_MODEL");
    expect(secretValue(docs, model?.name ?? "", model?.key ?? "")).toBe(
      "openai/gpt-5.5",
    );
    const key = envSecret(agent.env ?? [], "OPENAI_API_KEY");
    expect(secretValue(docs, key?.name ?? "", key?.key ?? "")).toBe(MODEL_KEY);
    const token = envSecret(agent.env ?? [], "LEARNING_AGENT_TOKEN");
    expect(
      secretValue(docs, token?.name ?? "", token?.key ?? "")?.length,
    ).toBeGreaterThanOrEqual(32);

    expect(
      docs.some(
        (d) => d.kind === "CronJob" && component("learning-scheduler")(d),
      ),
    ).toBe(true);
    expect(
      docs.some(
        (d) => d.kind === "Deployment" && component("learning-reconciler")(d),
      ),
    ).toBe(true);
  });

  test("every Secret a bundled workload reads, by reference or by name, is one the chart writes with that key", () => {
    const docs = render(...learningVanilla);
    const missing: string[] = [];
    const check = (where: string, name: string, key: string) => {
      if (secretValue(docs, name, key) === undefined)
        missing.push(`${where} reads ${name}/${key}`);
    };
    for (const doc of docs as Workload[]) {
      if (!WORKLOADS.has(doc.kind)) continue;
      for (const container of containersOf(doc)) {
        const where = `${doc.kind} ${doc.metadata.name} (${container.name})`;
        const env = container.env ?? [];
        for (const variable of env) {
          const ref = variable.valueFrom?.secretKeyRef as
            | { name: string; key: string; optional?: boolean }
            | undefined;
          // An optional one is the workload saying it runs without it; the test below covers it.
          if (ref && !ref.optional) check(where, ref.name, ref.key);
        }
        // The Learning reconciler hands its runner Jobs Secrets by name, as pairs of variables.
        for (const variable of env) {
          const match = /^(LEARNING_[A-Z_]+)_SECRET_NAME$/.exec(variable.name);
          if (!match || !variable.value) continue;
          const keyVariables = env.filter(
            (other) =>
              other.name.startsWith(`${match[1]}_`) &&
              other.name !== variable.name &&
              /_(SECRET_KEY|ACCESS_KEY)$/.test(other.name),
          );
          for (const keyVariable of keyVariables)
            check(where, variable.value, keyVariable.value ?? "");
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("every client of the object store reaches the store's pod, under any release name", () => {
    for (const release of ["openbot", "ci"]) {
      const result = Bun.spawnSync(
        [
          "helm",
          "template",
          release,
          chart,
          "--namespace",
          "openbot",
          "--set-string",
          `secrets.keyEncryptionKey=${randomBytes(32).toString("base64")}`,
          ...learningVanilla,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(new TextDecoder().decode(result.stderr)).toBe("");
      const docs = parseAllDocuments(new TextDecoder().decode(result.stdout))
        .map((document) => document.toJSON() as Workload | null)
        .filter((document): document is Workload => document !== null);
      const store = docs.find(
        (d) =>
          d.kind === "StatefulSet" &&
          d.metadata.name.endsWith("-local-object-storage"),
      );
      const podLabels = store?.spec?.template?.metadata?.labels ?? {};
      const endpoints = new Set<string>();
      for (const doc of docs) {
        if (doc.kind === "ConfigMap" && doc.data?.S3_ENDPOINT)
          endpoints.add(doc.data.S3_ENDPOINT);
        if (!WORKLOADS.has(doc.kind)) continue;
        for (const container of containersOf(doc)) {
          const value = container.env?.find(
            (e) => e.name === "S3_ENDPOINT",
          )?.value;
          if (value !== undefined) endpoints.add(value);
        }
      }
      // app-api, the gateway, the Learning runners' ConfigMap and the bucket Job all have one.
      expect(endpoints.size).toBe(1);
      const endpoint = new URL([...endpoints][0] ?? "");
      const service = docs.find(
        (d) => d.kind === "Service" && d.metadata.name === endpoint.hostname,
      );
      expect(service).toBeDefined();
      const selector = (service?.spec?.selector ?? {}) as Record<
        string,
        string
      >;
      expect(Object.keys(selector).length).toBeGreaterThan(0);
      for (const [label, value] of Object.entries(selector))
        expect(podLabels[label]).toBe(value);
      expect(service?.spec?.ports?.map((p) => p.port)).toContain(
        Number(endpoint.port),
      );
      expect(service?.spec?.ports?.[0]?.targetPort).toBe("s3");
    }
  });

  test("turns Trajectories on in both Intelligence services that decide it, together", () => {
    const docs = render(...learningVanilla);
    for (const name of ["app-api", "realtime-gateway"]) {
      const container = mainContainer(
        workload(docs, "Deployment", component(name)),
      );
      expect(configValue(docs, container, "FF_LEARNING_TRAJECTORIES")).toBe(
        "true",
      );
    }
    // Learning's runners take it too, from their ConfigMap.
    const runtime = docs.find(
      (d) =>
        d.kind === "ConfigMap" && d.metadata.name.endsWith("-learning-runtime"),
    ) as Workload | undefined;
    expect(runtime?.data?.FF_LEARNING_TRAJECTORIES).toBe("true");
    // The gateway asks the API about a Trajectory with a token Intelligence's chart generates.
    const gateway = mainContainer(
      workload(docs, "Deployment", component("realtime-gateway")),
    );
    const token = envSecret(
      gateway.env ?? [],
      "REALTIME_GATEWAY_APP_API_INTERNAL_TOKEN",
    );
    expect(
      secretValue(docs, token?.name ?? "", token?.key ?? "")?.length,
    ).toBeGreaterThanOrEqual(32);
  });

  /*
   * An upgrade that moves the bundled Intelligence moves its PostgreSQL's image too, so the database
   * pod is replaced while the upgrade applies. The Job that installs Learning's queue is applied in
   * the same step, not as a hook before it, and waits for that database inside its own deadline.
   * On Intelligence's 300 seconds, an in-place upgrade from 0.16.0-rc.5 failed with the Job's
   * DeadlineExceeded while the new database pod came up, and reported UPGRADE FAILED.
   */
  test("gives the Job that installs Learning's queue as long to wait out a database restart as OpenBot's own migrations", () => {
    const docs = render(...learningVanilla);
    const queue = workload(
      docs,
      "Job",
      component("learning-queue-migration"),
    ) as Doc & {
      metadata: { annotations?: Record<string, string> };
      spec: { activeDeadlineSeconds?: number };
    };
    const migrations = docs.find(
      (d) =>
        d.kind === "Job" &&
        d.metadata.labels?.["app.kubernetes.io/name"] === "openbot" &&
        component("migrations")(d),
    ) as (Doc & { spec: { activeDeadlineSeconds?: number } }) | undefined;

    // Not a hook: it runs beside the database's restart, not before it.
    expect(queue.metadata.annotations?.["helm.sh/hook"]).toBeUndefined();
    expect(
      (queue as Workload).spec?.template?.spec.initContainers?.map(
        (c) => c.name,
      ),
    ).toContain("wait-for-database");
    expect(migrations?.spec.activeDeadlineSeconds).toBe(900);
    expect(queue.spec.activeDeadlineSeconds).toBe(
      migrations?.spec.activeDeadlineSeconds,
    );
  });

  /*
   * A release from before that key, upgraded with --reuse-values, has no `intelligence.learning.queue`
   * of this chart's, and still has the Intelligence chart's own beneath it. The new-values-key check
   * once nulled the key to stand for that, which deleted Intelligence's default too, failed the
   * render, and refused a change that upgrades cleanly.
   */
  test("a release from before the queue Job's ceiling, upgraded with --reuse-values, renders it on Intelligence's own", async () => {
    const dependencies = dependencyKeys(
      await Bun.file(join(chart, "Chart.yaml")).text(),
    );
    expect(underDependency("intelligence.learning.queue", dependencies)).toBe(
      true,
    );
    expect(underDependency("intelligence", dependencies)).toBe(false);
    expect(underDependency("config.handoff", dependencies)).toBe(false);

    const [packaged] = Array.from(
      new Bun.Glob("intelligence-*.tgz").scanSync(join(chart, "charts")),
    );
    const shown = Bun.spawnSync(
      ["helm", "show", "values", join(chart, "charts", packaged ?? "")],
      { stdout: "pipe", stderr: "pipe" },
    );
    const own = (
      parse(new TextDecoder().decode(shown.stdout)) as {
        learning: { queue: { migration: { activeDeadlineSeconds: number } } };
      }
    ).learning.queue.migration.activeDeadlineSeconds;
    expect(own).toBeGreaterThan(0);

    const docs = await withoutChartDefault(
      chart,
      "intelligence.learning.queue",
      (copy) => renderChart(copy, ...learningVanilla),
    );
    const queue = workload(
      docs,
      "Job",
      component("learning-queue-migration"),
    ) as Doc & { spec: { activeDeadlineSeconds?: number } };
    expect(queue.spec.activeDeadlineSeconds).toBe(own);
  });

  test("with no model key the install still renders, and Learning's agent finds none rather than a placeholder", () => {
    const docs = render(...vanilla, "--set-string", "secrets.modelApiKey=");
    const agent = mainContainer(
      workload(docs, "Deployment", component("learning-agent")),
    );
    const key = agent.env?.find((e) => e.name === "OPENAI_API_KEY")?.valueFrom
      ?.secretKeyRef as
      | { name: string; key: string; optional?: boolean }
      | undefined;
    expect(key?.optional).toBe(true);
    expect(secretValue(docs, key?.name ?? "", key?.key ?? "")).toBeUndefined();
  });
});

describe.skipIf(!helm)("the chart with intelligence.enabled=false", () => {
  test("renders no Intelligence and uses the Intelligence the operator named", () => {
    const docs = render("--values", join(chart, "ci/eks-values.yaml"));
    expect(
      docs.some(
        (d) => d.metadata.labels?.["app.kubernetes.io/name"] === "intelligence",
      ),
    ).toBe(false);
    expect(
      docs.some((d) => d.kind === "Job" && component("intelligence-key")(d)),
    ).toBe(false);
    expect(docs.some((d) => d.metadata.name.startsWith("openbot-intel-"))).toBe(
      false,
    );

    const env = containerEnv(workload(docs, "Deployment", component("server")));
    expect(envValue(env, "INTELLIGENCE_API_URL")).toBe(
      "https://api.intelligence.copilotkit.ai",
    );
    expect(envValue(env, "INTELLIGENCE_GATEWAY_WS_URL")).toBe(
      "wss://realtime.intelligence.copilotkit.ai",
    );
    expect(envSecret(env, "INTELLIGENCE_API_KEY")).toEqual({
      name: "openbot-secrets",
      key: "intelligence-api-key",
    });
    expect(envValue(env, "INTELLIGENCE_GATEWAY_PROXY")).toBeUndefined();
  });
});
