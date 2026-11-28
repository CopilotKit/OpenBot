import {
  IconHierarchy2,
  IconUserMinus,
  IconUserPlus,
  IconUsersGroup,
} from "@tabler/icons-react";
import {
  type AdminCardState,
  AdminChangeCard,
  AdminChangeDetails,
} from "./admin-card-parts";
import type { ChangeView, TeamsResult } from "./admin-tool-results";

/**
 * `manage_teams`: a team made, renamed or moved, or a person put in or taken out, drawn as the Teams
 * screens draw a team, with who the change reaches: the team's people, since what a team is given
 * is theirs.
 */

/** The mark on each changed row, for what was asked: the tool's own `action`. */
function rowIconOf(action: unknown) {
  if (action === "move") return IconHierarchy2;
  if (action === "add_member") return IconUserPlus;
  if (action === "remove_member") return IconUserMinus;
  return IconUsersGroup;
}

function captionOf(result: TeamsResult) {
  const count = result.team.memberCount;
  return `${result.organization} · ${result.team.name} · ${count} ${count === 1 ? "person" : "people"}`;
}

export function ManageTeamsCard({
  result,
  asked,
  state,
  message,
}: {
  result?: TeamsResult;
  /** What the Bot asked for, which says what the card is about before there's a result. */
  asked?: { action?: unknown };
  state: AdminCardState;
  message?: string;
}) {
  return (
    <AdminChangeCard
      caption={result ? captionOf(result) : "Teams"}
      icon={IconUsersGroup}
      message={message}
      result={result}
      rowIcon={rowIconOf(result?.action ?? asked?.action)}
      state={state}
      title={result?.summary ?? "Manage teams"}
    />
  );
}

/** What the approval card shows while it waits. */
export function ManageTeamsApproval({
  change,
  asked,
}: {
  change: ChangeView;
  asked?: { action?: unknown };
}) {
  return (
    <AdminChangeDetails
      headline
      icon={rowIconOf(asked?.action)}
      result={change}
    />
  );
}
