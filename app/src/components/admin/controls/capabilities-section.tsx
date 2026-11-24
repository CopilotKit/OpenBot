import {
  IconChevronRight,
  IconSparkles,
  IconToggleRight,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { BusinessComputerLink } from "@/components/edition/team-features-dialog";
import { PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { isolationUnavailable } from "@/lib/agents/isolation";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { setCapabilityMutationOptions } from "@/lib/enterprise/mutations";
import type {
  CapabilitySetting,
  EnterpriseOverview,
} from "@/lib/enterprise/queries";
import { MISSING_TEAM } from "@/lib/teams/names";
import { teamListQueryOptions } from "@/lib/teams/queries";
import { queryClient } from "@/query-client";
import { ControlsSection } from "./controls-section";

/**
 * Admin, Permissions: what people may do, for the whole organization, with the row that opens the
 * overrides for roles and teams. The page's only section, so it has no title of its own.
 */
export function CapabilitiesSection() {
  const [overridesOpen, setOverridesOpen] = useState(false);
  /*
   * Whether this OpenBot gives a Bot a computer of its own at all. Where it doesn't (one shared computer, or an
   * operator who turned isolated Bots off for every organization), "Isolated Bots" can't do anything: the row says
   * why and its switch is off limits, so an admin isn't shown a setting that has no effect.
   */
  const { data: deployment } = useQuery(deploymentCapabilitiesQueryOptions());
  const noIsolation = deployment?.isolatedBots === false;
  // OpenBot Cloud gives each person one computer: the row says so, with where a Bot can have its own.
  const cloud = deployment?.hostedSignIn === true;
  return (
    <ControlsSection>
      {({ data, setCapability, saving }) => {
        const overrideCount = data.capabilities.reduce(
          (count, capability) =>
            count +
            Object.keys(capability.roles).length +
            Object.keys(capability.teams).length +
            Object.keys(capability.groups).length,
          0,
        );
        return (
          <>
            <PageRows>
              {data.capabilities.map((capability) => {
                const effective = capability.organization ?? capability.default;
                const unavailable =
                  noIsolation && capability.capability === "isolatedComputers";
                return (
                  <div key={capability.capability}>
                    <Item size="sm">
                      <ItemMedia variant="icon">
                        <IconToggleRight />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{capability.title}</ItemTitle>
                        <ItemDescription>
                          {unavailable
                            ? isolationUnavailable(cloud)
                            : effective
                              ? capability.description
                              : "Off for everybody, unless a role or team turns it on."}
                        </ItemDescription>
                        {unavailable && cloud ? (
                          <BusinessComputerLink className="text-xs" />
                        ) : null}
                      </ItemContent>
                      <ItemActions>
                        <Switch
                          aria-label={capability.title}
                          checked={effective && !unavailable}
                          disabled={saving || unavailable}
                          onCheckedChange={(checked) =>
                            setCapability(capability.capability, checked)
                          }
                        />
                      </ItemActions>
                    </Item>
                    <Separator />
                  </div>
                );
              })}
              <Item
                render={
                  <button
                    onClick={() => setOverridesOpen(true)}
                    type="button"
                  />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconUsersGroup />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Role and team overrides</ItemTitle>
                  <ItemDescription>
                    {overrideCount === 0
                      ? "None. Everybody gets the switches above"
                      : `${overrideCount} set`}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
              <Separator />
              <Item
                render={<Link to="/admin/permissions/describe" />}
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconSparkles />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Describe it in words</ItemTitle>
                  <ItemDescription>
                    Say who may use what, and your model writes the changes.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </PageRows>
            <OverridesDialog
              data={data}
              onOpenChange={setOverridesOpen}
              open={overridesOpen}
            />
          </>
        );
      }}
    </ControlsSection>
  );
}

type Tri = "inherit" | "on" | "off";

/** Whose switches the dialog is showing: a role's, a team's, or a directory group's. */
type Scope = { kind: "role" | "team" | "group"; id: string; label: string };

const scopeKey = (scope: Scope) => `${scope.kind}:${scope.id}`;

/** What a scope set a permission to, or undefined where it sets nothing. */
function storedAt(
  capability: CapabilitySetting,
  scope: Scope,
): boolean | undefined {
  if (scope.kind === "role")
    return capability.roles[scope.id as "admin" | "member"];
  return (scope.kind === "team" ? capability.teams : capability.groups)[
    scope.id
  ];
}

const SCOPE_HINTS: Record<Scope["kind"], string> = {
  role: "A role's setting replaces the organization switch for everybody with that role.",
  team: "A team can only add. Grant gives the people in it, and in the teams beneath it, the permission even when the organization has it off.",
  group:
    "This rule is for a directory group. You can remove it here. Make new rules for a team.",
};

/**
 * The switches a role or a team sets over the organization's.
 *
 * A team is picked by name from the organization's teams, and its id is what a switch is saved
 * under. Two kinds of rule are listed only because they are already there, so that nothing is lost
 * and each can be removed: a directory group's, from before there were teams, and one for a team
 * that has since been deleted. Neither can be given a new permission here.
 */
function OverridesDialog({
  data,
  open,
  onOpenChange,
}: {
  data: EnterpriseOverview;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setCapability = useMutation(setCapabilityMutationOptions(queryClient));
  const teams = useQuery({ ...teamListQueryOptions(), enabled: open });
  const known = teams.data?.teams ?? [];
  const named = (level: "teams" | "groups") => [
    ...new Set(
      data.capabilities.flatMap((capability) => Object.keys(capability[level])),
    ),
  ];
  const scopes: Scope[] = [
    { kind: "role", id: "admin", label: "Admins" },
    { kind: "role", id: "member", label: "Members" },
    ...known.map((team) => ({
      kind: "team" as const,
      id: team.id,
      label: `Team: ${team.name}`,
    })),
    // Only once the teams are known: until then a team with a rule can't be told from a deleted one.
    ...(teams.data
      ? named("teams")
          .filter((id) => !known.some((team) => team.id === id))
          .map((id) => ({ kind: "team" as const, id, label: MISSING_TEAM }))
      : []),
    ...named("groups").map((group) => ({
      kind: "group" as const,
      id: group,
      label: `Group: ${group}`,
    })),
  ];
  const [chosen, setChosen] = useState("role:admin");
  // A scope whose last rule was removed is no longer listed, so the dialog goes back to the first.
  const scope =
    scopes.find((candidate) => scopeKey(candidate) === chosen) ??
    (scopes[0] as Scope);
  /* Whether the scope is listed for the rules it already has, and not to be given new ones. */
  const onlyItsRules =
    scope.kind === "group" ||
    (scope.kind === "team" && !known.some((team) => team.id === scope.id));

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Role and team overrides</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 space-y-4 overflow-y-auto">
          <Select
            onValueChange={(value) => setChosen(String(value))}
            value={scopeKey(scope)}
          >
            {/* As wide as the dialog, as a team is picked on every other screen: the list is as wide
                as its trigger, and a team's name is longer than "Admins". */}
            <SelectTrigger aria-label="Scope" className="w-full">
              <SelectValue>{scope.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {scopes.map((candidate) => (
                  // A long name wraps under itself: cut short, two teams could read alike.
                  <SelectItem
                    className="*:first:whitespace-normal"
                    key={scopeKey(candidate)}
                    value={scopeKey(candidate)}
                  >
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {teams.error ? (
            <p className="text-destructive text-sm" role="alert">
              Couldn't load teams. Try again in a moment.
            </p>
          ) : null}
          <p className="text-muted-foreground text-xs">
            {scope.kind === "team" && onlyItsRules
              ? "This team no longer exists. You can remove its rules here."
              : SCOPE_HINTS[scope.kind]}
          </p>
          {scope
            ? data.capabilities.map((capability) => {
                const stored = storedAt(capability, scope);
                if (onlyItsRules && stored === undefined) return null;
                const value: Tri =
                  stored === undefined ? "inherit" : stored ? "on" : "off";
                return (
                  <div
                    className="flex items-center justify-between gap-4"
                    key={capability.capability}
                  >
                    <Label>{capability.title}</Label>
                    <Select
                      onValueChange={(next) =>
                        setCapability.mutate({
                          scopeKind: scope.kind,
                          scopeId: scope.id,
                          capability: capability.capability,
                          allowed: next === "inherit" ? null : next === "on",
                        })
                      }
                      value={value}
                    >
                      <SelectTrigger
                        aria-label={`${capability.title} for ${scope.label}`}
                        className="w-36"
                      >
                        {/* The words the list offers, where the trigger alone would show the value. */}
                        <SelectValue>
                          {value === "inherit"
                            ? "Inherit"
                            : value === "off"
                              ? "Off"
                              : scope.kind === "role"
                                ? "On"
                                : "Grant"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="inherit">Inherit</SelectItem>
                          <SelectItem value="on">
                            {scope.kind === "role" ? "On" : "Grant"}
                          </SelectItem>
                          {scope.kind === "role" ? (
                            <SelectItem value="off">Off</SelectItem>
                          ) : null}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                );
              })
            : null}
          {setCapability.error ? (
            <p className="text-destructive text-sm" role="alert">
              {setCapability.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={() => onOpenChange(false)} size="sm" type="button">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
