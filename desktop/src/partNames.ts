/**
 * What a person reads for each container the Status window lists: the part of OpenBot it is, never
 * Docker's name for it. Docker's names stay in Copy diagnostics, where support needs them.
 *
 * Matched on the Compose service at the end of the name (`<project>-<service>-<n>`), because the
 * project is the installation's and differs between them. The same table is in the app's This
 * computer page (app/src/lib/desktop/part-names.ts); app/tests/desktop-part-names.test.ts holds the
 * two to one answer.
 */

/** Which card a container is listed under: the Bots and what serves them, or the back end. */
export type PartGroup = "bots" | "back-end";

const BOTS: [RegExp, string][] = [
  // Identity for the Bots' computers in an earlier team install. Before `server`, which it ends with.
  [/(^|-)spire-/, "Bot computer identity"],
  [/(^|-)server-\d+$/, "App and Bots"],
  [/(^|-)worker-\d+$/, "Background jobs"],
  [/(^|-)postgres-\d+$/, "Database"],
  [/(^|-)migrate-\d+$/, "Database setup"],
  [/(^|-)supervisor-\d+$/, "Bot computer manager"],
  [/(^|-)(agent-)?computer(-|$)/, "Bot computer"],
  // A Bot of its own container, in an earlier team install: agent-langgraph, agent-bot.
  [/(^|-)agent-[a-z0-9-]+-\d+$/, "Bot"],
];

/**
 * The back end is the local Intelligence: a k3d cluster with one node and no load balancer
 * (`--servers 1 --agents 0 --no-lb`). The node holds every one of its services. Beside it k3d keeps
 * its tools container, which loads the back end's software into the node when it's set up or updated.
 */
const BACK_END: [RegExp, string][] = [
  [/^k3d-.+-server-\d+$/, "Conversations and learning"],
  [/^k3d-.+-tools$/, "Setup helper"],
];

/**
 * A container OpenBot runs that the table doesn't know yet. The card it is listed under already
 * says which side it's on.
 */
const UNKNOWN = "OpenBot service";

export function partLabel(name: string, group: PartGroup): string {
  for (const [pattern, label] of group === "bots" ? BOTS : BACK_END)
    if (pattern.test(name)) return label;
  return UNKNOWN;
}
