import {
  type QueryClient,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
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
  /**
   * Whether to show the banner offering help self-hosting OpenBot. A fork that runs OpenBot for its
   * own organization turns it off with OPENBOT_SELF_HOST_BANNER=false, and the server answers false
   * for a deployment on a paid Intelligence plan.
   */
  selfHostBanner: boolean;
  /**
   * Whether this is somebody trying OpenBot on their own machine rather than an organization's
   * deployment: single-user mode on the server, which only a local, unreachable install can be in.
   */
  localEvaluation: boolean;
  /**
   * Which product this is. `personal` is one person on their own machine: no Admin, and what they
   * need of it under Settings. A server from before the switch reads as `team`.
   */
  edition: "team" | "personal";
  transcription?: boolean;
  voice?: boolean;
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
          fallback: "Couldn't load what OpenBot can do.",
        })
      ).json()) as {
        generativeUi?: boolean;
        selfHostBanner?: boolean;
        localEvaluation?: boolean;
        edition?: string;
        transcription?: boolean;
        voice?: boolean;
      };

      return {
        generativeUi: body.generativeUi === true,
        selfHostBanner: body.selfHostBanner === true,
        localEvaluation: body.localEvaluation === true,
        edition: body.edition === "personal" ? "personal" : "team",
        transcription: body.transcription === true,
        voice: body.voice === true,
      };
    },
  });
}

/**
 * Whether this deployment offers memory: what a person's Bots remember about them, and the apps a
 * Bot learns it from. Every memory screen, row and link reads this.
 *
 * NOT IN THE PERSONAL EDITION. OpenBot Desktop runs a local Intelligence whose licence leaves memory
 * out, so the personal edition has no memory to show. Read from the edition, not from Intelligence's
 * entitlement: the server's entitlement read only chooses where memory is kept (Intelligence, or
 * OpenBot's own tables when Intelligence is unlicensed or unreachable), and it changes from one
 * minute to the next while Intelligence starts. A screen gated on it would come and go, and a team
 * deployment that keeps memory in its own tables would lose screens that work.
 *
 * An edition that could not be read is the team edition, as everywhere else.
 */
export function offersMemory(
  capabilities: Pick<DeploymentCapabilities, "edition"> | undefined,
): boolean {
  return capabilities?.edition !== "personal";
}

/**
 * {@link offersMemory} for a component. False until the edition is known, so the personal edition
 * never draws a memory row for a moment or asks the server for memory it doesn't have.
 */
export function useOffersMemory(): boolean {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  return !capabilities.isPending && offersMemory(capabilities.data);
}

/** {@link offersMemory} for a route guard, which has the query client and no component. */
export async function deploymentOffersMemory(
  queryClient: QueryClient,
): Promise<boolean> {
  return offersMemory(
    await queryClient
      .ensureQueryData(deploymentCapabilitiesQueryOptions())
      .catch(() => undefined),
  );
}
