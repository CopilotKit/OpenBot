import { Hono } from "hono";

/** The Bun server this request arrived on, which `http-server.ts` passes to `app.fetch` as env. */
type PeerEnvironment = {
  server?: {
    requestIP?: (request: Request) => { address: string } | null;
  };
};

/** Headers a reverse proxy adds when it forwards someone else's request. A proxy on the same host
 * connects from loopback, so its presence means the caller is not the machine itself. */
const FORWARDING_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-real-ip",
];

function loopback(address: string) {
  const plain = address.replace(/^::ffff:/i, "");
  return plain === "::1" || /^127(?:\.\d{1,3}){3}$/.test(plain);
}

/**
 * Build identity only; never infer the candidate from the still-accepted installation sidecar.
 *
 * Answered only to a caller on the server's own machine: the TCP peer, not any header, must be a
 * loopback address, and the request must not have been forwarded. Every check that reads this asks
 * from there: Desktop's native server on 127.0.0.1, the host updater on 127.0.0.1, and the image and
 * Kubernetes updaters from inside the server's container. Anyone else gets a 404, so the exact
 * version, commit and a private fork's repository name are not handed to whoever can reach the port.
 */
export function createReleaseStatusRoutes(
  env: NodeJS.ProcessEnv = process.env,
) {
  const identity = {
    version: env.OPENBOT_BUILD_VERSION,
    commit: env.OPENBOT_BUILD_COMMIT,
    distributionId: env.OPENBOT_BUILD_DISTRIBUTION_ID,
    repository: env.OPENBOT_BUILD_REPOSITORY,
    channel: env.OPENBOT_BUILD_CHANNEL,
  };
  const valid =
    Object.values(identity).every(
      (value) =>
        typeof value === "string" &&
        value.trim() !== "" &&
        value.trim() === value &&
        ![...value].some((character) => character.charCodeAt(0) < 32),
    ) &&
    /^[0-9a-f]{40}$/.test(identity.commit ?? "") &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(identity.repository ?? "");
  const app = new Hono<{ Bindings: PeerEnvironment }>();
  app.get("/release", (context) => {
    const peer = context.env?.server?.requestIP?.(context.req.raw)?.address;
    if (
      !peer ||
      !loopback(peer) ||
      FORWARDING_HEADERS.some((name) => context.req.header(name) !== undefined)
    )
      return context.notFound();
    context.header("Cache-Control", "no-store");
    return valid
      ? context.json(identity)
      : context.json({ error: "Build release identity is unavailable" }, 503);
  });
  return app;
}
