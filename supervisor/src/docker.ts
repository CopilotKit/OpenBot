import Docker from "dockerode";
import {
  BOT_LABEL,
  type ComputerNames,
  DEFAULT_NAMESPACE,
  NAMESPACE,
  NAMESPACE_LABEL,
  OWNER_LABEL,
} from "./names";

/**
 * The only Docker this service knows how to do.
 *
 * `dockerode` provides Engine API stream handling, error shapes and version negotiation.
 *
 * There is no passthrough. There is no generic "run this Docker call" here,
 * because the whole reason the API server does not hold the socket is that the socket is unrestricted
 * root on the host, a supervisor that forwarded arbitrary calls would hand that straight back
 * through a politer door. Four verbs, expressed in Bots, and nothing else.
 *
 * Every write is scoped by ownership. Containers are created carrying `openbot.supervisor`, and
 * stop, reset and inspect refuse anything without it. A container whose name happens to match but
 * lacks the label is treated as absent.
 */

const docker = new Docker(
  process.env.DOCKER_SOCKET
    ? { socketPath: process.env.DOCKER_SOCKET }
    : undefined,
);

/** The port the computer listens on inside its own container. */
const COMPUTER_PORT = "4100/tcp";

/**
 * How many times `ensure` will build a computer before giving up.
 *
 * One retry, because the only thing being retried is losing a race to another request for the same
 * Bot. A second loss means something else is removing the container, and retrying forever would hide
 * that behind a hung request.
 */
const ATTEMPTS = 2;

function statusOf(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

export type ComputerState = {
  botId: string;
  container: string;
  status: string;
  /** When this computer started, so a surface can say how long it has been up. */
  startedAt?: string;
  /** Its published port, when it has one. Absent on a shared network, where nothing is published. */
  port?: number;
  /** Where to reach it, however it is arranged. */
  url?: string;
};

export class DockerUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `The supervisor could not reach Docker (${cause}). A computer cannot be started without it.`,
    );
    this.name = "DockerUnavailableError";
  }
}

export async function reachable(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

function portOf(ports?: Docker.Port[] | undefined): number | undefined {
  const published = ports?.find((p) => p.PrivatePort === 4100)?.PublicPort;
  return published ?? undefined;
}

/**
 * Whether a labelled thing belongs to this deployment.
 *
 * Containers created before the namespace label existed carry the default namespace, so an existing
 * deployment keeps its own computers across an upgrade.
 */
function ours(labels: Record<string, string> | undefined): boolean {
  if (labels?.[OWNER_LABEL] !== "true") return false;
  return (labels[NAMESPACE_LABEL] ?? DEFAULT_NAMESPACE) === NAMESPACE;
}

/** The labels every container and volume this supervisor creates carries. */
function labelsFor(names: ComputerNames): Record<string, string> {
  return {
    [OWNER_LABEL]: "true",
    [BOT_LABEL]: names.botId,
    [NAMESPACE_LABEL]: NAMESPACE,
  };
}

/** Every computer this supervisor owns, and only those. */
export async function listOwned(): Promise<ComputerState[]> {
  try {
    const containers = (
      await docker.listContainers({
        all: true,
        filters: { label: [`${OWNER_LABEL}=true`] },
      })
    ).filter((container) => ours(container.Labels));
    return containers.map((container) => ({
      botId: container.Labels?.[BOT_LABEL] ?? "unknown",
      container: (container.Names?.[0] ?? "").replace(/^\//, ""),
      status: container.State,
      ...(container.Created
        ? { startedAt: new Date(container.Created * 1000).toISOString() }
        : {}),
      ...(portOf(container.Ports) ? { port: portOf(container.Ports) } : {}),
    }));
  } catch (error) {
    throw new DockerUnavailableError(String(error));
  }
}

/**
 * One computer, if this supervisor owns it.
 *
 * Ownership is checked here rather than at the call sites, so no verb can skip it by accident.
 */
async function inspectOwned(
  names: ComputerNames,
): Promise<{ status: string; port?: number } | null> {
  try {
    const info = await docker.getContainer(names.container).inspect();
    if (!ours(info.Config?.Labels)) return null;
    const published =
      info.NetworkSettings?.Ports?.[COMPUTER_PORT]?.[0]?.HostPort;
    return {
      status: info.State?.Status ?? "unknown",
      ...(published ? { port: Number.parseInt(published, 10) } : {}),
    };
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return null;
    throw new DockerUnavailableError(String(error));
  }
}

/**
 * Wait until the computer actually answers.
 *
 * "Started" and "ready" are not the same thing, and the gap is seconds: Docker reports running as
 * soon as the process exists, while the computer inside is still starting. A caller told a computer
 * is ready and then refused by it cannot tell that from a broken one, so `ensure` waits.
 *
 * Asked of Docker, not over the network. Reaching the computer directly needs an address, and which
 * address works depends on how the deployment is wired: `127.0.0.1:<published port>` is right only
 * when the supervisor runs on the host, and the container name resolves only when both containers
 * share a network.
 *
 * The image carries a HEALTHCHECK, so Docker already knows the answer and can be asked from anywhere
 * the supervisor can reach the socket, which it must, or it could not have created the container.
 */
async function waitUntilAnswering(
  container: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = await docker.getContainer(container).inspect();
      const health = info.State?.Health?.Status;
      // An image without a HEALTHCHECK reports nothing. Waiting forever for an answer that will
      // never come would be worse than going ahead, so running is accepted as the best available.
      if (!health) {
        if (info.State?.Running) return;
      } else if (health === "healthy") {
        return;
      }
    } catch {
      // Mid-creation, or gone. The deadline is what ends this.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export type EnsureOptions = {
  image: string;
  /** Passed to the computer so a Bot's traffic still leaves by the route configured for it. */
  environment: string[];
  /** A network to join, when the supervisor runs alongside a compose stack. */
  network?: string;
  /**
   * The container runtime. Left unset this is Docker's default, which shares the host kernel.
   * Setting `runsc` runs each computer under gVisor, which intercepts syscalls in user space and is
   * the pragmatic middle ground for untrusted Bot code. A deployment that wants a kernel per Bot
   * points this at a microVM runtime instead.
   */
  runtime?: string;
  memoryBytes?: number;
  pidsLimit?: number;
  /**
   * The volume holding the SPIRE agent's Workload API socket, mounted read-only into each computer
   * so it can ask what it is. Unset means no identity, which is a deployment choice rather than a
   * failure.
   */
  spireSocketVolume?: string;
};

/**
 * Confinement applied to every computer.
 *
 * A container is a boundary only if it is configured as one. Each of these closes a specific route
 * off the host, and none of them costs a Bot anything it legitimately needs: a browser and a
 * filesystem under `/workspace`.
 */
function hostConfig(names: ComputerNames, options: EnsureOptions) {
  return {
    // The Bot's own storage. This is what turns the path confinement inside the computer from a
    // boundary between a Bot and the host into a boundary between one Bot and another.
    Binds: [
      `${names.profileVolume}:/profiles`,
      `${names.workspaceVolume}:/workspace`,
      // Read-only: a computer asks the agent what it is and has nothing to tell it.
      ...(options.spireSocketVolume
        ? [`${options.spireSocketVolume}:/tmp/spire-agent/public:ro`]
        : []),
    ],
    // On a shared network the computers are reached by name and nothing is published: a remote host
    // should not accumulate an open port per Bot. Off a network, a laptop, where the server runs
    // outside Docker, an ephemeral host port is the only way in, and it is reported back so nothing
    // has to guess and two computers never contend for the same number.
    ...(options.network
      ? {}
      : {
          // Loopback, not the world. An unqualified binding publishes on 0.0.0.0, which would put
          // every Bot's computer within reach of anything that can route to this machine. The token
          // the computer requires is the control; this keeps the surface off the network as well,
          // because both is the right number of locks on a browser holding somebody's logins.
          PortBindings: {
            [COMPUTER_PORT]: [{ HostIp: "127.0.0.1", HostPort: "" }],
          },
        }),
    RestartPolicy: { Name: "unless-stopped" },
    ...(options.network ? { NetworkMode: options.network } : {}),
    ...(options.runtime ? { Runtime: options.runtime } : {}),

    // No path from inside to more privilege than it started with, whatever it manages to run.
    SecurityOpt: ["no-new-privileges:true"],
    // Chromium needs none of these, and each is a documented container escape route.
    CapDrop: ["ALL"],
    // A runaway Bot is a resource problem for itself, not for every other Bot on the host.
    ...(options.memoryBytes ? { Memory: options.memoryBytes } : {}),
    PidsLimit: options.pidsLimit ?? 512,
    // Chromium's sandbox wants shared memory and will crash on the 64MB default.
    ShmSize: 1_073_741_824,
  };
}

/**
 * Make sure this Bot has a computer, and say where to reach it.
 *
 * Idempotent because the caller is a request handler that can run concurrently with itself: two
 * messages to one Bot at the same moment must not race into two containers. An existing owned
 * container is started if stopped, and otherwise left exactly as it is.
 */
export async function ensure(
  names: ComputerNames,
  options: EnsureOptions,
): Promise<ComputerState> {
  for (let attempt = ATTEMPTS; attempt > 0; attempt--) {
    const existing = await inspectOwned(names);

    if (!existing) {
      for (const volume of [names.profileVolume, names.workspaceVolume]) {
        try {
          await docker.createVolume({
            Name: volume,
            Labels: labelsFor(names),
          });
        } catch (error) {
          // Already exists is success for a restarted supervisor.
          if (statusOf(error) !== 409) {
            throw new DockerUnavailableError(String(error));
          }
        }
      }

      try {
        await docker.createContainer({
          name: names.container,
          Image: options.image,
          // The Bot id is a label because that is what a SPIRE docker workload attestor selects on:
          // an identity per Bot then falls out of the same fact that names the container.
          Labels: labelsFor(names),
          Env: options.environment,
          ExposedPorts: { [COMPUTER_PORT]: {} },
          HostConfig: hostConfig(names, options),
        });
      } catch (error) {
        // The other request creating the same computer got there first, which is what idempotent
        // means here. Its container is the one this request goes on to start.
        if (statusOf(error) !== 409) {
          throw new DockerUnavailableError(String(error));
        }
      }
    }

    if (existing?.status !== "running") {
      try {
        await docker.getContainer(names.container).start();
      } catch (error) {
        const status = statusOf(error);
        // Gone between creating it and starting it: a concurrent reset took the container away, or
        // the create this request lost the race to was itself rolled back. Nothing about the Bot has
        // changed, so the answer is to build it again rather than to report Docker as unreachable.
        if (status === 404 && attempt > 1) continue;
        // 304 is "already running", which is success for an idempotent verb.
        if (status !== 304) {
          throw new DockerUnavailableError(String(error));
        }
      }
    }

    const settled = await inspectOwned(names);
    await waitUntilAnswering(names.container);

    return {
      botId: names.botId,
      container: names.container,
      status: settled?.status ?? "unknown",
      ...(settled?.port ? { port: settled.port } : {}),
      // How to reach it. A name on a shared network, a host port otherwise, the caller does not have
      // to know which arrangement it is in.
      ...(options.network
        ? { url: `http://${names.container}:4100` }
        : settled?.port
          ? { url: `http://127.0.0.1:${settled.port}` }
          : {}),
    };
  }

  throw new DockerUnavailableError(
    `The computer for ${names.botId} was removed while it was being started.`,
  );
}

/** Stop this Bot's computer. Its storage is untouched, so its logins survive. */
export async function stop(names: ComputerNames): Promise<boolean> {
  if (!(await inspectOwned(names))) return false;
  try {
    // Long enough for Chromium to flush its profile, matching the compose grace period.
    await docker.getContainer(names.container).stop({ t: 30 });
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== 304 && status !== 404) {
      throw new DockerUnavailableError(String(error));
    }
  }
  return true;
}

/**
 * Throw this Bot's computer away so the next request builds a clean one.
 *
 * The profile goes with it. The workspace is left alone: files a Bot was asked to produce are work,
 * not browser state.
 */
export async function reset(names: ComputerNames): Promise<boolean> {
  if (!(await inspectOwned(names))) return false;

  try {
    await docker
      .getContainer(names.container)
      .remove({ force: true, v: false });
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) {
      throw new DockerUnavailableError(String(error));
    }
  }

  try {
    await docker.getVolume(names.profileVolume).remove();
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    // 409 is "still in use", which resolves itself once the container is gone.
    if (status !== 404 && status !== 409) {
      throw new DockerUnavailableError(String(error));
    }
  }
  return true;
}
