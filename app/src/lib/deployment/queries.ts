import {
  type QueryClient,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import type { Deployment } from "@/lib/api/generated/model";
import { getDeployment } from "@/lib/api/generated/organization-settings/organization-settings";
import { listOrganizations } from "@/lib/api/generated/organizations/organizations";
import { DEPLOYMENT_ORGANIZATION } from "@/lib/api/request";
import { ClientError } from "@/lib/client";
import { currentOrganizationId } from "@/lib/organizations/current";

/**
 * What this deployment can do, as the server is willing to say it.
 *
 * A projection, not the runtime. The API's `deployment` is readable before anybody has signed in,
 * so only fields somebody may know unauthenticated appear on it; the Intelligence contract and every
 * deployment secret stay on the server.
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
   * Whether to ask people to star OpenBot on GitHub, and list the link in Settings. On unless the
   * deployment set OPENBOT_STAR_PROMPT=false. Absent, from a server too old to say, reads as off.
   */
  starPrompt?: boolean;
  /**
   * Whether this is somebody trying OpenBot on their own machine rather than an organization's
   * deployment: single-user mode on the server, which only a local, unreachable install can be in.
   */
  localEvaluation: boolean;
  /**
   * Which product this is. `personal` is one person on their own machine, who is its admin, with
   * what they use most of Admin under Settings too. A server from before the switch reads as `team`.
   */
  edition: "team" | "personal";
  transcription?: boolean;
  voice?: boolean;
  /** Whether a Bot can run inside OpenBot, with no address of its own. */
  builtInBots?: boolean;
  /**
   * Whether this OpenBot can give a Bot a computer of its own at all.
   *
   * Only where its computers are made one at a time (the supervisor, or a cluster's sandboxes).
   * Whether the signed-in person may is a different question, answered by the "Isolated Bots"
   * switch in `myCapabilitiesQueryOptions`.
   */
  isolatedBots?: boolean;
  /**
   * Whether this OpenBot has computers for Bots at all.
   *
   * Not `isolatedBots`: an OpenBot whose Bots share one computer has computers and gives no Bot one
   * of its own. False only when the server says so. Without computers a Bot has no screen, terminal
   * or sign-in to a website, and the server refuses every call about one, so a screen reads this
   * and says so in place of asking.
   */
  botComputers?: boolean;
};

/**
 * The API's `deployment`, asked where the server answers it.
 *
 * Signed in, it is answered in an organization the person is a member of and not found in any
 * other, `default` included, as every address under an organization is. Nobody signed in reads it
 * at `default`, which the sign-in screen asks before there is anybody to ask as. So it is asked in
 * the organization the person works in once that is known, and at `default` before. A person who
 * is signed in and not a member of `default` is told "not found" there, and is asked in one of
 * their own instead: the facts are the deployment's, the same in each.
 */
export async function readDeployment(options: {
  signal?: AbortSignal;
  fallback: string;
}): Promise<Deployment> {
  const known = currentOrganizationId();
  try {
    return await getDeployment(known ?? DEPLOYMENT_ORGANIZATION, options);
  } catch (error) {
    if (
      known !== undefined ||
      !(error instanceof ClientError) ||
      error.status !== 404
    )
      throw error;
    const own = (await listOrganizations({ limit: 1 }, undefined, options))
      .organizations[0];
    if (!own) throw error;
    return getDeployment(own.id, options);
  }
}

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
    queryFn: async ({ signal }): Promise<DeploymentCapabilities> => {
      const body = await readDeployment({
        signal,
        fallback: "Couldn't load what OpenBot can do.",
      });
      return {
        generativeUi: body.generativeUi === true,
        selfHostBanner: body.selfHostBanner === true,
        starPrompt: body.starPrompt === true,
        localEvaluation: body.localEvaluation === true,
        edition: body.edition === "personal" ? "personal" : "team",
        transcription: body.transcription === true,
        voice: body.voice === true,
        builtInBots: body.builtInBots === true,
        isolatedBots: body.isolatedBots === true,
        // The other way round from the rest: a server that doesn't say reads as having computers.
        botComputers: body.botComputers !== false,
      };
    },
  });
}

/**
 * Asks OpenBot the cheapest thing it answers, to find out whether it answers at all. A verdict about
 * this moment, so no cache key: the answer reaches `lib/desktop/reachability.ts` through the client
 * like every other, and that is what the connection line reads.
 */
export async function askWhetherOpenBotAnswers(): Promise<void> {
  await getDeployment(DEPLOYMENT_ORGANIZATION, {
    fallback: "Couldn't reach OpenBot.",
  }).catch(() => undefined);
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

/**
 * Whether this OpenBot has no computers for Bots: true only once the server has said so.
 *
 * `undefined` while the answer is on its way. A screen about a computer waits for it before it asks
 * the server about one, because where there are none every such call is refused, and the refusal
 * would be on screen as a failure before the reason was known. An answer that could not be read is
 * false: the screen behaves as it does where there are computers, and never says "no computers"
 * about an OpenBot that may have them.
 */
export function useNoBotComputers(): boolean | undefined {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  if (capabilities.isPending) return undefined;
  return capabilities.data?.botComputers === false;
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
