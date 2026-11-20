/**
 * Self-serve enrollment on a real cluster: the `openbot-agent` chart installed with no install id
 * and no certificate, only `enrollment.serverUrl` (plus where this test's services listen, and
 * their test CA and signing key):
 *
 *  1. the agent proves itself to OpenBot's internal status port with its projected service account
 *     token, which the stand-in checks against the cluster's own keys (/openid/v1/jwks), collects
 *     the enrollment token, sends the enrollment API a request for its own key, writes the
 *     certificate and key to its Secret, and heartbeats over mutual TLS with them;
 *  2. a pod under another service account, with the same audience, is refused the token;
 *  3. the agent's RBAC reaches that one Secret by name, and no other;
 *  4. a restart reads the Secret and enrolls nothing;
 *  5. no log line of the agent holds the token, the key or the certificate.
 *
 * The stand-ins (fake-enrollment.ts, fake-management-service.ts) answer as the contract says the
 * real services do. Opt-in, on a throwaway kind cluster:
 *
 *   OPENBOT_AGENT_E2E_KUBECONFIG=~/.kube/config   cluster to use (namespaces openbot-system, openbot)
 *   OPENBOT_AGENT_E2E_CHART=/path/to/charts/openbot-agent
 *   OPENBOT_AGENT_E2E_IMAGE=openbot-management-agent:e2e   loaded into the cluster
 *   OPENBOT_AGENT_E2E_HOST=172.18.0.1        this machine as the cluster reaches it
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENROLLMENT_TOKEN_AUDIENCE } from "../../shared/management-contract";
import { FakeEnrollmentService, FakeOpenBotInternal } from "./fake-enrollment";
import {
  commonName,
  FakeManagementService,
  makePki,
  type TestPki,
} from "./fake-management-service";

setDefaultTimeout(1_800_000);
const env = process.env;
const kubeconfig = env.OPENBOT_AGENT_E2E_KUBECONFIG;
const installId = "7a3c9e14-2b6d-4f81-a0c5-9e8d7b6a5f43";
const SYSTEM = "openbot-system";
const PRODUCT = "openbot";
const SECRET = "openbot-agent-credentials";
const AGENT = `system:serviceaccount:${SYSTEM}:openbot-agent`;

function sh(command: string, args: string[], input?: string) {
  return execFileSync(command, args, {
    encoding: "utf8",
    input,
    env: { ...env, KUBECONFIG: kubeconfig },
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}
const kubectl = (...args: string[]) => sh("kubectl", args);
const apply = (object: unknown) =>
  sh("kubectl", ["apply", "-f", "-"], JSON.stringify(object));
async function shAsync(command: string, args: string[]) {
  const child = Bun.spawn([command, ...args], {
    env: { ...env, KUBECONFIG: kubeconfig },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}
async function until<T>(
  what: string,
  check: () => T | undefined | false | Promise<T | undefined | false>,
  minutes = 10,
) {
  const deadline = Date.now() + minutes * 60_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(3_000);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ""}`);
}
const canI = (...args: string[]) => {
  try {
    return kubectl(
      "auth",
      "can-i",
      ...args,
      "--as",
      AGENT,
      "-n",
      SYSTEM,
    ).trim();
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? "").trim();
  }
};
function secretData() {
  const secret = JSON.parse(
    kubectl("-n", SYSTEM, "get", "secret", SECRET, "-o", "json"),
  ) as { data?: Record<string, string> };
  return Object.fromEntries(
    Object.entries(secret.data ?? {}).map(([key, value]) => [
      key,
      Buffer.from(value, "base64").toString("utf8"),
    ]),
  );
}
const agentPod = () =>
  kubectl(
    "-n",
    SYSTEM,
    "get",
    "pods",
    "-l",
    "app.kubernetes.io/component=agent",
    "--field-selector=status.phase=Running",
    "-o",
    "jsonpath={.items[*].metadata.name}",
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);

/** A pod under `serviceAccount` in `namespace` that asks for the token with its own projected token. */
async function intruder(
  namespace: string,
  serviceAccount: string,
  url: string,
) {
  const name = `intruder-${crypto.randomUUID().slice(0, 8)}`;
  apply({
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: { name: serviceAccount, namespace },
  });
  apply({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace },
    spec: {
      serviceAccountName: serviceAccount,
      restartPolicy: "Never",
      containers: [
        {
          name: "curl",
          image: "curlimages/curl:8.17.0",
          command: [
            "sh",
            "-c",
            `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat /var/run/secrets/enroll/token)" ${url}`,
          ],
          volumeMounts: [
            { name: "enroll", mountPath: "/var/run/secrets/enroll" },
          ],
        },
      ],
      volumes: [
        {
          name: "enroll",
          projected: {
            sources: [
              {
                serviceAccountToken: {
                  audience: ENROLLMENT_TOKEN_AUDIENCE,
                  expirationSeconds: 600,
                  path: "token",
                },
              },
            ],
          },
        },
      ],
    },
  });
  const status = await until(`${name} to finish`, () => {
    const phase = kubectl(
      "-n",
      namespace,
      "get",
      "pod",
      name,
      "-o",
      "jsonpath={.status.phase}",
    );
    return phase === "Succeeded" || phase === "Failed"
      ? kubectl("-n", namespace, "logs", name).trim()
      : false;
  });
  kubectl("-n", namespace, "delete", "pod", name, "--wait=false");
  return status;
}

const run = kubeconfig ? describe : describe.skip;
let pki: TestPki;
let fleet: FakeManagementService;
let enroll: FakeEnrollmentService;
let openbot: FakeOpenBotInternal;
let internalUrl = "";
/** The enrolling pod's log, kept before the restart replaces the pod. */
let enrollingLog = "";

run("self-serve enrollment on a real cluster", () => {
  beforeAll(async () => {
    const host = env.OPENBOT_AGENT_E2E_HOST ?? "";
    pki = makePki(installId, [host]);
    fleet = new FakeManagementService(pki, installId);
    const fleetPort = await fleet.start(0, "0.0.0.0");
    enroll = new FakeEnrollmentService(pki);
    const enrollPort = enroll.start(0, "0.0.0.0");
    // The cluster's own service account keys, as OpenBot's server reads them.
    const issuer = (
      JSON.parse(
        kubectl("get", "--raw", "/.well-known/openid-configuration"),
      ) as {
        issuer: string;
      }
    ).issuer;
    const jwks = JSON.parse(kubectl("get", "--raw", "/openid/v1/jwks"));
    openbot = new FakeOpenBotInternal({ jwks, issuer });
    const internalPort = openbot.start(0, "0.0.0.0");
    internalUrl = `http://${host}:${internalPort}/management/enrollment-token`;
    // The admin has connected the install in OpenBot: the token waits for the agent.
    openbot.token = enroll.grant(installId);

    for (const namespace of [SYSTEM, PRODUCT])
      apply({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: namespace },
      });
    const [repository, tag] = (env.OPENBOT_AGENT_E2E_IMAGE ?? "").split(":");
    // Nothing about the install: no installId, no certificate Secret, no backup, default product.
    const values = {
      enrollment: {
        serverUrl: `http://${host}:${internalPort}`,
        url: `https://${host}:${enrollPort}`,
        trustCa: pki.ca,
      },
      management: { url: `https://${host}:${fleetPort}` },
      commandPublicKey: fleet.publicKey,
      agent: { image: { repository, tag } },
    };
    const file = join(pki.directory, "agent-values.json");
    writeFileSync(file, JSON.stringify(values));
    await shAsync("helm", [
      "upgrade",
      "--install",
      "openbot-agent",
      env.OPENBOT_AGENT_E2E_CHART ?? "",
      "-n",
      SYSTEM,
      "--values",
      file,
    ]);
  });

  afterAll(() => {
    fleet?.stop();
    enroll?.stop();
    openbot?.stop();
    if (pki) rmSync(pki.directory, { recursive: true, force: true });
  });

  test("enrolls, writes its Secret and heartbeats with the certificate", async () => {
    await until(
      "the agent's first heartbeat",
      () => fleet.heartbeats.length > 0,
    );
    expect(fleet.heartbeats[0]?.installId).toBe(installId);
    expect(openbot.answers.filter((a) => a.status === 200)).toEqual([
      { status: 200, subject: AGENT },
    ]);
    expect(enroll.issued).toHaveLength(1);
    const data = secretData();
    expect(commonName(data["tls.crt"] ?? "")).toBe(installId);
    expect(data["tls.crt"]).toBe(enroll.issued[0]?.certificatePem);
    expect(data["tls.key"]).toContain("BEGIN PRIVATE KEY");
    expect(data["enrollment-token"]).toBeUndefined();
    enrollingLog = kubectl("-n", SYSTEM, "logs", "deployment/openbot-agent");
    expect(enrollingLog).toContain("enrolled:");
    // The request the service saw carried no key.
    expect(JSON.stringify(enroll.requests)).not.toContain("PRIVATE KEY");
    // The metrics collector, which mounts the same Secret, starts once it exists.
    await until("the metrics collector to run", () =>
      kubectl(
        "-n",
        SYSTEM,
        "get",
        "pods",
        "-l",
        "app.kubernetes.io/component=otel-cluster",
        "-o",
        "jsonpath={.items[*].status.phase}",
      ).includes("Running"),
    );
  });

  test("another service account is refused the token, with the same audience", async () => {
    expect(await intruder(SYSTEM, "intruder", internalUrl)).toBe("403");
    // The agent's name in another namespace is not the agent.
    expect(await intruder(PRODUCT, "openbot-agent", internalUrl)).toBe("403");
    expect(openbot.answers.filter((a) => a.status === 403)).toHaveLength(2);
  });

  test("the agent may reach its own Secret by name and no other", () => {
    expect(canI("get", `secrets/${SECRET}`)).toBe("yes");
    expect(canI("update", `secrets/${SECRET}`)).toBe("yes");
    expect(canI("create", `secrets/${SECRET}`)).toBe("yes");
    expect(canI("get", "secrets/openbot-values")).toBe("no");
    expect(canI("list", "secrets")).toBe("no");
    expect(canI("create", "secrets/another")).toBe("no");
    expect(canI("delete", `secrets/${SECRET}`)).toBe("no");
  });

  test("a restart reads the Secret and enrolls nothing", async () => {
    const before = agentPod();
    const answers = openbot.answers.length;
    kubectl("-n", SYSTEM, "rollout", "restart", "deployment/openbot-agent");
    kubectl(
      "-n",
      SYSTEM,
      "rollout",
      "status",
      "deployment/openbot-agent",
      "--timeout=5m",
    );
    const after = await until("the new agent pod", () => {
      const pods = agentPod();
      return pods.length === 1 && !before.includes(pods[0] ?? "") && pods;
    });
    const count = fleet.heartbeats.length;
    await until(
      "a heartbeat from the restarted agent",
      () => fleet.heartbeats.length > count,
    );
    expect(fleet.heartbeats.at(-1)?.installId).toBe(installId);
    expect(openbot.answers.length).toBe(answers);
    expect(enroll.issued).toHaveLength(1);
    const log = kubectl("-n", SYSTEM, "logs", after[0] ?? "");
    expect(log).not.toContain("enrolled:");
    expect(log).toContain("openbot management agent started");
  });

  test("no agent log line holds the token, the key or the certificate", () => {
    const data = secretData();
    const logs = [
      enrollingLog,
      kubectl("-n", SYSTEM, "logs", "deployment/openbot-agent"),
    ].join("\n");
    expect(logs).not.toContain(openbot.token?.enrollmentToken ?? "-");
    expect(logs).not.toContain("PRIVATE KEY");
    expect(logs).not.toContain("BEGIN CERTIFICATE");
    expect(logs).not.toContain((data["tls.key"] ?? "").split("\n")[1] ?? "-");
  });
});
