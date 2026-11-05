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
 *    operator named, and no gateway proxy.
 */
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

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
  valueFrom?: { secretKeyRef?: { name: string; key: string } };
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

  test("gives the server the key the key Job writes, made with the token Intelligence's API mounts, for an organization Intelligence creates", () => {
    const docs = render(...vanilla);
    const server = workload(docs, "Deployment", component("server"));
    const job = workload(docs, "Job", component("intelligence-key"));
    const jobEnv = containerEnv(job);
    const appApi = workload(docs, "Deployment", component("app-api"));

    const key = envSecret(containerEnv(server), "INTELLIGENCE_API_KEY");
    expect(key?.name).toBe(envValue(jobEnv, "INTELLIGENCE_KEY_SECRET"));
    expect(key?.key).toBe("intelligence-api-key");
    // Written by the Job, never by Helm: a rendered copy would be put back empty on every upgrade.
    expect(
      docs.some((d) => d.kind === "Secret" && d.metadata.name === key?.name),
    ).toBe(false);
    expect(envValue(jobEnv, "INTELLIGENCE_API_URL")).toBe(
      envValue(containerEnv(server), "INTELLIGENCE_API_URL"),
    );

    // The Job may write that one Secret and create it, and nothing else.
    const role = workload(
      docs,
      "Role",
      component("intelligence-key"),
    ) as Doc & {
      rules: {
        resources: string[];
        resourceNames?: string[];
        verbs: string[];
      }[];
    };
    expect(role.rules).toEqual([
      {
        apiGroups: [""],
        resources: ["secrets"],
        resourceNames: [key?.name ?? ""],
        verbs: ["get", "update"],
      },
      { apiGroups: [""], resources: ["secrets"], verbs: ["create"] },
    ] as never);

    // The service token: the Job's is the Secret Intelligence's API mounts, and it is generated.
    const token = envSecret(jobEnv, "INTELLIGENCE_SERVICE_TOKEN");
    const mounted = (appApi.spec?.template?.spec.volumes ?? [])
      .map((v) => v.secret?.secretName)
      .filter(Boolean);
    expect(mounted).toContain(token?.name);
    expect(
      secretValue(docs, token?.name ?? "", token?.key ?? "")?.length,
    ).toBeGreaterThanOrEqual(43);

    // For the organization Intelligence's own bootstrap creates, by the id it creates it with.
    const bootstrap = workload(docs, "Job", component("bootstrap"));
    const config = JSON.parse(
      Buffer.from(
        envValue(containerEnv(bootstrap), "BOOTSTRAP_CONFIG_B64") ?? "",
        "base64",
      ).toString("utf8"),
    ) as { organizations: { id?: string; slug: string }[] };
    expect(config.organizations.map((o) => o.id)).toContain(
      envValue(jobEnv, "INTELLIGENCE_ORGANIZATION_ID"),
    );
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
