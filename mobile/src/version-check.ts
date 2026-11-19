/**
 * Whether this phone app is new enough for the OpenBot it was built for, asked before anybody signs in.
 *
 * The app reads the OpenBot's `deployment` (which answers before sign-in) and decides by the rule in ./client-version.
 * Only an app too old for its OpenBot is stopped, with "Update OpenBot". Anything else decides nothing: the screens say
 * what failed, as they always have.
 */
import { ApiError, deploymentOrganization } from "./api/request";
import { getDeployment } from "./api/generated/organization-settings/organization-settings";
import {
  CLIENT_UPDATE_REQUIRED,
  compatibility,
  phoneUpdateDetail,
  type VersionVerdict,
} from "./client-version";
import { RELEASE } from "./release";

export async function checkVersion(): Promise<VersionVerdict> {
  let deployment: Awaited<ReturnType<typeof getDeployment>>;
  try {
    deployment = await getDeployment(await deploymentOrganization());
  } catch (error) {
    if (error instanceof ApiError && error.code === CLIENT_UPDATE_REQUIRED)
      return error.security
        ? { kind: "app", detail: error.message, security: true }
        : { kind: "app", detail: error.message };
    return { kind: "ok" };
  }
  // A build that names no release can still tell an API it doesn't speak; it is never refused for a version.
  const fit = compatibility(RELEASE ? deployment : { api: deployment.api }, {
    kind: "mobile",
    version: RELEASE ?? "0.0.0",
  });
  if (fit.fit === "app")
    return fit.security
      ? {
          kind: "app",
          detail: phoneUpdateDetail(fit.minimum, true),
          security: true,
        }
      : { kind: "app", detail: phoneUpdateDetail(fit.minimum) };
  return { kind: "ok" };
}
