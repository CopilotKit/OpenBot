/**
 * Isolated Bots: a Bot with a computer of its own instead of its owner's.
 *
 * By default every Bot a person uses runs on that person's one computer. An owner may tick Isolated
 * when making a Bot, which gives it a computer keyed by the Bot, kept between runs, and shared by
 * everyone who uses that Bot. Two things can stand between the tick and the computer, and this module
 * is where both are answered, so the screen, the write path and the run path never disagree:
 *
 * - The deployment. Only a provider that makes computers can make one more (the Docker or Podman
 *   supervisor, and the Helm sandbox). The one shared computer cannot.
 * - The "Isolated Bots" switch (`isolatedComputers`), which an administrator can turn off for
 *   everybody or allow only for chosen groups or roles. Withdrawing it does not untick anything: the
 *   owner's Bots run on their shared computer from the next run, and giving the switch back restores
 *   them, which is why the flag and the verdict are two different facts.
 */
import { eq } from "drizzle-orm";
import { DEFAULT_CAPABILITIES } from "../admin/capabilities";
import { enterpriseControls } from "../admin/controls";
import type { ComputerConfig } from "../config";
import type { Database } from "../db/client";
import { agentProfiles } from "../db/schema";

/** Whether this deployment's computers can give one Bot a computer of its own. */
export function deploymentCanIsolate(
  computer: Pick<ComputerConfig, "provider"> | undefined,
): boolean {
  return computer?.provider === "docker" || computer?.provider === "sandbox";
}

/**
 * Whether this person holds "Isolated Bots" right now.
 *
 * Read fresh, never from a snapshot, for the same reason every other asynchronous check in
 * `admin/controls.ts` is: a switch an administrator flipped a second ago counts. Without enterprise
 * controls installed (a script, a test that does not install them) the built-in default stands, which
 * is the product as it was. A switch that cannot be read refuses, as every other check does.
 */
export async function mayIsolate(userId: string): Promise<boolean> {
  const controls = enterpriseControls();
  if (!controls) return DEFAULT_CAPABILITIES.isolatedComputers;
  return controls
    .capabilityFor(userId, "isolatedComputers")
    .catch((error: unknown) => {
      // Refused, as every other unreadable switch is, but said: an isolated Bot then runs on the person's computer.
      console.warn(
        JSON.stringify({
          type: "isolation-capability-read-failed",
          userId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return false;
    });
}

/** Why an isolated Bot is running on a shared computer instead. */
export type IsolationOffReason = "deployment" | "admin";

export type IsolationState = {
  /** Whether its next run gets the computer of its own. */
  isolationActive: boolean;
  /**
   * Why not, for a Bot that asked for one and is not getting it. Null when it is, and when it never
   * asked. `deployment` wins over `admin`: with no way to make a second computer, the switch is moot.
   */
  isolationOffReason: IsolationOffReason | null;
};

/**
 * The verdict for one Bot, given what the deployment can do and whether its owner holds the switch.
 *
 * The owner's switch, not the viewer's: isolation is the owner's choice about their Bot, and a person
 * using somebody's public Bot neither grants nor withdraws it. A Bot with no owner (one whose owner
 * was removed) is never isolated, because nobody holds the switch for it.
 */
export function isolationState(
  agent: { isolated: boolean; ownerUserId: string | null },
  deploymentAvailable: boolean,
  ownerMayIsolate: boolean,
): IsolationState {
  if (!agent.isolated)
    return { isolationActive: false, isolationOffReason: null };
  if (!deploymentAvailable) {
    return { isolationActive: false, isolationOffReason: "deployment" };
  }
  if (!agent.ownerUserId) {
    return { isolationActive: false, isolationOffReason: null };
  }
  return ownerMayIsolate
    ? { isolationActive: true, isolationOffReason: null }
    : { isolationActive: false, isolationOffReason: "admin" };
}

/**
 * Whether this Bot runs on a computer of its own on its next run, as far as the Bot and its owner
 * decide it.
 *
 * For the computer key: an isolated Bot whose owner still holds the switch is keyed by the Bot, and
 * every other Bot by the person acting. Whether the deployment's provider can make a computer per key
 * is the provider's own answer and is not asked here. A Bot that does not exist, or was deleted, is
 * not isolated.
 */
export async function runsIsolated(
  database: Pick<Database, "select">,
  botId: string,
): Promise<boolean> {
  const [row] = await database
    .select({
      isolated: agentProfiles.isolated,
      ownerUserId: agentProfiles.ownerUserId,
      deletedAt: agentProfiles.deletedAt,
    })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, botId))
    .limit(1);
  if (!row || row.deletedAt || !row.isolated || !row.ownerUserId) return false;
  return mayIsolate(row.ownerUserId);
}
