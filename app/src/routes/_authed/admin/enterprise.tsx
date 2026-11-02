import {
  IconChartBar,
  IconChevronRight,
  IconDeviceDesktop,
  IconFingerprint,
  IconKey,
  IconNetwork,
  IconPlug,
  IconShare,
  IconShieldLock,
  IconTerminal2,
  IconToggleRight,
  IconUsersGroup,
  IconWorld,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  setCapabilityMutationOptions,
  setEnterpriseSettingMutationOptions,
  setNetworkPolicyMutationOptions,
  terminateInactiveComputersMutationOptions,
} from "@/lib/enterprise/mutations";
import {
  actionRecordsQueryOptions,
  type CapabilitySetting,
  type EgressRule,
  type EnterpriseOverview,
  enterpriseOverviewQueryOptions,
  modelUsageQueryOptions,
  type NetworkMode,
  type NetworkPolicy,
} from "@/lib/enterprise/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/enterprise")({
  component: EnterprisePage,
});

const MODE_NAMES: Record<NetworkMode, string> = {
  allow_all: "Allow all network access",
  defaults_plus_allowlist: "Defaults plus team allowlist",
  allowlist_only: "Team allowlist only",
};

/** One rule per line: `example.com`, `*.corp.example`, or `10.0.0.0/8 443,8443`. */
function rulesFromText(text: string): EgressRule[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value = "", ports] = line.split(/\s+/, 2);
      return /^[\d.:a-fA-F]+(\/\d+)?$/.test(value) &&
        /[\d]/.test(value) &&
        /[.:]/.test(value)
        ? { type: "cidr" as const, value, ...(ports ? { ports } : {}) }
        : { type: "domain" as const, value };
    });
}

function rulesToText(rules: EgressRule[]): string {
  return rules
    .map((rule) =>
      rule.type === "domain"
        ? rule.value
        : `${rule.value}${rule.ports ? ` ${rule.ports}` : ""}`,
    )
    .join("\n");
}

function summarizePolicy(policy: NetworkPolicy | undefined): string {
  if (!policy)
    return "No policy. Bot computers can reach anything the cluster allows";
  const count = policy.rules.length;
  return `${MODE_NAMES[policy.mode]} · ${count} ${count === 1 ? "rule" : "rules"}${policy.locked ? " · locked" : ""}`;
}

function EnterprisePage() {
  const overview = useQuery(enterpriseOverviewQueryOptions());
  const setCapability = useMutation(setCapabilityMutationOptions(queryClient));
  const setSetting = useMutation(
    setEnterpriseSettingMutationOptions(queryClient),
  );
  const failure = setCapability.error ?? setSetting.error;

  return (
    <PageShell
      description="Manage member permissions, network access for Bot computers, and recording settings. All changes appear in Audit."
      title="Enterprise controls"
    >
      {failure ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failure.message}
        </p>
      ) : null}
      {overview.isPending ? null : overview.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Couldn't load enterprise controls. Reload the page.
        </p>
      ) : (
        <EnterpriseSections
          data={overview.data}
          onCapability={(capability, allowed) =>
            setCapability.mutate({
              scopeKind: "organization",
              scopeId: "",
              capability,
              allowed,
            })
          }
          onSetting={(key, value) => setSetting.mutate({ key, value })}
          saving={setCapability.isPending || setSetting.isPending}
        />
      )}
    </PageShell>
  );
}

function EnterpriseSections({
  data,
  onCapability,
  onSetting,
  saving,
}: {
  data: EnterpriseOverview;
  onCapability: (
    capability: CapabilitySetting["capability"],
    allowed: boolean,
  ) => void;
  onSetting: (
    key: keyof EnterpriseOverview["settings"],
    value: unknown,
  ) => void;
  saving: boolean;
}) {
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [networkScope, setNetworkScope] = useState<
    { scopeKind: "organization" | "group"; scopeId: string } | undefined
  >();
  const [modelsOpen, setModelsOpen] = useState(false);
  const [daysOpen, setDaysOpen] = useState(false);
  const { settings } = data;
  const overrideCount = data.capabilities.reduce(
    (count, capability) =>
      count +
      Object.keys(capability.roles).length +
      Object.keys(capability.groups).length,
    0,
  );
  const organizationPolicy = data.network.find(
    (row) => row.scopeKind === "organization",
  );
  const groupPolicies = data.network.filter((row) => row.scopeKind === "group");

  return (
    <>
      <PageSection
        description="Addresses in INITIAL_ADMIN_EMAILS can always use social sign-in as an emergency way in. Each of those sign-ins shows in Audit."
        title="Sign-in"
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconShieldLock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Require SSO</ItemTitle>
              <ItemDescription>
                {settings.ssoRequired
                  ? "People can only sign in through a registered SAML or OpenID Connect provider."
                  : "People can also sign in with Google, Microsoft or Okta."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Require SSO"
                checked={settings.ssoRequired}
                disabled={saving}
                onCheckedChange={(checked) => onSetting("ssoRequired", checked)}
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconFingerprint />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>SCIM provisioning</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {data.scim.configured
                  ? `Directory base URL ${data.scim.baseUrl ?? "(set BETTER_AUTH_URL)"} with the SCIM_BEARER_TOKEN bearer token. Deprovisioning ends sessions, blocks the address, retires connector credentials and stops their computers.`
                  : "Off. Set SCIM_BEARER_TOKEN to accept provisioning from Okta, Entra or another directory."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {data.scim.configured ? "On" : "Off"}
              </span>
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      <PageSection
        description="Each switch applies to the whole organization. A role can override it, and a directory group can get a capability the organization has off."
        title="Capabilities"
      >
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
                        onCapability(capability.capability, checked)
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
              <button onClick={() => setOverridesOpen(true)} type="button" />
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
      </PageSection>

      <PageSection
        description="Each person's recordings teach Skills in their own Learning space, and those Skills reach the Bots that person uses. A shared Skill puts its person's recorded and narrated text in front of everybody's Bots."
        title="Learning"
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconShare />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Skill sharing</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {settings.skillSharing
                  ? "People may open their Skills to every Bot in Settings, Learning."
                  : "Off. Each person's Skills reach only the Bots they use, even Skills they opened before."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Skill sharing"
                checked={settings.skillSharing}
                disabled={saving}
                onCheckedChange={(checked) =>
                  onSetting("skillSharing", checked)
                }
              />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      <PageSection
        description="Control where Bot computers can connect. Changes apply within seconds without a restart. Group policies override the organization’s policy unless it is locked."
        title="Network"
      >
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
                  <ItemDescription>{summarizePolicy(policy)}</ItemDescription>
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
            onClick={() => setNetworkScope({ scopeKind: "group", scopeId: "" })}
            size="sm"
            variant="outline"
          >
            Add a group policy
          </Button>
        ) : null}
      </PageSection>

      <PageSection
        description="With the allowlist on, Bots can only call tools on the MCP servers approved here. Calls to any other server are refused."
        title="MCP servers"
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconPlug />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Only approved servers</ItemTitle>
              <ItemDescription>
                {settings.mcpAllowlist.enabled
                  ? `${settings.mcpAllowlist.servers.length} approved`
                  : "Off. Bots can use any registered server they have access to."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Only approved MCP servers"
                checked={settings.mcpAllowlist.enabled}
                disabled={saving}
                onCheckedChange={(enabled) =>
                  onSetting("mcpAllowlist", {
                    ...settings.mcpAllowlist,
                    enabled,
                  })
                }
              />
            </ItemActions>
          </Item>
          {data.mcpServers.map((server) => {
            const approved = settings.mcpAllowlist.servers.includes(server.id);
            return (
              <div key={server.id}>
                <Separator />
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconKey />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{server.title}</ItemTitle>
                    <ItemDescription>{server.url}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Switch
                      aria-label={`Approve ${server.title}`}
                      checked={approved}
                      disabled={saving}
                      onCheckedChange={(checked) =>
                        onSetting("mcpAllowlist", {
                          ...settings.mcpAllowlist,
                          servers: checked
                            ? [...settings.mcpAllowlist.servers, server.id]
                            : settings.mcpAllowlist.servers.filter(
                                (id) => id !== server.id,
                              ),
                        })
                      }
                    />
                  </ItemActions>
                </Item>
              </div>
            );
          })}
        </PageRows>
      </PageSection>

      <PageSection
        description={`The built-in Bot runs on ${data.builtInModel ?? "the deployment's configured model"}. A remote Bot chooses its own, and the model it reports is recorded.`}
        title="Models"
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconShieldLock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Model allowlist</ItemTitle>
              <ItemDescription>
                {settings.modelAllowlist.enabled
                  ? "A built-in Bot on an unlisted model is refused before it runs."
                  : "Off. Any model can be used."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Model allowlist"
                checked={settings.modelAllowlist.enabled}
                disabled={saving}
                onCheckedChange={(enabled) =>
                  onSetting("modelAllowlist", {
                    ...settings.modelAllowlist,
                    enabled,
                  })
                }
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item
            render={
              <button onClick={() => setModelsOpen(true)} type="button" />
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconKey />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Allowed models</ItemTitle>
              <ItemDescription>
                {settings.modelAllowlist.models.length === 0
                  ? "None listed"
                  : settings.modelAllowlist.models.join(", ")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </PageRows>
        <ModelUsage />
      </PageSection>

      <PageSection
        description="Set OTEL_EXPORTER_OTLP_ENDPOINT to stream audit events and Bot actions to your OpenTelemetry collector or SIEM. They are tagged openbot.surface."
        title="Recording and export"
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconTerminal2 />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Action Recording</ItemTitle>
              <ItemDescription>
                {settings.actionRecording
                  ? `Shell commands Bots run are recorded with secrets removed, and kept ${data.actionRecordRetentionDays} days.`
                  : "Off. Commands show in Audit only."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Action Recording"
                checked={settings.actionRecording}
                disabled={saving}
                onCheckedChange={(checked) =>
                  onSetting("actionRecording", checked)
                }
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconChartBar />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>OpenTelemetry export</ItemTitle>
              <ItemDescription>
                {data.otel.configured
                  ? "Exporting over OTLP/HTTP."
                  : "Not set up. Set OTEL_EXPORTER_OTLP_ENDPOINT on the server."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {data.otel.configured ? "On" : "Off"}
              </span>
            </ItemActions>
          </Item>
        </PageRows>
        {settings.actionRecording ? <RecordedActions /> : null}
      </PageSection>

      <PageSection
        description="Stopping a computer ends its running Bots and keeps its disk. The Bot gets a fresh computer next session. To stop one person's computers, go to People."
        title="Computers"
      >
        <PageRows>
          <Item
            render={<button onClick={() => setDaysOpen(true)} type="button" />}
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconDeviceDesktop />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Stop inactive computers</ItemTitle>
              <ItemDescription>
                {settings.inactiveComputerDays === 0
                  ? "Off"
                  : `After ${settings.inactiveComputerDays} days without use`}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </PageRows>
        <SweepNow />
      </PageSection>

      <OverridesDialog
        data={data}
        onOpenChange={setOverridesOpen}
        open={overridesOpen}
      />
      {networkScope ? (
        <NetworkDialog
          data={data}
          initial={networkScope}
          onClose={() => setNetworkScope(undefined)}
        />
      ) : null}
      <ListDialog
        description="Enter one model per line as provider/model, for example openai/gpt-5.6-terra."
        initial={settings.modelAllowlist.models}
        onClose={() => setModelsOpen(false)}
        onSave={(models) =>
          onSetting("modelAllowlist", { ...settings.modelAllowlist, models })
        }
        open={modelsOpen}
        title="Allowed models"
      />
      <DaysDialog
        initial={settings.inactiveComputerDays}
        onClose={() => setDaysOpen(false)}
        onSave={(days) => onSetting("inactiveComputerDays", days)}
        open={daysOpen}
      />
    </>
  );
}

function ModelUsage() {
  const usage = useQuery(modelUsageQueryOptions(30));
  if (usage.isPending) return null;
  if (usage.error)
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        Couldn't load model usage. Reload the page.
      </p>
    );
  if (usage.data.summary.length === 0)
    return (
      <PageEmpty icon={IconChartBar} title="No recent runs">
        No Bot runs in the last 30 days.
      </PageEmpty>
    );
  return (
    <PageRows>
      {usage.data.summary.map((row, index) => (
        <div key={`${row.model}-${row.source}`}>
          {index > 0 ? <Separator /> : null}
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconChartBar />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{row.model}</ItemTitle>
              <ItemDescription>
                {row.runs} runs by {row.people}{" "}
                {row.people === 1 ? "person" : "people"} in 30 days
                {row.refused > 0 ? ` · ${row.refused} off the allowlist` : ""} ·{" "}
                {row.source}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {new Date(row.lastUsedAt).toLocaleDateString()}
              </span>
            </ItemActions>
          </Item>
        </div>
      ))}
    </PageRows>
  );
}

function RecordedActions() {
  const actions = useQuery(actionRecordsQueryOptions());
  if (actions.isPending) return null;
  if (actions.error)
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        Couldn't load recorded actions. Reload the page.
      </p>
    );
  if (actions.data.length === 0)
    return <PageEmpty icon={IconTerminal2} title="No commands recorded yet" />;
  return (
    <PageRows>
      {actions.data.map((action, index) => (
        <div key={action.id}>
          {index > 0 ? <Separator /> : null}
          <Item size="sm">
            <ItemContent>
              <ItemTitle className="font-mono text-xs">
                {action.command}
              </ItemTitle>
              <ItemDescription>
                {action.surface === "local"
                  ? "Member's machine"
                  : `Bot ${action.botId ?? "?"}`}{" "}
                · {action.outcome} ·{" "}
                {new Date(action.createdAt).toLocaleString()}
              </ItemDescription>
            </ItemContent>
          </Item>
        </div>
      ))}
    </PageRows>
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
  const save = useMutation(setNetworkPolicyMutationOptions(queryClient));
  const remove = useMutation(removeNetworkPolicyMutationOptions(queryClient));
  const scopeId = initial.scopeKind === "group" ? group : "";
  const formId = useId();

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
            className="flex flex-col gap-4"
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate(
                {
                  scopeKind: initial.scopeKind,
                  scopeId,
                  mode,
                  rules: rulesFromText(rules),
                  locked,
                },
                { onSuccess: onClose },
              );
            }}
          >
            {initial.scopeKind === "group" && !initial.scopeId ? (
              <div className="space-y-1.5">
                <Label>Group</Label>
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
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label>Mode</Label>
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
                      (candidate) => (
                        <SelectItem key={candidate} value={candidate}>
                          {MODE_NAMES[candidate]}
                        </SelectItem>
                      ),
                    )}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="network-rules">Allowlist</Label>
              <Textarea
                className="font-mono text-xs"
                id="network-rules"
                onChange={(event) => setRules(event.target.value)}
                placeholder={"example.com\n*.corp.example\n10.0.0.0/8 443,5432"}
                rows={8}
                value={rules}
              />
              <p className="text-muted-foreground text-xs">
                One per line. A domain covers its subdomains. *.name covers only
                subdomains. An IP range can list ports. Defaults are{" "}
                {data.defaultDestinations.slice(0, 4).join(", ")} and{" "}
                {data.defaultDestinations.length - 4} more package and source
                hosts.
              </p>
            </div>
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
              save.isPending || (initial.scopeKind === "group" && !scopeId)
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

function ListDialog({
  open,
  title,
  description,
  initial,
  onSave,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  initial: string[];
  onSave: (values: string[]) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial.join("\n"));
  return (
    <Dialog
      onOpenChange={(next) => (next ? setText(initial.join("\n")) : onClose())}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 space-y-2 overflow-y-auto">
          <Textarea
            className="font-mono text-xs"
            onChange={(event) => setText(event.target.value)}
            rows={8}
            value={text}
          />
          <p className="text-muted-foreground text-xs">{description}</p>
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            Cancel
          </Button>
          <Button
            onClick={() => {
              onSave(
                text
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
              );
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
