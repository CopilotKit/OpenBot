/**
 * What a member may use, decided from the switches an administrator set.
 *
 * Pure: no database, no clock. `settings-store.ts` reads the rows, `controls.ts` holds a snapshot
 * for the synchronous policy check, and both ask this module for the answer so the two can never
 * disagree about what a row means.
 *
 * THE RULE, taken from the two products this closes the gap on:
 *
 * - The organization row is the baseline (OpenAI: "Workspace default > Workspace capabilities").
 * - A role row replaces the baseline for everybody holding that role (OpenAI custom roles).
 * - A group row can only widen (Grok Bot: "Group settings only widen: a group can grant its members
 *   more than the team allows, never less"). `true` grants; `false` is recorded and changes nothing.
 * - No row anywhere means the built-in default below, which keeps every deployment that has never
 *   opened this screen working exactly as it did.
 */

export const CAPABILITIES = [
  "useBots",
  "cloudBrowser",
  "cloudNetwork",
  "cloudComputer",
  "localComputer",
  "customRules",
  "passwordManager",
  "slackTeams",
  "teamBots",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: unknown): value is Capability {
  return (
    typeof value === "string" &&
    (CAPABILITIES as readonly string[]).includes(value)
  );
}

/** Words for the admin screen and for a refusal a person reads. */
export const CAPABILITY_LABELS: Record<
  Capability,
  { title: string; description: string }
> = {
  useBots: {
    title: "Use Bots",
    description: "Talk to Bots and let them run work in this person's name.",
  },
  cloudBrowser: {
    title: "Cloud browser use",
    description: "Bots may drive the browser on their cloud computer.",
  },
  cloudNetwork: {
    title: "Cloud network access",
    description:
      "Bot computers may reach the internet, within the network policy.",
  },
  cloudComputer: {
    title: "Cloud computer use",
    description:
      "Bots may run commands and read and write files on their computer.",
  },
  localComputer: {
    title: "Local computer access",
    description:
      "Bots may use folders and commands on this person's own machine.",
  },
  customRules: {
    title: "Custom rules",
    description: "People may save their own always-allow and ask-first rules.",
  },
  passwordManager: {
    title: "Password manager",
    description: "People may save logins and hand sign-ins to a Bot's browser.",
  },
  slackTeams: {
    title: "Add Bots to Slack and Teams",
    description: "People may connect a Bot to a Slack or Teams conversation.",
  },
  teamBots: {
    title: "Team Bots",
    description: "People may publish a Bot for the whole team to use.",
  },
};

/**
 * What an untouched deployment allows.
 *
 * Everything the product already did stays on.
 */
export const DEFAULT_CAPABILITIES: Record<Capability, boolean> = {
  useBots: true,
  cloudBrowser: true,
  cloudNetwork: true,
  cloudComputer: true,
  localComputer: true,
  customRules: true,
  passwordManager: true,
  slackTeams: true,
  teamBots: true,
};

export type CapabilityRow = {
  scopeKind: "organization" | "role" | "group";
  scopeId: string;
  capability: string;
  allowed: boolean;
};

export type Member = { role: "admin" | "user"; groups: readonly string[] };

export type CapabilityAnswer = {
  allowed: boolean;
  /** Which switch decided it, for the audit row and the refusal. */
  decidedBy: "default" | "organization" | "role" | "group";
  scopeId: string;
};

export function resolveCapability(
  rows: readonly CapabilityRow[],
  member: Member,
  capability: Capability,
): CapabilityAnswer {
  const forCapability = rows.filter((row) => row.capability === capability);

  const widening = forCapability.find(
    (row) =>
      row.scopeKind === "group" &&
      row.allowed &&
      member.groups.includes(row.scopeId),
  );
  if (widening) {
    return { allowed: true, decidedBy: "group", scopeId: widening.scopeId };
  }

  const role = forCapability.find(
    (row) => row.scopeKind === "role" && row.scopeId === member.role,
  );
  if (role) {
    return { allowed: role.allowed, decidedBy: "role", scopeId: role.scopeId };
  }

  const organization = forCapability.find(
    (row) => row.scopeKind === "organization",
  );
  if (organization) {
    return {
      allowed: organization.allowed,
      decidedBy: "organization",
      scopeId: "",
    };
  }

  return {
    allowed: DEFAULT_CAPABILITIES[capability],
    decidedBy: "default",
    scopeId: "",
  };
}

export function resolveAllCapabilities(
  rows: readonly CapabilityRow[],
  member: Member,
): Record<Capability, boolean> {
  return Object.fromEntries(
    CAPABILITIES.map((capability) => [
      capability,
      resolveCapability(rows, member, capability).allowed,
    ]),
  ) as Record<Capability, boolean>;
}

/** The sentence a refused person reads. */
export function capabilityRefusal(capability: Capability): string {
  return `An administrator has turned off "${CAPABILITY_LABELS[capability].title}" for you, so that was not done.`;
}
