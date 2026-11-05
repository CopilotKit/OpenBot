/**
 * OpenBot's project and runtime key in the Intelligence this deployment installed, with nobody
 * signing in.
 *
 * The Helm chart installs Intelligence beside OpenBot (`intelligence.enabled`), and the server cannot
 * start without a project key from it. A person would sign in to Intelligence, make a project and
 * copy its key. This does the same with the organization's service token, which can create a project
 * and a key in its organization and nothing else, and stores the key in a Kubernetes Secret the server
 * reads. Run by the chart's key Job on every install and upgrade:
 *
 *   - a key already in the Secret that Intelligence still accepts is kept, so an upgrade changes
 *     nothing;
 *   - one Intelligence rejects (its database was replaced, say) is replaced with a new project's;
 *   - with none, a project and key are made.
 *
 * Intelligence 0.15.1 does not start its API until the organization the token names exists, which
 * its own post-install hook creates, so on a first install this waits, through connection refusals
 * and restarts, until the API answers or the deadline passes.
 */
import { readFile } from "node:fs/promises";

/** Where the key is kept: the Secret the server's INTELLIGENCE_API_KEY reads. */
export type KeyStore = {
  read(): Promise<{ apiKey: string; projectId?: string } | null>;
  write(value: { apiKey: string; projectId: string }): Promise<void>;
};

export type ProvisionInput = {
  /** Intelligence's API, as this pod reaches it: `http://<release>-intelligence-app-api:4201`. */
  apiUrl: string;
  /** The organization the service token acts for, by id. */
  organizationId: string;
  serviceToken: string;
  projectName: string;
  store: KeyStore;
  /** Give up after this long. Default 25 minutes, inside the Job's own deadline. */
  deadlineMs?: number;
  /** Pause between attempts. Default 5 seconds. */
  retryMs?: number;
  log?: (line: string) => void;
  fetch?: typeof fetch;
};

export type ProvisionResult = "kept" | "created" | "replaced";

/** The header Intelligence's service tokens travel in (apps/app-api/src/service-tokens/middleware.ts). */
const SERVICE_TOKEN_HEADER = "X-CopilotKit-EI-Service-Token";

class Retry extends Error {}

export async function provisionIntelligenceKey(
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const call = input.fetch ?? fetch;
  const log = input.log ?? ((line: string) => console.log(line));
  const retryMs = input.retryMs ?? 5_000;
  const deadline = Date.now() + (input.deadlineMs ?? 25 * 60_000);
  const api = input.apiUrl.replace(/\/+$/, "");

  /** Run `attempt` until it answers, retrying what Intelligence not being up yet looks like. */
  async function untilAnswered<T>(what: string, attempt: () => Promise<T>) {
    let lastReason = "";
    for (;;) {
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof Retry) && !isConnectionError(error)) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        if (reason !== lastReason) {
          log(`Waiting for Intelligence to ${what}: ${reason}`);
          lastReason = reason;
        }
      }
      if (Date.now() + retryMs > deadline) {
        throw new Error(
          `Intelligence at ${api} did not ${what} in time. Last answer: ${lastReason}`,
        );
      }
      await Bun.sleep(retryMs);
    }
  }

  const existing = await input.store.read();
  if (existing?.apiKey) {
    const accepted = await untilAnswered(
      "answer with the stored key",
      async () => {
        const response = await call(`${api}/api/entitlements/runtime`, {
          headers: { authorization: `Bearer ${existing.apiKey}` },
        });
        // Only a refusal of the key itself replaces it. A licence problem, or anything else this
        // endpoint says, is not the key's fault, and minting a new one would not fix it.
        if (response.status === 401) return false;
        if (response.status >= 500) throw new Retry(`HTTP ${response.status}`);
        return true;
      },
    );
    if (accepted) {
      log("Intelligence accepts the stored key; nothing to do.");
      return "kept";
    }
    log(
      "Intelligence no longer accepts the stored key; making a new project and key.",
    );
  }

  const serviceHeaders = {
    "content-type": "application/json",
    [SERVICE_TOKEN_HEADER]: input.serviceToken,
  };
  const project = await untilAnswered("create OpenBot's project", async () => {
    const response = await call(
      `${api}/api/organizations/${encodeURIComponent(input.organizationId)}/projects`,
      {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify({ name: input.projectName }),
      },
    );
    return expectCreated<{ id: number | string }>(response, "project");
  });
  const projectId = String(project.id);
  log(`Created Intelligence project ${projectId}.`);

  const created = await untilAnswered("create the project's key", async () => {
    const response = await call(
      `${api}/api/projects/${encodeURIComponent(projectId)}/api-keys`,
      {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify({ name: "openbot" }),
      },
    );
    return expectCreated<{ key?: { token?: string } }>(response, "key");
  });
  const apiKey = created.key?.token;
  if (!apiKey) {
    throw new Error(
      "Intelligence created the key but its answer carried no token, so it cannot be stored.",
    );
  }
  await input.store.write({ apiKey, projectId });
  log(`Stored the key for project ${projectId}.`);
  return existing?.apiKey ? "replaced" : "created";
}

/**
 * The created object, or a reason to try again, or a failure that will not change by waiting.
 *
 * Retried: 5xx (the API starting), 404 (the organization not bootstrapped yet), 401 and 403 (the API
 * started before the token's Secret settled, and reads it once at startup), and 429 (project
 * creation is rate-limited). A 400 is a request this code got wrong and fails at once.
 */
async function expectCreated<T>(response: Response, what: string): Promise<T> {
  if (response.status === 201 || response.status === 200) {
    return (await response.json()) as T;
  }
  const body = (await response.text()).slice(0, 300);
  if (response.status === 400) {
    throw new Error(
      `Intelligence refused to create the ${what}: HTTP 400 ${body}`,
    );
  }
  throw new Retry(
    `HTTP ${response.status} creating the ${what} ${body}`.trim(),
  );
}

/** A request that never reached an answer: the Service has no ready pod yet, or one went away. */
function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === "string" &&
    /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ConnectionRefused|ConnectionClosed|FailedToOpenSocket)$/.test(
      code,
    )
  );
}

/**
 * The key's Secret, through the Kubernetes API with this pod's service account.
 *
 * Created by this Job rather than rendered by Helm: Helm would put its own (empty) copy back on the
 * next upgrade. It is not removed by `helm uninstall`, like the generated Intelligence credentials,
 * because Intelligence's database, which still holds the key, is not removed either.
 */
export function kubernetesKeyStore(input: {
  apiServer: string;
  namespace: string;
  name: string;
  token: string;
  ca?: string;
  labels?: Record<string, string>;
  fetch?: typeof fetch;
}): KeyStore {
  const call = input.fetch ?? fetch;
  const base = `${input.apiServer.replace(/\/+$/, "")}/api/v1/namespaces/${encodeURIComponent(input.namespace)}/secrets`;
  const init = (method: string, body?: unknown): RequestInit =>
    ({
      method,
      headers: {
        authorization: `Bearer ${input.token}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(input.ca ? { tls: { ca: input.ca } } : {}),
    }) as RequestInit;

  const manifest = (value: { apiKey: string; projectId: string }) => ({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: input.name, labels: input.labels ?? {} },
    type: "Opaque",
    stringData: {
      "intelligence-api-key": value.apiKey,
      "intelligence-project-id": value.projectId,
    },
  });

  return {
    async read() {
      const response = await call(
        `${base}/${encodeURIComponent(input.name)}`,
        init("GET"),
      );
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(
          `Could not read Secret ${input.name}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
        );
      }
      const secret = (await response.json()) as {
        data?: Record<string, string>;
      };
      const decode = (key: string) => {
        const raw = secret.data?.[key];
        return raw ? Buffer.from(raw, "base64").toString("utf8") : undefined;
      };
      const apiKey = decode("intelligence-api-key");
      if (!apiKey) return null;
      const projectId = decode("intelligence-project-id");
      return projectId ? { apiKey, projectId } : { apiKey };
    },
    async write(value) {
      const created = await call(base, init("POST", manifest(value)));
      if (created.ok) return;
      if (created.status !== 409) {
        throw new Error(
          `Could not create Secret ${input.name}: HTTP ${created.status} ${(await created.text()).slice(0, 300)}`,
        );
      }
      const replaced = await call(
        `${base}/${encodeURIComponent(input.name)}`,
        init("PUT", manifest(value)),
      );
      if (!replaced.ok) {
        throw new Error(
          `Could not replace Secret ${input.name}: HTTP ${replaced.status} ${(await replaced.text()).slice(0, 300)}`,
        );
      }
    },
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (import.meta.main) {
  const serviceAccount = "/var/run/secrets/kubernetes.io/serviceaccount";
  try {
    const [token, ca] = await Promise.all([
      readFile(`${serviceAccount}/token`, "utf8"),
      readFile(`${serviceAccount}/ca.crt`, "utf8"),
    ]);
    const host = required("KUBERNETES_SERVICE_HOST");
    const port = process.env.KUBERNETES_SERVICE_PORT?.trim() || "443";
    const result = await provisionIntelligenceKey({
      apiUrl: required("INTELLIGENCE_API_URL"),
      organizationId: required("INTELLIGENCE_ORGANIZATION_ID"),
      serviceToken: required("INTELLIGENCE_SERVICE_TOKEN"),
      projectName: process.env.INTELLIGENCE_PROJECT_NAME?.trim() || "OpenBot",
      store: kubernetesKeyStore({
        apiServer: `https://${host.includes(":") ? `[${host}]` : host}:${port}`,
        namespace: required("POD_NAMESPACE"),
        name: required("INTELLIGENCE_KEY_SECRET"),
        token: token.trim(),
        ca,
        labels: {
          "app.kubernetes.io/name": "openbot",
          "app.kubernetes.io/instance":
            process.env.RELEASE_NAME?.trim() || "openbot",
          "app.kubernetes.io/component": "intelligence-key",
        },
      }),
    });
    console.log(JSON.stringify({ type: "intelligence-key", result }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
