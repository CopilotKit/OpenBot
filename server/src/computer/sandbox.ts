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
import type {
  ComputerLocation,
  ComputerProvider,
  ComputerUpdate,
} from "./provider";
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
  metadata?: { name?: string; creationTimestamp?: string; generation?: number };
  spec?: {
    operatingMode?: "Running" | "Suspended";
    podTemplate?: PodTemplate;
  };
  status?: {
    serviceFQDN?: string;
    conditions?: {
      type?: string;
      status?: string;
      reason?: string;
      /** The generation of the Sandbox this condition was computed against. */
      observedGeneration?: number;
      /** When this condition last changed, which is how one run of a computer is told from the next. */
      lastTransitionTime?: string;
    }[];
    podIPs?: string[];
    nodeName?: string;
  };
};

/** The part of a pod template this file compares: which image each container runs. */
type PodTemplate = {
  spec?: {
    containers?: { name?: string; image?: string }[];
    initContainers?: { name?: string; image?: string }[];
  };
};

/**
 * Which image each container of a pod template runs, as one comparable string.
 *
 * IMAGES, NOT THE WHOLE TEMPLATE. The API server fills defaults into what it stores (a port's
 * protocol, for one), so a stored template never compares equal to the mounted one byte for byte,
 * and a comparison of the whole thing would call every computer out of date forever. What an
 * upgrade changes is the image, and that is what decides whether new computer code has reached it.
 */
export function imagesOf(podTemplate: unknown): string {
  const spec = (podTemplate as PodTemplate | undefined)?.spec;
  const list = (
    kind: string,
    containers: { name?: string; image?: string }[] | undefined,
  ) =>
    (containers ?? []).map(
      (container) => `${kind}/${container.name ?? ""}=${container.image ?? ""}`,
    );
  return [
    ...list("container", spec?.containers),
    ...list("init", spec?.initContainers),
  ]
    .sort()
    .join(",");
}

export type SandboxProviderOptions = {
  /** Where the Bots' computers live. The provider is scoped to exactly this namespace. */
  namespace: string;
  /**
   * The pod and volumes every computer is cut from.
   *
   * `Sandbox` carries its pod inline and has no template reference, so this has to come from
   * somewhere. It comes from a file the chart mounts, which means the server needs no permission to
   * read ConfigMaps and the shape of a computer stays a deployment decision rather than a constant
   * in this file.
   */
  template: Record<string, unknown>;
  /** How long a computer may go untouched before the culler suspends it. */
  idleAfterMs: number;
  apiServer?: string;
  /**
   * How this pod proves who it is, or a way to ask for the current one.
   *
   * A FUNCTION IS THE HONEST SHAPE, because a projected service account token is not a constant. The
   * kubelet rewrites the file well before the token expires, and the expiry is the cluster's to set:
   * an hour on a hardened cluster, a day by default. Read once and held for the life of the process,
   * it works right up until the first rotation and then every sandbox call returns 401, which reads
   * like the cluster broke rather than like a credential going stale.
   */
  token?: string | (() => Promise<string>);
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
/**
 * Read the pod template the chart mounted.
 *
 * A missing file is a deployment that asked for per-Bot computers without saying what one looks
 * like, which is worth failing on by name rather than creating a Sandbox the API server rejects for
 * a missing required field.
 */
export async function readSandboxTemplate(
  path: string,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new SandboxError(
      `COMPUTER_SANDBOX_TEMPLATE_FILE points at ${path}, which cannot be read. That file is what a Bot's computer is cut from; the chart mounts it when computers.mode is sandbox.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SandboxError(
      `${path} is not valid JSON, so there is nothing to make a computer from.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SandboxError(
      `${path} is not valid JSON, so there is nothing to make a computer from.`,
    );
  }
  const podTemplate = (parsed as Record<string, unknown>).podTemplate;
  if (!podTemplate) {
    throw new SandboxError(
      `${path} has no podTemplate, so there is nothing to make a computer from.`,
    );
  }
  return parsed as Record<string, unknown>;
}

/** How long a read token is reused before the file is consulted again. */
const TOKEN_MEMO_MS = 30_000;

export async function inClusterConfig(): Promise<{
  apiServer: string;
  token: () => Promise<string>;
  ca: string;
}> {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
  if (!host) {
    throw new SandboxError(
      "COMPUTER_PROVIDER=sandbox needs to run inside a cluster: KUBERNETES_SERVICE_HOST is not set, so there is no API server to ask for a Bot's computer.",
    );
  }
  /*
   * The CA is read once and the token is not.
   *
   * A cluster CA changes when the cluster is rebuilt, which is not a thing that happens under a
   * running pod. The token changes on a schedule the cluster chooses, so it is re-read, with a short
   * memo so an ordinary burst of sandbox calls does not become a burst of disk reads. Half a minute
   * is far inside any rotation window and far outside any burst.
   */
  const ca = await readFile(`${SERVICE_ACCOUNT}/ca.crt`, "utf8");
  let cached: { value: string; readAt: number } | undefined;
  const token = async () => {
    if (cached && Date.now() - cached.readAt < TOKEN_MEMO_MS)
      return cached.value;
    const value = (await readFile(`${SERVICE_ACCOUNT}/token`, "utf8")).trim();
    cached = { value, readAt: Date.now() };
    return value;
  };
  // Read once here so a missing or unreadable token is an error at start-up rather than on the
  // first Bot to ask for a computer.
  await token();
  return { apiServer: `https://${host}:${port}`, token, ca };
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
): ComputerProvider & {
  update(botId: string): Promise<ComputerUpdate>;
  restarting(botId: string): Promise<void> | undefined;
} {
  const doFetch = options.fetchImpl ?? fetch;
  const resumeTimeoutMs = options.resumeTimeoutMs ?? 120_000;
  /** Restarts started by `update` and not yet finished, one per Bot. */
  const lastRestart = new Map<string, Promise<void>>();
  const base = () =>
    `${options.apiServer}/apis/${GROUP}/${VERSION}/namespaces/${options.namespace}/sandboxes`;

  async function call(
    path: string,
    init: RequestInit & { contentType?: string } = {},
  ): Promise<unknown> {
    const { contentType, ...rest } = init;
    const token =
      typeof options.token === "function"
        ? await options.token()
        : options.token;
    const response = await doFetch(`${base()}${path}`, {
      ...rest,
      /*
       * The cluster's own CA, which is the only thing that signs the API server's certificate.
       *
       * It is not in any public trust store, so without this every call fails with "unable to verify
       * the first certificate" and a Bot simply never gets a computer. The alternative some reach for
       * is to stop verifying, which would leave the token in every one of these requests open to
       * anything that can answer on that address.
       */
      ...(options.ca ? { tls: { ca: options.ca } } : {}),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(contentType ? { "content-type": contentType } : {}),
        accept: "application/json",
        ...(rest.headers ?? {}),
      },
    } as RequestInit);
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
      spec: {
        operatingMode: "Running",
        // `podTemplate` is required and `volumeClaimTemplates` is what makes a suspend worth doing,
        // and both arrive together from the mounted template.
        ...options.template,
      },
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

  /** Whether this computer runs a different image from the one a new computer would get. */
  function isOutOfDate(sandbox: Sandbox): boolean {
    return (
      imagesOf(sandbox.spec?.podTemplate) !==
      imagesOf(options.template.podTemplate)
    );
  }

  /**
   * Put the current pod template on a Sandbox, and optionally its operating mode in the same write.
   *
   * A JSON patch that replaces `spec.podTemplate` whole, rather than a merge patch. A merge patch
   * merges maps key by key, so a field the template has since dropped (a node selector, an env
   * source) would linger on the computer and it would be running a pod nobody wrote.
   * `volumeClaimTemplates` is not touched: the CRD makes it immutable, and it is what holds the
   * profile and the workspace.
   *
   * THIS DOES NOT RESTART A RUNNING POD. The agent-sandbox controller cuts a pod from the template
   * only when there is none, and leaves an existing pod's spec alone (v0.5.6, `reconcilePod`). A new
   * template therefore reaches a computer through a suspend and a resume, which is why both callers
   * pair this with one.
   */
  async function replaceTemplate(
    botId: string,
    operatingMode: "Running" | "Suspended",
  ): Promise<Sandbox | undefined> {
    return (await call(`/${sandboxNameFor(botId)}`, {
      method: "PATCH",
      contentType: "application/json-patch+json",
      body: JSON.stringify([
        {
          op: "replace",
          path: "/spec/podTemplate",
          value: options.template.podTemplate,
        },
        { op: "add", path: "/spec/operatingMode", value: operatingMode },
      ]),
    })) as Sandbox | undefined;
  }

  /**
   * Wait for the pod of a computer being suspended to be gone.
   *
   * The Suspended condition, at or after the generation the suspend wrote. The condition on its own
   * is not enough: the controller does not clear it on resume, so a stale True from the last idle
   * suspend could say "gone" about a pod that is still running.
   */
  async function waitForSuspended(
    botId: string,
    generation: number | undefined,
  ): Promise<void> {
    const deadline = Date.now() + resumeTimeoutMs;
    for (;;) {
      const sandbox = await read(botId);
      if (!sandbox) return;
      const suspended = sandbox.status?.conditions?.find(
        (condition) => condition.type === "Suspended",
      );
      if (
        suspended?.status === "True" &&
        (generation === undefined ||
          (suspended.observedGeneration ?? 0) >= generation)
      ) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new SandboxError(
          `The computer for ${botId} did not stop within ${Math.round(resumeTimeoutMs / 1000)}s to take its new image.`,
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
         * person is waiting. A patch rather than a replace: the controller owns most of this object
         * and writing the whole thing back would fight it.
         *
         * And brought up to date on the way, because this is the one moment it costs nothing. There
         * is no pod, so the pod the controller is about to create is cut from whatever the template
         * says now, and the volumes are the Sandbox's own and are not in the patch. A computer woken
         * without this runs the image it was first created with for ever.
         */
        if (isOutOfDate(existing)) {
          await replaceTemplate(botId, "Running");
          console.info(
            JSON.stringify({
              type: "computer-sandbox-updated",
              botId,
              reason:
                "it was woken, and its image differed from the current one",
              from: imagesOf(existing.spec?.podTemplate),
              to: imagesOf(options.template.podTemplate),
            }),
          );
        } else {
          await call(`/${sandboxNameFor(botId)}`, {
            method: "PATCH",
            contentType: "application/merge-patch+json",
            body: JSON.stringify({ spec: { operatingMode: "Running" } }),
          });
        }
      }
      // A computer that is running on an older image is left alone here. It may be in the middle of
      // a task, and restarting it under the Bot is the person's decision, which is `update`.

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

    /**
     * Move this Bot's computer onto the current image now, keeping its files and sign-ins.
     *
     * A suspended computer has its template replaced and stays suspended: the next wake creates
     * its pod from the new one, and waking it now would spend a pod on nobody. A running one is
     * suspended with the new template in the same write, which sends the computer SIGTERM so its
     * browser saves its session and flushes its profile, and then resumed.
     *
     * The resume is not awaited. A suspend waits out a pod's grace period and a resume a pod
     * schedule and a browser launch, which together outlast the idle timeout of the load balancer in
     * front of a request. If this process dies before the resume, the computer is suspended on the
     * new image, and the next action wakes it exactly as it wakes an idle one.
     */
    async update(botId: string) {
      const sandbox = await read(botId);
      if (!sandbox) return { updated: false, wasRunning: false };
      const from = imagesOf(sandbox.spec?.podTemplate);
      const to = imagesOf(options.template.podTemplate);
      if (!isOutOfDate(sandbox)) {
        return { updated: false, wasRunning: !isSuspended(sandbox), from, to };
      }
      if (isSuspended(sandbox)) {
        await replaceTemplate(botId, "Suspended");
        return { updated: true, wasRunning: false, from, to };
      }
      const patched = await replaceTemplate(botId, "Suspended");
      const restarted = (async () => {
        await waitForSuspended(botId, patched?.metadata?.generation);
        // Reset while it was stopping: there is nothing left to bring back.
        if (!(await read(botId))) return;
        await call(`/${sandboxNameFor(botId)}`, {
          method: "PATCH",
          contentType: "application/merge-patch+json",
          body: JSON.stringify({ spec: { operatingMode: "Running" } }),
        });
        await waitForReady(botId);
      })();
      lastRestart.set(botId, restarted);
      restarted
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              type: "computer-sandbox-update-resume-failed",
              botId,
              reason: error instanceof Error ? error.message : String(error),
              note: "The computer is on its new image and suspended; the next action wakes it.",
            }),
          );
        })
        .finally(() => {
          if (lastRestart.get(botId) === restarted) lastRestart.delete(botId);
        });
      return { updated: true, wasRunning: true, from, to };
    },

    /** The restart an `update` started, for a test to wait on. Undefined once it has finished. */
    restarting(botId: string): Promise<void> | undefined {
      return lastRestart.get(botId);
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
          updateAvailable: isOutOfDate(sandbox),
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
       * A snapshot's generation only orders snapshots within one run of a browser: a resumed computer
       * counts from one again, so a ref the model still holds from before the suspend would match a
       * row nothing has overwritten, and the boundary would decide about an element on a page that no
       * longer exists.
       *
       * NOT THE NODE AND NOT THE POD IP, which is what this used and what testing a real resume
       * disproved. A suspended sandbox is very often rescheduled onto the same node and handed the
       * same address back, because nothing else has taken it: measured on EKS, both were byte for
       * byte identical across a suspend and resume, so the check would have said "same run" for the
       * exact case it exists to catch.
       *
       * The `Ready` condition's transition time does move, because suspending drives Ready to False
       * and resuming drives it back to True. It is the moment this run of the browser started
       * serving, which is precisely the question, and it needs no permission beyond the sandbox this
       * already reads. The pod's own UID would be exact too, and would cost a second read and the
       * right to list pods.
       *
       * Reading, never ensuring: this must not be the thing that wakes a computer up.
       */
      const sandbox = await read(botId);
      if (!sandbox || isSuspended(sandbox)) return undefined;
      const ready = sandbox.status?.conditions?.find(
        (condition) => condition.type === "Ready",
      );
      if (ready?.status !== "True") return undefined;
      return ready.lastTransitionTime;
    },
  };
}
