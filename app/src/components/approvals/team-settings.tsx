import { useMutation, useQuery } from "@tanstack/react-query";
import { PageSection } from "@/components/layout/page-shell";
import { Switch } from "@/components/ui/switch";
import {
  approvalInboxOptions,
  createTeamApprovalRuleMutationOptions,
  type HostCommandPolicy,
  revokeTeamApprovalRuleMutationOptions,
  teamApprovalSettingsMutationOptions,
  updateTeamApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { queryClient } from "@/query-client";
import { HOST_LABELS, RuleForm, RuleRow, selectClass } from "./rules";
import { SharedUseRequests } from "./shared-use-requests";

/**
 * What every member's Bots must do, set by an administrator: the team-wide controls, the rules that
 * apply to everyone, and requests to use a shared account. Members read the team rules, locked, in
 * Settings → Approvals.
 */
export function TeamApprovalSettings() {
  const inbox = useQuery(approvalInboxOptions());
  const team = useMutation(teamApprovalSettingsMutationOptions(queryClient));
  const addTeamRule = useMutation(
    createTeamApprovalRuleMutationOptions(queryClient),
  );
  const changeTeamRule = useMutation(
    updateTeamApprovalRuleMutationOptions(queryClient),
  );
  const revokeTeam = useMutation(
    revokeTeamApprovalRuleMutationOptions(queryClient),
  );
  const error =
    inbox.error ??
    team.error ??
    addTeamRule.error ??
    changeTeamRule.error ??
    revokeTeam.error;
  if (inbox.isPending && !error) return null;
  const settings = inbox.data?.team;
  const teamRules = inbox.data?.teamRules ?? [];

  return (
    <>
      {error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {settings ? (
        <PageSection title="Team settings">
          <div className="mt-4 space-y-3">
            <label
              htmlFor="enforce-auto-review"
              className="flex items-center justify-between gap-4 rounded-lg border p-4"
            >
              <span id="enforce-auto-review-title" className="font-medium">
                Require auto-review for everyone
              </span>
              <Switch
                id="enforce-auto-review"
                aria-labelledby="enforce-auto-review-title"
                checked={settings.enforceAutoReview}
                disabled={team.isPending}
                onCheckedChange={(enforceAutoReview) =>
                  team.mutate({ enforceAutoReview })
                }
              />
            </label>
            <label
              htmlFor="custom-rules"
              className="flex items-center justify-between gap-4 rounded-lg border p-4"
            >
              <span id="custom-rules-title" className="font-medium">
                Let members set personal rules
              </span>
              <Switch
                id="custom-rules"
                aria-labelledby="custom-rules-title"
                checked={settings.customRulesEnabled}
                disabled={team.isPending}
                onCheckedChange={(customRulesEnabled) =>
                  team.mutate({ customRulesEnabled })
                }
              />
            </label>
            <label
              htmlFor="host-commands-cap"
              className="flex items-center justify-between gap-4 rounded-lg border p-4"
            >
              <span>
                <span className="block font-medium">
                  Commands on members' computers, at most
                </span>
                <span className="text-sm text-muted-foreground">
                  A member's own stricter setting still applies.
                </span>
              </span>
              <select
                id="host-commands-cap"
                aria-label="Commands on members' computers, at most"
                className={selectClass}
                value={settings.hostCommandsCap}
                disabled={team.isPending}
                onChange={(event) =>
                  team.mutate({
                    hostCommandsCap: event.target.value as HostCommandPolicy,
                  })
                }
              >
                {(Object.keys(HOST_LABELS) as HostCommandPolicy[]).map(
                  (key) => (
                    <option key={key} value={key}>
                      {HOST_LABELS[key]}
                    </option>
                  ),
                )}
              </select>
            </label>
          </div>
        </PageSection>
      ) : null}
      <PageSection
        description="These apply to every member's Bots, and members cannot change them."
        title="Team rules"
      >
        <div className="mt-4 space-y-3">
          {teamRules.map((rule) => (
            <RuleRow
              disabled={revokeTeam.isPending || changeTeamRule.isPending}
              key={rule.id}
              onChange={(behaviour) =>
                changeTeamRule.mutate({ id: rule.id, behaviour })
              }
              onRevoke={() => revokeTeam.mutate(rule.id)}
              rule={rule}
              team
            />
          ))}
          {teamRules.length === 0 ? (
            <p className="text-sm text-muted-foreground">No team rules.</p>
          ) : null}
          <RuleForm
            label="Add a team rule"
            onSave={(input) => addTeamRule.mutate(input)}
            pending={addTeamRule.isPending}
          />
        </div>
      </PageSection>
      <div className="mt-12">
        <SharedUseRequests />
      </div>
    </>
  );
}
