import {
  IconAdjustmentsHorizontal,
  IconToggleRight,
} from "@tabler/icons-react";
import {
  type AdminCardState,
  AdminChangeCard,
  AdminChangeDetails,
} from "./admin-card-parts";
import type {
  ChangeView,
  OrganizationSettingsResult,
} from "./admin-tool-results";

/**
 * `update_organization_settings`: a change to the organization's settings or permissions, drawn as
 * the Admin screens draw those switches. Each row is the setting by its screen's name, with what it
 * was and what it is now; under them, who the change reaches, from the Permissions screen's preview.
 */

export function UpdateOrganizationSettingsCard({
  result,
  state,
  message,
}: {
  result?: OrganizationSettingsResult;
  state: AdminCardState;
  message?: string;
}) {
  return (
    <AdminChangeCard
      caption={
        result
          ? `${result.organization} · Organization settings`
          : "Organization settings"
      }
      icon={IconAdjustmentsHorizontal}
      message={message}
      result={result}
      rowIcon={IconToggleRight}
      state={state}
      title={result?.summary ?? "Change organization settings"}
    />
  );
}

/** What the approval card shows while it waits: the same rows, before anything is saved. */
export function UpdateOrganizationSettingsApproval({
  change,
}: {
  change: ChangeView;
}) {
  return <AdminChangeDetails headline icon={IconToggleRight} result={change} />;
}
