/**
 * Which product this deployment is.
 *
 * `team` is OpenBot as an organization runs it. `personal` is one person on their own machine: no
 * sign-in, one shared computer, and none of the screens that govern other people. The governance
 * itself (the gateway, its policy, approvals and the audit trail) runs the same in both; the edition
 * only fixes what feeds it.
 */
import type { Capability } from "./admin/capabilities";
import type { EnterpriseSettings } from "./admin/settings-store";

export type Edition = "team" | "personal";

/**
 * What the personal edition allows. Fixed: there is no screen to change it, and a row left in the
 * database by a team deployment is not read.
 *
 * Off is what needs a team or a fleet (Slack and Teams, Team Bots, a computer per Bot) and reaching
 * into the person's own machine. Everything else stays on, including the password manager, whose
 * saved logins are only ever used after the person picks one in the private sign-in form.
 */
export const PERSONAL_CAPABILITIES: Record<Capability, boolean> = {
  useBots: true,
  cloudBrowser: true,
  cloudNetwork: true,
  cloudComputer: true,
  localComputer: false,
  customRules: true,
  passwordManager: true,
  slackTeams: false,
  teamBots: false,
  ownerApps: true,
  isolatedComputers: false,
  proactive: true,
};

/**
 * There is one computer, so it is never stopped for sitting idle. Check-ins keep the team limit.
 * The one person picks their own model: there is nobody else to decide it for them.
 */
export const PERSONAL_ENTERPRISE_SETTINGS: EnterpriseSettings = {
  ssoRequired: false,
  actionRecording: false,
  inactiveComputerDays: 0,
  modelAllowlist: { enabled: false, models: [] },
  mcpAllowlist: { enabled: false, servers: [] },
  skillSharing: false,
  proactiveDailyRuns: 24,
  modelSelection: true,
};

let running: Edition = "team";

/**
 * Set once at startup, from the configuration. Module state rather than a parameter, because a
 * capability is resolved and refused in a dozen places across the server and every one of them has
 * to agree; a forgotten argument would quietly fall back to the team edition.
 */
export function setEdition(edition: Edition): void {
  running = edition;
}

export function currentEdition(): Edition {
  return running;
}

/** Unset or empty is `team`, so every deployment that predates the switch is unchanged. */
export function parseEdition(raw: string | undefined): Edition {
  const value = raw?.trim() ?? "";
  if (value === "" || value === "team") return "team";
  if (value === "personal") return "personal";
  throw new Error(
    `OPENBOT_EDITION is "${value}". It must be "team" or "personal", or unset for "team".`,
  );
}
