/**
 * Whether this phone app can work with the OpenBot it was built for, asked before anybody signs in.
 *
 * The app reads the OpenBot's `deployment` (which answers before sign-in) and decides by the rule in ./client-version.
 * An OpenBot that answers no `deployment` but answers `/api/capabilities` as an OpenBot is from before the v2 API, and
 * too old. Anything else that fails here decides nothing: the screens say what failed, as they always have.
 */
import {
  ApiError,
  DEPLOYMENT_ORGANIZATION_ID,
  apiRequest,
} from "./api/request";
import { getDeployment } from "./api/generated/organization-settings/organization-settings";
import {
  CLIENT_UPDATE_REQUIRED,
  compatibility,
  isOpenBotCapabilities,
  phoneUpdateDetail,
  type VersionVerdict,
} from "./client-version";
import { RELEASE } from "./release";

/** Whether the server answers `/api/capabilities` as an OpenBot does. */
async function answersAsOpenBot(): Promise<boolean> {
  try {
    return isOpenBotCapabilities(
      await apiRequest<unknown>("/api/capabilities"),
    );
  } catch {
    return false;
  }
}

export async function checkVersion(): Promise<VersionVerdict> {
  let deployment: Awaited<ReturnType<typeof getDeployment>>;
  try {
    deployment = await getDeployment(DEPLOYMENT_ORGANIZATION_ID);
  } catch (error) {
    if (error instanceof ApiError && error.code === CLIENT_UPDATE_REQUIRED)
      return { kind: "app", detail: error.message };
    if (
      error instanceof ApiError &&
      error.status === 404 &&
      (await answersAsOpenBot())
    )
      return { kind: "server" };
    return { kind: "ok" };
  }
  // A build that names no release can still tell an API it doesn't speak; it is never refused for a version.
  const fit = compatibility(RELEASE ? deployment : { api: deployment.api }, {
    kind: "mobile",
    version: RELEASE ?? "0.0.0",
  });
  if (fit.fit === "app")
    return { kind: "app", detail: phoneUpdateDetail(fit.minimum) };
  if (fit.fit === "server") return { kind: "server" };
  return { kind: "ok" };
}
