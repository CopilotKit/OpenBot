import {
  IconBuilding,
  IconChecklist,
  IconDeviceDesktop,
  IconFolder,
  IconKey,
  IconMessage,
  IconPlug,
  IconRobot,
  IconTrash,
  IconUser,
  IconUserShield,
  IconUsersGroup,
} from "@tabler/icons-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Fragment } from "react";
import type { AuditEvent } from "@/components/audit/audit-cells";
import {
  type ReplayRow,
  ReplayRows,
} from "@/components/boundaries/dry-run-changes";
import { PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import type {
  CapabilityAnswer,
  CapabilityPreview,
  PreviewCapability,
  PreviewPerson,
} from "@/lib/capability-changes/queries";
import type {
  CapabilityChange,
  CapabilityChangeProblem,
} from "@/lib/capability-changes/translate";
import { cn } from "@/lib/utils";

/** Who a switch is for, as the Permissions page and its overrides name them. */
function scopeWords(change: CapabilityChange): string {
  if (change.scopeKind === "organization") return "Everybody";
  if (change.scopeKind === "role")
    return change.scopeId === "admin" ? "Admins" : "Members";
  return `Group: ${change.scopeId}`;
}

const SCOPE_ICONS = {
  organization: IconBuilding,
  role: IconUserShield,
  group: IconUsersGroup,
};

/** What a switch is set to, in the overrides dialog's words: a group grants, the rest turn on or off. */
function settingWords(change: CapabilityChange): {
  text: string;
  className: string;
} {
  if (change.allowed === null)
    return { text: "Inherit", className: "text-muted-foreground" };
  if (!change.allowed) return { text: "Off", className: "text-destructive" };
  return {
    text: change.scopeKind === "group" ? "Grant" : "On",
    className: "text-emerald-600 dark:text-emerald-400",
  };
}

/**
 * The switches the model wrote, one row each, in the Permissions page's own words. Any can be removed
 * before saving; what is wrong with one, as the server checks them as they stand, is said under it.
 */
export function ChangeRows({
  changes,
  titles,
  problems,
  onRemove,
}: {
  changes: CapabilityChange[];
  /** Each permission's title, from the Permissions page's own list. */
  titles: Partial<Record<string, string>>;
  problems: CapabilityChangeProblem[];
  onRemove: (index: number) => void;
}) {
  return (
    <Field>
      <FieldLabel>Changes</FieldLabel>
      <FieldDescription>
        Each change sets one switch. Remove any you don't want before you save.
      </FieldDescription>
      <PageRows>
        {changes.map((change, index) => {
          const row = index + 1;
          const Icon = SCOPE_ICONS[change.scopeKind];
          const setting = settingWords(change);
          const title = titles[change.capability] ?? change.capability;
          const wrong = problems.filter((problem) => problem.change === row);
          return (
            // Index-keyed: a change has no identity apart from its place until it is saved.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <Fragment key={index}>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <Icon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{title}</ItemTitle>
                  <ItemDescription>{scopeWords(change)}</ItemDescription>
                  {wrong.map((problem) => (
                    <p className="text-destructive text-sm" key={problem.field}>
                      {problem.message}
                    </p>
                  ))}
                </ItemContent>
                <ItemActions>
                  <span
                    className={cn("font-medium text-sm", setting.className)}
                  >
                    {setting.text}
                  </span>
                  <Button
                    aria-label={`Remove change ${row}`}
                    onClick={() => onRemove(index)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <IconTrash />
                  </Button>
                </ItemActions>
              </Item>
              {index !== changes.length - 1 && <Separator />}
            </Fragment>
          );
        })}
      </PageRows>
    </Field>
  );
}

/** Why a person has a permission or not, after "Now" or "After this,". */
function answerWords(answer: CapabilityAnswer): string {
  const state = answer.allowed ? "on" : "off";
  switch (answer.decidedBy) {
    case "default":
      return `${state} by default`;
    case "organization":
      return `${state} for everybody`;
    case "role":
      return `${state} for ${answer.scopeId === "admin" ? "admins" : "members"}`;
    case "group":
      return `on through ${answer.scopeId}`;
  }
}

const loses = (capability: PreviewCapability) =>
  capability.before.allowed && !capability.after.allowed;
const gains = (capability: PreviewCapability) =>
  !capability.before.allowed && capability.after.allowed;

function verdictOf(person: PreviewPerson): { text: string; className: string } {
  if (person.capabilities.some(loses))
    return { text: "Loses access", className: "text-destructive" };
  if (person.capabilities.some(gains))
    return {
      text: "Gains access",
      className: "text-emerald-600 dark:text-emerald-400",
    };
  return { text: "Keeps access", className: "text-muted-foreground" };
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** The preview in one sentence: "3 people lose access and 4 people keep it through a different switch." */
export function previewHeadline(counts: CapabilityPreview["counts"]): string {
  const parts = [
    counts.losing > 0
      ? `${plural(counts.losing, "person loses", "people lose")} access`
      : null,
    counts.gaining > 0
      ? `${plural(counts.gaining, "person gains", "people gain")} access`
      : null,
    counts.keeping > 0
      ? `${plural(counts.keeping, "person keeps", "people keep")} it through a different switch`
      : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return "Nobody's access changes.";
  const sentence =
    parts.length > 1
      ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
      : (parts[0] as string);
  return `${sentence}.`;
}

/** What a person's recent use of a permission they lose comes to, in one line. */
function activityWords(
  capability: PreviewCapability,
  unmapped: ReadonlySet<string>,
  days: number,
): string | null {
  if (!loses(capability)) return null;
  if (unmapped.has(capability.capability))
    return "OpenBot doesn't record its use.";
  const activity = capability.activity;
  if (!activity) return null;
  if (activity.count === 0) return `Not used in the last ${days} days.`;
  return `${activity.count}${activity.more ? " or more" : ""} in the last ${days} days: ${activity.what}.`;
}

/** Where a past action acted, for the mark beside it. */
function mediaOf(event: AuditEvent): ReplayRow["media"] {
  if (event.targetType === "host_access")
    return { icon: <IconFolder />, label: "Folder on their own computer" };
  if (event.eventType.startsWith("computer."))
    return { icon: <IconDeviceDesktop />, label: "Computer action" };
  if (event.eventType.startsWith("password."))
    return { icon: <IconKey />, label: "Login" };
  if (event.eventType.startsWith("delivery."))
    return { icon: <IconMessage />, label: "Messaging app" };
  if (event.eventType.startsWith("bot."))
    return { icon: <IconRobot />, label: "Bot" };
  if (event.eventType.startsWith("approval."))
    return { icon: <IconChecklist />, label: "Approval rule" };
  return { icon: <IconPlug />, label: "App call" };
}

/**
 * Who the changes would change, worked out on the server by the rule OpenBot enforces: the headline,
 * then each person with their permissions now and after, then the recent use of what they would lose,
 * in Audit's own cells, as a boundary's preview lists what it would stop.
 */
export function PermissionsPreview({
  preview,
}: {
  preview: UseQueryResult<CapabilityPreview>;
}) {
  if (preview.isPending) return null;
  if (preview.error)
    return (
      <Field>
        <FieldLabel>Who it changes</FieldLabel>
        <p className="text-destructive text-sm" role="alert">
          {preview.error.message}
        </p>
      </Field>
    );
  const data = preview.data;
  // Changes that don't check say so on their rows; there is nothing to preview.
  if (!data.check.ok) return null;
  const unmapped = new Set(
    data.activity.unmapped.map((entry) => entry.capability),
  );
  const nameOf = (person: PreviewPerson) => person.name ?? person.email;
  const used: ReplayRow[] = data.people.flatMap((person) =>
    person.capabilities.flatMap((capability) =>
      loses(capability)
        ? (capability.activity?.recent ?? []).map((event) => ({
            id: `${person.id}:${event.id}`,
            event,
            media: mediaOf(event),
            verdict: "Would be blocked",
            note: `${nameOf(person)}, ${capability.title}`,
          }))
        : [],
    ),
  );
  const usedTotal = data.people.reduce(
    (sum, person) =>
      sum +
      person.capabilities.reduce(
        (inner, capability) =>
          inner + (loses(capability) ? (capability.activity?.count ?? 0) : 0),
        0,
      ),
    0,
  );
  const listed = data.counts.losing + data.counts.gaining + data.counts.keeping;

  return (
    <>
      <Field aria-labelledby="permissions-preview" aria-live="polite">
        <FieldLabel id="permissions-preview">Who it changes</FieldLabel>
        <div>
          <p className="font-medium text-sm">{previewHeadline(data.counts)}</p>
          <FieldDescription className="mt-1">
            Worked out for all {plural(data.counts.people, "person", "people")}{" "}
            with the rule OpenBot enforces.
            {data.counts.unchanged > 0
              ? ` ${plural(data.counts.unchanged, "person isn't", "people aren't")} affected.`
              : ""}
          </FieldDescription>
        </div>
        {data.warning ? (
          <p className="text-amber-600 text-sm dark:text-amber-500">
            {data.warning}
          </p>
        ) : null}
        {data.people.length > 0 ? (
          <PageRows>
            {data.people.map((person, index) => {
              const verdict = verdictOf(person);
              return (
                <Fragment key={person.id}>
                  <Item size="sm">
                    <ItemMedia
                      className="translate-y-0.5 self-start"
                      variant="icon"
                    >
                      <IconUser />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle>{nameOf(person)}</ItemTitle>
                      <ItemDescription className="line-clamp-none">
                        {person.role === "admin" ? "Admin" : "Member"}
                        {person.groups.length > 0
                          ? ` in ${person.groups.join(", ")}`
                          : ", in no group"}
                      </ItemDescription>
                      {person.capabilities
                        .filter(
                          (capability) =>
                            capability.before.allowed !==
                              capability.after.allowed ||
                            capability.before.decidedBy !==
                              capability.after.decidedBy ||
                            capability.before.scopeId !==
                              capability.after.scopeId,
                        )
                        .map((capability) => {
                          const activity = activityWords(
                            capability,
                            unmapped,
                            data.activity.days,
                          );
                          return (
                            <div
                              className="mt-1.5 text-sm"
                              key={capability.capability}
                            >
                              <p>
                                <span className="font-medium">
                                  {capability.title}.
                                </span>{" "}
                                Now {answerWords(capability.before)}. After
                                this, {answerWords(capability.after)}.
                              </p>
                              {activity ? (
                                <p className="text-muted-foreground text-xs">
                                  {activity}
                                </p>
                              ) : null}
                            </div>
                          );
                        })}
                    </ItemContent>
                    <ItemActions className="self-start">
                      <span
                        className={cn("font-medium text-sm", verdict.className)}
                      >
                        {verdict.text}
                      </span>
                    </ItemActions>
                  </Item>
                  {index !== data.people.length - 1 && <Separator />}
                </Fragment>
              );
            })}
          </PageRows>
        ) : null}
        {listed > data.people.length ? (
          <p className="text-muted-foreground text-xs">
            Showing the first {data.people.length} of {listed}.
          </p>
        ) : null}
        {data.activity.unmapped.length > 0 ? (
          <FieldDescription>
            OpenBot doesn't record use of{" "}
            {data.activity.unmapped.map((entry) => entry.title).join(", ")}, so
            recent use isn't shown for it.
          </FieldDescription>
        ) : null}
      </Field>
      {used.length > 0 ? (
        <Field aria-labelledby="permissions-used">
          <FieldLabel id="permissions-used">
            Used in the last {data.activity.days} days
          </FieldLabel>
          <FieldDescription>
            The newest actions people took with what they would lose, from
            Audit.
          </FieldDescription>
          <ReplayRows rows={used} total={usedTotal} />
        </Field>
      ) : null}
    </>
  );
}
