/**
 * A vanilla install from the licence and the model key alone, rendered by real Helm from the real
 * chart: the README's secrets file is those two lines, and the chart makes everything else.
 *
 * What must not regress, because each one is a person stuck before OpenBot ever starts, or a database
 * locked out of itself on the next upgrade:
 *  - with the bundled database, the key encryption key, the computer token and the database password
 *    are generated when nobody gives them, into Secrets the chart writes and keeps on uninstall, and
 *    every pod that reads one reads the same Secret and key;
 *  - nothing ships a fixed value, which would be a credential published in this repository;
 *  - a value given is the value used, and a Secret of the operator's is read and never written;
 *  - with a database of the operator's, the key encryption key is still required, because that
 *    database outlives the namespace a generated key lives in;
 *  - an upgrade keeps every generated value, and one from a release installed with these supplied
 *    keeps what that release was installed with. That is `lookup`'s job, which needs a cluster: the
 *    last block runs against one when OPENBOT_KIND_KUBECONFIG names a disposable cluster.
 */
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const helm = Bun.which("helm") !== null;
const kubeconfig = process.env.OPENBOT_KIND_KUBECONFIG;
const chart = join(import.meta.dir, "../charts/openbot");

type EnvVar = {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string } };
};
type Doc = {
  kind: string;
  metadata: {
    name: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    template?: {
      spec: {
        containers: { name: string; env?: EnvVar[] }[];
        volumes?: { name: string; secret?: { secretName: string } }[];
      };
    };
  };
  data?: Record<string, string>;
  stringData?: Record<string, string>;
};

/** The vanilla install with the README's two-line secrets file, and nothing else unless asked. */
function render(...args: string[]): Doc[] {
  const result = Bun.spawnSync(
    [
      "helm",
      "template",
      "openbot",
      chart,
      "--namespace",
      "openbot",
      "--values",
      join(chart, "ci/vanilla-values.yaml"),
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

const component = (name: string) => (doc: Doc) =>
  doc.metadata.labels?.["app.kubernetes.io/component"] === name;

function env(doc: Doc | undefined): EnvVar[] {
  return doc?.spec?.template?.spec.containers[0]?.env ?? [];
}

/** The Secret and key a variable is read from (whether it is optional is not the question here). */
function ref(doc: Doc | undefined, name: string) {
  const found = env(doc).find((e) => e.name === name)?.valueFrom?.secretKeyRef;
  return found && { name: found.name, key: found.key };
}

function secrets(docs: Doc[], name: string): Doc[] {
  return docs.filter((d) => d.kind === "Secret" && d.metadata.name === name);
}

function written(docs: Doc[], name: string, key: string): string | undefined {
  const secret = secrets(docs, name)[0];
  if (secret?.stringData?.[key] !== undefined) return secret.stringData[key];
  const raw = secret?.data?.[key];
  return raw === undefined
    ? undefined
    : Buffer.from(raw, "base64").toString("utf8");
}

/** The three credentials as every reader sees them, checking on the way that the readers agree. */
function credentials(docs: Doc[]) {
  const server = docs.find(
    (d) => d.kind === "Deployment" && component("server")(d),
  );
  const computer = docs.find(
    (d) => d.kind === "StatefulSet" && component("computer")(d),
  );
  const database = docs.find(
    (d) => d.kind === "StatefulSet" && d.metadata.name === "openbot-postgresql",
  );
  const kek = ref(server, "KEY_ENCRYPTION_KEY");
  const token = ref(server, "COMPUTER_TOKEN");
  const password = ref(server, "POSTGRES_PASSWORD");
  // The computer opens with the token the API presents, and the database with the password the API
  // connects with: the database mounts its Secret whole and reads `postgres-password` from it.
  expect(ref(computer, "COMPUTER_TOKEN")).toEqual(token);
  const mounted = database?.spec?.template?.spec.volumes?.find(
    (v) => v.name === "postgresql-password",
  )?.secret?.secretName;
  expect(mounted).toBe(password?.name);
  expect(password?.key).toBe("postgres-password");
  return {
    refs: { kek, token, password },
    kek: written(docs, kek?.name ?? "", kek?.key ?? ""),
    token: written(docs, token?.name ?? "", token?.key ?? ""),
    password: written(docs, password?.name ?? "", password?.key ?? ""),
  };
}

describe.skipIf(!helm)(
  "a vanilla install from the licence and the model key",
  () => {
    test("generates the key encryption key, the computer token and the database password, into Secrets kept on uninstall", () => {
      const docs = render();
      const { refs, kek, token, password } = credentials(docs);

      const key = Buffer.from(kek ?? "", "base64");
      expect(key.length).toBe(32);
      // Not the public example key, which is thirty-two zero bytes.
      expect(key.some((byte) => byte !== 0)).toBe(true);
      expect(token?.length ?? 0).toBeGreaterThanOrEqual(32);
      expect(password?.length ?? 0).toBeGreaterThanOrEqual(24);

      // One Secret under each name, so the subchart's own does not render beside the chart's.
      for (const name of new Set(
        Object.values(refs).map((r) => r?.name ?? ""),
      )) {
        const found = secrets(docs, name);
        expect(found.length).toBe(1);
        expect(
          found[0]?.metadata.annotations?.["helm.sh/resource-policy"],
        ).toBe("keep");
      }
    });

    test("generates fresh values rather than shipping them", () => {
      const once = credentials(render());
      const twice = credentials(render());
      expect(twice.kek).not.toBe(once.kek);
      expect(twice.token).not.toBe(once.token);
      expect(twice.password).not.toBe(once.password);
    });

    test("uses the values given", () => {
      const kek = randomBytes(32).toString("base64");
      const given = credentials(
        render(
          "--set-string",
          `secrets.keyEncryptionKey=${kek}`,
          "--set-string",
          "secrets.computerToken=the-operators-token",
          "--set-string",
          "postgresql.auth.password=the-operators-password",
        ),
      );
      expect(given.kek).toBe(kek);
      expect(given.token).toBe("the-operators-token");
      expect(given.password).toBe("the-operators-password");
    });

    test("reads the operator's own Secret and writes none of these", () => {
      const docs = render(
        "--set-string",
        "secrets.existingSecret=mine",
        "--set-string",
        "postgresql.auth.existingSecret=mine",
      );
      const { refs } = credentials(docs);
      expect(Object.values(refs).map((r) => r?.name)).toEqual([
        "mine",
        "mine",
        "mine",
      ]);
      expect(secrets(docs, "openbot-secrets")).toEqual([]);
      expect(secrets(docs, "openbot-postgresql")).toEqual([]);
    });

    test("with a database of the operator's, still requires the key encryption key and the computer token", () => {
      const external = [
        "--set",
        "postgresql.enabled=false",
        "--set-string",
        "database.url=postgres://openbot:secret@db.example.com:5432/openbot?sslmode=require",
      ];
      expect(
        refusal(
          ...external,
          "--set-string",
          "secrets.computerToken=the-operators-token",
        ),
      ).toContain(
        "secrets.keyEncryptionKey is required with a database of your own",
      );
      expect(
        refusal(
          ...external,
          "--set-string",
          `secrets.keyEncryptionKey=${randomBytes(32).toString("base64")}`,
        ),
      ).toContain("A computer needs a token");
    });
  },
);

/*
 * Against a real API server, because `lookup` sees nothing under `helm template`. Rendered as
 * `helm upgrade` would render it, against Secrets as `helm install` would have left them.
 */
describe.skipIf(!helm || !kubeconfig)(
  "a vanilla install against a cluster",
  () => {
    const namespace = `openbot-vanilla-${randomBytes(3).toString("hex")}`;
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
        ...args,
      );
    /** A Secret as this release would hold it, so Helm will take it as its own. */
    const owned = (name: string, data: Record<string, string>) =>
      kubectl(
        ["apply", "-f", "-"],
        JSON.stringify({
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            name,
            labels: { "app.kubernetes.io/managed-by": "Helm" },
            annotations: {
              "meta.helm.sh/release-name": "openbot",
              "meta.helm.sh/release-namespace": namespace,
            },
          },
          stringData: data,
        }),
      );

    test("keeps every generated value across upgrades, and the values a release was installed with", () => {
      Bun.spawnSync([
        "kubectl",
        "--kubeconfig",
        kubeconfig ?? "",
        "create",
        "namespace",
        namespace,
      ]);
      try {
        // Installed from the two-line file: what the chart generated is what the upgrade reads back.
        const first = renderLive();
        const installed = credentials(first);
        for (const name of ["openbot-secrets", "openbot-postgresql"]) {
          const secret = secrets(first, name)[0];
          owned(name, secret?.stringData ?? {});
        }
        expect(credentials(renderLive())).toEqual(installed);

        // Installed with the three supplied, the database's Secret written by the subchart itself: an
        // upgrade that still supplies them, and one that has stopped, both keep what is there.
        const kek = randomBytes(32).toString("base64");
        owned("openbot-secrets", {
          "key-encryption-key": kek,
          "computer-token": "supplied-at-install",
        });
        owned("openbot-postgresql", {
          "postgres-password": "supplied-password",
        });
        const supplied = {
          kek,
          token: "supplied-at-install",
          password: "supplied-password",
        };
        const stillGiven = credentials(
          renderLive(
            "--set-string",
            `secrets.keyEncryptionKey=${kek}`,
            "--set-string",
            "secrets.computerToken=supplied-at-install",
            "--set-string",
            "postgresql.auth.password=supplied-password",
          ),
        );
        expect({
          kek: stillGiven.kek,
          token: stillGiven.token,
          password: stillGiven.password,
        }).toEqual(supplied);
        const noLongerGiven = credentials(renderLive());
        expect({
          kek: noLongerGiven.kek,
          token: noLongerGiven.token,
          password: noLongerGiven.password,
        }).toEqual(supplied);
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
  },
);

/** The annotations on a workload's pod template: what Kubernetes compares to decide whether to roll it. */
function podAnnotations(
  docs: Doc[],
  kind: string,
  name: string,
): Record<string, string> {
  const workload = docs.find((d) => d.kind === kind && component(name)(d)) as
    | {
        spec?: {
          template?: { metadata?: { annotations?: Record<string, string> } };
        };
      }
    | undefined;
  return workload?.spec?.template?.metadata?.annotations ?? {};
}

describe.skipIf(!helm)("an upgrade that changes a secret", () => {
  // A changed Secret does not change a pod, so without these an upgrade with a new model key or
  // licence left every pod on the old one: the release looked upgraded and every Bot turn kept
  // failing on the key it was meant to replace.
  const given = (...extra: string[]) =>
    render(
      "--set-string",
      "secrets.licenseToken=licence-a",
      "--set-string",
      "secrets.computerToken=computer-token-a-0123456789abcdef",
      ...extra,
    );

  test("a new model key rolls the server, and leaves the computer and its sessions alone", () => {
    const before = given("--set-string", "secrets.modelApiKey=key-a");
    const after = given("--set-string", "secrets.modelApiKey=key-b");

    expect(podAnnotations(after, "Deployment", "server")).not.toEqual(
      podAnnotations(before, "Deployment", "server"),
    );
    expect(podAnnotations(after, "StatefulSet", "computer")).toEqual(
      podAnnotations(before, "StatefulSet", "computer"),
    );
  });

  test("a new computer token rolls both the server and the computer, which must agree on it", () => {
    const before = given("--set-string", "secrets.modelApiKey=key-a");
    const after = given(
      "--set-string",
      "secrets.modelApiKey=key-a",
      "--set-string",
      "secrets.computerToken=computer-token-b-0123456789abcdef",
    );

    expect(podAnnotations(after, "Deployment", "server")).not.toEqual(
      podAnnotations(before, "Deployment", "server"),
    );
    expect(podAnnotations(after, "StatefulSet", "computer")).not.toEqual(
      podAnnotations(before, "StatefulSet", "computer"),
    );
  });

  test("the same values roll nothing, though the generated secrets differ on every render", () => {
    const once = render("--set-string", "secrets.modelApiKey=key-a");
    const twice = render("--set-string", "secrets.modelApiKey=key-a");

    expect(podAnnotations(twice, "Deployment", "server")).toEqual(
      podAnnotations(once, "Deployment", "server"),
    );
    expect(podAnnotations(twice, "StatefulSet", "computer")).toEqual(
      podAnnotations(once, "StatefulSet", "computer"),
    );
  });
});
