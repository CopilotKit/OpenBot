import {
  IconChevronRight,
  IconToggleRight,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
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
import { setCapabilityMutationOptions } from "@/lib/enterprise/mutations";
import type { EnterpriseOverview } from "@/lib/enterprise/queries";
import { queryClient } from "@/query-client";
import { ControlsSection } from "./controls-section";

/**
 * Admin, Permissions: what people may do, for the whole organization, with the row that opens the
 * overrides for roles and directory groups. The page's only section, so it has no title of its own.
 */
export function CapabilitiesSection() {
  const [overridesOpen, setOverridesOpen] = useState(false);
  return (
    <ControlsSection>
      {({ data, setCapability, saving }) => {
        const overrideCount = data.capabilities.reduce(
          (count, capability) =>
            count +
            Object.keys(capability.roles).length +
            Object.keys(capability.groups).length,
          0,
        );
        return (
          <>
            <PageRows>
              {data.capabilities.map((capability) => {
                const effective = capability.organization ?? capability.default;
                return (
                  <div key={capability.capability}>
                    <Item size="sm">
                      <ItemMedia variant="icon">
                        <IconToggleRight />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{capability.title}</ItemTitle>
                        <ItemDescription>
                          {effective
                            ? capability.description
                            : "Off for everybody, unless a role or group turns it on."}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Switch
                          aria-label={capability.title}
                          checked={effective}
                          disabled={saving}
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
                  <ItemTitle>Role and group overrides</ItemTitle>
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
  const scopes: { kind: "role" | "group"; id: string; label: string }[] = [
    { kind: "role", id: "admin", label: "Admins" },
    { kind: "role", id: "user", label: "Members" },
    ...data.groups.map((group) => ({
      kind: "group" as const,
      id: group,
      label: `Group: ${group}`,
    })),
  ];
  const [scopeIndex, setScopeIndex] = useState(0);
  const scope = scopes[scopeIndex] ?? scopes[0];

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Role and group overrides</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 space-y-4 overflow-y-auto">
          <Select
            onValueChange={(value) => setScopeIndex(Number(value))}
            value={String(scopeIndex)}
          >
            <SelectTrigger aria-label="Scope">
              <SelectValue>{scope?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {scopes.map((candidate, index) => (
                  <SelectItem
                    key={`${candidate.kind}:${candidate.id}`}
                    value={String(index)}
                  >
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            {scope?.kind === "group"
              ? "A group can only add. Grant gives its members the capability even when the organization has it off."
              : "A role's setting replaces the organization switch for everybody with that role."}
          </p>
          {scope
            ? data.capabilities.map((capability) => {
                const stored =
                  scope.kind === "role"
                    ? capability.roles[scope.id as "admin" | "user"]
                    : capability.groups[scope.id];
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
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="inherit">Inherit</SelectItem>
                          <SelectItem value="on">
                            {scope.kind === "group" ? "Grant" : "On"}
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
