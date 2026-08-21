import { afterEach, describe, expect, test } from "bun:test";
import Docker from "dockerode";
import {
  ComputerNotAnsweringError,
  ensure,
  NameHeldError,
  reachable,
} from "../src/docker";
import { namesFor } from "../src/names";

/*
 * The ownership rule, against a real daemon.
 *
 * A fake Docker cannot show what this is about. The question is what the daemon does when two
 * things want one name, and the answer, a 409 from `createContainer`, is the daemon's own behaviour
 * rather than something a stub would be asserting about itself.
 *
 * Skipped where the socket is not reachable, which is most machines and most CI runs. That makes
 * this a test that has to be asked for; it is here so the rule can be re-checked rather than
 * argued about.
 */
const docker = new Docker(
  process.env.DOCKER_SOCKET
    ? { socketPath: process.env.DOCKER_SOCKET }
    : undefined,
);
const available = await reachable();
const IMAGE = process.env.SUPERVISOR_TEST_IMAGE ?? "debian:bookworm-slim";

const BOT = "supervisortestbot";
const result = namesFor(BOT);
if (!result.ok) throw new Error(result.reason);
const names = result.names;

async function remove(container: string) {
  await docker
    .getContainer(container)
    .remove({ force: true })
    .catch(() => undefined);
}

async function plant(labels: Record<string, string>, health?: boolean) {
  await remove(names.container);
  await docker.createContainer({
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

describe.skipIf(!available)("a name held by somebody else", () => {
  test("is refused rather than adopted, and never started", async () => {
    // The container this supervisor did not make. Ownership is checked everywhere else so that a
    // name collision reads as absent; starting it on a 409 was the path that adopted it instead,
    // and an adopted container receives the deployment's computer token.
    await plant({ "someone.else": "true" });

    await expect(
      ensure(names, { image: IMAGE, environment: [] }),
    ).rejects.toBeInstanceOf(NameHeldError);

    const info = await docker.getContainer(names.container).inspect();
    expect(info.State?.Running).toBe(false);
  }, 90_000);

  test("but a container this supervisor owns is still started", async () => {
    // The other direction, and the reason the check is ownership rather than existence: `ensure` is
    // idempotent, so the container a previous call left stopped has to come back up.
    await plant(OURS, true);

    const state = await ensure(names, { image: IMAGE, environment: [] });

    expect(state.status).toBe("running");
  }, 90_000);
});

describe.skipIf(!available)("a computer that never answers", () => {
  test("fails instead of being handed out as ready", async () => {
    // A wait that cannot fail is a sleep: every computer that never came up was reported ready, and
    // the caller learned otherwise by sending it the deployment's token and getting a transport
    // error back.
    await plant(OURS);

    await expect(
      ensure(names, { image: IMAGE, environment: [], readyTimeoutMs: 3_000 }),
    ).rejects.toBeInstanceOf(ComputerNotAnsweringError);
  }, 90_000);
});
