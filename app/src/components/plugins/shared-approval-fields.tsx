import { IconBuildingBank, IconUsersGroup } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Fragment, type ReactNode, useId } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  type ApprovalMember,
  approvalNamesNobody,
  type SharedUseApproval,
} from "@/lib/plugins/shared-use";
import { MISSING_TEAM } from "@/lib/teams/names";
import { teamListQueryOptions } from "@/lib/teams/queries";
import { failureSaid } from "@/lib/load-failure";

export function sharedSectionSentence(
  effect: "read" | "write",
  shared: boolean,
): string | null {
  if (!shared) return null;
  return effect === "write"
    ? "Anyone who can use this Bot can do this as the shared account."
    : "Anyone who can use this Bot can read what this account can read.";
}

const AUDIENCES: { audience: SharedUseApproval["audience"]; label: string }[] =
  [
    { audience: "owner", label: "Only its owner" },
    { audience: "people", label: "Named teams and people" },
    { audience: "team", label: "Everyone" },
  ];

/**
 * Who may use a shared account through one Bot: the audience the Bot has now, offered as the
 * default, which an admin can change here. Only its owner, everyone in the organization, or the
 * teams the admin names. Whoever the audience already names (people, and directory groups from
 * before there were teams) is kept and shown under the named choice.
 */
export function SharedApprovalFields({
  value,
  onChange,
}: {
  value: SharedUseApproval;
  onChange: (next: SharedUseApproval) => void;
}) {
  return (
    <fieldset className="min-w-0 space-y-2 text-sm">
      <legend className="font-medium">
        Who can use the shared account through this Bot
      </legend>
      {AUDIENCES.map((option) => (
        <Fragment key={option.audience}>
          <label className="flex items-center gap-2">
            <input
              checked={value.audience === option.audience}
              name="shared-audience"
              onChange={() =>
                onChange({
                  ...value,
                  audience: option.audience,
                  members: option.audience === "people" ? value.members : [],
                })
              }
              type="radio"
            />
            {option.label}
          </label>
          {/* Under the choice it belongs to, so the teams never read as part of the one after. */}
          {option.audience === "people" && value.audience === "people" ? (
            <NamedMembers onChange={onChange} value={value} />
          ) : null}
        </Fragment>
      ))}
      <label className="flex items-center gap-2">
        <input
          checked={value.outsideInput}
          onChange={(event) =>
            onChange({ ...value, outsideInput: event.target.checked })
          }
          type="checkbox"
        />
        Messages from outside (email, Slack, webhooks) can use it
      </label>
    </fieldset>
  );
}

/**
 * Who a named audience names. The organization's teams are ticked by name, and a ticked team is kept
 * as a member of kind `team` holding its id. What the audience named before is listed beneath and
 * can be taken out: a directory group by its own name, and a team that has been deleted since.
 * People are counted, as the line describing an approval counts them.
 *
 * Mounted only for a named audience, so the organization's teams are read once, when they are needed.
 * Stacked in one column for the dialog it sits in.
 */
function NamedMembers({
  value,
  onChange,
}: {
  value: SharedUseApproval;
  onChange: (next: SharedUseApproval) => void;
}) {
  const id = useId();
  const teams = useQuery(teamListQueryOptions());
  const chosen = new Set(
    value.members
      .filter((member) => member.kind === "team")
      .map((member) => member.value),
  );
  const without = (gone: ApprovalMember) =>
    value.members.filter(
      (member) => !(member.kind === gone.kind && member.value === gone.value),
    );
  const toggle = (teamId: string) => {
    const member: ApprovalMember = { kind: "team", value: teamId };
    onChange({
      ...value,
      members: chosen.has(teamId)
        ? without(member)
        : [...value.members, member],
    });
  };
  const remove = (member: ApprovalMember) =>
    onChange({ ...value, members: without(member) });

  const groups = value.members.filter((member) => member.kind === "group");
  // Only once the teams have arrived: before that, a team not found is a team not loaded yet.
  const deleted = teams.data
    ? value.members.filter(
        (member) =>
          member.kind === "team" &&
          !teams.data.teams.some((team) => team.id === member.value),
      )
    : [];
  const people = value.members.filter(
    (member) => member.kind === "user",
  ).length;

  return (
    <div className="flex min-w-0 flex-col gap-3 ps-6" data-shared-named>
      {/* A group of tickboxes named by the heading above it, as the Publish dialog lists teams. */}
      <fieldset
        aria-labelledby={`${id}-teams`}
        className="flex min-w-0 flex-col gap-2"
      >
        <p className="font-medium text-xs leading-none" id={`${id}-teams`}>
          Teams
        </p>
        {teams.isPending ? null : teams.error ? (
          <p className="text-destructive text-sm" role="alert">
            {failureSaid(teams.error)}
          </p>
        ) : teams.data.teams.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            There are no teams yet. Create one on the Teams page.
          </p>
        ) : (
          <div className="max-h-48 space-y-2 overflow-y-auto">
            {teams.data.teams.map((team) => (
              // A long name wraps under itself: cut short, two teams could read alike.
              <div className="flex items-start gap-2" key={team.id}>
                <Checkbox
                  checked={chosen.has(team.id)}
                  className="mt-0.5"
                  id={`${id}-team-${team.id}`}
                  onCheckedChange={() => toggle(team.id)}
                />
                <label
                  className="min-w-0 break-words text-sm"
                  htmlFor={`${id}-team-${team.id}`}
                >
                  {team.name}
                </label>
              </div>
            ))}
          </div>
        )}
      </fieldset>
      {deleted.length > 0 || groups.length > 0 ? (
        <div className="flex flex-col gap-2">
          {deleted.map((member) => (
            <NamedRow
              icon={<IconUsersGroup />}
              key={`team:${member.value}`}
              onRemove={() => remove(member)}
              removeLabel="Remove a team that no longer exists"
              title={MISSING_TEAM}
            />
          ))}
          {groups.map((member) => (
            <NamedRow
              description="Directory group"
              icon={<IconBuildingBank />}
              key={`group:${member.value}`}
              onRemove={() => remove(member)}
              removeLabel={`Remove directory group ${member.value}`}
              title={member.value}
            />
          ))}
        </div>
      ) : null}
      {people > 0 ? (
        <p className="text-muted-foreground text-sm">
          {people === 1 ? "1 person is named." : `${people} people are named.`}
        </p>
      ) : null}
      {approvalNamesNobody(value) && teams.data?.teams.length ? (
        <p className="text-muted-foreground text-sm">Choose a team.</p>
      ) : null}
    </div>
  );
}

/** One thing the audience already names, with the button that takes it out. Muted, for a dialog. */
function NamedRow({
  icon,
  title,
  description,
  removeLabel,
  onRemove,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  removeLabel: string;
  onRemove: () => void;
}) {
  return (
    <Item data-shared-member size="xs" variant="muted">
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="line-clamp-none break-words">{title}</ItemTitle>
        {description ? <ItemDescription>{description}</ItemDescription> : null}
      </ItemContent>
      <ItemActions>
        <Button
          aria-label={removeLabel}
          onClick={onRemove}
          size="sm"
          type="button"
          variant="ghost"
        >
          Remove
        </Button>
      </ItemActions>
    </Item>
  );
}
