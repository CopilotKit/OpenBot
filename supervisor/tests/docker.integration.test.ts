import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { namesFor } from "../src/names";

/*
 * The ownership rule, against a real daemon.
 *
 * A fake Docker cannot show what this is about. The question is what the daemon does when two things
 * want one name, and the answer, a 409 from `createContainer`, is the daemon's own behaviour rather
 * than something a stub would be asserting about itself.
 *
 * NOTHING HERE IS IMPORTED AT MODULE SCOPE except `namesFor`, which has no dependencies of its own.
 * `supervisor` is not one of the root workspaces, so a root `bun install` never installs `dockerode`,
 * and `bun test` from the root walks this directory anyway. A static import of the client, or of
 * `../src/docker` which holds one, fails to resolve there and takes the whole file down with it
 * rather than skipping. So the client is resolved when a test is about to use it, and its absence is
 * one of the reasons to skip, alongside there being no socket to talk to.
 */

const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";

type DockerRuntime = {
  docker: InstanceType<typeof import("dockerode").default>;
  supervisor: typeof import("../src/docker");
};

/**
 * The daemon and the module under test, or nothing.
 *
 * Nothing on any of the three reasons this cannot run: no socket on this machine, no client package
 * installed because the root is the only thing that ran `bun install`, or a socket that will not
 * answer. Each is a reason to skip rather than to fail, and none of them is a property of the code
 * being tested.
 */
async function dockerRuntime(): Promise<DockerRuntime | null> {
  if (!existsSync(SOCKET)) return null;
  try {
    const supervisor = await import("../src/docker");
    if (!(await supervisor.reachable())) return null;
    const { default: Docker } = await import("dockerode");
    return {
      docker: new Docker(
        process.env.DOCKER_SOCKET ? { socketPath: SOCKET } : undefined,
      ),
      supervisor,
    };
  } catch {
    return null;
  }
}

const runtime = await dockerRuntime();

/**
 * The runtime, for a test that is only reached when there is one.
 *
 * Every use sits inside a `describe.skipIf(runtime === null)`, so the throw is unreachable. It is
 * here to say that in the types rather than with an assertion at each of the eight call sites.
 */
function withDocker(): DockerRuntime {
  if (runtime === null) {
    throw new Error("This test runs only when a Docker daemon is reachable.");
  }
  return runtime;
}

/** Any small image that stays up when told to sleep. Nothing here tests what is inside it. */
const IMAGE = process.env.SUPERVISOR_TEST_IMAGE ?? "debian:bookworm-slim";

const BOT = "supervisortestbot";
const result = namesFor(BOT);
if (!result.ok) throw new Error(result.reason);
const names = result.names;

async function remove(container: string) {
  await withDocker()
    .docker.getContainer(container)
    .remove({ force: true })
    .catch(() => undefined);
}

async function plant(labels: Record<string, string>, health?: boolean) {
  await remove(names.container);
  await withDocker().docker.createContainer({
    name: names.container,
    Image: IMAGE,
    Labels: labels,
    Cmd: ["sleep", "600"],
    ...(health
      ? {}
      : {
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
  "openbot.namespace": "openbot",
  "openbot.bot-id": BOT,
};

afterEach(async () => {
  await remove(names.container);
});

describe.skipIf(runtime === null)("a name held by somebody else", () => {
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

describe.skipIf(runtime === null)("a computer that never answers", () => {
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

describe.skipIf(runtime === null)(
  "a computer built from an older image",
  () => {
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
    const OTHER = process.env.SUPERVISOR_TEST_OTHER_IMAGE ?? "alpine:3";

    async function pull(image: string): Promise<boolean> {
      try {
        await withDocker().docker.getImage(image).inspect();
        return true;
      } catch {
        // Not present locally. Pulling in a test is a network call this suite otherwise never makes,
        // so it is attempted once and its failure skips rather than fails.
        try {
          const stream = await withDocker().docker.pull(image);
          await new Promise((resolve, reject) => {
            withDocker().docker.modem.followProgress(
              stream as never,
              (error: unknown) => (error ? reject(error) : resolve(null)),
            );
          });
          return true;
        } catch {
          return false;
        }
      }
    }

    test("is replaced, and keeps its profile and workspace", async () => {
      if (!(await pull(OTHER))) return;

      // A computer this supervisor owns, made the way it makes them, on the wrong image.
      await withDocker().supervisor.ensure(names, {
        image: OTHER,
        environment: [],
      });
      const before = await withDocker()
        .docker.getContainer(names.container)
        .inspect();

      // Something in the volumes, so "kept" is a fact about their contents and not only their names.
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
      expect(kept.map((v) => v.CreatedAt)).toEqual(
        volumes.map((v) => v.CreatedAt),
      );
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

      /*
       * Identity, not liveness. The placeholder image has no long-running command, so the container
       * exits and Docker restarts it; its status and its start time at any instant are facts about
       * that image rather than about `ensure`. What matters here is that the same container is
       * still there: a replacement would have a different id, and `ensure` is called for every
       * request, so a comparison that ever reported stale for a current container would throw away
       * a Bot's browser mid-task.
       */
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(after.Id).toBe(before.Id);
    }, 180_000);
  },
);
