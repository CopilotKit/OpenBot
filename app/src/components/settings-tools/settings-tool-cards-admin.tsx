import type { AdminCardState } from "./admin-card-parts";
import { adminResultOf, changeViewOf } from "./admin-tool-results";
import { ManagePeopleApproval, ManagePeopleCard } from "./manage-people-card";
import { ManageTeamsApproval, ManageTeamsCard } from "./manage-teams-card";
import type {
  SettingsApprovalBodies,
  SettingsToolCardProps,
  SettingsToolCards,
} from "./registry";
import {
  UpdateOrganizationSettingsApproval,
  UpdateOrganizationSettingsCard,
} from "./update-organization-settings-card";

/**
 * The cards for an admin's changes to the organization: `update_organization_settings`,
 * `manage_people`, `manage_teams`. One file per tool beside this one, registered here by name.
 *
 * A card reads the tool's structured output, which carries everything it draws (what changed, who
 * it reaches, the screens it shows on), so it is the same live and after a reload.
 */

/** The output as this tool's card reads it, when it is this tool's. */
function resultFor<K extends "organization_settings" | "people" | "teams">(
  props: SettingsToolCardProps,
  kind: K,
) {
  const result = adminResultOf(props.output);
  return result?.kind === kind
    ? (result as Extract<NonNullable<typeof result>, { kind: K }>)
    : undefined;
}

const stateOf = (props: SettingsToolCardProps): AdminCardState => props.state;

export const adminSettingsToolCards: SettingsToolCards = {
  update_organization_settings: (props) => (
    <UpdateOrganizationSettingsCard
      message={props.reason}
      result={resultFor(props, "organization_settings")}
      state={stateOf(props)}
    />
  ),
  manage_people: (props) => (
    <ManagePeopleCard
      asked={props.args}
      message={props.reason}
      result={resultFor(props, "people")}
      state={stateOf(props)}
    />
  ),
  manage_teams: (props) => (
    <ManageTeamsCard
      asked={props.args}
      message={props.reason}
      result={resultFor(props, "teams")}
      state={stateOf(props)}
    />
  ),
};

/** Their own bodies for the approval card: the same rows the card draws, before anything is saved. */
export const adminSettingsApprovalBodies: SettingsApprovalBodies = {
  update_organization_settings: ({ change }) => {
    const view = changeViewOf(change);
    return view ? <UpdateOrganizationSettingsApproval change={view} /> : null;
  },
  manage_people: ({ change, args }) => {
    const view = changeViewOf(change);
    return view ? <ManagePeopleApproval asked={args} change={view} /> : null;
  },
  manage_teams: ({ change, args }) => {
    const view = changeViewOf(change);
    return view ? <ManageTeamsApproval asked={args} change={view} /> : null;
  },
};
