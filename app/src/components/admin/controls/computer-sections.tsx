import {
  IconChevronRight,
  IconDeviceDesktop,
  IconNetwork,
  IconUsersGroup,
  IconWorld,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
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
import {
  type EgressRule,
  type EnterpriseOverview,
  knownNetworkScope,
  type NetworkMode,
  type NetworkPolicy,
  type NetworkScopeKind,
} from "@/lib/enterprise/queries";
import { loadFailure } from "@/lib/load-failure";
import { MISSING_TEAM, teamName } from "@/lib/teams/names";
import { type TeamSummary, teamListQueryOptions } from "@/lib/teams/queries";
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
  defaults_plus_allowlist: "Defaults plus organization allowlist",
  allowlist_only: "Organization allowlist only",
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

/** Whose network policy a row or the dialog is about. An empty id with `team` is a new team policy. */
type NetworkScope = { scopeKind: NetworkScopeKind; scopeId: string };

/** Admin, Computers: where Bot computers may connect, for the organization and per team. */
export function NetworkSection() {
  return (
    <ControlsSection
      description="Control where Bot computers can connect. Changes apply within seconds without a restart. Team policies override the organization’s policy unless it is locked."
      title="Network"
    >
      {({ data }) => <NetworkPolicies data={data} />}
    </ControlsSection>
  );
}

/**
 * The organization's policy, then each team's and each directory group's.
 *
 * A new policy is made for a team, picked by name from the organization's teams, and is saved under
 * the team's id. A directory group's policy, from before there were teams, stays listed as it was so
 * it can be opened and removed, and so does one for a team that has since been deleted.
 */
function NetworkPolicies({ data }: { data: EnterpriseOverview }) {
  const [networkScope, setNetworkScope] = useState<NetworkScope | undefined>();
  const teams = useQuery(teamListQueryOptions());
  const known = teams.data?.teams ?? [];
  const organizationPolicy = data.network.find(
    (row) => row.scopeKind === "organization",
  );
  /*
   * A team's rows wait for the teams' names: a row is never titled with an id. A policy of a kind a
   * newer server names that this app doesn't know is left out, so it is never opened or sent back.
   */
  const scopedPolicies = data.network
    .filter(knownNetworkScope)
    .filter(
      (row) =>
        row.scopeKind === "group" ||
        (row.scopeKind === "team" && teams.data !== undefined),
    );
  const titleOf = (policy: NetworkPolicy) => {
    if (policy.scopeKind === "group") return `Group: ${policy.scopeId}`;
    const name = teamName(known, policy.scopeId);
    return name === MISSING_TEAM ? name : `Team: ${name}`;
  };
  return (
    <>
      <PageRows>
        <Item
          render={
            <button
              onClick={() =>
                setNetworkScope({ scopeKind: "organization", scopeId: "" })
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
        {scopedPolicies.map((policy) => (
          <div key={`${policy.scopeKind}:${policy.scopeId}`}>
            <Separator />
            <Item
              render={
                <button
                  onClick={() =>
                    setNetworkScope({
                      scopeKind: policy.scopeKind,
                      scopeId: policy.scopeId,
                    })
                  }
                  type="button"
                />
              }
              size="sm"
            >
              <ItemMedia variant="icon">
                {policy.scopeKind === "team" ? (
                  <IconUsersGroup />
                ) : (
                  <IconNetwork />
                )}
              </ItemMedia>
              <ItemContent>
                {/* A long team name wraps, and the row is a button, whose words center unless told. */}
                <ItemTitle className="text-left">{titleOf(policy)}</ItemTitle>
                <ItemDescription>{summarizePolicy(policy)}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </div>
        ))}
      </PageRows>
      {teams.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {loadFailure(
            teams.error,
            "Couldn't load teams. Try again in a moment.",
          )}
        </p>
      ) : null}
      {known.some(
        (team) =>
          !data.network.some(
            (row) => row.scopeKind === "team" && row.scopeId === team.id,
          ),
      ) ? (
        <Button
          className="mt-4"
          onClick={() => setNetworkScope({ scopeKind: "team", scopeId: "" })}
          size="sm"
          variant="outline"
        >
          Add a team policy
        </Button>
      ) : null}
      {networkScope ? (
        <NetworkDialog
          data={data}
          initial={networkScope}
          onClose={() => setNetworkScope(undefined)}
          teams={known}
        />
      ) : null}
    </>
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
  teams,
  onClose,
}: {
  data: EnterpriseOverview;
  initial: NetworkScope;
  /** The organization's teams, to pick a new policy's team from. */
  teams: TeamSummary[];
  onClose: () => void;
}) {
  const existing = data.network.find(
    (row) =>
      row.scopeKind === initial.scopeKind && row.scopeId === initial.scopeId,
  );
  /* A new team policy is for a team that has none yet: one that has is opened from its row. */
  const without = teams.filter(
    (team) =>
      !data.network.some(
        (row) => row.scopeKind === "team" && row.scopeId === team.id,
      ),
  );
  const [team, setTeam] = useState(initial.scopeId || without[0]?.id || "");
  const [mode, setMode] = useState<NetworkMode>(
    existing?.mode ?? "defaults_plus_allowlist",
  );
  const [rules, setRules] = useState(rulesToText(existing?.rules ?? []));
  const [locked, setLocked] = useState(existing?.locked ?? false);
  const [written, setWritten] = useState<WrittenAllowlist | null>(null);
  const save = useMutation(setNetworkPolicyMutationOptions(queryClient));
  const remove = useMutation(removeNetworkPolicyMutationOptions(queryClient));
  const scoped = initial.scopeKind !== "organization";
  const scopeId =
    initial.scopeKind === "team"
      ? team
      : initial.scopeKind === "group"
        ? initial.scopeId
        : "";
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
   * the scope matters: a team's policy covers its people's Bots, and a locked organization policy
   * covers everybody's.
   */
  const unchanged =
    existing !== undefined &&
    existing.mode === mode &&
    existing.locked === locked &&
    JSON.stringify(existing.rules) === JSON.stringify(entries);
  const candidate =
    unchanged || broken || (scoped && !scopeId)
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
              : initial.scopeKind === "team"
                ? "Team network policy"
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
              {initial.scopeKind === "team" && !initial.scopeId ? (
                <Field>
                  <FieldLabel>Team</FieldLabel>
                  <FieldDescription>
                    The policy covers the Bots of the people in this team, and
                    in the teams beneath it.
                  </FieldDescription>
                  <Select
                    onValueChange={(value) => setTeam(String(value))}
                    value={team}
                  >
                    <SelectTrigger aria-label="Team">
                      <SelectValue>{teamName(teams, team)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {without.map((candidate) => (
                          <SelectItem key={candidate.id} value={candidate.id}>
                            {candidate.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              ) : scoped ? (
                <p className="text-muted-foreground text-sm">
                  {initial.scopeKind === "group"
                    ? `This policy is for the directory group ${initial.scopeId}. You can change or remove it here. Make new policies for a team.`
                    : teams.some((one) => one.id === initial.scopeId)
                      ? `This policy covers the Bots of the people in ${teamName(teams, initial.scopeId)}, and in the teams beneath it.`
                      : "This team no longer exists, so its policy covers nobody. You can remove it."}
                </p>
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
                    Lock so teams can't replace this policy
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
            disabled={save.isPending || broken || (scoped && !scopeId)}
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
