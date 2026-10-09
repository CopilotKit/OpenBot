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

export function sharingSummary(
  published: { audience: "team" | "people" } | undefined,
): string {
  if (!published) return "Not shared";
  return published.audience === "team"
    ? "Whole team"
    : "Specific people and groups";
}

export function setupSummary(agent: {
  builtIn: boolean;
  endpoint: string | null;
}): string {
  if (agent.builtIn || !agent.endpoint) return "Built in";
  try {
    return new URL(agent.endpoint).host;
  } catch {
    return agent.endpoint;
  }
}
