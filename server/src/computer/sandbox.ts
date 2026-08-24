/**
 * A computer each, as a `Sandbox` on Kubernetes.
 *
 * `kubernetes-sigs/agent-sandbox` defines a CRD for "isolated, stateful singleton workloads with
 * stable identity and persistent storage", aimed at agents that run untrusted code and drive
 * graphical interfaces. That is a description of a Bot's computer, so this provider maps onto it
 * rather than hand-rolling a StatefulSet per Bot and owning suspend, resume and identity ourselves.
 *
 * The part that would have been the hard build is a field. `spec.operatingMode` is `Running` or
 * `Suspended`, and Suspended terminates the pod while keeping the volumes, so "spin down when idle,
 * come back with the logins intact" is one patch and a condition to wait on.
 *
 * NO CLIENT LIBRARY. The Kubernetes API is HTTP and JSON, this needs five verbs of it, and a
 * generated client would be a large dependency in an image that already ships a browser. The
 * in-cluster service account gives a token and a CA, which is what `inClusterConfig` reads.
 */
import { readFile } from "node:fs/promises";
import type { ComputerLocation, ComputerProvider } from "./provider";
import type { ComputerStatus } from "./schema";

const SERVICE_ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount";
const GROUP = "agents.x-k8s.io";
const VERSION = "v1beta1";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/** One Sandbox, in the shape the parts of it this file reads. */
type Sandbox = {
  metadata?: { name?: string; creationTimestamp?: string };
  spec?: { operatingMode?: "Running" | "Suspended" };
  status?: {
    serviceFQDN?: string;
    conditions?: { type?: string; status?: string; reason?: string }[];
    podIPs?: string[];
    nodeName?: string;
  };
};

export type SandboxProviderOptions = {
  /** Where the Bots' computers live. The provider is scoped to exactly this namespace. */
  namespace: string;
  /** The pod template every computer is cut from, as YAML-derived JSON from the chart. */
  template: Record<string, unknown>;
  /** How long a computer may go untouched before the culler suspends it. */
  idleAfterMs: number;
  apiServer?: string;
  token?: string;
  ca?: string;
  fetchImpl?: typeof fetch;
  /** How long `locate` waits for a suspended computer to come back before giving up. */
  resumeTimeoutMs?: number;
};

/**
 * The service account this pod was given, which is how it reaches the API server.
 *
 * Absent outside a cluster, and that is not an error here: `createComputerProvider` only asks for
 * this provider when a deployment configured it, and a clear message about a missing token beats a
 * connection refused to an address nobody set.
 */
export async function inClusterConfig(): Promise<{
  apiServer: string;
  token: string;
  ca: string;
}> {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
  if (!host) {
    throw new SandboxError(
      "COMPUTER_PROVIDER=sandbox needs to run inside a cluster: KUBERNETES_SERVICE_HOST is not set, so there is no API server to ask for a Bot's computer.",
    );
  }
  const [token, ca] = await Promise.all([
    readFile(`${SERVICE_ACCOUNT}/token`, "utf8"),
    readFile(`${SERVICE_ACCOUNT}/ca.crt`, "utf8"),
  ]);
  return { apiServer: `https://${host}:${port}`, token: token.trim(), ca };
}

/**
 * A Kubernetes name for a Bot.
 *
 * Bot ids are ours and may hold anything a person typed; a resource name may hold lowercase
 * alphanumerics and dashes, and is refused rather than truncated by the API server. Anything else
 * becomes a dash, and a short hash keeps two ids that differ only in punctuation from colliding on
 * one computer, which would be one Bot reading another's logins.
 */
export function sandboxNameFor(botId: string): string {
  const slug = botId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  let hash = 5381;
  for (let index = 0; index < botId.length; index += 1) {
    hash = ((hash << 5) + hash + botId.charCodeAt(index)) >>> 0;
  }
  const suffix = hash.toString(36);
  return `bot-${slug.slice(0, 40) || "unnamed"}-${suffix}`;
}

function conditionOf(sandbox: Sandbox, type: string): string | undefined {
  return sandbox.status?.conditions?.find((c) => c.type === type)?.status;
}

/** Ready means the pod is up and the service answers; anything else is not somewhere to send a Bot. */
function isReady(sandbox: Sandbox): boolean {
  return conditionOf(sandbox, "Ready") === "True";
}

function isSuspended(sandbox: Sandbox): boolean {
  return (
    sandbox.spec?.operatingMode === "Suspended" ||
    conditionOf(sandbox, "Suspended") === "True"
  );
}

export function createSandboxComputerProvider(
  options: SandboxProviderOptions,
): ComputerProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const resumeTimeoutMs = options.resumeTimeoutMs ?? 120_000;
  const base = () =>
    `${options.apiServer}/apis/${GROUP}/${VERSION}/namespaces/${options.namespace}/sandboxes`;

  async function call(
    path: string,
    init: RequestInit & { contentType?: string } = {},
  ): Promise<unknown> {
    const { contentType, ...rest } = init;
    const response = await doFetch(`${base()}${path}`, {
      ...rest,
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(contentType ? { "content-type": contentType } : {}),
        accept: "application/json",
        ...(rest.headers ?? {}),
      },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new SandboxError(
        `The cluster refused a sandbox request (${response.status}): ${body.slice(0, 300)}`,
      );
    }
    return response.json();
  }

  const read = (botId: string) =>
    call(`/${sandboxNameFor(botId)}`) as Promise<Sandbox | undefined>;

  /** The desired body for a Bot's computer. Created once, then only ever patched. */
  function desired(botId: string): Record<string, unknown> {
    return {
      apiVersion: `${GROUP}/${VERSION}`,
      kind: "Sandbox",
      metadata: {
        name: sandboxNameFor(botId),
        namespace: options.namespace,
        labels: {
          "app.kubernetes.io/managed-by": "openbot",
          "openbot.dev/component": "computer",
        },
        // The Bot id as written, which the name above cannot always carry. The culler reads this
        // rather than trying to reverse the slug.
        annotations: { "openbot.dev/bot-id": botId },
      },
      spec: { operatingMode: "Running", ...options.template },
    };
  }

  async function waitForReady(botId: string): Promise<Sandbox> {
    const deadline = Date.now() + resumeTimeoutMs;
    for (;;) {
      const sandbox = await read(botId);
      if (sandbox && isReady(sandbox) && sandbox.status?.serviceFQDN) {
        return sandbox;
      }
      if (Date.now() >= deadline) {
        throw new SandboxError(
          `The computer for ${botId} did not become ready within ${Math.round(resumeTimeoutMs / 1000)}s. A resume costs a pod schedule and a browser launch, so this is a real wait rather than a failure, but it has to end somewhere.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  return {
    name: "sandbox",
    isolation: "per-bot",

    async locate(botId: string): Promise<string> {
      const existing = await read(botId);
      if (!existing) {
        await call("", {
          method: "POST",
          contentType: "application/json",
          body: JSON.stringify(desired(botId)),
        });
      } else if (isSuspended(existing)) {
        /*
         * Woken, because somebody is asking for it.
         *
         * `locate` runs immediately before an action, so reaching a suspended computer here means a
         * person is waiting. A merge patch rather than a replace: the controller owns most of this
         * object and writing the whole thing back would fight it.
         */
        await call(`/${sandboxNameFor(botId)}`, {
          method: "PATCH",
          contentType: "application/merge-patch+json",
          body: JSON.stringify({ spec: { operatingMode: "Running" } }),
        });
      }

      const ready = await waitForReady(botId);
      const fqdn = ready.status?.serviceFQDN;
      if (!fqdn) {
        throw new SandboxError(
          `The computer for ${botId} is ready but reported no address, so it cannot be reached.`,
        );
      }
      return `http://${fqdn}:4100`;
    },

    async status(botId: string): Promise<ComputerStatus> {
      try {
        const sandbox = await read(botId);
        if (!sandbox) return { botId, state: "absent" };
        /*
         * A SUSPENDED COMPUTER IS DOWN AND FINE, and reading it any other way is how scale-to-zero
         * is lost. Answering this by dialling the pod would wake it, so every computer anything ever
         * asked about would come back up and the bill would never fall. The conditions are the whole
         * answer and nothing here touches the browser.
         */
        if (isSuspended(sandbox)) return { botId, state: "absent" };
        if (isReady(sandbox)) return { botId, state: "ready" };
        return { botId, state: "starting" };
      } catch (error) {
        return {
          botId,
          state: "unreachable",
          reason:
            error instanceof Error && error.message.length > 0
              ? error.message
              : "The cluster could not be asked about this computer.",
        };
      }
    },

    async stop(botId: string): Promise<{ wasRunning: boolean }> {
      const sandbox = await read(botId);
      if (!sandbox || isSuspended(sandbox)) return { wasRunning: false };
      // Suspended, not deleted: the pod goes and the volumes stay, which is the difference between
      // stopping a computer and wiping a Bot's logins.
      await call(`/${sandboxNameFor(botId)}`, {
        method: "PATCH",
        contentType: "application/merge-patch+json",
        body: JSON.stringify({ spec: { operatingMode: "Suspended" } }),
      });
      return { wasRunning: true };
    },

    async reset(botId: string): Promise<{ cleared: boolean }> {
      const sandbox = await read(botId);
      if (!sandbox) return { cleared: false };
      // Deleted, which takes the volumes with it. This is the one that is meant to lose the logins.
      await call(`/${sandboxNameFor(botId)}`, { method: "DELETE" });
      return { cleared: true };
    },

    async list(): Promise<ComputerLocation[]> {
      const body = (await call("")) as { items?: Sandbox[] } | undefined;
      return (body?.items ?? []).map((sandbox) => {
        const botId =
          (sandbox.metadata as { annotations?: Record<string, string> })
            ?.annotations?.["openbot.dev/bot-id"] ??
          sandbox.metadata?.name ??
          "";
        return {
          botId,
          status:
            isSuspended(sandbox) || !isReady(sandbox) ? "stopped" : "running",
          url: sandbox.status?.serviceFQDN
            ? `http://${sandbox.status.serviceFQDN}:4100`
            : "",
          ...(sandbox.metadata?.creationTimestamp
            ? { startedAt: sandbox.metadata.creationTimestamp }
            : {}),
        };
      });
    },

    async sessionOf(botId: string): Promise<string | undefined> {
      /*
       * Which run of this computer this is, and it has to change across a suspend and resume.
       *
       * A snapshot's generation only orders snapshots within one run of a browser: a resumed
       * computer counts from one again, so a ref the model still holds from before the suspend would
       * match a row nothing has overwritten and the boundary would decide about an element on a page
       * that no longer exists. The pod's address changes when it is rescheduled, and the node it
       * landed on with it, so the two together identify the run without asking the browser anything.
       *
       * Reading, never ensuring: this must not be the thing that wakes a computer up.
       */
      const sandbox = await read(botId);
      if (!sandbox || isSuspended(sandbox)) return undefined;
      const ip = sandbox.status?.podIPs?.[0];
      const node = sandbox.status?.nodeName;
      if (!ip && !node) return undefined;
      return [node, ip].filter(Boolean).join("/");
    },
  };
}
