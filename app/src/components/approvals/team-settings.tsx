import { IconEyeCheck, IconTerminal2, IconUserCog } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  approvalInboxOptions,
  createTeamApprovalRuleMutationOptions,
  revokeTeamApprovalRuleMutationOptions,
  teamApprovalSettingsMutationOptions,
  updateTeamApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { queryClient } from "@/query-client";
import { HOST_LABELS, LabelSelect, RuleForm, RuleRow } from "./rules";
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
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconEyeCheck />
              </ItemMedia>
              <ItemContent>
                <ItemTitle id="enforce-auto-review-title">
                  Require auto-review for everyone
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-labelledby="enforce-auto-review-title"
                  checked={settings.enforceAutoReview}
                  disabled={team.isPending}
                  onCheckedChange={(enforceAutoReview) =>
                    team.mutate({ enforceAutoReview })
                  }
                />
              </ItemActions>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconUserCog />
              </ItemMedia>
              <ItemContent>
                <ItemTitle id="custom-rules-title">
                  Let members set personal rules
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-labelledby="custom-rules-title"
                  checked={settings.customRulesEnabled}
                  disabled={team.isPending}
                  onCheckedChange={(customRulesEnabled) =>
                    team.mutate({ customRulesEnabled })
                  }
                />
              </ItemActions>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconTerminal2 />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Commands on members' computers, at most</ItemTitle>
                <ItemDescription>
                  A member's own stricter setting still applies.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <LabelSelect
                  disabled={team.isPending}
                  label="Commands on members' computers, at most"
                  labels={HOST_LABELS}
                  onChange={(hostCommandsCap) =>
                    team.mutate({ hostCommandsCap })
                  }
                  value={settings.hostCommandsCap}
                />
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
      ) : null}
      <PageSection
        description="These apply to every member's Bots, and members cannot change them."
        title="Team rules"
      >
        {teamRules.length === 0 ? <PageEmpty>No team rules.</PageEmpty> : null}
        <PageRows>
          {teamRules.map((rule) => (
            <Fragment key={rule.id}>
              <RuleRow
                disabled={revokeTeam.isPending || changeTeamRule.isPending}
                onChange={(behaviour) =>
                  changeTeamRule.mutate({ id: rule.id, behaviour })
                }
                onRevoke={() => revokeTeam.mutate(rule.id)}
                rule={rule}
                team
              />
              <Separator />
            </Fragment>
          ))}
          <RuleForm
            label="Add a team rule"
            onSave={(input) => addTeamRule.mutate(input)}
            pending={addTeamRule.isPending}
          />
        </PageRows>
      </PageSection>
      <SharedUseRequests />
    </>
  );
}
