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
