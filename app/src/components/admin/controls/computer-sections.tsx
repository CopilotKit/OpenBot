import {
  IconChevronRight,
  IconDeviceDesktop,
  IconNetwork,
  IconWorld,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
import { Textarea } from "@/components/ui/textarea";
import {
  removeNetworkPolicyMutationOptions,
  setNetworkPolicyMutationOptions,
  terminateInactiveComputersMutationOptions,
} from "@/lib/enterprise/mutations";
import type {
  EgressRule,
  EnterpriseOverview,
  NetworkMode,
  NetworkPolicy,
} from "@/lib/enterprise/queries";
import { queryClient } from "@/query-client";
import { ControlsSection } from "./controls-section";
import {
  AllowlistPreview,
  AllowlistReading,
  DescribeAllowlist,
  type WrittenAllowlist,
} from "./network-describe";

const MODE_NAMES: Record<NetworkMode, string> = {
  allow_all: "Allow all network access",
  defaults_plus_allowlist: "Defaults plus team allowlist",
  allowlist_only: "Team allowlist only",
};

/**
 * One rule per line: `example.com`, `*.corp.example`, `intranet.example 8443` or `10.0.0.0/8 443,8443`.
 *
 * A domain keeps its ports, as an IP range always has. It used to drop them, so opening a policy that
 * held `intranet.example 8443` and pressing Save widened it to every port without a word.
 */
function rulesFromText(text: string): EgressRule[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value = "", ports] = line.split(/\s+/, 2);
      const type =
        /^[\d.:a-fA-F]+(\/\d+)?$/.test(value) &&
        /[\d]/.test(value) &&
        /[.:]/.test(value)
          ? ("cidr" as const)
          : ("domain" as const);
      return { type, value, ...(ports ? { ports } : {}) };
    });
}

function rulesToText(rules: EgressRule[]): string {
  return rules
    .map((rule) => `${rule.value}${rule.ports ? ` ${rule.ports}` : ""}`)
    .join("\n");
}

function summarizePolicy(policy: NetworkPolicy | undefined): string {
  if (!policy)
    return "No policy. Bot computers can reach anything the cluster allows";
  const count = policy.rules.length;
  return `${MODE_NAMES[policy.mode]} · ${count} ${count === 1 ? "rule" : "rules"}${policy.locked ? " · locked" : ""}`;
}

/** Admin, Computers: when an idle computer is stopped, and stopping them now. */
export function InactiveComputersSection() {
  const [daysOpen, setDaysOpen] = useState(false);
  return (
    <ControlsSection
      description="Stopping a computer ends its running Bots and keeps its disk. The Bot gets a fresh computer next session. To stop one person's computers, go to People."
      title="Idle computers"
    >
      {({ data, setSetting }) => (
        <>
          <PageRows>
            <Item
              render={
                <button onClick={() => setDaysOpen(true)} type="button" />
              }
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconDeviceDesktop />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Stop inactive computers</ItemTitle>
                <ItemDescription>
                  {data.settings.inactiveComputerDays === 0
                    ? "Off"
                    : `After ${data.settings.inactiveComputerDays} days without use`}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </PageRows>
          <SweepNow />
          <DaysDialog
            initial={data.settings.inactiveComputerDays}
            onClose={() => setDaysOpen(false)}
            onSave={(days) => setSetting("inactiveComputerDays", days)}
            open={daysOpen}
          />
        </>
      )}
    </ControlsSection>
  );
}

/** Admin, Computers: where Bot computers may connect, for the organization and per group. */
export function NetworkSection() {
  const [networkScope, setNetworkScope] = useState<
    { scopeKind: "organization" | "group"; scopeId: string } | undefined
  >();
  return (
    <ControlsSection
      description="Control where Bot computers can connect. Changes apply within seconds without a restart. Group policies override the organization’s policy unless it is locked."
      title="Network"
    >
      {({ data }) => {
        const organizationPolicy = data.network.find(
          (row) => row.scopeKind === "organization",
        );
        const groupPolicies = data.network.filter(
          (row) => row.scopeKind === "group",
        );
        return (
          <>
            <PageRows>
              <Item
                render={
                  <button
                    onClick={() =>
                      setNetworkScope({
                        scopeKind: "organization",
                        scopeId: "",
                      })
                    }
                    type="button"
                  />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconWorld />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Organization</ItemTitle>
                  <ItemDescription>
                    {summarizePolicy(organizationPolicy)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
              {groupPolicies.map((policy) => (
                <div key={policy.scopeId}>
                  <Separator />
                  <Item
                    render={
                      <button
                        onClick={() =>
                          setNetworkScope({
                            scopeKind: "group",
                            scopeId: policy.scopeId,
                          })
                        }
                        type="button"
                      />
                    }
                    size="sm"
                  >
                    <ItemMedia variant="icon">
                      <IconNetwork />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>Group: {policy.scopeId}</ItemTitle>
                      <ItemDescription>
                        {summarizePolicy(policy)}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <IconChevronRight className="size-4 text-muted-foreground" />
                    </ItemActions>
                  </Item>
                </div>
              ))}
            </PageRows>
            {data.groups.length > 0 ? (
              <Button
                className="mt-4"
                onClick={() =>
                  setNetworkScope({ scopeKind: "group", scopeId: "" })
                }
                size="sm"
                variant="outline"
              >
                Add a group policy
              </Button>
            ) : null}
            {networkScope ? (
              <NetworkDialog
                data={data}
                initial={networkScope}
                onClose={() => setNetworkScope(undefined)}
              />
            ) : null}
          </>
        );
      }}
    </ControlsSection>
  );
}

function SweepNow() {
  const sweep = useMutation(terminateInactiveComputersMutationOptions());
  return (
    <div className="mt-4 flex items-center gap-3">
      <Button
        disabled={sweep.isPending}
        onClick={() => sweep.mutate()}
        size="sm"
        variant="outline"
      >
        {sweep.isPending ? "Stopping…" : "Stop inactive computers now"}
      </Button>
      {sweep.data ? (
        <span className="text-muted-foreground text-sm">
          Stopped {sweep.data.stopped.length}.
        </span>
      ) : null}
      {sweep.error ? (
        <span className="text-destructive text-sm" role="alert">
          {sweep.error.message}
        </span>
      ) : null}
    </div>
  );
}

function NetworkDialog({
  data,
  initial,
  onClose,
}: {
  data: EnterpriseOverview;
  initial: { scopeKind: "organization" | "group"; scopeId: string };
  onClose: () => void;
}) {
  const existing = data.network.find(
    (row) =>
      row.scopeKind === initial.scopeKind && row.scopeId === initial.scopeId,
  );
  const [group, setGroup] = useState(initial.scopeId || data.groups[0] || "");
  const [mode, setMode] = useState<NetworkMode>(
    existing?.mode ?? "defaults_plus_allowlist",
  );
  const [rules, setRules] = useState(rulesToText(existing?.rules ?? []));
  const [locked, setLocked] = useState(existing?.locked ?? false);
  const [written, setWritten] = useState<WrittenAllowlist | null>(null);
  const save = useMutation(setNetworkPolicyMutationOptions(queryClient));
  const remove = useMutation(removeNetworkPolicyMutationOptions(queryClient));
  const scopeId = initial.scopeKind === "group" ? group : "";
  const formId = useId();

  const entries = rulesFromText(rules);
  const edited =
    written !== null &&
    (mode !== written.mode ||
      JSON.stringify(entries) !== JSON.stringify(written.rules));
  /* The model's list, unedited, that didn't parse. Its problems are already on screen, under it. */
  const broken = written !== null && !written.check.ok && !edited;
  /*
   * The policy as the dialog holds it, replayed once it differs from the one in force. Each part of
   * the scope matters: a group's policy covers its members' Bots, and a locked organization policy
   * covers everybody's.
   */
  const unchanged =
    existing !== undefined &&
    existing.mode === mode &&
    existing.locked === locked &&
    JSON.stringify(existing.rules) === JSON.stringify(entries);
  const candidate =
    unchanged || broken || (initial.scopeKind === "group" && !scopeId)
      ? null
      : { scopeKind: initial.scopeKind, scopeId, mode, rules: entries, locked };

  /* The model's list goes into the Allowlist field and its mode into Mode, where the admin reads both. */
  const takeWritten = (next: WrittenAllowlist) => {
    save.reset();
    setWritten(next);
    setMode(next.mode);
    setRules(rulesToText(next.rules));
  };

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {initial.scopeKind === "organization"
              ? "Organization network policy"
              : "Group network policy"}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 space-y-4 overflow-y-auto">
          {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
              direct child of DialogContent and keeps scrolling. */}
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              if (broken) return;
              save.mutate(
                {
                  scopeKind: initial.scopeKind,
                  scopeId,
                  mode,
                  rules: entries,
                  locked,
                  ...(written
                    ? {
                        authoring: {
                          source: "english" as const,
                          text: written.text,
                        },
                      }
                    : {}),
                },
                { onSuccess: onClose },
              );
            }}
          >
            <FieldGroup>
              {initial.scopeKind === "group" && !initial.scopeId ? (
                <Field>
                  <FieldLabel>Group</FieldLabel>
                  <Select
                    onValueChange={(value) => setGroup(String(value))}
                    value={group}
                  >
                    <SelectTrigger aria-label="Group">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {data.groups.map((name) => (
                          <SelectItem key={name} value={name}>
                            {name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
              <DescribeAllowlist onWritten={takeWritten} />
              <Field>
                <FieldLabel>Mode</FieldLabel>
                <Select
                  onValueChange={(value) => setMode(value as NetworkMode)}
                  value={mode}
                >
                  <SelectTrigger aria-label="Mode">
                    <SelectValue>{MODE_NAMES[mode]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {(Object.keys(MODE_NAMES) as NetworkMode[]).map(
                        (option) => (
                          <SelectItem key={option} value={option}>
                            {MODE_NAMES[option]}
                          </SelectItem>
                        ),
                      )}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="network-rules">Allowlist</FieldLabel>
                <FieldDescription>
                  One per line. A domain covers its subdomains. *.name covers
                  only subdomains. Either can list ports. Defaults are{" "}
                  {data.defaultDestinations.slice(0, 4).join(", ")} and{" "}
                  {data.defaultDestinations.length - 4} more package and source
                  hosts.
                </FieldDescription>
                <Textarea
                  className="font-mono text-xs"
                  id="network-rules"
                  onChange={(event) => setRules(event.target.value)}
                  placeholder={
                    "example.com\n*.corp.example\n10.0.0.0/8 443,5432"
                  }
                  rows={8}
                  value={rules}
                />
                {written ? (
                  <AllowlistReading edited={edited} written={written} />
                ) : null}
              </Field>
              <AllowlistPreview candidate={candidate} />
              {initial.scopeKind === "organization" ? (
                <div className="flex items-center justify-between gap-4">
                  <Label htmlFor="network-locked">
                    Lock so groups can't replace this policy
                  </Label>
                  <Switch
                    checked={locked}
                    id="network-locked"
                    onCheckedChange={setLocked}
                  />
                </div>
              ) : null}
            </FieldGroup>
          </form>
          {(save.error ?? remove.error) ? (
            <p className="text-destructive text-sm" role="alert">
              {(save.error ?? remove.error)?.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          {existing ? (
            <Button
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(
                  { scopeKind: initial.scopeKind, scopeId },
                  { onSuccess: onClose },
                )
              }
              size="sm"
              type="button"
              variant="destructive"
            >
              Remove policy
            </Button>
          ) : null}
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={
              save.isPending ||
              broken ||
              (initial.scopeKind === "group" && !scopeId)
            }
            form={formId}
            size="sm"
            type="submit"
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DaysDialog({
  open,
  initial,
  onSave,
  onClose,
}: {
  open: boolean;
  initial: number;
  onSave: (days: number) => void;
  onClose: () => void;
}) {
  const [days, setDays] = useState(String(initial));
  const parsed = Number(days);
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 3650;
  return (
    <Dialog
      onOpenChange={(next) => (next ? setDays(String(initial)) : onClose())}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Stop inactive computers</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 space-y-2">
          <Label htmlFor="inactive-days">Days without use</Label>
          <Input
            id="inactive-days"
            inputMode="numeric"
            onChange={(event) => setDays(event.target.value)}
            value={days}
          />
          <p className="text-muted-foreground text-xs">
            0 turns it off. Checked hourly.
          </p>
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              onSave(parsed);
              onClose();
            }}
            size="sm"
            type="button"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
