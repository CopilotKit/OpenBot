import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type Docker from "dockerode";
import { namesFor, NAMESPACE } from "../../src/names";

// Launched by docker.integration.test.ts in a fresh process: names.ts reads its namespace once.
const namespace = NAMESPACE;
if (
  !namespace.startsWith("supervisor-test-") ||
  namespace !== process.env.COMPUTER_NAMESPACE
) {
  throw new Error(
    "This fixture requires its own supervisor-test namespace before importing the supervisor.",
  );
}

const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";

const { default: DockerClient } = await import("dockerode");
const supervisor = await import("../../src/docker");
const runtime: { docker: Docker; supervisor: typeof supervisor } = {
  docker: new DockerClient({ socketPath: SOCKET }),
  supervisor,
};
if (!(await supervisor.reachable()))
  throw new Error("The parent verified Docker; the child must run every case.");
function withDocker() {
  return runtime;
}

const IMAGE = `openbot-supervisor-fixture:${namespace}-one`;
const OTHER = `openbot-supervisor-fixture:${namespace}-two`;
const fixtureImages: string[] = [];

const BOT = "supervisortestbot";
const result = namesFor(BOT);
if (!result.ok) throw new Error(result.reason);
const names = result.names;

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === 404
  );
}

async function remove(container: string) {
  const docker = withDocker().docker;
  try {
    const info = await docker.getContainer(container).inspect();
    const labels = info.Config?.Labels;
    if (
      labels?.["openbot.test-fixture"] !== namespace &&
      !(
        labels?.["openbot.namespace"] === namespace &&
        labels?.["openbot.bot-id"] === BOT
      )
    ) {
      throw new Error("Refusing to clean a container outside this fixture.");
    }
    await docker.getContainer(info.Id).remove({ force: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function createdAt(volume: Docker.VolumeInspectInfo): string {
  // Engine API exposes CreatedAt, but the installed Dockerode declarations omit it.
  if ("CreatedAt" in volume && typeof volume.CreatedAt === "string")
    return volume.CreatedAt;
  throw new Error("The daemon did not return a volume creation time.");
}

async function removeVolumes() {
  for (const volume of [names.profileVolume, names.workspaceVolume]) {
    try {
      const info = await withDocker().docker.getVolume(volume).inspect();
      if (
        info.Labels?.["openbot.namespace"] !== namespace ||
        info.Labels?.["openbot.bot-id"] !== BOT
      ) {
        throw new Error("Refusing to clean a volume outside this fixture.");
      }
      await withDocker().docker.getVolume(volume).remove();
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

beforeAll(async () => {
  // Refuse even an improbable collision before any cleanup or creation.
  for (const resource of [
    withDocker().docker.getContainer(names.container),
    withDocker().docker.getVolume(names.profileVolume),
    withDocker().docker.getVolume(names.workspaceVolume),
  ]) {
    try {
      await resource.inspect();
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    throw new Error("A fixture resource name was already present.");
  }
  for (const [index, tag] of [IMAGE, OTHER].entries()) {
    const stream = await withDocker().docker.buildImage(
      { context: import.meta.dir, src: ["Dockerfile"] },
      {
        t: tag,
        buildargs: {
          FIXTURE_NAMESPACE: namespace,
          FIXTURE_VARIANT: String(index),
        },
      },
    );
    await new Promise<void>((resolve, reject) => {
      withDocker().docker.modem.followProgress(stream, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    const image = await withDocker().docker.getImage(tag).inspect();
    fixtureImages.push(image.Id);
  }
  expect(fixtureImages[0]).not.toBe(fixtureImages[1]);
}, 180_000);

let completedCases = 0;
afterAll(async () => {
  await remove(names.container);
  await removeVolumes();
  for (const image of fixtureImages) {
    const info = await withDocker().docker.getImage(image).inspect();
    if (info.Config.Labels?.["openbot.test-fixture"] !== namespace)
      throw new Error("Foreign fixture image");
    await withDocker().docker.getImage(image).remove();
  }
  console.log(
    "SUPERVISOR_FIXTURE " +
      JSON.stringify({
        namespace,
        names,
        fixtureImages,
        completedCases,
        cleanup: "complete",
      }),
  );
});

async function plant(labels: Record<string, string>, health?: boolean) {
  await remove(names.container);
  await withDocker().docker.createContainer({
    name: names.container,
    Image: IMAGE,
    Labels: { ...labels, "openbot.test-fixture": namespace },
    ...(health
      ? {}
      : {
          Cmd: ["sleep", "600"],
          Healthcheck: {
            Test: ["CMD-SHELL", "exit 1"],
            Interval: 1_000_000_000,
            Retries: 1,
            StartPeriod: 0,
          },
        }),
  });
}

const OURS = {
  "openbot.supervisor": "true",
  "openbot.namespace": namespace,
  "openbot.bot-id": BOT,
};

afterEach(async () => {
  await remove(names.container);
  await removeVolumes();
  completedCases += 1;
});

describe("a name held by somebody else", () => {
  test("is refused rather than adopted, and never started", async () => {
    // The container this supervisor did not make. Ownership is checked everywhere else so that a
    // name collision reads as absent; starting it on a 409 was the path that adopted it instead,
    // and an adopted container receives the deployment's computer token.
    await plant({ "someone.else": "true" });

    await expect(
      withDocker().supervisor.ensure(names, { image: IMAGE, environment: [] }),
    ).rejects.toBeInstanceOf(withDocker().supervisor.NameHeldError);

    const info = await withDocker()
      .docker.getContainer(names.container)
      .inspect();
    expect(info.State?.Running).toBe(false);
  }, 90_000);

  test("but a container this supervisor owns is still started", async () => {
    // The other direction, and the reason the check is ownership rather than existence: `ensure` is
    // idempotent, so the container a previous call left stopped has to come back up.
    await plant(OURS, true);

    const state = await withDocker().supervisor.ensure(names, {
      image: IMAGE,
      environment: [],
    });

    expect(state.status).toBe("running");
  }, 90_000);
});

describe("a computer that never answers", () => {
  test("fails instead of being handed out as ready", async () => {
    // A wait that cannot fail is a sleep: every computer that never came up was reported ready, and
    // the caller learned otherwise by sending it the deployment's token and getting a transport
    // error back.
    await plant(OURS);

    await expect(
      withDocker().supervisor.ensure(names, {
        image: IMAGE,
        environment: [],
        readyTimeoutMs: 3_000,
      }),
    ).rejects.toBeInstanceOf(withDocker().supervisor.ComputerNotAnsweringError);
  }, 90_000);
});

describe("a computer built from an older image", () => {
  /*
   * The upgrade that never reached the computers.
   *
   * `ensure` reused any container with the right name whatever it was built from, so once a Bot had
   * a computer, rebuilding the image moved the tag and the container went on running the old one
   * indefinitely, with nothing to say so. `docker compose down` does not touch these either, because
   * the supervisor makes them rather than compose, so even a full teardown left them behind.
   *
   * Found by rebuilding every image, restarting the whole stack, and watching a Bot's computer
   * answer with in-memory state from an hour before: a handover prompt about a page from a previous
   * conversation, offered on a new one.
   *
   * Two different images rather than a rebuild of one, because what the code compares is the
   * resolved id on either side and two tags is the cheapest way to have two of those.
   */
  test("is replaced, and keeps its profile and workspace", async () => {
    // A computer this supervisor owns, made the way it makes them, on the wrong image.
    await withDocker().supervisor.ensure(names, {
      image: OTHER,
      environment: [],
    });
    const before = await withDocker()
      .docker.getContainer(names.container)
      .inspect();

    // Record the actual named volume identities before replacement.
    // Volumes outlive the container by not being removed with it; that is what makes replacing one
    // safe, and it is the whole reason this fix is allowed to be automatic.
    const volumes = await Promise.all(
      [names.profileVolume, names.workspaceVolume].map((volume) =>
        withDocker().docker.getVolume(volume).inspect(),
      ),
    );

    const state = await withDocker().supervisor.ensure(names, {
      image: IMAGE,
      environment: [],
    });
    const after = await withDocker()
      .docker.getContainer(names.container)
      .inspect();

    expect(state).not.toBeNull();
    // A different container, on the image asked for.
    expect(before.State.Health?.Status).toBe("healthy");
    expect(after.State.Health?.Status).toBe("healthy");
    expect(after.Id).not.toBe(before.Id);
    expect(after.Image).not.toBe(before.Image);

    const wanted = await withDocker().docker.getImage(IMAGE).inspect();
    expect(after.Image).toBe(wanted.Id);

    // The same volumes, not replacements: a Bot keeps its logins and its files across an upgrade.
    const kept = await Promise.all(
      [names.profileVolume, names.workspaceVolume].map((volume) =>
        withDocker().docker.getVolume(volume).inspect(),
      ),
    );
    expect(kept.map(createdAt)).toEqual(volumes.map(createdAt));
  }, 180_000);

  test("is left alone when it is already the image asked for", async () => {
    /*
     * The other half, and the one that keeps this from being a fix that restarts every computer on
     * every request. `ensure` is called whenever a computer is needed, so a comparison that ever
     * reported stale for a current container would throw away a Bot's browser mid-task.
     */
    const first = await withDocker().supervisor.ensure(names, {
      image: IMAGE,
      environment: [],
    });
    const before = await withDocker()
      .docker.getContainer(names.container)
      .inspect();

    const second = await withDocker().supervisor.ensure(names, {
      image: IMAGE,
      environment: [],
    });
    const after = await withDocker()
      .docker.getContainer(names.container)
      .inspect();

    // Both calls must reach the real health check and keep the same running container.
    expect(before.State.Health?.Status).toBe("healthy");
    expect(after.State.Health?.Status).toBe("healthy");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(after.Id).toBe(before.Id);
  }, 180_000);
});
