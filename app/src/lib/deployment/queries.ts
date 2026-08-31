import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * What this deployment can do, as the server is willing to say it.
 *
 * A projection, not the runtime. `/api/capabilities` is reachable before anybody has signed in, so
 * only fields somebody may know unauthenticated appear on it; the Intelligence contract and every
 * deployment secret stay on the server. See server/src/app.ts.
 */
export type DeploymentCapabilities = {
  /**
   * Whether a Bot may answer with an interface it wrote itself.
   *
   * Read by the browser because the browser owns half of this capability: the SDK's provider is what
   * offers the model the tool that generates one. A deployment that turned the server half off while
   * the browser kept offering the tool would have Bots writing whole interfaces that nothing draws,
   * so both halves read this one answer.
   */
  generativeUi: boolean;
};

export const deploymentKeys = {
  all: ["deployment"] as const,
  capabilities: () => ["deployment", "capabilities"] as const,
};

/**
 * What this deployment can do.
 *
 * From the server rather than from the build, like the sign-in options beside it: the container image
 * is built once and knows nothing about the deployment that will run it, so a capability compiled
 * into the bundle can only ever describe the build machine.
 *
 * Absent fields read as off. A server too old to answer, or one that failed to, is a server this app
 * should not assume a capability of — and for generated interfaces the fail-closed direction is the
 * safe one, because claiming it wrongly is what makes a Bot generate something nothing renders.
 */
export function deploymentCapabilitiesQueryOptions() {
  return queryOptions({
    queryKey: deploymentKeys.capabilities(),
    // Configuration, not data. It cannot change without the process restarting.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async (): Promise<DeploymentCapabilities> => {
      /*
       * The whole body, then one field off it. `/api/capabilities` answers with a bare object rather
       * than the envelope most endpoints use, which is why this reads the Response itself instead of
       * naming a key — the same shape the sign-in query uses.
       */
      const body = (await (
        await client("/api/capabilities", {
          fallback: "This deployment's capabilities could not be loaded.",
        })
      ).json()) as { generativeUi?: boolean };

      return { generativeUi: body.generativeUi === true };
    },
  });
}
