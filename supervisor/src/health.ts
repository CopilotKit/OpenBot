/**
 * Reading a container's healthcheck from the status line Docker writes.
 *
 * In its own file rather than in `docker.ts` for the reason `names.ts` is: that file imports
 * `dockerode` at module scope, so a test of a one-line parse would need the Docker client installed
 * merely to be imported.
 */

/** What the image's healthcheck says, when Docker reports one. */
export type ContainerHealth = "starting" | "healthy" | "unhealthy";

/** The healthcheck verdict Docker writes into a container's status line, e.g. "Up 3 seconds (health: starting)". */
export function healthOf(
  status: string | undefined,
): ContainerHealth | undefined {
  const match = /\((?:health: )?(starting|healthy|unhealthy)\)/.exec(
    status ?? "",
  );
  return match?.[1] as ContainerHealth | undefined;
}
