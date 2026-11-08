/**
 * The current answer each "Settings for this Bot" row states, computed from its query on every
 * render so it updates itself when the page behind it changes something.
 */

export function countLabel(
  count: number,
  one: string,
  many: string,
  none: string,
): string {
  if (count === 0) return none;
  return `${count} ${count === 1 ? one : many}`;
}

export function accessSummary(skills: number, apps: number): string {
  const parts = [
    skills ? countLabel(skills, "skill", "skills", "") : "",
    apps ? countLabel(apps, "app", "apps", "") : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Nothing granted";
}

/**
 * Who else can use it. Publishing and visibility are separate records: a public Bot nobody published
 * is still open to everyone in the deployment.
 */
export function sharingSummary(
  published: { audience: "team" | "people" } | undefined,
  visibility: "public" | "private",
): string {
  if (!published) {
    return visibility === "public" ? "Everyone (public)" : "Not shared";
  }
  return published.audience === "team"
    ? "Whole team"
    : "Specific people and groups";
}

/**
 * Where it runs. The personal edition names what runs it when OpenBot knows: its one person
 * picked that harness at setup, and the address is the container OpenBot started for it, which
 * means nothing to them. A team deployment shows the address, which an admin or owner gave it.
 */
export function setupSummary(
  agent: {
    builtIn: boolean;
    endpoint: string | null;
    framework?: string;
  },
  edition: "team" | "personal" = "team",
): string {
  if (agent.builtIn || !agent.endpoint) return "Built in";
  if (edition === "personal" && agent.framework)
    return `Runs on ${agent.framework}`;
  try {
    return new URL(agent.endpoint).host;
  } catch {
    return agent.endpoint;
  }
}

const TRANSPORT_LABEL: Record<string, string> = {
  slack: "Slack",
  teams: "Microsoft Teams",
  sms: "SMS",
};

/** Where this Bot's conversations continue outside OpenBot, each place once. */
export function reachSummary(transports: readonly string[]): string {
  const places = [...new Set(transports)]
    .map((transport) => TRANSPORT_LABEL[transport] ?? transport)
    .sort((a, b) => a.localeCompare(b));
  return places.length ? places.join(", ") : "Only in OpenBot";
}

/** The apps feeding this Bot facts, and whether it checks in on them. */
export function memorySummary(sources: number, research: boolean): string {
  const parts = [
    sources ? countLabel(sources, "source", "sources", "") : "",
    research ? (sources ? "check-ins on" : "Check-ins on") : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Nothing connected";
}
