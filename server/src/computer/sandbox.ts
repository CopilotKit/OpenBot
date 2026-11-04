/**
 * A computer per person, and per isolated Bot, as a `Sandbox` on Kubernetes.
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
import { ComputerStillStartingError } from "./client";
import {
  type ComputerKey,
  type ComputerSeat,
  computerKeyText,
} from "./computer-key";
import { ownComputerToken } from "./computer-token";
import type {
  ComputerLocation,
  ComputerProvider,
  ComputerTarget,
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

/**
 * The pod template, cut for one computer: what the container is told about whose it is, as the supervisor tells each
 * container it starts (supervisor/src/environment.ts).
 *
 * A COMPUTER OF ONE ID (an isolated Bot's, or a person's own browser) is told the id (`COMPUTER_BOT_ID`), and keeps
 * its files at the root of its volume (`COMPUTER_SEPARATE_WORKSPACES=off`). The computer decides from the id whether a
 * person's browser may run on it (agent-computer's `person-access.ts`): without it, it reads as a computer Bots share
 * and refuses one. The root stays where it was because an isolated Bot keeps the Sandbox, and the volume, its Bot had
 * before computers were per person, with its files at the root; moving the root under it would hide every one
 * (agent-computer's `workspaces.ts`).
 *
 * A PERSON'S COMPUTER carries every Bot they use, so it names no Bot (anything it was given is taken out), is told whose
 * it is (`COMPUTER_PERSON_ID`, so Record runs in its Bots' browsers), and gives each Bot a folder of its own
 * (`COMPUTER_SEPARATE_WORKSPACES=on`), as each has a browser profile of its own.
 *
 * EVERY COMPUTER IS GIVEN ITS OWN TOKEN (`token`, computer-token.ts), and never the deployment's: whatever token the
 * template carried, a value or a reference to the deployment's Secret, is taken out. A Bot can read what its computer's
 * process was started with, and the deployment's token opens every other person's computer. The value is written into
 * the Sandbox itself rather than into a Secret of its own: a reference cannot reach a Secret in another namespace, which
 * is where computers can live (`computers.sandbox.namespace`), and writing one per computer would give the server
 * permission to create Secrets there, which it does not otherwise need. The value opens that one computer and nothing
 * else.
 *
 * The template itself is left as it was, since every computer is cut from it.
 */
export function podTemplateFor(
  podTemplate: unknown,
  key: ComputerKey,
  token?: string,
): unknown {
  const template = podTemplate as
    | { spec?: { containers?: Record<string, unknown>[] } }
    | undefined;
  const containers = template?.spec?.containers;
  if (!template?.spec || !Array.isArray(containers)) return podTemplate;
  const told =
    key.kind === "bot"
      ? [
          { name: "COMPUTER_BOT_ID", value: key.botId },
          { name: "COMPUTER_SEPARATE_WORKSPACES", value: "off" },
        ]
      : [
          { name: "COMPUTER_PERSON_ID", value: key.personId },
          { name: "COMPUTER_SEPARATE_WORKSPACES", value: "on" },
        ];
  return {
    ...template,
    spec: {
      ...template.spec,
      containers: containers.map((container) => {
        const env = Array.isArray(container.env)
          ? (container.env as { name?: unknown }[]).filter(
              (variable) =>
                variable.name !== "COMPUTER_BOT_ID" &&
                variable.name !== "COMPUTER_PERSON_ID" &&
                variable.name !== "COMPUTER_SEPARATE_WORKSPACES" &&
                variable.name !== COMPUTER_TOKEN,
            )
          : [];
        return {
          ...container,
          env: [
            ...env,
            ...told,
            ...(token ? [{ name: COMPUTER_TOKEN, value: token }] : []),
          ],
        };
      }),
    },
  };
}

const COMPUTER_TOKEN = "COMPUTER_TOKEN";

/**
 * Whether every container of a Sandbox's pod template holds `token`, the computer's own.
 *
 * A Sandbox created before computers had tokens of their own references the deployment's Secret instead, so it holds a
 * token the server no longer sends: every call to it is refused, and it carries the key to every other computer.
 */
function holdsToken(podTemplate: unknown, token: string): boolean {
  const containers =
    (podTemplate as { spec?: { containers?: { env?: unknown }[] } } | undefined)
      ?.spec?.containers ?? [];
  return containers.every((container) =>
    (Array.isArray(container.env) ? container.env : []).some(
      (variable: { name?: unknown; value?: unknown; valueFrom?: unknown }) =>
        variable.name === COMPUTER_TOKEN &&
        variable.value === token &&
        variable.valueFrom === undefined,
    ),
  );
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
  /**
   * The deployment's `COMPUTER_TOKEN`, from which each computer's own token is derived and written into its Sandbox.
   * Never written into one itself. Absent, a computer is given no token, and refuses to start, as without a token at all.
   */
  computerToken?: string;
  /** How long a computer is waited on to come back, by `update`'s restart and at most by `locate`. */
  resumeTimeoutMs?: number;
  /**
   * How long one `locate` waits before answering that the computer is still starting.
   *
   * Shorter than a resume can take ON PURPOSE. `locate` runs inside a person's request, and a load
   * balancer with the usual 60s idle timeout cuts a request that says nothing for longer: the browser
   * got a bare gateway error, the action could still land once the pod came up, and the model was
   * told it had failed. Answering before that line keeps the "not performed" true. Giving up costs
   * nothing, because the resume has already been written and the pod keeps coming up; the next call
   * waits again.
   */
  locateWaitMs?: number;
};

/** See `locateWaitMs`. Under a 60s load balancer idle timeout, with room for the call itself. */
const LOCATE_WAIT_MS = 45_000;

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
 * A Kubernetes name for a computer: a person's, or an isolated Bot's.
 *
 * Ids are ours and may hold anything; a resource name may hold lowercase alphanumerics and dashes,
 * and is refused rather than truncated by the API server. Anything else becomes a dash, and a short
 * hash keeps two ids that differ only in punctuation from colliding on one computer, which would be
 * one person reading another's logins.
 *
 * An isolated Bot's name is exactly the one every Bot's computer had before computers were per
 * person, so an isolated Bot keeps the Sandbox, and the logins, it already had. A person's starts
 * `person-`, which no Bot's can.
 */
export function sandboxNameFor(key: ComputerKey | string): string {
  const resolved: ComputerKey =
    typeof key === "string" ? { kind: "bot", botId: key } : key;
  const id = resolved.kind === "bot" ? resolved.botId : resolved.personId;
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  let hash = 5381;
  for (let index = 0; index < id.length; index += 1) {
    hash = ((hash << 5) + hash + id.charCodeAt(index)) >>> 0;
  }
  const suffix = hash.toString(36);
  const prefix = resolved.kind === "bot" ? "bot" : "person";
  return `${prefix}-${slug.slice(0, 40) || "unnamed"}-${suffix}`;
}

/** Whose computer a Sandbox is, from the annotations it was created with. */
function keyOfSandbox(sandbox: Sandbox): ComputerKey {
  const annotations =
    (sandbox.metadata as { annotations?: Record<string, string> })
      ?.annotations ?? {};
  const person = annotations["openbot.dev/person-id"];
  if (person) return { kind: "person", personId: person };
  return {
    kind: "bot",
    botId: annotations["openbot.dev/bot-id"] ?? sandbox.metadata?.name ?? "",
  };
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
  update(key: ComputerKey): Promise<ComputerUpdate>;
  restarting(key: ComputerKey): Promise<void> | undefined;
} {
  const doFetch = options.fetchImpl ?? fetch;
  const resumeTimeoutMs = options.resumeTimeoutMs ?? 120_000;
  const locateWaitMs = Math.min(
    resumeTimeoutMs,
    options.locateWaitMs ?? LOCATE_WAIT_MS,
  );
  /** Restarts started by `update` and not yet finished, one per computer. */
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

  const read = (key: ComputerKey) =>
    call(`/${sandboxNameFor(key)}`) as Promise<Sandbox | undefined>;

  /** This computer's own token, or none where the deployment set none. */
  const tokenOf = (key: ComputerKey) =>
    options.computerToken
      ? ownComputerToken(options.computerToken, key)
      : undefined;

  /** The pod template for this computer, cut from the mounted one. */
  const templateFor = (key: ComputerKey) =>
    podTemplateFor(options.template.podTemplate, key, tokenOf(key));

  /** Whether this Sandbox holds the token the server sends it. See {@link holdsToken}. */
  function holdsOwnToken(sandbox: Sandbox, key: ComputerKey): boolean {
    const token = tokenOf(key);
    return token === undefined || holdsToken(sandbox.spec?.podTemplate, token);
  }

  /** The desired body for a computer. Created once, then only ever patched. */
  function desired(key: ComputerKey): Record<string, unknown> {
    return {
      apiVersion: `${GROUP}/${VERSION}`,
      kind: "Sandbox",
      metadata: {
        name: sandboxNameFor(key),
        namespace: options.namespace,
        labels: {
          "app.kubernetes.io/managed-by": "openbot",
          "openbot.dev/component": "computer",
        },
        // Whose computer, as written, which the name above cannot always carry. The listing and the
        // culler read this rather than trying to reverse the slug.
        annotations:
          key.kind === "person"
            ? {
                "openbot.dev/person-id": key.personId,
                "openbot.dev/computer": computerKeyText(key),
              }
            : {
                "openbot.dev/bot-id": key.botId,
                "openbot.dev/computer": computerKeyText(key),
              },
      },
      spec: {
        operatingMode: "Running",
        // `podTemplate` is required and `volumeClaimTemplates` is what makes a suspend worth doing,
        // and both arrive together from the mounted template.
        ...options.template,
        podTemplate: templateFor(key),
      },
    };
  }

  async function waitForReady(
    key: ComputerKey,
    budgetMs: number = resumeTimeoutMs,
  ): Promise<Sandbox> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const sandbox = await read(key);
      if (sandbox && isReady(sandbox) && sandbox.status?.serviceFQDN) {
        return sandbox;
      }
      if (Date.now() >= deadline) {
        /*
         * A resume costs a pod schedule and a browser launch, so this is a real wait rather than a
         * failure, but it has to end somewhere. When it does, the caller is told the computer is
         * still starting and nothing was done, which is the truth: the pod is very likely seconds
         * away. The operator's version, with the Bot and the budget, goes to the log.
         */
        console.warn(
          JSON.stringify({
            type: "computer-sandbox-still-starting",
            computer: computerKeyText(key),
            waitedMs: budgetMs,
          }),
        );
        throw new ComputerStillStartingError();
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  /**
   * Whether this computer runs a different image from the one a new computer would get, or holds a token other than
   * its own (one from before computers had their own, which the server no longer sends).
   */
  function isOutOfDate(sandbox: Sandbox, key: ComputerKey): boolean {
    return (
      imagesOf(sandbox.spec?.podTemplate) !==
        imagesOf(options.template.podTemplate) || !holdsOwnToken(sandbox, key)
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
    key: ComputerKey,
    operatingMode: "Running" | "Suspended",
  ): Promise<Sandbox | undefined> {
    return (await call(`/${sandboxNameFor(key)}`, {
      method: "PATCH",
      contentType: "application/json-patch+json",
      body: JSON.stringify([
        {
          op: "replace",
          path: "/spec/podTemplate",
          value: templateFor(key),
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
    key: ComputerKey,
    generation: number | undefined,
    budgetMs: number = resumeTimeoutMs,
  ): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const sandbox = await read(key);
      if (!sandbox) return true;
      const suspended = sandbox.status?.conditions?.find(
        (condition) => condition.type === "Suspended",
      );
      if (
        suspended?.status === "True" &&
        (generation === undefined ||
          (suspended.observedGeneration ?? 0) >= generation)
      ) {
        return true;
      }
      // Not a verdict here: whoever asked says what running out of time means.
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  /**
   * Whether a Sandbox being suspended has lost its pod yet: its Suspended condition, at the generation it is now.
   *
   * Only asked of one whose spec says Suspended. One whose spec says Running is not being suspended, whatever an old
   * condition says, and a Sandbox whose controller reports no Suspended condition at all says nothing either way: both
   * are taken as they were before this was asked.
   */
  function suspendSettled(sandbox: Sandbox): boolean {
    if (sandbox.spec?.operatingMode !== "Suspended") return true;
    const suspended = sandbox.status?.conditions?.find(
      (condition) => condition.type === "Suspended",
    );
    if (!suspended) return true;
    const generation = sandbox.metadata?.generation;
    return (
      suspended.status === "True" &&
      (generation === undefined ||
        (suspended.observedGeneration ?? 0) >= generation)
    );
  }

  /** The caller is told the computer is still starting, as `waitForReady` does when its wait runs out. */
  function stillStarting(key: ComputerKey, waitedMs: number): never {
    console.warn(
      JSON.stringify({
        type: "computer-sandbox-still-starting",
        computer: computerKeyText(key),
        waitedMs,
      }),
    );
    throw new ComputerStillStartingError();
  }

  /** `work`, or the still-starting answer once `budgetMs` has passed. `work` goes on either way. */
  async function within<T>(
    key: ComputerKey,
    work: Promise<T>,
    budgetMs: number,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), budgetMs);
    });
    try {
      const outcome = await Promise.race([work, late]);
      if (outcome === "late") return stillStarting(key, budgetMs);
      return outcome as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Bring a Sandbox whose template was just replaced with `operatingMode: Suspended` back up on it: wait for the old
   * pod to be gone, resume, and wait for the new one. The only way the controller replaces a pod (`replaceTemplate`).
   *
   * Remembered per computer until it finishes, so a `locate` meanwhile waits for it rather than resuming the Sandbox
   * under it, which would leave the old pod, on its old template, running. A failure is logged here: the computer is
   * on its new template and suspended, and the next action wakes it as it wakes an idle one.
   */
  function restart(
    key: ComputerKey,
    generation: number | undefined,
  ): Promise<void> {
    const id = computerKeyText(key);
    const restarted = (async () => {
      if (!(await waitForSuspended(key, generation))) {
        throw new SandboxError(
          `The computer for ${computerKeyText(key)} did not stop within ${Math.round(resumeTimeoutMs / 1000)}s to take its new image.`,
        );
      }
      // Reset while it was stopping: there is nothing left to bring back.
      if (!(await read(key))) return;
      await call(`/${sandboxNameFor(key)}`, {
        method: "PATCH",
        contentType: "application/merge-patch+json",
        body: JSON.stringify({ spec: { operatingMode: "Running" } }),
      });
      await waitForReady(key);
    })();
    lastRestart.set(id, restarted);
    restarted
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            type: "computer-sandbox-update-resume-failed",
            computer: id,
            reason: error instanceof Error ? error.message : String(error),
            note: "The computer is on its new image and suspended; the next action wakes it.",
          }),
        );
      })
      .finally(() => {
        if (lastRestart.get(id) === restarted) lastRestart.delete(id);
      });
    return restarted;
  }

  return {
    name: "sandbox",
    isolation: "per-person",

    /** The token written into this computer's Sandbox: its own, never the deployment's. See `podTemplateFor`. */
    tokenFor: (key, deploymentToken) => ownComputerToken(deploymentToken, key),

    /**
     * The computer this seat is on, creating or waking it.
     *
     * A private Bot's profile from before computers were per person is NOT carried over here. Each
     * Sandbox's volumes come from its own immutable `volumeClaimTemplates`, and a copy would need a
     * pod that mounts the old Bot's claim and the person's at once while both are on one node. That
     * is a migration job, not a request handler; the old Bot's Sandbox and its volume are left as
     * they were (listed, and suspended when idle), so nothing is lost if it is ever wanted.
     */
    async locate(seat: ComputerSeat): Promise<string> {
      const key = seat.key;
      // One budget for every wait below, so the person's request is answered inside it (`locateWaitMs`).
      const deadline = Date.now() + locateWaitMs;
      const left = () => Math.max(0, deadline - Date.now());
      // A restart already under way is finished first, never resumed under (see `restart`).
      const pending = lastRestart.get(computerKeyText(key));
      if (pending) await within(key, pending, left());
      const existing = await read(key);
      if (!existing) {
        await call("", {
          method: "POST",
          contentType: "application/json",
          body: JSON.stringify(desired(key)),
        });
      } else if (isSuspended(existing)) {
        /*
         * Its old pod gone first, when it is still going: suspended by a restart on another server, or by the culler a
         * moment ago. Resumed before that, the controller keeps the pod it has, cut from the template it had, and a new
         * template (a new image, the computer's own token) would never reach it.
         */
        if (
          !suspendSettled(existing) &&
          !(await waitForSuspended(key, existing.metadata?.generation, left()))
        ) {
          stillStarting(key, locateWaitMs);
        }
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
        if (isOutOfDate(existing, key)) {
          await replaceTemplate(key, "Running");
          console.info(
            JSON.stringify({
              type: "computer-sandbox-updated",
              computer: computerKeyText(key),
              reason: holdsOwnToken(existing, key)
                ? "it was woken, and its image differed from the current one"
                : "it was woken, and it held a token other than its own",
              from: imagesOf(existing.spec?.podTemplate),
              to: imagesOf(options.template.podTemplate),
            }),
          );
        } else {
          await call(`/${sandboxNameFor(key)}`, {
            method: "PATCH",
            contentType: "application/merge-patch+json",
            body: JSON.stringify({ spec: { operatingMode: "Running" } }),
          });
        }
      } else if (!holdsOwnToken(existing, key)) {
        /*
         * RUNNING, AND HOLDING A TOKEN OTHER THAN ITS OWN: made before computers had their own, so it holds the
         * deployment's. Every call the server makes to it is refused, so leaving it is not leaving a working computer
         * alone, and it carries the key to every other person's computer to whatever runs on it. Restarted onto its own
         * token the way `update` restarts one onto a new image, which keeps its volumes, its files and its sign-ins.
         */
        const patched = await replaceTemplate(key, "Suspended");
        console.info(
          JSON.stringify({
            type: "computer-sandbox-updated",
            computer: computerKeyText(key),
            reason: "it held a token other than its own",
          }),
        );
        await within(key, restart(key, patched?.metadata?.generation), left());
      }
      // A computer that is running on an older image is left alone here. It may be in the middle of
      // a task, and restarting it under the Bot is the person's decision, which is `update`.

      const ready = await waitForReady(key, left());
      const fqdn = ready.status?.serviceFQDN;
      if (!fqdn) {
        throw new SandboxError(
          `The computer for ${computerKeyText(key)} is ready but reported no address, so it cannot be reached.`,
        );
      }
      return `http://${fqdn}:4100`;
    },

    async status(seat: ComputerSeat): Promise<ComputerStatus> {
      const botId = seat.botId;
      try {
        const sandbox = await read(seat.key);
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

    async stop(target: ComputerTarget): Promise<{ wasRunning: boolean }> {
      const sandbox = await read(target.key);
      if (!sandbox || isSuspended(sandbox)) return { wasRunning: false };
      // Suspended, not deleted: the pod goes and the volumes stay, which is the difference between
      // stopping a computer and wiping its logins.
      await call(`/${sandboxNameFor(target.key)}`, {
        method: "PATCH",
        contentType: "application/merge-patch+json",
        body: JSON.stringify({ spec: { operatingMode: "Suspended" } }),
      });
      return { wasRunning: true };
    },

    async reset(target: ComputerTarget): Promise<{ cleared: boolean }> {
      const sandbox = await read(target.key);
      if (!sandbox) return { cleared: false };
      // Deleted, which takes the volumes with it. This is the one that is meant to lose the logins,
      // and on a person's computer it is every Bot's there.
      await call(`/${sandboxNameFor(target.key)}`, { method: "DELETE" });
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
    async update(key: ComputerKey) {
      const sandbox = await read(key);
      if (!sandbox) return { updated: false, wasRunning: false };
      const from = imagesOf(sandbox.spec?.podTemplate);
      const to = imagesOf(options.template.podTemplate);
      if (!isOutOfDate(sandbox, key)) {
        return { updated: false, wasRunning: !isSuspended(sandbox), from, to };
      }
      if (isSuspended(sandbox)) {
        await replaceTemplate(key, "Suspended");
        return { updated: true, wasRunning: false, from, to };
      }
      const patched = await replaceTemplate(key, "Suspended");
      // Not awaited: see above. Its failure is logged by `restart`.
      void restart(key, patched?.metadata?.generation).catch(() => undefined);
      return { updated: true, wasRunning: true, from, to };
    },

    /** The restart an `update` started, for a test to wait on. Undefined once it has finished. */
    restarting(key: ComputerKey): Promise<void> | undefined {
      return lastRestart.get(computerKeyText(key));
    },

    async list(): Promise<ComputerLocation[]> {
      const body = (await call("")) as { items?: Sandbox[] } | undefined;
      return (body?.items ?? []).map((sandbox) => {
        return {
          key: keyOfSandbox(sandbox),
          status:
            isSuspended(sandbox) || !isReady(sandbox) ? "stopped" : "running",
          updateAvailable: isOutOfDate(sandbox, keyOfSandbox(sandbox)),
          url: sandbox.status?.serviceFQDN
            ? `http://${sandbox.status.serviceFQDN}:4100`
            : "",
          ...(sandbox.metadata?.creationTimestamp
            ? { startedAt: sandbox.metadata.creationTimestamp }
            : {}),
        };
      });
    },

    async sessionOf(seat: ComputerSeat): Promise<string | undefined> {
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
      const sandbox = await read(seat.key);
      if (!sandbox || isSuspended(sandbox)) return undefined;
      const ready = sandbox.status?.conditions?.find(
        (condition) => condition.type === "Ready",
      );
      if (ready?.status !== "True") return undefined;
      return ready.lastTransitionTime;
    },
  };
}
