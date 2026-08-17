import type { ComputerNames } from "./names";
import { BOT_LABEL, NAMESPACE, NAMESPACE_LABEL } from "./names";

/**
 * A SPIFFE identity for each Bot's computer.
 *
 * An SVID makes the Bot's identity something a workload holds and can be challenged on, rather than
 * a name supplied in a header.
 *
 * The computer is issued nothing at build time and carries no
 * secret. It asks the local SPIRE agent, and the agent decides what it is by inspecting the calling
 * container and matching the label the supervisor set. So identity follows from the same fact that
 * created the container, and an unregistered container gets nothing.
 *
 * Registered here because the supervisor knows when a computer has come into existence.
 */

const SPIFFE_ENABLED = process.env.SPIRE_SOCKET !== undefined;

/** The parent every workload entry hangs from: the agent that attested the node. */
const AGENT_SPIFFE_ID =
  process.env.SPIRE_AGENT_ID ??
  "spiffe://openbot.local/spire/agent/join_token/openbot";

const TRUST_DOMAIN = process.env.SPIRE_TRUST_DOMAIN ?? "openbot.local";

export function spiffeIdFor(botId: string): string {
  return `spiffe://${TRUST_DOMAIN}/bot/${botId}`;
}

export type EntryResult =
  | { registered: true; spiffeId: string }
  | { registered: false; reason: string };

/**
 * Give this Bot's computer an identity, if SPIRE is part of this deployment.
 *
 * Not fatal when it fails. A computer without an SVID still works; it simply cannot prove which Bot
 * it is. Refusing to start one would turn an identity outage into an outage of the product, which is
 * the wrong trade for a deployment that may not run SPIRE at all. It is reported instead, so the
 * difference between "no identity configured" and "identity broken" stays visible.
 */
export async function registerEntry(
  names: ComputerNames,
): Promise<EntryResult> {
  if (!SPIFFE_ENABLED) {
    return { registered: false, reason: "SPIRE is not configured." };
  }

  const spiffeId = spiffeIdFor(names.botId);
  const selectors = [
    `docker:label:${BOT_LABEL}:${names.botId}`,
    `docker:label:${NAMESPACE_LABEL}:${NAMESPACE}`,
  ];

  try {
    // The SPIRE CLI rather than a hand-rolled registration client: it is the supported surface for
    // this, ships in the same image as the server, and its entry semantics are already idempotent.
    const process_ = Bun.spawn(
      [
        "spire-server",
        "entry",
        "create",
        "-socketPath",
        process.env.SPIRE_SOCKET ?? "/tmp/spire-server/private/api.sock",
        "-spiffeID",
        spiffeId,
        "-parentID",
        AGENT_SPIFFE_ID,
        ...selectors.flatMap((selector) => ["-selector", selector]),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const [status, stderr] = await Promise.all([
      process_.exited,
      new Response(process_.stderr).text(),
    ]);

    // Already registered is success for a restarted supervisor.
    if (status !== 0 && !stderr.includes("similar entry already exists")) {
      return {
        registered: false,
        reason: stderr.trim().slice(0, 200) || `spire-server exited ${status}`,
      };
    }

    return { registered: true, spiffeId };
  } catch (error) {
    // Identity registration must not stop a computer being created. A missing binary, unreachable
    // socket or starting server is reported in the response instead.
    return {
      registered: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
