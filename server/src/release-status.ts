import { Hono } from "hono";

/** Build identity only; never infer the candidate from the still-accepted installation sidecar. */
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
  const app = new Hono();
  app.get("/release", (context) => {
    context.header("Cache-Control", "no-store");
    return valid
      ? context.json(identity)
      : context.json({ error: "Build release identity is unavailable" }, 503);
  });
  return app;
}
