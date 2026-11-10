import {
  IconChecklist,
  IconChevronRight,
  IconCreditCard,
  IconEyeCheck,
  IconKey,
  IconLock,
  IconNotes,
  IconSend,
  IconShare,
  IconSparkles,
  IconSpeakerphone,
  IconTerminal2,
  IconTrash,
  IconUserCog,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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
  type ActionKind,
  type ActionKindPolicy,
  approvalInboxOptions,
  createTeamApprovalRuleMutationOptions,
  revokeTeamApprovalRuleMutationOptions,
  teamApprovalSettingsMutationOptions,
  updateTeamApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { reviewerGuidanceQueryOptions } from "@/lib/reviewer-guidance/queries";
import { queryClient } from "@/query-client";
import { HOST_LABELS, LabelSelect, RuleForm, RuleRow } from "./rules";
import { SharedUseRequests } from "./shared-use-requests";

/** The kinds of action Bots ask about by name, in the order members meet them. */
const ACTION_KIND_ROWS: {
  kind: ActionKind;
  title: string;
  icon: typeof IconSend;
}[] = [
  { kind: "sending", title: "Sending to other people", icon: IconSend },
  { kind: "deleting", title: "Deleting", icon: IconTrash },
  { kind: "sharing", title: "Sharing", icon: IconShare },
  {
    kind: "publishing",
    title: "Posting and publishing",
    icon: IconSpeakerphone,
  },
  { kind: "payments", title: "Paying and buying", icon: IconCreditCard },
  {
    kind: "security_settings",
    title: "Security and access settings",
    icon: IconLock,
  },
  {
    kind: "credentials",
    title: "Passwords and sign-in details",
    icon: IconKey,
  },
];

/** What members can do about one kind of action. Open unless the admin closes it. */
const ACTION_KIND_LABELS: Record<ActionKindPolicy, string> = {
  open: "Members choose",
  ask: "Ask every time",
  hand_off: "Members do it themselves",
};

/**
 * What every member's Bots must do, set by an administrator: the team-wide controls, the rules that
 * apply to everyone, and requests to use a shared account. Members read the team rules, locked, in
 * Settings → Approvals.
 */
export function TeamApprovalSettings() {
  const inbox = useQuery(approvalInboxOptions());
  const guidance = useQuery(reviewerGuidanceQueryOptions());
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
    inbox.error ?? team.error ?? changeTeamRule.error ?? revokeTeam.error;
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
            <Item render={<Link to="/admin/approvals/guidance" />} size="sm">
              <ItemMedia variant="icon">
                <IconNotes />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Guidance for auto-review</ItemTitle>
                <ItemDescription>
                  {guidance.isPending
                    ? null
                    : guidance.error
                      ? "Couldn't load the guidance."
                      : (guidance.data ??
                        "None. Tell the reviewer what your organization needs a person for.")}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
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
      {settings ? (
        <PageSection
          description="Bots ask before these. With Members choose, a member can allow one once, for a conversation, or always. Ask every time leaves only Allow once and Deny."
          title="Actions that ask first"
        >
          <PageRows>
            {ACTION_KIND_ROWS.map(({ kind, title, icon: Icon }, index) => (
              <Fragment key={kind}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <Icon />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{title}</ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    <LabelSelect
                      disabled={team.isPending}
                      label={title}
                      labels={ACTION_KIND_LABELS}
                      onChange={(policy) =>
                        team.mutate({ actionKinds: { [kind]: policy } })
                      }
                      value={settings.actionKinds?.[kind] ?? "open"}
                    />
                  </ItemActions>
                </Item>
              </Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}
      <PageSection
        description="These apply to every member's Bots. Members can't change them."
        title="Team rules"
      >
        {teamRules.length === 0 ? (
          <PageEmpty icon={IconChecklist} title="No team rules" />
        ) : null}
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
          <Item render={<Link to="/admin/approvals/describe" />} size="sm">
            <ItemMedia variant="icon">
              <IconSparkles />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Describe it in words</ItemTitle>
              <ItemDescription>
                Say what Bots should do, and your model writes the rules.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
          <Separator />
          <RuleForm label="Add a team rule" save={addTeamRule} />
        </PageRows>
      </PageSection>
      <SharedUseRequests />
    </>
  );
}
