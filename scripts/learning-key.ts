import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";

/**
 * What a runtime key alone can learn from Intelligence about its own project's Learning containers,
 * for the Learning setup helpers that run in this checkout (scripts/setup-learning.ts).
 *
 * A client of Intelligence's API, through CopilotKit's own Intelligence client. The server asks the
 * same questions at boot.
 */

/**
 * What asking Intelligence about one container found. `learning_off`: Intelligence answered and has
 * no Learning routes at all, which is Learning switched off in its deployment, not a failure to reach it.
 */
export type ContainerProbe =
  | "present"
  | "absent"
  | "not_entitled"
  | "learning_off"
  | "unavailable";

/**
 * Read a learned-skills error into whether the container is there.
 *
 * The runtime key cannot list or create Learning containers: Intelligence serves those routes only
 * to a person's session or CLI login. What it can do is read a container's published Skills, and
 * that read is scoped to the key's own project, so it answers the one question this needs without
 * a side effect. A container nobody has published to yet still exists: Intelligence says the
 * revision is missing or delivery is off, not that the container is.
 */
export function classifyProbeError(error: unknown): ContainerProbe {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? (error as { code: unknown }).code
      : undefined;
  if (code === "CONTAINER_NOT_FOUND") return "absent";
  if (
    code === "REVISION_NOT_FOUND" ||
    code === "DELIVERY_DISABLED" ||
    code === "REVISION_REVOKED"
  )
    return "present";
  if (code === "ENTITLEMENT_REQUIRED") return "not_entitled";
  return "unavailable";
}

/** The HTTP status and Intelligence error code a project-key Learning request failed with. */
function requestFailure(error: unknown): { status?: number; code?: string } {
  if (error === null || typeof error !== "object") return {};
  const { status, code } = error as { status?: unknown; code?: unknown };
  return {
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof code === "string" ? { code } : {}),
  };
}

/**
 * Read a refusal from Intelligence's project-key Learning routes (`/api/v1/learning/containers/...`).
 *
 * Intelligence with Learning switched off registers none of them, so it answers 404 with its
 * catch-all `ROUTE_NOT_FOUND`: Learning is off there, which the person who can turn it on needs to
 * hear, rather than that Intelligence could not be reached.
 */
export function classifyLearningRouteError(error: unknown): ContainerProbe {
  const { status, code } = requestFailure(error);
  if (status === 404 && code === "ROUTE_NOT_FOUND") return "learning_off";
  if (code === "LEARNING_CONTAINER_NOT_FOUND") return "absent";
  if (code === "LEARNING_NOT_ENABLED") return "not_entitled";
  return "unavailable";
}

/** The runtime client's catch-alls: a refusal it has no code for, which the read below can name. */
const UNNAMED_REFUSALS = new Set([
  "UNSUPPORTED_SERVER",
  "AUTHORIZATION_FAILED",
]);

/**
 * Ask whether `containerId` exists in the project the runtime key belongs to.
 *
 * The published-Skills read answers it on every Intelligence. When that read fails with a code the
 * runtime client does not know (it reports any such refusal as `UNSUPPORTED_SERVER`, or a 403 as
 * `AUTHORIZATION_FAILED`), the container itself is read on the same key, whose refusal carries
 * Intelligence's own code: Learning switched off, a missing container, or Learning not licensed.
 */
export async function probeLearningContainer(
  client: Pick<CopilotKitIntelligence, "getLearnedSkillsSnapshot"> & {
    experimental?: {
      learning: Pick<
        CopilotKitIntelligence["experimental"]["learning"],
        "getLearningContainer"
      >;
    };
  },
  containerId: string,
  timeoutMs = 5_000,
): Promise<ContainerProbe> {
  try {
    await client.getLearnedSkillsSnapshot({
      containerId,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return "present";
  } catch (error) {
    const found = classifyProbeError(error);
    const { code } = requestFailure(error);
    if (
      found !== "unavailable" ||
      !client.experimental ||
      !code ||
      !UNNAMED_REFUSALS.has(code)
    )
      return found;
    try {
      await client.experimental.learning.getLearningContainer({
        containerId,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return "present";
    } catch (named) {
      return classifyLearningRouteError(named);
    }
  }
}

/** The organization and project a runtime key belongs to, by slug. */
export type KeyProject = { organizationSlug: string; projectSlug: string };

/**
 * Which project a runtime key belongs to, read from the Learning link Intelligence returns for it.
 *
 * The key cannot name its own project directly. The Inspector projection it can read carries a link
 * to the project's Learning page, `/o/<organization>/<project>/learning`, and that is enough for a
 * helper holding a person's login to refuse to create a container in some other project. Anything
 * unreadable is `undefined`, and callers treat that as "cannot prove it".
 */
export async function keyProject(
  client: Pick<CopilotKitIntelligence, "getInspectorLearning">,
  timeoutMs = 10_000,
): Promise<KeyProject | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The Inspector read takes no signal, so the deadline races it.
    const snapshot = await Promise.race([
      client.getInspectorLearning({}),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Inspector read timed out")),
          timeoutMs,
        );
      }),
    ]);
    const [o, organizationSlug, projectSlug, learning] = new URL(
      snapshot.links.learning,
    ).pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    if (
      o !== "o" ||
      learning !== "learning" ||
      !organizationSlug ||
      !projectSlug
    )
      return undefined;
    return { organizationSlug, projectSlug };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** A runtime key's project by slug and by name: everything the key can say about where it lives. */
export type KeyIdentity = KeyProject & {
  organizationName: string;
  projectName: string;
};

/**
 * The key's project slugs (see `keyProject`) and the organization and project names its Inspector
 * metadata carries. The names are what a CopilotKit CLI login can be compared on: the CLI reports
 * its organization by name and Clerk ID, never by slug. Anything unreadable is `undefined`.
 */
export async function keyIdentity(
  client: Pick<
    CopilotKitIntelligence,
    "getInspectorLearning" | "getInspectorMetadata"
  >,
  timeoutMs = 10_000,
): Promise<KeyIdentity | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [slugs, metadata] = await Promise.all([
      keyProject(client, timeoutMs),
      Promise.race([
        client.getInspectorMetadata(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Inspector metadata timed out")),
            timeoutMs,
          );
        }),
      ]),
    ]);
    const identity = metadata?.identity;
    if (!slugs || !identity?.organizationName || !identity.projectName)
      return undefined;
    return {
      ...slugs,
      organizationName: identity.organizationName,
      projectName: identity.projectName,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A client holding only a runtime key, for helpers that run without the server.
 *
 * Loaded when it is first asked for: CopilotKit's runtime is large, and a helper that never reaches
 * Intelligence with a key, or a test that hands it a stand-in, should not load it at all.
 */
export async function runtimeKeyClient(
  apiUrl: string,
  apiKey: string,
  wsUrl?: string,
): Promise<CopilotKitIntelligence> {
  const { CopilotKitIntelligence } = await import("@copilotkit/runtime/v2");
  return new CopilotKitIntelligence({
    apiUrl,
    apiKey,
    ...(wsUrl ? { wsUrl } : {}),
  });
}

/** What creating the container with a credential that can did. `skipped`: nothing here could. */
